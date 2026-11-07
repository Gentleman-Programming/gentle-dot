// A4: with GENTLE_DOT_ENGRAM=private, the memory server the engine starts outlives it. The daemon
// stops it when it closes, only when the daemon caused it (nothing listened on the private port
// at start) and it serves the private data folder. The memory server here is a stand-in on a
// free port; nothing is stopped by name, only the PIDs this test started.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryMode } from "../src/config.ts";
import { ConnectorStore } from "../src/connectors.ts";
import { applyMemoryMode, startDaemon } from "../src/daemon.ts";
import * as daemonAdmission from "../src/daemon-admission.ts";
import { claimDaemonDirs, DAEMON_CLAIM_FILE } from "../src/daemon-claim.ts";
import {
	isolatedAgentEnv,
	listenerLookupTimeoutMs,
	PRIVATE_ENGRAM_PORT,
	privateMemory,
} from "../src/isolation.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import * as windowsChannel from "../src/windows-app-channel.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

vi.mock("node:http", { spy: true });
vi.mock("../src/windows-app-channel.ts", { spy: true });

// Orchestration tests only: injected admission/transport facts are not native Windows proof.
describe("failed startup retains ownership until checked cleanup", () => {
	function fixture() {
		const dataDir = tempDir();
		const agentHome = tempDir();
		const config = join(dataDir, "config.json");
		const oldBytes = '{"memory":"invalid-private-mode"}\n';
		writeFileSync(config, oldBytes);
		const sentinel = join(agentHome, "existing-state");
		writeFileSync(sentinel, "old engine bytes\n");
		type ObservedLease = { records: Map<string, Buffer> };
		const history: ObservedLease[] = [];
		const active = new Set<ObservedLease>();
		const events: Array<{ kind: string; lease?: ObservedLease; error?: unknown }> = [];
		// Observe the real registry selected by the existing account-home fixture override.
		let registry: string | undefined;
		const physicalId = (directory: string) => {
			const { dev, ino } = statSync(directory, { bigint: true });
			return `${dev.toString(16)}-${ino.toString(16)}`;
		};
		const dataId = physicalId(dataDir);
		const homeId = physicalId(agentHome);
		const observed = (file: string) => {
			const matches = history.filter((lease) => lease.records.has(file));
			expect(matches).toHaveLength(1);
			return matches[0]!;
		};
		const lifecycle = (lease: ObservedLease) =>
			events.filter((event) => event.lease === lease).map((event) => event.kind);
		const expectRegistryReleased = () => {
			expect(registry).toBeDefined();
			const registryFile = join(registry!, DAEMON_CLAIM_FILE);
			const lease = observed(registryFile);
			expect(lifecycle(lease)).toEqual(["acquired", "release-start", "released"]);
			expect(active.has(lease)).toBe(false);
			expect(existsSync(registryFile)).toBe(false);
			expect(existsSync(join(agentHome, DAEMON_CLAIM_FILE))).toBe(false);
			return registryFile;
		};
		const expectOwnership = (retained: boolean, cleanupEvents: string[] = []) => {
			// The coordination lease must actually have completed release; absence alone is not proof.
			const registryFile = expectRegistryReleased();
			const retainedFiles = [
				join(dataDir, DAEMON_CLAIM_FILE),
				join(registry!, "physical", dataId, DAEMON_CLAIM_FILE),
				join(registry!, "physical", homeId, DAEMON_CLAIM_FILE),
			];
			expect(history.flatMap((lease) => [...lease.records.keys()]).sort()).toEqual(
				[registryFile, ...retainedFiles].sort(),
			);
			expect(active.size).toBe(retained ? retainedFiles.length : 0);
			for (const file of retainedFiles) {
				const lease = observed(file);
				const record = lease.records.get(file)!;
				expect(record.toString("utf8")).toMatch(
					new RegExp(`^gentle-dot-daemon ${process.pid} [0-9a-f]{32}\\n$`),
				);
				expect(active.has(lease)).toBe(retained);
				if (retained) {
					expect(lifecycle(lease)).toEqual(["acquired"]);
					expect(readFileSync(file)).toEqual(record);
				} else {
					expect(lifecycle(lease)).toEqual(["acquired", "release-start", "released"]);
					expect(existsSync(file)).toBe(false);
					const releaseStart = events.findIndex(
						(event) => event.kind === "release-start" && event.lease === lease,
					);
					for (const kind of cleanupEvents) {
						const cleanup = events.findIndex((event) => event.kind === kind);
						expect(cleanup).toBeGreaterThanOrEqual(0);
						expect(releaseStart).toBeGreaterThan(cleanup);
					}
				}
			}
		};
		const realAdmission = daemonAdmission.claimDaemonAdmission;
		const capture = vi.spyOn(daemonAdmission, "claimDaemonAdmission").mockImplementation((options) =>
			realAdmission({
				...options,
				claim: (targets) => {
					if (history.length === 0) {
						expect(targets).toHaveLength(1);
						expect(basename(targets[0]!.path)).toBe(".gentle-dot-daemon-claims");
						registry = targets[0]!.path;
					}
					const lease = claimDaemonDirs(targets);
					const observed: ObservedLease = {
						records: new Map(lease.files.map((file) => [file, readFileSync(file)])),
					};
					history.push(observed);
					active.add(observed);
					events.push({ kind: "acquired", lease: observed });
					return {
						files: lease.files,
						release() {
							events.push({ kind: "release-start", lease: observed });
							try {
								lease.release();
							} catch (error) {
								// A partial/failed real release is uncertain, never a successful release.
								events.push({ kind: "release-failed", lease: observed, error });
								throw error;
							}
							active.delete(observed);
							events.push({ kind: "released", lease: observed });
						},
					};
				},
			}),
		);
		return {
			dataDir,
			agentHome,
			config,
			oldBytes,
			sentinel,
			events,
			expectOwnership,
			restoreAdmission: () => capture.mockRestore(),
			options: {
				port: 0,
				host: "127.0.0.1",
				dataDir,
				agentHome,
				workspace: join(dataDir, "workspace"),
				uiDir: dataDir,
				agentCommand: process.execPath,
				agentArgs: [FAKE_AGENT],
				agentEnv: { HOME: tempDir() },
				profilesImportPath: join(dataDir, "no-import.json"),
			},
		};
	}

	it.each([false, true])(
		"invalid memory configuration waits for Windows drain; failure=%s",
		async (failDrain) => {
			const f = fixture();
			const lines: string[] = [];
			let finish!: () => void;
			let reject!: (error: Error) => void;
			let drainSettled = false;
			const drained = new Promise<{ mode: "drain"; drained: true }>((resolve, fail) => {
				finish = () => {
					if (drainSettled) return;
					drainSettled = true;
					f.events.push({ kind: "drain-succeeded" });
					resolve({ mode: "drain", drained: true });
				};
				reject = (error) => {
					if (drainSettled) return;
					drainSettled = true;
					f.events.push({ kind: "drain-failed" });
					fail(error);
				};
			});
			void drained.catch(() => {});
			const channel = Object.assign(new PassThrough(), { close: vi.fn(() => drained) });
			// Model the adopted transport only; real Linux admission must not invoke a Windows helper.
			const transport = vi.spyOn(windowsChannel, "isWindowsAppChannel").mockReturnValue(true);
			const spawn = vi.spyOn(AgentSupervisor.prototype, "start");
			try {
				let startupError: unknown;
				let startupSettled = false;
				const starting = startDaemon({
					...f.options,
					appChannel: channel,
					log: (line) => lines.push(line),
				})
					.catch((error: unknown) => {
						startupError = error;
						return error;
					})
					.finally(() => {
						startupSettled = true;
					});
				await vi.waitFor(() => {
					if (startupError !== undefined) throw startupError;
					expect(channel.close).toHaveBeenCalledOnce();
				});
				expect(channel.close).toHaveBeenCalledWith("drain");
				expect(startupError).toBeUndefined();
				expect(startupSettled, "startup must remain pending until transport drain settles").toBe(false);
				expect(drainSettled).toBe(false);
				f.expectOwnership(true);
				if (failDrain) reject(new Error("synthetic drain failure"));
				else finish();
				const error = await starting;
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe("Invalid memory in config.json: invalid-private-mode");
				expect(spawn).not.toHaveBeenCalled();
				expect(drainSettled).toBe(true);
				expect(channel.close).toHaveBeenCalledOnce();
				f.expectOwnership(failDrain, ["drain-succeeded"]);
				expect(readFileSync(f.config, "utf8")).toBe(f.oldBytes);
				expect(readFileSync(f.sentinel, "utf8")).toBe("old engine bytes\n");
				if (failDrain) expect(lines).toContain("startup cleanup failed; retaining directory claims");
			} finally {
				finish();
				channel.destroy();
				transport.mockRestore();
				spawn.mockRestore();
				f.restoreAdmission();
			}
		},
	);

	it.each([false, true])(
		"post-listen startup failure checks all resources; cleanup failure=%s",
		async (failCleanup) => {
			const f = fixture();
			writeFileSync(f.config, '{"memory":"shared"}\n');
			const startupError = new Error("synthetic post-listen startup failure");
			const servers = vi.spyOn(http, "createServer");
			const watch = vi.spyOn(ConnectorStore.prototype, "watch").mockImplementation(() => {
				f.expectOwnership(true);
				const server = servers.mock.results.at(-1)?.value as http.Server;
				expect(server.listening).toBe(true);
				server.once("close", () => f.events.push({ kind: "server-closed" }));
				throw startupError;
			});
			const stop = vi.spyOn(AgentSupervisor.prototype, "stop").mockImplementation(async () => {
				if (failCleanup) {
					f.events.push({ kind: "supervisor-cleanup-failed" });
					throw new Error("synthetic supervisor cleanup failure");
				}
				f.events.push({ kind: "supervisor-stopped" });
			});
			const spawn = vi.spyOn(AgentSupervisor.prototype, "start");
			try {
				await expect(startDaemon(f.options)).rejects.toBe(startupError);
				expect(watch).toHaveBeenCalledOnce();
				expect(stop).toHaveBeenCalledOnce();
				expect(spawn).not.toHaveBeenCalled();
				const server = servers.mock.results.at(-1)?.value as http.Server;
				expect(server).toBeDefined();
				expect(server.listening).toBe(false);
				expect(f.events.some((event) => event.kind === "server-closed")).toBe(true);
				f.expectOwnership(failCleanup, ["supervisor-stopped", "server-closed"]);
				expect(readFileSync(f.config, "utf8")).toBe('{"memory":"shared"}\n');
				expect(readFileSync(f.sentinel, "utf8")).toBe("old engine bytes\n");
			} finally {
				watch.mockRestore();
				stop.mockRestore();
				spawn.mockRestore();
				servers.mockRestore();
				f.restoreAdmission();
			}
		},
	);
});

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
	])("starts without claiming ownership when the startup lookup is uncertain: %j", async (output) => {
		const f = await fixture([output]);
		const log = vi.fn();
		expect(await privateMemory(f.base, f.dataDir, log, undefined, f.options)).toBeUndefined();
		expect(log).toHaveBeenCalledWith(
			`cannot verify private memory listener on port ${f.port} (${output.code === 0 && output.stdout.includes("\n") ? "ambiguous" : "failed"} lookup); will not stop it`,
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

	it("does not take a failed command for an empty port, and still starts", async () => {
		const f = await fixture([]);
		f.runListenerCommand.mockRejectedValueOnce(new Error("spawn failed"));
		const log = vi.fn();
		expect(await privateMemory(f.base, f.dataDir, log, undefined, f.options)).toBeUndefined();
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/cannot verify .* will not stop it/));
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

	it("asks lsof for no warnings, so a successful lookup is not read as failed", async () => {
		// lsof warns on stderr even when the lookup works (gvfs, Docker overlay mounts), and any
		// stderr is a failed lookup: `-w` keeps those warnings out, real failures keep their exit code.
		const f = await fixture([{ code: 1, stdout: "" }]);
		await privateMemory(f.base, f.dataDir, () => {}, undefined, { ...f.options, platform: "linux" });
		expect(f.runListenerCommand.mock.calls[0]?.[1]).toContain("-w");
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
