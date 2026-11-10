import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function invoke(name, args) {
 return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
  fileURLToPath(new URL(`../${name}.ps1`, import.meta.url)), ...args],
 { encoding: "utf8", timeout: 15000, windowsHide: true });
}
const usage = "usage: stage.ps1 [-Target <windows-x64|windows-arm64>] [-CheckHost] [-Help]\n";
test("Windows staging help documents default and native host check without staging", { skip: process.platform !== "win32" }, () => {
 const result = invoke("stage", ["-Help"]);
 assert.equal(result.status, 0);
 assert.equal(result.stdout.replaceAll("\r\n", "\n"), usage);
 assert.equal(result.stderr, "");
});
test("native Windows host validation preserves the x64 default and rejects mismatched tools", { skip: process.platform !== "win32" }, () => {
 const path = fileURLToPath(new URL("../stage.ps1", import.meta.url)).replaceAll("'", "''");
 for (const [args, node, go, code] of [
  ["", "x64", "amd64", process.arch === "x64" ? 0 : 2],
  [`-Target windows-${process.arch}`, process.arch, process.arch === "x64" ? "amd64" : "arm64", 0],
  [`-Target windows-${process.arch}`, "ia32", "amd64", 2],
  [`-Target windows-${process.arch}`, process.arch, "386", 2],
 ]) {
  const script = `function global:node { $global:LASTEXITCODE = 0; 'win32-${node}' }; function global:go { $global:LASTEXITCODE = 0; 'windows'; '${go}' }; & '${path}' ${args} -CheckHost; exit $LASTEXITCODE`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, code, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.replaceAll("\r\n", "\n"), code === 0 ? "" : `Run on native windows-${args ? process.arch : "x64"} with matching Node, Go and Rust toolchains.\n`);
 }
});

test("Windows producers reject unknown and non-native targets before any tooling", { skip: process.platform !== "win32" }, () => {
 const output = new URL("../../../build/windows/", import.meta.url);
 const before = existsSync(output) ? readdirSync(output) : null;
 for (const name of ["stage", "package"]) {
  const invalid = invoke(name, ["-Target", "windows-ia32"]);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr.replaceAll("\r\n", "\n"), "Unknown Windows target windows-ia32; expected windows-x64 or windows-arm64.\n");
  const other = process.arch === "arm64" ? "windows-x64" : "windows-arm64";
  const mismatch = invoke(name, ["-Target", other]);
  assert.equal(mismatch.status, 2);
  assert.equal(mismatch.stdout, "");
  assert.equal(mismatch.stderr.replaceAll("\r\n", "\n"), `Run on native ${other} with matching Node, Go and Rust toolchains.\n`);
 }
 assert.deepEqual(existsSync(output) ? readdirSync(output) : null, before);
});
test("Windows target plumbing retains checksum sealing, per-user NSIS and path guards", () => {
 const stage = readFileSync(new URL("../stage.ps1", import.meta.url), "utf8");
 const pack = readFileSync(new URL("../package.ps1", import.meta.url), "utf8");
 assert.match(stage, /\$Target = 'windows-x64'/);
 assert.match(stage, /\$engramArch = if \(\$arch -eq 'x64'\) \{ 'amd64' \} else \{ 'arm64' \}/);
 assert.match(stage, /node-v\$nodeVersion-win-\$arch/);
 assert.match(stage, /runtime-integrity.mjs/);
 assert.match(stage, /Checksum mismatch/);
 assert.match(pack, /installMode = 'currentUser'/);
 assert.match(pack, /installer-path-guard.mjs/);
 assert.match(pack, /stage.ps1" -Target \$Target -CheckHost/);
 assert.match(pack, /stage.ps1" -Target \$Target\s/);
});
