// POSIX file modes in tests.
//
// macOS and Linux carry real mode bits, so a file or directory the daemon means to keep private can
// be asserted to be `0o600` / `0o700` / `0o644` / `0o711`. Windows has none: `statSync().mode` never
// carries them, so a raw mode assertion there can never pass. File privacy on Windows comes from the
// ACL of the profile directory the data folder lives in, not from a per-file mode
// (odd/tasks/windows-port.md). These helpers skip the mode assertion on Windows, but announce every
// skip so a green Windows run cannot quietly assert nothing.
import { lstatSync, statSync } from "node:fs";
import { expect } from "vitest";

export function hasPosixModes(platform: string = process.platform): boolean {
	return platform !== "win32";
}

function warnSkipped(kind: "stat" | "lstat" | "executable", path: string, mode: number): void {
	console.warn(
		`posix-modes: skipped ${kind} mode 0o${mode.toString(8)} assertion for ${path}; ` +
			"Windows has no POSIX mode bits, and privacy relies on the ACL of the profile directory " +
			"(see odd/tasks/windows-port.md).",
	);
}

/** Asserts the `0o777` bits of `path`, or loudly skips on a platform without POSIX modes. */
export function expectPosixMode(path: string, mode: number, platform: string = process.platform): void {
	if (!hasPosixModes(platform)) {
		warnSkipped("stat", path, mode);
		return;
	}
	expect(statSync(path).mode & 0o777).toBe(mode);
}

/** The `lstat` twin of {@link expectPosixMode}, for a path that may be a symlink itself. */
export function expectPosixLstatMode(path: string, mode: number, platform: string = process.platform): void {
	if (!hasPosixModes(platform)) {
		warnSkipped("lstat", path, mode);
		return;
	}
	expect(lstatSync(path).mode & 0o777).toBe(mode);
}

/**
 * Asserts that `path` carries every execute bit, or loudly skips on a platform without POSIX
 * modes. Windows has no executable bit: there, whether a file can be run is a matter of its
 * extension, so the assertion is skipped and the wrapper becomes a `.cmd` in the packaging work.
 */
export function expectPosixExecutable(path: string, platform: string = process.platform): void {
	if (!hasPosixModes(platform)) {
		warnSkipped("executable", path, 0o111);
		return;
	}
	expect(statSync(path).mode & 0o111).toBe(0o111);
}
