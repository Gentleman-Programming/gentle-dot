#!/usr/bin/env node
// Stages the installed app's `runtime/` folder (S29.5) for one target:
// `node scripts/package/stage-runtime.mjs --target darwin-arm64 [--out <dir>]`.
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	createWriteStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
	assertHostTarget,
	buildManifest,
	checksumFor,
	engramArchiveName,
	engramReleaseVersion,
	formatSize,
	gentleAiProvenance,
	nodeArchiveName,
	nodeVersion,
	npmWrapper,
	parseArgs,
	symlinksIn,
	TARGETS,
	treeSize,
	verifyChecksum,
	versionFromReleaseUrl,
} from "./lib.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const CACHE = join(REPO, ".cache", "package");
const ENGRAM_RELEASES = "https://github.com/Gentleman-Programming/engram/releases";
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const say = (line) => process.stdout.write(`${line}\n`);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.status !== 0)
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`}).`,
		);
	return result;
}

async function download(url, destination) {
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`GET ${url} answered ${response.status}.`);
	const partial = `${destination}.part`;
	await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
	renameSync(partial, destination);
}

async function text(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`GET ${url} answered ${response.status}.`);
	return response.text();
}

/** The first file named `name` under `dir`, wherever an archive nests it, or undefined. */
function findFile(dir, name) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isFile() && entry.name === name) return path;
		if (entry.isDirectory()) {
			const found = findFile(path, name);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Extracts a Windows `.zip` with PowerShell's `Expand-Archive`, which ships with Windows.
 * `tar` cannot be relied on there: Git for Windows shadows the bundled bsdtar with a GNU
 * tar that does not read zip.
 */
function extractZip(archive, destination) {
	mkdirSync(destination, { recursive: true });
	const ps = (path) => path.replace(/'/g, "''");
	run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`Expand-Archive -LiteralPath '${ps(archive)}' -DestinationPath '${ps(destination)}' -Force`,
	]);
}

/** A cached download of `url` whose SHA-256 is `expected`, fetched again when the cached copy differs. */
async function verifiedDownload(url, name, expected) {
	const file = join(CACHE, name);
	if (existsSync(file)) {
		try {
			await verifyChecksum(file, expected);
			say(`  cached ${name} (sha256 verified)`);
			return file;
		} catch {
			unlinkSync(file);
		}
	}
	say(`  downloading ${url}`);
	await download(url, file);
	try {
		await verifyChecksum(file, expected);
	} catch (error) {
		unlinkSync(file);
		throw error;
	}
	say(`  sha256 verified ${name}`);
	return file;
}

/** An empty output folder; a runtime staged earlier is replaced, anything else is refused. */
function prepareOut(out) {
	if (existsSync(out) && readdirSync(out).length > 0) {
		const manifest = join(out, "MANIFEST.json");
		const previous = existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name;
		if (previous !== "gentle-dot-runtime")
			throw new Error(`${out} is not empty and holds no staged runtime; choose an empty folder.`);
		rmSync(out, { recursive: true });
	}
	mkdirSync(out, { recursive: true });
}

async function stageNode(out, target) {
	const version = nodeVersion(readFileSync(join(REPO, ".nvmrc"), "utf8"));
	const base = `https://nodejs.org/dist/v${version}`;
	const archiveName = nodeArchiveName(version, target);
	say(`Node ${version}`);
	const archive = await verifiedDownload(
		`${base}/${archiveName}`,
		archiveName,
		checksumFor(await text(`${base}/SHASUMS256.txt`), archiveName),
	);
	const node = join(out, "node");
	if (TARGETS[target].platform === "win32") {
		const extracted = mkdtempSync(join(CACHE, "node-"));
		extractZip(archive, extracted);
		const found = findFile(extracted, "node.exe");
		const root = found ? dirname(found) : undefined;
		if (!root) throw new Error(`${archiveName} has no node.exe.`);
		// The Windows zip has node.exe at its root, npm one folder down and the cmd shims beside it.
		mkdirSync(join(node, "node_modules"), { recursive: true });
		for (const name of ["node.exe", "npm.cmd", "npx.cmd", "LICENSE"])
			copyFileSync(join(root, name), join(node, name));
		cpSync(join(root, "node_modules", "npm"), join(node, "node_modules", "npm"), { recursive: true });
		rmSync(extracted, { recursive: true });
		return version;
	}
	mkdirSync(join(node, "bin"), { recursive: true });
	const root = archiveName.replace(/\.tar\.gz$/, "");
	// Only the binary, npm, and the license: headers, docs, and corepack are left out.
	run("tar", [
		"-xzf",
		archive,
		"-C",
		node,
		"--strip-components=1",
		`${root}/bin/node`,
		`${root}/lib/node_modules/npm`,
		`${root}/LICENSE`,
	]);
	writeFileSync(join(node, "bin", "npm"), npmWrapper("npm-cli.js"), { mode: 0o755 });
	writeFileSync(join(node, "bin", "npx"), npmWrapper("npx-cli.js"), { mode: 0o755 });
	return version;
}

