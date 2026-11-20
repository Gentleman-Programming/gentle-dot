import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const entry = 'scripts/windows/test/packaged-storage-admission.mjs';
const runtime = 'C:\\staged runtime';
const scratch = 'D:\\runner temp\\dot-storage-test';
const helper = `${runtime}\\bin\\private-storage.exe`;
const verbatim = `\\\\?\\${helper}`;
const control = `${scratch}\\absent\\probe.txt`;
const dir = `${scratch}\\private`;
const file = `${dir}\\probe.txt`;
const bytes = Buffer.from('synthetic storage probe\n');

async function run({ failures = [], createControl = false, createDirectory = true, contents = bytes } = {}) {
  const { probeStorage } = await import('./packaged-storage-admission.mjs');
  const calls = [], entries = new Map();
  const result = probeStorage(runtime, scratch, {
    exec(executable, args, options) {
      const failure = failures[calls.length];
      calls.push([executable, args, options]);
      if (failure) throw Object.assign(new Error('not for projection'), failure);
      if (args[0] === 'secure-file' && createControl) entries.set(`${scratch}\\absent`, 'directory');
      if (args[0] === 'ensure-dir' && createDirectory) entries.set(dir, 'directory');
      if (args[0] === 'write-file') entries.set(file, contents);
    },
    stat(path) {
      if (!entries.has(path)) throw Object.assign(new Error(), { code: 'ENOENT' });
      const value = entries.get(path);
      return { isDirectory: () => value === 'directory', isFile: () => Buffer.isBuffer(value), size: value.length };
    },
    read: path => entries.get(path),
  });
  return { result, calls, entries };
}

function invocation(executable, operation, target, input) {
  return [executable, [operation, target], {
    input, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true,
    timeout: 15_000, maxBuffer: 64 * 1024 * 1024,
  }];
}

test('both executable spellings use the identical absent-parent no-write control; verbatim then initializes synthetic storage', async () => {
  const { result, calls, entries } = await run();
  assert.equal(result, 'ok ok ok ok');
  assert.deepEqual(calls, [invocation(helper, 'secure-file', control), invocation(verbatim, 'secure-file', control),
    invocation(verbatim, 'ensure-dir', dir), invocation(verbatim, 'write-file', file, bytes)]);
  assert.deepEqual([...entries], [[dir, 'directory'], [file, bytes]]);
});

test('launch refusal and helper exit are distinct; only a successful control can select the write route', async () => {
  const fallback = await run({ failures: [null, { code: 'ENOENT' }] });
  assert.equal(fallback.result, 'ok launch-failed ok ok');
  assert.deepEqual(fallback.calls.slice(2), [invocation(helper, 'ensure-dir', dir), invocation(helper, 'write-file', file, bytes)]);
  const refused = await run({ failures: [{ status: 1 }, { code: 'ETIMEDOUT' }] });
  assert.equal(refused.result, 'helper-failed timeout skipped skipped');
  assert.equal(refused.calls.length, 2);
  assert.equal(refused.entries.size, 0);
});

test('unexpected control effects stop writes; directory and readback are verified independently', async () => {
  const controlWrite = await run({ createControl: true });
  assert.equal(controlWrite.result, 'unexpected-effect skipped skipped skipped');
  assert.equal(controlWrite.calls.length, 1);
  const noDir = await run({ createDirectory: false });
  assert.equal(noDir.result, 'ok ok unexpected-effect skipped');
  assert.equal(noDir.calls.length, 3);
  assert.equal(noDir.entries.size, 0);
  const badWrite = await run({ contents: Buffer.alloc(bytes.length) });
  assert.equal(badWrite.result, 'ok ok ok unexpected-effect');
  assert.equal(badWrite.calls.length, 4);
});

test('direct non-CI CLI invocation emits only a fixed prerequisite refusal', () => {
  const result = spawnSync(process.execPath, [entry], { env: {}, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'prerequisite-failed\n');
  assert.equal(result.stderr, '');
});
