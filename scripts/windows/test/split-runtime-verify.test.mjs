import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../split-runtime-verify.mjs', import.meta.url));
// Keep isolated source copies separate from the authorized Windows fixtures.
const scratch = process.env.DOT_SPLIT_VERIFY_TEST_SCRATCH ??
  fileURLToPath(new URL('../../../build/split-runtime-test/', import.meta.url));
assert.ok(isAbsolute(scratch), 'fixture directory must be absolute');
const core = ['node/node.exe', 'bin/engram.exe', 'bin/pi.exe', 'bin/private-storage.exe', 'daemon/cli.mjs',
  'daemon/node_modules/gentle-pi/bin/gentle-shell.mjs', 'ui/index.html'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = 'public fixture\n';
const entry = path => ({ path, type: 'file', size: bytes.length, sha256: digest(bytes) });
const usage = 'Usage: node scripts/windows/split-runtime-verify.mjs verify ROOT MANIFEST EXPECTED_SHA256\n';
const help = usage + 'Verify an exclusively owned staged tree using an independently trusted manifest SHA-256.\n';

function fixture(t, extra = []) {
  mkdirSync(scratch, { recursive: true });
  const area = mkdtempSync(join(scratch, 'run-'));
  t.diagnostic(`Retained fixture (runner PID ${process.pid}): ${area}`);
  const root = join(area, 'runtime');
  const manifest = join(area, 'inventory.json');
  const files = [...core, ...extra].map(entry);
  const data = { schema: 1, target: 'windows-x64', shell: '5.0.0', pi: '1.6.0', files };
  for (const { path } of files) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  return { area, root, manifest, data };
}

function snapshot(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    return readdirSync(path).sort().map(name => [name, snapshot(join(path, name))]);
  }
  // Metadata only for links (including the public hard-link fixture).
  return [stat.mode, stat.nlink, stat.size, stat.mtimeMs,
    stat.isFile() && stat.nlink === 1 ? digest(readFileSync(path)) : null];
}

function invoke(args, status, stdout, stderr) {
  const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(run.error);
  assert.deepEqual({ status: run.status, stdout: run.stdout, stderr: run.stderr }, { status, stdout, stderr });
}

function verify(f, message, options = {}) {
  const raw = options.raw ?? JSON.stringify(f.data) + '\n';
  const manifest = options.manifest ?? f.manifest;
  writeFileSync(manifest, raw);
  const before = snapshot(f.area);
  try {
    invoke(['verify', options.root ?? f.root, manifest, options.expected ?? digest(raw)],
      message ? 1 : 0, message ? '' : 'Windows split runtime verified.\n',
      message ? `Windows split runtime refused: ${message}\n` : '');
  } finally {
    assert.deepEqual(snapshot(f.area), before);
  }
}

test('help and invalid invocation', () => {
  invoke(['--help'], 0, help, '');
  invoke(['verify', 'runtime', 'inventory.json'], 2, '', usage);
});

test('admits the complete pinned tree with extra listed files and dot-prefixed package names', t => {
  verify(fixture(t, ['daemon/node_modules/gentle-pi/.gentle-ai/v1/gentle-ai.exe']), null);
});

test('requires lowercase independent digest, hashes raw bytes first, then parses and admits exact metadata', t => {
  const f = fixture(t);
  const absent = join(f.area, 'absent');
  verify(f, 'expected SHA-256 must be 64 lowercase hex characters', { expected: 'A'.repeat(64), root: absent });
  verify(f, 'expected SHA-256 must be 64 lowercase hex characters', { expected: 'a'.repeat(63), root: absent });
  verify(f, 'manifest SHA-256 mismatch', { expected: digest(JSON.stringify(f.data)), root: absent });
  verify(f, 'manifest SHA-256 mismatch', { raw: '{', expected: '0'.repeat(64), root: absent });
  verify(f, 'manifest is not valid UTF-8 JSON', { raw: '{', root: absent });
  verify(f, 'manifest is not valid UTF-8 JSON', { raw: Buffer.from([0xff]), root: absent });
  verify(f, 'duplicate manifest field', { raw: JSON.stringify(f.data).replace('{', '{"schem\\u0061":2,'), root: absent });
  verify(f, 'duplicate manifest field', { raw: JSON.stringify(f.data).replace('"type":"file"', '"type":"directory","type":"file"'), root: absent });
  verify(f, 'unsafe input path', { root: join(f.area, 'audit', 'runtime') });
  for (const changes of [{ schema: 2 }, { target: 'windows-arm64' }, { shell: '5.0.1' }, { pi: '1.6.1' },
    { extra: true }, { files: {} }]) {
    verify(f, 'invalid manifest schema or runtime tuple', { raw: JSON.stringify({ ...f.data, ...changes }), root: absent });
  }
  for (const changes of [{ type: 'directory' }, { size: -1 }, { size: 0.5 }, { size: 2 ** 53 },
    { sha256: 'A'.repeat(64) }, { extra: true }]) {
    verify(f, 'invalid manifest file record', { raw: JSON.stringify({ ...f.data, files: [{ ...entry('file'), ...changes }] }), root: absent });
  }
  verify(f, 'manifest omits a required runtime file', { raw: JSON.stringify({ ...f.data, files: f.data.files.slice(1) }), root: absent });
});

