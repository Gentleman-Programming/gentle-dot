import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = process.env.GENTLE_DOT_CI_TEST_ROOT;
assert.ok(root, 'Explicit retained scratch required');
const scratch = mkdtempSync(join(root, 'daemon-contract-'));
console.log(`Retained inert fixtures: ${scratch}`);
for (const dir of ['home','appdata','localappdata','temp','cache','runtime/node','runtime/daemon']) mkdirSync(join(scratch, dir), {recursive:true});
const runtime = join(scratch, 'runtime');
writeFileSync(join(runtime, 'node/node.exe'), 'inert, never executed');
writeFileSync(join(runtime, 'daemon/cli.mjs'), 'inert, never executed');
const env = { OS:process.env.OS, SystemRoot:process.env.SystemRoot, WINDIR:process.env.WINDIR,
 HOME:join(scratch,'home'), USERPROFILE:join(scratch,'home'), APPDATA:join(scratch,'appdata'), LOCALAPPDATA:join(scratch,'localappdata'),
 TEMP:join(scratch,'temp'), TMP:join(scratch,'temp'), TMPDIR:join(scratch,'temp'), XDG_CACHE_HOME:join(scratch,'cache') };
const quote = s => `'${s.replaceAll("'", "''")}'`;
const scriptPath = resolve('scripts/windows/test-daemon-startup.ps1');
function ps(body) {
 const script = `$ErrorActionPreference='Stop'; . ${quote(scriptPath)}; ${body}`;
 const result = spawnSync(process.env.GENTLE_DOT_TEST_PWSH, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], {env,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr); assert.equal(result.stderr,'');
 return result.stdout.trim();
}
test('launch settings use only packaged Node/CLI and a fresh allowlisted environment', () => {
 const result = JSON.parse(ps(`$env:OPENAI_API_KEY='SECRET'; $env:NODE_OPTIONS='SECRET'; $env:PATH='SECRET'; $e=New-DaemonStartupEnvironment -Runtime ${quote(runtime)} -Scratch ${quote(scratch)} -Port 12345; $p=New-DaemonStartupStartInfo -Runtime ${quote(runtime)} -Environment $e; [ordered]@{file=$p.FileName;args=@($p.ArgumentList);cwd=$p.WorkingDirectory;env=$e;stdout=$p.RedirectStandardOutput;stderr=$p.RedirectStandardError;shell=$p.UseShellExecute} | ConvertTo-Json -Depth 4 -Compress`));
 assert.equal(result.file, join(runtime,'node/node.exe'));
 assert.deepEqual(result.args,[join(runtime,'daemon/cli.mjs')]);
 assert.equal(result.cwd,runtime); assert.equal(result.stdout,true); assert.equal(result.stderr,true); assert.equal(result.shell,false);
 assert.doesNotMatch(JSON.stringify(result),/SECRET|OPENAI_API_KEY|NODE_OPTIONS/);
 assert.deepEqual(Object.keys(result.env).sort(), ['OS','SystemRoot','WINDIR','PATH','GENTLE_DOT_RUNTIME','GENTLE_DOT_DATA_DIR','GENTLE_DOT_PORT','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','XDG_CACHE_HOME'].sort());
 for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','XDG_CACHE_HOME','GENTLE_DOT_DATA_DIR']) assert.ok(result.env[key].startsWith(scratch));
 assert.equal(result.env.GENTLE_DOT_RUNTIME,runtime); assert.equal(result.env.GENTLE_DOT_PORT,'12345');
});
const mocks = `
 $script:starts=0; $script:stops=0; $script:polls=0
 function New-DaemonStartupScratch { ${quote(scratch)} }
 function Get-DaemonStartupPort { 12345 }
 function Start-DaemonStartupProcess { $script:starts++; if ($mode -eq 'startfailure') { throw 'SECRET' }; return @{fake=$true} }
 function Test-DaemonStartupExited { return ($mode -eq 'earlyexit') }
 function Stop-DaemonStartupProcess { $script:stops++; return ($mode -ne 'cleanupfailure') }
 function Receive-DaemonStartupHealth { $script:polls++; if ($mode -eq 'probeerror') { throw 'SECRET' }; return ($mode -in @('success','cleanupfailure')) }
 function Wait-DaemonStartupPoll {}
`;
for (const [mode, outcome, polls, stops] of [
 ['success','daemon-startup-passed',1,1], ['timeout','daemon-startup-timeout',12,1],
 ['earlyexit','daemon-startup-earlyexit',0,1], ['probeerror','daemon-startup-failed',1,1],
 ['startfailure','daemon-startup-failed',0,0], ['cleanupfailure','daemon-startup-cleanup-failed',1,1],
]) test(`public launch contract ${mode} is sanitized and stops only its owned process`, () => {
 const output = ps(`$env:CI='true'; $mode='${mode}'; ${mocks}; $r=Invoke-DaemonStartupContract -Runtime ${quote(runtime)}; [ordered]@{outcome=$r;starts=$script:starts;stops=$script:stops;polls=$script:polls} | ConvertTo-Json -Compress`);
 assert.deepEqual(JSON.parse(output),{outcome,starts:1,stops,polls}); assert.doesNotMatch(output,/SECRET/);
});
test('non-CI and missing-runtime rejections do not launch or mutate input', () => {
 const before = readFileSync(join(runtime,'node/node.exe'));
 const output = ps(`${mocks}; $env:CI=''; $a=Invoke-DaemonStartupContract -Runtime ${quote(runtime)}; $env:CI='true'; $b=Invoke-DaemonStartupContract -Runtime ${quote(join(scratch,'absent'))}; [ordered]@{a=$a;b=$b;starts=$script:starts;stops=$script:stops} | ConvertTo-Json -Compress`);
 assert.deepEqual(JSON.parse(output),{a:'daemon-startup-not-ci',b:'daemon-startup-invalid-runtime',starts:0,stops:0});
 assert.deepEqual(readFileSync(join(runtime,'node/node.exe')),before); assert.equal(existsSync(join(scratch,'absent')),false);
});
test('health proof rejects TCP, HTTP, JSON and shape failures without requiring idle', () => {
 const output = ps(`function Get-SmokeObservation { return $script:probe }; foreach ($change in @('none','tcp','http','json','shape')) { $script:probe=@{tcpState='connected';httpState='response';httpStatus=200;jsonState='valid';healthState='valid';agentState='error'}; switch ($change) { tcp {$script:probe.tcpState='refused'} http {$script:probe.httpStatus=503} json {$script:probe.jsonState='invalid'} shape {$script:probe.healthState='invalidshape'} }; Receive-DaemonStartupHealth -Port 12345 }`);
 assert.deepEqual(output.split(/\r?\n/),['True','False','False','False','False']);
});
test('direct non-CI CLI fails with exact sanitized stdout and empty stderr, without starting anything', () => {
 const before = readFileSync(join(runtime,'node/node.exe'));
 const result = spawnSync(process.env.GENTLE_DOT_TEST_PWSH, ['-NoLogo','-NoProfile','-NonInteractive','-File',scriptPath,'-Runtime',runtime], {env:{...env,CI:''},encoding:'utf8'});
 assert.equal(result.status,1); assert.equal(result.stdout,'daemon-startup-not-ci\r\n'); assert.equal(result.stderr,'');
 assert.deepEqual(readFileSync(join(runtime,'node/node.exe')),before);
});
const containedModel = `
 $script:root=[pscustomobject]@{HasExited=$true;ChildAlive=$true}
 $script:root | Add-Member ScriptMethod WaitForExit { param($ms) return $true }
 $script:root | Add-Member ScriptMethod Dispose {}
 $script:owner=[pscustomobject]@{Process=$script:root;HasExited=$true;Stops=0}
 $script:owner | Add-Member ScriptMethod Stop { $this.Stops++; $this.Process.ChildAlive=$false; return $true }
 $script:owner | Add-Member ScriptMethod Dispose {}
`;
test('exited root still requires contained descendant termination, not root-only WaitForExit', () => {
 const output = ps(`${containedModel}; $ok=Stop-DaemonStartupProcess $script:owner; [ordered]@{ok=$ok;childAlive=$script:root.ChildAlive;stops=$script:owner.Stops} | ConvertTo-Json -Compress`);
 assert.deepEqual(JSON.parse(output),{ok:true,childAlive:false,stops:1});
});
test('health-success/root-exit race terminates modeled descendants before passing', () => {
 const output = ps(`${containedModel}; $env:CI='true'; $script:root.HasExited=$false; $script:owner.HasExited=$false;
 function New-DaemonStartupScratch { ${quote(scratch)} }
 function Get-DaemonStartupPort { 12345 }
 function Start-DaemonStartupProcess { return $script:owner }
 function Receive-DaemonStartupHealth { $script:root.HasExited=$true; $script:owner.HasExited=$true; return $true }
 function Wait-DaemonStartupPoll {}
 $r=Invoke-DaemonStartupContract -Runtime ${quote(runtime)}
 [ordered]@{outcome=$r;childAlive=$script:root.ChildAlive;stops=$script:owner.Stops} | ConvertTo-Json -Compress`);
 assert.deepEqual(JSON.parse(output),{outcome:'daemon-startup-passed',childAlive:false,stops:1});
});
test('contained cleanup false/throw fails closed and always closes its owned job', () => {
 const output = ps(`foreach ($mode in @('false','throw')) { $o=[pscustomobject]@{Closed=$false}; $o | Add-Member ScriptMethod Stop { if ($mode -eq 'throw') { throw 'SECRET' }; return $false }; $o | Add-Member ScriptMethod Dispose { $this.Closed=$true }; $ok=Stop-DaemonStartupProcess $o; [ordered]@{ok=$ok;closed=$o.Closed} | ConvertTo-Json -Compress }`);
 assert.deepEqual(output.split(/\r?\n/).map(JSON.parse),[{ok:false,closed:true},{ok:false,closed:true}]);
});
test('start adapter receives exact cleared settings without running or compiling native code', () => {
 const output = ps(`function New-DaemonStartupOwner($Info) { [ordered]@{file=$Info.FileName;entry=$Info.ArgumentList[0];secret=$Info.Environment.ContainsKey('OPENAI_API_KEY')} }; $env:OPENAI_API_KEY='SECRET'; $e=New-DaemonStartupEnvironment -Runtime ${quote(runtime)} -Scratch ${quote(scratch)} -Port 12345; Start-DaemonStartupProcess -Runtime ${quote(runtime)} -Environment $e | ConvertTo-Json -Compress`);
 assert.deepEqual(JSON.parse(output),{file:join(runtime,'node/node.exe'),entry:join(runtime,'daemon/cli.mjs'),secret:false});
});
test('OS adapter structurally assigns a suspended process to kill-on-close job before resume', () => {
 const source = ps('Get-DaemonStartupNativeSource');
 const create = source.indexOf('Require(CreateProcessW('), assign = source.indexOf('Require(AssignProcessToJobObject('), resume = source.indexOf('Require(ResumeThread(');
 assert.ok(source.indexOf('Require(SetInformationJobObject(') < create);
 assert.ok(create > 0 && create < assign && assign < resume);
 assert.match(source,/CREATE_SUSPENDED\s*\|\s*CREATE_UNICODE_ENVIRONMENT\s*\|\s*EXTENDED_STARTUPINFO_PRESENT\s*\|\s*CREATE_NO_WINDOW/);
 assert.match(source,/JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000/);
 assert.match(source,/CreateFileW\("NUL"/); assert.match(source,/UpdateProcThreadAttribute\(attributes, 0, HANDLE_LIST/);
 assert.match(source,/startup.Info.Input = sink; startup.Info.Output = sink; startup.Info.Error = sink/);
 const stop = source.slice(source.indexOf('public bool Stop()'));
 assert.match(stop,/TerminateJobObject\(job, 1\)/); assert.match(stop,/accounting.ActiveProcesses == 0/);
 assert.match(stop,/watch.ElapsedMilliseconds < 5000/); assert.doesNotMatch(stop,/HasExited|WaitForSingleObject/);
 assert.match(source,/if \(assigned\) TerminateJobObject\(job, 1\); else TerminateProcess\(child.Process, 1\)/);
 assert.doesNotMatch(source,/GetProcessById|BREAKAWAY_OK|CREATE_BREAKAWAY_FROM_JOB/);
});
test('source suppresses raw output and uses contained cleanup; existing smoke unchanged', () => {
 const source = readFileSync(scriptPath,'utf8');
 assert.match(source,/\.Environment\.Clear\(\)/);
 assert.match(source,/try \{ return \$Owner.Stop\(\) \} catch \{ return \$false \}/);
 assert.match(source,/finally \{ \$Owner.Dispose\(\) \}/);
 assert.doesNotMatch(source,/taskkill|Get-Process|Stop-Process|Write-(Error|Warning)|RedirectStandard(Output|Error)\s*=\s*\$false/);
 assert.match(source,/Get-SmokeObservation -Port \$Port/);
 const smoke = readFileSync('scripts/windows/smoke-install.ps1','utf8');
 assert.match(smoke,/AddSeconds\(240\)/); assert.match(smoke,/agentState=idle within 240 seconds/);
});
