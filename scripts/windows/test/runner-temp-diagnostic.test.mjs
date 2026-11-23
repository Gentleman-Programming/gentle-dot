import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const branch = 'qa/windows-runner-temp-44810128936';
const entry = new URL('./runner-temp-diagnostic.mjs', import.meta.url);

test('exact push, sole read-only Windows job; macOS excludes only this branch', () => {
  const macos = read('../../../.github/workflows/macos.yml');
  assert.ok(macos.includes(`on:\n  push:\n    branches-ignore: ['${branch}']\n    tags: ['**']\n  pull_request:\n  workflow_dispatch:\n`));
  const workflow = read('../../../.github/workflows/windows-runner-temp-diagnostic.yml');
  assert.ok(workflow.includes(`\non:\n  push:\n    branches: ['${branch}']\npermissions:\n  contents: read\njobs:\n  checks:\n`));
  assert.deepEqual([...workflow.split('jobs:\n')[1].matchAll(/^  (\w+):$/gm)].map((m) => m[1]), ['checks']);
  assert.match(workflow, /runs-on: windows-2022/);
  assert.match(workflow, /persist-credentials: false/);
  assert.deepEqual([...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]), ['actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683']);
});

test('Node CLI refuses locally and rejects arguments without echoing them', () => {
  for (const args of [[], ['invalid-argument']]) {
    const result = spawnSync(process.execPath, [fileURLToPath(entry), ...args], {
      env: {}, encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    assert.ifError(result.error);
    assert.deepEqual([result.status, result.signal, result.stdout, result.stderr], [1, null, 'node-host-refused\n', '']);
  }
});

test('Node metadata stages are distinct and only admitted roots reach drive check', async () => {
  const { inspectTemp } = await import(entry);
  const temp = 'D:\\temp';
  const repo = 'D:\\checkout';
  const good = { isDirectory: () => true, dev: 1n, ino: 2n };
  const stages = [
    ['', {}, 'node-path-root'],
    ['\\\\host\\share', {}, 'node-path-root'],
    ['D:\\', {}, 'node-path-component'],
    ['D:\\temp\\..', {}, 'node-path-component'],
    ['D:\\con.txt', {}, 'node-path-component'],
    ['D:\\temp:stream', {}, 'node-path-component'],
    [temp, { stat: () => { throw Error('not emitted'); } }, 'node-ancestry-refused'],
    [temp, { stat: () => ({ isDirectory: () => false }) }, 'node-ancestry-refused'],
    [temp, { canonicalize: () => { throw Error('not emitted'); } }, 'node-canonical-refused'],
    [temp, { canonicalize: () => 'D:\\other' }, 'node-canonical-refused'],
    [temp, { canonicalize: (p) => p === repo ? temp : p }, 'node-outside-repo-refused'],
    [temp, { stat: () => ({ ...good, ino: 0n }) }, 'node-file-id-refused'],
    ['d:/TEMP/', { canonicalize: (p) => p === repo ? p : temp }, 'node-drive-fixed'],
  ];
  for (const [raw, overrides, expected] of stages) {
    const roots = [];
    const actual = inspectTemp(raw, repo, {
      stat: () => good, canonicalize: (p) => p, ...overrides,
      drive: (root) => { roots.push(root); return 'node-drive-fixed'; },
    });
    assert.equal(actual, expected);
    assert.deepEqual(roots, expected === 'node-drive-fixed' ? [temp] : []);
  }
});

test('outside-repo check rejects descendants but allows a sibling prefix and another drive', async () => {
  const { inspectTemp } = await import(entry);
  for (const [path, allowed] of [['D:\\repo\\scratch', false], ['D:\\repo2\\scratch', true], ['E:\\scratch', true]]) {
    const roots = [];
    assert.equal(inspectTemp(path, 'D:\\repo', {
      stat: () => ({ isDirectory: () => true, dev: 1n, ino: 2n }),
      canonicalize: (p) => p,
      drive: (root) => { roots.push(root); return 'node-drive-fixed'; },
    }), allowed ? 'node-drive-fixed' : 'node-outside-repo-refused');
    assert.deepEqual(roots, allowed ? [path] : []);
  }
});

test('runtime enum requires x64 and exact executable version identity', async () => {
  const { classifyRuntime } = await import(entry);
  for (const [dir, arch, reported, expected] of [
    ['24.14.1', 'x64', 'v24.14.1', 'node-runtime-exact'],
    ['24.15.0', 'x64', 'v24.15.0', 'node-runtime-alternate-24'],
    ['24.15.0', 'x64', 'v24.14.1', 'node-runtime-refused'],
    ['24.15.0', 'arm64', 'v24.15.0', 'node-runtime-refused'],
    ['25.0.0', 'x64', 'v25.0.0', 'node-runtime-refused'],
    ['24.01.0', 'x64', 'v24.01.0', 'node-runtime-refused'],
  ]) {
    assert.equal(classifyRuntime(`C:\\cache\\node\\${dir}\\x64\\node.exe`, arch, reported), expected);
  }
  assert.equal(classifyRuntime('C:\\other\\24.14.1\\x64\\node.exe', 'x64', 'v24.14.1'), 'node-runtime-refused');
});

test('restricted drive probe emits only classified child outcomes', async () => {
  const { probeDrive } = await import(entry);
  const good = { signal: null, status: 0, stdout: 'fixed', stderr: '' };
  for (const [change, expected] of [
    [{ error: Error('not emitted') }, 'node-drive-spawn-error'],
    [{ status: 1, stdout: '' }, 'node-drive-nonfixed'],
    [{ status: null, signal: 'SIGTERM' }, 'node-drive-malformed'],
    [{ stdout: 'fixed\n' }, 'node-drive-malformed'],
    [{ stderr: 'not emitted' }, 'node-drive-malformed'],
    [{}, 'node-drive-fixed'],
  ]) {
    assert.equal(probeDrive('d:\\not-in-command', (exe, args, options) => {
      assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
      assert.match(args[4], /DriveInfo\]::new\('D:\\'\)/);
      assert.ok(!args[4].includes('not-in-command'));
      assert.deepEqual(options, { cwd: 'C:\\Windows\\System32', env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
        shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 128 });
      return { ...good, ...change };
    }), expected);
  }
});
