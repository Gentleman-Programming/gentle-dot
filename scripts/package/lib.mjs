// Pure helpers for staging the installed app's runtime (`stage-runtime.mjs`).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join, posix, win32 } from "node:path";

/**
 * The targets a runtime can be staged for, with the names Node's and Engram's
 * release assets use for each.
 */
export const TARGETS = Object.freeze({
	"darwin-arm64": { platform: "darwin", arch: "arm64", node: "darwin-arm64", engram: "darwin_arm64" },
	"linux-arm64": { platform: "linux", arch: "arm64", node: "linux-arm64", engram: "linux_arm64" },
	"linux-x64": { platform: "linux", arch: "x64", node: "linux-x64", engram: "linux_amd64" },
	"win-x64": { platform: "win32", arch: "x64", node: "win-x64", engram: "windows_amd64" },
	"win-arm64": { platform: "win32", arch: "arm64", node: "win-arm64", engram: "windows_arm64" },
});

/**
 * SW5 names the Windows target `windows-x64`; the canonical key follows the machine
 * convention the other targets use. Both spellings are accepted.
 */
const TARGET_ALIASES = Object.freeze({ "windows-x64": "win-x64" });

/** Node's and Engram's Windows releases are `.zip`; every other target's are `.tar.gz`. */
function archiveExtension(target) {
	return TARGETS[target].platform === "win32" ? "zip" : "tar.gz";
}

/** The Node release staged when `.nvmrc` names only a major version; it must stay on that major. */
export const PINNED_NODE_VERSION = "24.14.1";

export const USAGE =
	"usage: stage-runtime --target <darwin-arm64|linux-arm64|linux-x64|win-x64|win-arm64> [--out <dir>] " +
	"[--engram-version <x.y.z>]";

/** Parses the command line; throws with the usage on anything unexpected. */
export function parseArgs(argv) {
	const args = argv.filter((arg) => arg !== "--");
	const options = {};
	const names = { "--target": "target", "--out": "out", "--engram-version": "engramVersion" };
	for (let i = 0; i < args.length; i += 2) {
		const name = names[args[i]];
		const value = args[i + 1];
		if (!name || value === undefined || value.startsWith("--"))
			throw new Error(`Unexpected argument ${args[i]}.\n${USAGE}`);
		options[name] = value;
	}
	if (!options.target) throw new Error(`Missing --target.\n${USAGE}`);
	if (!Object.hasOwn(TARGETS, options.target) && TARGET_ALIASES[options.target])
		options.target = TARGET_ALIASES[options.target];
	if (!Object.hasOwn(TARGETS, options.target))
		throw new Error(`Unknown target ${options.target}; expected one of ${Object.keys(TARGETS).join(", ")}.`);
	if (options.engramVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(options.engramVersion))
		throw new Error(`--engram-version must be x.y.z, got ${options.engramVersion}.`);
	return options;
}

/** The target this machine is, or undefined when it is none of the supported ones. */
export function hostTarget(platform = process.platform, arch = process.arch) {
	return Object.keys(TARGETS).find(
		(name) => TARGETS[name].platform === platform && TARGETS[name].arch === arch,
	);
}

/**
 * Throws when `target` is not the machine staging it: the daemon's dependencies
 * carry native, per-platform pieces that npm installs for the machine it runs on.
 */
export function assertHostTarget(target, host = hostTarget()) {
	if (target === host) return;
	throw new Error(
		`Cannot stage ${target} on ${host ?? `${process.platform}-${process.arch}`}: the runtime's dependencies ` +
			`include native pieces for the machine that installs them. Stage ${target} on a ${target} machine ` +
			"or container (Linux targets are staged inside a container).",
	);
}

/** The exact Node version: `.nvmrc` when it is exact, else the pinned one, which must share its major. */
export function nodeVersion(nvmrc, pinned = PINNED_NODE_VERSION) {
	const wanted = nvmrc.trim().replace(/^v/, "");
	if (/^\d+\.\d+\.\d+$/.test(wanted)) return wanted;
	if (/^\d+$/.test(wanted) && pinned.split(".")[0] === wanted) return pinned;
	throw new Error(`.nvmrc asks for Node ${wanted}, but the pinned release is ${pinned}; update one of them.`);
}

export function nodeArchiveName(version, target) {
	return `node-v${version}-${TARGETS[target].node}.${archiveExtension(target)}`;
}

/**
 * The Engram release archive for `target`. Windows releases have shipped both ZIP and tar.gz, so
 * given the release's checksum `listing` the Windows name is the one format it lists, and it must
 * list exactly one. Without a listing the name is the target's usual extension, unchecked.
 */
