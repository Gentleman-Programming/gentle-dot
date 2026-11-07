import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { resolveWindowsEngram } from "./windows-runtime.ts";

/**
 * The installed app's runtime folder (`GENTLE_DOT_RUNTIME`), or undefined in a
 * source checkout. It holds `node/`, `bin/` (`engram`, `pi`, and Windows private storage),
 * `daemon/` (this bundle and its `node_modules/`) and `ui/`.
 */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.GENTLE_DOT_RUNTIME ? resolve(env.GENTLE_DOT_RUNTIME) : undefined;
}

/** The runtime's flat install of the daemon's external dependencies. */
export function runtimeModules(runtime: string): string {
	return join(runtime, "daemon", "node_modules");
}

export function engramBinaryName(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "engram.exe" : "engram";
}

/** Usual user installations, after the login PATH on Unix. */
export function engramKnownDirs(home: string, platform: NodeJS.Platform = process.platform): string[] {
	if (platform === "win32") {
		return [
			join(home, "go", "bin"),
			join(home, "AppData", "Local", "engram", "bin"),
			join(home, ".local", "bin"),
		];
	}
	return [join(home, "go", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin")];
}

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function isExecutableFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
	try {
		accessSync(path, platform === "win32" ? constants.R_OK : constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

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
		return isAbsolute(found) && isExecutableFile(found, platform) ? found : undefined;
	} catch {
		return undefined;
	}
}

/** Explicit override, login PATH (Unix), known user folders, then the bundled executable. */
export function resolveEngramBin(
	env: NodeJS.ProcessEnv,
	runtime: string,
	options: { home?: string; knownDirs?: string[]; platform?: NodeJS.Platform } = {},
): string {
	if (process.platform === "win32") return resolveWindowsEngram(env, runtime, { home: options.home });
	if (env.ENGRAM_BIN) return env.ENGRAM_BIN;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? (env.HOME || (platform === "win32" && env.USERPROFILE) || homedir());
	const name = engramBinaryName(platform);
	const fromLogin = loginShellEngram(env, home, platform);
	if (fromLogin) return fromLogin;
	for (const dir of options.knownDirs ?? engramKnownDirs(home, platform)) {
		const bin = join(dir, name);
		if (isExecutableFile(bin, platform)) return bin;
	}
	return join(runtime, "bin", name);
}
