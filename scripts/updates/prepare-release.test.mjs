import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyRelease } from './release.mjs';

const base = 'https://github.com/Gentleman-Programming/gentle-dot/releases/download/v1.2.3/';
const bytes = Buffer.from('synthetic package bytes\n');
const names = ['Gentle Dot_1.2.3_aarch64.dmg', 'gentle-dot_1.2.3_amd64.deb', 'gentle-dot_1.2.3_arm64.deb', 'gentle-dot-1.2.3-1-x86_64.pkg.tar.zst', 'gentle-dot-1.2.3-999999-aarch64.pkg.tar.zst'];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-'));
  const artifacts = names.map((file, i) => {
    writeFileSync(join(dir, file), bytes);
    return { platform: ['darwin-arm64', 'linux-amd64', 'linux-arm64', 'linux-amd64', 'linux-arm64'][i], format: ['dmg', 'deb', 'deb', 'pkg.tar.zst', 'pkg.tar.zst'][i], file, url: base + encodeURI(file) };
  });
  return { dir, recipe: { version: '1.2.3', artifacts } };
}
function run(args, script = 'prepare-release.mjs') {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, script), ...args], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function inventory(dir) {
  return readdirSync(dir).sort().map(name => {
    const path = join(dir, name), stat = lstatSync(path);
    return [name, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
      stat.isDirectory() ? inventory(path) : stat.isFile() ? readFileSync(path).toString('hex') : null];
  });
}
function invoke(f, expectedError) {
  const input = join(f.dir, 'recipe.json');
  writeFileSync(input, JSON.stringify(f.recipe));
  const before = inventory(f.dir);
  const result = run(['--input', input]);
  assert.deepEqual(inventory(f.dir), before);
  if (expectedError) assert.deepEqual(result, { status: 1, stdout: '', stderr: `Error: ${expectedError}\n` });
  return result;
}

test('public CLI produces exact unsigned hashes/counts for every T1 pair', () => {
  const f = fixture(), result = invoke(f);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const expected = { schemaVersion: 1, version: '1.2.3', artifacts: f.recipe.artifacts.map(({ file, ...a }) => ({ ...a, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })) };
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
});

test('public CLI rejects invalid recipes and packages without effects', t => {
  const cases = [
    [r => r.extra = true, 'Invalid recipe'],
    [r => r.version = '01.2.3', 'Invalid version'],
    [r => r.version = 123, 'Invalid version'],
    [r => r.version = '1.2.3-beta', 'Invalid version'],
    [r => r.version = '1'.repeat(33), 'Invalid version'],
    [r => r.artifacts = null, 'Invalid artifacts'],
    [r => r.artifacts[0] = null, 'Invalid recipe artifact'],
    [r => r.version = '9007199254740992.0.0', 'Invalid version'],
    [r => r.artifacts = [], 'Invalid artifacts'],
    [r => r.artifacts.push(r.artifacts[0]), 'Invalid artifacts'],
    [r => r.artifacts = [r.artifacts[0], r.artifacts[0]], 'Duplicate artifact'],
    [r => r.artifacts[0].platform = 'windows-amd64', 'Unsupported platform or format'],
    [r => r.artifacts[0].format = 'deb', 'Unsupported platform or format'],
    [r => r.artifacts[0].url += '?download=1', 'Invalid artifact URL'],
    [r => r.artifacts[0].url = r.artifacts[0].url.replace('github.com', 'example.com'), 'Invalid artifact URL'],
    [r => r.artifacts[0].url = r.artifacts[0].url.replace('%20', ' '), 'Invalid artifact URL'],
    [r => r.artifacts[3].url = base + 'gentle-dot-1.2.3-01-x86_64.pkg.tar.zst', 'Invalid artifact URL'],
    [r => r.artifacts[0].url = base + 'Gentle%20Dot_1.2.4_aarch64.dmg', 'Invalid artifact URL'],
    [r => r.artifacts[3].url = base + 'gentle-dot-1.2.3-0-x86_64.pkg.tar.zst', 'Invalid artifact URL'],
    [r => r.artifacts[3].url = base + 'gentle-dot-1.2.3-1000000-x86_64.pkg.tar.zst', 'Invalid artifact URL'],
    [r => r.artifacts[0].file = names[1], 'Artifact filename mismatch'],
    [r => r.artifacts[0].file = 1, 'Invalid recipe artifact'],
    [r => r.artifacts[0].size = 1, 'Invalid recipe artifact'],
    [r => r.artifacts[0].url = null, 'Invalid artifact URL'],
  ];
  for (const [change, error] of cases) {
    const f = fixture(); change(f.recipe); invoke(f, error);
  }
  for (const kind of ['empty', 'directory', 'missing']) {
    const f = fixture();
    const folder = join(f.dir, 'other'); mkdirSync(folder);
    const path = join(folder, names[0]);
    f.recipe.artifacts[0].file = 'other/' + names[0];
    if (kind === 'empty') writeFileSync(path, '');
    if (kind === 'directory') mkdirSync(path);
    invoke(f, kind === 'empty' ? 'Invalid artifact integrity metadata' : 'Cannot read artifact file');
  }
  const f = fixture();
  mkdirSync(join(f.dir, 'links'));
  try { symlinkSync(join(f.dir, names[0]), join(f.dir, 'links', names[0])); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.diagnostic(`Symlink creation unavailable: ${error.code}; no symlink proof`);
    return;
  }
  f.recipe.artifacts[0].file = 'links/' + names[0];
  invoke(f, 'Cannot read artifact file');
});

test('draft is never a trusted release, even with null key', () => {
  const result = invoke(fixture());
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.throws(() => verifyRelease(JSON.parse(result.stdout), null, { platform: 'linux-amd64', currentVersion: '1.2.2' }), { message: 'Invalid envelope' });
});

test('help and option rejection; existing sign/verify preserve public behavior', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0); assert.equal(help.stderr, '');
  assert.match(help.stdout, /UNSIGNED DRAFT/);
  for (const args of [[], ['--input'], ['--other', 'x'], ['--input', 'x', '--input', 'y']]) {
    assert.deepEqual(run(args), { status: 1, stdout: '', stderr: 'Error: Invalid command or options\n' });
  }
  const f = fixture();
  writeFileSync(join(f.dir, 'bad.json'), '{');
  assert.deepEqual(run(['--input', join(f.dir, 'bad.json')]), { status: 1, stdout: '', stderr: 'Error: Invalid JSON\n' });
  for (const mode of ['sign', 'verify']) {
    assert.deepEqual(run([mode, '--input', 'recipe.json'], 'release.mjs'), { status: 1, stdout: '', stderr: 'Error: Invalid command or options\n' });
  }
  const oldHelp = run(['--help'], 'release.mjs');
  assert.equal(oldHelp.status, 0); assert.equal(oldHelp.stderr, '');
  assert.match(oldHelp.stdout, /Sign emits an envelope; verify emits verified JSON only on success/);
});
