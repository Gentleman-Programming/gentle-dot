import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
