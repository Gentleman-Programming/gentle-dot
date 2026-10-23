import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * A root Win32 canonicalized keeps its verbatim prefix (`\\?\C:\…`, or `\\?\UNC\server\share`).
 * Win32 wants it; Node does not. Handed to `spawn` as the engine's entry, a verbatim path is taken
 * by Node's module resolver as a bare drive (`C:`) and fails with `EISDIR`, which is exactly what an
 * installed copy did (W30): the app's `resource_dir()` is canonicalized, so the root arrives that way.
 */
function withoutVerbatim(root: string): string {
	if (root.startsWith("\\\\?\\UNC\\")) return `\\\\${root.slice(8)}`;
	if (root.startsWith("\\\\?\\")) return root.slice(4);
	return root;
}

/**
 * The installed app's runtime folder (`GENTLE_DOT_RUNTIME`), or undefined in a
 * source checkout. It holds `node/`, `bin/` (`engram`, `pi`),
 * `daemon/` (this bundle and its `node_modules/`) and `ui/`.
 */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.GENTLE_DOT_RUNTIME ? resolve(withoutVerbatim(env.GENTLE_DOT_RUNTIME)) : undefined;
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

/** The guard's file name on a platform, which resolves a program by its extension. */
export function engramGuardName(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "engram-guard.exe" : "engram-guard";
}

/**
 * The extensions Windows itself starts from a path, which is how the providers run `ENGRAM_BIN`:
 * a direct `spawn`, no shell (measured in gentle-engram: `spawn(ENGRAM_BIN, …)` and
 * `spawnSync(ENGRAM_BIN, ["instance-id"])`). `.bat` and `.cmd` are deliberately absent — Node
 * refuses to start those without a shell, so they are no more usable here than a script.
 */
const WINDOWS_PROGRAM_EXTENSIONS = [".exe", ".com"];

/**
 * Whether this platform can start `path` at all. Windows starts a program by its extension rather
 * than by a mode bit, so the POSIX guard — a `#!/bin/sh` script with no extension — exists there and
 * still cannot run. POSIX starts anything executable, shebang or not.
 */
export function isStartableProgram(path: string, platform: NodeJS.Platform): boolean {
	if (!existsSync(path)) return false;
	if (platform !== "win32") return isExecutableFile(path);
	const lower = path.toLowerCase();
	return WINDOWS_PROGRAM_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * The guard the engine gets **instead of** an `ENGRAM_BIN` this platform cannot start.
 *
 * The POSIX guard ships as a `#!/bin/sh` script, and Windows cannot start it: the provider then
 * reported "the Engram binary could not be found" for a file that was right there, while nothing
 * listened on the private port. Substituting the runtime's own guard keeps the guard's real
 * contract — refuse, print why, touch no store — and makes the notice true on every platform.
 *
 * Two cases are deliberately **not** substituted. An `ENGRAM_BIN` this platform starts is the
 * caller's choice and is left alone. A path that is not there is a different defect, and the
 * provider's own message names it better than a refusal would: substituting there would hide a
 * typo behind "memory disabled".
 */
export function refusalGuard(
	env: NodeJS.ProcessEnv,
	runtime: string,
	options: {
		platform?: NodeJS.Platform;
		startable?: (path: string, platform: NodeJS.Platform) => boolean;
		exists?: (path: string) => boolean;
	} = {},
): string | undefined {
	const inherited = env.ENGRAM_BIN;
	if (!inherited) return undefined;
	const platform = options.platform ?? process.platform;
	const startable = options.startable ?? isStartableProgram;
	if (startable(inherited, platform)) return undefined;
	const exists = options.exists ?? existsSync;
	if (!exists(inherited)) return undefined;
	const guard = join(runtime, "bin", engramGuardName(platform));
	return exists(guard) ? guard : undefined;
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
