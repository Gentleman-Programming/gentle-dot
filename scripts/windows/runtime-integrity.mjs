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
class WindowsRuntimeTargetError extends Error {}
export function windowsPlatform(target = 'windows-x64') {
  if (!['windows-x64', 'windows-arm64'].includes(target)) throw new WindowsRuntimeTargetError(`Unsupported Windows runtime target: ${target}`);
  return target.replace('windows-', 'win32-');
}
export function seal(root, target) {
  const platform = windowsPlatform(target);
  const files = inventory(root);
  for (const path of REQUIRED) if (!files[path]) throw new Error(`Missing runtime file: ${path}`);
  const native = Object.keys(files).filter(p => p.startsWith('daemon/node_modules/gentle-pi/.gentle-ai/') && p.endsWith('/gentle-ai.exe'));
  if (native.length !== 1) throw new Error('Expected exactly one packaged Gentle AI executable');
  for (const path of ['node/node.exe', 'bin/engram.exe', 'bin/pi.exe', 'bin/private-storage.exe', ...native]) {
    if (readFileSync(join(root,path)).subarray(0,2).toString() !== 'MZ') throw new Error(`Not a Windows executable: ${path}`);
  }
  const data = {schema:1, platform, files};
  writeFileSync(join(root,MANIFEST),JSON.stringify(data,null,2)+'\n');
  return data;
}
export function verify(root, expected, target) {
  const platform = windowsPlatform(target);
  if (expected.schema !== 1 || !['win32-x64', 'win32-arm64'].includes(expected.platform)) throw new Error('Invalid Windows runtime manifest');
  if (expected.platform !== platform) throw new WindowsRuntimeTargetError(`Windows runtime target mismatch: expected ${platform}, got ${expected.platform}`);
  const actual=inventory(root);
  for (const key of new Set([...Object.keys(expected.files), ...Object.keys(actual)])) {
    if (actual[key] !== expected.files[key]) throw new Error(`Runtime integrity mismatch: ${key}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, root, ...args] = process.argv.slice(2);
    if (mode === 'seal' && root && args.length <= 1) seal(root, args[0]);
    else if (mode === 'verify' && root && args[0] && args.length <= 2)
      verify(root, JSON.parse(readFileSync(args[0], 'utf8')), args[1]);
    else throw new Error('Usage: runtime-integrity.mjs seal ROOT [TARGET] | verify ROOT REFERENCE_MANIFEST [TARGET]');
  } catch (error) {
    if (!(error instanceof WindowsRuntimeTargetError)) throw error;
    console.error(error.message);
    process.exitCode = 2;
  }
}
