import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { lockedDependenciesFromLock, runtimeManifest } from "../src/runtime-manifest.ts";

const SDK = "@earendil-works/pi-coding-agent";
const CODEMODE = "@earendil-works/pi-codemode";
const lock = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
const pins = Object.freeze({
	"@earendil-works/pi-ai": "1.5.0",
	[SDK]: "1.5.0",
	"@earendil-works/pi-mcp": "1.5.0",
	"@earendil-works/pi-tui": "1.5.0",
	"gentle-pi": "4.6.0",
	jiti: "2.7.0",
	ws: "8.22.0",
});

test("retains the seven exact importer pins and excludes workspace/dev dependencies", () => {
	assert.deepEqual(lockedDependenciesFromLock(lock), pins);
});

test("retains private ESM identity and does not mutate provided dependencies", () => {
	const manifest = runtimeManifest(lock, pins);
	assert.equal(manifest.name, "gentle-dot-runtime");
	assert.equal(manifest.private, true);
	assert.equal(manifest.type, "module");
	assert.deepEqual(manifest.dependencies, pins);
	assert.notEqual(manifest.dependencies, pins);
	manifest.dependencies.ws = "changed";
	assert.equal(pins.ws, "8.22.0");
});

test("pins the SDK-selected codemode snapshot in the public npm manifest", () => {
	assert.deepEqual(runtimeManifest(lock, pins).overrides, { [CODEMODE]: "1.5.0" });
});

const sdkRef = "1.0.4(peer@2.0.0)";
function fixture(codemodeRef = "1.0.4") {
	return `lockfileVersion: '9.0'
importers:
  packages/daemon:
    dependencies:
      '${SDK}':
        specifier: ^1.0.4
        version: ${sdkRef}
      '@gentle-dot/protocol':
        specifier: workspace:*
        version: link:../protocol
    devDependencies:
      esbuild:
        version: 0.28.2
packages:
  '${SDK}@1.0.4':
    resolution: {}
  '${CODEMODE}@${codemodeRef.split("(")[0]}':
    resolution: {}
snapshots:
  '${CODEMODE}@1.3.0': {}
  '${SDK}@9.0.0':
    dependencies:
      '${CODEMODE}': 1.3.0
  '${SDK}@${sdkRef}':
    dependencies:
      '${CODEMODE}': ${codemodeRef}
  '${CODEMODE}@${codemodeRef}': {}
`;
}
const selected = Object.freeze({ [SDK]: "1.0.4" });

test("selects the exact importer snapshot, not the first global SDK/codemode entry", () => {
	const input = fixture();
	assert.deepEqual(lockedDependenciesFromLock(input), selected);
	assert.deepEqual(runtimeManifest(input, selected).overrides, { [CODEMODE]: "1.0.4" });
});

test("strips nested peer annotations without leaking them into npm overrides", () => {
	const input = fixture("1.0.4(peer@2.0.0(nested@3.0.0))");
	assert.deepEqual(runtimeManifest(input, selected).overrides, { [CODEMODE]: "1.0.4" });
});

test("derives the version rather than hardcoding the current healthy pin", () => {
	assert.deepEqual(runtimeManifest(fixture("1.0.5"), selected).overrides, { [CODEMODE]: "1.0.5" });
});

test("rejects a missing selected codemode package source record", () => {
	const input = fixture().replace(`  '${CODEMODE}@1.0.4':\n    resolution: {}\n`, "");
	assert.throws(() => runtimeManifest(input, selected), /Missing or ambiguous lock entry/);
});

const invalidSources = [
	["missing packages section", (s) => s.replace("packages:", "otherPackages:")],
	["missing selected SDK source", (s) => s.replace(`  '${SDK}@1.0.4':\n    resolution: {}\n`, "")],
	["mismatched SDK source version", (s) => s.replace(`  '${SDK}@1.0.4':`, `  '${SDK}@1.0.5':`)],
	[
		"mismatched codemode source version",
		(s) =>
			s.replace(`  '${CODEMODE}@1.0.4':\n    resolution: {}`, `  '${CODEMODE}@1.3.0':\n    resolution: {}`),
	],
	["ambiguous selected SDK source", (s) => s.replace("snapshots:", `  '${SDK}@1.0.4': {}\nsnapshots:`)],
	[
		"ambiguous selected codemode source",
		(s) => s.replace("snapshots:", `  '${CODEMODE}@1.0.4': {}\nsnapshots:`),
	],
];
for (const [name, corrupt] of invalidSources) {
	test(`rejects ${name} without mutating provided pins`, () => {
		assert.throws(() => runtimeManifest(corrupt(fixture()), selected), /Missing or ambiguous lock entry/);
		assert.deepEqual(selected, { [SDK]: "1.0.4" });
	});
}

