import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { readComputerArchive, type ComputerArchiveFile } from "./computer-archive.ts";
import { COMPUTER_ARTIFACTS, type AcquiredComponent, type ArtifactPin } from "./computer-providers.ts";
import { insideEngineAccess } from "./engine-access.ts";
import { ensurePrivateDir } from "./isolation.ts";
import { windowsPrivateStorage } from "./windows-private-storage.ts";

type Kind = "eyes" | "hands";
const invalid = () => new Error("Invalid computer component cache");
const supported = () => process.platform === "win32" && process.arch === "x64";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function stat(path: string) {
	try { return lstatSync(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function contained(root: string, path: string) {
	const rel = relative(root, path);
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw invalid();
}
/** Check existing ancestors without creating, repairing, or following a junction. */
function directories(path: string) {
	const root = parse(path).root;
	let current = root;
	for (const part of relative(root, path).split(sep).filter(Boolean)) {
		current = join(current, part);
		const info = stat(current);
		if (!info) break;
		if (!info.isDirectory() || info.isSymbolicLink() ||
			realpathSync(current).toLowerCase() !== current.toLowerCase()) throw invalid();
	}
}
function location(dataDir: string, kind: Kind, pins: readonly ArtifactPin[]) {
	if (!supported() || !isAbsolute(dataDir) || !/^[a-z]:[\\/]/i.test(dataDir)) throw invalid();
	const matches = pins.filter(pin => pin.kind === kind), pin = matches[0];
	if ((kind !== "eyes" && kind !== "hands") || matches.length !== 1 || !pin ||
		!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(pin.version) || !/^[a-f0-9]{64}$/.test(pin.archiveSha256)) throw invalid();
	const data = resolve(dataDir), parent = join(data, "components", "windows-x64", kind);
	const version = join(parent, `${pin.version}-${pin.archiveSha256}`);
	contained(data, version);
	return { data, parent, version, pin };
}
function regularBytes(path: string, size: number) {
	directories(dirname(path));
	const info = stat(path);
	if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== size) throw invalid();
	const bytes = readFileSync(path), after = lstatSync(path);
	if (after.ino !== info.ino || after.dev !== info.dev || after.nlink !== 1 || bytes.length !== size) throw invalid();
	return bytes;
}
/** The pinned original archive, not a receipt, defines every allowed file and directory. */
function verifyVersion(version: string, kind: Kind, pins: readonly ArtifactPin[], pin: ArtifactPin): AcquiredComponent {
	directories(version);
	const archivePath = join(version, "archive.zip");
	const files = readComputerArchive(regularBytes(archivePath, pin.archiveSize), kind, pins);
	const expected = new Map(files.map(file => [`payload/${file.path}`, file]));
	const dirs = new Set(["payload"]);
	for (const path of expected.keys()) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
	}
	function walk(path: string, prefix = "") {
		for (const name of readdirSync(path)) {
			const key = prefix + name, child = join(path, name), info = lstatSync(child);
			contained(version, child);
			if (info.isSymbolicLink()) throw invalid();
			if (info.isDirectory()) {
				if (!dirs.delete(key)) throw invalid();
				directories(child);
				walk(child, `${key}/`);
			} else if (key !== "archive.zip") {
				const file = expected.get(key);
				if (!file || sha(regularBytes(child, file.bytes.length)) !== file.sha256) throw invalid();
				expected.delete(key);
			}
		}
	}
	walk(version);
	if (expected.size || dirs.size) throw invalid();
	const entry = files.find(file => basename(file.path) === pin.entry)!;
	return { archivePath, executablePath: join(version, "payload", entry.path) };
}

/** Read-only verification; absent version returns undefined, invalid version throws a path-free error.
 * Expected pins are a deterministic test seam. Production callers must omit them.
 */
export function verifyCachedComputerComponent(dataDir: string, kind: Kind,
	pins: readonly ArtifactPin[] = COMPUTER_ARTIFACTS): AcquiredComponent | undefined {
	try {
		const { version, pin } = location(dataDir, kind, pins);
		directories(dirname(version));
		if (!stat(version)) return undefined;
		return verifyVersion(version, kind, pins, pin);
	} catch { throw invalid(); }
}

/** Discover only a complete, independently verified pair; never repair, install or expose errors. */
export function discoverComputerComponents(dataDir: string,
	pins: readonly ArtifactPin[] = COMPUTER_ARTIFACTS): Record<Kind, AcquiredComponent> | undefined {
	if (!supported()) return undefined;
	try {
		const eyes = verifyCachedComputerComponent(dataDir, "eyes", pins);
		const hands = verifyCachedComputerComponent(dataDir, "hands", pins);
		return eyes && hands ? { eyes, hands } : undefined;
	} catch { return undefined; }
}

/** Install already acquired bytes synchronously (serializes this process's requests).
 * Validate the ENTIRE archive before any filesystem mutation. Never replace a version,
 * remove evidence, download, launch, or grant a session. Failures retain staging.
 */
export function installComputerComponent(dataDir: string, archive: Buffer, kind: Kind,
	pins: readonly ArtifactPin[] = COMPUTER_ARTIFACTS): AcquiredComponent {
	const retained = Buffer.from(archive);
	const files: ComputerArchiveFile[] = readComputerArchive(retained, kind, pins);
	try {
		if (insideEngineAccess()) throw invalid();
		const { data, parent, version, pin } = location(dataDir, kind, pins);
		const prior = verifyCachedComputerComponent(data, kind, pins);
		if (prior) return prior;
		// Protect each cache parent, not only the last directory. The native boundary
		// rejects all reparse ancestors and verifies owner/protected DACL on every write.
		for (const path of [data, join(data, "components"), join(data, "components", "windows-x64"), parent]) {
			directories(path);
			ensurePrivateDir(path);
		}
		const staging = join(parent, `.staging-${randomBytes(16).toString("hex")}`);
		mkdirSync(staging); // Exclusive, inherits the already-private parent's DACL.
		ensurePrivateDir(staging);
		windowsPrivateStorage("write-file", join(staging, "archive.zip"), retained);
		const payload = join(staging, "payload");
		ensurePrivateDir(payload);
		for (const file of files) {
			const destination = join(payload, file.path);
			contained(payload, destination);
			ensurePrivateDir(dirname(destination));
			windowsPrivateStorage("write-file", destination, file.bytes);
		}
		verifyVersion(staging, kind, pins, pin);
		directories(parent);
		ensurePrivateDir(parent);
		const winner = verifyCachedComputerComponent(data, kind, pins);
		if (winner) return winner; // Only reuse a fully revalidated concurrent winner.
		try {
			// Windows directory rename fails if the destination exists; no replace or cleanup.
			renameSync(staging, version);
		} catch {
			const concurrent = verifyCachedComputerComponent(data, kind, pins);
			if (concurrent) return concurrent;
			throw invalid();
		}
		return verifyVersion(version, kind, pins, pin);
	} catch { throw invalid(); }
}
