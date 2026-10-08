import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
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

	it("asks before any other connector tool, with a readable, truncated preview", () => {
		const body = `Hello team,\n${"x".repeat(400)}`;
		const decision = decide(
			call("mcp__notion__notion_create_pages", { parent: "Weekly notes", title: "Plan", body, icon: "🚀" }),
			policy(),
		);
		expect(decision.action).toBe("ask");
		if (decision.action !== "ask") return;
		expect(decision.title).toBe("Allow Notion to create pages?");
		expect(decision.message).toContain("The assistant wants to create pages in Notion.");
		expect(decision.message).toContain("parent: Weekly notes");
		expect(decision.message).toContain("title: Plan");
		expect(decision.message).toContain("body: Hello team,\n  xxx");
		expect(decision.message).toContain("…");
		expect(decision.message).not.toContain("x".repeat(300));
		// Key fields come before the rest.
		expect(decision.message.indexOf("parent:")).toBeLessThan(decision.message.indexOf("icon:"));
		expect(decision.message).not.toMatch(/gentle|\bpi\b|mcp__/i);
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
		expect(decide(call("read", { path: `${AGENT}/mcp.json` }), policy())).toEqual({ action: "pass" });
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
