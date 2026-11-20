import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const builder = new URL('./startup-phase-bundle.mjs', import.meta.url);
const api = () => import(builder);
const source = (name) => readFileSync(new URL(`../../../packages/daemon/src/${name}.ts`, import.meta.url), 'utf8');
const env = () => ({ CI: 'true', GITHUB_ACTIONS: 'true', GENTLE_DOT_CI_TRACE_PORT: '65535',
  GENTLE_DOT_CI_TRACE_ID: '0123456789abcdef0123456789abcdef' });

test('pinned checkout instruments real startup anchors and refuses source drift', async () => {
  const { instrumentSource } = await api();
  for (const [name, anchors] of Object.entries({
    cli: ['entry', 'config-start', 'config-ready', 'startup-failed'],
    'windows-stop': ['stop-start', 'stop-refused', 'stop-ready', 'fd3-start', 'fd3-refused', 'fd3-ready'],
    daemon: ['daemon-start', 'preview-memory-start', 'claim-ready', 'providers-ready', 'token-ready',
      'workspace-ready', 'memory-ready', 'http-bind', 'http-refused', 'http-listening'],
  })) {
    const input = source(name);
    const output = instrumentSource(name, input);
    assert.doesNotThrow(() => stripTypeScriptTypes(output));
    assert.equal(instrumentSource(name, input.replaceAll(/\r?\n/g, '\r\n')), output);
    for (const phase of anchors) assert.equal(output.split(`__ciStartupPhase("${phase}")`).length, 2, phase);
    assert.throws(() => instrumentSource(name, input + '\n'), /^Error: source-drift$/);
  }
  const cli = instrumentSource('cli', source('cli'));
  assert.ok(cli.indexOf('__ciStartupPhase("entry")') < cli.indexOf('if (process.argv.includes("--auth-helper"))'));
  const stop = instrumentSource('windows-stop', source('windows-stop'));
  assert.match(stop, /__ciStartupPhase\("fd3-start"\)[\s\S]*new WindowsAppChannel\(\{ exclusiveFd3Startup: true \}\)[\s\S]*__ciStartupPhase\("fd3-ready"\)[\s\S]*await start\(channel\)/);
  const daemon = instrumentSource('daemon', source('daemon'));
  assert.match(daemon, /server\.listen\(options\.port, options\.host, \(\) => done\(\)\);\s*\}\);\s*__ciStartupPhase\("http-listening"\)/);
});

test('only hosted Windows opt-in with canonical fields can create a socket', async () => {
  const { makePhaseTrace } = await api();
  for (const overrides of [{ CI: '' }, { GITHUB_ACTIONS: '' }, ...['0', '65536', '0001', '1\n', '+1', '1e1', ' 1'].map(
    (GENTLE_DOT_CI_TRACE_PORT) => ({ GENTLE_DOT_CI_TRACE_PORT })), ...['', 'X'.repeat(32), 'a'.repeat(32) + '\n'].map(
    (GENTLE_DOT_CI_TRACE_ID) => ({ GENTLE_DOT_CI_TRACE_ID }))]) {
    let opened = 0;
    makePhaseTrace({ ...env(), ...overrides }, 'win32', () => { opened++; })('entry');
    assert.equal(opened, 0);
  }
  let opened = 0;
  makePhaseTrace(env(), 'linux', () => { opened++; })('entry');
  assert.equal(opened, 0);
});

test('trace is synchronous, fixed, monotonic and best-effort', async () => {
  const { makePhaseTrace } = await api();
  const options = { ...env(), GENTLE_DOT_CI_TRACE_PORT: '1' };
  const sends = [];
  let unrefs = 0;
  const binds = [];
  let onError;
  const trace = makePhaseTrace(options, 'win32', (type) => {
    assert.equal(type, 'udp4');
    return { on: (event, fn) => { assert.equal(event, 'error'); onError = fn; }, unref: () => unrefs++,
      bind: (options) => binds.push(options),
      send: (...args) => { sends.push(args); if (sends.length === 2) throw new Error('inert'); } };
  });
  for (const phase of ['entry', 'entry', 'arbitrary', 'config-start', 'entry', 'stop-refused', 'fd3-start', 'startup-failed']) trace(phase);
  assert.equal(unrefs, 1);
  assert.deepEqual(binds, [{ address: '127.0.0.1', port: 0, exclusive: true }]);
  assert.doesNotThrow(() => onError(new Error('inert async error')));
  assert.deepEqual(sends, ['entry', 'config-start', 'stop-refused'].map(
    (phase) => [`${env().GENTLE_DOT_CI_TRACE_ID} ${phase}`, 1, '127.0.0.1']));
  assert.doesNotThrow(() => makePhaseTrace(env(), 'win32', () => { throw new Error('inert'); })('entry'));
});

