/**
 * T3: the engine must keep its sessions on disk, or every restart (and every rotation) throws
 * the conversation away. Production passed --session-dir; the refactored daemon did not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bootDaemon } from "./harness.ts";
import { tempDir, waitFor } from "./helpers.ts";

vi.setConfig({ testTimeout: 180_000 });

describe("the engine keeps its session files (T3)", () => {
	it("starts the engine with a session dir inside the daemon's data dir", async () => {
		const argsFile = join(tempDir(), "agent-args.json");
		const booted = await bootDaemon({ env: { FAKE_AGENT_ARGS_FILE: argsFile } });

		await waitFor(() => {
			try {
				readFileSync(argsFile, "utf8");
				return true;
			} catch {
				return false;
			}
		}, 60_000);

		const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
		const at = argv.indexOf("--session-dir");
		expect(at).toBeGreaterThanOrEqual(0);
		const sessionDir = argv[at + 1];
		expect(sessionDir).toBe(join(booted.dataDir, "sessions"));

		await booted.stop();
	});
});
