import { describe, expect, it } from "vitest";
import {
	AD_HOC,
	dmgFileName,
	insideOut,
	isMachO,
	keepsOwnSignature,
	modeDifferences,
	parseMacArgs,
	tauriReleaseConfig,
} from "../lib.mjs";

describe("parseMacArgs", () => {
	it("signs ad hoc unless an identity is given, and the flag wins over the environment", () => {
		expect(parseMacArgs([], {})).toEqual({
			skipStage: false,
			check: false,
			finderLayout: false,
			identity: AD_HOC,
		});
		expect(parseMacArgs([], { GENTLE_DOT_SIGN_IDENTITY: "Gentle Dot Local" }).identity).toBe(
			"Gentle Dot Local",
		);
		expect(parseMacArgs([], { GENTLE_DOT_SIGN_IDENTITY: "" }).identity).toBe(AD_HOC);
		expect(
			parseMacArgs(["--", "--sign", "Gentle Dot Local"], { GENTLE_DOT_SIGN_IDENTITY: "Other" }).identity,
		).toBe("Gentle Dot Local");
	});

	it("reads the switches and the DMG to check", () => {
		expect(
			parseMacArgs(["--skip-stage", "--check", "--finder-layout", "--check-dmg", "/tmp/a.dmg"], {}),
		).toEqual({
			skipStage: true,
			check: true,
			finderLayout: true,
			checkDmg: "/tmp/a.dmg",
			identity: AD_HOC,
		});
	});

	it("refuses unknown flags and a value-taking flag without its value", () => {
		expect(() => parseMacArgs(["--notarize"], {})).toThrow(/Unexpected argument --notarize/);
		expect(() => parseMacArgs(["--sign"], {})).toThrow(/Unexpected argument --sign/);
		expect(() => parseMacArgs(["--sign", "--check"], {})).toThrow(/Unexpected argument --sign/);
		expect(() => parseMacArgs(["--sign", ""], {})).toThrow(/Unexpected argument --sign/);
	});
});

describe("isMachO", () => {
	const header = (...words: number[]) => {
		const bytes = Buffer.alloc(words.length * 4);
		words.forEach((word, i) => {
			bytes.writeUInt32BE(word, i * 4);
		});
		return bytes;
	};

	it("recognizes thin 64- and 32-bit headers and universal binaries", () => {
		expect(isMachO(header(0xcffaedfe, 0x0c000001))).toBe(true);
		expect(isMachO(header(0xcefaedfe, 0x07000000))).toBe(true);
		expect(isMachO(header(0xcafebabe, 2))).toBe(true);
	});

	it("rejects scripts, Java class files, and short files", () => {
		expect(isMachO(Buffer.from("#!/bin/sh\nexec node\n"))).toBe(false);
		expect(isMachO(header(0xcafebabe, 52))).toBe(false);
		expect(isMachO(Buffer.from([0xcf, 0xfa, 0xed]))).toBe(false);
	});
});

describe("signing plan", () => {
	it("keeps the pinned Gentle AI binary's own signature and only that", () => {
		expect(keepsOwnSignature("daemon/node_modules/gentle-pi/.gentle-ai/v4.0.0/gentle-ai")).toBe(true);
		expect(keepsOwnSignature("node/bin/node")).toBe(false);
		expect(keepsOwnSignature("bin/engram")).toBe(false);
		expect(keepsOwnSignature("daemon/node_modules/esbuild/bin/esbuild")).toBe(false);
	});

	it("signs the deepest paths first", () => {
		expect(insideOut(["node/bin/node", "bin/engram", "daemon/node_modules/a/b/c.node"])).toEqual([
			"daemon/node_modules/a/b/c.node",
			"node/bin/node",
			"bin/engram",
		]);
	});

	it("maps the staged runtime to the app's runtime resource with the identity", () => {
		expect(tauriReleaseConfig({ runtime: "/repo/build/runtime/darwin-arm64", identity: "-" })).toEqual({
			bundle: {
				resources: { "/repo/build/runtime/darwin-arm64": "runtime" },
				macOS: { signingIdentity: "-" },
			},
		});
	});

	it("names the DMG the way Tauri does", () => {
		expect(dmgFileName("Gentle Dot", "0.1.0", "arm64")).toBe("Gentle Dot_0.1.0_aarch64.dmg");
		expect(() => dmgFileName("Gentle Dot", "0.1.0", "ia32")).toThrow(/ia32/);
	});
});

describe("modeDifferences", () => {
	it("reports changed permission bits and missing files, ignoring the file type bits", () => {
		const staged = new Map([
			["node/bin/node", 0o100755],
			["daemon/cli.mjs", 0o100644],
			["bin/engram", 0o100755],
		]);
		const bundled = new Map([
			["node/bin/node", 0o755],
			["daemon/cli.mjs", 0o100755],
		]);
		expect(modeDifferences(staged, bundled)).toEqual(["daemon/cli.mjs (644 → 755)", "bin/engram (missing)"]);
	});
});
