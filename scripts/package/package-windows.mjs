#!/usr/bin/env node
// Builds the self-contained Windows installer (SW5, W11b): stages the runtime, builds
// the release app and its NSIS and MSI installers with Tauri, and — with `--check` —
// verifies each installer's payload by extracting it, without installing anything:
// `node scripts/package/package-windows.mjs [--skip-stage] [--check]`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertHostTarget,
	formatSize,
	isGentleAiBinary,
	parseWindowsArgs,
	payloadDifferences,
	RUNTIME_HASH_SAMPLE,
	sevenZipCandidates,
	sha256File,
	treeSize,
	windowsInstallerNames,
	windowsReleaseConfig,
} from "./lib.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TARGET = "win-x64";
const TAURI = join(REPO, "apps", "desktop", "src-tauri");
const HERE = join(REPO, "scripts", "package");
const BUNDLE = join(TAURI, "target", "release", "bundle");

const say = (line) => process.stdout.write(`${line}\n`);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.status !== 0)
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`}).`,
		);
	return result;
}

/** Regular files under `dir`, relative to it with `/` separators; links are neither followed nor listed. */
function filesIn(dir, prefix = "") {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) found.push(...filesIn(join(dir, entry.name), relative));
		else if (entry.isFile()) found.push(relative);
	}
	return found;
}

/** The staged runtime to bundle, from `--skip-stage` or by running the stager. */
function stageRuntime(options) {
	const runtime = join(REPO, "build", "runtime", TARGET);
	if (options.skipStage) {
		if (!existsSync(join(runtime, "MANIFEST.json")))
			throw new Error(`--skip-stage needs a staged runtime in ${runtime}; run without it once.`);
		say(`Using the staged runtime in ${runtime}`);
		return runtime;
	}
	run(process.execPath, [join(HERE, "stage-runtime.mjs"), "--target", TARGET, "--out", runtime]);
	return runtime;
}

/** Builds both installers and returns their paths; fails naming the one the bundler left out. */
function buildInstallers(runtime) {
	const { productName, version } = JSON.parse(readFileSync(join(TAURI, "tauri.conf.json"), "utf8"));
	const config = windowsReleaseConfig({ runtime });
	say(`tauri build --bundles nsis,msi (release, runtime ${runtime})`);
	run(
		"pnpm",
		[
			"--filter",
			"@gentle-dot/desktop",
			"exec",
			"tauri",
			"build",
			"--bundles",
			"nsis,msi",
			"--config",
			JSON.stringify(config),
		],
		// CI in package-mac's sense: no interactive bundler behaviour.
		{ cwd: REPO, env: { ...process.env, CI: "true" } },
	);
	const names = windowsInstallerNames(productName, version);
	const installers = { NSIS: join(BUNDLE, "nsis", names.nsis), MSI: join(BUNDLE, "msi", names.msi) };
	for (const [kind, path] of Object.entries(installers))
		if (!existsSync(path)) throw new Error(`Tauri left no ${kind} installer at ${path}.`);
	return installers;
}

/** Locates 7-Zip, or explains why `--check` cannot inspect the NSIS payload. */
function sevenZip() {
	for (const candidate of sevenZipCandidates()) {
		const probe = spawnSync(candidate, ["i"], { encoding: "utf8" });
		if (!probe.error && probe.status === 0) return candidate;
	}
	throw new Error(
		"--check inspects the NSIS payload with 7-Zip, and none was found. Install 7-Zip, or set " +
			"SEVEN_ZIP to its 7z.exe (the MSI needs no extra tool: msiexec is part of Windows).",
	);
}

/** The `runtime/` tree an extractor produced, wherever inside `dir` it landed. */
function findRuntime(dir) {
	if (existsSync(join(dir, "runtime", "MANIFEST.json"))) return join(dir, "runtime");
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const found = findRuntime(join(dir, entry.name));
		if (found) return found;
	}
	return undefined;
}

