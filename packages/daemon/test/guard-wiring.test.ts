/**
 * Security: the engine must load the approval guard, and the subagents it spawns must get the
 * child guard from the agent home's extensions folder. Production did both; the refactored
 * daemon did neither, so a tool call could run without asking.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CHILD_GUARD_NAME, childGuardFile } from "../src/child-guard.ts";
import { bootDaemon } from "./harness.ts";
import { tempDir, waitFor } from "./helpers.ts";

vi.setConfig({ testTimeout: 180_000 });

describe("the approval guard reaches the engine (T3)", () => {
	it("passes -e with the guard and installs the child guard in the agent home", async () => {
		const argsFile = join(tempDir(), "agent-args.json");
		const agentHome = join(tempDir(), "agent");
		const booted = await bootDaemon({
			env: { FAKE_AGENT_ARGS_FILE: argsFile, GENTLE_DOT_AGENT_HOME: agentHome },
		});

		await waitFor(() => existsSync(argsFile), 60_000);
		const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];

		// The engine loads the guard itself…
		const at = argv.indexOf("-e");
		expect(at).toBeGreaterThanOrEqual(0);
		expect(argv[at + 1]).toMatch(/approval-guard\.ts$/);

		// …and the subagents of that engine find the child guard in the agent home.
		const childGuard = childGuardFile(agentHome);
		expect(childGuard.endsWith(CHILD_GUARD_NAME)).toBe(true);
		await waitFor(() => existsSync(childGuard), 60_000);
		expect(readFileSync(childGuard, "utf8")).toMatch(/approval-guard\.ts/);

		await booted.stop();
	});
});
