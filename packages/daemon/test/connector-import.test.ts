// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are other apps' configs, written with their `${...}` references.
// S20: the user's MCP servers from other apps, found read-only in a fixture home, imported on request.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ImportCandidate, ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { scanClientConfigs } from "../src/connector-import.ts";
import { ConnectorManager, ConnectorStore } from "../src/connectors.ts";
import { tempDir, waitFor } from "./helpers.ts";

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-mcp-cli.ts", import.meta.url));
const SECRETS = ["ghp_desktopsecret", "sk_cursorsecret", "bar-secret-value", "lin-token-123"];

function write(home: string, path: string, value: unknown) {
	const file = join(home, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

/** One config file per client format, as each app writes it. */
function fixtureHome(): string {
	const home = tempDir();
	const github = {
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-github"],
		env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_desktopsecret" },
	};
	write(home, "Library/Application Support/Claude/claude_desktop_config.json", {
		mcpServers: {
			filesystem: {
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/x/Docs"],
			},
			github,
		},
	});
	write(home, ".config/Claude/claude_desktop_config.json", {
		mcpServers: { memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } },
	});
	write(home, ".claude.json", {
		numStartups: 3,
		mcpServers: {
			sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" },
			legacy: { type: "sse", url: "https://old.example.com/sse" },
		},
		projects: {
			[join(home, "proj")]: {
				mcpServers: {
					local1: { type: "stdio", command: "node", args: ["server.js"], env: { API_KEY: "${API_KEY}" } },
				},
			},
			[join(home, "missing-project")]: {},
		},
	});
	write(home, "proj/.mcp.json", { mcpServers: { projsrv: { command: "uvx", args: ["mcp-server-time"] } } });
	write(home, ".cursor/mcp.json", {
		mcpServers: {
			linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin-token-123" } },
			stripe: {
				url: "https://mcp.stripe.com?key=sk_cursorsecret",
				headers: { Authorization: "Bearer sk_cursorsecret" },
			},
			github,
		},
	});
	write(home, "Library/Application Support/Code/User/mcp.json", {
		inputs: [
			{ type: "promptString", id: "perplexity-key", description: "Perplexity API Key", password: true },
		],
		servers: {
			perplexity: {
				type: "stdio",
				command: "npx",
				args: ["-y", "server-perplexity-ask"],
				env: { PERPLEXITY_API_KEY: "${input:perplexity-key}" },
			},
			copilot: {
				type: "http",
				url: "https://api.githubcopilot.com/mcp/",
				headers: { Authorization: "Bearer ${env:GH_TOKEN}" },
			},
		},
	});
	write(home, ".config/Code/User/mcp.json", "{oops");
	write(home, ".codeium/windsurf/mcp_config.json", {
		mcpServers: {
			figma: { serverUrl: "https://mcp.figma.com/mcp" },
			oldsse: { serverUrl: "https://x.example.com/sse" },
		},
	});
	write(home, ".config/opencode/opencode.json", {
		$schema: "https://opencode.ai/config.json",
		mcp: {
			context7: {
				type: "remote",
				url: "https://mcp.context7.com/mcp",
				headers: { CONTEXT7_API_KEY: "{env:CTX7}" },
			},
			everything: {
				type: "local",
				command: ["npx", "-y", "@modelcontextprotocol/server-everything", "--token", "bar-secret-value"],
				environment: { FOO: "bar-secret-value" },
				enabled: true,
			},
		},
	});
	write(home, ".gentle-shell/agent/mcp.json", {
		mcpServers: { codegraph: { command: "codegraph", args: ["serve", "--mcp"], exposure: "codemode" } },
	});
	return home;
}

/** Every file below `home` with its hash and modification time. */
function snapshot(home: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const stat = statSync(path);
			if (stat.isDirectory()) walk(path);
			else out[path] = `${createHash("sha256").update(readFileSync(path)).digest("hex")}:${stat.mtimeMs}`;
		}
	};
	walk(home);
	return out;
}

async function engine() {
	const require = createRequire(import.meta.url);
	const load = async <T>(path: string) => {
		const file = (require.resolve.paths("@earendil-works/pi-coding-agent") ?? [])
			.map((dir) => join(dir, "@earendil-works", "pi-coding-agent", "dist", "core", path))
			.find((candidate) => existsSync(candidate));
		if (!file) throw new Error("the engine package is missing");
		return (await import(pathToFileURL(file).href)) as T;
	};
	return {
		...(await load<{ validateMcpServerConfig(name: string, raw: unknown): unknown }>("mcp-servers.js")),
		...(await load<{ resolveConfigValue(config: string): string | undefined }>("resolve-config-value.js")),
	};
}

