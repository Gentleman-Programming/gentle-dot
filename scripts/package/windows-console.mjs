import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Published gentle-pi 4.6.0 source, not an ABI/version-range assertion. Revisit
// against the actual launch glue when the declared package changes.
const SOURCE_SHA256 = "f4e246c2da503ec84820b2dce067cc4a569b13809e5b2b9fa4001bbd677cc937";
const HELPERS = {
	"runtime/gentle-shell-launcher.mjs": "b8126047aaf75e498e05529ee0b24637b3f514bf4857b157132a3bd4efb6ecb7",
	"runtime/gentle-shell-startup-flow.mjs": "d50c85691c80bf7211fe61e659de6f6a55dcdc39b3c3b355457fbfe01ae6805b",
};
const hide = ', ...(process.platform === "win32" ? { windowsHide: true } : {})';
// Only child creation options change. planSpawn's command/argv/shell policy,
// setup/relaunch environments, signal forwarding and native ownership stay upstream-owned.
const OPTIONS = [
	"{ stdio, env, shell: launchPlan.shell }",
	"{ stdio }",
	'{ stdio: "inherit", env: next.env, shell: false }',
	'{ stdio: "inherit", env: childEnv, shell: launchPlan.shell }',
	"\t\tenv: bundledEnv ?? process.env,\n\t}",
];
const replacements = OPTIONS.map((original) => [
	original,
	original.endsWith(" }")
		? original.slice(0, -2) + hide + " }"
		: original.replace("\n\t}", `\n\t\t...(process.platform === "win32" ? { windowsHide: true } : {}),\n\t}`),
]);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function replaceOnce(source, from, to) {
	if (source.split(from).length !== 2) throw new Error("Unknown gentle-shell launch options.");
	return source.replace(from, to);
}

export function adaptGentleShell(source, metadata, platform = process.platform) {
	if (platform !== "win32") return source;
	if (
		metadata?.name !== "gentle-pi" ||
		metadata.version !== "4.6.0" ||
		metadata.bin?.["gentle-shell"] !== "bin/gentle-shell.mjs"
	)
		throw new Error("Windows console compatibility requires gentle-pi 4.6.0 and its declared launcher.");
	if (sha256(source) === SOURCE_SHA256)
		return replacements.reduce((text, [from, to]) => replaceOnce(text, from, to), source);
	// Accept our exact result, never a merely similar patch or a partial application.
	try {
		const original = replacements.reduce((text, [from, to]) => replaceOnce(text, to, from), source);
		if (sha256(original) === SOURCE_SHA256) return source;
	} catch {
		// Unknown/partially patched source remains closed.
	}
	throw new Error("Unknown gentle-shell source SHA-256; inspect the declared package before packaging.");
}

export function planWindowsConsole({
	source,
	metadata,
	manifest,
	requireManifest = false,
	platform = "win32",
}) {
	if (
		platform === "win32" &&
		requireManifest &&
		(manifest?.name !== "gentle-dot-runtime" || manifest.target !== "windows-x64")
	)
		throw new Error("Console adaptation requires an existing windows-x64 runtime manifest.");
	return adaptGentleShell(source, metadata, platform);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (cause) {
		throw new Error(`Cannot read console compatibility metadata: ${path}`, { cause });
	}
}

function readPackage(packageRoot) {
	const read = (relative) => {
		const path = join(packageRoot, relative);
		if (!lstatSync(path).isFile()) throw new Error(`Console source is not a regular file: ${relative}`);
		return readFileSync(path, "utf8");
	};
	const metadataSource = read("package.json");
	let metadata;
	try {
		metadata = JSON.parse(metadataSource);
	} catch (cause) {
		throw new Error("Cannot parse gentle-pi console compatibility metadata.", { cause });
	}
	const source = read("bin/gentle-shell.mjs");
	for (const [name, hash] of Object.entries(HELPERS)) {
		if (sha256(read(name)) !== hash) throw new Error(`Unknown gentle-shell launch helper SHA-256: ${name}`);
	}
	return { metadata, source };
}

/** Read-only local-source admission, before the stager replaces output or downloads. */
export function preflightWindowsConsole({
	platform = process.platform,
	packageRoot = fileURLToPath(new URL("../../packages/daemon/node_modules/gentle-pi/", import.meta.url)),
} = {}) {
	if (platform !== "win32") return;
	const { source, metadata } = readPackage(packageRoot);
	adaptGentleShell(source, metadata, platform);
}

/** Adapt only a validated staged copy; never the project's installed dependency. */
export function applyWindowsConsole(runtime, { platform = process.platform, requireManifest = false } = {}) {
	if (platform !== "win32") return;
	const manifest = requireManifest ? readJson(join(runtime, "MANIFEST.json")) : undefined;
	const packageRoot = join(runtime, "daemon", "node_modules", "gentle-pi");
	const { source, metadata } = readPackage(packageRoot);
	const adapted = planWindowsConsole({ source, metadata, manifest, requireManifest, platform });
	if (adapted !== source) writeFileSync(join(packageRoot, "bin", "gentle-shell.mjs"), adapted);
	return { gentlePi: metadata.version, sourceSha256: SOURCE_SHA256, adaptedSha256: sha256(adapted) };
}
