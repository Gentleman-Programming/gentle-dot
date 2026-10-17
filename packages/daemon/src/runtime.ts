import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The installed app's runtime folder (`GENTLE_DOT_RUNTIME`), or undefined in a
 * source checkout. It holds `node/`, `bin/` (`engram`, `pi`),
 * `daemon/` (this bundle and its `node_modules/`) and `ui/`.
 */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.GENTLE_DOT_RUNTIME ? resolve(env.GENTLE_DOT_RUNTIME) : undefined;
}

/** The runtime's flat install of the daemon's external dependencies. */
export function runtimeModules(runtime: string): string {
	return join(runtime, "daemon", "node_modules");
}

/**
 * The Engram executable's name on a platform. Windows resolves a program by its extension
 * rather than by a mode bit, so a bare `engram` is never the file to look for there.
 */
export function engramBinaryName(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "engram.exe" : "engram";
}

/** Where a user's own Engram usually lives, after the login PATH. */
export function engramKnownDirs(home: string): string[] {
	return [join(home, "go", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin")];
}

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * The `engram` the user's login shell finds. The app starts with a fixed PATH,
 * so the shell builds the user's own from their profile, starting from the system one.
 *
 * Windows has no login shell and no `command -v`, so there is no probe to run there and
 * this returns undefined by construction rather than by a failed spawn.
 */
function loginShellEngram(
	env: NodeJS.ProcessEnv,
	home: string,
	platform: NodeJS.Platform,
): string | undefined {
	if (platform === "win32") return undefined;
	try {
		const output = execFileSync(env.SHELL || "/bin/sh", ["-l", "-c", "command -v engram"], {
			env: { ...env, HOME: home, PATH: SYSTEM_PATH },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		const found = output.trim().split("\n").at(-1)?.trim() ?? "";
		return isAbsolute(found) && isExecutableFile(found) ? found : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The Engram binary of an installed app: `ENGRAM_BIN`, then an `engram` on the
 * user's login PATH or in the usual folders, so the user's own version keeps
 * serving `~/.engram`, and only then the one the runtime carries.
 *
 * Windows has no login shell to ask and no `command -v` to ask with, so the login step does
 * not exist there: the chain is `ENGRAM_BIN`, then the known folders, then the runtime's own
 * copy, and the file is `engram.exe`.
 */
export function resolveEngramBin(
	env: NodeJS.ProcessEnv,
	runtime: string,
	options: { home?: string; knownDirs?: string[]; platform?: NodeJS.Platform } = {},
): string {
	if (env.ENGRAM_BIN) return env.ENGRAM_BIN;
	const platform = options.platform ?? process.platform;
	const binary = engramBinaryName(platform);
	const home = options.home ?? (env.HOME || homedir());
	const fromLogin = loginShellEngram(env, home, platform);
	if (fromLogin) return fromLogin;
	for (const dir of options.knownDirs ?? engramKnownDirs(home)) {
		const bin = join(dir, binary);
		if (isExecutableFile(bin)) return bin;
	}
	return join(runtime, "bin", binary);
}