/** Extracts an NSIS installer's payload with 7-Zip, which reads Tauri's NSIS format. */
function extractNsis(installer, into) {
	const seven = sevenZip();
	say(`Extracting the NSIS payload with ${seven}`);
	mkdirSync(into, { recursive: true });
	run(seven, ["x", "-y", `-o${into}`, installer], { stdio: "pipe" });
	const runtime = findRuntime(into);
	if (!runtime) throw new Error(`The NSIS installer carries no runtime/ tree (extracted to ${into}).`);
	return runtime;
}

/**
 * Extracts an MSI's payload with `msiexec /a`: an administrative installation writes the
 * file tree without installing the product or touching the registry. WiX's own `dark.exe`
 * is not used because it was measured to flatten every file to its WiX File Id.
 */
function extractMsi(installer, into) {
	say("Extracting the MSI payload with msiexec /a (administrative extraction, not an install)");
	mkdirSync(into, { recursive: true });
	const result = spawnSync("msiexec", ["/a", installer, "/qn", `TARGETDIR=${into}`], { stdio: "inherit" });
	if (result.status !== 0)
		throw new Error(`msiexec /a failed (${result.error?.message ?? `exit ${result.status}`}).`);
	const runtime = findRuntime(into);
	if (!runtime) throw new Error(`The MSI carries no runtime/ tree (extracted to ${into}).`);
	return runtime;
}

/** Checks one extracted payload against the staged runtime: the whole tree, then the bytes. */
async function verifyPayload(kind, extracted, stagedRuntime, stagedFiles) {
	const differences = payloadDifferences(stagedFiles, filesIn(extracted));
	if (differences.missing.length > 0)
		throw new Error(
			`${kind}: ${differences.missing.length} staged files are absent from the payload, e.g. ` +
				differences.missing.slice(0, 5).join(", "),
		);
	if (differences.extra.length > 0)
		throw new Error(
			`${kind}: the payload holds ${differences.extra.length} files the staged runtime does not, e.g. ` +
				differences.extra.slice(0, 5).join(", "),
		);
	const sample = [...RUNTIME_HASH_SAMPLE, ...stagedFiles.filter(isGentleAiBinary)];
	for (const relative of sample) {
		const [stagedHash, payloadHash] = await Promise.all([
			sha256File(join(stagedRuntime, relative)),
			sha256File(join(extracted, relative)),
		]);
		if (stagedHash !== payloadHash) throw new Error(`${kind}: ${relative} changed on its way in.`);
	}
	say(`  ${kind}: all ${stagedFiles.length} staged files present, ${sample.length} hashes match`);
}

async function main() {
	const options = parseWindowsArgs(process.argv.slice(2));
	assertHostTarget(TARGET);
	const runtime = stageRuntime(options);
	const installers = buildInstallers(runtime);
	const sizes = {};
	for (const [kind, path] of Object.entries(installers)) {
		const size = statSync(path).size;
		sizes[kind] = size;
		say(`${kind}: ${path}: ${formatSize(size)} (${size} bytes)`);
		// A bundle with no payload at all is a build failure, not a smaller installer.
		if (size < 1024 * 1024) throw new Error(`${kind} is ${size} bytes: that is no installer with a payload.`);
	}
	if (!options.check) return;

	const stagedFiles = filesIn(runtime);
	say(
		`Checking the payloads against the staged runtime (${stagedFiles.length} files, ${formatSize(treeSize(runtime))})`,
	);
	const scratch = mkdtempSync(join(tmpdir(), "gentle-dot-windows-check-"));
	try {
		const extractedNsis = extractNsis(installers.NSIS, join(scratch, "nsis"));
		await verifyPayload("NSIS", extractedNsis, runtime, stagedFiles);
		const extractedMsi = extractMsi(installers.MSI, join(scratch, "msi"));
		await verifyPayload("MSI", extractedMsi, runtime, stagedFiles);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	say("Payload check: ok (both extractions were removed; nothing was installed)");
}

main().catch((error) => {
	process.stderr.write(`package-windows: ${error.message}\n`);
	process.exit(1);
});
