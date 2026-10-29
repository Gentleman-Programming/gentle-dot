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
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
	assertHostTarget,
	buildManifest,
	checksumFor,
	daemonSourceRevision,
	engramArchiveName,
	engramReleaseVersion,
	formatSize,
	gentleAiIntegritySummary,
	installerEnv,
	nodeArchiveName,
	nodeExtractionPlan,
	nodeVersion,
	npmWrapper,
	parseArgs,
	pnpmInvocation,
	renameWhenReleased,
	symlinksIn,
	treeSize,
	verifyChecksum,
	versionFromReleaseUrl,
	windowsBuildGo,
} from "./lib.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const CACHE = join(REPO, ".cache", "package");
const ENGRAM_RELEASES = "https://github.com/Gentleman-Programming/engram/releases";

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
	mkdirSync(join(node, "bin"), { recursive: true });
	const plan = nodeExtractionPlan(version, target);
	// Only the binary, npm, and the license: headers, docs, and corepack are left out.
	run("tar", [plan.flag, archive, "-C", node, "--strip-components=1", ...plan.members]);
	for (const [from, to] of plan.moves) {
		mkdirSync(join(node, "lib"), { recursive: true });
		renameWhenReleased(join(node, from), join(node, to));
	}
	const windows = target === "windows-x64";
	for (const name of ["npm", "npx"])
		writeFileSync(
			join(node, "bin", `${name}${windows ? ".cmd" : ""}`),
			npmWrapper(`${name}-cli.js`, windows ? "win32" : "unix"),
			{ mode: 0o755 },
		);
	return version;
}

/** The engine's packaged Gentle AI binary: readable and runnable by every user, as an installed app needs. */
function openGentleAi(daemon) {
	const dir = join(daemon, "node_modules", "gentle-pi", ".gentle-ai");
	if (!existsSync(dir)) throw new Error(`gentle-pi's postinstall left no ${dir}.`);
	const open = (path) => {
		const stat = lstatSync(path);
		if (stat.isDirectory()) {
			chmodSync(path, 0o755);
			for (const name of readdirSync(path)) open(join(path, name));
		} else if (stat.isFile()) chmodSync(path, stat.mode & 0o111 ? 0o755 : 0o644);
	};
	open(dir);
	const versions = readdirSync(dir);
	const integrity = JSON.parse(readFileSync(join(dir, versions[0] ?? "", "integrity.json"), "utf8"));
	return integrity;
}

function installDaemonModules(out, target, goExecutable) {
	const daemon = join(out, "daemon");
	const npmHome = join(CACHE, "npm-home");
	mkdirSync(npmHome, { recursive: true });
	const npmrc = join(CACHE, "npmrc");
	writeFileSync(npmrc, "");
	say("Daemon dependencies (npm install --omit=dev)");
	// A clean npm setup: no user npmrc, a cache of its own, and a scratch HOME for install scripts.
	const env = installerEnv(out, CACHE, target, process.env, goExecutable);
	if (target === "windows-x64")
		for (const path of [env.LOCALAPPDATA, env.APPDATA, env.TEMP, env.TMP])
			mkdirSync(path, { recursive: true });
	const result = spawnSync(
		join(out, "node", "bin", target === "windows-x64" ? "node.exe" : "node"),
		[
			join(out, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
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
			env,
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
	say(`  ${gentleAiIntegritySummary(gentleAi)}`);
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
	const listing = await text(`${base}/checksums.txt`);
	const archiveName = engramArchiveName(version, target, listing);
	const archive = await verifiedDownload(
		`${base}/${archiveName}`,
		archiveName,
		checksumFor(listing, archiveName),
	);
	const extracted = mkdtempSync(join(CACHE, "engram-"));
	const name = target === "windows-x64" ? "engram.exe" : "engram";
	run("tar", [archiveName.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", extracted, name]);
	const binary = join(extracted, name);
	if (!lstatSync(binary).isFile()) throw new Error(`${archiveName} has no regular ${name} binary.`);
	copyFileSync(binary, join(out, "bin", name));
	chmodSync(join(out, "bin", name), 0o755);
	rmSync(extracted, { recursive: true });
	return { version, source };
}

function daemonCommit() {
	return daemonSourceRevision(REPO);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const { target } = options;
	assertHostTarget(target);
	// Fail before output replacement or downloads; only the chosen Go directory is
	// added to the installer's otherwise isolated PATH. No Go setup occurs here.
	const goExecutable =
		target === "windows-x64"
			? windowsBuildGo(process.env, (file) => {
					try {
						return lstatSync(file).isFile();
					} catch {
						return false;
					}
				})
			: undefined;
	const out = resolve(
		process.env.INIT_CWD ?? process.cwd(),
		options.out ?? join(REPO, "build", "runtime", target),
	);
	mkdirSync(CACHE, { recursive: true });
	prepareOut(out);
	say(`Staging the ${target} runtime in ${out}`);

	const node = await stageNode(out, target);
	say("Daemon (build:runtime)");
	const daemonBuild = pnpmInvocation(["--filter", "@gentle-dot/daemon", "build:runtime", "--", "--out", out]);
	run(daemonBuild.command, daemonBuild.args, { cwd: REPO });
	const modules = installDaemonModules(out, target, goExecutable);
	const engram = await stageEngram(out, target, options.engramVersion);
	say("Web UI");
	const uiBuild = pnpmInvocation(["--filter", "@gentle-dot/ui", "build"]);
	run(uiBuild.command, uiBuild.args, { cwd: REPO });
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
