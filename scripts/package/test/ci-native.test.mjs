import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const scratch = process.env.GENTLE_DOT_CI_TEST_ROOT;
assert.ok(scratch, 'Set GENTLE_DOT_CI_TEST_ROOT to an authorized retained system-temp directory.');
mkdirSync(scratch, { recursive: true });
const run = mkdtempSync(join(scratch, 'contracts-'));
console.log(`Retained inert fixtures: ${run}`);
const cli = resolve('scripts/package/ci-native.mjs');
const sha = 'a'.repeat(40);
const targets = [
 ['windows-x64', 'windows-2022', 'win32', 'x64', 'x86_64-pc-windows-msvc'],
 ['windows-arm64', 'windows-11-arm', 'win32', 'arm64', 'aarch64-pc-windows-msvc'],
 ['linux-x64', 'ubuntu-24.04', 'linux', 'x64', 'x86_64-unknown-linux-gnu'],
 ['linux-arm64', 'ubuntu-24.04-arm', 'linux', 'arm64', 'aarch64-unknown-linux-gnu'],
 ['darwin-x64', 'macos-15-intel', 'darwin', 'x64', 'x86_64-apple-darwin'],
 ['darwin-arm64', 'macos-15', 'darwin', 'arm64', 'aarch64-apple-darwin'],
];
function call(args, cwd) {
 return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, OS: process.env.OS,
 } });
}
function snapshot(dir) {
 return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
  .map(e => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name)).toString('hex')]);
}
const digest = data => createHash('sha256').update(data).digest('hex');

test('six selectors describe native runners, tools, producers and installer evidence', async () => {
 const result = call(['matrix']);
 assert.equal(result.status, 0); assert.equal(result.stderr, '');
 const matrix = JSON.parse(result.stdout);
 assert.equal(matrix.include.length, 6);
 for (const [target, runner, platform, arch, rust] of targets) {
  const item = matrix.include.find(x => x.target === target);
  assert.equal(item.runner, runner); assert.equal(item.platform, platform);
  assert.equal(item.arch, arch); assert.equal(item.rust, rust);
  assert.ok(item.build.includes(target)); assert.ok(item.runtimeManifest);
  assert.ok(item.installers.length); assert.ok(item.check);
 }
 const { plan } = await import('../ci-native.mjs');
 for (const [target, , platform, arch] of targets) {
  const value = plan(target, sha, process.cwd(), { platform, arch });
  assert.equal(value.artifactName, `gentle-dot-0.1.0-${target}-${sha}-qa`);
  assert.throws(() => plan(target, sha, process.cwd(), { platform: 'unsupported', arch }), /Native host mismatch/);
 }
});

test('invalid CLI input fails exactly without changing any artifact', () => {
 const out = join(run, 'untouched'); mkdirSync(out); writeFileSync(join(out, 'canary'), 'retain');
 const before = snapshot(run);
 const cases = [
  [[], 'Expected matrix, plan or collect.'],
  [['plan'], 'Missing --target.'],
  [['plan', '--target'], 'Missing value for --target.'],
  [['plan', '--target', 'bogus', '--source', sha], 'Unknown target bogus.'],
  [['plan', '--target', 'windows-x64', '--target', 'windows-x64'], 'Duplicate --target.'],
  [['plan', '--target', 'windows-x64', '--source', sha, '--source', sha], 'Duplicate --source.'],
  [['plan', '--wat', 'x'], 'Unknown option --wat.'],
  [['matrix', '--target', 'windows-x64'], 'matrix takes no options.'],
  [['collect', '--target', 'windows-x64', '--source', sha, '--out', out, '--out', out], 'Duplicate --out.'],
  [['plan', '--target', 'windows-x64', '--source', sha, '--root', out, '--root', out], 'Duplicate --root.'],
  [['plan', '--target', 'windows-x64', '--source'], 'Missing value for --source.'],
  [['plan', '--target', 'windows-x64', '--source', sha, '--root'], 'Missing value for --root.'],
  [['collect', '--target', 'windows-x64', '--source', sha, '--out'], 'Missing value for --out.'],
  [['plan', '--target', 'windows-x64'], 'Missing --source.'],
  [['plan', '--target', 'windows-x64', '--source', 'main'], 'Source must be a full lowercase Git SHA.'],
  [['collect', '--target', 'windows-x64', '--source', sha], 'Missing --out.'],
 ];
 for (const [args, error] of cases) {
  const result = call(args); assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, `ci-native: ${error}\n`);
  assert.deepEqual(snapshot(run), before);
 }
 const mismatch = targets.find(([, , platform, arch]) => platform !== process.platform || arch !== process.arch)[0];
 const result = call(['collect', '--target', mismatch, '--source', sha, '--out', out]);
 assert.equal(result.status, 2); assert.equal(result.stdout, '');
 assert.equal(result.stderr, `ci-native: Native host mismatch for ${mismatch}; use matching OS and Node architecture.\n`);
 assert.deepEqual(snapshot(run), before);
});