describe("scanning other apps' MCP configs", () => {
	it("reads every client format and maps it to the engine's schema", () => {
		const home = fixtureHome();
		const found = scanClientConfigs(home);
		const byName = (name: string) => found.find((s) => s.name === name);
		expect(found.map((s) => `${s.source}:${s.name}`).sort()).toEqual(
			[
				"Claude Desktop:filesystem",
				"Claude Desktop:github",
				"Claude Desktop:memory",
				"Claude Code:sentry",
				"Claude Code:legacy",
				"Claude Code:local1",
				"Claude Code:projsrv",
				"Cursor:linear",
				"Cursor:stripe",
				"Cursor:github",
				"VS Code:perplexity",
				"VS Code:copilot",
				"Windsurf:figma",
				"Windsurf:oldsse",
				"OpenCode:context7",
				"OpenCode:everything",
				"Gentle Shell:codegraph",
			].sort(),
		);
		expect(byName("filesystem")?.server).toEqual({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/x/Docs"],
		});
		expect(byName("sentry")?.server).toEqual({ url: "https://mcp.sentry.dev/mcp" });
		for (const name of ["legacy", "oldsse"]) {
			expect(byName(name)?.server, name).toBeUndefined();
			expect(byName(name)).toMatchObject({ transport: "sse", reason: expect.stringMatching(/SSE/) });
		}
		expect(byName("figma")?.server).toEqual({ url: "https://mcp.figma.com/mcp" });
		// Claude Code's `${VAR}` and VS Code's `${env:VAR}` / OpenCode's `{env:VAR}` read the environment.
		expect(byName("local1")?.server).toMatchObject({ env: { API_KEY: "${API_KEY}" } });
		expect(byName("copilot")?.server).toMatchObject({ headers: { Authorization: "Bearer ${GH_TOKEN}" } });
		expect(byName("context7")?.server).toMatchObject({ headers: { CONTEXT7_API_KEY: "${CTX7}" } });
		expect(byName("everything")?.server).toMatchObject({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-everything", "--token", "bar-secret-value"],
			env: { FOO: "bar-secret-value" },
		});
		// VS Code inputs become values the user types in the app.
		expect(byName("perplexity")?.server).toMatchObject({
			env: { PERPLEXITY_API_KEY: "${input:perplexity-key}" },
		});
		expect(byName("perplexity")?.fields).toEqual([
			{ key: "perplexity-key", label: "Perplexity API Key", secret: true },
		]);
		// Gentle Shell entries keep their server, not the other app's exposure.
		expect(byName("codegraph")?.server).toEqual({ command: "codegraph", args: ["serve", "--mcp"] });
	});

	it("finds nothing in an empty home and skips files it cannot read", () => {
		expect(scanClientConfigs(tempDir())).toEqual([]);
	});
});

const managers: ConnectorManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.cancelAll();
});

function setup(home: string) {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const logs: string[] = [];
	const store = new ConnectorStore({ dataDir, agentHome });
	const manager = new ConnectorManager({
		store,
		cli: { command: process.execPath, args: [FAKE_CLI] },
		env: { ...process.env, HOME: join(dataDir, "home") },
		cwd: dataDir,
		importHome: home,
		log: (line) => logs.push(line),
	});
	managers.push(manager);
	const owner = {};
	const sent: ServerPayload[] = [];
	const emit = (payload: ServerPayload) => sent.push(payload);
	return { agentHome, dataDir, store, manager, logs, owner, sent, emit };
}

const pick = (found: ImportCandidate[], name: string) => {
	const candidate = found.find((c) => c.name === name);
	if (!candidate) throw new Error(`${name} was not found`);
	return candidate;
};