const scratch = () => join(realpathSync(tmpdir()), `gentle-dot-startup-trace-${randomBytes(16).toString('hex')}`);

test('esbuild is silent and its rejection becomes a fixed failure without output', async () => {
  const { buildDiagnosticBundle } = await api();
  const out = scratch();
  let options;
  await assert.rejects(buildDiagnosticBundle(out, async (received) => {
    options = received;
    throw new Error('synthetic raw esbuild detail');
  }), /^Error: build-failed$/);
  assert.equal(options.logLevel, 'silent');
  assert.equal(options.write, false);
  assert.equal(existsSync(out), false);
});

test('CLI refuses unsafe or existing output without leaking arguments or changing bytes', (t) => {
  const invoke = (...args) => {
    const { status, stdout, stderr, error } = spawnSync(process.execPath, [fileURLToPath(builder), ...args], { encoding: 'utf8' });
    assert.ifError(error);
    return [status, stdout, stderr];
  };
  assert.deepEqual(invoke(), [2, '', 'usage: startup-phase-bundle.mjs --out-dir <new absolute trace scratch directory>\n']);
  const existing = scratch();
  mkdirSync(existing);
  t.diagnostic(`Retained scratch: ${existing}`);
  const file = join(existing, 'startup-phase-cli.mjs');
  const sentinel = Buffer.from([0, 10, 255]);
  writeFileSync(file, sentinel, { flag: 'wx' });
  for (const path of [tmpdir(), join(tmpdir(), 'not-a-trace-output'), 'gentle-dot-startup-trace-local', existing]) {
    assert.deepEqual(invoke('--out-dir', path), [1, '', 'STARTUP_PHASE_BUNDLE: scratch-refused\n']);
  }
  assert.deepEqual(readFileSync(file), sentinel);
});

