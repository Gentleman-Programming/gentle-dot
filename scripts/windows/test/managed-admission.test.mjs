import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const native = 'apps/desktop/src-tauri/src/daemon/';

test('inert child answers the exact fragmented challenge only through the channel', async () => {
  const { exchange } = await import('./managed-admission-child.mjs');
  const channel = new EventEmitter();
  const writes = [];
  channel.write = (bytes, done) => { writes.push(bytes.toString()); done(); };
  const result = exchange(channel);
  channel.emit('data', Buffer.from('admis'));
  assert.deepEqual(writes, []);
  channel.emit('data', Buffer.from('sion-v1'));
  await result;
  assert.deepEqual(writes, ['admission-ack-v1']);
});

test('inert child rejects mismatched, oversized, ended and failed exchanges', async () => {
  const { exchange } = await import('./managed-admission-child.mjs');
  for (const [event, value] of [
    ['data', Buffer.from('admission-v2')], ['data', Buffer.from('admission-v1extra')],
    ['end'], ['error', new Error('simulated read failure')],
  ]) {
    const channel = new EventEmitter();
    channel.write = () => assert.fail('invalid challenge reached ACK');
    const result = exchange(channel);
    channel.emit(event, value);
    await assert.rejects(result, { message: 'challenge-failed' });
  }
  const channel = new EventEmitter();
  channel.write = (_, done) => done(new Error('simulated write failure'));
  const result = exchange(channel);
  channel.emit('data', Buffer.from('admission-v1'));
  await assert.rejects(result, { message: 'ack-failed' });
});

test('native checkout fixture enters production admission and retains the separate drain test', () => {
  const child = read('scripts/windows/test/managed-admission-child.mjs');
  const fixture = read(`${native}windows_admission_fixture.rs`);
  const owner = read(`${native}windows.rs`);
  assert.match(owner, /#\[cfg\(test\)\]\s*mod admission_fixture/);
  assert.match(owner, /#\[ignore[^\n]*\]\s*fn production_fd3_drain_excludes_live_child_and_retires_owned_job/);
  assert.match(child, /startWithWindowsAppChannel\(join\(recordDirectory, 'daemon.pid'\), async \(channel\) => \{[\s\S]*await exchange\(channel\)/);
  assert.doesNotMatch(child, /loadNative:|createAppChannel:|new WindowsAppChannel|child_process|console\./);
  assert.match(child, /process\.version !== 'v24\.14\.1'/);
  assert.match(fixture, /channel_pair\(\)[\s\S]*spawn\(&launch, sink, &endpoint, directory\)/);
  assert.match(fixture, /OpenOptions::new\(\)\.write\(true\)\.open\("NUL"\)/);
  assert.match(fixture, /recv_timeout[\s\S]*admission:\{phase\}[\s\S]*shutdown_owned[\s\S]*parent\.shutdown\(\)[\s\S]*reader\.join\(\)/);
  assert.match(fixture, /!child\.force_requested[\s\S]*child\.query\(\)[\s\S]*record\.deletion_marked/);
});
