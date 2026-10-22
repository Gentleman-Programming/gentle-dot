/**
 * Writes one of the daemon's own files (the access key, `state.json`, `connectors.json`, the
 * encrypted secrets, the PIN hash): a new temporary file next to it, created exclusively (a link or
 * an older file there is never followed), checked to belong to the daemon's real user before
 * anything is written, then renamed over the old one. Windows uses the packaged native helper to
 * create and verify a protected current-user/SYSTEM DACL instead of relying on POSIX mode bits.
 * Refused inside an engine-access bracket
 * (`engine-access.ts`), where it would be created as the engine's user. Fails closed: a temporary
 * file that is not the daemon's is removed and the write throws.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { insideEngineAccess } from "./engine-access.ts";
import { windowsPrivateStorage } from "./windows-private-storage.ts";

export function writePrivateFile(path: string, text: string, mode = 0o600): void {
	if (insideEngineAccess())
		throw new Error(`${path} is the daemon's and is not written as the engine's user.`);
	if (process.platform === "win32") {
		windowsPrivateStorage("write-file", path, Buffer.from(text, "utf8"));
		return;
	}
	const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
	const fd = openSync(temp, "wx", mode);
	try {
		const owner = fstatSync(fd).uid;
		const self = process.getuid?.();
		if (self !== undefined && owner !== self)
			throw new Error(`${temp} was created as uid ${owner}, not the daemon's ${self}.`);
		writeFileSync(fd, text);
	} catch (error) {
		closeSync(fd);
		unlinkSync(temp);
		throw error;
	}
	closeSync(fd);
	renameSync(temp, path);
}

/** Tightens and verifies an existing daemon-owned file before sensitive reads on Windows. */
export function securePrivateFile(path: string): void {
	if (process.platform !== "win32") return;
	try {
		windowsPrivateStorage("secure-file", path);
	} catch (cause) {
		throw new PrivateFileProtectionError(path, cause);
	}
}

/** A private file whose Windows owner/DACL could not be verified or repaired before access. */
export class PrivateFileProtectionError extends Error {
	constructor(path: string, cause: unknown) {
		super(`Could not secure private file ${path} before access: ${(cause as Error).message}`, { cause });
		this.name = "PrivateFileProtectionError";
	}
}

/** Read daemon-private UTF-8 state only after the Windows file itself has a protected DACL. */
export function readPrivateFileSync(path: string): string {
	if (process.platform === "win32") {
		// The native operation is a no-op when the file is absent, so the read preserves ENOENT.
		securePrivateFile(path);
	}
	return readFileSync(path, "utf8");
}
