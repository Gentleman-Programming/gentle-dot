import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../split-runtime-inventory.mjs', import.meta.url));
const verifier = fileURLToPath(new URL('../split-runtime-verify.mjs', import.meta.url));
// A verifier can keep its source copy isolated and put only inert Windows
// fixtures in a separately approved, admissible directory.
const scratch = process.env.DOT_SPLIT_INVENTORY_TEST_SCRATCH ??
  fileURLToPath(new URL('../../../build/split-runtime-inventory-test/', import.meta.url));
assert.ok(isAbsolute(scratch), 'fixture directory must be absolute');
const core = ['node/node.exe', 'bin/engram.exe', 'bin/pi.exe', 'bin/private-storage.exe', 'daemon/cli.mjs',
  'daemon/node_modules/gentle-pi/bin/gentle-shell.mjs', 'ui/index.html'];
const tuple = { schema: 1, target: 'windows-x64', shell: '5.0.0', pi: '1.6.0' };
const usage = 'Usage: node scripts/windows/split-runtime-inventory.mjs emit ROOT PLAN EXPECTED_PLAN_SHA256\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = path => path === 'ui/index.html' ? Buffer.alloc(0) : Buffer.from(`inert fixture: ${path}\n`);
const json = data => JSON.stringify(data) + '\n';

function fixture(t, extra = []) {
  mkdirSync(scratch, { recursive: true });
  const area = mkdtempSync(join(scratch, 'run-'));
  t.diagnostic(`Retained fixture (runner PID ${process.pid}): ${area}`);
  const root = join(area, 'runtime');
  const plan = join(area, 'plan.json');
  const data = { ...tuple, files: [...core, ...extra] };
  for (const path of data.files) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes(path));
  }
  return { area, root, plan, data };
}

function snapshot(path) {
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink()
    ? [stat.mtimeMs, readdirSync(path).sort().map(name => [name, snapshot(join(path, name))])]
    : [stat.mode, stat.nlink, stat.size, stat.mtimeMs,
      stat.isFile() && stat.nlink === 1 ? digest(readFileSync(path)) : null];
}

function invoke(script, args, status, stdout, stderr) {
  const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(run.error);
  assert.deepEqual({ status: run.status, stdout: run.stdout, stderr: run.stderr }, { status, stdout, stderr });
  return run.stdout;
}

function emit(f, message, options = {}) {
  const raw = options.raw ?? json(f.data);
  const plan = options.plan ?? f.plan;
  if (options.write !== false) writeFileSync(plan, raw);
  const before = snapshot(f.area);
  try {
    return invoke(cli, ['emit', options.root ?? f.root, plan, options.expected ?? digest(raw)],
      message ? 1 : 0, message ? '' : options.stdout,
      message ? `Windows split runtime inventory refused: ${message}\n` : '');
  } finally {
    assert.deepEqual(snapshot(f.area), before);
  }
}

test('help and invalid invocation', () => {
  invoke(cli, ['--help'], 0, usage + 'Emit an inventory from an exclusively owned runtime tree and an independently pinned layout plan.\n', '');
  invoke(cli, ['emit', 'runtime', 'plan.json'], 2, '', usage);
});

test('emits deterministic exact bytes interoperable with the unchanged verifier', t => {
  const f = fixture(t, ['daemon/node_modules/gentle-pi/.gentle-ai/v1/gentle-ai.exe']);
  const expected = json({ ...tuple, files: [...f.data.files].sort().map(path => ({
    path, type: 'file', size: bytes(path).length, sha256: digest(bytes(path)),
  })) });
  const output = emit(f, null, { stdout: expected });
  f.data.files.reverse();
  emit(f, null, { stdout: expected });
  const manifest = join(f.area, 'manifest.json');
  writeFileSync(manifest, output);
  invoke(verifier, ['verify', f.root, manifest, digest(expected)], 0, 'Windows split runtime verified.\n', '');
});