export function engramArchiveName(version, target, listing) {
	const base = `engram_${version}_${TARGETS[target].engram}`;
	if (TARGETS[target].platform !== "win32" || listing === undefined)
		return `${base}.${archiveExtension(target)}`;
	const candidates = ["zip", "tar.gz"]
		.map((extension) => `${base}.${extension}`)
		.filter((name) => {
			try {
				checksumFor(listing, name);
				return true;
			} catch {
				return false;
			}
		});
	if (candidates.length !== 1)
		throw new Error(
			"Windows Engram needs exactly one supported archive in the release checksum list (ZIP or tar.gz).",
		);
	return candidates[0];
}

/** Explicit build prerequisite only; never search or inherit the user's entire PATH. */
export function windowsBuildGo(source, isFile) {
	const exe = source.GENTLE_DOT_BUILD_GO;
	if (
		!exe ||
		!win32.isAbsolute(exe) ||
		win32.basename(exe).toLowerCase() !== "go.exe" ||
		/[;\r\n"]/.test(exe)
	)
		throw new Error(
			"GENTLE_DOT_BUILD_GO must be the full path of the real go.exe in GOROOT\\bin (not a Scoop or Chocolatey shim), such as C:\\Program Files\\Go\\bin\\go.exe.",
		);
	if (!isFile(exe)) throw new Error(`GENTLE_DOT_BUILD_GO names ${exe}, which is not an existing file.`);
	return exe;
}

/** Child-only environment: installers do not inherit the user's home or credentials. */
export function installerEnv(out, cache, target, source = process.env, goExecutable) {
	const windows = TARGETS[target].platform === "win32";
	const path = windows ? win32.join : posix.join;
	const home = path(cache, "npm-home");
	const env = {
		HOME: home,
		PATH: `${path(out, "node", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
		TMPDIR: source.TMPDIR ?? "/tmp",
		npm_config_userconfig: path(cache, "npmrc"),
		npm_config_cache: path(cache, "npm-cache"),
		npm_config_registry: "https://registry.npmjs.org/",
		npm_config_update_notifier: "false",
	};
	if (windows) {
		const get = (key) =>
			Object.entries(source).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
		const root = get("SystemRoot");
		if (!root) throw new Error("Windows installers require SystemRoot.");
		delete env.TMPDIR;
		Object.assign(env, {
			USERPROFILE: home,
			LOCALAPPDATA: path(home, "AppData", "Local"),
			APPDATA: path(home, "AppData", "Roaming"),
			SystemRoot: root,
			ComSpec: path(root, "System32", "cmd.exe"),
			PATH: [
				path(out, "node", "bin"),
				path(root, "System32"),
				root,
				...(goExecutable ? [win32.dirname(goExecutable)] : []),
			].join(";"),
			TEMP: get("TEMP") ?? get("TMP") ?? path(home, "Temp"),
			TMP: get("TMP") ?? get("TEMP") ?? path(home, "Temp"),
		});
	}
	return env;
}

/**
 * No shell quoting or direct `.cmd` spawn: on Windows pnpm supplies its JavaScript entry through
 * `npm_execpath`, which Node runs. Spawning `pnpm` itself fails with ENOENT there, as it is a `.cmd` shim.
 */
export function pnpmInvocation(
	args,
	platform = process.platform,
	env = process.env,
	node = process.execPath,
) {
	if (platform !== "win32") return { command: "pnpm", args };
	if (!/pnpm\.(?:c?js|mjs)$/i.test(env.npm_execpath ?? ""))
		throw new Error("Run Windows staging through pnpm so npm_execpath names pnpm's JavaScript entry.");
	return { command: node, args: [env.npm_execpath, ...args] };
}

/**
 * The files a staged Windows runtime must hold, relative to its root: what `launch.rs`
 * `validate_packaged_runtime` requires of the installed copy, and what `windows-layout.test.ts`
 * keeps in step with it. `node/bin/node.exe` is where the app launches Node (`launch.rs`).
 */
export const WINDOWS_RUNTIME_FILES = Object.freeze([
	"node/bin/node.exe",
	"daemon/cli.mjs",
	"daemon/package.json",
	"daemon/native/windows-stop.node",
	"daemon/node_modules/gentle-pi/package.json",
	"bin/engram.exe",
	"bin/pi.cmd",
	"ui/index.html",
]);

/**
 * Lays Node's extracted Windows zip (`extracted` holds node.exe, the cmd shims and `node_modules/npm`)
 * out like the other targets under `node`: `bin/node.exe`, `bin/npm.cmd` and `bin/npx.cmd` that run
 * the staged Node's own npm, and `lib/node_modules/npm`. The zip's own shims look for npm beside
 * node.exe, so they are rewritten rather than copied.
 */
export function layoutWindowsNode(extracted, node) {
	mkdirSync(join(node, "bin"), { recursive: true });
	mkdirSync(join(node, "lib", "node_modules"), { recursive: true });
	copyFileSync(join(extracted, "node.exe"), join(node, "bin", "node.exe"));
	copyFileSync(join(extracted, "LICENSE"), join(node, "LICENSE"));
	cpSync(join(extracted, "node_modules", "npm"), join(node, "lib", "node_modules", "npm"), {
		recursive: true,
	});
	for (const name of ["npm", "npx"])
		writeFileSync(join(node, "bin", `${name}.cmd`), npmWrapper(`${name}-cli.js`, "win32"));
}

/** The SHA-256 a `SHASUMS256.txt` / `checksums.txt` listing gives `fileName`; throws when it is absent. */
export function checksumFor(listing, fileName) {
	for (const line of listing.split("\n")) {
		const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
		if (match && match[2] === fileName) return match[1];
	}
	throw new Error(`The checksum list has no entry for ${fileName}.`);
}

export function sha256File(path) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(path)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest("hex")));
	});
}

/** Throws when the file's SHA-256 is not `expected`. */
export async function verifyChecksum(path, expected) {
	const actual = await sha256File(path);
	if (actual !== expected)
		throw new Error(`Checksum mismatch for ${path}: expected ${expected}, got ${actual}.`);
}

/**
 * The release version in `engram version` output, or undefined when it is not
 * a release (a development build prints a Go pseudo-version such as `3.0.0-2026…-8e52…`).
 */
export function engramReleaseVersion(output) {
	return /^engram v?(\d+\.\d+\.\d+)\s*$/.exec(output.trim())?.[1];
}

/** The `x.y.z` of a GitHub `…/releases/tag/vx.y.z` URL. */
export function versionFromReleaseUrl(url) {
	const version = /\/releases\/tag\/v?(\d+\.\d+\.\d+)$/.exec(url ?? "")?.[1];
	if (!version) throw new Error(`Not a release URL: ${url}`);
	return version;
}

/** Bytes under `dir`, counting links as themselves and never following them. */
export function treeSize(dir) {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		total += entry.isDirectory() ? treeSize(path) : lstatSync(path).size;
	}
	return total;
}

/** Symbolic links under `dir`, relative to it. */
export function symlinksIn(dir, prefix = "") {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isSymbolicLink()) found.push(relative);
		else if (entry.isDirectory()) found.push(...symlinksIn(join(dir, entry.name), relative));
	}
	return found;
}

export function formatSize(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A copied Windows source tree has no Git revision; never manufacture one. That label is for a
 * local copy only: CI stages release candidates, which must name their daemon commit.
 */
export function daemonSourceRevision(
	repo,
	platform = process.platform,
	present = existsSync,
	git = execFileSync,
	ci = process.env.CI,
) {
	if (platform === "win32" && !present(join(repo, ".git"))) {
		if (ci)
			throw new Error(
				`CI must stage from a Git checkout: ${repo} has no .git, so the runtime would have no daemon commit.`,
			);
		return "snapshot-unversioned";
	}
	const commit = git("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const dirty = git("git", ["status", "--porcelain", "--", "packages"], { cwd: repo, encoding: "utf8" });
	return dirty.trim() ? `${commit}-dirty` : commit;
}

/** The runtime's `MANIFEST.json` content. */
export function buildManifest({ target, versions, daemonCommit, sizeBytes, stagedAt }) {
	for (const key of ["node", "engram", "gentlePi"])
		if (!versions[key]) throw new Error(`The manifest needs the ${key} version.`);
	if (!daemonCommit) throw new Error("The manifest needs the daemon commit.");
	return {
		name: "gentle-dot-runtime",
		target,
		versions,
		daemonCommit,
		sizeBytes,
		size: formatSize(sizeBytes),
		stagedAt,
	};
}

/** A `bin/npm` or `bin/npx` that runs the staged Node's own npm, wherever the folder is copied. */
export function npmWrapper(cli, platform = "unix") {
	if (platform === "win32")
		return `@echo off\r\n"%~dp0node.exe" "%~dp0..\\lib\\node_modules\\npm\\bin\\${cli}" %*\r\n`;
	return `#!/bin/sh
# Runs the npm bundled with this Node; a script rather than Node's symlink, so copies that follow links work.
self=$0
while [ -L "$self" ]; do
	link=$(readlink "$self")
	case $link in
		/*) self=$link ;;
		*) self=$(dirname "$self")/$link ;;
	esac
done
bin=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd -P) || exit 1
exec "$bin/node" "$bin/../lib/node_modules/npm/bin/${cli}" "$@"
`;
}

// macOS installer (`package-mac.mjs`).

export const MAC_USAGE =
	"usage: package-mac [--sign <identity>] [--skip-stage] [--check] [--check-dmg <dmg>] [--finder-layout]";

/** The ad hoc signing identity: no certificate, and no identity that survives a rebuild. */
export const AD_HOC = "-";

/**
 * Parses package-mac's command line. The signing identity is `--sign`, else
 * `GENTLE_DOT_SIGN_IDENTITY`, else ad hoc.
 */
export function parseMacArgs(argv, env = process.env) {
	const args = argv.filter((arg) => arg !== "--");
	const options = { skipStage: false, check: false, finderLayout: false };
	const switches = { "--skip-stage": "skipStage", "--check": "check", "--finder-layout": "finderLayout" };
	const values = { "--sign": "sign", "--check-dmg": "checkDmg" };
	for (let i = 0; i < args.length; i++) {
		if (switches[args[i]]) {
			options[switches[args[i]]] = true;
			continue;
		}
		const name = values[args[i]];
		const value = args[i + 1];
		if (!name || value === undefined || value === "" || value.startsWith("--"))
			throw new Error(`Unexpected argument ${args[i]}.\n${MAC_USAGE}`);
		options[name] = value;
		i++;
	}
	const identity = options.sign ?? (env.GENTLE_DOT_SIGN_IDENTITY || AD_HOC);
	delete options.sign;
	return { ...options, identity };
}

/**
 * Whether a file's first bytes are a Mach-O header: thin 32/64-bit, or universal.
 * A universal header shares Java's class-file magic; it counts its architectures,
 * a small number, where a class file has its version, 45 or more.
 */
export function isMachO(bytes) {
	if (bytes.length < 8) return false;
	const magic = bytes.readUInt32BE(0);
	if ([0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface].includes(magic)) return true;
	if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false;
	const architectures = bytes.readUInt32BE(4);
	return architectures > 0 && architectures < 20;
}

/**
 * Runtime binaries that must keep their own signature: re-signing changes their
 * bytes, and gentle-pi refuses a Gentle AI binary whose SHA-256 is not its pinned release's.
 */
export function keepsOwnSignature(relative) {
	return /(^|\/)node_modules\/gentle-pi\/\.gentle-ai\//.test(relative);
}

/** Signing order for nested code: the deepest paths first, so nothing is signed before what it holds. */
export function insideOut(paths) {
	const depth = (path) => path.split("/").length;
	return [...paths].sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
}

/**
 * The configuration `tauri build --config` merges for a release: the staged runtime
 * as the app's `runtime` resource, and the signing identity. They stay out of
 * `tauri.macos.conf.json` because tauri-build copies resources on every build, so a
 * source build (`cargo test`, `tauri dev`) would need a staged runtime.
 */
export function tauriReleaseConfig({ runtime, identity }) {
	return {
		bundle: {
			resources: { [runtime]: "runtime" },
			macOS: { signingIdentity: identity },
		},
	};
}

/** The DMG name Tauri's bundler gives a product, version, and Node-style arch. */
export function dmgFileName(productName, version, arch) {
	const names = { arm64: "aarch64", x64: "x64" };
	if (!names[arch]) throw new Error(`No DMG for arch ${arch}.`);
	return `${productName}_${version}_${names[arch]}.dmg`;
}

// Windows installer (`package-windows.mjs`).

export const WINDOWS_USAGE = "usage: package-windows [--skip-stage] [--check]";

/** Parses package-windows' command line: two switches, and a bare `--` is ignored. */
export function parseWindowsArgs(argv) {
	const options = { skipStage: false, check: false };
	const switches = { "--skip-stage": "skipStage", "--check": "check" };
	for (const arg of argv.filter((value) => value !== "--")) {
		if (!switches[arg]) throw new Error(`Unexpected argument ${arg}.\n${WINDOWS_USAGE}`);
		options[switches[arg]] = true;
	}
	return options;
}

/**
 * The configuration `tauri build --config` merges for a self-contained Windows release: the
 * staged runtime as the app's `runtime` resource — the mapping `tauriReleaseConfig` uses for
 * macOS, and the one `daemon::runtime_dir` looks for beside the exe. No macOS key: there is no
 * signing identity on Windows. It carries no `longDescription`: the Windows bundlers do not
 * emit one (measured on the built bundles — the MSI has no `Comments`/`ARPCOMMENTS` property,
 * and the NSIS version-info block derives every key from `PRODUCTNAME`), so a description here
 * would be config with no output.
 */
export function windowsReleaseConfig({ runtime }) {
	if (!runtime) throw new Error("windowsReleaseConfig needs the staged runtime path.");
	return { bundle: { resources: { [runtime]: "runtime" } } };
}

/**
 * The environment `tauri build` runs with for the Windows installers. `CI` keeps the bundler
 * non-interactive, as in package-mac. `GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED=1` is the marker
 * build.rs embeds and the release daemon checks: without it an installed copy with a missing
 * or partial runtime falls back to the build machine's paths instead of refusing to start.
 * It is set last so an inherited value can never turn the requirement off.
 */
export function windowsBuildEnv(env = process.env) {
	return { ...env, CI: "true", GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED: "1" };
}

/** The NSIS and MSI names Tauri's bundler gives a product and version. */
export function windowsInstallerNames(productName, version) {
	return {
		nsis: `${productName}_${version}_x64-setup.exe`,
		msi: `${productName}_${version}_x64_en-US.msi`,
	};
}

/**
 * The 7-Zip executables to try, in order, when `--check` has to extract an NSIS
 * payload: an explicit `SEVEN_ZIP`, the two conventional install folders, then
 * whatever PATH resolves. The caller probes each one; this only names them.
 */
export function sevenZipCandidates(env = process.env) {
	const candidates = [];
	if (env.SEVEN_ZIP) candidates.push(env.SEVEN_ZIP);
	for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]])
		if (root) candidates.push(join(root, "7-Zip", "7z.exe"));
	return [...candidates, "7z", "7za"];
}

