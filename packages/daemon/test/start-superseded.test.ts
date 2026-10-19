// The desktop app registers computer control while the daemon is still starting. That change needs
// a restart, and the restart must not be reported as the starting agent failing (T25): the daemon
// says what happened in its own voice, and claims an agent only when one is ready. A replacement
// that fails is reported once by the bridge, without the daemon waiting for the supervisor's retries.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeApp } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const REPLACED = "the agent was restarted while it was starting; the first start was replaced";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

const health = (port: number) =>
	fetch(`http://127.0.0.1:${port}/health`).then(
		(res) => res.ok,
		() => false,
	);

/**
 * Starts the daemon and, once its agent process exists, registers computer control as the app does:
 * by then the supervisor is inside `start()`, which is exactly when the restart used to land.
 * `duringStart` runs after that registration and before the daemon is back, for a test that stops
 * the assistant (the app quitting) while the replacement is still starting.
 */
async function startAndRegister(
	agentEnv: NodeJS.ProcessEnv,
	duringStart: (app: ReturnType<typeof fakeApp>) => void = () => {},
) {
	const dataDir = tempDir();
	const argsFile = join(tempDir(), "argv.json");
	const attemptsFile = join(tempDir(), "attempts.json");
	const logs: string[] = [];
	const app = fakeApp();
	const fake = fakeAuthRuntime();
	const starting = startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentHome: join(dataDir, "agent"),
		agentEnv: {
			...process.env,
			FAKE_AGENT_ARGS_FILE: argsFile,
			FAKE_AGENT_ATTEMPTS_FILE: attemptsFile,
			...agentEnv,
		},
		backoffMs: [50],
		authRuntime: async () => fake.runtime,
		appChannel: app.daemonEnd,
		log: (line) => logs.push(line),
	});
	await waitFor(() => existsSync(argsFile), 10_000);
	await app.request("computer_register", { url: "http://127.0.0.1:41234/mcp", token: "start-test-token-1" });
	duringStart(app);
	const daemon = await starting;
	daemons.push(daemon);
	return { daemon, logs, attemptsFile };
}

describe("a start a restart supersedes", () => {
	it("is reported once, and only with the agent the replacement made ready", async () => {
		// The first attempt never answers get_state, so it is still starting when the app registers.
		const { daemon, logs, attemptsFile } = await startAndRegister({ FAKE_AGENT_STALL_START_AT: "1" });
		const joined = logs.join("\n");
		expect(joined).not.toMatch(/agent failed to start/);
		expect(joined).not.toMatch(/agent exited unexpectedly/);
		// Exactly once: reported as a replacement, never next to a failure of its own.
		expect(logs.filter((line) => line === REPLACED).length).toBe(1);
		// Only now is the daemon back, and the agent it claims is ready.
		expect(daemon.supervisor.state).toBe("ready");
		expect(await health(daemon.port)).toBe(true);
		expect(Number(readFileSync(attemptsFile, "utf8"))).toBe(2);
	});

	it("claims nothing when the replacement fails: one report, and the retry keeps going", async () => {
		const { daemon, logs, attemptsFile } = await startAndRegister({
			FAKE_AGENT_STALL_START_AT: "1",
			// The replacement exits before it is ready; the supervisor's own scheduling retries.
			FAKE_AGENT_EXIT_START_AT: "2",
		});
		// The daemon must not wait for those retries: each one backs off (up to 30 s per attempt in
		// production), and the app would stay unreachable behind the supervisor's own loop.
		expect(daemon.supervisor.state).toBe("restarting");
		const joined = logs.join("\n");
		expect(joined).not.toMatch(/agent failed to start/);
		// A replacement that never came up is not a replacement that happened.
		expect(joined).not.toContain(REPLACED);
		// Its own failure is reported exactly once, by the bridge's existing path.
		expect(logs.filter((line) => line.includes("agent restart failed")).length).toBe(1);
		await waitFor(() => daemon.supervisor.state === "ready");
		expect(Number(readFileSync(attemptsFile, "utf8"))).toBe(3);
	});

	it("claims nothing when a stop interrupts the replacement", async () => {
		// Neither attempt ever becomes ready, so the app quitting lands while the replacement that
		// superseded the first start is still starting.
		const { daemon, logs } = await startAndRegister({ FAKE_AGENT_STALL_START_AT: "1,2" }, (app) =>
			app.close(),
		);
		expect(daemon.supervisor.state).toBe("stopped");
		expect(logs.join("\n")).not.toContain(REPLACED);
	});
});
