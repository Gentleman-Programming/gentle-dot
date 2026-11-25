#!/usr/bin/env node
// Builds the macOS installer (S29.2): stages the runtime, signs its nested code,
// builds the release app and DMG with Tauri, and verifies the result:
// `node scripts/package/package-mac.mjs [--sign <identity>] [--skip-stage] [--check]`.
// `--check-dmg <dmg>` only checks a built DMG: it mounts it read-only, copies the
// app to a temporary folder, and starts the copy's daemon on a clean HOME.
import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	rmdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AD_HOC,
	assertHostTarget,
	dmgFileName,
	formatSize,
	insideOut,
	isMachO,
	keepsOwnSignature,
	modeDifferences,
	parseMacArgs,
	sha256File,
	tauriReleaseConfig,
} from "./lib.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TAURI = join(REPO, "apps", "desktop", "src-tauri");
const HERE = join(REPO, "scripts", "package");

const say = (line) => process.stdout.write(`${line}\n`);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.status !== 0)
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`}).`,
		);
	return result;
}

/** Runs a command, prints what it wrote (codesign reports on stderr), and fails on a non-zero exit. */
function report(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	say(`$ ${command} ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")}`);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
	if (output) say(output.replace(/^/gm, "  "));
	if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (exit ${result.status}).`);
	return output;
}

/** Regular files under `dir`, relative to it; links are neither followed nor listed. */
function filesIn(dir, prefix = "") {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) found.push(...filesIn(join(dir, entry.name), relative));
		else if (entry.isFile()) found.push(relative);
	}
	return found;
}

function modes(dir) {
	return new Map(filesIn(dir).map((relative) => [relative, lstatSync(join(dir, relative)).mode]));
}

function machOFiles(dir) {
	const header = Buffer.alloc(8);
	return filesIn(dir).filter((relative) => {
		const fd = openSync(join(dir, relative), "r");
		try {
			const read = readSync(fd, header, 0, 8, 0);
			return isMachO(header.subarray(0, read));
		} finally {
			closeSync(fd);
		}
	});
}

const identityName = (identity) => (identity === AD_HOC ? "ad hoc" : `"${identity}"`);

/**
 * Signs the runtime's Mach-O files with `identity`, deepest first, before Tauri copies
 * them into the app and signs the app around them. Hardened runtime stays off: Node
 * needs JIT, and the N-API addons are signed by others (library validation).
 */
async function signRuntime(runtime, identity, target) {
	const binaries = machOFiles(runtime);
	const kept = binaries.filter(keepsOwnSignature);
	const signed = insideOut(binaries.filter((relative) => !keepsOwnSignature(relative)));
	say(`Signing ${signed.length} nested Mach-O files ${identityName(identity)}`);
	for (const relative of signed) {
		run("codesign", ["--force", "--sign", identity, "--timestamp=none", join(runtime, relative)]);
		say(`  signed ${relative}`);
	}
	const detached = new Map();
	for (const relative of kept) {
		const path = join(runtime, relative);
		// The pinned Intel 5.0.0 upstream binary is unsigned. For ad-hoc QA only,
		// sign it separately so the engine can still authenticate its original bytes.
		if (identity === AD_HOC && target === "darwin-x64" &&
			relative === "daemon/node_modules/gentle-pi/.gentle-ai/v5.0.0/gentle-ai") {
			const digest = await sha256File(path);
			// binarySha256 from gentle-pi@5.0.0's darwin/amd64 release recipe.
			if (digest !== "63c9833b8d6986ecc8aa6427f3d6e4375662bcdedca7d3b281502f941f0928fb")
				throw new Error("Gentle AI Intel binary differs from the upstream release pin");
			const signature = join(runtime, "gentle-ai-intel-qa.sig");
			run("codesign", ["--sign", identity, "--timestamp=none", "--detached", signature, path]);
			run("codesign", ["--verify", "--strict", "--detached", signature, path]);
			detached.set(relative, "gentle-ai-intel-qa.sig");
			say(`  unsigned upstream Intel binary preserved; detached ad-hoc QA signature verified: ${relative}`);
			continue;
		}
		run("codesign", ["--verify", "--strict", path]);
		say(`  kept its own signature (pinned digest): ${relative}`);
	}
	return { signed, kept, detached };
}

/** Checks the built app: its signature, its nested code, and that the runtime kept every file and mode. */
async function verifyApp(app, runtime, nested) {
	say(`Verifying ${app}`);
	report("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
	report("codesign", ["-dv", "--verbose=2", app]);
	const bundled = join(app, "Contents", "Resources", "runtime");
	const differences = modeDifferences(modes(runtime), modes(bundled));
	if (differences.length > 0)
		throw new Error(`The app's runtime differs from the staged one: ${differences.slice(0, 10).join(", ")}`);
	say(`  runtime: every staged file present with its mode (${filesIn(bundled).length} files)`);
	for (const relative of nested.signed) run("codesign", ["--verify", "--strict", join(bundled, relative)]);
	say(`  nested signatures valid in the app: ${nested.signed.length}`);
	for (const relative of nested.kept) {
		const [staged, copied] = await Promise.all([
			sha256File(join(runtime, relative)),
			sha256File(join(bundled, relative)),
		]);
		const signature = nested.detached.get(relative);
		if (signature) run("codesign", ["--verify", "--strict", "--detached", join(bundled, signature), join(bundled, relative)]);
		if (staged !== copied) throw new Error(`${relative} changed on its way into the app.`);
		say(`  unchanged bytes (sha256 ${copied.slice(0, 12)}…): ${relative}`);
	}
}

