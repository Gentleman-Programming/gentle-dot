import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import approvalGuard, {
	type ConnectorPolicy,
	decide,
	isReadOnlyCall,
	POLICY_ENV,
	parsePolicy,
} from "../src/extensions/approval-guard.ts";

const AGENT = "/data/agent";
const PROTECTED = [`${AGENT}/mcp.json`, `${AGENT}/mcp-auth.json`, "/data/connectors.json", "/app/guard.ts"];

function policy(mode: "read_only" | "read_write" = "read_write"): ConnectorPolicy {
	return {
		connectors: { notion: { name: "Notion", mode, readOnlyTools: ["notion-search", "notion-fetch"] } },
		protectedPaths: PROTECTED,
	};
}

const call = (toolName: string, input: Record<string, unknown> = {}, readOnlyHint?: boolean) => ({
	toolName,
	input,
	cwd: "/data/workspace",
	...(readOnlyHint === undefined ? {} : { readOnlyHint }),
});

describe("read-only classification (fail closed)", () => {
	it("needs both readOnlyHint true and the curated list", () => {
		const curated = ["notion-search"];
		expect(isReadOnlyCall("notion", "mcp__notion__notion_search", true, curated)).toBe(true);
		expect(isReadOnlyCall("notion", "mcp__notion__notion_search", false, curated)).toBe(false);
		expect(isReadOnlyCall("notion", "mcp__notion__notion_search", undefined, curated)).toBe(false);
		expect(isReadOnlyCall("notion", "mcp__notion__notion_search", "true", curated)).toBe(false);
		// Claimed read-only by the server, but not curated.
		expect(isReadOnlyCall("notion", "mcp__notion__notion_create_pages", true, curated)).toBe(false);
		// Another server's tool with the same short name.
		expect(isReadOnlyCall("notion", "mcp__linear__notion_search", true, curated)).toBe(false);
	});
});

