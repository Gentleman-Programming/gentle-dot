#!/usr/bin/env node
// QA metadata/collection only. Never builds, installs, downloads or publishes.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tauri = 'apps/desktop/src-tauri';
function target(target, runner, platform, arch, rust) {
 const windows = platform === 'win32';
 const linux = platform === 'linux';
 const bundle = `${tauri}/target/${windows || arch === 'x64' ? `${rust}/` : ''}release/bundle`;
 const debArch = arch === 'x64' ? 'amd64' : 'arm64';
 return {
  target, runner, platform, arch, rust,
  build: windows ? `pwsh -NoProfile -File scripts/windows/package.ps1 -Target ${target}`
   : linux ? `node scripts/package/package-linux.mjs --target ${target}`
   : `node scripts/package/package-mac.mjs --target ${target} --sign - --check`,
  check: windows ? (arch === 'x64' ? 'windows-x64-lifecycle' : 'unsupported-windows-arm64-smoke')
   : linux ? `node scripts/package/linux-check.mjs --arch ${debArch}` : 'producer-dmg-runtime-check',
  installers: windows ? [{ directory: `${bundle}/nsis`, suffix: '-setup.exe' }]
   : linux ? [{ directory: 'build/linux', suffix: '.deb' },
     ...(arch === 'x64' ? [{ directory: 'build/linux', suffix: '.pkg.tar.zst' }] : [])]
   : [{ directory: `${bundle}/dmg`, suffix: '.dmg' }],
  runtimeManifest: windows ? 'build/windows/runtime/WINDOWS-INTEGRITY.json'
   : linux ? `build/linux/runtime-${target}.json` : `build/runtime/${target}/MANIFEST.json`,
 };
}
export const matrix = { include: [
 target('windows-x64', 'windows-2022', 'win32', 'x64', 'x86_64-pc-windows-msvc'),
 target('windows-arm64', 'windows-11-arm', 'win32', 'arm64', 'aarch64-pc-windows-msvc'),
 target('linux-x64', 'ubuntu-24.04', 'linux', 'x64', 'x86_64-unknown-linux-gnu'),
 target('linux-arm64', 'ubuntu-24.04-arm', 'linux', 'arm64', 'aarch64-unknown-linux-gnu'),
 target('darwin-x64', 'macos-15-intel', 'darwin', 'x64', 'x86_64-apple-darwin'),
 target('darwin-arm64', 'macos-26', 'darwin', 'arm64', 'aarch64-apple-darwin'),
] };

export function plan(target, source, root = process.cwd(), host = process) {
 const item = matrix.include.find(item => item.target === target);
 if (!item) throw new Error(`Unknown target ${target}.`);
 if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Source must be a full lowercase Git SHA.');
 if (host.platform !== item.platform || host.arch !== item.arch)
  throw new Error(`Native host mismatch for ${target}; use matching OS and Node architecture.`);
 const { version } = JSON.parse(readFileSync(join(root, tauri, 'tauri.conf.json'), 'utf8'));
 if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid Dot version.');
 return { ...item, version, source, artifactName: `gentle-dot-${version}-${target}-${source}-qa` };
}

function regular(path) {
 const stat = lstatSync(path);
 if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
 return readFileSync(path);
}

export function collect(target, source, root, out, host = process) {
 const info = plan(target, source, root, host);
 if (existsSync(out)) throw new Error('Output already exists; use a fresh QA directory.');
 // Resolve and validate every required input before creating any output.
 const payloads = info.installers.map(({ directory, suffix }) => {
  const dir = join(root, directory);
  const names = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(suffix)) : [];
  if (names.length !== 1) throw new Error(`Expected exactly one installer ${directory}/*${suffix}; found ${names.length}.`);
  return { path: join(dir, names[0]), name: `${info.artifactName}${suffix}`, role: 'installer' };
 });
 const runtime = join(root, info.runtimeManifest);
 const runtimeBytes = regular(runtime);
 const producer = JSON.parse(runtimeBytes);
 const identity = info.platform === 'win32' ? producer.platform : producer.target;
 const expected = info.platform === 'win32' ? `win32-${info.arch}` : target;
 if (identity !== expected) throw new Error('Runtime manifest target mismatch.');
 payloads.push({ path: runtime, name: 'runtime-manifest.json', role: 'producer-runtime-manifest' });
 const files = payloads.map(file => {
  const bytes = regular(file.path);
  return { name: file.name, role: file.role, sizeBytes: bytes.length,
   sha256: createHash('sha256').update(bytes).digest('hex') };
 });
 const manifest = {
  schema: 1, purpose: 'manual-native-qa', releaseReady: false,
  target, version: info.version, source, artifactName: info.artifactName,
  producer: { build: info.build, runtimeManifest: info.runtimeManifest },
  files,
  components: {
   app: { available: true, delivery: 'monolithic-installer' },
   runtime: { available: true, delivery: 'embedded', identityFile: 'runtime-manifest.json' },
   eyes: { available: false, reason: 'No separately produced/qualified component in this CI; no provider URL.' },
   hands: { available: false, reason: 'Dot-only provider unpublished; no ARM64 payload claimed; no provider URL.' },
  },
  evidence: {
   boundary: 'Byte identity and producer manifest only; not publisher provenance, native or installed acceptance.',
   installationCheck: info.check,
   signing: info.platform === 'darwin' ? 'ad-hoc; not notarized' : 'no publisher signature asserted',
   lock: 'Runtime npm install is not frozen; ranges/latest and postinstall remain effective inputs.',
   delivery: 'Separate app/runtime/eyes/hands acquisition, bootstrap and rollback remain planned.',
  },
 };
 mkdirSync(out, { recursive: true });
 for (const file of payloads) copyFileSync(file.path, join(out, file.name));
 writeFileSync(join(out, 'QA-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
 return manifest;
}

export const usage = 'usage: ci-native matrix | plan --target TARGET --source SHA [--root DIR] | collect --target TARGET --source SHA --out DIR [--root DIR]';
function main(args) {
 if (args.length === 1 && args[0] === '--help') return `${usage}\n`;
 const [mode, ...flags] = args;
 if (!['matrix', 'plan', 'collect'].includes(mode)) throw new Error('Expected matrix, plan or collect.');
 if (mode === 'matrix') {
  if (flags.length) throw new Error('matrix takes no options.');
  return `${JSON.stringify(matrix)}\n`;
 }
 const options = {};
 for (let i = 0; i < flags.length; i += 2) {
  const key = flags[i];
  if (!['--target', '--source', '--root', ...(mode === 'collect' ? ['--out'] : [])].includes(key))
   throw new Error(`Unknown option ${key}.`);
  if (Object.hasOwn(options, key)) throw new Error(`Duplicate ${key}.`);
  if (!flags[i + 1] || flags[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}.`);
  options[key] = flags[i + 1];
 }
 for (const key of ['--target', '--source', ...(mode === 'collect' ? ['--out'] : [])])
  if (!options[key]) throw new Error(`Missing ${key}.`);
 const root = resolve(options['--root'] ?? process.cwd());
 const parameters = [options['--target'], options['--source'], root];
 const result = mode === 'plan' ? plan(...parameters) : collect(...parameters, resolve(options['--out']));
 return `${JSON.stringify(result)}\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 try { process.stdout.write(main(process.argv.slice(2))); }
 catch (error) { process.stderr.write(`ci-native: ${error.message}\n`); process.exitCode = 2; }
}
