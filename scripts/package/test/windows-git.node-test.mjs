import assert from "node:assert/strict";
import test from "node:test";
import { isGentleAiBinary, payloadDifferences, RUNTIME_HASH_SAMPLE, windowsReleaseConfig } from "../lib.mjs";

// Retired MinGit staging tests are replaced by preservation checks for system-Git packaging.
test("system-Git packaging keeps the whole-directory resource mapping without a Git filter", () => {
	const options = Object.freeze({ runtime: "C:\\Owner runtime\\windows-x64" });
	assert.deepEqual(windowsReleaseConfig(options), {
		bundle: { resources: { [options.runtime]: "runtime" } },
	});
	assert.equal(options.runtime, "C:\\Owner runtime\\windows-x64");
	assert.throws(() => windowsReleaseConfig({}), {
		message: "windowsReleaseConfig needs the staged runtime path.",
	});
});

test("normal payload comparison preserves case/separator compatibility and reports all differences", () => {
	const staged = Object.freeze([
		"MANIFEST.json",
		"node/bin/node.exe",
		"daemon/cli.mjs",
		"daemon/native/windows-stop.node",
		"bin/engram.exe",
	]);
	const compatible = Object.freeze([
		"manifest.JSON",
		"NODE\\BIN\\node.exe",
		"daemon\\CLI.mjs",
		"daemon\\native\\windows-stop.node",
		"bin/engram.exe",
	]);
	assert.deepEqual(payloadDifferences(staged, compatible), { missing: [], extra: [] });
	const unexpected = Object.freeze(["MANIFEST.json", "node/bin/node.exe", "Git/cmd/git.exe", "other.bin"]);
	assert.deepEqual(payloadDifferences(staged, unexpected), {
		missing: ["bin/engram.exe", "daemon/cli.mjs", "daemon/native/windows-stop.node"],
		extra: ["git/cmd/git.exe", "other.bin"],
	});
	assert.deepEqual(staged, [
		"MANIFEST.json",
		"node/bin/node.exe",
		"daemon/cli.mjs",
		"daemon/native/windows-stop.node",
		"bin/engram.exe",
	]);
	assert.deepEqual(unexpected, ["MANIFEST.json", "node/bin/node.exe", "Git/cmd/git.exe", "other.bin"]);
});

test("normal hash sample and engine binary recognition remain intact without bundled Git", () => {
	assert.deepEqual(RUNTIME_HASH_SAMPLE, [
		"MANIFEST.json",
		"node/bin/node.exe",
		"daemon/native/windows-stop.node",
		"bin/pi.cmd",
		"bin/engram.exe",
		"daemon/cli.mjs",
	]);
	assert.equal(isGentleAiBinary("daemon/node_modules/gentle-pi/.gentle-ai/v1.2.3/gentle-ai.exe"), true);
	assert.equal(isGentleAiBinary("daemon\\node_modules\\gentle-pi\\.gentle-ai\\v1.2.3\\gentle-ai.exe"), true);
	assert.equal(isGentleAiBinary("git/cmd/git.exe"), false);
});
