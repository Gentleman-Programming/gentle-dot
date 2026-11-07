import { resolve, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWindowsArgs, WINDOWS_FILES, windowsPackagePlan } from "../windows-lib.mjs";

const manifest = { name: "gentle-dot-runtime", target: "windows-x64" };
const options = {
	repo: resolve("checkout with spaces"),
	runtime: resolve("staged runtime"),
	platform: "win32",
	arch: "x64",
	node: "C:\\Program Files\\nodejs\\node.exe",
	manifest,
	isFile: () => true,
	isDirectory: () => true,
};

describe("Windows package admission and plan (no commands executed)", () => {
	it("parses both restored switches and the existing runtime override/help", () => {
		expect(parseWindowsArgs([])).toEqual({});
		expect(parseWindowsArgs(["--", "--runtime", "C:\\staged runtime"])).toEqual({
			runtime: "C:\\staged runtime",
		});
		expect(parseWindowsArgs(["--help"])).toEqual({ help: true });
		expect(parseWindowsArgs(["--skip-stage", "--check"])).toEqual({ skipStage: true, check: true });
		expect(parseWindowsArgs(["--runtime", "selected", "--check"])).toEqual({
			runtime: "selected",
			check: true,
		});
		for (const args of [
			["--runtime"],
			["--runtime", ""],
			["--stage"],
			["--bundles", "msi"],
			["--runtime", "a", "--runtime", "b"],
		])
			expect(() => parseWindowsArgs(args)).toThrow();
	});
	it("rejects unsupported hosts before reading artifacts", () => {
		for (const [platform, arch] of [
			["linux", "x64"],
			["win32", "arm64"],
			["darwin", "arm64"],
		])
			expect(() =>
				windowsPackagePlan({
					...options,
					platform,
					arch,
					isFile: () => {
						throw Error("artifact read");
					},
				}),
			).toThrow(/native Windows x64/);
	});
	it("rejects wrong manifests and every missing prerequisite, including mandatory native addon", () => {
		for (const value of [undefined, {}, { ...manifest, target: "win-x64" }, { ...manifest, name: "other" }])
			expect(() => windowsPackagePlan({ ...options, manifest: value })).toThrow(/MANIFEST/);
		for (const file of WINDOWS_FILES)
			expect(() =>
				windowsPackagePlan({ ...options, isFile: (path: string) => path !== resolve(options.runtime, file) }),
			).toThrow(file);
		for (const file of ["tauri.js", "icon.ico"])
			expect(() =>
				windowsPackagePlan({ ...options, isFile: (path: string) => !path.endsWith(file) }),
			).toThrow(file);
		expect(() => windowsPackagePlan({ ...options, isDirectory: () => false })).toThrow(/gentle-ai/);
	});
	it("keeps the explicit-runtime plan in JSON using local Node CLI without staging or installing", () => {
		const plan = windowsPackagePlan(options);
		expect(plan.program).toBe(options.node);
		expect(plan.cwd).toBe(resolve(options.repo, "apps/desktop"));
		expect(plan.args.slice(1, 4)).toEqual(["build", "--bundles", "nsis"]);
		expect(plan.env).toEqual({ GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED: "1" });
		const config = JSON.parse(plan.args[5]);
		expect(config.bundle.resources).toEqual({ [options.runtime]: "runtime" });
		expect(config.build.beforeBuildCommand).toBe("");
		expect(config.build.frontendDist).toMatch(/^\.\//);
		expect(resolve(options.repo, "apps/desktop/src-tauri", config.build.frontendDist)).toBe(
			resolve(options.runtime, "ui"),
		);
		expect(config.bundle.windows.webviewInstallMode).toEqual({ type: "embedBootstrapper", silent: true });
		expect(plan.args.join(" ")).not.toMatch(/\.cmd|stage-runtime|install|download/);
		const runtime = 'C:\\staged runtime\\quoted "folder"';
		expect(
			JSON.parse(windowsPackagePlan({ ...options, repo: "C:\\checkout", runtime, path: win32 }).args[5])
				.bundle.resources,
		).toEqual({ [runtime]: "runtime" });
	});
	it("reproduces the cannot-be-base absolute Windows URL failure", () => {
		const absolute = new URL(win32.resolve("C:\\staged runtime", "ui"));
		expect(absolute.protocol).toBe("c:");
		expect(() => new URL("index.html?surface=panel&effects=none", absolute)).toThrow();
	});
	it("uses src-tauri-relative paths rather than desktop cwd, including spaces and scheme-like names", () => {
		const repo = "C:\\workspace\\checkout with spaces",
			runtime = "C:\\workspace\\staged runtime";
		const plan = windowsPackagePlan({ ...options, repo, runtime, path: win32 });
		const config = JSON.parse(plan.args[5]);
		expect(config.build.frontendDist).toBe("./../../../../staged runtime/ui");
		expect(win32.resolve(repo, "apps/desktop/src-tauri", config.build.frontendDist)).toBe(
			win32.resolve(runtime, "ui"),
		);
		expect(win32.resolve(plan.cwd, config.build.frontendDist)).not.toBe(win32.resolve(runtime, "ui"));
		const scheme = resolve(options.repo, "apps/desktop/src-tauri/c:assets");
		expect(JSON.parse(windowsPackagePlan({ ...options, runtime: scheme }).args[5]).build.frontendDist).toBe(
			"./c:assets/ui",
		);
	});
	it("accepts same-share UNC and case-insensitive roots", () => {
		for (const [repo, runtime] of [
			["\\\\server\\share\\checkout", "\\\\server\\share\\staged runtime"],
			["C:\\checkout", "c:\\staged runtime"],
		]) {
			const config = JSON.parse(windowsPackagePlan({ ...options, repo, runtime, path: win32 }).args[5]);
			expect(config.build.frontendDist).toMatch(/^\.\//);
			expect(win32.resolve(repo, "apps/desktop/src-tauri", config.build.frontendDist).toLowerCase()).toBe(
				win32.resolve(runtime, "ui").toLowerCase(),
			);
		}
	});
	it("rejects cross-volume and cross-share frontend paths", () => {
		for (const [repo, runtime] of [
			["C:\\checkout", "D:\\staged runtime"],
			["\\\\server\\checkout\\repo", "\\\\server\\runtime\\staged"],
		])
			expect(() => windowsPackagePlan({ ...options, repo, runtime, path: win32 })).toThrow(
				/frontendDist.*relative.*src-tauri/i,
			);
	});
});
