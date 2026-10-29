import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSupervisor } from "../src/supervisor.ts";
import { FAKE_AGENT, fakeSupervisor, tempDir, waitFor } from "./helpers.ts";

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
		// Windows has no uid/gid, so `?? 0` used to fabricate a pair the fixture never reports (W5b).
		// The expectation is built from what the platform can actually say: the ids where they exist,
		// and no invented ids where they do not.
		const hasIds = Boolean(process.getuid && process.getgid);
		const ids = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
		// Where the platform has no ids, a configured user is inert and must not invent them.
		const expected = hasIds ? ids : {};
		const processFile = join(tempDir(), "process.json");
		const reported = () => JSON.parse(readFileSync(processFile, "utf8")) as { uid?: number; gid?: number };
		const env = { ...process.env, FAKE_AGENT_PROCESS_FILE: processFile };
		// Without a user, the agent runs as the daemon does today.
		const plain = track(fakeSupervisor({ env }));
		await plain.supervisor.start();
		expect(reported()).toMatchObject(expected);
		await plain.supervisor.stop();
		const as = track(fakeSupervisor({ env, user: ids }));
		if (hasIds) {
			await as.supervisor.start();
			expect(reported()).toMatchObject(ids);
			expect(as.supervisor.state).toBe("ready");
		} else {
			// Measured on Windows 11: Node does not ignore `uid`/`gid` there, it refuses the spawn with
			// ENOTSUP, so a configured user is a POSIX capability rather than an inert option.
			await expect(as.supervisor.start()).rejects.toThrow(/ENOTSUP/);
		}
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

	it("schedules one respawn per backoff step while the agent keeps dying at startup (no restart storm)", {
		timeout: 9000,
	}, async () => {
		// Measured on Windows (daemon.log, 2026-10-27): one crash of a healthy agent whose
		// respawns all died at startup became ~416k respawn attempts in five hours, because a
		// death during startup schedules the restart twice and the backoff never escalates.
		const dataDir = tempDir();
		const dieFlag = join(dataDir, "die");
		const spawnLog = join(dataDir, "spawns.txt");
		const launcher = join(dataDir, "launcher.mjs");
		writeFileSync(
			launcher,
			[
				"import { appendFileSync, existsSync } from 'node:fs';",
				"if (existsSync(process.env.DIE_FLAG)) {",
				`  appendFileSync(process.env.SPAWN_LOG, \`\${Date.now()}\\n\`);`,
				"  process.exit(3221225794);", // 0xC0000142, the incident's exit code
				"}",
				`await import(${JSON.stringify(pathToFileURL(FAKE_AGENT).href)});`,
			].join("\n"),
		);
		const { supervisor } = track(
			fakeSupervisor({
				command: process.execPath,
				args: [launcher],
				env: { ...process.env, DIE_FLAG: dieFlag, SPAWN_LOG: spawnLog },
			}),
		);
		await supervisor.start();
		writeFileSync(dieFlag, "");
		process.kill(supervisor.pid ?? 0, "SIGKILL");
		await new Promise((resolve) => setTimeout(resolve, 4000));
		const spawns = readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean);
		// The [50, 100, 200] backoff itself allows ~13 attempts in 4 s; a restart storm or a
		// backoff that never escalates produces multiples of that.
		expect(spawns.length).toBeLessThanOrEqual(20);
		expect(supervisor.state).toBe("restarting");
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

	it("a restart asked while the engine starts waits for it, then replaces it once (S1)", async () => {
		let spawns = 0;
		const logs: string[] = [];
		const { supervisor, events } = track(
			fakeSupervisor({
				env: { ...process.env, FAKE_AGENT_START_DELAY_MS: "300" },
				prepareSpawn: () => {
					spawns += 1;
					return {};
				},
				log: (line) => logs.push(line),
			}),
		);
		const starting = supervisor.start();
		const firstPid = supervisor.pid;
		// Two requests while starting (computer control, then connector files put back) make one restart.
		const restarts = [supervisor.restart(), supervisor.restart()];
		await expect(starting).resolves.toBeUndefined();
		await Promise.all(restarts);
		expect(supervisor.state).toBe("ready");
		expect(spawns).toBe(2);
		expect(supervisor.pid).not.toBe(firstPid);
		const states = events.flatMap((e) => (e.type === "supervisor_state" && "state" in e ? [e.state] : []));
		expect(states).toEqual(["starting", "ready", "restarting", "ready"]);
		expect(events.some((e) => e.type === "interrupted")).toBe(false);
		expect(logs.filter((line) => /exited unexpectedly|restart failed/.test(line))).toEqual([]);
	});

	it("a stop while a restart waits for the start starts nothing again", async () => {
		let spawns = 0;
		const { supervisor } = track(
			fakeSupervisor({
				env: { ...process.env, FAKE_AGENT_START_DELAY_MS: "300" },
				prepareSpawn: () => {
					spawns += 1;
					return {};
				},
			}),
		);
		const starting = supervisor.start().catch(() => {});
		const restarting = supervisor.restart();
		await supervisor.stop();
		await Promise.all([starting, restarting]);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(spawns).toBe(1);
		expect(supervisor.state).toBe("stopped");
		expect(supervisor.pid).toBeUndefined();
	});

	it("a restart while ready replaces the engine right away, once", async () => {
		let spawns = 0;
		const { supervisor, events } = track(
			fakeSupervisor({
				prepareSpawn: () => {
					spawns += 1;
					return {};
				},
			}),
		);
		await supervisor.start();
		await supervisor.restart();
		expect(spawns).toBe(2);
		const states = events.flatMap((e) => (e.type === "supervisor_state" && "state" in e ? [e.state] : []));
		expect(states).toEqual(["starting", "ready", "restarting", "ready"]);
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
});