test('rejects unsafe Windows names and case or file/directory collisions before touching the tree', t => {
  const f = fixture(t);
  for (const path of ['/x', 'C:/x', 'x:y', 'x\\y', 'x//y', 'x/../y', './x', 'x/', 'x./y', 'x /y',
    'x\n', 'x/é', 'CON.txt', 'x/COM1.js', 'LPT9', 'NUL', 'CONIN$', 'LONGNA~1', 'x/'.repeat(120) + 'x',
    'x'.repeat(121), 'x/.env.local', 'x/credentials.json', '.ssh/key', 'x/key.pem']) {
    verify(f, 'unsafe manifest path', { raw: JSON.stringify({ ...f.data, files: [...f.data.files, entry(path)] }), root: join(f.area, 'absent') });
  }
  for (const paths of [['bin/PI.exe'], ['bin/pi.exe'], ['bin/pi.exe/nested'], ['bin'], ['extra/a', 'EXTRA/b']]) {
    verify(f, 'manifest path collision', { raw: JSON.stringify({ ...f.data, files: [...f.data.files, ...paths.map(entry)] }) });
  }
});

test('manifest must be outside the staged tree', t => {
  const f = fixture(t);
  verify(f, 'manifest must be outside the staged tree', { manifest: join(f.root, 'inventory.json') });
  const linked = fixture(t);
  writeFileSync(linked.manifest, JSON.stringify(linked.data) + '\n');
  linkSync(linked.manifest, join(linked.root, 'alias.json'));
  const before = snapshot(linked.area);
  invoke(['verify', linked.root, linked.manifest, digest(JSON.stringify(linked.data) + '\n')], 1, '',
    'Windows split runtime refused: manifest path does not name a plain regular single-linked file\n');
  assert.deepEqual(snapshot(linked.area), before);
});

test('refuses missing and extra files, unexpected directories and in-tree integrity metadata', t => {
  const f = fixture(t, ['extra.txt']);
  f.data.files.pop();
  verify(f, 'unexpected staged entry');
  const missing = fixture(t);
  missing.data.files.push(entry('missing.txt'));
  verify(missing, 'staged tree is missing an inventory entry');
  const empty = fixture(t);
  mkdirSync(join(empty.root, 'empty'));
  verify(empty, 'unexpected staged entry');
  const old = fixture(t, ['WINDOWS-INTEGRITY.json']);
  old.data.files.pop();
  verify(old, 'unexpected staged entry');
});

test('requires exact on-disk spelling and bytes', t => {
  const wrongCase = fixture(t, ['EXTRA']);
  wrongCase.data.files.at(-1).path = 'extra';
  verify(wrongCase, 'unexpected staged entry');
  const f = fixture(t);
  writeFileSync(join(f.root, 'bin/pi.exe'), 'truncated');
  verify(f, 'staged file size mismatch');
  writeFileSync(join(f.root, 'bin/pi.exe'), bytes.toUpperCase());
  verify(f, 'staged file SHA-256 mismatch');
});

test('refuses hard-linked files, directory links, and linked manifest parents', t => {
  const hard = fixture(t);
  linkSync(join(hard.root, 'bin/pi.exe'), join(hard.area, 'outside.txt'));
  verify(hard, 'staged entry is not a regular single-linked file');
  const linked = fixture(t);
  symlinkSync(join(linked.root, 'ui'), join(linked.root, 'alias'), 'junction');
  linked.data.files.push(entry('alias/index.html'));
  verify(linked, 'staged entry is not a plain directory');
  const external = fixture(t);
  mkdirSync(join(external.area, 'outside'));
  symlinkSync(join(external.area, 'outside'), join(external.area, 'alias'), 'junction');
  verify(external, 'manifest path does not name a plain regular single-linked file', { manifest: join(external.area, 'alias/inventory.json') });
});
