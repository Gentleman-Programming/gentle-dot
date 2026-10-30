// Windows packaging consumes an existing runtime; it never stages or installs one.
import hostPath from "node:path";

export const WINDOWS_USAGE =
	"usage: package-windows [--runtime <staged-dir>] [--help]\n" +
	"Native Windows x64 only; consumes build/runtime/windows-x64 by default. Builds NSIS; the installer adds WebView2 when missing (needs internet then).";
export const WINDOWS_FILES = Object.freeze([
	"MANIFEST.json",
	"node/bin/node.exe",
	"daemon/cli.mjs",
	"daemon/package.json",
	"daemon/native/windows-stop.node",
	"daemon/node_modules/gentle-pi/package.json",
	"bin/engram.exe",
	"bin/pi.cmd",
	"ui/index.html",
]);

export function parseWindowsArgs(argv) {
	const args = argv.filter((arg) => arg !== "--");
	if (args.length === 1 && args[0] === "--help") return { help: true };
	if (args.length === 0) return {};
	if (args.length === 2 && args[0] === "--runtime" && args[1] && !args[1].startsWith("--"))
		return { runtime: args[1] };
	throw new Error(WINDOWS_USAGE);
}

export function assertWindowsHost(platform, arch) {
	if (platform !== "win32" || arch !== "x64")
		throw new Error(
			`Packaging requires native Windows x64; got ${platform}-${arch}. No cross-build or implicit staging.`,
		);
}

/** Pure admission/argument plan. The CLI supplies filesystem predicates; tests execute no build. */
export function windowsPackagePlan({
	repo,
	runtime,
	platform,
	arch,
	node,
	manifest,
	isFile,
	isDirectory,
	path = hostPath,
}) {
	assertWindowsHost(platform, arch);
	const { resolve } = path;
	if (manifest?.name !== "gentle-dot-runtime" || manifest?.target !== "windows-x64")
		throw new Error("MANIFEST.json must describe a staged gentle-dot-runtime for windows-x64.");
	const desktop = resolve(repo, "apps/desktop");
	const cli = resolve(desktop, "node_modules/@tauri-apps/cli/tauri.js");
	const icon = resolve(desktop, "src-tauri/icons/icon.ico");
	for (const file of WINDOWS_FILES) {
		if (!isFile(resolve(runtime, file)))
			throw new Error(`Missing staged artifact ${file} in ${runtime}. Stage explicitly before packaging.`);
	}
	if (!isDirectory(resolve(runtime, "daemon/node_modules/gentle-pi/.gentle-ai")))
		throw new Error("Missing staged gentle-pi/.gentle-ai agent. Stage explicitly before packaging.");
	for (const file of [cli, icon])
		if (!isFile(file))
			throw new Error(`Missing packaging prerequisite ${file}; provision it explicitly before packaging.`);
	// Tauri resolves directories from src-tauri, not the CLI cwd. Absolute drive
	// paths deserialize as URLs (e.g. c:), whose relative page joins can panic.
	const configDir = resolve(desktop, "src-tauri");
	const frontendDir = resolve(runtime, "ui");
	const frontend = path.relative(configDir, frontendDir);
	// win32.relative can traverse between shares on one server, but Windows
	// cannot traverse above a share root. Compare roots as well as absoluteness.
	const differentWindowsRoots =
		path.sep === "\\" &&
		path.parse(configDir).root.toLowerCase() !== path.parse(frontendDir).root.toLowerCase();
	if (differentWindowsRoots || path.isAbsolute(frontend))
		throw new Error(
			"frontendDist must be relative to src-tauri; place the staged runtime on the same volume/share as the checkout.",
		);
	const config = {
		build: { beforeBuildCommand: "", frontendDist: `./${frontend.split(path.sep).join("/")}` },
		bundle: {
			resources: { [runtime]: "runtime" },
			icon: ["icons/icon.ico"],
			// WebView2 comes with Windows 11 and most Windows 10; where it is missing, the installer
			// runs Microsoft's embedded bootstrapper (about 1.8 MB, downloaded once at build time),
			// which installs it from the internet.
			windows: { webviewInstallMode: { type: "embedBootstrapper", silent: true } },
		},
	};
	return {
		program: node,
		args: [cli, "build", "--bundles", "nsis", "--config", JSON.stringify(config)],
		cwd: desktop,
		env: { GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED: "1" },
	};
}
