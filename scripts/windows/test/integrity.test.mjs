import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { REQUIRED, seal, verify } from "../runtime-integrity.mjs";

function fixture(_t, paths = REQUIRED) {
	const root = mkdtempSync(join(tmpdir(), "gentle-dot-integrity-"));
	// Retain inert fixtures; no test cleanup can delete a developer's runtime.
	for (const path of [...paths, "daemon/node_modules/gentle-pi/.gentle-ai/v4/gentle-ai.exe"]) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), /\.(exe|node)$/.test(path) ? "MZ-fixture-never-executed" : "fixture");
	}
	return root;
}
test("all runtime files match after sealing", (t) => {
	const root = fixture(t);
	const expected = seal(root);
	assert.ok(Object.keys(expected.files).length > REQUIRED.length);
	verify(root, expected);
});
test("corruption, omission and unexpected additions are rejected", (t) => {
	const root = fixture(t);
	const expected = seal(root);
	writeFileSync(join(root, "ui/index.html"), "corrupt");
	assert.throws(() => verify(root, expected), /mismatch/);
	writeFileSync(join(root, "ui/index.html"), "fixture");
	const node = REQUIRED.find((path) => path.endsWith("/node.exe"));
	renameSync(join(root, node), join(root, "omitted-node.exe"));
	assert.throws(() => verify(root, expected), /mismatch/);
	renameSync(join(root, "omitted-node.exe"), join(root, node));
	writeFileSync(join(root, "unexpected.txt"), "extra");
	assert.throws(() => verify(root, expected), /mismatch/);
});
test("missing native engine, wrong executable and absent UI fail before packaging", (t) => {
	const root = fixture(t);
	for (const path of REQUIRED.filter((path) => /\.(exe|node)$/.test(path))) {
		writeFileSync(join(root, path), "not an executable");
		assert.throws(() => seal(root), { message: `Not a Windows executable: ${path}` });
		writeFileSync(join(root, path), "MZ-fixture-never-executed");
	}
	renameSync(
		join(root, "daemon/node_modules/gentle-pi/.gentle-ai/v4/gentle-ai.exe"),
		join(root, "omitted-engine.exe"),
	);
	assert.throws(() => seal(root), /exactly one/);
	renameSync(join(root, "ui/index.html"), join(root, "omitted-index.html"));
	assert.throws(() => seal(root), /Missing runtime file/);
});
test("directory links cannot silently escape the packaged runtime", (t) => {
	const root = fixture(t);
	const outside = mkdtempSync(join(tmpdir(), "gentle-dot-outside-"));
	symlinkSync(outside, join(root, "outside"), process.platform === "win32" ? "junction" : "dir");
	assert.throws(() => seal(root), /links cannot be packaged/);
});
test("canonical staged Windows layout seals without obsolete node or pi executables", (t) => {
	const root = fixture(t, [
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
	]);
	const expected = seal(root);
	verify(root, expected);
	assert.ok(expected.files["node/bin/node.exe"]);
	assert.ok(expected.files["bin/pi.cmd"]);
	assert.ok(expected.files["daemon/native/windows-stop.node"]);
	assert.equal(expected.files["node/node.exe"], undefined);
	assert.equal(expected.files["bin/pi.exe"], undefined);
});
test("every required stage artifact and a unique native engine are mandatory", (t) => {
	const root = fixture(t);
	for (const path of REQUIRED) {
		const omitted = join(root, "omitted-artifact");
		renameSync(join(root, path), omitted);
		assert.throws(() => seal(root), { message: `Missing runtime file: ${path}` });
		renameSync(omitted, join(root, path));
	}
	const duplicate = join(root, "daemon/node_modules/gentle-pi/.gentle-ai/duplicate/gentle-ai.exe");
	mkdirSync(dirname(duplicate), { recursive: true });
	writeFileSync(duplicate, "MZ-fixture-never-executed");
	assert.throws(() => seal(root), /exactly one/);
});
test("verification rejects malformed manifests and revalidates a self-consistent bad payload", (t) => {
	const root = fixture(t);
	for (const invalid of [null, {}, { schema: 1, platform: "win32-x64", files: [] }])
		assert.throws(() => verify(root, invalid), /Invalid Windows runtime manifest/);
	const expected = seal(root);
	const node = REQUIRED.find((path) => path.endsWith("/node.exe"));
	writeFileSync(join(root, node), "not a Windows executable");
	// Matching hashes alone must not bypass executable admission.
	expected.files[node] = createHash("sha256").update("not a Windows executable").digest("hex");
	assert.throws(() => verify(root, expected), /Not a Windows executable/);
});
