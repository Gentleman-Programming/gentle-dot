// Starts the daemon for Playwright with the fake agent, a fresh data dir, and a known token.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_TOKEN } from "./token.ts";

const dataDir = join(tmpdir(), "gentle-dot-e2e");
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "token"), `${E2E_TOKEN}\n`, { mode: 0o600 });

process.env.GENTLE_DOT_DATA_DIR = dataDir;
process.env.GENTLE_DOT_WORKSPACE = dataDir;
process.env.GENTLE_DOT_AGENT_BIN = process.execPath;
process.env.GENTLE_DOT_AGENT_ARGS = JSON.stringify([
	fileURLToPath(new URL("../packages/daemon/test/fixtures/fake-agent.ts", import.meta.url)),
]);
// A non-literal specifier keeps the daemon sources out of this tsconfig project.
const cli = "../packages/daemon/src/cli.ts";
await import(cli);
