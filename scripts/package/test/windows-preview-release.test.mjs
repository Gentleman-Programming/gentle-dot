import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyPreview } from '../windows-preview-release.mjs';
const source='a'.repeat(40), version='0.1.0';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'dot-preview-release-')); const name=`gentle-dot-${version}-windows-x64-${source}-qa-setup.exe`;
 const files=[{name,role:'installer',bytes:Buffer.from('SYNTHETIC TEST DATA, NOT AN EXECUTABLE\n')},{name:'runtime-manifest.json',role:'producer-runtime-manifest',bytes:Buffer.from('{"platform":"win32-x64"}\n')}];
 for(const f of files)writeFileSync(join(dir,f.name),f.bytes);
 const manifest={schema:1,purpose:'manual-native-qa',releaseReady:false,target:'windows-x64',source,version,files:files.map(f=>({name:f.name,role:f.role,sizeBytes:f.bytes.length,sha256:hash(f.bytes)}))};
 writeFileSync(join(dir,'QA-MANIFEST.json'),JSON.stringify(manifest)); console.info(`RETAINED_SYNTHETIC_FIXTURE=${dir}`); return {dir,manifest};
}
const snapshot=dir=>readdirSync(dir).sort().map(name=>[name,hash(readFileSync(join(dir,name)))]);

test('verified Windows QA payload emits exactly the three real immutable upload files',()=>{
 const {dir}=fixture(), before=snapshot(dir);const result=verifyPreview(dir,source);
 assert.equal(result.source,source);assert.equal(result.target,'windows-x64');assert.equal(result.version,version);
 assert.equal(result.files.length,3);assert.ok(result.files.every(path=>path.startsWith(resolve(dir))));assert.deepEqual(snapshot(dir),before);
 const cli=spawnSync(process.execPath,['scripts/package/windows-preview-release.mjs',dir,source],{encoding:'utf8'});
 assert.equal(cli.status,0);assert.equal(cli.stderr,'');assert.equal(cli.stdout,JSON.stringify(result)+'\n');
 const help=spawnSync(process.execPath,['scripts/package/windows-preview-release.mjs','--help'],{encoding:'utf8'});
 assert.equal(help.status,0);assert.equal(help.stderr,'');assert.equal(help.stdout,'usage: windows-preview-release.mjs DIRECTORY SOURCE_SHA\n');
});

test('rejected payloads produce exact CLI refusal and leave files and counters unchanged',()=>{
 for(const change of ['source','target','digest','size','path','extra']){
  const {dir,manifest}=fixture();
  if(change==='source')manifest.source='b'.repeat(40);
  if(change==='target')manifest.target='windows-arm64';
  if(change==='digest')manifest.files[0].sha256='0'.repeat(64);
  if(change==='size')manifest.files[0].sizeBytes++;
  if(change==='path')manifest.files[0].name='../outside.exe';
  if(change==='extra')writeFileSync(join(dir,'unexpected.txt'),'not a release asset');
  writeFileSync(join(dir,'QA-MANIFEST.json'),JSON.stringify(manifest));const before=snapshot(dir);
  const cli=spawnSync(process.execPath,['scripts/package/windows-preview-release.mjs',dir,source],{encoding:'utf8'});
  assert.equal(cli.status,2,change);assert.equal(cli.stdout,'');assert.equal(cli.stderr,'preview-release: Windows preview payload verification failed.\n');assert.deepEqual(snapshot(dir),before);
 }
});

