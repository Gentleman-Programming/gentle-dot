import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUIRED, seal } from '../runtime-integrity.mjs';
const helper = new URL('../installer-path-guard.mjs', import.meta.url);
const load = () => import(helper.href);
function runtime(t) {
  const root = mkdtempSync(join(tmpdir(), 'gentle-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const key of [...REQUIRED, 'daemon/node_modules/gentle-pi/.gentle-ai/v4/gentle-ai.exe']) {
    mkdirSync(dirname(join(root, key)), { recursive: true });
    writeFileSync(join(root, key), key.endsWith('.exe') ? 'MZ-fixture' : 'fixture');
  }
  seal(root);
  return root;
}
test('budget includes UTF16 files, directories, manifest and product executables', async t => {
  const { stagedBudget, destination } = await load();
  const root = runtime(t);
  const key = 'ui/' + 'a'.repeat(80) + '/😀 file.txt';
  mkdirSync(dirname(join(root, key)), { recursive: true });
  writeFileSync(join(root, key), 'fixture'); seal(root);
  const budget = stagedBudget(root);
  const files = Object.keys(JSON.parse(readFileSync(join(root, 'WINDOWS-INTEGRITY.json'))).files)
    .map(k => 'runtime/' + k).concat('runtime/WINDOWS-INTEGRITY.json', 'gentle-dot.exe', 'uninstall.exe');
  const dirs = files.flatMap(k => k.split('/').slice(0, -1).map((_, i) => k.split('/').slice(0, i + 1).join('/')));
  assert.equal(budget.maxDestination, Math.min(259 - 1 - Math.max(...files.map(k => k.length)), 247 - 1 - Math.max(...dirs.map(k => k.length))));
  const valid = 'C:\\Space Dir\\' + 'x'.repeat(budget.maxDestination - 13);
  assert.equal(valid.length, budget.maxDestination);
  assert.equal(destination(valid + '\\\\', budget), valid);
  assert.throws(() => destination(valid + 'x', budget), /Choose a shorter/);
  assert.throws(() => destination('relative', budget), /local absolute/);
  assert.throws(() => destination('C:\\a\\..\\b', budget), /local absolute/);
});
test('file-dominant and empty-directory-dominant payloads use separate ceilings', async t => {
  const { stagedBudget } = await load();
  const fileRoot = runtime(t), dirRoot = runtime(t);
  const key = 'ui/' + 'f'.repeat(180);
  writeFileSync(join(fileRoot, key), 'fixture'); seal(fileRoot);
  assert.equal(stagedBudget(fileRoot).maxDestination, 259 - 1 - ('runtime/' + key).length);
  const empty = 'ui/' + 'd'.repeat(180);
  mkdirSync(join(dirRoot, empty));
  assert.equal(stagedBudget(dirRoot).maxDestination, 247 - 1 - ('runtime/' + empty).length);
});
test('malformed, unsafe and inconsistent staged inventories fail closed', async t => {
  const { stagedBudget } = await load();
  const root = runtime(t), path = join(root, 'WINDOWS-INTEGRITY.json');
  const original = JSON.parse(readFileSync(path));
  for (const key of ['../escape', '/absolute', 'C:/absolute', 'ui\\fake', 'ui//fake', 'ui/./fake']) {
    writeFileSync(path, JSON.stringify({ ...original, files: { ...original.files, [key]: '0'.repeat(64) } }));
    assert.throws(() => stagedBudget(root), /Invalid/);
  }
  for (const files of [null, [], { 'ui/a': 'not-sha256' }]) {
    writeFileSync(path, JSON.stringify({ ...original, files }));
    assert.throws(() => stagedBudget(root), /Invalid/);
  }
  writeFileSync(path, JSON.stringify(original));
  writeFileSync(join(root, 'ui/index.html'), 'drift');
  assert.throws(() => stagedBudget(root), /integrity mismatch/);
});
test('public helper CLI preserves valid paths, rejects before writes, and documents usage', async t => {
  const root = runtime(t);
  const { stagedBudget } = await load();
  const invoke = args => spawnSync(process.execPath, [fileURLToPath(helper), ...args], { encoding: 'utf8', timeout: 30000 });
  const valid = invoke(['destination', root, 'C:\\QA with spaces\\']);
  assert.equal(valid.status, 0); assert.equal(valid.stdout, 'C:\\QA with spaces\n'); assert.equal(valid.stderr, '');
  const rejected = invoke(['destination', root, 'C:\\' + 'x'.repeat(260)]);
  assert.equal(rejected.status, 2); assert.equal(rejected.stdout, '');
  assert.equal(rejected.stderr, `Gentle Dot destination is too long for this staged payload. Choose a shorter local installation folder (maximum ${stagedBudget(root).maxDestination} UTF-16 characters, excluding trailing separators) and run setup again.\n`);
  const usage = invoke([]);
  assert.equal(usage.status, 2); assert.equal(usage.stdout, '');
  assert.equal(usage.stderr, 'Usage: installer-path-guard.mjs hook STAGED_ROOT OUTPUT.nsh | destination STAGED_ROOT ABSOLUTE_DESTINATION\n');
  assert.equal(readFileSync(join(root, 'ui/index.html'), 'utf8'), 'fixture');
});
test('native NSIS boundary: reject before sentinel changes; preserve valid extraction', { skip: process.platform !== 'win32' }, async () => {
  const deadline = Date.now() + 30000;
  const timeout = () => Math.max(1, deadline - Date.now());
  // No registry, shortcut, product executable, or existing installation is touched.
  const area = resolve('build/windows/path-guard-fixtures', 'run-' + Date.now());
  mkdirSync(area, { recursive: true });
  const compiler = join(process.env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe');
  assert.ok(existsSync(compiler), 'existing Tauri NSIS compiler required');
  const api = existsSync(helper) ? await load() : null;
  const budget = { maxDestination: Math.max(100, area.length + 9) };
  const cap = budget.maxDestination;
  assert.ok(cap < 230, 'fixture checkout must leave room for the 247-character directory boundary');
  const hook = api ? api.renderHook(budget) : '!macro NSIS_HOOK_PREINSTALL\n!macroend\n';
  writeFileSync(join(area, 'hooks.nsh'), hook);
  writeFileSync(join(area, 'payload.txt'), 'sentinel-v1');
  function compile(name, guarded, suffix = '') {
    const exe = join(area, name + '.exe');
    const script = join(area, name + '.nsi');
    writeFileSync(script, `Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${exe}"\n${guarded ? `!include "${join(area, 'hooks.nsh')}"` : ''}\nSection\nSetOutPath "$INSTDIR${suffix}"\n${guarded ? '!insertmacro NSIS_HOOK_PREINSTALL' : ''}\nFile /oname=payload.txt "${join(area, 'payload.txt')}"\nFile /oname=counter.txt "${join(area, 'payload.txt')}"\nSectionEnd\n`);
    const compiled = spawnSync(compiler, ['/V2', script], { encoding: 'utf8', timeout: timeout() });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    return exe;
  }
  const exe = compile('guarded', true);
  function run(dest, code, binary = exe) {
    // NSIS /D consumes the rest of the command line verbatim, not CRT quoting.
    const result = spawnSync(binary, ['/S', '/D=' + dest], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: timeout() });
    if (code !== null) assert.equal(result.status, code, JSON.stringify(result));
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    assert.equal(result.signal, null); assert.equal(result.error, undefined);
    return result.status;
  }
  const base = area + '\\';
  assert.ok(base.length < cap);
  const valid = base + 'v'.repeat(cap - base.length);
  const invalid = valid + 'x';
  run(invalid, 2); assert.equal(existsSync(invalid), false);
  mkdirSync(invalid); writeFileSync(join(invalid, 'payload.txt'), 'unchanged');
  writeFileSync(join(invalid, 'counter.txt'), '0');
  run(invalid, 2); assert.equal(readFileSync(join(invalid, 'payload.txt'), 'utf8'), 'unchanged');
  assert.equal(readFileSync(join(invalid, 'counter.txt'), 'utf8'), '0');
  run(valid, 0); assert.equal(readFileSync(join(valid, 'payload.txt'), 'utf8'), 'sentinel-v1');
  for (const unicodeBase of [base, base + 'l'.repeat(cap - 4 - base.length) + '\\']) {
    // Keep the astral pair intact and always finish with a legal non-space character.
    const prefix = cap - unicodeBase.length >= 4 ? '😀 ' : '😀';
    const unicode = unicodeBase + prefix + 'u'.repeat(cap - unicodeBase.length - prefix.length);
    run(unicode + '\\', 0); assert.equal(readFileSync(join(unicode, 'payload.txt'), 'utf8'), 'sentinel-v1');
  }
  const baseline = compile('baseline', false);
  const before = readFileSync(join(valid, 'payload.txt'));
  run(valid, 0, baseline); assert.deepEqual(readFileSync(join(valid, 'payload.txt')), before);
  // Actual legacy boundary: directory=247, file=259 (11-character filename).
  const suffix = '\\' + 'd'.repeat(247 - cap - 1);
  const boundary = compile('boundary', true, suffix);
  run(valid, 0, boundary);
  const leaf = valid + suffix + '\\payload.txt';
  assert.equal((valid + suffix).length, 247); assert.equal(leaf.length, 259);
  assert.equal(readFileSync(leaf, 'utf8'), 'sentinel-v1');
  // Original extraction cliff, with no guard: directory=248 and file=260.
  const cliff = compile('cliff', false, suffix);
  const cliffDestination = base + 'c'.repeat(cap + 1 - base.length);
  const cliffCode = run(cliffDestination, null, cliff);
  assert.equal(existsSync(cliffDestination + suffix + '\\payload.txt'), false);
  console.log(`Native cliff: directory=248/file=260, exit=${cliffCode}, payload absent`);
  console.log('Native evidence: ' + area);
});

// Model Tauri 2.12.1's custom maintenance page BEFORE Directory/sections.
// Only ExecWait's effect is substituted with an owned file counter, never an uninstaller.
for (const rule of ['maintenance', 'traversal']) {
  test(`native ${rule} rejection precedes PageLeaveReinstall effects`, { skip: process.platform !== 'win32' }, async t => {
    const deadline = Date.now() + 30000;
    const area = resolve('build/windows/path-guard-fixtures', rule + '-' + Date.now());
    mkdirSync(area, { recursive: true });
    const counter = join(area, 'counter.txt'), sentinel = join(area, 'sentinel.txt');
    const budget = { maxDestination: Math.max(108, area.length + 30) };
    const { renderHook, destination } = await load();
    writeFileSync(join(area, 'hooks.nsh'), renderHook(budget));
    writeFileSync(sentinel, 'preserve');
    const invalid = rule === 'maintenance' ? area + '\\' + 'x'.repeat(budget.maxDestination - area.length) : area + '\\v\\..\\escape';
    const escaped = join(area, 'escape');
    assert.throws(() => destination(invalid, budget));
    if (rule === 'traversal') {
      const root = runtime(t);
      const result = spawnSync(process.execPath, [fileURLToPath(helper), 'destination', root, invalid], { encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 2); assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Choose a local absolute Windows destination without traversal or reserved characters.\n');
    }
    function compile(guarded, collision = false) {
      const exe = join(area, `${guarded ? 'guarded' : 'baseline'}${collision ? '-collision' : ''}.exe`);
      const source = exe + '.nsi';
      writeFileSync(source, `Unicode true
RequestExecutionLevel user
OutFile "${exe}"
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
${collision ? '!define MUI_CUSTOMFUNCTION_GUIINIT ExistingCallback' : ''}
${guarded ? `!include "${join(area, 'hooks.nsh')}"` : ''}
Var WixMode
Var UpdateMode
Var PassiveMode
Page custom PageReinstall PageLeaveReinstall
Function PageReinstall
  ; Auto-select the uninstall branch, avoiding interactive controls in this fixture.
  StrCpy $R0 1
  StrCpy $R1 1
  Call PageLeaveReinstall
  Quit
FunctionEnd
Function PageLeaveReinstall
  \${If} $WixMode = 1
    Goto reinst_uninstall
  \${EndIf}
  \${If} $UpdateMode = 1
    Goto reinst_done
  \${EndIf}
  \${If} $R0 = 0
    \${If} $R1 = 1
      Goto reinst_done
    \${Else}
      Goto reinst_uninstall
    \${EndIf}
  \${ElseIf} $R0 = 1
    \${If} $R1 = 1
      Goto reinst_uninstall
    \${Else}
      Goto reinst_done
    \${EndIf}
  \${ElseIf} $R0 = -1
    \${If} $R1 = 1
      Goto reinst_uninstall
    \${Else}
      Goto reinst_done
    \${EndIf}
  \${EndIf}
  reinst_uninstall:
  FileOpen $0 "${counter}" w
  FileWrite $0 "uninstall-effect"
  FileClose $0
  reinst_done:
FunctionEnd
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Function .onInit
  \${GetOptions} $CMDLINE "/P" $PassiveMode
FunctionEnd
Section
  SetOutPath "$INSTDIR"
  ${guarded ? '!insertmacro NSIS_HOOK_PREINSTALL' : ''}
  File /oname=payload.txt "${sentinel}"
SectionEnd
`);
      const result = spawnSync(join(process.env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe'), ['/V2', source], { encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()) });
      if (collision) { assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /MUI_CUSTOMFUNCTION_GUIINIT/); }
      else assert.equal(result.status, 0, result.stdout + result.stderr);
      return exe;
    }
    const guarded = compile(true), baseline = compile(false);
    for (const mode of rule === 'traversal' ? ['/S', '/P'] : ['/P', '/S']) {
      writeFileSync(counter, '0');
      const result = spawnSync(guarded, [mode, '/D=' + invalid], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: Math.max(1, deadline - Date.now()) });
      assert.equal(result.status, 2, JSON.stringify(result));
      assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
      assert.equal(readFileSync(counter, 'utf8'), '0');
      assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
      assert.equal(existsSync(rule === 'maintenance' ? invalid : escaped), false);
      console.log(`${rule} ${mode}: exit=2 stdout="" stderr="" counter=0 sentinel=preserve destination absent`);
    }
    if (rule === 'maintenance') {
      writeFileSync(counter, '0');
      const result = spawnSync(baseline, ['/P', '/D=' + invalid], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: Math.max(1, deadline - Date.now()) });
      assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
      assert.equal(readFileSync(counter, 'utf8'), 'uninstall-effect');
      compile(true, true); // Refuse an existing callback rather than replacing it.
      console.log('maintenance baseline /P: exit=0 stdout="" stderr="" counter=uninstall-effect');
      // A supported initial destination must not suppress existing maintenance behavior.
      const valid = join(area, 'valid');
      for (const binary of [baseline, guarded]) {
        writeFileSync(counter, '0');
        const preserved = spawnSync(binary, ['/P', '/D=' + valid], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: Math.max(1, deadline - Date.now()) });
        assert.equal(preserved.status, 0, JSON.stringify(preserved)); assert.equal(preserved.stdout, ''); assert.equal(preserved.stderr, '');
        assert.equal(readFileSync(counter, 'utf8'), 'uninstall-effect');
        assert.equal(existsSync(valid), false);
      }
    } else {
      const result = spawnSync(baseline, ['/S', '/D=' + invalid], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: Math.max(1, deadline - Date.now()) });
      assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
      assert.equal(readFileSync(join(escaped, 'payload.txt'), 'utf8'), 'preserve');
      console.log('traversal baseline /S: exit=0 stdout="" stderr="" escaped payload=preserve');
    }
    console.log('Native correction evidence: ' + area);
  });
}
