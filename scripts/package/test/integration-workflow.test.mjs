import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { matrix } from '../ci-native.mjs';

const store = resolve('node_modules/.pnpm');
const installed = readdirSync(store).find(name => /^yaml@/.test(name));
assert.ok(installed, 'Existing lock-matching workspace YAML parser required');
const { parse } = await import(pathToFileURL(resolve(store, installed, 'node_modules/yaml/dist/index.js')));
const load = path => parse(readFileSync(path, 'utf8'));
const paths = ['.github/workflows/integration-tests.yml', '.github/workflows/native-distributions.yml', '.github/workflows/windows.yml',
 'apps/**', 'packages/**', 'scripts/**', 'docker/**', 'packaging/**', 'patches/**',
 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.nvmrc',
 'tsconfig*.json', 'vitest.config.ts'];

test('integration push is exact-branch and input-filtered; manual dispatch needs no main edit', () => {
 const workflow = load('.github/workflows/integration-tests.yml');
 assert.deepEqual(workflow.on, { workflow_dispatch: null, push: { branches: ['docs/stable-integration-team'], paths } });
 assert.deepEqual(workflow.permissions, { contents: 'read' });
 assert.deepEqual(Object.keys(workflow.jobs), ['functional', 'targets', 'native']);
 assert.equal(workflow.jobs.functional.name, 'Static, TypeScript and UI tests (${{ matrix.os }})');
 assert.equal(workflow.jobs.native.name, 'Native build and installed evidence (${{ matrix.target }})');
 assert.deepEqual(workflow.jobs.functional.strategy.matrix.os, ['windows-2022', 'ubuntu-24.04']);
 assert.equal(workflow.jobs.functional['runs-on'], '${{ matrix.os }}');
 assert.equal(workflow.jobs.targets['runs-on'], 'ubuntu-24.04');
 assert.equal(workflow.jobs.native['runs-on'], '${{ matrix.runner }}');
 assert.deepEqual(workflow.jobs.native.needs, ['functional', 'targets']);
 for (const job of Object.values(workflow.jobs)) {
  assert.equal(job.permissions, undefined); assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.environment, undefined); assert.equal(job.container, undefined);
  assert.equal(job.if, undefined);
  for (const step of job.steps) {
   assert.equal(step['continue-on-error'], undefined);
   assert.doesNotMatch(JSON.stringify(step), /secrets\.|gh release|gh api|deploy|\bpublish\b|workflow_call|contents: write|pull_request_target/);
   if (step.uses) assert.ok(['actions/checkout@v4','actions/setup-node@v4','pnpm/action-setup@v4',
    'actions/setup-go@v5','actions/upload-artifact@v4','ilammy/msvc-dev-cmd@v1.13.0'].includes(step.uses));
   if (step.uses === 'pnpm/action-setup@v4') assert.equal(step.with.version, '11.5.0');
   if (step.uses === 'actions/setup-node@v4') assert.equal(step.with['node-version'], '24.14.1');
  }
 }
});

test('functional gates run real workspace tests, UI build and scoped inert contracts', () => {
 const steps = load('.github/workflows/integration-tests.yml').jobs.functional.steps;
 for (const command of ['pnpm install --frozen-lockfile', 'pnpm typecheck', 'pnpm test', 'pnpm --filter @gentle-dot/ui build',
  'node --test scripts/package/test/ci-native.test.mjs scripts/package/test/ci-workflow.test.mjs scripts/package/test/integration-workflow.test.mjs'])
  assert.ok(steps.some(step => step.run === command), command);
 const contracts = steps.find(step => step.name === 'Windows inert startup contracts (not Win32 proof)');
 assert.equal(contracts.if, "runner.os == 'Windows'"); assert.equal(contracts.shell, 'pwsh');
 assert.match(contracts.run, /\$env:GENTLE_DOT_TEST_PWSH = \(Get-Process -Id \$PID\).Path/);
 assert.match(contracts.run, /node --test scripts\/windows\/test\/daemon-startup.test.mjs/);
 const scratch = steps.find(step => step.name === 'Retained inert fixture root');
 assert.match(scratch.run, /GENTLE_DOT_CI_TEST_ROOT/); assert.match(scratch.run, /RUNNER_TEMP/);
 assert.ok(steps.indexOf(scratch) < steps.indexOf(contracts));
});