const store=resolve('node_modules/.pnpm');const installed=readdirSync(store).find(name=>/^yaml@/.test(name));
const {parse}=await import(pathToFileURL(resolve(store,installed,'node_modules/yaml/dist/index.js')));
const workflow=()=>parse(readFileSync('.github/workflows/windows-installer-preview.yml','utf8'));
test('Windows CI is narrowly triggered, natively builds and retains all mandatory acceptance gates',()=>{
 const w=workflow();assert.deepEqual(w.on,{workflow_dispatch:null,push:{branches:['qa/windows-installer-preview/**']}});assert.deepEqual(w.permissions,{contents:'read'});
 const b=w.jobs.build;assert.equal(b['runs-on'],'windows-2022');assert.deepEqual(b.permissions,{contents:'read'});
 const steps=b.steps;assert.equal(steps.find(s=>s.uses==='actions/checkout@v4').with['persist-credentials'],false);
 assert.equal(steps.find(s=>s.uses==='actions/setup-node@v4').with.architecture,'x64');
 assert.ok(steps.some(s=>s.run==='pnpm install --frozen-lockfile'));
 const build=steps.findIndex(s=>s.run==='./scripts/windows/package.ps1 -Target windows-x64');
 const all=Object.values(w.jobs).flatMap(job=>job.steps);
 assert.ok(build>=0);assert.ok(all.some(s=>s.run?.includes('./scripts/windows/test-staged-desktop-startup.ps1 -Runtime')));
 assert.ok(all.some(s=>s.run?.includes('./scripts/windows/smoke-install.ps1')));
 assert.ok(steps.some(s=>s.id==='collect' && s.run?.includes('ci-native.mjs collect --target windows-x64')));
 assert.equal(b['continue-on-error'],undefined);
 for(const step of steps)if(step.id!=='managed-admission')assert.equal(step['continue-on-error'],undefined);
 assert.ok(steps.some(s=>s.uses==='actions/upload-artifact@v4'&&s.if?.includes('always()')));
});

test('native addon is built from matching checksum-verified inputs before runtime packaging',()=>{
 const steps=workflow().jobs.build.steps;
 const msvc=steps.findIndex(s=>s.uses==='ilammy/msvc-dev-cmd@v1.13.0');
 const addon=steps.findIndex(s=>s.name==='Build required Windows native addon');
 const producer=steps.findIndex(s=>s.run==='./scripts/windows/package.ps1 -Target windows-x64');
 assert.ok(msvc>=0&&addon>msvc&&producer>addon,'missing native addon prerequisite ordering');
 assert.equal(steps[msvc].with.arch,'x64');
 const script=steps[addon].run;
 assert.match(script,/node -p process.version/);assert.match(script,/https:\/\/nodejs.org\/download\/release\/\$version/);
 assert.match(script,/SHASUMS256.txt/);assert.match(script,/Get-FileHash -Algorithm SHA256/);assert.match(script,/Checksum mismatch/);
 assert.ok(script.indexOf('Get-FileHash')<script.indexOf('tar -xf')&&script.indexOf('tar -xf')<script.indexOf('run build:windows-stop'));
 assert.match(script,/Get-Command cl.exe/);assert.match(script,/--compiler "\$compiler" --headers "\$inputs\/node-\$version\/include\/node" --node-lib "\$inputs\/node.lib"/);
 assert.match(script,/if \(\$LASTEXITCODE -ne 0\) \{ throw 'Native addon build failed' \}/);
 assert.match(script,/require\('.\/packages\/daemon\/native\/windows-stop.node'\)/);
});

test('build and contracts are independent roots but both gate native acceptance',()=>{
 const {build,contracts,checks}=workflow().jobs;
 assert.equal(build.needs,undefined,'native build must not wait for contracts');
 assert.equal(contracts.needs,undefined,'contracts must not wait for native build');
 assert.deepEqual(checks.needs,['contracts','build']);
 assert.equal(checks.if,undefined,'native acceptance must use the default success gate');
});

