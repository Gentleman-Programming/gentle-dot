import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_TOKEN = "e2e-token-0123456789abcdefghijklmnopqrstuv";
/** The daemon's data dir during e2e runs (see serve.ts). */
export const E2E_DATA_DIR = join(tmpdir(), "gentle-dot-e2e");
/** The fake agent appends every model command it receives here. */
export const E2E_COMMANDS_FILE = join(E2E_DATA_DIR, "agent-commands.jsonl");
