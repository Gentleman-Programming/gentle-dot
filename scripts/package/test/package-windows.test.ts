import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	gentleAiProvenance,
	isGentleAiBinary,
	parseWindowsArgs,
	payloadDifferences,
	RUNTIME_HASH_SAMPLE,
	sevenZipCandidates,
	WINDOWS_USAGE,
	windowsInstallerNames,
	windowsReleaseConfig,
} from "../lib.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

describe("parseWindowsArgs", () => {
	it("defaults to staging and no payload check", () => {
		expect(parseWindowsArgs([])).toEqual({ skipStage: false, check: false });
	});

	it("reads --skip-stage and --check, ignores a bare --, and refuses anything else", () => {
		expect(parseWindowsArgs(["--", "--skip-stage", "--check"])).toEqual({ skipStage: true, check: true });
		expect(() => parseWindowsArgs(["--sign", "x"])).toThrow(WINDOWS_USAGE);
	});
});

describe("windowsReleaseConfig", () => {
	it("carries the staged runtime as the app's runtime resource, the way macOS does", () => {
		expect(windowsReleaseConfig({ runtime: "D:\\build\\runtime\\win-x64" })).toEqual({
			bundle: { resources: { "D:\\build\\runtime\\win-x64": "runtime" } },
		});
	});

	it("sets no macOS key: there is no signing identity on Windows", () => {
		const config = windowsReleaseConfig({ runtime: "/build/runtime/win-x64" });
		expect(JSON.stringify(config)).not.toContain("signingIdentity");
		expect(config.bundle).not.toHaveProperty("macOS");
	});

	it("adds no description key, because the Windows bundlers emit none", () => {
		// Measured on the built bundles, not assumed: the MSI carries no Comments/ARPCOMMENTS
		// property and the NSIS version-info block derives every key from PRODUCTNAME, so a
		// longDescription here would be config with no output.
		expect(windowsReleaseConfig({ runtime: "/r" }).bundle).not.toHaveProperty("longDescription");
	});

	it("refuses a config without a runtime", () => {
		expect(() => windowsReleaseConfig({})).toThrow(/runtime/);
	});
});

describe("windowsInstallerNames", () => {
	it("names the NSIS and MSI files the way Tauri's bundler does", () => {
		// Measured on this host: W8's bundles are exactly these two names at 0.1.0.
		expect(windowsInstallerNames("Gentle Dot", "0.1.0")).toEqual({
			nsis: "Gentle Dot_0.1.0_x64-setup.exe",
			msi: "Gentle Dot_0.1.0_x64_en-US.msi",
		});
	});
});

describe("payloadDifferences", () => {
	const staged = ["MANIFEST.json", "bin/pi.cmd", "daemon/cli.mjs"];

	it("reports nothing when the payload holds exactly the staged runtime", () => {
		expect(payloadDifferences(staged, staged)).toEqual({ missing: [], extra: [] });
	});

	it("ignores path separators and case, because Windows does", () => {
		expect(payloadDifferences(staged, ["MANIFEST.JSON", "bin\\pi.cmd", "daemon\\cli.mjs"])).toEqual({
			missing: [],
			extra: [],
		});
	});

	it("names what the payload dropped and what it added", () => {
		const differences = payloadDifferences(staged, ["MANIFEST.json", "bin/pi.cmd", "uninstall.exe"]);
		expect(differences.missing).toEqual(["daemon/cli.mjs"]);
		expect(differences.extra).toEqual(["uninstall.exe"]);
	});
});

describe("the payload hash sample", () => {
	it("pins the files whose bytes prove the runtime crossed the installer", () => {
		expect(RUNTIME_HASH_SAMPLE).toContain("MANIFEST.json");
		expect(RUNTIME_HASH_SAMPLE).toContain("node/node.exe");
		expect(RUNTIME_HASH_SAMPLE).toContain("bin/pi.cmd");
		expect(RUNTIME_HASH_SAMPLE).toContain("bin/engram.exe");
		expect(RUNTIME_HASH_SAMPLE).toContain("daemon/cli.mjs");
	});

	it("finds the engine binary wherever the build nests it, without pinning its version", () => {
		expect(isGentleAiBinary("daemon/node_modules/gentle-pi/.gentle-ai/v4.0.0/gentle-ai.exe")).toBe(true);
		expect(isGentleAiBinary("daemon/node_modules/gentle-pi/.gentle-ai/v9.9.9/gentle-ai.exe")).toBe(true);
		expect(isGentleAiBinary("daemon/node_modules/gentle-pi/.gentle-ai/v4.0.0/integrity.json")).toBe(false);
		expect(isGentleAiBinary("bin/engram.exe")).toBe(false);
	});
});

describe("sevenZipCandidates", () => {
	it("tries SEVEN_ZIP, then both Program Files, then PATH", () => {
		const candidates = sevenZipCandidates({
			SEVEN_ZIP: "D:\\tools\\7z.exe",
			ProgramFiles: "C:\\Program Files",
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
		});
		expect(candidates[0]).toBe("D:\\tools\\7z.exe");
		expect(candidates).toContain(join("C:\\Program Files", "7-Zip", "7z.exe"));
		expect(candidates).toContain(join("C:\\Program Files (x86)", "7-Zip", "7z.exe"));
		expect(candidates.slice(-2)).toEqual(["7z", "7za"]);
	});

	it("keeps a bare 7z as the last resort when the environment names nothing", () => {
		expect(sevenZipCandidates({})).toEqual(["7z", "7za"]);
	});
});

describe("gentleAiProvenance", () => {
	it("keeps the signed-release wording the other platforms already print", () => {
		expect(gentleAiProvenance({ asset: "gentle-ai_4.0.0_darwin_arm64.tar.gz", assetSha256: "abc123" })).toBe(
			"from gentle-ai_4.0.0_darwin_arm64.tar.gz (sha256 abc123)",
		);
	});

	it("names the Go source build on Windows, which records binarySha256 instead", () => {
		// L54's advisory: the staged Windows integrity.json has no asset/assetSha256 pair,
		// so staging used to print `from undefined (sha256 undefined)`.
		const line = gentleAiProvenance({
			method: "go-sumdb-source-build",
			binarySha256: "d736cf22f120ca31549fc47d0455436d273a9c07417757e394cad53a9356208f",
			goVersion: "go1.27.0",
			buildMode: "exe",
		});
		expect(line).toContain("go-sumdb-source-build");
		expect(line).toContain("go1.27.0");
		expect(line).toContain("d736cf22f120");
		expect(line).not.toContain("undefined");
	});
});

describe("package:windows", () => {
	it("is wired to the packaging script", () => {
		const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
		expect(pkg.scripts["package:windows"]).toBe("node scripts/package/package-windows.mjs");
	});
});
