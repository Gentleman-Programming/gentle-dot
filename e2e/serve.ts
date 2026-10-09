// Starts the daemon for Playwright with the fake agent, a fresh data dir, and a known token.
// It also starts a second daemon, with the conversations list on, and waits for it first.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	E2E_COMMANDS_FILE,
	E2E_CONVERSATIONS_DATA_DIR,
	E2E_CONVERSATIONS_PORT,
	E2E_DATA_DIR,
	E2E_IMPORT_HOME,
	E2E_TOKEN,
} from "./token.ts";

const conversations = process.env.E2E_CONVERSATIONS === "1";
const dataDir = conversations ? E2E_CONVERSATIONS_DATA_DIR : E2E_DATA_DIR;
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "token"), `${E2E_TOKEN}\n`, { mode: 0o600 });

if (!conversations) {
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
		env: { ...process.env, E2E_CONVERSATIONS: "1", GENTLE_DOT_PORT: String(E2E_CONVERSATIONS_PORT) },
		stdio: "inherit",
	});
	process.on("exit", () => child.kill());
	await waitForHealth(`http://127.0.0.1:${E2E_CONVERSATIONS_PORT}/health`);
}

// Provider keys in the developer's environment would mark accounts as connected.
delete process.env.OPENAI_API_KEY;
// Never offer to import the developer's own profiles.
process.env.GENTLE_PI_CONFIG_HOME = join(dataDir, "no-shell-profiles");
// Profiles are applied to <dataDir>/agent; the fake agent records the live model switch.
delete process.env.GENTLE_DOT_AGENT_HOME;
process.env.FAKE_AGENT_COMMANDS_FILE = conversations
	? join(dataDir, "agent-commands.jsonl")
	: E2E_COMMANDS_FILE;
process.env.GENTLE_DOT_DATA_DIR = dataDir;
// Connector sign-in runs a stand-in for the engine's `mcp login`, which waits for the pasted address.
process.env.GENTLE_DOT_MCP_CLI = JSON.stringify([
	process.execPath,
	fileURLToPath(new URL("../packages/daemon/test/fixtures/fake-mcp-cli.ts", import.meta.url)),
]);
process.env.GENTLE_DOT_AGENT_BIN = process.execPath;
process.env.GENTLE_DOT_AGENT_ARGS = JSON.stringify([
	fileURLToPath(new URL("../packages/daemon/test/fixtures/fake-agent.ts", import.meta.url)),
]);
// "Import my MCP servers" scans a stand-in home with other apps' configs, never the developer's.
process.env.GENTLE_DOT_IMPORT_HOME = E2E_IMPORT_HOME;
if (!conversations) writeImportHome(E2E_IMPORT_HOME);
if (conversations) {
	process.env.GENTLE_DOT_CONVERSATIONS = "1";
} else {
	delete process.env.GENTLE_DOT_CONVERSATIONS;
	// Rotate after two compactions and send short history pages, so one test can cross a rotation.
	process.env.GENTLE_DOT_ROTATE_COMPACTIONS = "2";
	process.env.GENTLE_DOT_HISTORY_PAGE = "4";
}
// A non-literal specifier keeps the daemon sources out of this tsconfig project.
const cli = "../packages/daemon/src/cli.ts";
await import(cli);

function writeImportHome(home: string): void {
	rmSync(home, { recursive: true, force: true });
	const write = (path: string, value: unknown) => {
		mkdirSync(dirname(join(home, path)), { recursive: true });
		writeFileSync(join(home, path), JSON.stringify(value, null, 2));
	};
	write(".cursor/mcp.json", {
		mcpServers: {
			github: {
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-github"],
				env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_e2e_secret_value" },
			},
		},
	});
	write(".codeium/windsurf/mcp_config.json", {
		mcpServers: { oldsse: { serverUrl: "https://old.example.com/sse" } },
	});
	write("Library/Application Support/Code/User/mcp.json", {
		inputs: [{ type: "promptString", id: "key", description: "Search API key", password: true }],
		servers: {
			search: {
				type: "stdio",
				command: "npx",
				args: ["-y", "search-mcp"],
				// biome-ignore lint/suspicious/noTemplateCurlyInString: a VS Code input reference.
				env: { SEARCH_KEY: "${input:key}" },
			},
		},
	});
}

async function waitForHealth(url: string): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		const up = await fetch(url).then(
			(response) => response.ok,
			() => false,
		);
		if (up) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`the conversations daemon did not start: ${url}`);
}