/**
 * What an installer payload's extracted `runtime/` tree is missing from, or holds
 * beyond, the staged runtime. Both arguments are relative paths; Windows compares
 * them case-insensitively and indifferently to the separator, so a payload that only
 * differs that way is not a difference.
 */
export function payloadDifferences(staged, extracted) {
	const normalize = (path) => path.replace(/\\/g, "/").toLowerCase();
	const wanted = new Set(staged.map(normalize));
	const found = new Set(extracted.map(normalize));
	return {
		missing: [...wanted].filter((path) => !found.has(path)).sort(),
		extra: [...found].filter((path) => !wanted.has(path)).sort(),
	};
}

/**
 * The files whose bytes `--check` compares between the staged runtime and the payload.
 * Not all of them: the whole tree is 300 MB of mostly Node's own distribution and
 * dependencies, and these are the ones a dropped or repacked resource would change.
 */
export const RUNTIME_HASH_SAMPLE = Object.freeze([
	"MANIFEST.json",
	"node/bin/node.exe",
	"bin/pi.cmd",
	"bin/engram.exe",
	"daemon/cli.mjs",
]);

/** The engine's own binary, wherever the build nested it and at whichever version. */
export function isGentleAiBinary(relative) {
	return /(^|\/)\.gentle-ai\/v[^/]+\/gentle-ai\.exe$/.test(relative.replace(/\\/g, "/"));
}

