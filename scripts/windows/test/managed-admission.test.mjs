import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const native = 'apps/desktop/src-tauri/src/daemon/';
const pwsh = process.env.GENTLE_DOT_TEST_PWSH;
const scratch = process.env.GENTLE_DOT_CI_TEST_ROOT;

function runInertRunner({ addon, frontend = true, host = '' } = {}) {
  const root = mkdtempSync(join(scratch, 'managed-admission-'));
  const runner = join(root, 'scripts/windows/test/run-managed-admission.ps1');
  const addonPath = join(root, 'packages/daemon/native/windows-stop.node');
  const output = join(root, 'result');
  const shadow = join(root, 'second-node');
  for (const directory of [dirname(runner), dirname(addonPath), join(root, 'packages/ui/dist/app'),
    join(root, 'apps/desktop/src-tauri'), shadow]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(runner, read('scripts/windows/test/run-managed-admission.ps1'));
  writeFileSync(output, '');
  writeFileSync(join(shadow, 'node.exe'), 'inert second PATH entry');
  if (addon === 'file') writeFileSync(addonPath, 'inert addon');
  if (addon === 'directory') mkdirSync(addonPath);
  if (frontend) writeFileSync(join(root, 'packages/ui/dist/app/index.html'), 'inert UI');
  const script = `
$ProgressPreference = 'SilentlyContinue'
function cargo { throw 'real Cargo must never run' }
${host}
& $env:INERT_RUNNER
exit $LASTEXITCODE
`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...env, PATH: [dirname(process.execPath), shadow, process.env.PATH].join(delimiter),
      GITHUB_OUTPUT: output, INERT_RUNNER: runner, INERT_CHECKOUT: root },
    encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(result.error);
  const bytes = readFileSync(output);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8';
  return [result.status, result.stdout, result.stderr, bytes.toString(encoding).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')];
}

const psTest = { skip: !(process.platform === 'win32' && pwsh && scratch) };
const published = (result, status = 1) => [status, '', '', `result=${result}\n`];
if (!psTest.skip) console.log(`RETAINED_ADMISSION_FIXTURES=${scratch}`);

test('checkout runner binds the first actual Node application even with another node.exe on PATH', psTest, () => {
  assert.deepEqual(runInertRunner({ host: `
if (@(Get-Command node.exe -CommandType Application -All).Count -lt 2) { exit 98 }
` }), published(process.arch === 'x64' && process.version === 'v24.14.1' ? 'checkout-addon-invalid' : 'node-identity-mismatch'));
});

function stubHost({ unavailable = false, identity = 'win32-x64-v24.14.1', probeExit = 0, addonExit = 0, cargo = '' }) {
  return `
function Get-Command {
    if ('${unavailable}' -eq 'true') { throw 'private command lookup detail' }
    [pscustomobject]@{ Source = 'Invoke-InertNode' }
}
function Invoke-InertNode {
    if ((Get-Location).Path -cne $env:INERT_CHECKOUT) { exit 97 }
    if ($args[0] -ceq '-p' -and $args[1] -ceq "process.platform + '-' + process.arch + '-' + process.version") {
        $global:LASTEXITCODE = ${probeExit}
        '${identity}'
    } elseif ($args[0] -ceq '-e' -and $args[1] -ceq "require('./packages/daemon/native/windows-stop.node')") {
        $global:LASTEXITCODE = ${addonExit}
        'private addon output'
    } elseif ($args[0] -ceq '-p' -and $args[1] -clike "require('./packages/daemon/native/windows-stop.node');*") {
        # Allow the old combined probe to reproduce the former result without loading an addon.
        $global:LASTEXITCODE = ${probeExit || addonExit}
        '${identity}'
    } else { exit 96 }
}
${cargo}
`;
}

const inertCargo = (lines) => `
function cargo {
    if ((Get-Location).Path -cne (Join-Path $env:INERT_CHECKOUT 'apps/desktop/src-tauri') -or
        $env:GENTLE_ADMISSION_NODE -cne 'Invoke-InertNode') { exit 95 }
    $global:LASTEXITCODE = 0
    ${lines.map(line => `'${line}'`).join('\n    ')}
}
`;

for (const [expected, files, stubs, status] of [
  ['node-unavailable', {}, { unavailable: true }],
  ['node-probe-failed', {}, { probeExit: 1 }],
  ['node-identity-mismatch', {}, { identity: 'win32-x64-v22.22.0' }],
  ['checkout-addon-invalid', { addon: 'directory' }, {}],
  ['checkout-addon-load-failed', { addon: 'file' }, { addonExit: 1 }],
  ['frontend-missing', { addon: 'file', frontend: false }, {}],
  ['zero-tests', { addon: 'file' }, { cargo: inertCargo(['running 0 tests', 'private cargo output']) }],
  ['orderly', { addon: 'file' }, { cargo: inertCargo(['admission-result:orderly',
    'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.01s']) }, 0],
]) {
  test(`checkout runner reports only ${expected}`, psTest, () => {
    assert.deepEqual(runInertRunner({ ...files, host: stubHost(stubs) }), published(expected, status));
  });
}

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
