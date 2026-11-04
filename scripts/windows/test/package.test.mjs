import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { REQUIRED, seal } from '../runtime-integrity.mjs';

const scratch = 'C:/Users/maicolj/AppData/Local/Temp/gentle-dot-windows-es-verify/';
function copyFixture(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const file of readdirSync(src, { withFileTypes: true })) {
    if (file.isDirectory()) copyFixture(join(src, file.name), join(dest, file.name));
    else copyFileSync(join(src, file.name), join(dest, file.name));
  }
}
const help = 'Usage: package.ps1 [--runtime PATH] [--skip-stage] [--check] [--bundles nsis,msi|nsis|msi] [--help]\n' +
  'Stages the default runtime unless --skip-stage or --runtime is supplied.\n' +
  '--check validates only: no staging, icon generation, or installer build.\n';

function fixture() {
  const root = mkdtempSync(join(scratch, 'package-cli-'));
  const scripts = join(root, 'scripts/windows');
  mkdirSync(scripts, { recursive: true });
  for (const file of ['package.ps1', 'runtime-integrity.mjs', 'package-plan.mjs'])
    copyFileSync(new URL('../' + file, import.meta.url), join(scripts, file));
  const runtime = join(root, 'fixture runtime');
  for (const file of [...REQUIRED, 'daemon/node_modules/gentle-pi/.gentle-ai/v4/gentle-ai.exe']) {
    mkdirSync(dirname(join(runtime, file)), { recursive: true });
    writeFileSync(join(runtime, file), file.endsWith('.exe') ? 'MZ-offline-fixture' : 'fixture');
  }
  seal(runtime);
  writeFileSync(join(scripts, 'stage.ps1'), `
$repo = (Resolve-Path "$PSScriptRoot/../..").Path
Add-Content (Join-Path $repo 'calls.txt') 'stage'
$out = Join-Path $repo 'build/windows/runtime'
if (Test-Path $out) { throw 'Fixture refuses existing runtime' }
New-Item -ItemType Directory (Split-Path $out) -Force | Out-Null
Copy-Item (Join-Path $repo 'fixture runtime') $out -Recurse
`);
  const tools = join(root, 'tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'pnpm.cmd'), `@echo off\r\necho %*>>"${join(root, 'calls.txt')}"\r\nexit /b 0\r\n`);
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    const name = Object.keys(process.env).find(name => name.toLowerCase() === key.toLowerCase());
    if (name) env[key] = process.env[name];
  }
  env.PATH = [tools, dirname(process.execPath), join(env.SystemRoot, 'System32'),
    join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0')].join(';');
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'XDG_CACHE_HOME']) {
    env[key] = join(root, 'profile', key);
    mkdirSync(env[key], { recursive: true });
  }
  env.OS = 'Windows_NT';
  env.PROCESSOR_ARCHITECTURE = 'AMD64';
  const run = (...args) => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(scripts, 'package.ps1'), ...args],
      { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(result.error, undefined);
    return { code: result.status, stdout: result.stdout.replace(/\r\n/g, '\n'), stderr: result.stderr.replace(/\r\n/g, '\n') };
  };
  const calls = () => existsSync(join(root, 'calls.txt')) ? readFileSync(join(root, 'calls.txt'), 'utf8').trim().split(/\r?\n/) : [];
  return { root, runtime, run, calls };
}
function snapshot(root) {
  const files = {};
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const file = prefix + name.name;
      if (name.isDirectory()) walk(join(dir, name.name), file + '/');
      else files[file] = readFileSync(join(dir, name.name)).toString('base64');
    }
  }
  walk(root);
  return files;
}
const icon = "--filter @gentle-dot/desktop exec tauri icon src-tauri/icons/icon.png --output ../../build/windows/icons";
function build(f, bundles) {
  return `--filter @gentle-dot/desktop exec tauri build --config ${join(f.root, 'build/windows/bundle.json')} --bundles ${bundles}`;
}

