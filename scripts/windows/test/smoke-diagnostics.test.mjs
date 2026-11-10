import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
 assert.equal(run(`$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile(${quote(resolve('scripts/windows/smoke-install.ps1'))}, [ref]$tokens, [ref]$errors); if ($errors.Count) { throw 'Invalid smoke syntax' }; 'syntax-ok'`), 'syntax-ok');
});
