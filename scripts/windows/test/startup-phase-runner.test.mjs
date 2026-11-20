import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { phases } from './startup-phase-bundle.mjs';

const runner = resolve('scripts/windows/test/run-startup-phase-trace.ps1');
const staged = resolve('scripts/windows/test-staged-desktop-startup.ps1');
const ps = process.env.GENTLE_DOT_TEST_PWSH;
const quote = value => `'${value.replaceAll("'", "''")}'`;
const shell = (args) => spawnSync(ps, ['-NoProfile', '-NonInteractive', ...args], {
  encoding: 'utf8', timeout: 10000,
  env: Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT'].map(key => [key, process.env[key]])),
});

test('runner fixes provenance and prepares a separately verified runtime before opening the receiver', () => {
  const source = readFileSync(runner, 'utf8');
  assert.match(source, /Assert-TraceTree \$original[\s\S]*verify \$original[\s\S]*tar -xf[\s\S]*Assert-TraceTree \$runtime[\s\S]*verify \$runtime \$manifest[\s\S]*Copy-Item[\s\S]*verify \$runtime \$traceManifest[\s\S]*New-TraceReceiver[\s\S]*Invoke-StagedDesktopStartup/);
  assert.deepEqual(source.match(/\$script:StartupTracePhases = '([^']+)'/)[1].split(' '), phases);
  assert.match(source, /RandomNumberGenerator/);
  const launcher = readFileSync(staged, 'utf8');
  assert.match(launcher, /Test-StagedStartupTraceHost[\s\S]*github-hosted[\s\S]*qa\/windows-storage-diagnostic-44794993333/);
  assert.match(launcher, /Invoke-StagedPackagedPreflight \$preflightInfo[\s\S]*GENTLE_DOT_CI_TRACE_PORT[\s\S]*New-DaemonStartupOwner \$info/);
});

test('non-hosted direct entry returns only the fixed host refusal', { skip: !ps }, () => {
  const r = shell(['-File', runner]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.trim(), 'trace-host-failed');
});

test('parent normalizes the selected runner temp without admitting other namespaces', { skip: !ps || process.platform !== 'win32' }, () => {
  const root = realpathSync.native(process.env.GENTLE_DOT_CI_TEST_ROOT || tmpdir());
  const command = `
    $ErrorActionPreference = 'Stop'; . ${quote(runner)}
    Get-TraceRunnerTemp ${quote(root.replaceAll('\\', '/') + '/')}
    foreach ($path in @('relative', 'C:relative', 'C:\\', '\\\\?\\C:\\temp', 'C:\\temp\\..', 'C:\\temp:stream')) {
      try { $null = Get-TraceRunnerTemp $path } catch { 'refused'; continue }
      throw 'unexpected admission'
    }
  `;
  const r = shell(['-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.replaceAll('\r\n', '\n'), `${root}\n${'refused\n'.repeat(6)}`);
});

test('bundle failure reports only an exact, unambiguous allowlisted line', { skip: !ps }, () => {
  const node = quote(process.execPath);
  const command = `
    $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; . ${quote(runner)}
    & { Set-Alias node ${node}; Invoke-TraceBundle ('a' * 32) }
    function node {
      if ($args.Count -ne 3 -or $args[1] -cne '--runner-suffix' -or $args[2] -cne 'unused') { throw 'bad arguments' }
      $global:LASTEXITCODE = $code; $lines
    }
    $code = 1
    foreach ($category in @('source-drift', 'anchor-drift', 'build-failed', 'scratch-refused', 'scratch-create-failed', 'scratch-write-failed')) {
      $lines = "STARTUP_PHASE_BUNDLE: $category"
      Invoke-TraceBundle 'unused'
    }
    foreach ($lines in @('STARTUP_PHASE_BUNDLE: BUILD-FAILED', 'STARTUP_PHASE_BUNDLE: build-failed ',
      'synthetic raw detail STARTUP_PHASE_BUNDLE: build-failed', 'STARTUP_PHASE_BUNDLE: unknown', '')) {
      Invoke-TraceBundle 'unused'
    }
    $lines = @('STARTUP_PHASE_BUNDLE: build-failed', 'synthetic raw detail')
    Invoke-TraceBundle 'unused'
    $code = 2
    $lines = 'STARTUP_PHASE_BUNDLE: scratch-create-failed'
    Invoke-TraceBundle 'unused'
    $code = 0
    Invoke-TraceBundle 'unused'
    $lines = 'STARTUP_PHASE_BUNDLE: ok'
    Invoke-TraceBundle 'unused'
  `;
  const r = shell(['-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.replaceAll('\r\n', '\n'), [
    'STARTUP_PHASE_BUNDLE: scratch-refused',
    ...['source-drift', 'anchor-drift', 'build-failed', 'scratch-refused', 'scratch-create-failed', 'scratch-write-failed'].map(c => `STARTUP_PHASE_BUNDLE: ${c}`),
    ...Array(8).fill('trace-bundle-failed'), '',
  ].join('\n'));
});

test('exclusive IPv4 receiver accepts only correlated increasing enum packets from one endpoint', { skip: !ps }, () => {
  const command = `
    $ErrorActionPreference = 'Stop'; . ${quote(runner)}
    $socket = New-TraceReceiver
    $first = [Net.Sockets.UdpClient]::new(); $other = [Net.Sockets.UdpClient]::new()
    try {
      if (-not $socket.ExclusiveAddressUse -or $socket.Blocking -or
          $socket.LocalEndPoint.Address.ToString() -cne '127.0.0.1') { throw 'unexpected socket binding' }
      $id = 'a' * 32
      function Send($sender, [string]$text) {
        $data = [Text.Encoding]::ASCII.GetBytes($text)
        [void]$sender.Send($data, $data.Length, $socket.LocalEndPoint)
      }
      Send $first (('b' * 32) + ' http-listening')
      Send $first ($id + ' ENTRY')
      Send $first ($id + ' http-listening' + ('z' * 512))
      Read-TraceReceiver $socket $id
      Send $first "$id entry"
      Send $other "$id http-listening"
      Send $first "$id config-ready"
      Send $first "$id config-start"
      Send $first "$id config-ready"
      Send $first "$id stop-refused"
      Send $first "$id http-listening"
      Read-TraceReceiver $socket $id
    } finally { $first.Dispose(); $other.Dispose(); $socket.Dispose() }
  `;
  const r = shell(['-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.replaceAll('\r\n', '\n'), 'no-evidence\nstop-refused\n');
});
