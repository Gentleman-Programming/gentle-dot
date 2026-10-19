import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSupervisor } from "../src/supervisor.ts";
import { alive, fakeSupervisor, settled, tempDir, waitFor } from "./helpers.ts";

const running: AgentSupervisor[] = [];
afterEach(async () => {
	await Promise.all(running.splice(0).map((s) => s.stop()));
});

function track<T extends { supervisor: AgentSupervisor }>(value: T): T {
	running.push(value.supervisor);
	return value;
}

describe("AgentSupervisor", () => {
	it("spawns the agent in RPC mode with the session dir and extra args", async () => {
		const argsFile = join(tempDir(), "argv.json");
		const { supervisor, dataDir } = track(
			fakeSupervisor({ env: { ...process.env, FAKE_AGENT_ARGS_FILE: argsFile }, extraArgs: ["--x", "1"] }),
		);
		await supervisor.start();
		const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
		expect(argv).toEqual(["--mode", "rpc", "--session-dir", join(dataDir, "sessions"), "--x", "1"]);
		expect(supervisor.state).toBe("ready");
	});

	it("starts the agent as the configured user, and as the daemon's own user without one (S25.8)", async () => {
		const own = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
		const processFile = join(tempDir(), "process.json");
		const env = { ...process.env, FAKE_AGENT_PROCESS_FILE: processFile };
		// Without a user, the agent runs as the daemon does today.
		const plain = track(fakeSupervisor({ env }));
		await plain.supervisor.start();
		expect(JSON.parse(readFileSync(processFile, "utf8"))).toMatchObject(own);
		await plain.supervisor.stop();
		const as = track(fakeSupervisor({ env, user: own }));
		await as.supervisor.start();
		expect(JSON.parse(readFileSync(processFile, "utf8"))).toMatchObject(own);
		expect(as.supervisor.state).toBe("ready");
	});

	it.skipIf((process.getuid?.() ?? 0) === 0)(
		"applies the user to the spawn: one it cannot take is refused",
		async () => {
			const own = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
			const { supervisor } = track(
				fakeSupervisor({ user: { uid: own.uid + 1, gid: own.gid }, startTimeoutMs: 2000 }),
			);
			await expect(supervisor.start()).rejects.toThrow();
			expect(supervisor.state).not.toBe("ready");
		},
	);

	it("correlates responses by id across concurrent commands", async () => {
		const { supervisor } = track(fakeSupervisor());
		await supervisor.start();
		const [state, commands] = await Promise.all([
			supervisor.request({ type: "get_state" }),
			supervisor.request({ type: "get_commands" }),
		]);
		expect(state.command).toBe("get_state");
		expect(commands.command).toBe("get_commands");
	});

	it("rejects a failed command with the agent's error", async () => {
		const { supervisor } = track(fakeSupervisor());
		await supervisor.start();
		await expect(supervisor.request({ type: "switch_session", sessionPath: "/nope.jsonl" })).rejects.toThrow(
			"Session not found",
		);
	});

	it("forwards session events and tracks busy until agent_settled", async () => {
		const { supervisor, events } = track(fakeSupervisor());
		await supervisor.start();
		await supervisor.request({ type: "prompt", message: "hello" });
		await waitFor(() => events.some((e) => e.type === "agent_settled"));
		expect(events.map((e) => e.type)).toContain("message_update");
		expect(supervisor.busy).toBe(false);
	});

	it("is not left busy when the run settles before the prompt response is handled", async () => {
		const { supervisor, events } = track(fakeSupervisor());
		await supervisor.start();
		await supervisor.request({ type: "prompt", message: "burst" });
		expect(events.some((e) => e.type === "agent_settled")).toBe(true);
		expect(supervisor.busy).toBe(false);
	});

	it("respawns after a crash, reopens the same conversation, and reports the interruption", async () => {
		const { supervisor, events } = track(fakeSupervisor());
		await supervisor.start();
		await supervisor.request({ type: "prompt", message: "first" });
		await waitFor(() => events.some((e) => e.type === "agent_settled"));
		const sessionBefore = supervisor.sessionFile;
		const pidBefore = supervisor.pid;

		await supervisor.request({ type: "prompt", message: "crash" });
		await waitFor(() => events.some((e) => e.type === "interrupted"));

		expect(supervisor.state).toBe("ready");
		expect(supervisor.pid).not.toBe(pidBefore);
		expect(supervisor.sessionFile).toBe(sessionBefore);
		const states = events.flatMap((e) => (e.type === "supervisor_state" && "state" in e ? [e.state] : []));
		expect(states).toContain("restarting");
		const history = await supervisor.request({ type: "get_messages" });
		const texts = (history.data as { messages: { content: unknown }[] }).messages.map((m) => m.content);
		expect(texts[0]).toBe("first");
	});

	it("does not report an interruption when the agent dies while idle", async () => {
		const { supervisor, events } = track(fakeSupervisor());
		await supervisor.start();
		process.kill(supervisor.pid ?? 0, "SIGKILL");
		await waitFor(
			() =>
				events.filter((e) => e.type === "supervisor_state" && "state" in e && e.state === "ready").length >=
				2,
		);
		expect(events.some((e) => e.type === "interrupted")).toBe(false);
	});

	it("rejects pending commands when the agent exits", async () => {
		const { supervisor } = track(fakeSupervisor());
		await supervisor.start();
		const pending = supervisor.request({ type: "noreply" });
		process.kill(supervisor.pid ?? 0, "SIGKILL");
		await expect(pending).rejects.toThrow(/agent exited/i);
	});

	it("reopens the last conversation after the daemon itself restarts", async () => {
		const dataDir = tempDir();
		const first = track(fakeSupervisor({ dataDir }));
		await first.supervisor.start();
		await first.supervisor.request({ type: "prompt", message: "remember me" });
		await waitFor(() => first.events.some((e) => e.type === "agent_settled"));
		await waitFor(() => first.supervisor.sessionFile && first.supervisor.sessionFile);
		const session = first.supervisor.sessionFile;
		await first.supervisor.stop();

		const second = track(fakeSupervisor({ dataDir }));
		await second.supervisor.start();
		expect(second.supervisor.sessionFile).toBe(session);
	});

	it("restarts on request, keeping the conversation and without an interruption", async () => {
		const { supervisor, events } = track(fakeSupervisor());
		await supervisor.start();
		await supervisor.request({ type: "prompt", message: "keep me" });
		await waitFor(() => events.some((e) => e.type === "agent_settled"));
		const session = supervisor.sessionFile;
		const pid = supervisor.pid;
		await supervisor.restart();
		expect(supervisor.state).toBe("ready");
		expect(supervisor.pid).not.toBe(pid);
		expect(supervisor.sessionFile).toBe(session);
		expect(events.some((e) => e.type === "interrupted")).toBe(false);
	});

	it("a stop during a restart starts nothing again (S35.2: the app quitting does both)", async () => {
		const { supervisor } = track(fakeSupervisor());
		await supervisor.start();
		const restarting = supervisor.restart();
		await supervisor.stop();
		await restarting;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(supervisor.state).toBe("stopped");
		expect(supervisor.pid).toBeUndefined();
	});

	it("stops cleanly and reports the stopped state", async () => {
		const { supervisor } = track(fakeSupervisor());
		await supervisor.start();
		await supervisor.stop();
		expect(supervisor.state).toBe("stopped");
		await expect(supervisor.request({ type: "get_state" })).rejects.toThrow(/not ready/i);
	});

	it("a restart while the agent is starting kills the starting child at once, without a failure", async () => {
		const attemptsFile = join(tempDir(), "attempts.json");
		const argsFile = join(tempDir(), "argv.json");
		const { supervisor } = track(
			fakeSupervisor({
				env: {
					...process.env,
					FAKE_AGENT_ARGS_FILE: argsFile,
					FAKE_AGENT_ATTEMPTS_FILE: attemptsFile,
					// The first attempt never becomes ready and leaves only on a SIGKILL.
					FAKE_AGENT_STALL_START_AT: "1",
					FAKE_AGENT_IGNORE_SIGNALS_AT: "1",
				},
				stopTimeoutMs: 500,
			}),
		);
		const starting = supervisor.start().then(
			() => "settled" as const,
			(error: Error) => error,
		);
		// The child has to be up (and stalled) before the restart lands on it.
		await waitFor(() => existsSync(argsFile));
		const pid = supervisor.pid as number;
		const superseded = await settled(
			supervisor.restart().then(() => "done" as const),
			1500,
		);
		expect(superseded).toBe("done");
		expect(await starting).toBe("settled");
		expect(alive(pid)).toBe(false);
		expect(supervisor.pid).not.toBe(pid);
		expect(supervisor.state).toBe("ready");
	});

	it("a restart that replaces a scheduled retry does not report the replaced attempt as a failure", async () => {
		const attemptsFile = join(tempDir(), "attempts.json");
		const logs: string[] = [];
		const { supervisor } = track(
			fakeSupervisor({
				env: {
					...process.env,
					FAKE_AGENT_ATTEMPTS_FILE: attemptsFile,
					// The first attempt is ready; the retry its crash schedules never becomes ready.
					FAKE_AGENT_STALL_START_AT: "2",
				},
				log: (line) => logs.push(line),
			}),
		);
		await supervisor.start();
		process.kill(supervisor.pid ?? 0, "SIGKILL");
		// The supervisor's own backoff schedules attempt 2, which stalls.
		await waitFor(() => readFileSync(attemptsFile, "utf8") === "2");
		// A restart lands on that scheduled attempt and replaces it before it is ready.
		await supervisor.restart();
		expect(supervisor.state).toBe("ready");
		expect(logs.filter((line) => line.includes("agent restart failed"))).toEqual([]);
	});

	it("a stop while the agent is starting kills the starting child at once", async () => {
		const grace = 500;
		const argsFile = join(tempDir(), "argv.json");
		const { supervisor } = track(
			fakeSupervisor({
				env: {
					...process.env,
					FAKE_AGENT_ARGS_FILE: argsFile,
					FAKE_AGENT_ATTEMPTS_FILE: join(tempDir(), "attempts.json"),
					FAKE_AGENT_STALL_START_AT: "1",
					FAKE_AGENT_IGNORE_SIGNALS_AT: "1",
				},
				stopTimeoutMs: grace,
			}),
		);
		const starting = supervisor.start().catch(() => {});
		await waitFor(() => existsSync(argsFile));
		const pid = supervisor.pid as number;
		const began = Date.now();
		await supervisor.stop();
		expect(Date.now() - began).toBeLessThan(grace);
		expect(alive(pid)).toBe(false);
		expect(supervisor.state).toBe("stopped");
		await starting;
	});

	it("a ready agent still stops on its stdin, inside the grace window", async () => {
		const signals = join(tempDir(), "signals.txt");
		const grace = 5000;
		const { supervisor } = track(
			fakeSupervisor({ env: { ...process.env, FAKE_AGENT_SIGNALS_FILE: signals }, stopTimeoutMs: grace }),
		);
		await supervisor.start();
		const pid = supervisor.pid as number;
		const began = Date.now();
		await supervisor.stop();
		expect(Date.now() - began).toBeLessThan(grace);
		expect(existsSync(signals)).toBe(false);
		expect(supervisor.state).toBe("stopped");
		expect(alive(pid)).toBe(false);
	});

	it("a ready agent's restart ends its stdin without signalling it", async () => {
		const signals = join(tempDir(), "signals.txt");
		const { supervisor } = track(
			fakeSupervisor({ env: { ...process.env, FAKE_AGENT_SIGNALS_FILE: signals } }),
		);
		await supervisor.start();
		const pid = supervisor.pid as number;
		await supervisor.restart();
		expect(existsSync(signals)).toBe(false);
		expect(supervisor.pid).not.toBe(pid);
		expect(supervisor.state).toBe("ready");
	});
});