describe("approval guard decisions", () => {
	it("lets curated read-only connector tools run in both modes", () => {
		for (const mode of ["read_only", "read_write"] as const) {
			expect(decide(call("mcp__notion__notion_search", { query: "plans" }, true), policy(mode))).toEqual({
				action: "pass",
			});
		}
	});

	it("asks before any other connector tool, with the full arguments as the preview", () => {
		const body = `Hello team,\n${"x".repeat(400)}`;
		const extra = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((key) => [key, key.repeat(3)]));
		const decision = decide(
			call("mcp__notion__notion_create_pages", { ...extra, parent: "Weekly notes", title: "Plan", body }),
			policy(),
		);
		expect(decision.action).toBe("ask");
		if (decision.action !== "ask") return;
		expect(decision.title).toBe("Allow Notion to create pages?");
		expect(decision.message).toContain("The assistant wants to create pages in Notion.");
		expect(decision.message).toContain("parent: Weekly notes");
		expect(decision.message).toContain("title: Plan");
		// Every field and every character the user approves is shown.
		expect(decision.message).toContain(`body: Hello team,\n  ${"x".repeat(400)}`);
		for (const key of Object.keys(extra)) expect(decision.message).toContain(`${key}: ${key.repeat(3)}`);
		expect(decision.message).not.toContain("more");
		expect(decision.message).not.toContain("…");
		// Key fields come before the rest.
		expect(decision.message.indexOf("parent:")).toBeLessThan(decision.message.indexOf("a: aaa"));
		expect(decision.message).not.toMatch(/gentle|\bpi\b|mcp__/i);
	});

	it("says how much of a very long preview was cut", () => {
		const decision = decide(call("mcp__notion__notion_create_pages", { body: "y".repeat(9000) }), policy());
		if (decision.action !== "ask") throw new Error("expected a question");
		const preview = decision.message.slice(decision.message.indexOf("body: "));
		expect(preview).toContain("y".repeat(7000));
		expect(preview).toMatch(/\n\(truncated, \d+ more characters\)$/);
		const shown = preview.split("\n(truncated")[0] ?? "";
		const more = Number(/truncated, (\d+) more/.exec(preview)?.[1]);
		expect(shown.length).toBe(8000);
		expect(shown.length + more).toBe("body: ".length + 9000);
	});

	it("asks when a curated tool does not declare itself read-only", () => {
		expect(decide(call("mcp__notion__notion_fetch", { id: "p1" }), policy()).action).toBe("ask");
		expect(decide(call("mcp__notion__notion_fetch", { id: "p1" }, false), policy()).action).toBe("ask");
	});

	it("blocks write tools of a read-only connector and says how to change it", () => {
		const decision = decide(call("mcp__notion__notion_create_pages", { title: "x" }), policy("read_only"));
		expect(decision).toEqual({
			action: "block",
			reason: expect.stringContaining('switch Notion to "Read and send" in Connectors'),
		});
	});

	it("blocks tools of a server the user never approved", () => {
		const decision = decide(call("mcp__evil__send", { to: "x" }, true), policy());
		expect(decision).toEqual({ action: "block", reason: expect.stringContaining("not approved") });
	});

	it("asks for every connector tool when the policy is missing or was tampered with", () => {
		expect(parsePolicy(undefined)).toBeUndefined();
		expect(parsePolicy("{not json")).toBeUndefined();
		expect(parsePolicy(JSON.stringify({ connectors: { notion: { mode: "read_write" } } }))).toBeUndefined();
		const untrusted = parsePolicy("{}") ?? { protectedPaths: PROTECTED };
		expect(decide(call("mcp__notion__notion_search", { query: "q" }, true), untrusted).action).toBe("ask");
		expect(decide(call("mcp__evil__send", {}, true), untrusted).action).toBe("ask");
		expect(parsePolicy(JSON.stringify(policy()))).toEqual(policy());
	});

	it("leaves ordinary tools alone", () => {
		expect(decide(call("read", { path: "notes.md" }), policy())).toEqual({ action: "pass" });
		expect(decide(call("bash", { command: "ls -la" }), policy())).toEqual({ action: "pass" });
		expect(decide(call("write", { path: "notes.md", content: "mcp.json" }), policy())).toEqual({
			action: "pass",
		});
	});

	it("blocks edits of the connector control files, by absolute or relative path", () => {
		for (const input of [
			{ path: `${AGENT}/mcp.json`, content: "{}" },
			{ path: "../agent/mcp-auth.json", content: "{}" },
			{ path: "/data/connectors.json", content: "{}" },
			{ path: "/app/guard.ts", content: "" },
		]) {
			for (const toolName of ["write", "edit"]) {
				expect(decide(call(toolName, input), policy())).toEqual({
					action: "block",
					reason: expect.stringContaining("Connectors screen"),
				});
			}
		}
	});

	it("sees through symlinked folders, for files that do not exist yet too", () => {
		const real = mkdtempSync(join(tmpdir(), "guard-"));
		const link = `${real}-link`;
		symlinkSync(real, link);
		const guarded: ConnectorPolicy = { connectors: {}, protectedPaths: [join(link, "mcp.json")] };
		for (const path of [
			join(real, "mcp.json"),
			join(realpathSync(real), "mcp.json"),
			join(link, "mcp.json"),
		]) {
			expect(decide(call("write", { path, content: "{}" }), guarded).action).toBe("block");
		}
		expect(decide(call("bash", { command: `rm ${realpathSync(real)}/mcp.json` }), guarded).action).toBe(
			"block",
		);
	});

	it("blocks commands that change connectors or touch their files", () => {
		for (const command of [
			"pi mcp add slack --url https://example.com/mcp",
			"node cli.js mcp login notion",
			"pi  mcp remove notion",
			"pi mcp logout notion",
			`cat > ${AGENT}/mcp.json <<'EOF'\n{}\nEOF`,
			"echo {} > $PI_CODING_AGENT_DIR/mcp.json",
			"sed -i '' s/read_only/read_write/ /data/connectors.json",
		]) {
			expect(decide(call("bash", { command }), policy())).toEqual({
				action: "block",
				reason: expect.stringContaining("Connectors screen"),
			});
		}
	});
});

/** A data folder like the assistant's: credentials and control files next to the agent's workspace. */
function credentialTree() {
	const data = mkdtempSync(join(tmpdir(), "guard-data-"));
	const agent = join(data, "agent");
	const workspace = join(data, "workspace");
	mkdirSync(agent);
	mkdirSync(workspace);
	const files = {
		auth: join(agent, "auth.json"),
		mcpAuth: join(agent, "mcp-auth.json"),
		models: join(agent, "models.json"),
		mcp: join(agent, "mcp.json"),
		connectors: join(data, "connectors.json"),
		token: join(data, "token"),
	};
	for (const file of Object.values(files)) writeFileSync(file, '{"secret":"value"}');
	const guarded: ConnectorPolicy = { connectors: {}, protectedPaths: Object.values(files) };
	const at = (toolName: string, input: Record<string, unknown>) => ({ toolName, input, cwd: workspace });
	return { data, agent, workspace, files, guarded, at };
}