/** The engine's packaged Gentle AI binary: readable and runnable by every user, as an installed app needs. */
function openGentleAi(daemon) {
	const dir = join(daemon, "node_modules", "gentle-pi", ".gentle-ai");
	if (!existsSync(dir)) throw new Error(`gentle-pi's postinstall left no ${dir}.`);
	// Windows carries no execute bit, so a `.exe` there must not read as "not a binary";
	// `chmod` is a no-op anyway and the file's extension is what makes it runnable.
	const windows = process.platform === "win32";
	const open = (path) => {
		const stat = lstatSync(path);
		if (stat.isDirectory()) {
			chmodSync(path, 0o755);
			for (const name of readdirSync(path)) open(join(path, name));
		} else if (stat.isFile()) chmodSync(path, windows || (stat.mode & 0o111) !== 0 ? 0o755 : 0o644);
	};
	open(dir);
	const versions = readdirSync(dir);
	const integrity = JSON.parse(readFileSync(join(dir, versions[0] ?? "", "integrity.json"), "utf8"));
	return integrity;
}

function installDaemonModules(out, target) {
	const daemon = join(out, "daemon");
	const npmHome = join(CACHE, "npm-home");
	mkdirSync(npmHome, { recursive: true });
	const npmrc = join(CACHE, "npmrc");
	writeFileSync(npmrc, "");
	say("Daemon dependencies (npm install --omit=dev)");
	const windows = TARGETS[target].platform === "win32";
	// A clean npm setup: no user npmrc, a cache of its own, and a scratch HOME for install scripts.
	const result = spawnSync(
		windows ? join(out, "node", "node.exe") : join(out, "node", "bin", "node"),
		[
			windows
				? join(out, "node", "node_modules", "npm", "bin", "npm-cli.js")
				: join(out, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
			"install",
			"--omit=dev",
			"--no-bin-links",
			"--no-audit",
			"--no-fund",
			"--foreground-scripts",
		],
		{
			cwd: daemon,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			env: windows
				? {
						...process.env,
						USERPROFILE: npmHome,
						HOME: npmHome,
						PATH: [join(out, "node"), join(out, "bin"), process.env.PATH ?? ""].filter(Boolean).join(";"),
						npm_config_userconfig: npmrc,
						npm_config_cache: join(CACHE, "npm-cache"),
						npm_config_registry: "https://registry.npmjs.org/",
						npm_config_update_notifier: "false",
					}
				: {
						HOME: npmHome,
						PATH: `${join(out, "node", "bin")}:${SYSTEM_PATH}`,
						TMPDIR: process.env.TMPDIR ?? "/tmp",
						npm_config_userconfig: npmrc,
						npm_config_cache: join(CACHE, "npm-cache"),
						npm_config_registry: "https://registry.npmjs.org/",
						npm_config_update_notifier: "false",
					},
		},
	);
	process.stdout.write(result.stdout ?? "");
	process.stderr.write(result.stderr ?? "");
	if (result.status !== 0) throw new Error(`npm install failed (exit ${result.status}).`);
	const postinstall = `${result.stdout}\n${result.stderr}`
		.split("\n")
		.filter((line) => /Gentle AI|gentle-pi/.test(line) && !/^>/.test(line.trim()));
	const gentleAi = openGentleAi(daemon);
	say(`  gentle-pi postinstall: ${postinstall.join(" | ") || "(no output)"}`);
	say(`  gentle-ai ${gentleAi.version} ${gentleAiProvenance(gentleAi)}`);
	const pkg = (name) =>
		JSON.parse(readFileSync(join(daemon, "node_modules", name, "package.json"), "utf8")).version;
	return {
		gentlePi: pkg("gentle-pi"),
		engine: pkg("@earendil-works/pi-coding-agent"),
		gentleAi: gentleAi.version,
	};
}

/** The Engram release to carry: the flag, else the user's own release version, else the latest release. */
async function engramVersion(requested) {
	if (requested) return { version: requested, source: "--engram-version" };
	let installed;
	try {
		installed = engramReleaseVersion(
			execFileSync("engram", ["version"], { encoding: "utf8", timeout: 5000 }),
		);
	} catch {}
	if (installed) {
		const response = await fetch(`${ENGRAM_RELEASES}/download/v${installed}/checksums.txt`, {
			method: "HEAD",
		});
		if (response.ok) return { version: installed, source: "installed engram" };
	}
	const latest = await fetch(`${ENGRAM_RELEASES}/latest`, { redirect: "manual" });
	return { version: versionFromReleaseUrl(latest.headers.get("location")), source: "latest release" };
}

async function stageEngram(out, target, requested) {
	const { version, source } = await engramVersion(requested);
	say(`Engram ${version} (${source})`);
	const base = `${ENGRAM_RELEASES}/download/v${version}`;
	const archiveName = engramArchiveName(version, target);
	const archive = await verifiedDownload(
		`${base}/${archiveName}`,
		archiveName,
		checksumFor(await text(`${base}/checksums.txt`), archiveName),
	);
	const windows = TARGETS[target].platform === "win32";
	const binaryName = windows ? "engram.exe" : "engram";
	const extracted = mkdtempSync(join(CACHE, "engram-"));
	if (windows) extractZip(archive, extracted);
	else run("tar", ["-xzf", archive, "-C", extracted, "engram"]);
	const binary = findFile(extracted, binaryName);
	if (!binary || !lstatSync(binary).isFile()) throw new Error(`${archiveName} has no regular ${binaryName}.`);
	copyFileSync(binary, join(out, "bin", binaryName));
	if (!windows) chmodSync(join(out, "bin", binaryName), 0o755);
	rmSync(extracted, { recursive: true });
	return { version, source };
}

function daemonCommit() {
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
	const dirty = execFileSync("git", ["status", "--porcelain", "--", "packages"], {
		cwd: REPO,
		encoding: "utf8",
	});
	return dirty.trim() ? `${commit}-dirty` : commit;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const { target } = options;
	assertHostTarget(target);
	const out = resolve(
		process.env.INIT_CWD ?? process.cwd(),
		options.out ?? join(REPO, "build", "runtime", target),
	);
	mkdirSync(CACHE, { recursive: true });
	prepareOut(out);
	say(`Staging the ${target} runtime in ${out}`);

	const node = await stageNode(out, target);
	say("Daemon (build:runtime)");
	run("pnpm", ["--filter", "@gentle-dot/daemon", "build:runtime", "--", "--out", out], { cwd: REPO });
	const modules = installDaemonModules(out, target);
	const engram = await stageEngram(out, target, options.engramVersion);
	say("Web UI");
	run("pnpm", ["--filter", "@gentle-dot/ui", "build"], { cwd: REPO });
	cpSync(join(REPO, "packages", "ui", "dist", "app"), join(out, "ui"), { recursive: true });

	const links = symlinksIn(out);
	if (links.length > 0)
		say(`warning: ${links.length} symbolic links remain, e.g. ${links.slice(0, 5).join(", ")}`);
	const manifest = buildManifest({
		target,
		versions: { node, engram: engram.version, engramSource: engram.source, ...modules },
		daemonCommit: daemonCommit(),
		sizeBytes: treeSize(out),
		stagedAt: new Date().toISOString(),
	});
	writeFileSync(join(out, "MANIFEST.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	say(`Staged ${out}: ${formatSize(manifest.sizeBytes)} (${manifest.sizeBytes} bytes)`);
}

main().catch((error) => {
	process.stderr.write(`stage-runtime: ${error.message}\n`);
	process.exit(1);
});
