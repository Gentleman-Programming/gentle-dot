// Starts the daemon for Playwright with the fake agent, a fresh data dir, and a known token.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_COMMANDS_FILE, E2E_DATA_DIR, E2E_TOKEN } from "./token.ts";

const dataDir = E2E_DATA_DIR;
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "token"), `${E2E_TOKEN}\n`, { mode: 0o600 });

// Provider keys in the developer's environment would mark accounts as connected.
delete process.env.OPENAI_API_KEY;
// Never offer to import the developer's own profiles.
process.env.GENTLE_PI_CONFIG_HOME = join(dataDir, "no-shell-profiles");
// Profiles are applied to <dataDir>/agent; the fake agent records the live model switch.
delete process.env.GENTLE_DOT_AGENT_HOME;
process.env.FAKE_AGENT_COMMANDS_FILE = E2E_COMMANDS_FILE;
process.env.GENTLE_DOT_DATA_DIR = dataDir;
process.env.GENTLE_DOT_AGENT_BIN = process.execPath;
process.env.GENTLE_DOT_AGENT_ARGS = JSON.stringify([
	fileURLToPath(new URL("../packages/daemon/test/fixtures/fake-agent.ts", import.meta.url)),
]);
// A non-literal specifier keeps the daemon sources out of this tsconfig project.
const cli = "../packages/daemon/src/cli.ts";
await import(cli);
