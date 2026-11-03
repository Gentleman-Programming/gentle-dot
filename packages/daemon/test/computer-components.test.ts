import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { expect, it } from "vitest";
import { discoverComputerComponents, installComputerComponent, verifyCachedComputerComponent } from "../src/computer-components.ts";
import type { ArtifactPin } from "../src/computer-providers.ts";
import { inspectWindowsAcl } from "./windows-acl-oracle.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const windows = it.skipIf(process.platform !== "win32" || process.arch !== "x64");
function fixture(kind: "eyes" | "hands" = "eyes", version = "fixture", extraName?: string) {
	const payload: [string, string][] = [[`${kind}.exe`, "synthetic executable; never run"],
		["_internal/python.dll", "synthetic DLL"], ["_internal/data/config.txt", "payload data"]];
	if (extraName) payload.push([extraName, "synthetic failure fixture"]);
	const locals: Buffer[] = [], centrals: Buffer[] = [];
	let offset = 0;
	for (const [path, text] of payload) {
		const name = Buffer.from(path), data = Buffer.from(text), packed = deflateRawSync(data);
		const local = Buffer.alloc(30), central = Buffer.alloc(46);
		local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
		central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4);
		local.copy(central, 6, 4, 26); central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(0x81b60000, 38); central.writeUInt32LE(offset, 42);
		locals.push(local, name, packed); centrals.push(central, name); offset += 30 + name.length + packed.length;
	}
	const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50); end.writeUInt16LE(payload.length, 8); end.writeUInt16LE(payload.length, 10);
	end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	const archive = Buffer.concat([...locals, directory, end]);
	const pin: ArtifactPin = { kind, version, entry: `${kind}.exe`, archiveSize: archive.length,
		archiveSha256: sha(archive), entrySha256: sha(Buffer.from(payload[0]![1])) };
	return { archive, pin, payload };
}
function root() { return mkdtempSync(join(tmpdir(), "t5e-cache-")); }
function versionPath(data: string, pin: ArtifactPin) {
	return join(data, "components", "windows-x64", pin.kind, `${pin.version}-${pin.archiveSha256}`);
}
function snapshot(path: string): unknown {
	if (!existsSync(path)) return null;
	return readdirSync(path).sort().map(name => {
		const file = join(path, name), stat = statSync(file);
		return [name, stat.isDirectory() ? snapshot(file) : sha(readFileSync(file))];
	});
}

windows("rejects archive/pin failures before creating or changing the data directory", () => {
	const data = join(root(), "absent"), f = fixture();
	for (const fault of ["bytes", "size", "entry", "version"] as const) {
		const pin = { ...f.pin }, archive = Buffer.from(f.archive);
		if (fault === "bytes") archive[0] = archive[0]! ^ 1;
		if (fault === "size") pin.archiveSize++;
		if (fault === "entry") pin.entrySha256 = "0".repeat(64);
		if (fault === "version") pin.version = "../../escape";
		const before = Buffer.from(archive);
		expect(() => installComputerComponent(data, archive, "eyes", [pin])).toThrow();
		expect(existsSync(data)).toBe(false);
		expect(archive).toEqual(before);
	}
});

windows("installs complete bytes privately, discovers a verified pair and reuses without writes", () => {
	const data = join(root(), "data"), eyes = fixture(), hands = fixture("hands"), pins = [eyes.pin, hands.pin];
	expect(discoverComputerComponents(data, pins)).toBeUndefined();
	expect(existsSync(data)).toBe(false);
	const records = { eyes: installComputerComponent(data, eyes.archive, "eyes", pins),
		hands: installComputerComponent(data, hands.archive, "hands", pins) };
	for (const f of [eyes, hands]) {
		const record = records[f.pin.kind];
		expect(readFileSync(record.archivePath)).toEqual(f.archive);
		for (const [path, text] of f.payload) expect(readFileSync(join(dirname(record.archivePath), "payload", path), "utf8")).toBe(text);
		for (const path of [data, join(data, "components"), join(data, "components", "windows-x64"),
			dirname(dirname(record.archivePath)), dirname(record.archivePath), record.archivePath,
			dirname(record.executablePath), record.executablePath,
			join(dirname(record.executablePath), "_internal"),
			join(dirname(record.executablePath), "_internal", "python.dll"),
			join(dirname(record.executablePath), "_internal", "data"),
			join(dirname(record.executablePath), "_internal", "data", "config.txt")]) {
			const acl = inspectWindowsAcl(path);
			expect(acl.owner).toBe(acl.currentSid);
			expect(acl.protected).toBe(true);
			expect(acl.rules.map(r => r.sid).sort()).toEqual([acl.currentSid, "S-1-5-18"].sort());
			expect(acl.rules.every(r => r.type === "Allow" && !r.inherited)).toBe(true);
		}
	}
	const before = snapshot(data), mtime = statSync(records.eyes.archivePath).mtimeMs;
	const bad = Buffer.from(eyes.archive); bad[0] = bad[0]! ^ 1;
	expect(() => installComputerComponent(data, bad, "eyes", pins)).toThrow("Invalid computer archive");
	expect(installComputerComponent(data, eyes.archive, "eyes", pins)).toEqual(records.eyes);
	expect(verifyCachedComputerComponent(data, "eyes", pins)).toEqual(records.eyes);
	expect(discoverComputerComponents(data, pins)).toEqual(records);
	expect(snapshot(data)).toEqual(before);
	expect(statSync(records.eyes.archivePath).mtimeMs).toBe(mtime);
});

