import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { phases } from './startup-phase-bundle.mjs';

const runner = resolve('scripts/windows/test/run-startup-phase-trace.ps1');
const staged = resolve('scripts/windows/test-staged-desktop-startup.ps1');
const ps = process.env.GENTLE_DOT_TEST_PWSH;
const quote = value => `'${value.replaceAll("'", "''")}'`;
const shell = (args) => spawnSync(ps, ['-NoProfile', '-NonInteractive', ...args], {
  encoding: 'utf8', timeout: 10000,
  env: Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].map(key => [key, process.env[key]])),
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