/**
 * Mounts the DMG read-only, copies the app out, and runs the copy's daemon on a
 * clean HOME, then from a read-only copy (`smoke-runtime.mjs`). The GUI is not launched.
 */
function checkDmg(dmg) {
	const scratch = mkdtempSync(join(tmpdir(), "gentle-dot-dmg-check-"));
	const mount = join(scratch, "mount");
	const copy = join(scratch, "copy");
	mkdirSync(mount);
	mkdirSync(copy);
	say(`Checking ${dmg} (scratch ${scratch})`);
	run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, dmg]);
	let app;
	try {
		for (const entry of readdirSync(mount, { withFileTypes: true })) {
			const path = join(mount, entry.name);
			const kind = entry.isSymbolicLink() ? `link → ${readlinkSync(path)}` : "folder or file";
			say(`  DMG: ${entry.name} (${kind})`);
		}
		const name = readdirSync(mount).find((entry) => entry.endsWith(".app"));
		if (!name) throw new Error("The DMG holds no app.");
		app = join(copy, name);
		run("ditto", [join(mount, name), app]);
	} finally {
		run("hdiutil", ["detach", mount]);
		rmdirSync(mount);
	}
	say(`Copied the app to ${app}`);
	report("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
	report("codesign", ["-dv", "--verbose=2", app]);
	report("codesign", ["-d", "-r-", app]);
	const runtime = join(app, "Contents", "Resources", "runtime");
	const smoke = join(HERE, "smoke-runtime.mjs");
	run(process.execPath, [smoke, "--runtime", runtime]);
	run(process.execPath, [smoke, "--runtime", runtime, "--read-only"]);
	rmSync(copy, { recursive: true });
	say(`DMG check: ok (the app copy was removed; smoke scratch folders are kept under ${tmpdir()})`);
}

async function main() {
	const options = parseMacArgs(process.argv.slice(2));
	const TARGET = options.target;
	assertHostTarget(TARGET);
	if (options.checkDmg) {
		checkDmg(resolve(process.env.INIT_CWD ?? process.cwd(), options.checkDmg));
		return;
	}

	// The Tauri CLI asks rustc for its version itself; a cargo wrapper that finds rustc on its own is not enough.
	const rust = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
	if (rust.status !== 0)
		throw new Error(
			"rustc is not on PATH; the Tauri CLI needs it (install Rust with rustup, or add it to PATH).",
		);

	const rustTarget = TARGET === "darwin-x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
	if (!rust.stdout.split(/\r?\n/).includes(`host: ${rustTarget}`))
		throw new Error(`Use a native ${rustTarget} Rust toolchain for ${TARGET}.`);
	// Keep the existing ARM output path; Intel builds select their target explicitly.
	const targetArgs = TARGET === "darwin-x64" ? ["--target", rustTarget] : [];
	const runtime = join(REPO, "build", "runtime", TARGET);
	if (options.skipStage) {
		if (!existsSync(join(runtime, "MANIFEST.json")))
			throw new Error(`--skip-stage needs a staged runtime in ${runtime}; run without it once.`);
		say(`Using the staged runtime in ${runtime}`);
	} else run(process.execPath, [join(HERE, "stage-runtime.mjs"), "--target", TARGET, "--out", runtime]);

	const nested = await signRuntime(runtime, options.identity, TARGET);

	// Tauri copies the signed runtime into the app, signs the app, and builds the DMG from it.
	// Unless asked, the DMG's Finder window is not scripted (CI): that needs Finder automation.
	const config = tauriReleaseConfig({ runtime, identity: options.identity });
	say(`tauri build --bundles app,dmg (release, signing ${identityName(options.identity)})`);
	const env = { ...process.env, APPLE_SIGNING_IDENTITY: options.identity };
	if (options.finderLayout) delete env.CI;
	else env.CI = "true";
	run(
		"pnpm",
		[
			"--filter",
			"@gentle-dot/desktop",
			"exec",
			"tauri",
			"build",
			...targetArgs,
			"--bundles",
			"app,dmg",
			"--config",
			JSON.stringify(config),
		],
		{ cwd: REPO, env },
	);

	const { productName, version } = JSON.parse(readFileSync(join(TAURI, "tauri.conf.json"), "utf8"));
	const bundle = join(TAURI, "target", ...(targetArgs.length ? [rustTarget] : []), "release", "bundle");
	const app = join(bundle, "macos", `${productName}.app`);
	const dmg = join(bundle, "dmg", dmgFileName(productName, version, TARGET.slice("darwin-".length)));
	if (!existsSync(dmg)) throw new Error(`Tauri left no ${dmg}.`);
	await verifyApp(app, runtime, nested);
	report("hdiutil", ["verify", dmg]);
	const size = statSync(dmg).size;
	say(`App: ${app}`);
	say(`DMG: ${dmg}: ${formatSize(size)} (${size} bytes), signed ${identityName(options.identity)}`);
	if (options.check) checkDmg(dmg);
}

main().catch((error) => {
	process.stderr.write(`package-mac: ${error.message}\n`);
	process.exit(1);
});
