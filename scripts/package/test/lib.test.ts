import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertHostTarget,
	buildManifest,
	checksumFor,
	engramArchiveName,
	engramReleaseVersion,
	hostTarget,
	nodeArchiveName,
	nodeVersion,
	parseArgs,
	symlinksIn,
	treeSize,
	verifyChecksum,
	versionFromReleaseUrl,
} from "../lib.mjs";

describe("parseArgs", () => {
	it("reads the target, the output folder, and an Engram version, ignoring pnpm's --", () => {
		expect(
			parseArgs(["--", "--target", "linux-x64", "--out", "/tmp/r", "--engram-version", "3.2.1"]),
		).toEqual({ target: "linux-x64", out: "/tmp/r", engramVersion: "3.2.1" });
	});

	it("refuses a missing or unknown target, unknown flags, and a flag without a value", () => {
		expect(() => parseArgs(["--out", "/tmp/r"])).toThrow(/Missing --target/);
		expect(() => parseArgs(["--target", "windows-x64"])).toThrow(/Unknown target windows-x64/);
		expect(() => parseArgs(["--target", "linux-x64", "--force", "1"])).toThrow(/Unexpected argument --force/);
		expect(() => parseArgs(["--target", "--out", "/tmp/r"])).toThrow(/Unexpected argument --target/);
		expect(() => parseArgs(["--target", "linux-x64", "--engram-version", "latest"])).toThrow(/x\.y\.z/);
	});
});

describe("host target", () => {
	it("maps Node's platform and arch to a target", () => {
		expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
		expect(hostTarget("linux", "x64")).toBe("linux-x64");
		expect(hostTarget("darwin", "x64")).toBeUndefined();
	});

	it("refuses to stage another platform's runtime, naming the way out", () => {
		expect(() => assertHostTarget("darwin-arm64", "darwin-arm64")).not.toThrow();
		expect(() => assertHostTarget("linux-arm64", "darwin-arm64")).toThrow(
			/Cannot stage linux-arm64 on darwin-arm64.*inside a container/,
		);
	});
});

describe("versions and asset names", () => {
	it("uses an exact .nvmrc, else the pinned release of the same major", () => {
		expect(nodeVersion("24.9.0\n")).toBe("24.9.0");
		expect(nodeVersion("v24", "24.14.1")).toBe("24.14.1");
		expect(() => nodeVersion("22", "24.14.1")).toThrow(/Node 22/);
	});

	it("names the official archives", () => {
		expect(nodeArchiveName("24.14.1", "linux-x64")).toBe("node-v24.14.1-linux-x64.tar.gz");
		expect(engramArchiveName("3.2.1", "linux-x64")).toBe("engram_3.2.1_linux_amd64.tar.gz");
		expect(engramArchiveName("3.2.1", "darwin-arm64")).toBe("engram_3.2.1_darwin_arm64.tar.gz");
	});

	it("takes a release version from `engram version`, not a development build", () => {
		expect(engramReleaseVersion("engram 3.2.1\n")).toBe("3.2.1");
		expect(engramReleaseVersion("engram v3.1.0")).toBe("3.1.0");
		expect(engramReleaseVersion("engram 3.0.0-20261007205017-8e525e767d69")).toBeUndefined();
		expect(engramReleaseVersion("")).toBeUndefined();
	});

	it("reads the version of a release URL", () => {
		expect(versionFromReleaseUrl("https://github.com/o/engram/releases/tag/v3.2.1")).toBe("3.2.1");
		expect(() => versionFromReleaseUrl("https://github.com/o/engram/releases")).toThrow(/Not a release URL/);
	});
});

describe("checksums", () => {
	const hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
	const listing = `${"a".repeat(64)}  node-v24.14.1-linux-x64.tar.gz\n${hello}  hello.txt\n${"b".repeat(64)} *bin.zip\n`;

	it("finds a file's entry in SHASUMS256 / checksums.txt listings", () => {
		expect(checksumFor(listing, "hello.txt")).toBe(hello);
		expect(checksumFor(listing, "bin.zip")).toBe("b".repeat(64));
		expect(() => checksumFor(listing, "node-v24.14.1-linux-x64.tar")).toThrow(/no entry/);
	});

	it("accepts a matching file and rejects a tampered one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "stage-runtime-"));
		const file = join(dir, "hello.txt");
		writeFileSync(file, "hello");
		await expect(verifyChecksum(file, hello)).resolves.toBeUndefined();
		writeFileSync(file, "hellO");
		await expect(verifyChecksum(file, hello)).rejects.toThrow(/Checksum mismatch/);
	});
});

describe("tree and manifest", () => {
	it("sizes a tree without following links, and lists the links", () => {
		const dir = mkdtempSync(join(tmpdir(), "stage-runtime-"));
		writeFileSync(join(dir, "a"), "12345");
		symlinkSync("a", join(dir, "link"));
		expect(treeSize(dir)).toBe(5 + 1);
		expect(symlinksIn(dir)).toEqual(["link"]);
	});

	it("records the versions, the commit, and the size", () => {
		const manifest = buildManifest({
			target: "darwin-arm64",
			versions: { node: "24.14.1", engram: "3.2.1", gentlePi: "4.0.0" },
			daemonCommit: "abc123",
			sizeBytes: 3 * 1024 * 1024,
			stagedAt: "2026-10-09T00:00:00.000Z",
		});
		expect(manifest).toMatchObject({ name: "gentle-dot-runtime", size: "3.0 MB", daemonCommit: "abc123" });
		expect(() =>
			buildManifest({
				target: "darwin-arm64",
				versions: { node: "24.14.1" },
				daemonCommit: "x",
				sizeBytes: 0,
			}),
		).toThrow(/engram/);
	});
});