test('startup and lifecycle fan out after one immutable build and all gate publication',()=>{
 const w=workflow(), c=w.jobs.checks;assert.ok(c,'separate acceptance job required');
 assert.equal(c['runs-on'],'windows-2022');
 assert.equal(c.strategy['fail-fast'],false);assert.deepEqual(c.strategy.matrix.kind,['startup','lifecycle']);assert.deepEqual(c.permissions,{contents:'read'});
 assert.ok(w.jobs.contracts.steps.some(s=>s.run?.includes('scripts/package/test/windows-preview-release.test.mjs')));
 assert.ok(w.jobs.contracts.steps.some(s=>s.run?.includes('scripts/windows/test/daemon-startup.test.mjs')));
 const restore=c.steps.find(s=>s.name==='Verify and restore this build runtime');
 assert.match(restore.run,/Get-FileHash -Algorithm SHA256/);assert.match(restore.run,/RUNTIME_SHA256/);
 assert.ok(restore.run.indexOf('Get-FileHash')<restore.run.indexOf('tar -xf'));
 assert.match(restore.run,/runtime-integrity.mjs verify/);assert.match(restore.run,/windows-preview-release.mjs/);
 assert.ok(c.steps.some(s=>s.if==="matrix.kind == 'startup'"&&s.run?.includes('-DiagnosticsPath')));
 assert.ok(c.steps.some(s=>s.if==="matrix.kind == 'lifecycle'"&&s.run?.includes('-DiagnosticsPath')));
 assert.ok(c.steps.some(s=>s.uses==='actions/upload-artifact@v4'&&s.if==='always()'));
 assert.ok(!w.jobs.build.steps.some(s=>s.run?.includes('test-daemon-startup.ps1')||s.run?.includes('smoke-install.ps1')));
});

test('only preview lifecycle opts into synthetic startup-phase evidence and retains the existing JSON only',()=>{
 const w=workflow(),steps=w.jobs.checks.steps;
 const lifecycle=steps.find(s=>s.run?.includes('./scripts/windows/smoke-install.ps1'));
 const opted=Object.values(w.jobs).flatMap(j=>j.steps).filter(s=>s.env?.GENTLE_DOT_CI_SMOKE_PHASE!==undefined);
 assert.deepEqual(opted,[lifecycle]);assert.equal(lifecycle.if,"matrix.kind == 'lifecycle'");
 assert.equal(lifecycle.env.GENTLE_DOT_CI_SMOKE_PHASE,'1');
 assert.ok(w.jobs.contracts.steps.some(s=>s.run?.includes('scripts/windows/test/smoke-diagnostics.test.mjs')));
 const upload=steps.filter(s=>s.uses==='actions/upload-artifact@v4');
 assert.equal(upload.length,1);assert.equal(upload[0].with.path.trim(),'${{ runner.temp }}/startup-diagnostics.json\n${{ runner.temp }}/lifecycle-diagnostics.json');
});

test('only startup receives the exact producer desktop, bound by its own SHA-256',()=>{
 const w=workflow(), b=w.jobs.build, steps=w.jobs.checks.steps;
 const transfer=b.steps.find(s=>s.id==='desktop');
 assert.ok(transfer,'missing staged desktop transfer');
 assert.ok(b.steps.indexOf(transfer)>b.steps.findIndex(s=>s.run==='./scripts/windows/package.ps1 -Target windows-x64'));
 assert.match(transfer.run,/apps\/desktop\/src-tauri\/target\/x86_64-pc-windows-msvc\/release\/gentle-dot\.exe/);
 assert.match(transfer.run,/Get-FileHash -Algorithm SHA256/);
 assert.equal(b.outputs['desktop-sha256'],'${{ steps.desktop.outputs.sha256 }}');
 const startup=steps.find(s=>s.run?.includes('test-staged-desktop-startup.ps1'));
 assert.equal(startup.if,"matrix.kind == 'startup'");
 assert.equal(startup.env.DESKTOP_SHA256,'${{ needs.build.outputs.desktop-sha256 }}');
 assert.match(startup.run,/-Desktop .* -DesktopSha256 \$env:DESKTOP_SHA256/);
 assert.ok(steps.indexOf(startup)>steps.findIndex(s=>s.run?.includes('runtime-integrity.mjs verify')));
 assert.equal(steps.find(s=>s.with?.name==='windows-preview-desktop')?.if,startup.if);
 assert.ok(!steps.some(s=>s.run?.includes('test-daemon-startup.ps1')));
 assert.ok(w.jobs.contracts.steps.some(s=>s.run?.includes('scripts/windows/test/staged-desktop-startup.test.mjs')));
});