test('help is exact and performs no staging or build', () => {
  const f = fixture();
  assert.deepEqual(f.run('--help'), { code: 0, stdout: help, stderr: '' });
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(join(f.root, 'build')), false);
});
test('default auto-stage validates then selects both installer formats', () => {
  const f = fixture();
  assert.deepEqual(f.run(), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(f.calls(), ['stage', icon, build(f, 'nsis,msi')]);
  const config = JSON.parse(readFileSync(join(f.root, 'build/windows/bundle.json')));
  assert.deepEqual(config.bundle.targets, ['nsis', 'msi']);
  assert.deepEqual(config.bundle.resources, { [join(f.root, 'build/windows/runtime')]: 'runtime' });
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');
});
for (const bundles of ['nsis', 'msi', 'nsis,msi']) test(`explicit runtime selects ${bundles} without staging or changing runtime`, () => {
  const f = fixture(); const before = snapshot(f.runtime);
  assert.deepEqual(f.run('--runtime', f.runtime, '--bundles', bundles), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(f.calls(), [icon, build(f, bundles)]);
  assert.deepEqual(snapshot(f.runtime), before);
});
test('skip-stage uses the existing default runtime without restaging', () => {
  const f = fixture();
  const runtime = join(f.root, 'build/windows/runtime');
  mkdirSync(dirname(runtime), { recursive: true });
  // Copy fixture bytes only, never an installed runtime or user profile.
  copyFixture(f.runtime, runtime);
  const before = snapshot(runtime);
  assert.deepEqual(f.run('--skip-stage'), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(f.calls(), [icon, build(f, 'nsis,msi')]);
  assert.deepEqual(snapshot(runtime), before);
});
test('check validates an explicit runtime without any build writes', () => {
  const f = fixture(); const before = snapshot(f.runtime);
  assert.deepEqual(f.run('--check', '--runtime', f.runtime), { code: 0, stdout: `Windows runtime verified: ${f.runtime}\n`, stderr: '' });
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(join(f.root, 'build')), false);
  assert.deepEqual(snapshot(f.runtime), before);
});
for (const args of [['--check'], ['--skip-stage']]) test(`${args[0]} rejects a missing runtime without staging`, () => {
  const f = fixture(); const before = snapshot(f.runtime);
  assert.deepEqual(f.run(...args), { code: 1, stdout: '', stderr: `Windows packaging: Runtime directory is missing: ${join(f.root, 'build/windows/runtime')}\n` });
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(snapshot(f.runtime), before);
  assert.equal(existsSync(join(f.root, 'build')), false);
});
for (const [args, message] of [
  [['--unknown'], 'Unknown option: --unknown'],
  [['--runtime'], 'Missing value for --runtime'],
  [['--bundles'], 'Missing value for --bundles'],
  [['--bundles', 'deb'], 'Bundles must be nsis, msi, or nsis,msi.'],
  [['--bundles', 'nsis,nsis'], 'Bundles must be nsis, msi, or nsis,msi.'],
]) test(`invalid options fail before writes: ${args.join(' ')}`, () => {
  const f = fixture(); const before = snapshot(f.runtime);
  assert.deepEqual(f.run(...args), { code: 1, stdout: '', stderr: `Windows packaging: ${message}\n` });
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(snapshot(f.runtime), before);
  assert.equal(existsSync(join(f.root, 'build')), false);
});
test('missing manifest fails without touching runtime or invoking build tools', () => {
  const f = fixture(); const runtime = join(f.root, 'unsealed runtime');
  mkdirSync(runtime);
  writeFileSync(join(runtime, 'keep.txt'), 'original');
  const before = snapshot(runtime);
  assert.deepEqual(f.run('--runtime', runtime), { code: 1, stdout: '', stderr: 'Windows packaging: Missing or invalid WINDOWS-INTEGRITY.json\n' });
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(snapshot(runtime), before);
  assert.equal(existsSync(join(f.root, 'build')), false);
});
test('failed icon generation stops before the installer build', () => {
  const f = fixture(); const before = snapshot(f.runtime);
  writeFileSync(join(f.root, 'tools/pnpm.cmd'), `@echo off\r\necho %*>>"${join(f.root, 'calls.txt')}"\r\nexit /b 7\r\n`);
  assert.deepEqual(f.run('--runtime', f.runtime), { code: 1, stdout: '', stderr: 'Windows packaging: Windows icon generation failed.\n' });
  assert.deepEqual(f.calls(), [icon]);
  assert.deepEqual(snapshot(f.runtime), before);
});
test('failed installer build propagates failure without modifying the explicit runtime', () => {
  const f = fixture(); const before = snapshot(f.runtime);
  writeFileSync(join(f.root, 'tools/pnpm.cmd'), `@echo off\r\necho %*>>"${join(f.root, 'calls.txt')}"\r\nif "%~5"=="build" exit /b 9\r\nexit /b 0\r\n`);
  assert.deepEqual(f.run('--runtime', f.runtime), { code: 1, stdout: '', stderr: 'Windows packaging: Windows installer build failed.\n' });
  assert.deepEqual(f.calls(), [icon, build(f, 'nsis,msi')]);
  assert.deepEqual(snapshot(f.runtime), before);
});
test('corrupt runtime fails before icon/build and retains original bytes', () => {
  const f = fixture();
  writeFileSync(join(f.runtime, 'ui/index.html'), 'tampered');
  const before = snapshot(f.runtime);
  assert.deepEqual(f.run('--runtime', f.runtime), { code: 1, stdout: '', stderr: 'Windows packaging: Runtime integrity mismatch: ui/index.html\n' });
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(snapshot(f.runtime), before);
  assert.equal(existsSync(join(f.root, 'build')), false);
});
test('check accepts the default runtime without restaging or changing build data', () => {
  const f = fixture(); const runtime = join(f.root, 'build/windows/runtime');
  copyFixture(f.runtime, runtime);
  writeFileSync(join(f.root, 'build/windows/keep.txt'), 'existing build data');
  const before = snapshot(join(f.root, 'build'));
  assert.deepEqual(f.run('--check'), { code: 0, stdout: `Windows runtime verified: ${runtime}\n`, stderr: '' });
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(snapshot(join(f.root, 'build')), before);
});
test('automatic staging preserves the real stager refusal of existing runtime', () => {
  const f = fixture(); const runtime = join(f.root, 'build/windows/runtime');
  copyFixture(f.runtime, runtime);
  copyFileSync(new URL('../stage.ps1', import.meta.url), join(f.root, 'scripts/windows/stage.ps1'));
  const before = snapshot(runtime);
  assert.deepEqual(f.run(), { code: 1, stdout: '', stderr: `Windows packaging: Staging already exists: ${runtime}. Use a clean checkout or remove only that generated folder.\n` });
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(snapshot(runtime), before);
});
for (const contents of ['', '{', 'null', '{"schema":1,"platform":"win32-x64","files":[]}']) test(`invalid manifest rejects without writes: ${contents}`, () => {
  const f = fixture();
  writeFileSync(join(f.runtime, 'WINDOWS-INTEGRITY.json'), contents);
  const before = snapshot(f.runtime);
  const message = contents === '' || contents === '{' ? 'Missing or invalid WINDOWS-INTEGRITY.json' : 'Invalid Windows runtime manifest';
  assert.deepEqual(f.run('--runtime', f.runtime, '--check'), { code: 1, stdout: '', stderr: `Windows packaging: ${message}\n` });
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(snapshot(f.runtime), before);
});
test('a manifest with matching hashes cannot bless a non-Windows executable', () => {
  const f = fixture();
  writeFileSync(join(f.runtime, 'node/node.exe'), 'not PE');
  const manifest = JSON.parse(readFileSync(join(f.runtime, 'WINDOWS-INTEGRITY.json')));
  // Recompute fixture identity without calling seal, which correctly refuses it.
  manifest.files['node/node.exe'] = createHash('sha256').update('not PE').digest('hex');
  writeFileSync(join(f.runtime, 'WINDOWS-INTEGRITY.json'), JSON.stringify(manifest));
  const before = snapshot(f.runtime);
  assert.deepEqual(f.run('--check', '--runtime', f.runtime), { code: 1, stdout: '', stderr: 'Windows packaging: Not a Windows executable: node/node.exe\n' });
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(snapshot(f.runtime), before);
});
test('a self-consistent manifest cannot omit mandatory executables', () => {
  const f = fixture();
  const manifest = join(f.runtime, 'WINDOWS-INTEGRITY.json');
  // An empty, self-consistent tree still is not a distributable runtime.
  const empty = join(f.root, 'empty runtime'); mkdirSync(empty);
  copyFileSync(manifest, join(f.root, 'original-manifest.json'));
  writeFileSync(join(empty, 'WINDOWS-INTEGRITY.json'), JSON.stringify({ schema: 1, platform: 'win32-x64', files: {} }));
  const before = snapshot(empty);
  assert.deepEqual(f.run('--check', '--runtime', empty), { code: 1, stdout: '', stderr: 'Windows packaging: Missing runtime file: node/node.exe\n' });
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(snapshot(empty), before);
});
