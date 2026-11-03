import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { COMPUTER_ARTIFACTS, type ArtifactPin } from "./computer-providers.ts";

export interface ComputerArchiveFile { path: string; bytes: Buffer; sha256: string }
const MiB = 1024 * 1024;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function requireValid(ok: boolean): asserts ok {
	if (!ok) throw new Error("Invalid computer archive");
}

/** Read-only, all-or-nothing ZIP32 validation. The expected pins argument is a test
 * seam; production callers omit it. No extraction, network, or executable loading.
 * Intentionally supports only the conservative subset used by our two artifacts.
 */
export function readComputerArchive(archive: Buffer, kind: "eyes" | "hands",
	pins: readonly ArtifactPin[] = COMPUTER_ARTIFACTS): ComputerArchiveFile[] {
	try {
		const matches = pins.filter(p => p.kind === kind), pin = matches[0];
		requireValid(matches.length === 1 && !!pin);
		requireValid(archive.length <= 64 * MiB && archive.length === pin.archiveSize);
		requireValid(sha(archive) === pin.archiveSha256);
		return decode(archive, pin);
	} catch {
		// Never disclose names, local paths, decompressor diagnostics, or partial data.
		throw new Error("Invalid computer archive");
	}
}

function decode(b: Buffer, pin: ArtifactPin): ComputerArchiveFile[] {
	function range(start: number, size: number, end = b.length) {
		requireValid(Number.isSafeInteger(start) && Number.isSafeInteger(size) &&
			start >= 0 && size >= 0 && start <= end && size <= end - start);
	}
	// No comments, prefixes, trailers, descriptors, extras, or ZIP64 extension records.
	range(b.length - 22, 22);
	const end = b.length - 22;
	requireValid(b.readUInt32LE(end) === 0x06054b50 && b.readUInt16LE(end + 20) === 0);
	requireValid(b.readUInt32LE(end + 4) === 0);
	const count = b.readUInt16LE(end + 10), centralSize = b.readUInt32LE(end + 12);
	const central = b.readUInt32LE(end + 16);
	requireValid(count > 0 && count <= 4096 && b.readUInt16LE(end + 8) === count);
	range(central, centralSize, end);
	requireValid(central + centralSize === end);
	const records: { path: string; directory: boolean; start: number; packed: number;
		size: number; crc: number; method: number }[] = [];
	const explicit = new Set<string>(), paths = new Map<string, { path: string; directory: boolean }>();
	let cursor = central, localEnd = 0, total = 0;
	for (let i = 0; i < count; i++) {
		range(cursor, 46, end);
		requireValid(b.readUInt32LE(cursor) === 0x02014b50);
		const version = b.readUInt16LE(cursor + 6), flags = b.readUInt16LE(cursor + 8);
		const method = b.readUInt16LE(cursor + 10), crc = b.readUInt32LE(cursor + 16);
		const packed = b.readUInt32LE(cursor + 20), size = b.readUInt32LE(cursor + 24);
		const nameLength = b.readUInt16LE(cursor + 28), extra = b.readUInt16LE(cursor + 30);
		const comment = b.readUInt16LE(cursor + 32), attr = b.readUInt32LE(cursor + 38);
		const local = b.readUInt32LE(cursor + 42);
		requireValid((version === 10 || version === 20) && (flags === 0 || flags === 0x800));
		requireValid((method === 0 || method === 8) && extra === 0 && comment === 0);
		requireValid(b.readUInt16LE(cursor + 34) === 0 && size <= 64 * MiB);
		range(cursor + 46, nameLength, end);
		const rawName = b.subarray(cursor + 46, cursor + 46 + nameLength);
		// ASCII only avoids encoding/codepage and Unicode Windows normalization aliases.
		requireValid(rawName.length > 0 && rawName.every(c => c >= 32 && c < 127));
		const name = rawName.toString("ascii"), directory = name.endsWith("/");
		const path = directory ? name.slice(0, -1) : name;
		const parts = path.split("/");
		requireValid(parts.every(part => part.length > 0 && part !== "." && part !== ".." &&
			!/[\\:<>"|?*]/.test(part) && !/[. ]$/.test(part) &&
			!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)));
		const type = (attr >>> 16) & 0xf000;
		requireValid((attr & 0x400) === 0 && (type === 0 || type === (directory ? 0x4000 : 0x8000)));
		requireValid(!(attr & 0x10) || directory);
		if (directory) requireValid(size === 0 && packed === 0 && crc === 0 && method === 0);
		const key = path.toLowerCase();
		requireValid(!explicit.has(key));
		explicit.add(key);
		// Register implicit ancestors as directories too, independent of entry ordering.
		for (let n = 1; n <= parts.length; n++) {
			const ancestor = parts.slice(0, n).join("/"), folded = ancestor.toLowerCase();
			const isDirectory = n < parts.length || directory, prior = paths.get(folded);
			requireValid(!prior || (prior.path === ancestor && prior.directory === isDirectory));
			paths.set(folded, { path: ancestor, directory: isDirectory });
		}
		total += size;
		requireValid(total <= 256 * MiB);
		// Local records must form a contiguous, non-overlapping prefix in central order.
		requireValid(local === localEnd);
		range(local, 30, central);
		requireValid(b.readUInt32LE(local) === 0x04034b50);
		requireValid(b.subarray(local + 4, local + 26).equals(b.subarray(cursor + 6, cursor + 28)));
		requireValid(b.readUInt16LE(local + 26) === nameLength && b.readUInt16LE(local + 28) === 0);
		range(local + 30, nameLength, central);
		requireValid(b.subarray(local + 30, local + 30 + nameLength).equals(rawName));
		const start = local + 30 + nameLength;
		range(start, packed, central);
		localEnd = start + packed;
		records.push({ path, directory, start, packed, size, crc, method });
		cursor += 46 + nameLength;
	}
	requireValid(cursor === end && localEnd === central);
	const files: ComputerArchiveFile[] = [];
	let executables = 0;
	for (const r of records) {
		const compressed = b.subarray(r.start, r.start + r.packed);
		let bytes: Buffer;
		if (r.method === 8) {
			// Node's info:true returns engine + buffer; installed typings omit that overload.
			const result = inflateRawSync(compressed, { maxOutputLength: Math.max(1, r.size), info: true }) as unknown as {
				buffer: Buffer; engine: { bytesWritten: number };
			};
			requireValid(result.engine.bytesWritten === r.packed);
			bytes = result.buffer;
		} else bytes = Buffer.from(compressed);
		requireValid(bytes.length === r.size && crc32(bytes) === r.crc);
		if (r.directory) continue;
		const hash = sha(bytes);
		if (r.path.split("/").at(-1)?.toLowerCase() === pin.entry.toLowerCase()) {
			requireValid(r.path.split("/").at(-1) === pin.entry && hash === pin.entrySha256);
			executables++;
		}
		files.push({ path: r.path, bytes, sha256: hash });
	}
	requireValid(executables === 1);
	return files;
}
