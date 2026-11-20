import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve('scripts/windows/test-staged-desktop-startup.ps1');
const ps = process.env.GENTLE_DOT_TEST_PWSH;
const q = s => `'${s.replaceAll("'", "''")}'`;
const flags = ['-NoLogo','-NoProfile','-NonInteractive'];
const isolated = root => ({ OS:process.env.OS, SystemRoot:process.env.SystemRoot, WINDIR:process.env.WINDIR,
 HOME:root, USERPROFILE:root, APPDATA:root, LOCALAPPDATA:root, TEMP:root, TMP:root, TMPDIR:root });
function fixture() {
 const root = mkdtempSync(join(process.env.GENTLE_DOT_CI_TEST_ROOT, 'staged-desktop-'));
 console.log(`Retained inert fixture: ${root}`);
 const desktop = join(root,'gentle-dot.exe'), runtime = join(root,'runtime');
 for (const dir of ['node','daemon']) mkdirSync(join(runtime,dir),{recursive:true});
 const files = [desktop,join(runtime,'node/node.exe'),join(runtime,'daemon/cli.mjs')];
 for (const file of files) writeFileSync(file,'inert, never executed');
 return {root, desktop, runtime, files, digest:createHash('sha256').update(readFileSync(desktop)).digest('hex')};
}

test('staged CLI rejects before any native launch or file mutation', {skip:!ps}, () => {
 const {root,desktop,runtime,files,digest} = fixture();
 const before = files.map(file=>readFileSync(file));
 for (const [ci, runtimePath, hash, outcome] of [
  ['',runtime,digest,'not-ci'], ['true',join(root,'absent'),digest,'invalid-runtime'],
  ['true',runtime,'0'.repeat(64),'desktop-identity'], ['true',runtime,'not-a-digest','desktop-identity'],
 ]) {
  const r = spawnSync(ps,[...flags,'-File',script,'-Runtime',runtimePath,'-Desktop',desktop,'-DesktopSha256',hash],{env:{...isolated(root),CI:ci},encoding:'utf8'});
  assert.equal(r.status,1); assert.equal(r.stderr,''); assert.equal(r.stdout,`staged-desktop-startup-${outcome}\r\n`);
  assert.deepEqual(files.map(file=>readFileSync(file)),before);
 }
});

