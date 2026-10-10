import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	archPackageFileName,
	builderImage,
	cacheVolumes,
	cargoCheckVolumes,
	checkImage,
	debFileName,
	fillPkgbuild,
	formatDuration,
	packageFileFor,
	parseCargoCheckArgs,
	parseCheckArgs,
	parsePackageArgs,
} from "../linux-lib.mjs";

const SHA = "a".repeat(64);

describe("parsePackageArgs", () => {
	it("builds the Arch package for amd64 only, unless --no-arch-package", () => {
		expect(parsePackageArgs(["--", "--arch", "amd64"])).toEqual({ arch: "amd64", archPackage: true });
		expect(parsePackageArgs(["--arch", "arm64"])).toEqual({ arch: "arm64", archPackage: false });
		expect(parsePackageArgs(["--arch", "amd64", "--no-arch-package", "--out", "/tmp/o"])).toEqual({
			arch: "amd64",
			out: "/tmp/o",
			archPackage: false,
		});
	});

	it("passes an Engram version through", () => {
		expect(parsePackageArgs(["--arch", "arm64", "--engram-version", "3.2.1"]).engramVersion).toBe("3.2.1");
	});

	it("refuses a missing or unknown architecture, unknown flags, and a flag without a value", () => {
		expect(() => parsePackageArgs([])).toThrow(/Missing --arch/);
		expect(() => parsePackageArgs(["--arch", "x86_64"])).toThrow(/Unknown architecture x86_64/);
		expect(() => parsePackageArgs(["--arch", "arm64", "--sign"])).toThrow(/Unexpected argument --sign/);
		expect(() => parsePackageArgs(["--arch", "--out", "/tmp/o"])).toThrow(/Unexpected argument --arch/);
		expect(() => parsePackageArgs(["--arch", "arm64", "--engram-version", "latest"])).toThrow(/x\.y\.z/);
	});
});

describe("parseCheckArgs", () => {
	it("checks every distribution an architecture supports by default", () => {
		expect(parseCheckArgs(["--arch", "amd64"]).distros).toEqual(["debian", "ubuntu", "arch"]);
		expect(parseCheckArgs(["--arch", "arm64"]).distros).toEqual(["debian", "ubuntu"]);
	});

	it("takes a comma-separated list and refuses Arch on arm64", () => {
		expect(parseCheckArgs(["--arch", "amd64", "--distro", "arch,debian"]).distros).toEqual([
			"arch",
			"debian",
		]);
		expect(() => parseCheckArgs(["--arch", "arm64", "--distro", "arch"])).toThrow(/only on amd64/);
		expect(() => parseCheckArgs(["--arch", "arm64", "--distro", "fedora"])).toThrow(
			/Unknown distribution fedora/,
		);
	});
});

describe("artifact names", () => {
	it("follow Debian and pacman conventions for each architecture", () => {
		expect(debFileName("0.1.0", "arm64")).toBe("gentle-dot_0.1.0_arm64.deb");
		expect(debFileName("0.1.0", "amd64")).toBe("gentle-dot_0.1.0_amd64.deb");
		expect(archPackageFileName("0.1.0", "amd64")).toBe("gentle-dot-0.1.0-1-x86_64.pkg.tar.zst");
		expect(archPackageFileName("0.2.0", "arm64", 3)).toBe("gentle-dot-0.2.0-3-aarch64.pkg.tar.zst");
	});

	it("pick the package each distribution installs", () => {
		expect(packageFileFor("ubuntu", "0.1.0", "arm64")).toBe("gentle-dot_0.1.0_arm64.deb");
		expect(packageFileFor("arch", "0.1.0", "amd64")).toBe("gentle-dot-0.1.0-1-x86_64.pkg.tar.zst");
	});

	it("name images and cache volumes per architecture", () => {
		expect(builderImage("amd64")).toBe("gentle-dot-linux-builder:amd64");
		const volumes = cacheVolumes("arm64");
		expect(volumes.map((volume) => volume.name)).toEqual([
			"gentle-dot-linux-arm64-cargo",
			"gentle-dot-linux-arm64-target",
			"gentle-dot-linux-arm64-cache",
			"gentle-dot-linux-arm64-pnpm",
		]);
		expect(volumes.every((volume) => volume.target.startsWith("/"))).toBe(true);
	});

	it("check the crate in an image and a target volume of their own, sharing the downloads", () => {
		expect(checkImage("arm64")).toBe("gentle-dot-linux-check:arm64");
		expect(cargoCheckVolumes("arm64")).toEqual([
			{ name: "gentle-dot-linux-arm64-cargo", target: "/usr/local/cargo/registry" },
			{ name: "gentle-dot-linux-arm64-pnpm", target: "/pnpm-store" },
			{ name: "gentle-dot-linux-arm64-check-target", target: "/work/apps/desktop/src-tauri/target" },
		]);
	});
});

describe("parseCargoCheckArgs", () => {
	it("takes an architecture and nothing else", () => {
		expect(parseCargoCheckArgs(["--", "--arch", "arm64"])).toEqual({ arch: "arm64" });
		expect(() => parseCargoCheckArgs([])).toThrow(/Missing --arch/);
		expect(() => parseCargoCheckArgs(["--arch", "riscv"])).toThrow(/Unknown architecture/);
		expect(() => parseCargoCheckArgs(["--arch", "arm64", "--distro", "debian"])).toThrow(
			/Unexpected argument/,
		);
	});
});

describe("fillPkgbuild", () => {
	const pkgbuild = readFileSync(new URL("../../../packaging/arch/PKGBUILD", import.meta.url), "utf8");

	it("fills in the version, release, and the checksum for the built architecture only", () => {
		const filled = fillPkgbuild(pkgbuild, { version: "0.2.0", arch: "amd64", sha256: SHA });
		expect(filled).toMatch(/^pkgver=0\.2\.0$/m);
		expect(filled).toMatch(/^pkgrel=1$/m);
		expect(filled).toMatch(new RegExp(`^sha256sums_x86_64=\\('${SHA}'\\)$`, "m"));
		expect(filled).toMatch(/^sha256sums_aarch64=\('SKIP'\)$/m);
		expect(filled).toMatch(/^source_x86_64=\("\$\{pkgname\}_\$\{pkgver\}_amd64\.deb"\)$/m);
	});

	it("names the .deb that debFileName produces", () => {
		const filled = fillPkgbuild(pkgbuild, { version: "0.1.0", arch: "amd64", sha256: SHA });
		const source = /^source_x86_64=\("\$\{pkgname\}_\$\{pkgver\}_(\w+)\.deb"\)$/m.exec(filled);
		expect(`gentle-dot_0.1.0_${source?.[1]}.deb`).toBe(debFileName("0.1.0", "amd64"));
	});

	it("refuses a bad checksum or a PKGBUILD without the fields", () => {
		expect(() => fillPkgbuild(pkgbuild, { version: "0.1.0", arch: "amd64", sha256: "abc" })).toThrow(
			/SHA-256/,
		);
		expect(() => fillPkgbuild("pkgname=x\n", { version: "0.1.0", arch: "amd64", sha256: SHA })).toThrow(
			/pkgver/,
		);
	});
});

describe("formatDuration", () => {
	it("prints seconds, then minutes and seconds", () => {
		expect(formatDuration(4_400)).toBe("4 s");
		expect(formatDuration(125_000)).toBe("2 min 5 s");
	});
});
