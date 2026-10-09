import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_TOKEN = "e2e-token-0123456789abcdefghijklmnopqrstuv";
/** The daemon's data dir during e2e runs (see serve.ts). */
export const E2E_DATA_DIR = join(tmpdir(), "gentle-dot-e2e");
/** The fake agent appends every model command it receives here. */
export const E2E_COMMANDS_FILE = join(E2E_DATA_DIR, "agent-commands.jsonl");
/** A second daemon with the conversations list on (it is off by default), for the tests of that feature. */
export const E2E_CONVERSATIONS_PORT = 4392;
export const E2E_CONVERSATIONS_DATA_DIR = join(tmpdir(), "gentle-dot-e2e-conversations");
/** A stand-in home with other apps' MCP configs, scanned by "Import my MCP servers" (never the real one). */
export const E2E_IMPORT_HOME = join(tmpdir(), "gentle-dot-e2e-import-home");