test('startup diagnostics stay opt-in, numeric and after readiness, preserving default quiet containment',()=>{
 const source=readFileSync('scripts/windows/test-daemon-startup.ps1','utf8');
 assert.match(source,/\[string\]\$DiagnosticsPath = ''/);assert.match(source,/GetExitCodeProcess\(IntPtr/);
 assert.match(source,/public int\? ExitCode/);assert.match(source,/if \(\$DiagnosticsPath/);
 assert.match(source,/Write-SmokeDiagnostic -Path \$DiagnosticsPath/);
 assert.ok(source.indexOf("$outcome = 'daemon-startup-earlyexit'")<source.indexOf('Write-SmokeDiagnostic -Path $DiagnosticsPath'));
 assert.match(source,/CreateFileW\("NUL"/);assert.match(source,/\.Environment\.Clear\(\)/);
 assert.doesNotMatch(source,/ReadToEnd|BeginOutputReadLine|BeginErrorReadLine|Write-(Error|Warning)/);
});

test('publication only follows successful build, validates exact payload and creates a nonlatest prerelease',()=>{
 const {publish:p,contracts}=workflow().jobs;
 assert.deepEqual(p.needs,['contracts','build','checks']);
 assert.equal(contracts['continue-on-error'],undefined,'failed contracts must block publication');
 assert.equal(p.if,"success() && github.repository == 'Gentleman-Programming/gentle-dot'");
 assert.deepEqual(p.permissions,{contents:'write'});
 const publish=p.steps.find(s=>s.run?.includes('gh release create'));assert.ok(publish);assert.ok(p.steps.some(s=>s.run?.includes('windows-preview-release.mjs')));
 assert.match(publish.run,/--prerelease/);assert.match(publish.run,/--latest=false/);assert.match(publish.run,/--target "\$SOURCE_SHA"/);assert.match(publish.run,/windows-preview-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/);
 assert.equal(publish.env.GH_TOKEN,'${{ github.token }}');
 for(const [name,job] of Object.entries(workflow().jobs))for(const s of job.steps){
  if(!((name==='build'&&s.id==='managed-admission')||(name==='checks'&&s.id==='packaged-storage')))assert.equal(s['continue-on-error'],undefined);
  if(!s.run?.includes('gh release create')&&s.env)assert.equal(s.env.GH_TOKEN,undefined);
 }
});

test('packaged storage is a bounded startup-only diagnostic after verified restore, not an acceptance gate',()=>{
 const {contracts,checks}=workflow().jobs;
 const step=checks.steps.find(s=>s.id==='packaged-storage');
 assert.ok(step);
 assert.ok(contracts.steps.some(s=>s.run?.includes('scripts/windows/test/packaged-storage-admission.test.mjs')));
 assert.equal(step.if,"matrix.kind == 'startup'");
 assert.equal(step['continue-on-error'],true);
 assert.equal(step['timeout-minutes'],2);
 const position=checks.steps.indexOf(step);
 assert.ok(position>checks.steps.findIndex(s=>s.run?.includes('runtime-integrity.mjs verify')));
 assert.ok(position<checks.steps.findIndex(s=>s.run?.includes('test-staged-desktop-startup.ps1')));
 assert.match(step.run,/build\/windows\/runtime/);
 assert.match(step.run,/node\/node\.exe/);
 assert.match(step.run,/bin\/private-storage\.exe/);
 assert.match(step.run,/ReparsePoint/);
 assert.match(step.run,/GITHUB_STEP_SUMMARY/);
});

test('managed admission adds inert contracts and runs only after all required producer uploads',()=>{
 const {contracts,build}=workflow().jobs;
 const inert=contracts.steps.find(s=>s.name==='Inert managed admission contracts')?.run;
 assert.match(inert,/GENTLE_DOT_CI_TEST_ROOT = Join-Path \$env:RUNNER_TEMP 'retained-admission-contracts'/);
 assert.match(inert,/New-Item -ItemType Directory -Path \$env:GENTLE_DOT_CI_TEST_ROOT/);
 assert.match(inert,/GENTLE_DOT_TEST_PWSH = \(Get-Command pwsh\.exe/);
 assert.match(inert,/^node --test scripts\/windows\/test\/managed-admission\.test\.mjs$/m);
 const diagnostic=build.steps.find(s=>s.id==='managed-admission');
 assert.ok(diagnostic);
 assert.equal(diagnostic.if,undefined);
 assert.equal(diagnostic['continue-on-error'],true);
 assert.equal(diagnostic['timeout-minutes'],15);
 assert.equal(diagnostic.run,'./scripts/windows/test/run-managed-admission.ps1');
 const previous=build.steps.slice(0,build.steps.indexOf(diagnostic));
 assert.deepEqual(previous.filter(s=>s.uses==='actions/upload-artifact@v4').map(s=>s.with.name),
  ['windows-installer-preview','windows-preview-runtime','windows-preview-desktop']);
 assert.deepEqual(previous.find(s=>s.uses==='actions/setup-node@v4').with,{'node-version':'24.14.1',architecture:'x64'});
 const summary=build.steps.at(-1);
 assert.equal(summary.if,"${{ !cancelled() && steps.managed-admission.outcome != 'skipped' }}");
 assert.equal(summary.env.ADMISSION_RESULT,'${{ steps.managed-admission.outputs.result }}');
 assert.match(summary.run,/GITHUB_STEP_SUMMARY/);
 assert.match(summary.run,/'not-completed'/);
});

test('managed admission suppresses raw output and refuses to treat zero tests or a missing marker as success',()=>{
 const runner=readFileSync('scripts/windows/test/run-managed-admission.ps1','utf8');
 const command='cargo test --offline --locked --release --target x86_64-pc-windows-msvc --features tauri/custom-protocol --lib daemon::windows::native::admission_fixture::production_managed_admission -- --exact --ignored --nocapture';
 assert.ok(runner.includes(`$output = @(& ${command} 2>$null)`));
 for(const name of ['NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE','NODE_OPTIONS','NODE_PATH','NODE_V8_COVERAGE','NODE_REDIRECT_WARNINGS','NODE_COMPILE_CACHE']) assert.ok(runner.includes(`'${name}'`));
 assert.match(runner,/\[Environment\]::SetEnvironmentVariable\(\$name, \[NullString\]::Value, 'Process'\)/);
 assert.match(runner,/packages\/ui\/dist\/app\/index\.html/);
 assert.match(runner,/packages\/daemon\/native\/windows-stop\.node/);
 assert.match(runner,/\$exitCode -eq 0[\s\S]*\$onePassed[\s\S]*\$output -ccontains 'admission-result:orderly'/);
 assert.match(runner,/1 passed; 0 failed; 0 ignored; 0 measured;/);
 assert.match(runner,/\^running 0 tests\$/);
 assert.match(runner,/'zero-tests'/);
 assert.match(runner,/if \(\$result -cne 'orderly'\) \{ exit 1 \}/);
 assert.doesNotMatch(runner,/Write-(Host|Error|Output|Warning).*\$(output|_|Error)|Invoke-WebRequest|rustup|SHERPA_ONNX_(LIB|ARCHIVE)_DIR/);
 const producer=readFileSync('scripts/windows/package.ps1','utf8');
 assert.match(producer,/x86_64-pc-windows-msvc/);
 assert.match(producer,/tauri build --config \$config --bundles nsis @targetArgs/);
 const tauri=JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json','utf8'));
 assert.deepEqual([tauri.build.frontendDist,tauri.build.beforeBuildCommand],
  ['../../../packages/ui/dist/app','pnpm --filter @gentle-dot/ui build']);
 const windows=readFileSync('.github/workflows/windows.yml','utf8');
 assert.match(windows,/cargo test --locked --lib/);
 assert.match(windows,/could not find native static\s*\n\s*# library sherpa-onnx-c-api/);
});
