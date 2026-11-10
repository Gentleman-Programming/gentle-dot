import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { readFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';

const root = process.env.GENTLE_DOT_CI_TEST_ROOT;
assert.ok(root, 'Authorized retained system-temp root required');
const scratch = mkdtempSync(join(root, 'pure-'));
console.log(`Retained inert fixtures: ${scratch}`);
for (const dir of ['home', 'temp', 'cache', 'appdata', 'localappdata']) mkdirSync(join(scratch, dir));
const env = { OS: process.env.OS, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
 HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), TEMP: join(scratch, 'temp'),
 TMP: join(scratch, 'temp'), TMPDIR: join(scratch, 'temp'), XDG_CACHE_HOME: join(scratch, 'cache'),
 APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata') };
const ps = process.env.GENTLE_DOT_TEST_PWSH;
assert.ok(ps, 'Explicit existing PowerShell 7 required');
const quote = s => `'${s.replaceAll("'", "''")}'`;
function run(body) {
 const script = `$ErrorActionPreference='Stop'; Import-Module ${quote(resolve('scripts/windows/smoke-diagnostics.psm1'))} -Force; ${body}`;
 const result = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, encoding: 'utf8' });
 assert.equal(result.status, 0, result.stderr);
 assert.equal(result.stderr, '');
 return result.stdout.trim();
}
async function observe(server, body) {
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const sockets = new Set();
 server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
 try {
  const script = `$ErrorActionPreference='Stop'; Import-Module ${quote(resolve('scripts/windows/smoke-diagnostics.psm1'))} -Force; $p=Get-SmokeObservation -Port ${server.address().port}; ${body}`;
  const child = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(status, 0, stderr); assert.equal(stderr, '');
  return stdout.trim();
 } finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
 }
}
const emitProbe = `$d=New-SmokeDiagnostic -Outcome timeout -Probe $p; $d | ConvertTo-Json -Compress`;
function checkProbe(output, expected) {
 assert.ok(Buffer.byteLength(output) <= 1024);
 assert.doesNotMatch(output, /SECRET|private|127\.0\.0\.1|https?:\/\/|Users|authorization/i);
 const d = JSON.parse(output); assert.deepEqual(d.probe, expected); return d;
}
const baseProbe = { tcpState: 'connected', httpState: 'response', httpStatus: 200, jsonState: 'valid', healthShape: 'object', healthState: 'valid' };
test('TCP refusal, timeout and unreachable are distinguished without exception strings', () => {
 const output = run(`$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $l.Start(); $port=$l.LocalEndpoint.Port; $l.Stop(); $p=Get-SmokeObservation -Port $port; ${emitProbe}`);
 checkProbe(output, { tcpState: 'refused', httpState: 'notattempted', httpStatus: null, jsonState: 'notattempted', healthShape: 'missing', healthState: 'notattempted' });
 assert.deepEqual(run(`Get-SmokeTcpState ([TimeoutException]::new('SECRET')); Get-SmokeTcpState ([OperationCanceledException]::new('SECRET')); Get-SmokeTcpState ([Net.Sockets.SocketException]::new(10060)); Get-SmokeTcpState ([Net.Sockets.SocketException]::new(10051)); Get-SmokeTcpState ([Net.Sockets.SocketException]::new(10065)); Get-SmokeTcpState ([Exception]::new('SECRET'))`).split(/\r?\n/), ['connecttimeout','connecttimeout','connecttimeout','unreachable','unreachable','other']);
 assert.deepEqual(run(`foreach ($port in @(0,65536)) { try { Get-SmokeObservation -Port $port } catch { 'rejected' } }`).split(/\r?\n/), ['rejected','rejected']);
});
test('connected HTTP status errors and response timeouts stay separate from TCP and JSON', async () => {
 const failed = await observe(createServer((req, res) => { res.writeHead(503, { 'x-private': 'SECRET' }); res.end('SECRET'); }), emitProbe);
 checkProbe(failed, { ...baseProbe, httpState: 'statuserror', httpStatus: 503, jsonState: 'notattempted', healthShape: 'missing', healthState: 'notattempted' });
 const timed = await observe(createTcpServer(() => {}), emitProbe);
 checkProbe(timed, { ...baseProbe, httpState: 'timeout', httpStatus: null, jsonState: 'notattempted', healthShape: 'missing', healthState: 'notattempted' });
 const broken = await observe(createTcpServer(socket => { socket.on('data', () => socket.destroy()); }), emitProbe);
 checkProbe(broken, { ...baseProbe, httpState: 'failure', httpStatus: null, jsonState: 'notattempted', healthShape: 'missing', healthState: 'notattempted' });
 let requests = 0;
 const redirect = await observe(createServer((req, res) => { requests++; res.writeHead(302, { location: 'http://private.invalid/SECRET' }); res.end(); }), emitProbe);
 checkProbe(redirect, { ...baseProbe, httpState: 'statuserror', httpStatus: 302, jsonState: 'notattempted', healthShape: 'missing', healthState: 'notattempted' });
 assert.equal(requests, 1, 'No automatic redirects or retries');
 const slowBody = await observe(createServer((req, res) => { res.writeHead(200); res.flushHeaders(); }), emitProbe);
 checkProbe(slowBody, { ...baseProbe, httpState: 'timeout', jsonState: 'notattempted', healthShape: 'missing', healthState: 'notattempted' });
});
for (const [name, body] of [['empty', ''], ['whitespace', ' \t\r\n ']]) {
 test(`HTTP 200 ${name} body is invalid JSON, not a decoded JSON null`, async () => {
  const output = await observe(createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); }), emitProbe);
  checkProbe(output, { ...baseProbe, jsonState: 'invalid', healthShape: 'missing', healthState: 'notattempted' });
 });
}
test('JSON invalid, oversized and invalid health shapes remain bounded and never serialize bodies', async () => {
 for (const [body, changes] of [
  ['{SECRET', { jsonState: 'invalid', healthShape: 'missing', healthState: 'notattempted' }],
  ['x'.repeat(4097), { jsonState: 'oversize', healthShape: 'missing', healthState: 'notattempted' }],
  ['[]', { healthShape: 'array', healthState: 'invalidshape' }],
  ['null', { healthShape: 'missing', healthState: 'invalidshape' }],
  ['"SECRET"', { healthShape: 'other', healthState: 'invalidshape' }],
  ['{"ok":true,"agentState":"SECRET","error":"SECRET"}', { healthState: 'invalidshape' }],
  ['{"ok":true,"agentState":"idle","error":"SECRET"}', {}],
  ['{"ok":true,"agentState":"idle"}' + ' '.repeat(4065), {}],
 ]) {
  const output = await observe(createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); }), emitProbe);
  checkProbe(output, { ...baseProbe, ...changes });
 }
});
test('probe projection rejects unsolicited metadata and preserves existing stored bytes', () => {
 const file = join(scratch, 'probe.json');
 const output = run(`$p=@{tcpState='SECRET';httpState='SECRET';httpStatus=9999;jsonState='SECRET';healthShape='SECRET';healthState='SECRET';body='SECRET'}; $d=New-SmokeDiagnostic -Outcome timeout -Probe $p; Write-SmokeDiagnostic -Path ${quote(file)} -Diagnostic $d; $d | ConvertTo-Json -Compress`);
 checkProbe(output, { tcpState: 'unknown', httpState: 'other', httpStatus: null, jsonState: 'other', healthShape: 'other', healthState: 'other' });
 const before = readFileSync(file); assert.ok(before.length <= 1024); assert.doesNotMatch(before.toString(), /SECRET|body/);
 assert.equal(run(`try { Write-SmokeDiagnostic -Path ${quote(file)} -Diagnostic (New-SmokeDiagnostic -Probe @{}) } catch { 'rejected' }`), 'rejected');
 assert.deepEqual(readFileSync(file), before);
});
test('allowlisted outcomes and health shapes never serialize unsolicited strings; bounded UTF8', () => {
 const output = run(`foreach ($outcome in @('success','timeout','earlyexit','agenterror','other')) {
 $d = New-SmokeDiagnostic -Outcome $outcome -Alive $true -ExitCode 17 -PollCount 480 -Reachable $true -HttpStatus 200 -Health ([pscustomobject]@{ok=$true;agentState='idle';error='SECRET-token';url='https://private';profile='C:\\Users\\private'}) -ErrorKind 'transport';
 $d | ConvertTo-Json -Compress
 }; New-SmokeDiagnostic -Outcome 'SECRET' -Alive 'SECRET' -ExitCode 'SECRET' -PollCount 9999999 -Reachable 'SECRET' -HttpStatus 9999 -Health ([pscustomobject]@{agentState='SECRET';ok='SECRET'}) -ErrorKind 'SECRET' | ConvertTo-Json -Compress`);
 const rows = output.split(/\r?\n/).map(s => { assert.ok(Buffer.byteLength(s) <= 1024); return JSON.parse(s); });
 assert.deepEqual(rows.slice(0, 5).map(r => r.outcome), ['success','timeout','earlyexit','agenterror','other']);
 assert.deepEqual(rows[0], { schema: 1, outcome: 'success', processAlive: true, exitCode: 17, pollCount: 480, listenerReachable: true, httpStatus: 200, healthShape: 'object', healthOk: true, agentState: 'idle', errorKind: 'transport' });
 assert.deepEqual(rows[5], { schema: 1, outcome: 'other', processAlive: null, exitCode: null, pollCount: 0, listenerReachable: null, httpStatus: null, healthShape: 'object', healthOk: null, agentState: 'unknown', errorKind: 'other' });
 assert.doesNotMatch(output, /SECRET|private|https|Users/);
 assert.equal(run(`New-SmokeDiagnostic -Health @('SECRET') | ConvertTo-Json -Compress`).includes('"healthShape":"array"'), true);
 assert.equal(run(`New-SmokeDiagnostic | ConvertTo-Json -Compress`).includes('"healthShape":"missing"'), true);
});
test('safe exception classification and rejected output requests do not mutate stored bytes', () => {
 const file = join(scratch, 'result.json');
 run(`$d=New-SmokeDiagnostic; Write-SmokeDiagnostic -Path ${quote(file)} -Diagnostic $d`);
 const before = readFileSync(file);
 assert.ok(before.length <= 1024);
 assert.equal(run(`try { Write-SmokeDiagnostic -Path ${quote(file)} -Diagnostic (New-SmokeDiagnostic -Outcome success) } catch { 'rejected' }`), 'rejected');
 assert.deepEqual(readFileSync(file), before);
 assert.deepEqual(run(`Get-SmokeErrorKind ([System.TimeoutException]::new('SECRET')); Get-SmokeErrorKind ([System.Net.WebException]::new('SECRET')); Get-SmokeErrorKind ([System.Exception]::new('SECRET'))`).split(/\r?\n/), ['timeout', 'transport', 'other']);
 const rejected = join(scratch, 'rejected.txt');
 assert.equal(run(`try { Write-SmokeDiagnostic -Path ${quote(rejected)} -Diagnostic (New-SmokeDiagnostic) } catch { 'rejected' }`), 'rejected');
 assert.deepEqual(readFileSync(file), before);
 const projected = join(scratch, 'projected.json');
 run(`$d=New-SmokeDiagnostic; $d['stdout']='SECRET'; $d['healthShape']='SECRET'; $d['agentState']='SECRET'; $d['healthOk']='SECRET'; Write-SmokeDiagnostic -Path ${quote(projected)} -Diagnostic $d`);
 const bytes = readFileSync(projected);
 assert.ok(bytes.length <= 1024);
 assert.doesNotMatch(bytes.toString(), /SECRET|stdout/);
 assert.equal(JSON.parse(bytes).healthShape, 'other');
});
test('actual diagnostic finally preserves the original failure with WarningPreference Stop', () => {
 const rejected = join(scratch, 'warning-stop.txt');
 const output = run(`
 $tokens=$null; $errors=$null
 $ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(resolve('scripts/windows/smoke-install.ps1'))}, [ref]$tokens, [ref]$errors)
 if ($errors.Count) { throw 'Invalid smoke syntax' }
 $outer=@($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.TryStatementAst] })
 if ($outer.Count -ne 1) { throw 'Expected exactly one outer try statement' }
 $text=$outer[0].Finally.Extent.Text
 $emit=[scriptblock]::Create($text.Substring(1, $text.Length-2))
 $DiagnosticsPath=${quote(rejected)}; $WarningPreference='Stop'
 $outcome='timeout'; $alive=$null; $exitCode=$null; $pollCount=480
 $reachable=$null; $httpStatus=$null; $health=$null; $errorKind='transport'
 $caught=$null
 try { try { throw 'original-smoke-failure' } finally { & $emit 3>$null } }
 catch { $caught=$_.Exception.Message }
 if ($caught -cne 'original-smoke-failure') { throw "Original smoke failure was masked: $caught" }
 'preserved'
 `);
 assert.equal(output, 'preserved');
 assert.equal(existsSync(rejected), false, 'Rejected diagnostic output must not create a file');
});
test('opt-in wiring preserves old invocation, readiness and failure/cleanup rules', () => {
 const source = readFileSync('scripts/windows/smoke-install.ps1', 'utf8');
 assert.match(source, /\[string\]\$DiagnosticsPath\s*=\s*''/);
 assert.match(source, /\.AddSeconds\(240\)/);
 assert.match(source, /Installed app did not reach agentState=idle within 240 seconds/);
 assert.match(source, /if \(\$DiagnosticsPath\)/);
 assert.match(source, /Write-SmokeDiagnostic/);
 assert.match(source, /\$outcome = 'earlyexit'/);
 assert.match(source, /\$outcome = 'agenterror'/);
 assert.match(source, /\$outcome = 'timeout'/);
 assert.match(source, /taskkill.exe \/PID \$app.Id \/T \/F/);
 assert.match(source, /# Reinstall only after cleanup/);
 assert.match(source, /if \(\$DiagnosticsPath\) \{\s*try \{ \$probe = Get-SmokeObservation -Port \$port \} catch \{ \$probe = @\{\} \}/);
 assert.equal(source.match(/Get-SmokeObservation/g)?.length, 1);
 assert.equal(run(`$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile(${quote(resolve('scripts/windows/smoke-install.ps1'))}, [ref]$tokens, [ref]$errors); if ($errors.Count) { throw 'Invalid smoke syntax' }; 'syntax-ok'`), 'syntax-ok');
});
