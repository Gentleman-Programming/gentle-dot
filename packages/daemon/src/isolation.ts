import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
 * under the home folder. PATH is kept, and so is the user's git identity,
 * through `GIT_CONFIG_GLOBAL` pointing at their real `~/.gitconfig`.
 *
 * Memory is the user's global Engram: Engram ties a server to its data folder
 * (by default under HOME), so `ENGRAM_DATA_DIR` points at the user's real one
 * (`GENTLE_DOT_ENGRAM_DATA_DIR` overrides it) and the memory plugin accepts the
 * user's server. The user's own `ENGRAM_PORT` and `ENGRAM_URL` are kept.
 * `GENTLE_DOT_ENGRAM=private` instead runs a memory of its own under the
 * engine's home, on port 7438 (`GENTLE_DOT_ENGRAM_PORT` overrides it).
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
	if (base.GENTLE_DOT_ENGRAM === "private") {
		env.ENGRAM_PORT = base.GENTLE_DOT_ENGRAM_PORT || PRIVATE_ENGRAM_PORT;
		delete env.ENGRAM_URL;
		delete env.ENGRAM_DATA_DIR;
	} else {
		env.ENGRAM_DATA_DIR =
			base.GENTLE_DOT_ENGRAM_DATA_DIR || base.ENGRAM_DATA_DIR || join(realHome, ".engram");
	}
	const gitConfig = join(realHome, ".gitconfig");
	if (!base.GIT_CONFIG_GLOBAL && existsSync(gitConfig)) env.GIT_CONFIG_GLOBAL = gitConfig;
	return env;
}