test('collect hashes every installer and producer manifest; rejected collections are write-free', async () => {
 const { matrix, collect } = await import('../ci-native.mjs');
 for (const item of matrix.include) {
  const root = join(run, item.target); mkdirSync(root);
  mkdirSync(join(root, 'apps/desktop/src-tauri'), { recursive: true });
  writeFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.1.0' }));
  const host = { platform: item.platform, arch: item.arch };
  const out = join(root, 'qa');
  const before = snapshot(root);
  assert.throws(() => collect(item.target, sha, root, out, host), /Expected exactly one installer/);
  assert.equal(existsSync(out), false); assert.deepEqual(snapshot(root), before);
  for (const [index, installer] of item.installers.entries()) {
   mkdirSync(join(root, installer.directory), { recursive: true });
   writeFileSync(join(root, installer.directory, `fixture${installer.suffix}`), `inert-${index}`);
  }
  const missingRuntime = snapshot(root);
  assert.throws(() => collect(item.target, sha, root, out, host), /ENOENT/);
  assert.equal(existsSync(out), false); assert.deepEqual(snapshot(root), missingRuntime);
  const first = item.installers[0];
  writeFileSync(join(root, first.directory, `duplicate${first.suffix}`), 'inert duplicate');
  const duplicate = snapshot(root);
  assert.throws(() => collect(item.target, sha, root, out, host), /Expected exactly one installer/);
  assert.equal(existsSync(out), false); assert.deepEqual(snapshot(root), duplicate);
  // Keep every fixture (no cleanup authority); use a separate directory for the valid installer.
  // Test via a fresh root rather than changing the public target metadata.
  const validRoot = join(run, `${item.target}-valid`);
  mkdirSync(validRoot);
  for (const [path, hex] of missingRuntime) {
   const destination = join(validRoot, path.slice(root.length + 1));
   mkdirSync(join(destination, '..'), { recursive: true }); writeFileSync(destination, Buffer.from(hex, 'hex'));
  }
  const validOut = join(validRoot, 'qa');
  mkdirSync(join(validRoot, item.runtimeManifest, '..'), { recursive: true });
  writeFileSync(join(validRoot, item.runtimeManifest), JSON.stringify({ target: 'wrong', platform: 'wrong' }));
  const invalid = snapshot(validRoot);
  assert.throws(() => collect(item.target, sha, validRoot, validOut, host), /Runtime manifest target mismatch/);
  assert.equal(existsSync(validOut), false); assert.deepEqual(snapshot(validRoot), invalid);
  writeFileSync(join(validRoot, item.runtimeManifest), JSON.stringify({
   target: item.target, platform: `win32-${item.arch}`, versions: { node: '24.14.1' },
  }));
  const manifest = collect(item.target, sha, validRoot, validOut, host);
  if (item.platform === process.platform && item.arch === process.arch) {
   const nativeOut = join(validRoot, 'cli-qa');
   const result = call(['collect', '--target', item.target, '--source', sha, '--root', validRoot, '--out', nativeOut]);
   assert.equal(result.status, 0); assert.equal(result.stderr, '');
   assert.equal(result.stdout, `${JSON.stringify(manifest)}\n`);
  }
  assert.equal(manifest.releaseReady, false); assert.equal(manifest.source, sha);
  assert.equal(manifest.target, item.target); assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.components.runtime.delivery, 'embedded');
  assert.equal(manifest.components.eyes.available, false); assert.equal(manifest.components.hands.available, false);
  assert.equal(manifest.files.length, item.installers.length + 1);
  for (const file of manifest.files) {
   const bytes = readFileSync(join(validOut, file.name));
   assert.equal(file.sizeBytes, bytes.length); assert.equal(file.sha256, digest(bytes));
  }
  assert.deepEqual(JSON.parse(readFileSync(join(validOut, 'QA-MANIFEST.json'))), manifest);
  const done = snapshot(validRoot);
  assert.throws(() => collect(item.target, sha, validRoot, validOut, host), /Output already exists/);
  assert.deepEqual(snapshot(validRoot), done);
 }
});

test('default root and explicit root have identical public plan output; help is inert', () => {
 const target = targets.find(([, , platform, arch]) => platform === process.platform && arch === process.arch)[0];
 const args = ['plan', '--target', target, '--source', sha];
 const implicit = call(args); const explicit = call([...args, '--root', process.cwd()]);
 assert.equal(implicit.status, 0); assert.equal(implicit.stderr, '');
 assert.equal(explicit.status, implicit.status); assert.equal(explicit.stdout, implicit.stdout); assert.equal(explicit.stderr, implicit.stderr);
 const help = call(['--help']); assert.equal(help.status, 0); assert.equal(help.stderr, '');
 assert.match(help.stdout, /^usage: ci-native/);
});