test('staged Node version check receives the exact isolated environment at the typed boundary', {skip:!ps}, () => {
 const {root,desktop,runtime,files,digest} = fixture();
 const before = files.map(file=>readFileSync(file));
 const env = {...isolated(root),OS:'Windows_NT',NODE_OPTIONS:'not forwarded'};
 const expected = {
  OS:env.OS, SystemRoot:env.SystemRoot, WINDIR:env.WINDIR,
  PATH:`${join(runtime,'node')};${join(env.SystemRoot,'System32')}`,
  GENTLE_DOT_RUNTIME_DIR:runtime, GENTLE_DOT_DATA_DIR:join(root,'data'), GENTLE_DOT_PORT:'12345',
  GENTLE_DOT_ENGRAM:'private', GENTLE_DOT_ENGRAM_PORT:'12346', GENTLE_DOT_PREVIEW_MEMORY_ADMISSION:'1',
  HOME:join(root,'home'), USERPROFILE:join(root,'home'), APPDATA:join(root,'appdata'),
  LOCALAPPDATA:join(root,'localappdata'), TEMP:join(root,'temp'), TMP:join(root,'temp'),
  TMPDIR:join(root,'temp'), XDG_CACHE_HOME:join(root,'cache'), WEBVIEW2_USER_DATA_FOLDER:join(root,'webview'),
 };
 const body = `
 $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; . ${q(script)}; $env:CI='true'
 # Windows PowerShell lacks ArgumentList; keep the real ProcessStartInfo.Environment adapter.
 if ($PSVersionTable.PSVersion.Major -eq 5) {
   $script:arguments = [Collections.Generic.List[string]]::new()
   Update-TypeData -TypeName System.Diagnostics.ProcessStartInfo -MemberType ScriptProperty -MemberName ArgumentList -Value { ,$script:arguments }
 }
 Add-Type -TypeDefinition @'
 using System.Collections.Generic;
 namespace GentleDot.CI {
   public sealed class OwnedDaemon {
     public static int Calls, Stops, Disposals;
     public static string Executable, Directory;
     public static Dictionary<string,string> Environment;
     public static OwnedDaemon CheckNodeVersion(string executable, string directory, IDictionary<string,string> environment) {
       Calls++; Executable = executable; Directory = directory;
       Environment = new Dictionary<string,string>(environment);
       return new OwnedDaemon();
     }
     public bool HasExited { get { return true; } }
     public int? ExitCode { get { return 1; } }
     public bool Stop() { Stops++; return true; }
     public void Dispose() { Disposals++; }
   }
 }
'@
 function Get-DaemonStartupNativeSource { throw 'native compilation not allowed in this test' }
 function New-DaemonStartupOwner { $script:starts++; throw 'unexpected desktop launch' }
 function New-DaemonStartupScratch { ${q(root)} }
 function Get-DaemonStartupPort { return (12345+$script:ports++) }
 $outcome = Invoke-StagedDesktopStartup -Runtime ${q(runtime)} -Desktop ${q(desktop)} -DesktopSha256 ${q(digest)}
 if ($outcome -cne 'staged-desktop-startup-node-version') { throw "Unexpected outcome: $outcome" }
 $stub = [GentleDot.CI.OwnedDaemon]
 if ($stub::Calls -ne 1 -or $stub::Stops -ne 1 -or $stub::Disposals -ne 1 -or $script:starts -or
     $stub::Executable -cne ${q(join(runtime,'node','node.exe'))} -or $stub::Directory -cne ${q(runtime)}) { throw 'Unexpected version-check lifecycle' }
 $expected = (${q(JSON.stringify(expected))} | ConvertFrom-Json).PSObject.Properties
 $actual = $stub::Environment
 if ($actual.psbase.Count -ne @($expected).Count) { throw 'Unexpected environment size' }
 foreach ($entry in $expected) {
   if (-not $actual.ContainsKey($entry.Name) -or $actual[$entry.Name] -cne $entry.Value) { throw "Unexpected value for $($entry.Name)" }
 }
 $outcome`;
 const r=spawnSync(ps,[...flags,'-EncodedCommand',Buffer.from(body,'utf16le').toString('base64')],{env,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr); assert.equal(r.stderr,'');
 assert.equal(r.stdout,'staged-desktop-startup-node-version\r\n');
 assert.deepEqual(files.map(file=>readFileSync(file)),before);
});

test('health is accepted only with stable owned listener and successful job cleanup', {skip:!ps}, () => {
 const {root,desktop,runtime,digest} = fixture();
 const body = `
 $ErrorActionPreference='Stop'; . ${q(script)}; $env:CI='true'
 function New-DaemonStartupScratch { ${q(root)} }
 function Get-DaemonStartupPort { return (12345+$script:ports++) }
 function New-DaemonStartupClock { $script:clock=[pscustomobject]@{ElapsedMilliseconds=0}; $script:clock }
 function Wait-DaemonStartupPoll { $script:clock.ElapsedMilliseconds=30000 }
 function Test-StagedNodeVersion { param($Runtime,$Environment) return ($mode -ne 'version') }
 function New-DaemonStartupOwner {
   param($Info); $script:starts++
   if ($Info.FileName -cne ${q(desktop)} -or $Info.ArgumentList.Count -ne 0 -or
       $Info.Environment['GENTLE_DOT_RUNTIME_DIR'] -cne ${q(runtime)} -or $Info.Environment.ContainsKey('NODE_OPTIONS')) { throw 'wrong launch' }
   @{HasExited=$false}
 }
 function Get-StagedListenerPid { $script:checks++; if ($mode -ne 'foreign') { if ($mode -eq 'changed') { 10+$script:checks } else { 10 } } }
 function Get-DaemonStartupDiagnosticProbe { $script:polls++; if ($mode -eq 'late') { $script:clock.ElapsedMilliseconds=30000 }; @{tcpState='connected';httpState='response';httpStatus=200;jsonState='valid';healthState='valid'} }
 function Stop-DaemonStartupProcess { $script:stops++; $mode -ne 'cleanup' }
 $env:NODE_OPTIONS='not forwarded'
 foreach ($mode in @('success','foreign','changed','late','cleanup','version')) {
   $script:starts=0; $script:checks=0; $script:polls=0; $script:stops=0; $script:ports=0
   $r=Invoke-StagedDesktopStartup -Runtime ${q(runtime)} -Desktop ${q(desktop)} -DesktopSha256 ${q(digest)}
   "$r,$starts,$checks,$polls,$stops"
 }`;
 const r=spawnSync(ps,[...flags,'-EncodedCommand',Buffer.from(body,'utf16le').toString('base64')],{env:isolated(root),encoding:'utf8'});
 assert.equal(r.status,0,r.stderr); assert.equal(r.stderr,'');
 assert.deepEqual(r.stdout.trim().split(/\r?\n/),[
  'staged-desktop-startup-passed,1,2,1,1','staged-desktop-startup-timeout,1,1,0,1',
  'staged-desktop-startup-timeout,1,2,1,1','staged-desktop-startup-timeout,1,2,1,1',
  'staged-desktop-startup-cleanup-failed,1,2,1,1','staged-desktop-startup-node-version,0,0,0,0',
 ]);
});
