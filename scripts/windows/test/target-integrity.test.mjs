import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { REQUIRED, inventory, seal } from '../runtime-integrity.mjs';
import { stagedBudget } from '../installer-path-guard.mjs';

const area = process.env.GENTLE_DOT_PACKAGE_TEST_ROOT;
assert.ok(area, 'Set GENTLE_DOT_PACKAGE_TEST_ROOT to an authorized retained scratch root');
function fixture() {
 const root = mkdtempSync(join(area, 'identity-'));
 for (const path of [...REQUIRED, 'daemon/node_modules/gentle-pi/.gentle-ai/v4/gentle-ai.exe']) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), path.endsWith('.exe') ? 'MZ-static-fixture' : 'fixture');
 }
 return root;
}
function invoke(script, args) {
 return spawnSync(process.execPath, [fileURLToPath(new URL(`../${script}.mjs`, import.meta.url)), ...args], { encoding: 'utf8', timeout: 15000 });
}
function result(actual, code, stdout, stderr) {
 assert.equal(actual.error, undefined);
 assert.equal(actual.status, code);
 assert.equal(actual.stdout, stdout);
 assert.equal(actual.stderr, stderr);
}
function snapshot(root) {
 return { files: inventory(root), manifest: readFileSync(join(root, 'WINDOWS-INTEGRITY.json'), 'utf8') };
}

test('ARM64 identity propagates through sealing, verification and path guards; x64 default remains compatible', () => {
 for (const target of [undefined, 'windows-arm64']) {
  const root = fixture();
  const args = target ? [target] : [];
  result(invoke('runtime-integrity', ['seal', root, ...args]), 0, '', '');
  const platform = target ? 'win32-arm64' : 'win32-x64';
  assert.equal(JSON.parse(readFileSync(join(root, 'WINDOWS-INTEGRITY.json'))).platform, platform);
  result(invoke('runtime-integrity', ['verify', root, join(root, 'WINDOWS-INTEGRITY.json'), ...args]), 0, '', '');
  const budget = stagedBudget(root, target);
  assert.ok(budget.maxDestination > 3);
  const before = snapshot(root);
  result(invoke('installer-path-guard', ['destination', root, 'C:\\Fixture', ...args]), 0, 'C:\\Fixture\n', '');
  const hook = join(area, `hook-${platform}.nsh`);
  result(invoke('installer-path-guard', ['hook', root, hook, ...args]), 0, '', '');
  assert.match(readFileSync(hook, 'utf8'), /NSIS_HOOK_PREINSTALL/);
  assert.deepEqual(snapshot(root), before);
 }
});

test('corrupt verify retains legacy uncaught Error diagnostics and leaves fixture bytes unchanged', () => {
 const root = fixture();
 seal(root);
 writeFileSync(join(root, 'ui/index.html'), 'corrupted');
 const before = snapshot(root);
 const actual = invoke('runtime-integrity', ['verify', root, join(root, 'WINDOWS-INTEGRITY.json')]);
 assert.equal(actual.error, undefined);
 assert.equal(actual.status, 1);
 assert.equal(actual.stdout, '');
 assert.match(actual.stderr, /\r?\nError: Runtime integrity mismatch: ui\/index\.html\r?\n    at verify \(file:\/\/\/[^\r\n]+\/runtime-integrity\.mjs:\d+:\d+\)/);
 assert.match(actual.stderr, /\n    at file:\/\/\/[^\n]+\/runtime-integrity\.mjs:\d+:\d+/);
 assert.deepEqual(snapshot(root), before);
});

test('invalid-header seal retains legacy uncaught Error diagnostics and leaves fixture bytes unchanged', () => {
 const root = fixture();
 seal(root);
 writeFileSync(join(root, 'node/node.exe'), 'not a PE executable');
 const before = snapshot(root);
 const actual = invoke('runtime-integrity', ['seal', root]);
 assert.equal(actual.error, undefined);
 assert.equal(actual.status, 1);
 assert.equal(actual.stdout, '');
 assert.match(actual.stderr, /\r?\nError: Not a Windows executable: node\/node\.exe\r?\n    at seal \(file:\/\/\/[^\r\n]+\/runtime-integrity\.mjs:\d+:\d+\)/);
 assert.match(actual.stderr, /\n    at file:\/\/\/[^\n]+\/runtime-integrity\.mjs:\d+:\d+/);
 assert.deepEqual(snapshot(root), before);
});

test('unsupported or mismatched identities reject without modifying runtime, manifest, output or counters', () => {
 const root = fixture();
 seal(root);
 const before = snapshot(root);
 const output = join(area, 'identity-rejected-hook.nsh');
 writeFileSync(output, 'unchanged');
 const counter = join(area, 'identity-counter.txt');
 writeFileSync(counter, '0');
 const reference = join(root, 'WINDOWS-INTEGRITY.json');
 for (const target of ['windows-ia32', 'windows-arm64']) {
  const message = target === 'windows-ia32' ? 'Unsupported Windows runtime target: windows-ia32' : 'Windows runtime target mismatch: expected win32-arm64, got win32-x64';
  if (target === 'windows-ia32') result(invoke('runtime-integrity', ['seal', root, target]), 2, '', `${message}\n`);
  result(invoke('runtime-integrity', ['verify', root, reference, target]), 2, '', `${message}\n`);
  for (const mode of ['hook', 'destination'])
   result(invoke('installer-path-guard', [mode, root, mode === 'hook' ? output : 'C:\\Fixture', target]), 2, '', `${message}\n`);
  assert.deepEqual(snapshot(root), before);
  assert.equal(readFileSync(output, 'utf8'), 'unchanged');
  assert.equal(readFileSync(counter, 'utf8'), '0');
 }
});