describe("built-in computer server (S24.7)", () => {
	const withComputer = (): ConnectorPolicy => ({ ...policy("read_only"), builtin: ["computer"] });

	it("runs its tools without approval cards, since the desktop app enforces its own checks", () => {
		for (const tool of ["mcp__computer__screenshot", "mcp__computer__click", "mcp__computer__type"]) {
			expect(decide(call(tool, { x: 1, y: 2, text: "send" }), withComputer()), tool).toEqual({
				action: "pass",
			});
		}
	});

	it("leaves every other server's rules as they were", () => {
		expect(decide(call("mcp__notion__notion_create_pages", { title: "x" }), withComputer()).action).toBe(
			"block",
		);
		expect(decide(call("mcp__evil__send", { to: "x" }, true), withComputer()).action).toBe("block");
		// A look-alike server name is not the built-in one.
		expect(decide(call("mcp__computer_x__click", {}), withComputer()).action).toBe("block");
		// Without the built-in entry, the computer's tools are an unapproved server.
		expect(decide(call("mcp__computer__click", {}), policy()).action).toBe("block");
	});

	it("reads the built-in list from the daemon's policy and rejects a malformed one", () => {
		expect(parsePolicy(JSON.stringify(withComputer()))).toEqual(withComputer());
		expect(parsePolicy(JSON.stringify({ ...policy(), builtin: "computer" }))).toBeUndefined();
		expect(parsePolicy(JSON.stringify({ ...policy(), builtin: [3] }))).toBeUndefined();
		// Only the computer server can be built in.
		expect(parsePolicy(JSON.stringify({ ...policy(), builtin: ["notion"] }))).toBeUndefined();
	});
});

describe("credential and control files (B2)", () => {
	it("blocks reading them with the read tool, by any path spelling", () => {
		const { files, guarded, at, workspace, data } = credentialTree();
		symlinkSync(files.mcpAuth, join(workspace, "notes.json"));
		linkSync(files.auth, join(workspace, "copy.json"));
		for (const path of [
			"../agent/mcp-auth.json",
			files.mcpAuth,
			realpathSync(files.mcpAuth),
			`@../agent/mcp-auth.json`,
			"../agent/./../agent/MCP-AUTH.JSON",
			"../agent/auth.json",
			"../agent/models.json",
			"../agent/mcp.json",
			"../connectors.json",
			"../token",
			`${data}/token`,
			"notes.json",
			"copy.json",
		]) {
			expect(decide(at("read", { path }), guarded), path).toEqual({
				action: "block",
				reason: expect.stringContaining("private"),
			});
		}
		writeFileSync(join(workspace, "plan.md"), "# Plan");
		expect(decide(at("read", { path: "plan.md" }), guarded)).toEqual({ action: "pass" });
		expect(decide(at("read", { path: "../agent/settings.json" }), guarded)).toEqual({ action: "pass" });
	});

	it("blocks file tools that would show them: grep over them or a folder above them, find and ls on them", () => {
		const { guarded, at } = credentialTree();
		for (const [toolName, input] of [
			["grep", { pattern: "access_token", path: "../agent/mcp-auth.json" }],
			["grep", { pattern: "access_token", path: ".." }],
			["grep", { pattern: "access_token", path: "../agent" }],
			["find", { pattern: "*", path: "../agent/mcp-auth.json" }],
			["ls", { path: "../agent/auth.json" }],
		] as const) {
			expect(decide(at(toolName, input), guarded).action, `${toolName} ${input.path}`).toBe("block");
		}
		expect(decide(at("grep", { pattern: "todo" }), guarded)).toEqual({ action: "pass" });
		expect(decide(at("grep", { pattern: "todo", path: "." }), guarded)).toEqual({ action: "pass" });
		expect(decide(at("ls", { path: "../agent" }), guarded)).toEqual({ action: "pass" });
		expect(decide(at("find", { pattern: "*.md" }), guarded)).toEqual({ action: "pass" });
	});

	it("blocks commands that name them, however the name is written (best effort)", () => {
		const { guarded, at } = credentialTree();
		for (const command of [
			"cat ../agent/mcp-auth.json",
			"cd ..; cat agent/mcp-auth.json",
			`cat ../agent/"mcp-"'auth.json'`,
			"cat ../agent/mcp-\\auth.json",
			"cat ../agent/MCP-AUTH.JSON",
			`python3 -c "print(open('../agent/mcp-auth.json').read())"`,
			`node -e "console.log(require('fs').readFileSync('../agent/' + 'mcp-auth.json', 'utf8'))"`,
			`python3 -c "import os; print(open(os.path.join('..', 'agent', 'auth' + '.json')).read())"`,
			"ln -s ../agent/mcp-auth.json x && cat x",
			"cat ../agent/mcp-a*",
			"cat ../agent/models.json",
			"cp ../connectors.json /tmp/c",
			"cat ../token",
			"cat ~/.gentle-dot/agent/settings.json",
			"security find-generic-password -s notion -w",
			"echo $PI_CODING_AGENT_DIR",
		]) {
			expect(decide(at("bash", { command }), guarded), command).toEqual({
				action: "block",
				reason: expect.stringContaining("private"),
			});
		}
		for (const command of [
			"ls -la",
			"cat README.md",
			"git status",
			"grep -rn todo src",
			'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com',
		]) {
			expect(decide(at("bash", { command }), guarded), command).toEqual({ action: "pass" });
		}
	});
});

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown> | unknown;

