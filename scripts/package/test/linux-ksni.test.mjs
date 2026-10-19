import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as linuxLib from "../linux-lib.mjs";

const { parsePackageArgs, PACKAGE_USAGE, dockerEnvArgs } = linuxLib;

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const readRepo = (rel) => readFileSync(`${REPO}/${rel}`, "utf8");

describe("linux KSNI tray packaging option", () => {
	it("keeps the ordinary default: no opt-in flag without --ksni-tray", () => {
		const options = parsePackageArgs(["--arch", "amd64"]);
		assert.ok(!options.ksniTray, "default build must not enable the KSNI backend");
		assert.equal(options.archPackage, true);
	});

	it("parses the explicit --ksni-tray opt-in without changing Arch eligibility", () => {
		assert.equal(parsePackageArgs(["--arch", "amd64", "--ksni-tray"]).ksniTray, true);
		assert.equal(
			parsePackageArgs(["--arch", "amd64", "--ksni-tray"]).archPackage,
			true,
		);
		assert.equal(parsePackageArgs(["--arch", "arm64", "--ksni-tray"]).archPackage, false);
		assert.equal(
			parsePackageArgs(["--arch", "amd64", "--ksni-tray", "--out", "/tmp/o"]).out,
			"/tmp/o",
		);
	});

	it("keeps --ksni-tray a bare switch and still refuses lookalikes", () => {
		assert.throws(() => parsePackageArgs(["--arch", "amd64", "--ksni"]), /Unexpected argument/);
		assert.throws(
			() => parsePackageArgs(["--arch", "amd64", "--ksni-tray", "yes"]),
			/Unexpected argument/,
		);
	});

	it("documents the flag in the packaging usage", () => {
		assert.ok(PACKAGE_USAGE.includes("--ksni-tray"), `usage lacks --ksni-tray: ${PACKAGE_USAGE}`);
	});

	it("passes the flag to Docker as a fixed boolean env entry, never free text", () => {
		assert.deepEqual(dockerEnvArgs({}), []);
		assert.deepEqual(dockerEnvArgs({ ksniTray: false }), []);
		assert.deepEqual(dockerEnvArgs({ engramVersion: "3.2.1" }), ["-e", "ENGRAM_VERSION=3.2.1"]);
		assert.deepEqual(dockerEnvArgs({ ksniTray: true }), ["-e", "GENTLE_DOT_KSNI_TRAY=1"]);
		assert.deepEqual(dockerEnvArgs({ engramVersion: "3.2.1", ksniTray: true }), [
			"-e",
			"ENGRAM_VERSION=3.2.1",
			"-e",
			"GENTLE_DOT_KSNI_TRAY=1",
		]);
	});

	it("wires the flag from package-linux.mjs into the Docker invocation", () => {
		const source = readRepo("scripts/package/package-linux.mjs");
		assert.ok(source.includes("ksniTray"), "package-linux.mjs never reads the ksniTray option");
		assert.ok(
			source.includes("dockerEnvArgs"),
			"package-linux.mjs never builds the container env through dockerEnvArgs",
		);
		// The fixed GENTLE_DOT_KSNI_TRAY entry itself lives in the unit-tested helper.
		assert.ok(
			readRepo("scripts/package/linux-lib.mjs").includes("GENTLE_DOT_KSNI_TRAY=1"),
			"linux-lib.mjs never defines the GENTLE_DOT_KSNI_TRAY container entry",
		);
	});

	it("build-deb.sh enables the Cargo feature only when the container env requests it", () => {
		const script = readRepo("docker/linux-package/build-deb.sh");
		assert.ok(
			script.includes("${GENTLE_DOT_KSNI_TRAY:-"),
			"build-deb.sh must read GENTLE_DOT_KSNI_TRAY with a set -u safe default",
		);
		assert.ok(
			script.includes("--features ksni-tray"),
			"build-deb.sh never passes --features ksni-tray to tauri build",
		);
		assert.ok(
			script.includes("tauri build --bundles deb"),
			"build-deb.sh lost the ordinary tauri build invocation",
		);
	});
});
