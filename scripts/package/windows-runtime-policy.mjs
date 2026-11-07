// Executable orchestration with explicit I/O: fixtures never invoke packaging tools.
import { join, resolve } from "node:path";
import {
	formatSize,
	isGentleAiBinary,
	payloadDifferences,
	RUNTIME_HASH_SAMPLE,
	sevenZipCandidates,
	windowsInstallerNames,
} from "./lib.mjs";
import { assertWindowsHost, parseWindowsArgs, WINDOWS_USAGE, windowsPackagePlan } from "./windows-lib.mjs";

function run(io, command, args, options = {}) {
	const result = io.spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
	if (result.error || result.status !== 0)
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`}).`,
		);
	return result;
}

function findRuntime(io, dir) {
	if (io.exists(join(dir, "runtime", "MANIFEST.json"))) return join(dir, "runtime");
	for (const name of io.directoriesIn(dir)) {
		const found = findRuntime(io, join(dir, name));
		if (found) return found;
	}
	return undefined;
}

function sevenZip(io) {
	for (const candidate of sevenZipCandidates(io.env)) {
		const probe = io.spawn(candidate, ["i"], { encoding: "utf8", windowsHide: true });
		if (!probe.error && probe.status === 0) return candidate;
	}
	throw new Error(
		"--check inspects the NSIS payload with 7-Zip, and none was found. Install 7-Zip, or set " +
			"SEVEN_ZIP to its 7z.exe (the MSI needs no extra tool: msiexec is part of Windows).",
	);
}

function extractNsis(io, installer, into, say) {
	const seven = sevenZip(io);
	say(`Extracting the NSIS payload with ${seven}`);
	io.mkdir(into);
	run(io, seven, ["x", "-y", `-o${into}`, installer], { stdio: "pipe" });
	const runtime = findRuntime(io, into);
	if (!runtime) throw new Error(`The NSIS installer carries no runtime/ tree (extracted to ${into}).`);
	return runtime;
}

function extractMsi(io, installer, into, say) {
	say("Extracting the MSI payload with msiexec /a (administrative extraction, not an install)");
	io.mkdir(into);
	const result = io.spawn("msiexec", ["/a", installer, "/qn", `TARGETDIR=${into}`], {
		stdio: "inherit",
		windowsHide: true,
	});
	if (result.error || result.status !== 0)
		throw new Error(`msiexec /a failed (${result.error?.message ?? `exit ${result.status}`}).`);
	const runtime = findRuntime(io, into);
	if (!runtime) throw new Error(`The MSI carries no runtime/ tree (extracted to ${into}).`);
	return runtime;
}

async function verifyPayload(io, kind, extracted, runtime, stagedFiles, say) {
	const differences = payloadDifferences(stagedFiles, io.filesIn(extracted));
	if (differences.missing.length)
		throw new Error(
			`${kind}: ${differences.missing.length} staged files are absent from the payload, e.g. ${differences.missing.slice(0, 5).join(", ")}`,
		);
	if (differences.extra.length)
		throw new Error(
			`${kind}: the payload holds ${differences.extra.length} files the staged runtime does not, e.g. ${differences.extra.slice(0, 5).join(", ")}`,
		);
	const sample = [...RUNTIME_HASH_SAMPLE, ...stagedFiles.filter(isGentleAiBinary)];
	for (const relative of sample) {
		const [stagedHash, payloadHash] = await Promise.all([
			io.sha256File(join(runtime, relative)),
			io.sha256File(join(extracted, relative)),
		]);
		if (stagedHash !== payloadHash) throw new Error(`${kind}: ${relative} changed on its way in.`);
	}
	say(`  ${kind}: all ${stagedFiles.length} staged files present, ${sample.length} hashes match`);
}