function fakePi(tools: { name: string; annotations?: Record<string, boolean> }[]) {
	const handlers: Handler[] = [];
	return {
		handlers,
		pi: {
			on(event: string, handler: Handler) {
				if (event === "tool_call") handlers.push(handler);
			},
			getAllTools: () => tools,
			// The guard also registers propose_connector (connector-drafts.test.ts covers it).
			registerTool: () => {},
		},
	};
}

function fakeCtx(answer: boolean | undefined, hasUI = true) {
	const asked: { title: string; message: string }[] = [];
	return {
		asked,
		ctx: {
			hasUI,
			cwd: "/data/workspace",
			ui: {
				confirm: async (title: string, message: string) => {
					asked.push({ title, message });
					return answer ?? false;
				},
			},
		},
	};
}

describe("approval guard extension", () => {
	const tools = [
		{ name: "mcp__notion__notion_search", annotations: { readOnlyHint: true } },
		{ name: "mcp__notion__notion_create_pages", annotations: { readOnlyHint: false } },
	];

	function load(env: Record<string, string | undefined>) {
		const { pi, handlers } = fakePi(tools);
		const saved = process.env[POLICY_ENV];
		if (env[POLICY_ENV] === undefined) delete process.env[POLICY_ENV];
		else process.env[POLICY_ENV] = env[POLICY_ENV];
		try {
			approvalGuard(pi as never);
		} finally {
			if (saved === undefined) delete process.env[POLICY_ENV];
			else process.env[POLICY_ENV] = saved;
		}
		expect(handlers).toHaveLength(1);
		return handlers[0] as Handler;
	}

	it("reads the policy from its own environment and passes read-only tools without asking", async () => {
		const handler = load({ [POLICY_ENV]: JSON.stringify(policy()) });
		const { ctx, asked } = fakeCtx(true);
		const result = await handler(
			{ type: "tool_call", toolName: "mcp__notion__notion_search", toolCallId: "t1", input: { query: "q" } },
			ctx,
		);
		expect(result).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it("asks the user, runs on yes, and blocks on no, also for nested calls", async () => {
		const handler = load({ [POLICY_ENV]: JSON.stringify(policy()) });
		const event = {
			type: "tool_call",
			toolName: "mcp__notion__notion_create_pages",
			toolCallId: "p/1",
			parentToolCallId: "p",
			input: { title: "Plan" },
		};
		const yes = fakeCtx(true);
		expect(await handler(event, yes.ctx)).toBeUndefined();
		expect(yes.asked).toEqual([{ title: "Allow Notion to create pages?", message: expect.any(String) }]);
		const no = fakeCtx(false);
		expect(await handler(event, no.ctx)).toEqual({
			block: true,
			reason: expect.stringContaining("did not allow"),
		});
		expect(no.asked).toHaveLength(1);
	});

	it("blocks when nobody can approve", async () => {
		const handler = load({ [POLICY_ENV]: JSON.stringify(policy()) });
		const { ctx, asked } = fakeCtx(true, false);
		const result = await handler(
			{ type: "tool_call", toolName: "mcp__notion__notion_create_pages", toolCallId: "t", input: {} },
			ctx,
		);
		expect(result).toEqual({ block: true, reason: expect.stringContaining("approval") });
		expect(asked).toEqual([]);
	});

	it("asks even for read-only tools when its policy was changed", async () => {
		const handler = load({ [POLICY_ENV]: '{"connectors":{"notion":"read_write"}}' });
		const { ctx, asked } = fakeCtx(false);
		const result = await handler(
			{ type: "tool_call", toolName: "mcp__notion__notion_search", toolCallId: "t", input: { query: "q" } },
			ctx,
		);
		expect(result).toEqual({ block: true, reason: expect.any(String) });
		expect(asked).toHaveLength(1);
	});

	it("blocks a write to the connector files with a message for the assistant", async () => {
		const handler = load({ [POLICY_ENV]: JSON.stringify(policy()) });
		const { ctx } = fakeCtx(true);
		const result = await handler(
			{ type: "tool_call", toolName: "write", toolCallId: "w", input: { path: `${AGENT}/mcp.json` } },
			ctx,
		);
		expect(result).toEqual({ block: true, reason: expect.stringContaining("Connectors screen") });
	});
});
