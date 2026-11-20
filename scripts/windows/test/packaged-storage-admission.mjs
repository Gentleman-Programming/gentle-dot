// CI-only; the workflow verifies the archive and rejects Windows reparse attributes
// before starting this script with the exact staged Node and an allowlisted environment.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ordinaryDrivePath = /^[a-z]:\\[^\\]/i;

export function probeStorage(runtime, scratch, { exec, stat, read }) {
  const executable = win32.join(runtime, 'bin', 'private-storage.exe');
  const verbatim = win32.toNamespacedPath(executable);
  const absent = win32.join(scratch, 'absent');
  const privateDir = win32.join(scratch, 'private');
  const target = win32.join(privateDir, 'probe.txt');
  const input = Buffer.from('synthetic storage probe\n');
  function invoke(image, operation, path, input) {
    try {
      // Match packages/daemon/src/windows-private-storage.ts; never project its stderr.
      exec(image, [operation, path], {
        input, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true,
        timeout: 15_000, maxBuffer: 64 * 1024 * 1024,
      });
      return 'ok';
    } catch (error) {
      if (error.code === 'ETIMEDOUT') return 'timeout';
      if (Number.isInteger(error.status)) return 'helper-failed';
      if (['ENOENT', 'EINVAL', 'EACCES', 'EPERM', 'UNKNOWN'].includes(error.code) && !error.signal) return 'launch-failed';
      return 'invocation-failed';
    }
  }
  function missing(path) {
    try { stat(path); return false; } catch (error) { return error.code === 'ENOENT'; }
  }
  function control(image) {
    if (!missing(absent)) return 'unexpected-effect';
    const outcome = invoke(image, 'secure-file', win32.join(absent, 'probe.txt'));
    return missing(absent) ? outcome : 'unexpected-effect';
  }
  const ordinary = control(executable);
  const extended = ordinary === 'unexpected-effect' ? 'skipped' : control(verbatim);
  let ensure = 'skipped', write = 'skipped';
  const selected = extended === 'ok' ? verbatim : ordinary === 'ok' ? executable : null;
  if (selected && extended !== 'unexpected-effect') {
    if (!missing(privateDir)) return `${ordinary} ${extended} unexpected-effect skipped`;
    ensure = invoke(selected, 'ensure-dir', privateDir);
    if (ensure === 'ok') {
      try {
        if (!stat(privateDir).isDirectory() || !missing(target)) ensure = 'unexpected-effect';
      } catch { ensure = 'unexpected-effect'; }
    }
    if (ensure === 'ok') {
      write = invoke(selected, 'write-file', target, input);
      if (write === 'ok') {
        try {
          const file = stat(target);
          if (!file.isFile() || file.size !== input.length || !read(target).equals(input)) write = 'unexpected-effect';
        } catch { write = 'unexpected-effect'; }
      }
    }
  }
  return `${ordinary} ${extended} ${ensure} ${write}`;
}

function main() {
  const { CI, GITHUB_ACTIONS, GITHUB_JOB, RUNNER_TEMP } = process.env;
  if (CI !== 'true' || GITHUB_ACTIONS !== 'true' || GITHUB_JOB !== 'checks' ||
      process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.14.1' ||
      process.argv.length !== 2 || !ordinaryDrivePath.test(RUNNER_TEMP ?? '')) return 'prerequisite-failed';
  const runtime = realpathSync.native(fileURLToPath(new URL('../../../build/windows/runtime', import.meta.url)));
  const expectedNode = win32.join(runtime, 'node', 'node.exe');
  const executable = win32.join(runtime, 'bin', 'private-storage.exe');
  if (!ordinaryDrivePath.test(runtime) || realpathSync.native(process.cwd()) !== runtime ||
      realpathSync.native(process.execPath) !== expectedNode || !lstatSync(executable).isFile() ||
      realpathSync.native(executable) !== executable) return 'prerequisite-failed';
  const scratch = mkdtempSync(win32.join(RUNNER_TEMP, 'dot-storage-'));
  return probeStorage(runtime, scratch, { exec: execFileSync, stat: lstatSync, read: readFileSync });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let result = 'prerequisite-failed';
  try { result = main(); } catch { /* do not project paths or raw errors */ }
  console.log(result);
  if (result !== 'ok ok ok ok') process.exitCode = 1;
}
