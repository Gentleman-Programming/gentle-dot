import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED = [
	"MANIFEST.json",
	"node/bin/node.exe",
	"bin/engram.exe",
	"bin/pi.cmd",
	"bin/private-storage.exe",
	"daemon/cli.mjs",
	"daemon/package.json",
	"daemon/native/windows-stop.node",
	"daemon/node_modules/gentle-pi/package.json",
	"daemon/node_modules/gentle-pi/bin/gentle-shell.mjs",
	"ui/index.html",
];
const MANIFEST = "WINDOWS-INTEGRITY.json";
export function inventory(root, relative = "", result = {}) {
	for (const name of readdirSync(join(root, relative))) {
		const path = relative ? `${relative}/${name}` : name;
		if (path === MANIFEST) continue;
		const stat = lstatSync(join(root, path));
		if (stat.isSymbolicLink()) throw new Error(`Runtime links cannot be packaged: ${path}`);
		if (stat.isDirectory()) inventory(root, path, result);
		else if (stat.isFile())
			result[path] = createHash("sha256")
				.update(readFileSync(join(root, path)))
				.digest("hex");
		else throw new Error(`Unsupported runtime entry: ${path}`);
	}
	return result;
}
function validatePayload(root, files) {
	for (const path of REQUIRED) if (!files[path]) throw new Error(`Missing runtime file: ${path}`);
	const native = Object.keys(files).filter(
		(path) => path.startsWith("daemon/node_modules/gentle-pi/.gentle-ai/") && path.endsWith("/gentle-ai.exe"),
	);
	if (native.length !== 1) throw new Error("Expected exactly one packaged Gentle AI executable");
	for (const path of [
		"node/bin/node.exe",
		"bin/engram.exe",
		"bin/private-storage.exe",
		"daemon/native/windows-stop.node",
		...native,
	]) {
		if (readFileSync(join(root, path)).subarray(0, 2).toString() !== "MZ")
			throw new Error(`Not a Windows executable: ${path}`);
	}
}
export function seal(root) {
	const files = inventory(root);
	validatePayload(root, files);
	const data = { schema: 1, platform: "win32-x64", files };
	writeFileSync(join(root, MANIFEST), `${JSON.stringify(data, null, 2)}\n`);
	return data;
}
export function verify(root, expected) {
	const actual = inventory(root);
	if (
		!expected ||
		expected.schema !== 1 ||
		expected.platform !== "win32-x64" ||
		!expected.files ||
		typeof expected.files !== "object" ||
		Array.isArray(expected.files)
	)
		throw new Error("Invalid Windows runtime manifest");
	for (const key of new Set([...Object.keys(expected.files), ...Object.keys(actual)])) {
		if (actual[key] !== expected.files[key]) throw new Error(`Runtime integrity mismatch: ${key}`);
	}
	validatePayload(root, actual);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [mode, root, reference] = process.argv.slice(2);
	if (mode === "seal" && root) seal(root);
	else if (mode === "verify" && root && reference) {
		let expected;
		try {
			expected = JSON.parse(readFileSync(reference, "utf8"));
		} catch (cause) {
			throw new Error("Cannot read Windows runtime manifest", { cause });
		}
		verify(root, expected);
	} else throw new Error("Usage: runtime-integrity.mjs seal ROOT | verify ROOT REFERENCE_MANIFEST");
}
