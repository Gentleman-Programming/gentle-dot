/** Windows executable discovery. Never runs a login shell or changes the user's environment. */
import { accessSync, constants, statSync } from "node:fs";
import { win32 } from "node:path";

type Environment = Record<string, string | undefined>;

/** Windows environment names are case-insensitive, including when copied into a JS object. */
export function windowsVariable(env: Environment, name: string): string | undefined {
	const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
	return key === undefined ? undefined : env[key];
}

function absolute(path: string): boolean {
	// Reject drive-relative C:foo and root-relative \\foo, which depend on the launching shell.
	return /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\/]+\\[^\\/]+(?:[\\/]|$)/.test(path);
}

export function windowsUserHome(env: Environment): string | undefined {
	const profile = windowsVariable(env, "USERPROFILE");
	if (profile && absolute(profile)) return win32.normalize(profile);
	const drive = windowsVariable(env, "HOMEDRIVE");
	const directory = windowsVariable(env, "HOMEPATH");
	const combined = drive && directory ? drive + directory : undefined;
	return combined && absolute(combined) ? win32.normalize(combined) : undefined;
}

function readableFile(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Same precedence as the existing runtime: explicit override, user install, packaged fallback.
 * Files inside a valid junction are allowed. This is discovery, not an integrity/ACL verdict.
 * An explicit invalid override is an error, never a silent switch to another memory binary.
 */
export function resolveWindowsEngram(
	env: Environment,
	runtime: string,
	options: { home?: string; isFile?: (path: string) => boolean } = {},
): string {
	const isFile = options.isFile ?? readableFile;
	const explicit = windowsVariable(env, "ENGRAM_BIN");
	if (explicit) {
		if (!absolute(explicit) || !/\.exe$/i.test(explicit) || !isFile(explicit)) {
			throw new Error("ENGRAM_BIN must name an existing, readable absolute Windows .exe file.");
		}
		return win32.normalize(explicit);
	}
	if (!absolute(runtime)) throw new Error("The Windows runtime directory must be an absolute path.");
	const home = options.home ?? windowsUserHome(env);
	const directories = (windowsVariable(env, "PATH") ?? "").split(";").map((entry) => {
		const value = entry.trim();
		return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
	});
	if (home && absolute(home))
		directories.push(win32.join(home, "go", "bin"), win32.join(home, ".local", "bin"));
	directories.push(win32.join(runtime, "bin"));
	const seen = new Set<string>();
	for (const directory of directories) {
		if (!absolute(directory)) continue;
		const candidate = win32.join(directory, "engram.exe");
		const key = candidate.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (isFile(candidate)) return candidate;
	}
	throw new Error(
		"Engram is missing from the Windows runtime and user executable locations. Repair the runtime.",
	);
}