/**
 * The engine's provenance for `stage-runtime`'s log, from either shape of
 * `integrity.json`: a Darwin/Linux signed release asset records `asset` and
 * `assetSha256`, a Windows Go SumDB source build records `method`, `binarySha256`,
 * `goVersion` and `buildMode` instead (L54).
 */
export function gentleAiProvenance(integrity) {
	if (integrity.asset) return `from ${integrity.asset} (sha256 ${integrity.assetSha256})`;
	const sha = integrity.binarySha256 ? `${String(integrity.binarySha256).slice(0, 12)}…` : "unknown";
	return `${integrity.method ?? "unknown method"} (${integrity.goVersion ?? "unknown Go"}, binary sha256 ${sha})`;
}

/**
 * Files whose permission bits differ between the staged runtime and the app's copy,
 * or that the copy lacks. Both maps are relative path → mode.
 */
export function modeDifferences(staged, bundled) {
	const differences = [];
	for (const [path, mode] of staged) {
		if (!bundled.has(path)) differences.push(`${path} (missing)`);
		else if ((bundled.get(path) & 0o777) !== (mode & 0o777))
			differences.push(
				`${path} (${(mode & 0o777).toString(8)} → ${(bundled.get(path) & 0o777).toString(8)})`,
			);
	}
	return differences;
}