async function packageWindows(argv, io) {
	// Parse everything before touching state; malformed combinations cannot start a stage.
	const options = parseWindowsArgs(argv);
	const say = (line) => io.stdout(`${line}\n`);
	if (options.help) {
		say(WINDOWS_USAGE);
		return;
	}
	assertWindowsHost(io.platform, io.arch);
	const explicitRuntime = options.runtime !== undefined;
	const runtime = resolve(io.cwd, options.runtime ?? resolve(io.repo, "build/runtime/windows-x64"));
	const bundles = explicitRuntime ? "nsis" : "nsis,msi";
	if (!explicitRuntime && !options.skipStage) {
		run(io, io.node, [
			join(io.repo, "scripts/package/stage-runtime.mjs"),
			"--target",
			"windows-x64",
			"--out",
			runtime,
		]);
	} else if (!explicitRuntime && !io.exists(join(runtime, "MANIFEST.json"))) {
		throw new Error(`--skip-stage needs a staged runtime in ${runtime}; run without it once.`);
	}
	let manifest;
	try {
		manifest = io.readJson(join(runtime, "MANIFEST.json"));
	} catch {
		throw new Error(
			`Missing or invalid MANIFEST.json in ${runtime}; stage the Windows runtime explicitly first.`,
		);
	}
	const plan = windowsPackagePlan({
		repo: io.repo,
		runtime,
		platform: io.platform,
		arch: io.arch,
		node: io.node,
		manifest,
		isFile: io.isFile,
		isDirectory: io.isDirectory,
		bundles,
	});
	// Both routes admit the canonical stage/addon before loading platform compatibility.
	const compatibility = await io.applyConsole(runtime, { requireManifest: true });
	if (explicitRuntime) {
		say(`gentle-shell Windows console compatibility: ${JSON.stringify(compatibility)}`);
		say(
			`Using ${runtime}; tauri build --bundles nsis (no staging; the installer adds WebView2 when missing).`,
		);
	} else {
		if (options.skipStage) say(`Using the staged runtime in ${runtime}`);
		say(`  gentle-shell Windows console compatibility: ${JSON.stringify(compatibility)}`);
	}
	const tauri = join(io.repo, "apps/desktop/src-tauri");
	// Prior automatic/skip-stage routes read product metadata before invoking Tauri.
	let product = !explicitRuntime ? io.readJson(join(tauri, "tauri.conf.json")) : undefined;
	if (!explicitRuntime) say(`tauri build --bundles nsis,msi (release, runtime ${runtime})`);
	// Same upstream local JavaScript CLI and admission config; no .cmd shell invocation.
	const result = io.spawn(plan.program, plan.args, {
		cwd: plan.cwd,
		env: { ...io.env, ...plan.env, ...(!explicitRuntime ? { CI: "true" } : {}) },
		stdio: "inherit",
		windowsHide: true,
	});
	if (result.error || result.status !== 0)
		throw new Error(
			`Windows package build failed (${result.error?.message ?? `exit ${result.status}, signal ${result.signal ?? "none"}`}).`,
		);
	if (explicitRuntime) {
		say("NSIS build finished; installer/installed runtime has not been exercised by this command.");
		if (!options.check) return;
	}
	product ??= io.readJson(join(tauri, "tauri.conf.json"));
	const { productName, version } = product;
	const names = windowsInstallerNames(productName, version);
	const bundle = join(tauri, "target/release/bundle");
	const installers = {
		NSIS: join(bundle, "nsis", names.nsis),
		...(!explicitRuntime ? { MSI: join(bundle, "msi", names.msi) } : {}),
	};
	for (const [kind, path] of Object.entries(installers)) {
		if (!io.exists(path)) throw new Error(`Tauri left no ${kind} installer at ${path}.`);
	}
	for (const [kind, path] of Object.entries(installers)) {
		const size = io.size(path);
		say(`${kind}: ${path}: ${formatSize(size)} (${size} bytes)`);
		if (size < 1024 * 1024) throw new Error(`${kind} is ${size} bytes: that is no installer with a payload.`);
	}
	if (!options.check) return;
	const stagedFiles = io.filesIn(runtime);
	say(
		`Checking the payloads against the staged runtime (${stagedFiles.length} files, ${formatSize(io.treeSize(runtime))})`,
	);
	const scratch = io.makeScratch();
	try {
		const nsis = extractNsis(io, installers.NSIS, join(scratch, "nsis"), say);
		await verifyPayload(io, "NSIS", nsis, runtime, stagedFiles, say);
		if (installers.MSI) {
			const msi = extractMsi(io, installers.MSI, join(scratch, "msi"), say);
			await verifyPayload(io, "MSI", msi, runtime, stagedFiles, say);
		}
	} finally {
		io.removeScratch(scratch);
	}
	say(
		explicitRuntime
			? "Payload check: ok (NSIS extraction was removed; nothing was installed)"
			: "Payload check: ok (both extractions were removed; nothing was installed)",
	);
}

/** This is the executable's error/exit boundary, also used by inert CLI fixtures. */
export async function runWindowsCli(argv, io) {
	try {
		await packageWindows(argv, io);
		return 0;
	} catch (error) {
		io.stderr(`package-windows: ${error.message}\n`);
		return 1;
	}
}
