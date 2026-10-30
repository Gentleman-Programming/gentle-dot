import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { bundledGentleShell } from "./config.ts";
import { directAccess, type EngineAccess } from "./engine-access.ts";
import { refusalGuard, resolveEngramBin, runtimeDir } from "./runtime.ts";

/**
 * The folder with the `pi` executable bundled with the daemon. The engine's
 * first-run setup needs `pi` on PATH, and a clean machine has none. An installed
 * app carries a relocatable `pi` in `<runtime>/bin`; pnpm's shim is not relocatable.
 */
interface IsolationOptions {
	platform?: NodeJS.Platform;
	/** Source shim directories, injectable for platform-independent tests. */
	sourceBinDirs?: string[];
}

function bundledBinDir(base: NodeJS.ProcessEnv, options: IsolationOptions): string | undefined {
	const runtime = runtimeDir(base);
	if (runtime) return join(runtime, "bin");
	const require = createRequire(import.meta.url);
	const bins =
		options.sourceBinDirs ??
		(require.resolve.paths("@earendil-works/pi-coding-agent") ?? []).map((dir) => join(dir, ".bin"));
	const names = (options.platform ?? process.platform) === "win32" ? ["pi", "pi.cmd", "pi.exe"] : ["pi"];
	for (const bin of bins) {
		if (names.some((name) => existsSync(join(bin, name)))) return bin;
	}
	return undefined;
}

/** Creates `path` with mode 0700, and tightens it to 0700 when it already exists. */
export function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

/** The file gentle-shell writes into a home it created (gentle-pi `bin/gentle-shell.mjs`). */
export const ENGINE_HOME_MARKER = ".gentle-shell-home";

