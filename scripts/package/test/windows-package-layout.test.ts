import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	gentleAiProvenance,
	isGentleAiBinary,
	parseWindowsArgs,
	payloadDifferences,
	RUNTIME_HASH_SAMPLE,
	sevenZipCandidates,
	windowsInstallerNames,
	windowsReleaseConfig,
} from "../lib.mjs";

describe("retained public Windows package helpers", () => {
	it("preserves legacy helper arguments without making them the new CLI", () => {
		expect(parseWindowsArgs([])).toEqual({ skipStage: false, check: false });
		expect(parseWindowsArgs(["--", "--skip-stage", "--check"])).toEqual({ skipStage: true, check: true });
		expect(() => parseWindowsArgs(["--sign", "x"])).toThrow(/usage/);
		const runtime = "D:\\build\\runtime\\windows-x64";
		expect(windowsReleaseConfig({ runtime })).toEqual({ bundle: { resources: { [runtime]: "runtime" } } });
		expect(() => windowsReleaseConfig({ runtime: undefined })).toThrow(/runtime/);
		expect(windowsInstallerNames("Gentle Dot", "0.1.0")).toEqual({
			nsis: "Gentle Dot_0.1.0_x64-setup.exe",
			msi: "Gentle Dot_0.1.0_x64_en-US.msi",
		});
	});
	it("retains payload comparison behavior with canonical Node and mandatory addon hash samples", () => {
		const staged = ["MANIFEST.json", "bin/pi.cmd", "daemon/cli.mjs"];
		expect(payloadDifferences(staged, ["MANIFEST.JSON", "bin\\pi.cmd", "daemon\\cli.mjs"])).toEqual({
			missing: [],
			extra: [],
		});
		expect(payloadDifferences(staged, ["MANIFEST.json", "bin/pi.cmd", "extra"])).toEqual({
			missing: ["daemon/cli.mjs"],
			extra: ["extra"],
		});
		for (const path of [
			"MANIFEST.json",
			"node/bin/node.exe",
			"daemon/native/windows-stop.node",
			"bin/pi.cmd",
			"bin/engram.exe",
			"daemon/cli.mjs",
		])
			expect(RUNTIME_HASH_SAMPLE).toContain(path);
		expect(RUNTIME_HASH_SAMPLE).not.toContain("node/node.exe");
		for (const version of ["4.0.0", "4.3.0", "9.9.9"])
			expect(isGentleAiBinary(`daemon/node_modules/gentle-pi/.gentle-ai/v${version}/gentle-ai.exe`)).toBe(
				true,
			);
		expect(isGentleAiBinary("bin/engram.exe")).toBe(false);
		expect(isGentleAiBinary(".gentle-ai/v4.3.0/integrity.json")).toBe(false);
	});
	it("retains release/source integrity wording and extractor candidate order", () => {
		expect(gentleAiProvenance({ asset: "unix.tar.gz", assetSha256: "abc" })).toBe(
			"from unix.tar.gz (sha256 abc)",
		);
		const source = gentleAiProvenance({
			method: "go-sumdb-source-build",
			goVersion: "go1.27.0",
			binarySha256: "123456789012abc",
		});
		expect(source).toBe("go-sumdb-source-build (go1.27.0, binary sha256 123456789012…)");
		expect(sevenZipCandidates({})).toEqual(["7z", "7za"]);
		expect(
			sevenZipCandidates({
				SEVEN_ZIP: "explicit",
				ProgramFiles: "programs",
				"ProgramFiles(x86)": "programs86",
			}),
		).toEqual([
			"explicit",
			join("programs", "7-Zip", "7z.exe"),
			join("programs86", "7-Zip", "7z.exe"),
			"7z",
			"7za",
		]);
	});
});