const invalidLocks = [
	["missing importer", (s) => s.replace("  packages/daemon:", "  packages/other:")],
	["missing SDK direct pin", (s) => s.replace(`      '${SDK}':`, "      other:")],
	["missing SDK snapshot", (s) => s.replace(`  '${SDK}@${sdkRef}':`, `  '${SDK}@1.0.5':`)],
	["peer context mismatch", (s) => s.replace(`  '${SDK}@${sdkRef}':`, `  '${SDK}@1.0.4(other@2.0.0)':`)],
	["missing codemode dependency", (s) => s.replace(`      '${CODEMODE}': 1.0.4`, "      other: 1.0.4")],
	["missing codemode snapshot", (s) => s.replace(`  '${CODEMODE}@1.0.4': {}`, "")],
	["missing snapshots", (s) => s.replace("snapshots:", "packages:")],
	["ambiguous SDK snapshot", (s) => `${s}  '${SDK}@${sdkRef}': {}\n`],
	["ambiguous codemode snapshot", (s) => `${s}  '${CODEMODE}@1.0.4': {}\n`],
	[
		"ambiguous codemode dependency",
		(s) => s.replace(`      '${CODEMODE}': 1.0.4`, `      '${CODEMODE}': 1.0.4\n      '${CODEMODE}': 1.0.5`),
	],
	["ambiguous importer", (s) => s.replace("packages:", "  packages/daemon: {}\npackages:")],
	["ambiguous version", (s) => s.replace(`version: ${sdkRef}`, `version: ${sdkRef}\n        version: 1.0.5`)],
	["range SDK reference", (s) => s.replaceAll(sdkRef, "^1.0.4")],
	[
		"unsupported inline SDK dependencies",
		(s) =>
			s.replace(`  '${SDK}@${sdkRef}':\n    dependencies:`, `  '${SDK}@${sdkRef}':\n    dependencies: {}`),
	],
];
for (const [name, corrupt] of invalidLocks) {
	test(`rejects ${name} without mutating provided pins`, () => {
		assert.throws(() => runtimeManifest(corrupt(fixture()), selected));
		assert.deepEqual(selected, { [SDK]: "1.0.4" });
	});
}

for (const version of [
	"^1.0.4",
	"latest",
	"npm:other@1.0.4",
	"file:../code",
	"01.0.4",
	"1.0.4junk",
	"1.0.4()",
	"1.0.4(peer@2.0.0",
	"1.0.4(peer@2.0.0))",
	"1.0.4-01",
]) {
	test(`rejects malformed codemode reference ${version}`, () => {
		assert.throws(() => runtimeManifest(fixture(version), selected), /Malformed resolved version/);
	});
}

test("rejects inconsistent provided dependencies, including SDK and missing/extra pins", () => {
	for (const dependencies of [{ [SDK]: "1.0.5" }, {}, { ...selected, extra: "1.0.0" }]) {
		Object.freeze(dependencies);
		assert.throws(() => runtimeManifest(fixture(), dependencies), /disagree/);
	}
});

test("native Node resolves the build's actual manifest helper import", async () => {
	const buildSourceFileURL = new URL("../src/runtime-build.ts", import.meta.url);
	const source = readFileSync(buildSourceFileURL, "utf8");
	const match = source.match(/import\s*\{[^}]*\bruntimeManifest\b[^}]*\}\s*from\s*["']([^"']+)["']/);
	assert.ok(match, "runtime-build must import the public manifest helper");
	const helper = await import(new URL(match[1], buildSourceFileURL));
	assert.equal(typeof helper.runtimeManifest, "function");
});

test("the build uses one platform-independent manifest and validates before emitting files", () => {
	const module = readFileSync(new URL("../src/runtime-build.ts", import.meta.url), "utf8");
	// The target also exports an explicit Go-helper builder. Its separate mkdir is not a
	// buildRuntime side effect; check ordering inside the actual runtime entry point only.
	const entrypoint = module.indexOf("export async function buildRuntime(");
	assert.ok(entrypoint >= 0);
	const source = module.slice(entrypoint);
	const creation = source.indexOf("const manifest = runtimeManifest(lockfile, dependencies);");
	assert.ok(creation > 0);
	assert.ok(creation < source.indexOf("mkdirSync("));
	assert.ok(creation < source.indexOf("const nativeArtifact = runtimeWindowsStopArtifact(platform);"));
	assert.match(source, /JSON\.stringify\(manifest, null, "\\t"\)/);
	const serialized = JSON.stringify(runtimeManifest(lock, pins));
	assert.deepEqual(JSON.parse(serialized), runtimeManifest(lock, pins));
});
