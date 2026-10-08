// A4: with GENTLE_DOT_ENGRAM=private, the memory server the engine starts outlives it. The daemon
// stops it when it closes, only when the daemon caused it (nothing listened on the private port
// at start) and it serves the private data folder. The memory server here is a stand-in on a
// free port; nothing is stopped by name, only the PIDs this test started.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
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
