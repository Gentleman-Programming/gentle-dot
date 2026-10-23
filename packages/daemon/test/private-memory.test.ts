// A4: with GENTLE_DOT_ENGRAM=private, the memory server the engine starts outlives it. The daemon
// stops it when it closes, only when the daemon caused it (nothing listened on the private port
// at start) and it serves the private data folder. The memory server here is a stand-in on a
// free port; nothing is stopped by name, only the PIDs this test started.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryMode } from "../src/config.ts";
import { applyMemoryMode, startDaemon } from "../src/daemon.ts";
import { isolatedAgentEnv, PRIVATE_ENGRAM_PORT, privateMemory } from "../src/isolation.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const hasLsof = (() => {
	try {
		execFileSync("which", ["lsof"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const started: ChildProcess[] = [];
afterEach(() => {
	for (const child of started.splice(0))
		if (child.exitCode === null && child.signalCode === null) child.kill();
});

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

/** A memory server stand-in: answers /health with its instance id, like Engram. */
async function memoryServer(port: number, instanceId: string): Promise<ChildProcess> {
	const child = spawn(
		process.execPath,
		[
			"-e",
			`require("http").createServer((q, s) => s.end(JSON.stringify({ status: "ok", instance_id: ${JSON.stringify(instanceId)} }))).listen(${port}, "127.0.0.1", () => console.log("up"))`,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	started.push(child);
	await new Promise((resolve) => child.stdout?.once("data", resolve));
	return child;
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

async function daemon(port: number) {
	const dataDir = tempDir();
	// The private memory's data folder is under the engine's home: <data>/home/.engram.
	mkdirSync(join(dataDir, "home", ".engram"), { recursive: true });
	writeFileSync(join(dataDir, "home", ".engram", ".instance-id"), "private-instance\n");
	return startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentHome: join(dataDir, "agent"),
		agentEnv: {
			PATH: process.env.PATH,
			HOME: tempDir(),
			GENTLE_DOT_ENGRAM: "private",
			GENTLE_DOT_ENGRAM_PORT: String(port),
		},
	});
}

// The contract `privateMemory` owns (isolation.ts), pinned directly and on every platform: its
// stop() decides by the listener's /health instance id against the private store's `.instance-id`.
describe("privateMemory's contract", () => {
	it("is undefined outside private mode", async () => {
		const lines: string[] = [];
		const log = (line: string) => lines.push(line);
		expect(await privateMemory({}, tempDir(), log)).toBeUndefined();
		expect(await privateMemory({ GENTLE_DOT_ENGRAM: "shared" }, tempDir(), log)).toBeUndefined();
		expect(lines).toEqual([]);
	});

	it("is undefined when a memory server already listened on the private port at start", async () => {
		const port = String(await freePort());
		const already = await memoryServer(Number(port), "private-instance");
		const lines: string[] = [];
		const handle = await privateMemory(
			{ GENTLE_DOT_ENGRAM: "private", GENTLE_DOT_ENGRAM_PORT: port },
			tempDir(),
			(line) => lines.push(line),
		);
		expect(handle).toBeUndefined();
		expect(lines).toEqual([]);
		expect(running(already)).toBe(true);
	});

	it("stops the listener whose /health instance id is the private store's", async () => {
		const dataDir = tempDir();
		mkdirSync(join(dataDir, "home", ".engram"), { recursive: true });
		writeFileSync(join(dataDir, "home", ".engram", ".instance-id"), "private-instance\n");
		const port = String(await freePort());
		const lines: string[] = [];
		const handle = await privateMemory(
			{ GENTLE_DOT_ENGRAM: "private", GENTLE_DOT_ENGRAM_PORT: port },
			dataDir,
			(line) => lines.push(line),
		);
		expect(handle).toBeDefined();
		const server = await memoryServer(Number(port), "private-instance");
		await handle?.stop();
		await waitFor(() => !running(server));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^stopped the private memory server \(pid \d+\)$/);
	});

	it("leaves a listener that serves other data running, and says so", async () => {
		const dataDir = tempDir();
		mkdirSync(join(dataDir, "home", ".engram"), { recursive: true });
		writeFileSync(join(dataDir, "home", ".engram", ".instance-id"), "ours\n");
		const port = String(await freePort());
		const lines: string[] = [];
		const handle = await privateMemory(
			{ GENTLE_DOT_ENGRAM: "private", GENTLE_DOT_ENGRAM_PORT: port },
			dataDir,
			(line) => lines.push(line),
		);
		expect(handle).toBeDefined();
		const server = await memoryServer(Number(port), "someone-else");
		await handle?.stop();
		expect(lines).toEqual([`the memory server on port ${port} serves other data; left running`]);
		expect(running(server)).toBe(true);
	});
});

describe.skipIf(!hasLsof)("private memory server (A4)", () => {
	it("stops the private memory server it caused to start, by PID, when it closes", async () => {
		const port = await freePort();
		const d = await daemon(port);
		const memory = await memoryServer(port, "private-instance");
		await d.close();
		await waitFor(() => !running(memory));
		expect(memory.signalCode).toBe("SIGTERM");
	});

	it("leaves a memory server that was already running, or that serves other data", async () => {
		const before = await freePort();
		const already = await memoryServer(before, "private-instance");
		const first = await daemon(before);
		await first.close();
		const other = await freePort();
		const second = await daemon(other);
		const foreign = await memoryServer(other, "someone-else");
		await second.close();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(running(already)).toBe(true);
		expect(running(foreign)).toBe(true);
	});
});

// The seam in daemon.ts (SW9, W26): the file's `memory` reaches the engine's environment through
// `GENTLE_DOT_ENGRAM`, so it behaves exactly like exporting the variable does today. No engine is
// spawned and no Engram binary is run: `isolatedAgentEnv` is what translates the switch.
describe("the daemon's memory setting seam", () => {
	const engineEnv = (memory: "shared" | "private", dataDir: string, base: NodeJS.ProcessEnv) =>
		isolatedAgentEnv(applyMemoryMode(base, memory), dataDir);

	it("applies config.json's private mode to the engine's environment", () => {
		const dataDir = tempDir();
		const base = { HOME: tempDir() };
		writeFileSync(join(dataDir, "config.json"), JSON.stringify({ memory: "private" }));
		const env = isolatedAgentEnv(applyMemoryMode(base, memoryMode(base, dataDir)), dataDir);
		expect(env.ENGRAM_PORT).toBe(PRIVATE_ENGRAM_PORT);
		expect(PRIVATE_ENGRAM_PORT).toBe("7438");
		expect(env.ENGRAM_DATA_DIR).toBe(join(dataDir, "home", ".engram"));
		expect(env.ENGRAM_URL).toBeUndefined();
	});

	it("leaves an absent or shared setting on the user's global Engram", () => {
		const dataDir = tempDir();
		const realHome = tempDir();
		const base = { HOME: realHome };
		// `shared` is the default, and applying it changes nothing.
		expect(applyMemoryMode(base, "shared")).toEqual(base);
		const env = engineEnv("shared", dataDir, base);
		expect(env.ENGRAM_DATA_DIR).toBe(join(realHome, ".engram"));
		expect(env.ENGRAM_PORT).toBeUndefined();
	});

	it("behaves exactly like GENTLE_DOT_ENGRAM=private does today", () => {
		const dataDir = tempDir();
		const base = { HOME: tempDir(), ENGRAM_PORT: "7437", ENGRAM_URL: "http://127.0.0.1:7437" };
		expect(engineEnv("private", dataDir, base)).toEqual(
			isolatedAgentEnv({ ...base, GENTLE_DOT_ENGRAM: "private" }, dataDir),
		);
	});
});
