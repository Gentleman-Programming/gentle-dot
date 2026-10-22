import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWindowsEngram, windowsUserHome } from '../../../packages/daemon/src/windows-runtime.ts';
const runtime = 'C:\\Program Files\\Gentle Dot\\runtime';
const bundled = runtime + '\\bin\\engram.exe';
const choose = (env, files) => resolveWindowsEngram(env, runtime, { isFile: p => files.includes(p) });

test('Explorer home wins over inherited MSYS HOME', () => {
  assert.equal(windowsUserHome({USERPROFILE:'C:\\Users\\Maix', HOME:'/home/foreign'}), 'C:\\Users\\Maix');
  assert.equal(windowsUserHome({homedrive:'D:', homepath:'\\Profiles\\Maix'}), 'D:\\Profiles\\Maix');
  assert.equal(windowsUserHome({USERPROFILE:'relative', HOME:'/home/foreign'}), undefined);
});
test('explicit binary is retained; a broken override cannot silently fall back', () => {
  const exe = 'D:\\My Tools\\engram.exe';
  assert.equal(choose({ENGRAM_BIN:exe},[exe,bundled]),exe);
  for (const invalid of ['C:engram.exe', '\\engram.exe', '!command', 'engram', 'C:\\engram.cmd', exe]) {
    assert.throws(()=>choose({ENGRAM_BIN:invalid},[bundled]), /ENGRAM_BIN/);
  }
});
test('Windows Path casing, spaces and quoted folders are supported without invoking a shell', () => {
  const exe = 'D:\\My Tools\\engram.exe';
  const env = {Path:'"D:\\My Tools";C:\\Windows\\System32'};
  assert.equal(choose(env,[exe,bundled]),exe);
  assert.deepEqual(env,{Path:'"D:\\My Tools";C:\\Windows\\System32'});
});
test('empty and relative PATH entries never search the current working directory', () => {
  const tried=[];
  assert.equal(resolveWindowsEngram({PATH:';.\\tools;C:relative;\\root-relative'},runtime,{isFile:p=>{tried.push(p);return p===bundled;}}),bundled);
  assert.deepEqual(tried,[bundled]);
});
test('duplicate directories are probed once ignoring Windows case', () => {
  const tried=[];
  choose({},[bundled]);
  resolveWindowsEngram({PATH:'D:\\Tools;d:\\tools'},runtime,{isFile:p=>{tried.push(p);return p===bundled;}});
  assert.deepEqual(tried,['D:\\Tools\\engram.exe',bundled]);
});
test('known home folder precedes the bundle and does not need HOME', () => {
  const exe='C:\\Users\\Maix\\go\\bin\\engram.exe';
  assert.equal(choose({USERPROFILE:'C:\\Users\\Maix'},[exe,bundled]),exe);
});
test('UNC locations are supported; no missing runtime path is reported as installed', () => {
  const exe='\\\\server\\tools\\engram.exe';
  assert.equal(choose({PATH:'\\\\server\\tools'},[exe]),exe);
  assert.throws(()=>choose({},[]), /Engram is missing/);
  assert.throws(()=>resolveWindowsEngram({},'runtime',{isFile:()=>true}), /absolute path/);
});
test('real file discovery refuses a missing explicit file',()=> {
  assert.throws(()=>resolveWindowsEngram({ENGRAM_BIN:'C:\\missing-gentle-dot-fixture\\engram.exe'},runtime), /ENGRAM_BIN/);
});

test('the production resolver retains an explicit real file on the host platform', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { resolveEngramBin } = await import('../../../packages/daemon/src/runtime.ts');
  const folder=mkdtempSync(join(tmpdir(),'gentle-dot-runtime-'));
  try {
    const exe=join(folder,'engram.exe');
    writeFileSync(exe,'discovery fixture, never executed');
    assert.equal(resolveEngramBin({ENGRAM_BIN:exe},folder),exe);
  } finally {rmSync(folder,{recursive:true,force:true});}
});
