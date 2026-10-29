// A4: with GENTLE_DOT_ENGRAM=private, the memory server the engine starts outlives it. The daemon
// stops it when it closes, only when the daemon caused it (nothing listened on the private port
// at start) and it serves the private data folder. The memory server here is a stand-in on a
// free port; nothing is stopped by name, only the PIDs this test started.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { listenerLookupTimeoutMs, privateMemory } from "../src/isolation.ts";
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

describe("private memory listener lookup", () => {
	it("gives Windows' PowerShell lookup time to start on a busy machine, and lsof the usual bound", () => {
		expect(listenerLookupTimeoutMs("win32")).toBe(15_000);
		expect(listenerLookupTimeoutMs("linux")).toBe(5000);
		expect(listenerLookupTimeoutMs("darwin")).toBe(5000);
	});
});

describe.runIf(process.platform === "win32")("private memory listener lookup on Windows", () => {
	it("finds a real listener through PowerShell and reports a free port as empty", async () => {
		const server = createServer();
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const port = String((server.address() as AddressInfo).port);
		const env = { GENTLE_DOT_ENGRAM: "private", GENTLE_DOT_ENGRAM_PORT: port };
		try {
			// Someone already listens (this process): private memory claims nothing.
			expect(await privateMemory(env, tempDir(), () => {})).toBeUndefined();
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
		}
		// Nothing listens now: the daemon would own the server it causes to start.
		expect(await privateMemory(env, tempDir(), () => {})).toBeDefined();
	}, 60_000);
});

describe("private memory ownership safeguards", () => {
	async function fixture(
		outputs: Array<{ code: number; stdout: string; stderr?: string }>,
		instance = "owned",
	) {
		const dataDir = tempDir();
		mkdirSync(join(dataDir, "home", ".engram"), { recursive: true });
		writeFileSync(join(dataDir, "home", ".engram", ".instance-id"), "owned\n");
		const runListenerCommand = vi.fn(async (_command: string, _args: readonly string[]) => {
			const next = outputs.shift();
			if (!next) throw new Error("unexpected lookup");
			return { stderr: "", ...next };
		});
		const kill = vi.fn();
		const health = vi.fn(async () => ({ instance_id: instance }));
		const port = String(await freePort());
		const base = { GENTLE_DOT_ENGRAM: "private", GENTLE_DOT_ENGRAM_PORT: port };
		const options = { platform: "win32" as const, runListenerCommand, kill, health };
		return { dataDir, base, options, kill, runListenerCommand, port };
	}
	const empty = { code: 0, stdout: "" };
	const one = { code: 0, stdout: "12345\r\n12345\r\n" };

	it("terminates only a stable positive PID with matching health identity", async () => {
		const f = await fixture([empty, one, one]);
		const owned = await privateMemory(f.base, f.dataDir, () => {}, undefined, f.options);
		expect(owned).toBeDefined();
		await owned?.stop();
		expect(f.kill).toHaveBeenCalledExactlyOnceWith(12345, "SIGTERM");
		expect(f.runListenerCommand).toHaveBeenCalledTimes(3);
		expect(f.runListenerCommand.mock.calls[0]?.[0]).toBe("powershell.exe");
	});

	it.each([
		{ code: 2, stdout: "", stderr: "lookup failed" },
		{ code: 0, stdout: "0" },
		{ code: 0, stdout: "garbage" },
		{ code: 0, stdout: "12345\n12346" },
	])("refuses uncertain startup ownership: %j", async (output) => {
		const f = await fixture([output]);
		await expect(privateMemory(f.base, f.dataDir, () => {}, undefined, f.options)).rejects.toThrow(
			"private memory",
		);
		expect(f.kill).not.toHaveBeenCalled();
	});

	it("does not claim a pre-existing listener", async () => {
		const f = await fixture([one]);
		expect(await privateMemory(f.base, f.dataDir, () => {}, undefined, f.options)).toBeUndefined();
		expect(f.kill).not.toHaveBeenCalled();
	});

	it.each([
		{ code: 2, stdout: "", stderr: "lookup failed" },
		{ code: 0, stdout: "0" },
		{ code: 0, stdout: "12345\n12346" },
	])("leaves a listener alone when close lookup is uncertain: %j", async (output) => {
		const f = await fixture([empty, output]);
		await (await privateMemory(f.base, f.dataDir, () => {}, undefined, f.options))?.stop();
		expect(f.kill).not.toHaveBeenCalled();
	});

	it("does not terminate when the PID changes after the health check", async () => {
		const f = await fixture([empty, one, { code: 0, stdout: "12346" }]);
		await (await privateMemory(f.base, f.dataDir, () => {}, undefined, f.options))?.stop();
		expect(f.kill).not.toHaveBeenCalled();
	});

	it("does not terminate another memory instance", async () => {
		const f = await fixture([empty, one], "foreign");
		await (await privateMemory(f.base, f.dataDir, () => {}, undefined, f.options))?.stop();
		expect(f.kill).not.toHaveBeenCalled();
	});

	it("rejects a failed command instead of assuming an empty port", async () => {
		const f = await fixture([]);
		f.runListenerCommand.mockRejectedValueOnce(new Error("spawn failed"));
		await expect(privateMemory(f.base, f.dataDir, () => {}, undefined, f.options)).rejects.toThrow(
			"private memory",
		);
		expect(f.kill).not.toHaveBeenCalled();
	});

	it("preserves the Unix no-match exit code and verifies stable ownership before stopping", async () => {
		const f = await fixture([{ code: 1, stdout: "" }, one, one]);
		await (
			await privateMemory(f.base, f.dataDir, () => {}, undefined, { ...f.options, platform: "linux" })
		)?.stop();
		expect(f.kill).toHaveBeenCalledExactlyOnceWith(12345, "SIGTERM");
		expect(f.runListenerCommand.mock.calls[0]?.[0]).toBe("lsof");
	});

	it("does not terminate when health is unavailable or the stored instance id is empty", async () => {
		const f = await fixture([empty, one]);
		await (
			await privateMemory(f.base, f.dataDir, () => {}, undefined, {
				...f.options,
				health: async () => undefined,
			})
		)?.stop();
		expect(f.kill).not.toHaveBeenCalled();
		const other = await fixture([empty, one]);
		writeFileSync(join(other.dataDir, "home", ".engram", ".instance-id"), "\n");
		await (await privateMemory(other.base, other.dataDir, () => {}, undefined, other.options))?.stop();
		expect(other.kill).not.toHaveBeenCalled();
	});

	it.each(["0", "65536", "123;exit"])(
		"rejects invalid port %s before querying or terminating anything",
		async (port) => {
			const f = await fixture([]);
			await expect(
				privateMemory({ ...f.base, GENTLE_DOT_ENGRAM_PORT: port }, f.dataDir, () => {}, undefined, f.options),
			).rejects.toThrow("private memory");
			expect(f.runListenerCommand).not.toHaveBeenCalled();
			expect(f.kill).not.toHaveBeenCalled();
		},
	);
});