const branch = 'refs/heads/qa/windows-storage-diagnostic-44794993333';
const repository = 'Gentleman-Programming/gentle-dot';
const hosted = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_JOB: 'checks',
  GITHUB_REPOSITORY: repository, GITHUB_WORKFLOW: 'Windows storage diagnostic 44794993333',
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/windows-storage-diagnostic.yml@${branch}`,
  GITHUB_EVENT_NAME: 'push', GITHUB_REF: branch };

test('runner suffix CLI rejects host and path violations with an exact tuple and no output files', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(process.env.GENTLE_DOT_CI_TEST_ROOT || tmpdir(), 'runner-trace-'));
  {
    const suffix = 'a'.repeat(32);
    const invoke = (arg, overrides) => {
      const { status, stdout, stderr, error } = spawnSync(process.execPath, [fileURLToPath(builder), '--runner-suffix', arg], {
        encoding: 'utf8', env: { ...process.env, ...hosted, RUNNER_TEMP: root, ...overrides },
      });
      assert.ifError(error);
      assert.deepEqual([status, stdout, stderr], [1, '', 'STARTUP_PHASE_BUNDLE: scratch-refused\n']);
      assert.deepEqual(readdirSync(root), []);
    };
    for (const key of Object.keys(hosted)) invoke(suffix, { [key]: 'invalid' });
    for (const arg of [`../${suffix}`, `${suffix}/..`, `${suffix}\n`, suffix.toUpperCase(), root]) invoke(arg);
    for (const path of [fileURLToPath(new URL('../../../', import.meta.url)), 'relative', dirname(root) + '\\..\\' + root.slice(3), '\\\\?\\' + root]) {
      invoke(suffix, { RUNNER_TEMP: path });
    }
  }
});

test('hosted builder refuses nonfixed drives and unreliable system probe results before build or allocation', { skip: process.platform !== 'win32' }, async (t) => {
  const { buildRunnerDiagnosticBundle } = await api();
  const root = mkdtempSync(join(process.env.GENTLE_DOT_CI_TEST_ROOT || tmpdir(), 'runner-trace-'));
  t.diagnostic(`Test scratch parent: ${dirname(root)}`);
  {
    const drive = realpathSync.native(root).slice(0, 2).toUpperCase();
    const env = { ...hosted, RUNNER_TEMP: root, SystemRoot: 'D:\\not-system', DRIVE_TYPE: 'Fixed' };
    const build = t.mock.fn(async ({ outfile }) => ({ outputFiles: [{ path: outfile, contents: Buffer.from('inert') }] }));
    let result;
    const probe = t.mock.method(childProcess, 'spawnSync', () => result);
    const success = { status: 0, signal: null, stdout: 'fixed', stderr: '' };
    for (const reply of [{ ...success, stdout: 'nonfixed' }, { ...success, status: 1 },
      { ...success, error: { code: 'ETIMEDOUT' } }, { ...success, error: { code: 'ENOBUFS' } },
      { ...success, signal: 'SIGTERM' }, { ...success, stdout: 'fixed\n' }, { ...success, stderr: 'unexpected' }]) {
      result = reply;
      await assert.rejects(buildRunnerDiagnosticBundle('a'.repeat(32), env, build), /^Error: scratch-refused$/);
      assert.deepEqual(readdirSync(root), []);
      assert.equal(build.mock.callCount(), 0);
    }
    assert.equal(probe.mock.callCount(), 7);
    for (const { arguments: [exe, args, options] } of probe.mock.calls) {
      assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
      assert.equal(args.length, 5);
      assert.ok(args[4].includes(`[IO.DriveInfo]::new('${drive}\\')`));
      assert.deepEqual(options, { cwd: 'C:\\Windows\\System32', env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
        shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 128 });
    }
  }
});

test('hosted bundle ignores system temp spelling, uses a canonical child and distinguishes exclusive I/O failures', { skip: process.platform !== 'win32' }, async () => {
  const { buildRunnerDiagnosticBundle } = await api();
  const root = mkdtempSync(join(process.env.GENTLE_DOT_CI_TEST_ROOT || tmpdir(), 'runner-trace-'));
  {
    const env = { ...hosted, RUNNER_TEMP: root.toUpperCase().replaceAll('\\', '/') + '/', TEMP: dirname(root), TMP: dirname(root) };
    const out = (suffix) => join(realpathSync.native(root), `gentle-dot-startup-trace-${suffix}`);
    const file = (suffix) => join(out(suffix), 'startup-phase-cli.mjs');
    const contents = Buffer.from('inert');
    const build = async ({ outfile }) => ({ outputFiles: [{ path: outfile, contents }] });
    const first = 'a'.repeat(32), race = 'b'.repeat(32), write = 'c'.repeat(32);
    await buildRunnerDiagnosticBundle(first, env, async (options) => {
      assert.equal(options.outfile, file(first));
      assert.equal(options.write, false);
      return build(options);
    });
    assert.deepEqual(readdirSync(out(first)), ['startup-phase-cli.mjs']);
    assert.deepEqual(readFileSync(file(first)), contents);
    await assert.rejects(buildRunnerDiagnosticBundle(first, env, build), /^Error: scratch-refused$/);
    await assert.rejects(buildRunnerDiagnosticBundle(race, env, async (options) => {
      mkdirSync(out(race));
      writeFileSync(file(race), contents, { flag: 'wx' });
      return build(options);
    }), /^Error: scratch-create-failed$/);
    assert.deepEqual(readFileSync(file(race)), contents);
    await assert.rejects(buildRunnerDiagnosticBundle(write, env, async ({ outfile }) => ({
      outputFiles: [{ path: outfile, contents: null }],
    })), /^Error: scratch-write-failed$/);
    assert.deepEqual(readdirSync(out(write)), []);
  }
});
