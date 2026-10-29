import { readFileSync } from "node:fs";
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
	it("parses only the existing runtime override and help", () => {
		expect(parseWindowsArgs([])).toEqual({});
		expect(parseWindowsArgs(["--", "--runtime", "C:\\staged runtime"])).toEqual({
			runtime: "C:\\staged runtime",
		});
		expect(parseWindowsArgs(["--help"])).toEqual({ help: true });
		for (const args of [["--runtime"], ["--runtime", ""], ["--stage"], ["--bundles", "msi"]])
			expect(() => parseWindowsArgs(args)).toThrow();
	});
	it("rejects unsupported hosts and architectures before reading artifacts", () => {
		for (const [platform, arch] of [
			["linux", "x64"],
			["win32", "arm64"],
			["darwin", "arm64"],
		]) {
			expect(() =>
				windowsPackagePlan({
					...options,
					platform,
					arch,
					isFile: () => {
						throw new Error("artifact read");
					},
				}),
			).toThrow(/native Windows x64/);
		}
	});
	it("rejects wrong or absent manifest and every missing prerequisite", () => {
		for (const value of [undefined, {}, { ...manifest, target: "linux-x64" }, { ...manifest, name: "other" }])
			expect(() => windowsPackagePlan({ ...options, manifest: value })).toThrow(/MANIFEST/);
		for (const file of WINDOWS_FILES)
			expect(() =>
				windowsPackagePlan({ ...options, isFile: (path: string) => path !== resolve(options.runtime, file) }),
			).toThrow(file);
		expect(() =>
			windowsPackagePlan({ ...options, isFile: (path: string) => !path.endsWith("tauri.js") }),
		).toThrow(/tauri.js/);
		expect(() =>
			windowsPackagePlan({ ...options, isFile: (path: string) => !path.endsWith("icon.ico") }),
		).toThrow(/icon.ico/);
		expect(() => windowsPackagePlan({ ...options, isDirectory: () => false })).toThrow(/gentle-ai/);
	});
	it("keeps resource paths as JSON arguments, uses local CLI through Node, and never stages or installs", () => {
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
		// The installer brings WebView2 only when the machine lacks it, through the embedded bootstrapper.
		expect(config.bundle.windows.webviewInstallMode).toEqual({ type: "embedBootstrapper", silent: true });
		expect(plan.args.join(" ")).not.toMatch(/\.cmd|stage-runtime|install|download/);
		const windowsPath = 'C:\\staged runtime\\quoted "folder"';
		const quoted = windowsPackagePlan({
			...options,
			repo: "C:\\checkout",
			runtime: windowsPath,
			path: win32,
		});
		expect(JSON.parse(quoted.args[5]).bundle.resources).toEqual({ [windowsPath]: "runtime" });
	});
	it("reproduces the cannot-be-base URL failure of an absolute Windows frontend path", () => {
		const absolute = new URL(win32.resolve("C:\\staged runtime", "ui"));
		expect(absolute.protocol).toBe("c:");
		expect(() => new URL("index.html?surface=panel&effects=none", absolute)).toThrow();
	});
	it("uses a directory relative to src-tauri, not the desktop cwd, on Windows with spaces", () => {
		const repo = "C:\\workspace\\checkout with spaces";
		const runtime = "C:\\workspace\\staged runtime";
		const plan = windowsPackagePlan({ ...options, repo, runtime, path: win32 });
		const config = JSON.parse(plan.args[5]);
		expect(plan.cwd).toBe(win32.resolve(repo, "apps/desktop"));
		expect(config.build.frontendDist).toBe("./../../../../staged runtime/ui");
		expect(win32.resolve(repo, "apps/desktop/src-tauri", config.build.frontendDist)).toBe(
			win32.resolve(runtime, "ui"),
		);
		expect(win32.resolve(plan.cwd, config.build.frontendDist)).not.toBe(win32.resolve(runtime, "ui"));
		expect(() => new URL(config.build.frontendDist)).toThrow();
		expect(config.bundle.resources).toEqual({ [runtime]: "runtime" });
	});
	it("prefixes a relative directory whose first component could otherwise be a URL scheme", () => {
		const runtime = resolve(options.repo, "apps/desktop/src-tauri/c:assets");
		const config = JSON.parse(windowsPackagePlan({ ...options, runtime }).args[5]);
		expect(config.build.frontendDist).toBe("./c:assets/ui");
		expect(() => new URL(config.build.frontendDist)).toThrow();
	});
	it("accepts same-share UNC paths and case-insensitive drive roots", () => {
		for (const [repo, runtime] of [
			["\\\\server\\share\\checkout", "\\\\server\\share\\staged runtime"],
			["C:\\checkout", "c:\\staged runtime"],
		]) {
			const plan = windowsPackagePlan({ ...options, repo, runtime, path: win32 });
			const frontend = JSON.parse(plan.args[5]).build.frontendDist;
			expect(frontend).toMatch(/^\.\//);
			expect(win32.resolve(repo, "apps/desktop/src-tauri", frontend).toLowerCase()).toBe(
				win32.resolve(runtime, "ui").toLowerCase(),
			);
		}
	});
	it("rejects cross-volume and cross-share frontend paths before a build can be planned", () => {
		for (const [repo, runtime] of [
			["C:\\checkout", "D:\\staged runtime"],
			["\\\\server\\checkout\\repo", "\\\\server\\runtime\\staged"],
		]) {
			expect(() => windowsPackagePlan({ ...options, repo, runtime, path: win32 })).toThrow(
				/frontendDist.*relative.*src-tauri/i,
			);
		}
	});
});

it("wires package-only marker to fallible admission before launch without changing launch_spec", () => {
	const build = readFileSync("apps/desktop/src-tauri/build.rs", "utf8");
	const daemon = readFileSync("apps/desktop/src-tauri/src/daemon.rs", "utf8");
	const launch = readFileSync("apps/desktop/src-tauri/src/daemon/launch.rs", "utf8");
	expect(build).toContain("cargo:rerun-if-env-changed=GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED");
	expect(build).toContain("cargo:rustc-env=GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED=");
	expect(build).toContain('env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")');
	expect(daemon).toContain("cfg!(windows) && !cfg!(debug_assertions)");
	expect(daemon).toContain('option_env!("GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED") == Some("1")');
	expect(daemon).toMatch(/validate_packaged_runtime\([\s\S]*?\)\?;\s*launch_spec\(/);
	expect(launch).toContain("pub fn validate_packaged_runtime(");
	expect(launch).toContain("pub fn launch_spec(");
});
