import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveEngramBin, runtimeDir } from "./runtime.ts";

/**
 * The folder with the `pi` executable bundled with the daemon. The engine's
 * first-run setup needs `pi` on PATH, and a clean machine has none. An installed
 * app carries a relocatable `pi` in `<runtime>/bin`; pnpm's shim is not relocatable.
 */
function bundledBinDir(base: NodeJS.ProcessEnv): string | undefined {
	const runtime = runtimeDir(base);
	if (runtime) return join(runtime, "bin");
	const require = createRequire(import.meta.url);
	for (const dir of require.resolve.paths("@earendil-works/pi-coding-agent") ?? []) {
		const bin = join(dir, ".bin");
		if (existsSync(join(bin, "pi"))) return bin;
	}
	return undefined;
}

/** Creates `path` with mode 0700, and tightens it to 0700 when it already exists. */
export function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

/** Variables that could point the engine back at the user's own setup. */
const INHERITED_HOMES = ["PI_CODING_AGENT_DIR", "GENTLE_PI_AGENT_HOME", "GENTLE_SHELL_CONFIG"];

/** The memory project every memory the assistant saves or searches belongs to. */
export const MEMORY_PROJECT = "gentle-dot";

/** The memory server port of the private memory (`GENTLE_DOT_ENGRAM=private`). */
export const PRIVATE_ENGRAM_PORT = "7438";

/**
 * Names the memory project of `workspace` through Engram's per-folder setting
 * (`.engram/config.json`), which Engram reads before any other detection.
 */
export function ensureMemoryProject(workspace: string): void {
	ensurePrivateDir(join(workspace, ".engram"));
	writeFileSync(
		join(workspace, ".engram", "config.json"),
		`${JSON.stringify({ project_name: MEMORY_PROJECT })}\n`,
	);
}

/**
 * The engine's environment: its own HOME (`<dataDir>/home`, mode 0700) with
 * the XDG folders under it, because parts of the engine write to fixed places
 * under the home folder. PATH is kept, with the bundled `pi` folder first, and so is the user's git identity,
 * through `GIT_CONFIG_GLOBAL` pointing at their real `~/.gitconfig`.
 *
 * Memory is the user's global Engram: Engram ties a server to its data folder
 * (by default under HOME), so `ENGRAM_DATA_DIR` points at the user's real one
 * (`GENTLE_DOT_ENGRAM_DATA_DIR` overrides it) and the memory plugin accepts the
 * user's server. The user's own `ENGRAM_PORT` and `ENGRAM_URL` are kept.
 * `GENTLE_DOT_ENGRAM=private` instead runs a memory of its own under the
 * engine's home, on port 7438 (`GENTLE_DOT_ENGRAM_PORT` overrides it).
 * Subagents are off (`GENTLE_PI_AGENTS=0`) until S25.
 *
 * Without a `TMPDIR` (the installed app's launch on Linux), the engine gets a
 * private one under its home: it caches compiled extensions in the temporary
 * folder, and a shared `/tmp` would let another local user plant that cache.
 *
 * An installed app (`GENTLE_DOT_RUNTIME`) also names the Engram binary
 * (`ENGRAM_BIN`, see `resolveEngramBin`), since its PATH has no user folders.
 */
export function isolatedAgentEnv(base: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
	const home = join(dataDir, "home");
	ensurePrivateDir(home);
	const realHome = base.HOME || homedir();
	const env: NodeJS.ProcessEnv = {
		...base,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_STATE_HOME: join(home, ".local", "state"),
	};
	for (const key of INHERITED_HOMES) delete env[key];
	if (!base.TMPDIR) {
		env.TMPDIR = join(home, ".cache", "tmp");
		ensurePrivateDir(env.TMPDIR);
	}
	const bin = bundledBinDir(base);
	if (bin) {
		const rest = (base.PATH ?? "").split(delimiter).filter((part) => part && part !== bin);
		env.PATH = [bin, ...rest].join(delimiter);
	}
	// Subagent child engines do not load the approval guard, so subagents stay off until the
	// daemon enforces connectors itself (S25).
	env.GENTLE_PI_AGENTS = "0";
	if (base.GENTLE_DOT_ENGRAM === "private") {
		env.ENGRAM_PORT = base.GENTLE_DOT_ENGRAM_PORT || PRIVATE_ENGRAM_PORT;
		delete env.ENGRAM_URL;
		delete env.ENGRAM_DATA_DIR;
	} else {
		env.ENGRAM_DATA_DIR =
			base.GENTLE_DOT_ENGRAM_DATA_DIR || base.ENGRAM_DATA_DIR || join(realHome, ".engram");
	}
	const runtime = runtimeDir(base);
	if (runtime) env.ENGRAM_BIN = resolveEngramBin(base, runtime, { home: realHome });
	const gitConfig = join(realHome, ".gitconfig");
	if (!base.GIT_CONFIG_GLOBAL && existsSync(gitConfig)) env.GIT_CONFIG_GLOBAL = gitConfig;
	return env;
}

/**
 * In private memory mode (`GENTLE_DOT_ENGRAM=private`) the engine's memory plugin starts a memory
 * server on the private port, and it outlives the engine. When nothing listened on that port as the
 * daemon started, the daemon caused it, so `stop()` ends it when the daemon closes: the PID that
 * listens on the port, and only after its `/health` instance id matches the private data folder's
 * (`<dataDir>/home/.engram/.instance-id`). Undefined outside private mode or when it already ran.
 */
export async function privateMemory(
	base: NodeJS.ProcessEnv,
	dataDir: string,
	log: (line: string) => void,
): Promise<{ stop(): Promise<void> } | undefined> {
	if (base.GENTLE_DOT_ENGRAM !== "private") return undefined;
	const port = base.GENTLE_DOT_ENGRAM_PORT || PRIVATE_ENGRAM_PORT;
	if ((await listeningPid(port)) !== undefined) return undefined;
	return {
		async stop() {
			const pid = await listeningPid(port);
			if (pid === undefined) return;
			let expected: string;
			try {
				expected = readFileSync(join(dataDir, "home", ".engram", ".instance-id"), "utf8").trim();
			} catch {
				return;
			}
			const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
				.then((response) => response.json() as Promise<{ instance_id?: unknown }>)
				.catch(() => undefined);
			if (!expected || health?.instance_id !== expected) {
				log(`the memory server on port ${port} serves other data; left running`);
				return;
			}
			try {
				process.kill(pid, "SIGTERM");
				log(`stopped the private memory server (pid ${pid})`);
			} catch {}
		},
	};
}

/** The one PID listening on `port` on this computer (`lsof`), if any. */
function listeningPid(port: string): Promise<number | undefined> {
	return new Promise((resolve) => {
		execFile("lsof", ["-t", "-n", "-P", `-iTCP:${port}`, "-sTCP:LISTEN"], (error, stdout) => {
			const pids = [...new Set(String(stdout).trim().split("\n").filter(Boolean))];
			resolve(!error && pids.length === 1 && /^\d+$/.test(pids[0] ?? "") ? Number(pids[0]) : undefined);
		});
	});
}
