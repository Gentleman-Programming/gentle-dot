import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { expect, it } from "vitest";
import { readComputerArchive } from "../src/computer-archive.ts";
import type { ArtifactPin } from "../src/computer-providers.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
interface Entry { path: string; text?: string; method?: number; flags?: number; attr?: number; size?: number }
function fixture(entries: Entry[] = [{ path: "app.exe", text: "exe" },
	{ path: "_internal/", text: "" }, { path: "_internal/python.dll", text: "dll", method: 8 }]) {
	const locals: Buffer[] = [], centrals: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.path), data = Buffer.from(e.text ?? "x");
		const packed = e.method === 8 ? deflateRawSync(data) : data;
		const l = Buffer.alloc(30), c = Buffer.alloc(46);
		l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4);
		l.writeUInt16LE(e.flags ?? 0, 6); l.writeUInt16LE(e.method ?? 0, 8);
		l.writeUInt32LE(crc32(data), 14); l.writeUInt32LE(packed.length, 18);
		l.writeUInt32LE(e.size ?? data.length, 22); l.writeUInt16LE(name.length, 26);
		c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314, 4);
		l.copy(c, 6, 4, 26); c.writeUInt16LE(name.length, 28);
		c.writeUInt32LE(e.attr ?? (e.path.endsWith("/") ? 0x41ed0010 : 0x81b60000), 38);
		c.writeUInt32LE(offset, 42);
		locals.push(l, name, packed); centrals.push(c, name); offset += 30 + name.length + packed.length;
	}
	const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	const bytes = Buffer.concat([...locals, directory, end]);
	const pin: ArtifactPin = { kind: "eyes", version: "fixture", entry: "app.exe",
		archiveSize: bytes.length, archiveSha256: sha(bytes), entrySha256: sha(Buffer.from("exe")) };
	return { bytes, pin };
}
function rejected(f: ReturnType<typeof fixture>, mutate?: (b: Buffer) => void, repin = true) {
	mutate?.(f.bytes);
	if (repin) { f.pin.archiveSize = f.bytes.length; f.pin.archiveSha256 = sha(f.bytes); }
	const before = Buffer.from(f.bytes);
	let result: unknown = "not returned";
	expect(() => { result = readComputerArchive(f.bytes, "eyes", [f.pin]); })
		.toThrow("Invalid computer archive");
	expect(result).toBe("not returned");
	expect(f.bytes.equals(before)).toBe(true);
}

it("returns the complete stored/deflated onedir payload with independent bytes and hashes", () => {
	const { bytes, pin } = fixture(), before = Buffer.from(bytes);
	const files = readComputerArchive(bytes, "eyes", [pin]);
	expect(files.map(f => [f.path, f.bytes.toString(), f.sha256])).toEqual([
		["app.exe", "exe", sha(Buffer.from("exe"))],
		["_internal/python.dll", "dll", sha(Buffer.from("dll"))],
	]);
	files[0]!.bytes.fill(0);
	expect(bytes.equals(before)).toBe(true);
});
it.each(["archive-size", "archive-sha", "entry-sha", "entry-name", "kind"])("rejects identity %s before returning payload", fault => {
	const f = fixture();
	if (fault === "archive-size") f.pin.archiveSize++;
	if (fault === "archive-sha") f.pin.archiveSha256 = "0".repeat(64);
	if (fault === "entry-sha") f.pin.entrySha256 = "0".repeat(64);
	if (fault === "entry-name") f.pin.entry = "other.exe";
	if (fault === "kind") f.pin.kind = "hands";
	rejected(f, undefined, false);
});
it.each(["/abs", "../escape", "a/../b", "a\\b", "C:ads", "CON", "nul.txt", "a/COM1.dll",
	"LPT9", "a.", "a ", "a//b", "./b", "a/\u0000b", "a/\u007fb", "a/<b", "a/aux.txt"])("rejects unsafe Windows path %s", path => {
	rejected(fixture([{ path: "app.exe", text: "exe" }, { path }]));
});
it.each([
	["A", "a"], ["a/", "A/"], ["a", "a/b"], ["a/b", "A"], ["app.exe", "dir/app.exe"],
])("rejects duplicate or ambiguous ancestry %s / %s", (a, b) => {
	rejected(fixture([{ path: "app.exe", text: "exe" }, { path: a, text: "" }, { path: b, text: "" }]));
});
it.each([
	{ flags: 1 }, { flags: 8 }, { flags: 16 }, { method: 12 },
	{ attr: 0xa1ff0000 }, { attr: 0x81b60400 }, { attr: 0x21ff0000 },
	{ attr: 0x41ed0010 }, { size: 64 * 1024 * 1024 + 1 }, { size: 0xffffffff },
])("rejects unsupported metadata %j", bad => {
	rejected(fixture([{ path: "app.exe", text: "exe" }, { path: "bad", ...bad }]));
});
it.each(["local-name", "local-method", "local-crc", "crc", "length", "offset", "disk", "zip64", "count", "central-size", "trailing", "truncated"])("rejects inconsistent/ranged ZIP %s", fault => {
	const f = fixture();
	rejected(f, b => {
		const end = b.length - 22, c = b.readUInt32LE(end + 16);
		if (fault === "local-name") b[30] = 120;
		if (fault === "local-method") b.writeUInt16LE(8, 8);
		if (fault === "local-crc") b.writeUInt32LE(0, 14);
		if (fault === "crc") { b.writeUInt32LE(0, 14); b.writeUInt32LE(0, c + 16); }
		if (fault === "length") { b.writeUInt32LE(4, 22); b.writeUInt32LE(4, c + 24); }
		if (fault === "offset") b.writeUInt32LE(c, c + 42);
		if (fault === "disk") b.writeUInt16LE(1, end + 4);
		if (fault === "zip64") b.writeUInt32LE(0xffffffff, end + 16);
		if (fault === "count") { b.writeUInt16LE(4097, end + 8); b.writeUInt16LE(4097, end + 10); }
		if (fault === "central-size") b.writeUInt32LE(0xffffffff, end + 12);
		if (fault === "trailing") b.writeUInt16LE(1, end + 20);
		if (fault === "truncated") b.fill(0, end);
	});
});
it("rejects nonempty directory payload and expanded-total bombs before inflation", () => {
	rejected(fixture([{ path: "app.exe", text: "exe" }, { path: "dir/", text: "x" }]));
	rejected(fixture([{ path: "app.exe", text: "exe" }, ...Array.from({ length: 4 }, (_, i) =>
		({ path: `f${i}`, method: 8, size: 64 * 1024 * 1024 }))]));
});
it("enforces entry and archive budgets at the boundary", () => {
	const f = fixture([{ path: "app.exe", text: "exe" }, ...Array.from({ length: 4095 }, (_, i) => ({ path: `f${i}`, text: "" }))]);
	expect(readComputerArchive(f.bytes, "eyes", [f.pin])).toHaveLength(4096);
	const bytes = Buffer.alloc(64 * 1024 * 1024 + 1);
	rejected({ bytes, pin: f.pin });
});
it("bounds deflate output by declared length, not just compressed size", () => {
	rejected(fixture([{ path: "app.exe", text: "exe" }, { path: "bomb", text: "x".repeat(10000), method: 8, size: 1 }]));
});