test('native x64 subset reuses every existing producer, host guard and installed gate without weakening', () => {
 const existing = load('.github/workflows/native-distributions.yml');
 const workflow = load('.github/workflows/integration-tests.yml');
 const selection = workflow.jobs.targets.steps.at(-1).run;
 assert.match(selection, /matrix\.include\.filter/);
 assert.match(selection, /\["windows-x64","linux-x64"\]\.includes\(item.target\)/);
 assert.deepEqual(matrix.include.filter(item => ['windows-x64','linux-x64'].includes(item.target)).map(item => item.runner),
  ['windows-2022', 'ubuntu-24.04']);
 const expected = structuredClone(existing.jobs.native);
 expected.needs = ['functional', 'targets'];
 expected.name = 'Native build and installed evidence (${{ matrix.target }})';
 expected.steps = expected.steps.filter(step => step.if !== "matrix.target == 'windows-arm64'");
 expected.steps.find(step => step.uses === 'pnpm/action-setup@v4').with = { version: '11.5.0' };
 const nativeWithoutAddonPrep = structuredClone(workflow.jobs.native);
 nativeWithoutAddonPrep.steps = nativeWithoutAddonPrep.steps.filter(step =>
  step.uses !== 'ilammy/msvc-dev-cmd@v1.13.0' && step.name !== 'Build app-channel addon');
 assert.deepEqual(nativeWithoutAddonPrep, expected);
 const commands = workflow.jobs.native.steps.map(step => step.run ?? '').join('\n');
 assert.match(commands, /test-daemon-startup.ps1/); assert.match(commands, /smoke-install.ps1/);
 assert.match(commands, /matrix.check/); assert.match(commands, /collect --target/);
});

test('both Windows paths prepare the checksum-verified Node-matching addon before tests or runtime build', () => {
 const workflow = load('.github/workflows/integration-tests.yml');
 const canonical = load('.github/workflows/windows.yml').jobs['app-channel'].steps;
 const msvc = canonical.find(step => step.uses === 'ilammy/msvc-dev-cmd@v1.13.0');
 const recipe = canonical.find(step => step.name === 'Build app-channel addon');
 const absoluteGuard = "          if (-not [IO.Path]::IsPathFullyQualified($compiler)) { throw 'Expected absolute cl.exe path' }".trimStart();
 const expectedRun = recipe.run.replace('$compiler = (Get-Command cl.exe).Source',
  '$compiler = (Get-Command cl.exe).Source\n' + absoluteGuard);
 for (const [jobName, gate] of [['functional','pnpm test'], ['native','${{ matrix.build }}']]) {
  const steps = workflow.jobs[jobName].steps;
  const init = steps.find(step => step.uses === msvc.uses);
  assert.ok(init, `${jobName} requires canonical MSVC initialization`);
  assert.deepEqual(init, { ...msvc, if: "runner.os == 'Windows'" });
  const build = steps.find(step => step.name === recipe.name);
  assert.ok(build, `${jobName} requires addon preparation`);
  assert.deepEqual(build, { name: recipe.name, if: "runner.os == 'Windows'", shell: 'pwsh', run: expectedRun });
  const node = steps.find(step => step.uses === 'actions/setup-node@v4');
  assert.equal(node.with['node-version'], '24.14.1');
  assert.ok(steps.indexOf(node) < steps.indexOf(init));
  assert.ok(steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile') < steps.indexOf(init));
  assert.ok(steps.indexOf(init) < steps.indexOf(build));
  assert.ok(steps.indexOf(build) < steps.findIndex(step => step.run === gate));
  assert.equal(steps.filter(step => step.name === recipe.name).length, 1);
  // Exact canonical script equality above pins both download identities, SHA guards,
  // extraction, dynamic Node version and fail-closed addon build; this is not native proof.
  const lines = build.run.trim().split('\n');
  const index = text => lines.findIndex(line => line.trim() === text);
  assert.ok(index('$version = node -p process.version') < index('$release = "https://nodejs.org/download/release/$version"'));
  assert.ok(index('if ($actual -ne ($line -split \'\\s+\')[0]) { throw "Checksum mismatch for $($pair[0])" }') < index('tar -xf "$inputs/headers.tar.gz" -C $inputs'));
  assert.ok(index(absoluteGuard) < index('pnpm --filter @gentle-dot/daemon run build:windows-stop -- --compiler "$compiler" --headers "$inputs/node-$version/include/node" --node-lib "$inputs/node.lib"'));
 }
});
