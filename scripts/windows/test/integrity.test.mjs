import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REQUIRED, seal, verify } from '../runtime-integrity.mjs';
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'gentle-dot-integrity-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for (const path of [...REQUIRED,'daemon/node_modules/gentle-pi/.gentle-ai/v4/gentle-ai.exe']) {
    mkdirSync(dirname(join(root,path)),{recursive:true});
    writeFileSync(join(root,path),path.endsWith('.exe')?'MZ-fixture-never-executed':'fixture');
  }
  return root;
}
test('all runtime files match after sealing', t=> {
  const root=fixture(t);const expected=seal(root);
  assert.ok(Object.keys(expected.files).length > REQUIRED.length);
  verify(root,expected);
});
test('corruption, omission and unexpected additions are rejected',t=> {
  const root=fixture(t);const expected=seal(root);
  writeFileSync(join(root,'ui/index.html'),'corrupt');
  assert.throws(()=>verify(root,expected), /mismatch/);
  writeFileSync(join(root,'ui/index.html'),'fixture');
  rmSync(join(root,'node/node.exe'));
  assert.throws(()=>verify(root,expected), /mismatch/);
  writeFileSync(join(root,'node/node.exe'),'MZ-fixture-never-executed');
  writeFileSync(join(root,'unexpected.txt'),'extra');
  assert.throws(()=>verify(root,expected), /mismatch/);
});
test('missing native engine, wrong executable and absent UI fail before packaging', t=> {
  const root=fixture(t);
  writeFileSync(join(root,'node/node.exe'),'not an executable');
  assert.throws(()=>seal(root), /Not a Windows executable/);
  writeFileSync(join(root,'node/node.exe'),'MZ-fixture-never-executed');
  writeFileSync(join(root,'bin/pi.exe'),'not an executable');
  assert.throws(()=>seal(root), /Not a Windows executable: bin\/pi\.exe/);
  writeFileSync(join(root,'bin/pi.exe'),'MZ-fixture-never-executed');
  rmSync(join(root,'daemon/node_modules/gentle-pi/.gentle-ai/v4/gentle-ai.exe'));
  assert.throws(()=>seal(root), /exactly one/);
  rmSync(join(root,'ui/index.html'));
  assert.throws(()=>seal(root), /Missing runtime file/);
});
test('directory links cannot silently escape the packaged runtime', t=> {
  const root=fixture(t);
  const outside=mkdtempSync(join(tmpdir(),'gentle-dot-outside-'));
  t.after(()=>rmSync(outside,{recursive:true,force:true}));
  symlinkSync(outside,join(root,'outside'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>seal(root), /links cannot be packaged/);
});
