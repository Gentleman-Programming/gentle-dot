import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Creates `path` with mode 0700, and tightens it to 0700 when it already exists. */
export function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

/** Variables that could point the engine back at the user's own setup. */
const INHERITED_HOMES = ["PI_CODING_AGENT_DIR", "GENTLE_PI_AGENT_HOME", "GENTLE_SHELL_CONFIG", "ENGRAM_URL"];

/**
 * The assistant's own memory server port. Engram ties a server to the HOME
 * that started it and refuses one started from another HOME, so the user's
 * server (port 7437) can be used by neither side once the homes differ.
 */
export const ASSISTANT_ENGRAM_PORT = "7438";

/**
 * The engine's environment: its own HOME (`<dataDir>/home`, mode 0700) with
 * the XDG folders under it, because parts of the engine write to fixed places
 * under the home folder, and its own memory server port. PATH is kept, and so
 * is the user's git identity, through `GIT_CONFIG_GLOBAL` pointing at their
 * real `~/.gitconfig`. `GENTLE_DOT_ENGRAM_PORT` overrides the memory port.
 */
export function isolatedAgentEnv(base: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
	const home = join(dataDir, "home");
	ensurePrivateDir(home);
	const env: NodeJS.ProcessEnv = {
		...base,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		ENGRAM_PORT: base.GENTLE_DOT_ENGRAM_PORT || ASSISTANT_ENGRAM_PORT,
	};
	for (const key of INHERITED_HOMES) delete env[key];
	const gitConfig = join(base.HOME || homedir(), ".gitconfig");
	if (!base.GIT_CONFIG_GLOBAL && existsSync(gitConfig)) env.GIT_CONFIG_GLOBAL = gitConfig;
	return env;
}