/** The bundled gentle-pi's version, which gentle-shell names in its marker; informational only. */
function engineVersion(): string | undefined {
	try {
		const manifest = join(dirname(bundledGentleShell()), "..", "package.json");
		return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

/**
 * Marks the assistant's own engine home as gentle-shell's (S35.3, #13). gentle-shell runs its
 * first-run setup (the companion packages) only in a home it created: one that did not exist, or
 * that holds its marker. The daemon writes `auth.json` and `mcp.json` there before the engine's
 * first start, so without the marker the engine took the home for someone else's and never set
 * it up. The marker has gentle-shell's own format (`{"createdBy":"gentle-shell","version":…}`; it
 * checks only that the file exists). One already there is left as it is. Call it only for the
 * default `<data>/agent`: a home the user chose may be theirs, and is never marked.
 */
export function claimEngineHome(
	agentHome: string,
	log: (line: string) => void = () => {},
	access: EngineAccess = directAccess,
): void {
	const content = `${JSON.stringify({ createdBy: "gentle-shell", version: engineVersion() })}\n`;
	try {
		access(() => {
			ensurePrivateDir(agentHome);
			writeFileSync(join(agentHome, ENGINE_HOME_MARKER), content, { flag: "wx", mode: 0o600 });
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST")
			log(`could not mark the engine's home as its own: ${(error as Error).message}`);
	}
}

/** Variables that could point the engine back at the user's own setup. */
const INHERITED_HOMES = ["PI_CODING_AGENT_DIR", "GENTLE_PI_AGENT_HOME", "GENTLE_SHELL_CONFIG"];

/**
 * What a subagent run sets for its child engines (gentle-pi `lib/agents-runner.ts`), and the command
 * line those children would run instead of the engine. The assistant's engine is never a child, and
 * its children run the same engine as it does.
 */
const SUBAGENT_VARIABLES = [
	"GENTLE_PI_AGENTS_CHILD",
	"GENTLE_PI_AGENTS_OWNED_IPC",
	"GENTLE_PI_AGENTS_PARENT_PERMISSION_FD",
	"GENTLE_PI_AGENTS_PI",
];

/** What only the daemon may hold: the server's connector secrets key (S25.8). */
const DAEMON_ONLY = ["GENTLE_DOT_SECRETS_KEY"];

/** Subagents are on unless `GENTLE_DOT_SUBAGENTS` is `off`, `0`, or `false`. */
export function subagentsEnabled(base: NodeJS.ProcessEnv): boolean {
	const value = base.GENTLE_DOT_SUBAGENTS?.trim().toLowerCase();
	return !(value === "off" || value === "0" || value === "false");
}

/** The memory project every memory the assistant saves or searches belongs to. */
export const MEMORY_PROJECT = "gentle-dot";

/** The memory server port of the private memory (`GENTLE_DOT_ENGRAM=private`). */
export const PRIVATE_ENGRAM_PORT = "7438";

/**
 * Names the memory project of `workspace` through Engram's per-folder setting
 * (`.engram/config.json`), which Engram reads before any other detection.
 */
export function ensureMemoryProject(workspace: string, access: EngineAccess = directAccess): void {
	const file = join(workspace, ".engram", "config.json");
	access(() => {
		ensurePrivateDir(join(workspace, ".engram"));
		// Written next to it and renamed over it: a link planted at its place is replaced, never followed.
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ project_name: MEMORY_PROJECT })}\n`);
		renameSync(temp, file);
	});
}

/**
 * The engine's environment: its own HOME (`<dataDir>/home`, mode 0700) with
 * the XDG folders under it (on Windows `USERPROFILE`, `APPDATA` and `LOCALAPPDATA`), because
 * parts of the engine write to fixed places under the home folder. PATH is kept (on Windows as one `PATH` key, whatever its spelling), with the bundled `pi` folder first, and so is the user's git identity,
 * through `GIT_CONFIG_GLOBAL` pointing at their real `~/.gitconfig`.
 *
 * Memory is the user's global Engram: Engram ties a server to its data folder
 * (by default under HOME), so `ENGRAM_DATA_DIR` points at the user's real one
 * (`GENTLE_DOT_ENGRAM_DATA_DIR` overrides it) and the memory plugin accepts the
 * user's server. The user's own `ENGRAM_PORT` and `ENGRAM_URL` are kept.
 * `GENTLE_DOT_ENGRAM=private` instead runs a memory of its own under
 * the engine's home, on port 7438 (`GENTLE_DOT_ENGRAM_PORT` overrides it), with the store named
 * (`ENGRAM_DATA_DIR=<dataDir>/home/.engram`) rather than left to Engram's default.
 * The server's connector secrets key (`GENTLE_DOT_SECRETS_KEY`, S25.8) is never passed on.
 * Subagents are on (`GENTLE_PI_AGENTS=1`) unless `GENTLE_DOT_SUBAGENTS=off`: their child engines
 * reach connectors only through the daemon's proxy, like the engine itself (S25.4).
 *
 * Without a `TMPDIR` (the installed app's launch on Linux), the engine gets a
 * private one under its home: it caches compiled extensions in the temporary
 * folder, and a shared `/tmp` would let another local user plant that cache.
 *
 * An installed app (`GENTLE_DOT_RUNTIME`) also names the Engram binary
 * (`ENGRAM_BIN`, see `resolveEngramBin`), since its PATH has no user folders.
 */
export function isolatedAgentEnv(
	base: NodeJS.ProcessEnv,
	dataDir: string,
	access: EngineAccess = directAccess,
	log?: (line: string) => void,
	options: IsolationOptions = {},
): NodeJS.ProcessEnv {
	const platform = options.platform ?? process.platform;
	const home = join(dataDir, "home");
	access(() => ensurePrivateDir(home));
	const realHome = base.HOME || (platform === "win32" && base.USERPROFILE) || homedir();
	const env: NodeJS.ProcessEnv = {
		...base,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_STATE_HOME: join(home, ".local", "state"),
	};
	for (const key of [...INHERITED_HOMES, ...SUBAGENT_VARIABLES, ...DAEMON_ONLY]) delete env[key];
	if (platform === "win32") {
		const tmp = join(home, ".cache", "tmp");
		env.USERPROFILE = home;
		env.TEMP = env.TMP = env.TMPDIR = tmp;
		// Windows' counterparts of the XDG folders, so the engine's tools keep no state in the user's.
		env.APPDATA = join(home, "AppData", "Roaming");
		env.LOCALAPPDATA = join(home, "AppData", "Local");
		access(() => {
			ensurePrivateDir(tmp);
			ensurePrivateDir(env.APPDATA as string);
			ensurePrivateDir(env.LOCALAPPDATA as string);
		});
	} else if (!base.TMPDIR) {
		const tmp = join(home, ".cache", "tmp");
		env.TMPDIR = tmp;
		access(() => ensurePrivateDir(tmp));
	}
	const bin = bundledBinDir(base, options);
	if (bin) {
		// Windows hands a process `Path` while the engine resolves the uppercase name, so setting
		// `PATH` beside an inherited `Path` kept both and the engine's own lookup found the bundled
		// folder alone — the whole daemon `PATH`, git and the system folders included, was gone (W34,
		// measured on an installed copy: engine `PATH` = `…\runtime\bin`). One name, then, whichever
		// case the daemon was handed.
		const inherited = Object.keys(base).find((key) => key.toLowerCase() === "path");
		for (const key of Object.keys(env)) {
			if (key.toLowerCase() === "path") delete env[key];
		}
		// Windows paths ignore case and a trailing separator, so the bundled folder is not kept twice.
		const same = (part: string) =>
			platform === "win32"
				? part.replace(/[\\/]+$/, "").toLowerCase() === bin.replace(/[\\/]+$/, "").toLowerCase()
				: part === bin;
		const rest = (inherited ? (base[inherited] ?? "") : "")
			.split(delimiter)
			.filter((part) => part && !same(part));
		env.PATH = [bin, ...rest].join(delimiter);
	}
	// The user's own Gentle Shell setting is not the assistant's.
	env.GENTLE_PI_AGENTS = subagentsEnabled(base) ? "1" : "0";
	if (base.GENTLE_DOT_ENGRAM === "private") {
		env.ENGRAM_PORT = base.GENTLE_DOT_ENGRAM_PORT || PRIVATE_ENGRAM_PORT;
		delete env.ENGRAM_URL;
		// The store is **named**, not left to Engram's default: that default follows `HOME`, which is a
		// POSIX convention, and on Windows Engram resolves the user profile instead — measured, the
		// "private" server opened the user's own store there (W25). It is also the path `privateMemory`
		// already reads when it decides whether the server on the private port is ours to stop.
		env.ENGRAM_DATA_DIR = join(home, ".engram");
	} else {
		env.ENGRAM_DATA_DIR =
			base.GENTLE_DOT_ENGRAM_DATA_DIR || base.ENGRAM_DATA_DIR || join(realHome, ".engram");
	}
	const runtime = runtimeDir(base);
	if (runtime) {
		// An `ENGRAM_BIN` that exists and cannot be started on this platform — the POSIX guard on
		// Windows — used to reach the engine as a broken spawn. The runtime's own guard takes its
		// place, so the refusal is reported as a refusal and no store is touched either way.
		const guard = refusalGuard(base, runtime);
		if (guard) {
			log?.(
				"the ENGRAM_BIN in the environment exists but cannot be started here; the engine gets the runtime's Engram guard, so memory reports itself disabled",
			);
			env.ENGRAM_BIN = guard;
		} else {
			env.ENGRAM_BIN = resolveEngramBin(base, runtime, { home: realHome, platform });
		}
	}
	const gitConfig = join(realHome, ".gitconfig");
	if (!base.GIT_CONFIG_GLOBAL && existsSync(gitConfig)) env.GIT_CONFIG_GLOBAL = gitConfig;
	return env;
}

type Listener = { kind: "empty" | "failed" | "ambiguous" } | { kind: "one"; pid: number };

interface PrivateMemoryOptions {
	platform?: NodeJS.Platform;
	/** Bounded command execution seam; errors must not be reported as empty output. */
	runListenerCommand?: (
		command: string,
		args: readonly string[],
	) => Promise<{ code: number; stdout: string; stderr: string }>;
	kill?: (pid: number, signal: "SIGTERM") => void;
	health?: (port: string) => Promise<{ instance_id?: unknown } | undefined>;
}

/**
 * Owns cleanup only after confirming an empty private port before startup.
 * A failed or ambiguous lookup refuses ownership, not startup: the daemon starts,
 * logs it, and leaves that memory server running when it closes. An invalid port
 * is a configuration error and does stop startup. Before termination, both the
 * private data identity and a repeated stable listener PID must match.
 * PID reuse after the final check remains possible; nothing is killed by name.
 */
export async function privateMemory(
	base: NodeJS.ProcessEnv,
	dataDir: string,
	log: (line: string) => void,
	access: EngineAccess = directAccess,
	options: PrivateMemoryOptions = {},
): Promise<{ stop(): Promise<void> } | undefined> {
	if (base.GENTLE_DOT_ENGRAM !== "private") return undefined;
	const port = base.GENTLE_DOT_ENGRAM_PORT || PRIVATE_ENGRAM_PORT;
	if (
		!/^\d+$/.test(port) ||
		!Number.isSafeInteger(Number(port)) ||
		Number(port) < 1 ||
		Number(port) > 65535
	) {
		throw new Error("Cannot start private memory: port must be an integer from 1 to 65535");
	}
	const before = await listeningPid(port, options);
	if (before.kind === "one") return undefined;
	if (before.kind !== "empty") {
		// Not knowing is no reason to keep the assistant from starting, nor to claim the server.
		log(`cannot verify private memory listener on port ${port} (${before.kind} lookup); will not stop it`);
		return undefined;
	}
	return {
		async stop() {
			const listener = await listeningPid(port, options);
			if (listener.kind !== "one") {
				if (listener.kind !== "empty")
					log(`cannot verify private memory listener on port ${port}; left running`);
				return;
			}
			let expected: string;
			try {
				const file = join(dataDir, "home", ".engram", ".instance-id");
				expected = access(() => readFileSync(file, "utf8")).trim();
			} catch {
				return;
			}
			const health = await (options.health ?? memoryHealth)(port).catch(() => undefined);
			if (!expected || health?.instance_id !== expected) {
				log(`the memory server on port ${port} serves other data; left running`);
				return;
			}
			const again = await listeningPid(port, options);
			if (again.kind !== "one" || again.pid !== listener.pid) {
				log(`the private memory listener changed on port ${port}; left running`);
				return;
			}
			try {
				(options.kill ?? process.kill)(listener.pid, "SIGTERM");
				log(`stopped the private memory server (pid ${listener.pid})`);
			} catch (error) {
				log(`could not stop private memory server (pid ${listener.pid}): ${String(error)}`);
			}
		},
	};
}

function memoryHealth(port: string): Promise<{ instance_id?: unknown } | undefined> {
	return fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
		.then((response) => response.json() as Promise<{ instance_id?: unknown }>)
		.catch(() => undefined);
}

/**
 * How long the listener lookup may take. Windows starts PowerShell and queries CIM, which can take
 * several seconds on a busy machine (startup, many processes); a lookup that runs out is a failed
 * lookup, and private memory then refuses to start.
 */
export function listenerLookupTimeoutMs(platform: NodeJS.Platform): number {
	return platform === "win32" ? 15_000 : 5000;
}

function runListenerCommand(
	command: string,
	args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			command,
			[...args],
			{
				encoding: "utf8",
				timeout: listenerLookupTimeoutMs(command === "powershell.exe" ? "win32" : process.platform),
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				resolve({
					code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
					stdout: String(stdout),
					stderr: String(stderr),
				});
			},
		);
	});
}

/** Enumerate Windows listeners before filtering, so an unused port is not a query error. */
async function listeningPid(port: string, options: PrivateMemoryOptions): Promise<Listener> {
	const windows = (options.platform ?? process.platform) === "win32";
	const command = windows ? "powershell.exe" : "lsof";
	const args = windows
		? [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try { Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq ${Number(port)} } | Select-Object -ExpandProperty OwningProcess } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
			]
		: ["-w", "-t", "-n", "-P", `-iTCP:${port}`, "-sTCP:LISTEN"];
	try {
		const result = await (options.runListenerCommand ?? runListenerCommand)(command, args);
		const text = result.stdout.trim();
		// lsof exits 1 for no matches. Missing commands, diagnostics and timeouts are failures.
		if (!windows && result.code === 1 && !text && !result.stderr.trim()) return { kind: "empty" };
		if (result.code !== 0 || result.stderr.trim()) return { kind: "failed" };
		if (!text) return { kind: "empty" };
		const values = text.split(/\r?\n/).map((value) => value.trim());
		if (values.some((value) => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))))
			return { kind: "failed" };
		const pids = [...new Set(values.map(Number))];
		return pids.length === 1 ? { kind: "one", pid: pids[0] as number } : { kind: "ambiguous" };
	} catch {
		return { kind: "failed" };
	}
}
