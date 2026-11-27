// A4: with GENTLE_DOT_ENGRAM=private, the memory server the engine starts outlives it. The daemon
// stops it when it closes, only when the daemon caused it (nothing listened on the private port
// at start) and it serves the private data folder. The memory server here is a stand-in on a
// free port; nothing is stopped by name, only the PIDs this test started.
import * as childProcess from "node:child_process";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { join, win32 } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as computerComponents from "../src/computer-components.ts";
import * as computerProviders from "../src/computer-providers.ts";
import * as daemonClaims from "../src/daemon-claim.ts";
import * as isolation from "../src/isolation.ts";
import * as privateFiles from "../src/private-file.ts";
import * as supervisors from "../src/supervisor.ts";
import { memoryMode } from "../src/config.ts";
import { applyMemoryMode, type DaemonOptions, startDaemon } from "../src/daemon.ts";
import {
	isolatedAgentEnv,
	listenerLookupTimeoutMs,
	PRIVATE_ENGRAM_PORT,
	privateMemory,
} from "../src/isolation.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

// Keep existing real fixtures unchanged; individual admission tests replace these spies only
// after preparing their synthetic state, and restore them before other test groups run.
vi.mock("node:child_process", { spy: true });
vi.mock("node:fs", { spy: true });

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

describe("preview memory startup admission", () => {
	type Lookup = { code: number; stdout: string; stderr?: string } | "throw";
	const one = { code: 0, stdout: "12345\n12345\n" };
	const empty = { code: 0, stdout: "" };
	const refusal = "Cannot start preview memory: listener ownership is unverified";
	const downstream = new Error("test boundary: downstream startup reached");
	const stop = () => {
		throw downstream;
	};
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const builtinRestores: Array<() => void> = [];

	afterEach(() => {
		Object.defineProperty(process, "platform", platform);
		for (const restore of builtinRestores.splice(0)) restore();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	// Only our freshly created tree is read. Include directory membership, bytes and modes,
	// so token/home/workspace/claim changes cannot hide behind a later admission error.
	function snapshot(root: string): unknown[] {
		const entries = fs.readdirSync(root).sort().map((name) => {
			const path = join(root, name);
			const stat = fs.lstatSync(path);
			return [name, stat.mode, stat.isDirectory() ? snapshot(path) : fs.readFileSync(path, "utf8")];
		});
		return [fs.lstatSync(root).mode, ...entries];
	}

	function fixture(
		outputs: Lookup[] = [one, one],
		instance: unknown = "owned",
		stored: string | null = "owned\n",
	) {
		const dataDir = tempDir();
		for (const dir of ["home/.engram", "agent", "workspace/.engram"])
			mkdirSync(join(dataDir, dir), { recursive: true });
		if (stored !== null) writeFileSync(join(dataDir, "home/.engram/.instance-id"), stored);
		writeFileSync(join(dataDir, "token"), "synthetic-token-preserve-01234567890123456789\n");
		writeFileSync(join(dataDir, "config.json"), '{"memory":"private"}\n');
		writeFileSync(join(dataDir, "agent/.gentle-shell-home"), "synthetic home marker\n");
		writeFileSync(join(dataDir, "workspace/.engram/config.json"), '{"project_name":"sentinel"}\n');
		const before = snapshot(dataDir);
		const options: DaemonOptions = {
			port: 0,
			host: "127.0.0.1",
			dataDir,
			workspace: join(dataDir, "workspace"),
			uiDir: dataDir,
			agentCommand: "synthetic-never-executed",
			agentHome: join(dataDir, "agent"),
			agentEnv: {
				HOME: dataDir,
				USERPROFILE: dataDir,
				GENTLE_DOT_ENGRAM: "private",
				GENTLE_DOT_ENGRAM_PORT: "17438",
				GENTLE_DOT_PREVIEW_MEMORY_ADMISSION: "1",
			},
		};
		// Install barriers BEFORE calling public startDaemon. The unchanged permissive path
		// hits a private-dir/claim barrier, not a real mutation/provider/engine. No real PID is probed.
		const effects = {
			privateDir: vi.spyOn(isolation, "ensurePrivateDir").mockImplementation(stop),
			claims: vi.spyOn(daemonClaims, "claimDaemonDirs").mockImplementation(stop),
			releaseClaims: vi.spyOn(daemonClaims, "releaseDaemonClaims").mockImplementation(stop),
			discovery: vi.spyOn(computerComponents, "discoverComputerComponents").mockImplementation(stop),
			providers: vi.spyOn(computerProviders, "resolveComputerProviders").mockImplementation(stop),
			tokenWrite: vi.spyOn(privateFiles, "writePrivateFile").mockImplementation(stop),
			engineHome: vi.spyOn(isolation, "claimEngineHome").mockImplementation(stop),
			workspace: vi.spyOn(fs, "mkdirSync").mockImplementation(stop),
			project: vi.spyOn(isolation, "ensureMemoryProject").mockImplementation(stop),
			isolation: vi.spyOn(isolation, "isolatedAgentEnv").mockImplementation(stop),
			supervisorStart: vi.spyOn(supervisors.AgentSupervisor.prototype, "start").mockImplementation(stop),
			supervisor: vi.spyOn(supervisors, "AgentSupervisor").mockImplementation(function () {
				throw downstream;
			}),
		};
		const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(stop);
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		const health = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
			if (instance instanceof Error) throw instance;
			return new Response(JSON.stringify({ instance_id: instance }));
		});
		vi.stubGlobal("fetch", health);
		const lookup = vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
			const next = outputs.shift();
			if (!next || next === "throw") throw new Error("synthetic lookup unavailable");
			const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
			callback(
				next.code ? Object.assign(new Error("synthetic lookup failed"), { code: next.code }) : null,
				next.stdout,
				next.stderr ?? "",
			);
			return {} as ChildProcess;
		});
		// Restore built-in automocks explicitly too, so later fixtures retain real defaults.
		for (const effect of [effects.workspace, spawn, lookup]) builtinRestores.push(() => effect.mockRestore());
		// Built-in automock spies may already contain fixture calls; measure startup only.
		for (const effect of [...Object.values(effects), spawn, kill, lookup]) effect.mockClear();
		const startupBarrier = process.platform === "win32" ? effects.privateDir : effects.claims;
		return { options, dataDir, before, effects, spawn, kill, health, lookup, startupBarrier };
	}

	async function rejectsBeforeEffects(f: ReturnType<typeof fixture>, message = refusal) {
		const result = await startDaemon(f.options).catch((error: unknown) => error);
		// Soft assertions retain ALL observable evidence even on the intended old-path RED.
		for (const [name, effect] of Object.entries(f.effects)) expect.soft(effect, name).not.toHaveBeenCalled();
		expect.soft(f.spawn).not.toHaveBeenCalled();
		expect.soft(f.kill).not.toHaveBeenCalled();
		for (const [url, init] of f.health.mock.calls) {
			expect.soft(url).toBe("http://127.0.0.1:17438/health");
			expect.soft(init?.signal).toBeInstanceOf(AbortSignal);
		}
		expect.soft(snapshot(f.dataDir)).toEqual(f.before);
		expect(result).toEqual(new Error(message));
	}

	it.each([
		{ name: "foreign instance", outputs: [one], instance: "foreign" },
		{ name: "missing health identity", outputs: [one], instance: undefined },
		{ name: "non-string health identity", outputs: [one], instance: 12345 },
		{ name: "unavailable health", outputs: [one], instance: new Error("synthetic health unavailable") },
		{ name: "changed PID after health", outputs: [one, { code: 0, stdout: "12346" }], instance: "owned" },
		{ name: "listener disappeared after health", outputs: [one, empty], instance: "owned" },
		{ name: "failed recheck after health", outputs: [one, { code: 2, stdout: "" }], instance: "owned" },
		{ name: "ambiguous listeners", outputs: [{ code: 0, stdout: "12345\n12346" }], instance: "owned" },
		{ name: "non-positive PID", outputs: [{ code: 0, stdout: "0" }], instance: "owned" },
		{ name: "unsafe PID", outputs: [{ code: 0, stdout: "9007199254740992" }], instance: "owned" },
		{ name: "malformed PID", outputs: [{ code: 0, stdout: "not-a-pid" }], instance: "owned" },
		{ name: "failed lookup", outputs: [{ code: 2, stdout: "" }], instance: "owned" },
		{ name: "lookup diagnostic", outputs: [{ code: 0, stdout: "", stderr: "synthetic warning" }], instance: "owned" },
		{ name: "unavailable lookup", outputs: ["throw" as const], instance: "owned" },
	])("refuses $name before downstream startup", async ({ outputs, instance }) => {
		const f = fixture(outputs, instance);
		// Passing undefined explicitly must mean missing identity, not fixture's default.
		if (instance === undefined) f.health.mockResolvedValue(new Response("{}"));
		await rejectsBeforeEffects(f);
	});

	it("honors the inherited preview marker when the CLI supplies no agentEnv", async () => {
		const f = fixture([one], "foreign");
		for (const [key, value] of Object.entries(f.options.agentEnv!)) vi.stubEnv(key, value);
		delete f.options.agentEnv;
		await rejectsBeforeEffects(f);
	});

	it.each([null, "\n"])("refuses unavailable stored identity (%j) without changing state", async (stored) => {
		await rejectsBeforeEffects(fixture([one], "owned", stored));
	});

	it.each(["shared", "missing engine home"])("requires preview prerequisites: %s", async (missing) => {
		const f = fixture();
		if (missing === "shared") f.options.agentEnv!.GENTLE_DOT_ENGRAM = "shared";
		else delete f.options.agentHome;
		await rejectsBeforeEffects(f, "Cannot start preview memory: private mode and engine home are required");
		expect(f.lookup).not.toHaveBeenCalled();
		expect(f.health).not.toHaveBeenCalled();
	});

	it.each(["0", "65536", "123;exit"])("rejects invalid preview port %s before any effect", async (port) => {
		const f = fixture();
		f.options.agentEnv!.GENTLE_DOT_ENGRAM_PORT = port;
		await rejectsBeforeEffects(f, "Cannot start private memory: port must be an integer from 1 to 65535");
		expect(f.lookup).not.toHaveBeenCalled();
		expect(f.health).not.toHaveBeenCalled();
	});

	it("finds the Windows listener observer when the daemon PATH omits PowerShell", async () => {
		const f = fixture([empty]);
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		vi.stubEnv("SystemRoot", "D:\\Windows");
		const powershell = "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
		f.lookup.mockImplementation((...args: unknown[]) => {
			const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
			callback(
				args[0] === powershell
					? null
					: Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" }),
				"",
				"",
			);
			return {} as ChildProcess;
		});

		const result = await startDaemon(f.options).catch((error: unknown) => error);
		expect.soft(result).toBe(downstream);
		expect.soft(f.lookup).toHaveBeenCalledOnce();
		expect.soft(f.lookup.mock.calls[0]?.[0]).toBe(powershell);
		expect(f.lookup.mock.calls[0]?.[1]).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try { Get-CimInstance -Namespace root/StandardCimv2 -Query 'SELECT OwningProcess FROM MSFT_NetTCPConnection WHERE LocalPort = 17438 AND State = 2' -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
		]);
		expect(f.lookup.mock.calls[0]?.[2]).toEqual({ encoding: "utf8", timeout: 15_000, windowsHide: true });
		expect.soft(f.effects.privateDir).toHaveBeenCalledOnce();
		for (const [name, effect] of Object.entries(f.effects))
			if (effect !== f.effects.privateDir) expect.soft(effect, name).not.toHaveBeenCalled();
		expect(f.health).not.toHaveBeenCalled();
		expect(f.kill).not.toHaveBeenCalled();
		expect(f.spawn).not.toHaveBeenCalled();
		expect(snapshot(f.dataDir)).toEqual(f.before);
	});

	it.each(["empty", "owned", "saved private mode"])("admits %s only as far as the safe startup barrier", async (kind) => {
		const f = fixture(kind === "empty" ? [empty] : [one, one]);
		if (kind === "saved private mode") delete f.options.agentEnv!.GENTLE_DOT_ENGRAM;
		await expect(startDaemon(f.options)).rejects.toBe(downstream);
		expect(f.startupBarrier).toHaveBeenCalledOnce();
		expect(f.lookup).toHaveBeenCalledTimes(kind === "empty" ? 1 : 2);
		expect(f.health).toHaveBeenCalledTimes(kind === "empty" ? 0 : 1);
		expect(f.kill).not.toHaveBeenCalled();
		expect(f.spawn).not.toHaveBeenCalled();
		expect(snapshot(f.dataDir)).toEqual(f.before);
	});

	it.each(["owned", "empty"])("carries %s admission through bootstrap without claiming another listener", async (kind) => {
		// The extra empty reply would grant cleanup if owned admission fell back to a
		// second permissive bootstrap. Only the caused-start case may receive a handle.
		const f = fixture(kind === "owned" ? [one, one, empty] : [empty, one, one]);
		const bootstrap = vi.spyOn(isolation, "admitPreviewMemory");
		f.effects.claims.mockReturnValue({ status: "claimed", files: [] });
		f.effects.releaseClaims.mockImplementation(() => {});
		f.effects.privateDir.mockImplementation(() => {});
		f.options.computerComponents = {};
		f.effects.providers.mockResolvedValue({ status: "unavailable", kind: "none" });
		vi.spyOn(privateFiles, "readPrivateFileSync").mockReturnValue("synthetic-token-preserve-01234567890123456789");
		const chmod = vi.spyOn(fs, "chmodSync").mockImplementation(() => {});
		builtinRestores.push(() => chmod.mockRestore());
		f.effects.engineHome.mockImplementation(() => {});
		f.effects.workspace.mockImplementation(() => undefined);
		f.effects.project.mockImplementation(() => {});
		// Retain the isolation barrier: this is past memory bootstrap, but before
		// connector construction, supervisor construction or any engine/network use.
		await expect(startDaemon(f.options)).rejects.toBe(downstream);
		expect(f.effects.isolation).toHaveBeenCalledOnce();
		expect(bootstrap).toHaveBeenCalledOnce();
		expect(bootstrap.mock.invocationCallOrder[0]).toBeLessThan(f.effects.claims.mock.invocationCallOrder[0]!);
		const { memory: cleanup } = await bootstrap.mock.results[0]!.value;
		if (kind === "owned") {
			expect(cleanup).toBeUndefined();
			expect(f.kill).not.toHaveBeenCalled();
		} else {
			expect(cleanup).toBeDefined();
			await cleanup!.stop();
			expect(f.kill).toHaveBeenCalledExactlyOnceWith(12345, "SIGTERM");
		}
		expect(f.lookup).toHaveBeenCalledTimes(kind === "owned" ? 2 : 3);
		expect(f.health).toHaveBeenCalledOnce();
		for (const effect of [f.effects.discovery, f.effects.tokenWrite, f.effects.supervisor, f.effects.supervisorStart, f.spawn])
			expect(effect).not.toHaveBeenCalled();
		expect(snapshot(f.dataDir)).toEqual(f.before);
	});

	it.each([undefined, "0"])("preserves private-mode production ordering without marker %j", async (marker) => {
		const f = fixture(["throw"]);
		if (marker === undefined) delete f.options.agentEnv!.GENTLE_DOT_PREVIEW_MEMORY_ADMISSION;
		else f.options.agentEnv!.GENTLE_DOT_PREVIEW_MEMORY_ADMISSION = marker;
		await expect(startDaemon(f.options)).rejects.toBe(downstream);
		expect(f.startupBarrier).toHaveBeenCalledOnce();
		expect(f.lookup).not.toHaveBeenCalled();
		expect(f.health).not.toHaveBeenCalled();
		expect(f.kill).not.toHaveBeenCalled();
		expect(snapshot(f.dataDir)).toEqual(f.before);
	});

	it("validates the Windows channel before preview lookup or any startup effect", async () => {
		const f = fixture(["throw"]);
		const channel = new PassThrough();
		f.options.appChannel = channel;
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		try {
			await rejectsBeforeEffects(f, "Windows app channel requires validated production ownership before startup");
			expect(f.lookup).not.toHaveBeenCalled();
			expect(f.health).not.toHaveBeenCalled();
		} finally {
			channel.destroy();
		}
	});
});

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
		// Windows resolves the base profile before HOME; keep both synthetic homes consistent.
		const base = { HOME: realHome, USERPROFILE: realHome };
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
		expect(f.runListenerCommand.mock.calls[0]?.[0]).toBe(
			win32.join(
				process.env.SystemRoot || "C:\\Windows",
				"System32",
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe",
			),
		);
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