test('validates digest before parsing plan or inspecting root', t => {
  const f = fixture(t);
  const root = join(f.area, 'absent');
  for (const expected of ['A'.repeat(64), 'a'.repeat(63)]) {
    emit(f, 'expected plan SHA-256 must be 64 lowercase hex characters', { root, expected });
  }
  emit(f, 'plan SHA-256 mismatch', { root, raw: '{', expected: '0'.repeat(64) });
  for (const raw of ['{', Buffer.from([0xff])]) emit(f, 'plan is not valid UTF-8 JSON', { root, raw });
  emit(f, 'duplicate plan field', { root, raw: json(f.data).replace('{', '{"schem\\u0061":2,') });
  for (const changes of [{ schema: 2 }, { target: 'windows-arm64' }, { shell: '5.0.1' }, { pi: '1.6.1' },
    { extra: true }, { files: {} }]) {
    emit(f, 'invalid plan schema or runtime tuple', { root, raw: json({ ...f.data, ...changes }) });
  }
  emit(f, 'plan omits a required runtime file', { root, raw: json({ ...f.data, files: core.slice(1) }) });
});

test('rejects unsafe Windows paths and collisions before inspecting root', t => {
  const f = fixture(t);
  const root = join(f.area, 'absent');
  for (const path of [null, { path: 'extra' }, '/x', 'C:/x', 'x:y', 'x\\y', 'x//y', 'x/../y', './x', 'x/',
    'x./y', 'x /y', 'x\n', 'x/é', 'CON.txt', 'x/COM1.js', 'LPT9', 'NUL', 'CONIN$', 'LONGNA~1',
    'x/'.repeat(120) + 'x', 'x'.repeat(121), 'x/.env.local', 'x/credentials.json', '.ssh/key', 'x/key.pem', 'x/old.zip']) {
    emit(f, 'unsafe plan path', { root, raw: json({ ...f.data, files: [...core, path] }) });
  }
  for (const paths of [['bin/PI.exe'], ['bin/pi.exe'], ['bin/pi.exe/nested'], ['bin'], ['extra/a', 'EXTRA/b']]) {
    emit(f, 'plan path collision', { root, raw: json({ ...f.data, files: [...core, ...paths] }) });
  }
});

test('requires a separate ordinary plan and unambiguous local arguments', t => {
  const f = fixture(t);
  emit(f, 'plan must be outside the runtime tree', { plan: join(f.root, 'plan.json'), write: false });
  for (const root of [f.root + '/.', f.root + '/../runtime', f.root + ':stream', f.root + '//alias']) {
    emit(f, 'unsafe input path', { root });
  }
  const raw = json(f.data);
  writeFileSync(f.plan, raw);
  linkSync(f.plan, join(f.root, 'alias.json'));
  emit(f, 'plan path is not a plain regular single-linked file', { write: false, raw });
});

test('refuses unexpected or missing entries, empty directories and mismatched spelling', t => {
  const f = fixture(t, ['EXTRA']);
  emit(f, 'unexpected runtime entry', { raw: json({ ...f.data, files: [...core, 'extra'] }) });
  emit(f, 'unexpected runtime entry', { raw: json({ ...f.data, files: core }) });
  emit(f, 'runtime tree is missing a plan entry', { raw: json({ ...f.data, files: [...f.data.files, 'absent/file'] }) });
  mkdirSync(join(f.root, 'empty'));
  emit(f, 'unexpected runtime entry');
  const types = fixture(t);
  mkdirSync(join(types.root, 'extra'));
  emit(types, 'runtime entry is not a regular single-linked file', { raw: json({ ...types.data, files: [...core, 'extra'] }) });
  writeFileSync(join(types.root, 'file'), 'inert');
  emit(types, 'runtime entry is not a plain directory', { raw: json({ ...types.data, files: [...core, 'extra/child', 'file/child'] }) });
});

test('refuses linked members and linked plan or root ancestors', t => {
  const f = fixture(t);
  linkSync(join(f.root, 'bin/pi.exe'), join(f.area, 'outside.txt'));
  emit(f, 'runtime entry is not a regular single-linked file');
  const linked = fixture(t);
  symlinkSync(join(linked.root, 'ui'), join(linked.root, 'alias'), 'junction');
  emit(linked, 'runtime entry is not a plain directory', { raw: json({ ...linked.data, files: [...core, 'alias/index.html'] }) });
  symlinkSync(linked.area, join(f.area, 'alias'), 'junction');
  emit(f, 'plan path is not a plain regular single-linked file', { plan: join(f.area, 'alias/plan.json'), write: false });
  emit(f, 'runtime root is not a plain directory', { root: join(f.area, 'alias/runtime') });
});