describe("importing MCP servers", () => {
	it("lists what it found with the source app and names only, never values", () => {
		const home = fixtureHome();
		const { manager, store } = setup(home);
		store.update((state) => {
			state.connectors.notion = { enabled: true, mode: "read_only" };
		});
		const found = manager.scan();
		const text = JSON.stringify(found);
		for (const secret of SECRETS) expect(text).not.toContain(secret);
		expect(pick(found, "github")).toEqual({
			id: expect.any(String),
			name: "github",
			sources: ["Claude Desktop", "Cursor"],
			transport: "stdio",
			summary: "npx -y @modelcontextprotocol/server-github",
			envNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
			headerNames: [],
			inputs: [],
			importable: true,
		});
		expect(pick(found, "stripe")).toMatchObject({
			transport: "http",
			summary: "https://mcp.stripe.com/",
			headerNames: ["Authorization"],
		});
		expect(pick(found, "everything").summary).toBe(
			"npx -y @modelcontextprotocol/server-everything --token •••",
		);
		expect(pick(found, "perplexity")).toMatchObject({
			inputs: ["Perplexity API Key"],
			envNames: ["PERPLEXITY_API_KEY"],
		});
		expect(pick(found, "legacy")).toMatchObject({
			transport: "sse",
			importable: false,
			reason: expect.stringMatching(/SSE/),
		});
		// The catalog has Linear with a curated list, so its import is offered as a duplicate.
		expect(pick(found, "linear")).toMatchObject({ importable: false, duplicateOf: "linear" });
		expect(found.filter((c) => c.name === "github")).toHaveLength(1);
	});

	it("copies the chosen servers with their values into private state, read only and hidden, without touching the sources", async () => {
		const home = fixtureHome();
		const before = snapshot(home);
		const { manager, store, agentHome, dataDir, logs, owner, emit, sent } = setup(home);
		const { validateMcpServerConfig, resolveConfigValue } = await engine();
		const found = manager.scan();
		const chosen = ["github", "stripe", "copilot", "everything", "perplexity", "legacy", "linear"].map(
			(name) => pick(found, name).id,
		);
		expect(manager.importServers(chosen).sort()).toEqual([
			"copilot",
			"everything",
			"github",
			"perplexity",
			"stripe",
		]);
		const mcp = JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8")).mcpServers as Record<
			string,
			Record<string, unknown>
		>;
		for (const [name, config] of Object.entries(mcp)) {
			expect(typeof validateMcpServerConfig(name, config), name).toBe("object");
			expect(config.toolExposure, name).toEqual({ "*": "hidden" });
		}
		expect(
			resolveConfigValue(
				(mcp.github?.env as Record<string, string> | undefined)?.GITHUB_PERSONAL_ACCESS_TOKEN ?? "",
			),
		).toBe("ghp_desktopsecret");
		expect(
			resolveConfigValue((mcp.stripe?.headers as Record<string, string> | undefined)?.Authorization ?? ""),
		).toBe("Bearer sk_cursorsecret");
		expect((mcp.copilot?.headers as Record<string, string> | undefined)?.Authorization).toBe(
			"Bearer ${GH_TOKEN}",
		);
		// A server that still needs a typed value waits for it.
		expect(mcp.perplexity).toBeUndefined();
		const list = manager.list();
		expect(list.find((c) => c.id === "perplexity")).toMatchObject({
			status: "needs_setup",
			mode: "read_only",
		});
		expect(list.find((c) => c.id === "github")).toMatchObject({
			status: "connected",
			enabled: true,
			mode: "read_only",
			custom: {
				origin: "Imported from Claude Desktop",
				summary: "npx -y @modelcontextprotocol/server-github",
			},
		});
		expect(store.policy().connectors?.github?.readOnlyTools).toEqual([]);
		// The import itself is never shown or logged with its values.
		for (const secret of SECRETS) {
			expect(JSON.stringify(list)).not.toContain(secret);
			expect(logs.join("\n")).not.toContain(secret);
		}
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).toContain("ghp_desktopsecret");
		// The VS Code input is typed in the app.
		expect(manager.setup(owner, "perplexity", emit)).toBeUndefined();
		const prompt = await waitFor(() => sent.flatMap((m) => (m.type === "auth_prompt" ? [m.prompt] : []))[0]);
		expect(prompt).toMatchObject({ kind: "secret", message: expect.stringContaining("Perplexity API Key") });
		manager.reply(owner, prompt.flowId, { value: "pplx-typed" });
		await waitFor(() => sent.find((m) => m.type === "auth_done"));
		const perplexity = JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8")).mcpServers.perplexity;
		expect(resolveConfigValue(perplexity.env.PERPLEXITY_API_KEY)).toBe("pplx-typed");
		expect(JSON.stringify(sent)).not.toContain("pplx-typed");
		// Importing again adds nothing: they are already connectors.
		const again = manager.scan();
		expect(pick(again, "github")).toMatchObject({ importable: false, duplicateOf: "github" });
		expect(manager.importServers([pick(again, "github").id, "unknown:id"])).toEqual([]);
		expect(snapshot(home)).toEqual(before);
	});

	it("imports nothing before a scan", () => {
		const { manager, store } = setup(fixtureHome());
		expect(manager.importServers(["Cursor:github"])).toEqual([]);
		expect(store.state()).toEqual({ connectors: {} });
	});
});
