import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hostTarget, parseMacArgs, nodeArchiveName, engramArchiveName } from "../lib.mjs";
import { parsePackageArgs } from "../linux-lib.mjs";

const scratchRoot = process.env.GENTLE_DOT_PACKAGE_TEST_ROOT ?? join(tmpdir(), "gentle-dot-arise-platform-installers-t1");
mkdirSync(scratchRoot, { recursive: true });
// Retained deliberately: cleanup belongs to the orchestrator, not this test.
const scratch = mkdtempSync(join(scratchRoot, "targets-"));
const out = join(scratch, "rejected-output");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "sentinel"), "unchanged");
const invoke = (name, args) => spawnSync(process.execPath,
 [fileURLToPath(new URL(`../${name}.mjs`, import.meta.url)), ...args],
 { encoding: "utf8", timeout: 15000 });
function rejected(name, args, message) {
 const before = readdirSync(out);
 const result = invoke(name, args);
 assert.equal(result.status, 1);
 assert.equal(result.stdout, "");
 assert.equal(result.stderr, `${name}: ${message}\n`);
 assert.deepEqual(readdirSync(out), before);
 assert.equal(readFileSync(join(out, "sentinel"), "utf8"), "unchanged");
}

test("macOS retains ARM default and signing switches; Intel uses official archive names", () => {
 assert.equal(parseMacArgs([], {}).target, "darwin-arm64");
 const options = parseMacArgs(["--target", "darwin-x64", "--skip-stage", "--sign", "Local"], {});
 assert.equal(options.target, "darwin-x64");
 assert.equal(options.skipStage, true);
 assert.equal(options.identity, "Local");
 assert.equal(hostTarget("darwin", "x64"), "darwin-x64");
 assert.equal(nodeArchiveName("24.14.1", "darwin-x64"), "node-v24.14.1-darwin-x64.tar.gz");
 assert.equal(engramArchiveName("3.4.0", "darwin-x64"), "engram_3.4.0_darwin_amd64.tar.gz");
});

test("Linux target aliases reuse existing architecture and Arch-package rules", () => {
 for (const [target, arch] of [["linux-x64", "amd64"], ["linux-arm64", "arm64"]]) {
  assert.deepEqual(parsePackageArgs(["--target", target]), parsePackageArgs(["--arch", arch]));
 }
 assert.deepEqual(parsePackageArgs(["--arch", "amd64"]), { arch: "amd64", archPackage: true });
 assert.equal(parsePackageArgs(["--arch", "arm64"]).archPackage, false);
});

test("bad targets and conflicting Linux selectors reject before output mutation", () => {
 rejected("package-mac", ["--target", "linux-x64"], "Unknown macOS target linux-x64; expected darwin-arm64 or darwin-x64.");
 rejected("package-linux", ["--target", "darwin-x64", "--out", out], "Unknown Linux target darwin-x64; expected linux-arm64 or linux-x64.");
 rejected("package-linux", ["--target", "linux-x64", "--arch", "arm64", "--out", out], "Use either --target or --arch, not both.");
});

test("macOS default and explicit targets reject non-native hosts before tooling", () => {
 for (const target of ["darwin-arm64", "darwin-x64"]) {
  if (target === hostTarget()) continue;
  const message = `Cannot stage ${target} on ${hostTarget() ?? `${process.platform}-${process.arch}`}: the runtime's dependencies include native pieces for the machine that installs them. Stage ${target} on a ${target} machine or container (Linux targets are staged inside a container).`;
  rejected("package-mac", ["--target", target, "--skip-stage"], message);
  if (target === "darwin-arm64") rejected("package-mac", ["--skip-stage"], message);
  rejected("stage-runtime", ["--target", target, "--out", out], message);
 }
});

test("repeated target selectors cannot hide earlier values or mutate artifacts", () => {
 for (const [name, valid, safety] of [
  ["stage-runtime", "darwin-x64", ["--engram-version", "invalid"]],
  ["package-mac", "darwin-x64", ["--sign"]],
  ["package-linux", "linux-x64", ["--engram-version", "invalid"]],
 ]) {
  for (const first of ["invalid", valid])
   rejected(name, ["--target", first, "--target", valid, ...safety], "--target may be specified only once.");
 }
 // Previous non-target flag behavior is deliberately unchanged.
 assert.equal(parseMacArgs(["--sign", "first", "--sign", "last"], {}).identity, "last");
 assert.equal(parsePackageArgs(["--arch", "arm64", "--arch", "amd64"]).arch, "amd64");
});

test("missing new argument values display updated usage without creating an output", () => {
 const result = invoke("package-linux", ["--target"]);
 assert.equal(result.status, 1);
 assert.equal(result.stdout, "");
 assert.equal(result.stderr, "package-linux: Unexpected argument --target.\nusage: package-linux (--arch <arm64|amd64> | --target <linux-arm64|linux-x64>) [--out <dir>] [--engram-version <x.y.z>] [--no-arch-package]\n");
 assert.equal(existsSync(join(out, "MANIFEST.json")), false);
});