windows.each(["dll", "extra-file", "extra-dir", "archive", "hardlink"])("rejects %s without repairing or replacing an existing version", fault => {
	const data = root(), f = fixture(), hands = fixture("hands"), pins = [f.pin, hands.pin];
	const record = installComputerComponent(data, f.archive, "eyes", pins);
	installComputerComponent(data, hands.archive, "hands", pins);
	const version = dirname(record.archivePath), dll = join(version, "payload", "_internal", "python.dll");
	if (fault === "dll") writeFileSync(dll, "tampered");
	if (fault === "extra-file") writeFileSync(join(version, "receipt.json"), "{\"trusted\":true}");
	if (fault === "extra-dir") mkdirSync(join(version, "unexpected"));
	if (fault === "archive") writeFileSync(record.archivePath, "tampered");
	if (fault === "hardlink") linkSync(dll, join(root(), "dll-link"));
	const before = snapshot(data);
	expect(() => verifyCachedComputerComponent(data, "eyes", pins)).toThrow("Invalid computer component cache");
	expect(discoverComputerComponents(data, pins)).toBeUndefined();
	expect(() => installComputerComponent(data, f.archive, "eyes", pins)).toThrow("Invalid computer component cache");
	expect(snapshot(data)).toEqual(before);
});

windows("preserves old versions and refuses populated invalid promotion targets", () => {
	const data = root(), old = fixture(), next = fixture("eyes", "next"), blocked = fixture("eyes", "blocked");
	const prior = installComputerComponent(data, old.archive, "eyes", [old.pin]);
	const before = snapshot(dirname(prior.archivePath));
	installComputerComponent(data, next.archive, "eyes", [next.pin]);
	const target = versionPath(data, blocked.pin);
	mkdirSync(target); writeFileSync(join(target, "evidence"), "do not replace");
	expect(() => installComputerComponent(data, blocked.archive, "eyes", [blocked.pin])).toThrow("Invalid computer component cache");
	expect(readFileSync(join(target, "evidence"), "utf8")).toBe("do not replace");
	expect(snapshot(dirname(prior.archivePath))).toEqual(before);
	expect(verifyCachedComputerComponent(data, "eyes", [old.pin])).toEqual(prior);
});

windows("retains a fresh staging directory and archive after a native file-write failure", () => {
	const data = root(), f = fixture("eyes", "failure", "a".repeat(300));
	expect(() => installComputerComponent(data, f.archive, "eyes", [f.pin])).toThrow("Invalid computer component cache");
	expect(existsSync(versionPath(data, f.pin))).toBe(false);
	const parent = dirname(versionPath(data, f.pin)), names = readdirSync(parent);
	expect(names).toHaveLength(1);
	expect(names[0]).toMatch(/^\.staging-[a-f0-9]{32}$/);
	expect(readFileSync(join(parent, names[0]!, "archive.zip"))).toEqual(f.archive);
});

windows.each(["ancestor", "payload"])("rejects a real junction at %s without escaping", fault => {
	const data = root(), outside = root(), f = fixture();
	writeFileSync(join(outside, "sentinel"), "unchanged");
	if (fault === "ancestor") symlinkSync(outside, join(data, "components"), "junction");
	else {
		const target = versionPath(data, f.pin);
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "archive.zip"), f.archive);
		symlinkSync(outside, join(target, "payload"), "junction");
	}
	const before = snapshot(outside);
	expect(() => installComputerComponent(data, f.archive, "eyes", [f.pin])).toThrow("Invalid computer component cache");
	expect(() => verifyCachedComputerComponent(data, "eyes", [f.pin])).toThrow("Invalid computer component cache");
	expect(discoverComputerComponents(data, [f.pin])).toBeUndefined();
	expect(snapshot(outside)).toEqual(before);
});
