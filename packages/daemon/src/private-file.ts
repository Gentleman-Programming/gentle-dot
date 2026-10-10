/**
 * Writes one of the daemon's own files (the access key, `state.json`, `connectors.json`, the
 * encrypted secrets, the PIN hash): a new temporary file next to it, created exclusively (a link or
 * an older file there is never followed), checked to belong to the daemon's real user before
 * anything is written, then renamed over the old one. Refused inside an engine-access bracket
 * (`engine-access.ts`), where it would be created as the engine's user. Fails closed: a temporary
 * file that is not the daemon's is removed and the write throws.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { insideEngineAccess } from "./engine-access.ts";

export function writePrivateFile(path: string, text: string, mode = 0o600): void {
	if (insideEngineAccess())
		throw new Error(`${path} is the daemon's and is not written as the engine's user.`);
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
