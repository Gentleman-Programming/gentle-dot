import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const { dirname, isAbsolute, relative, resolve, sep } = win32;
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const repository = 'Gentleman-Programming/gentle-dot';
const branch = 'refs/heads/qa/windows-runner-temp-44810128936';
const host = Object.freeze({
  CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_JOB: 'checks',
  GITHUB_REPOSITORY: repository, GITHUB_WORKFLOW: 'Windows runner temp diagnostic 44810128936',
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/windows-runner-temp-diagnostic.yml@${branch}`,
  GITHUB_EVENT_NAME: 'push', GITHUB_REF: branch,
});

export function probeDrive(root, spawn) {
  const drive = root.slice(0, 2).toUpperCase();
  if (!/^[A-Z]:$/.test(drive)) return 'node-drive-malformed';
  // Match the existing bundle's restricted child; do not inherit paths or credentials.
  const system = 'C:\\Windows';
  let result;
  try {
    result = spawn(`${system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; if ([IO.DriveInfo]::new('${drive}\\').DriveType -eq [IO.DriveType]::Fixed) { [Console]::Write('fixed') } else { exit 1 }`],
      { cwd: `${system}\\System32`, env: { SystemRoot: system, WINDIR: system },
        shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 128 });
  } catch { return 'node-drive-spawn-error'; }
  if (result.error) return 'node-drive-spawn-error';
  if (result.signal !== null || result.stderr !== '') return 'node-drive-malformed';
  if (result.status === 1 && result.stdout === '') return 'node-drive-nonfixed';
  return result.status === 0 && result.stdout === 'fixed' ? 'node-drive-fixed' : 'node-drive-malformed';
}

// Read-only projection of startup-phase-bundle.mjs runnerScratch through its first drive check.
// No suffix, output candidate, mutation, or later verification of created files.
export function inspectTemp(value, checkout, { stat, canonicalize, drive }) {
  const raw = value?.replaceAll('/', '\\');
  if (!raw || !/^[a-z]:\\/i.test(raw)) return 'node-path-root';
  const components = raw.slice(3).replace(/\\$/, '').split('\\');
  if (components.some(part => !part || /[. ]$|[\x00-\x1f:<>"|?*]/.test(part) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) return 'node-path-component';

  const identity = (path) => {
    const item = stat(path, { bigint: true });
    if (!item.isDirectory()) throw new Error();
    return item;
  };
  let failure = 'node-ancestry-refused';
  try {
    const selected = resolve(raw);
    for (let path = selected; ; path = dirname(path)) {
      identity(path);
      if (dirname(path) === path) break;
    }
    failure = 'node-canonical-refused';
    const root = canonicalize(selected);
    if (relative(selected, root) !== '') return failure;
    failure = 'node-outside-repo-refused';
    const fromRepo = relative(canonicalize(checkout), root);
    if (!isAbsolute(fromRepo) && fromRepo !== '..' && !fromRepo.startsWith(`..${sep}`)) return failure;
    failure = 'node-file-id-refused';
    const current = identity(root);
    const alias = identity(selected);
    if (current.ino === 0n || current.dev !== alias.dev || current.ino !== alias.ino) return failure;
    return drive(root);
  } catch { return failure; }
}

export function classifyRuntime(executable, arch, version) {
  const named = /[\\/]node[\\/](24\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8}))[\\/]x64[\\/]node\.exe$/i.exec(executable);
  if (arch !== 'x64' || !named || version !== `v${named[1]}`) return 'node-runtime-refused';
  return version === 'v24.14.1' ? 'node-runtime-exact' : 'node-runtime-alternate-24';
}

function run() {
  if (process.argv.length !== 2 || process.platform !== 'win32' ||
      !Object.entries(host).every(([key, value]) => process.env[key] === value)) {
    process.exitCode = 1;
    return 'node-host-refused';
  }
  const runtime = classifyRuntime(process.execPath, process.arch, process.version);
  if (runtime === 'node-runtime-refused') {
    process.exitCode = 1;
    return runtime;
  }
  const stage = inspectTemp(process.env.RUNNER_TEMP, repo, {
    stat: lstatSync, canonicalize: realpathSync.native, drive: (root) => probeDrive(root, spawnSync),
  });
  return `${runtime}\n${stage}`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.stdout.write(`${run()}\n`);
}
