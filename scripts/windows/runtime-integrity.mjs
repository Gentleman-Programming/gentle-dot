import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED = ['node/node.exe', 'bin/engram.exe', 'bin/pi.exe', 'bin/private-storage.exe', 'daemon/cli.mjs',
  'daemon/node_modules/gentle-pi/bin/gentle-shell.mjs', 'ui/index.html'];
const MANIFEST = 'WINDOWS-INTEGRITY.json';
export function inventory(root, relative = '', result = {}) {
  for (const name of readdirSync(join(root, relative))) {
    const path = relative ? `${relative}/${name}` : name;
    if (path === MANIFEST) continue;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`Runtime links cannot be packaged: ${path}`);
    if (stat.isDirectory()) inventory(root, path, result);
    else if (stat.isFile()) result[path] = createHash('sha256').update(readFileSync(join(root,path))).digest('hex');
    else throw new Error(`Unsupported runtime entry: ${path}`);
  }
  return result;
}
export function seal(root) {
  const files = inventory(root);
  for (const path of REQUIRED) if (!files[path]) throw new Error(`Missing runtime file: ${path}`);
  const native = Object.keys(files).filter(p => p.startsWith('daemon/node_modules/gentle-pi/.gentle-ai/') && p.endsWith('/gentle-ai.exe'));
  if (native.length !== 1) throw new Error('Expected exactly one packaged Gentle AI executable');
  for (const path of ['node/node.exe', 'bin/engram.exe', 'bin/pi.exe', 'bin/private-storage.exe', ...native]) {
    if (readFileSync(join(root,path)).subarray(0,2).toString() !== 'MZ') throw new Error(`Not a Windows executable: ${path}`);
  }
  const data = {schema:1, platform:'win32-x64', files};
  writeFileSync(join(root,MANIFEST),JSON.stringify(data,null,2)+'\n');
  return data;
}
export function verify(root, expected) {
  const actual=inventory(root);
  if (expected.schema !== 1 || expected.platform !== 'win32-x64') throw new Error('Invalid Windows runtime manifest');
  for (const key of new Set([...Object.keys(expected.files), ...Object.keys(actual)])) {
    if (actual[key] !== expected.files[key]) throw new Error(`Runtime integrity mismatch: ${key}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode,root,reference]=process.argv.slice(2);
  if (mode==='seal' && root) seal(root);
  else if (mode==='verify' && root && reference) verify(root,JSON.parse(readFileSync(reference,'utf8')));
  else throw new Error('Usage: runtime-integrity.mjs seal ROOT | verify ROOT REFERENCE_MANIFEST');
}
