import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { matrix } from '../ci-native.mjs';

// Reuse the installed workspace's transitive parser; do not install a new dependency.
const store = resolve('node_modules/.pnpm');
const installed = readdirSync(store).find(name => /^yaml@/.test(name));
assert.ok(installed, 'Existing workspace YAML parser is required for structural checks');
const { parse } = await import(pathToFileURL(resolve(store, installed, 'node_modules/yaml/dist/index.js')));
const workflow = parse(readFileSync('.github/workflows/native-distributions.yml', 'utf8'));

test('parsed workflow is manual/read-only QA with a fail-closed six-target metadata matrix', () => {
 assert.deepEqual(workflow.on, { workflow_dispatch: null });
 assert.deepEqual(workflow.permissions, { contents: 'read' });
 assert.deepEqual(Object.keys(workflow.jobs), ['targets', 'native']);
 const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
 assert.equal(scripts['package:mac'], 'node scripts/package/package-mac.mjs');
 assert.equal(scripts['package:linux'], 'node scripts/package/package-linux.mjs');
 assert.equal(scripts['package:windows'], 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/package.ps1');
 for (const mode of ['matrix', 'plan', 'collect'])
  assert.equal(scripts[`package:ci:${mode}`], `node scripts/package/ci-native.mjs ${mode}`);
 assert.equal(scripts['test:package-ci'], 'node --test scripts/package/test/ci-native.test.mjs scripts/package/test/ci-workflow.test.mjs');
 const { targets, native } = workflow.jobs;
 assert.equal(targets.steps.at(-1).run, 'echo "matrix=$(node scripts/package/ci-native.mjs matrix)" >> "$GITHUB_OUTPUT"');
 assert.equal(targets.outputs.matrix, '${{ steps.targets.outputs.matrix }}');
 assert.equal(native.strategy.matrix, '${{ fromJSON(needs.targets.outputs.matrix) }}');
 assert.equal(native.strategy['fail-fast'], false);
 assert.equal(native['runs-on'], '${{ matrix.runner }}');
 const steps = native.steps;
 const build = steps.find(s => s.run === '${{ matrix.build }}');
 const collect = steps.find(s => s.run?.startsWith('node scripts/package/ci-native.mjs collect'));
 const upload = steps.find(s => s.uses === 'actions/upload-artifact@v4');
 const plan = steps.find(s => s.id === 'plan');
 assert.ok(steps.indexOf(plan) < steps.indexOf(build));
 assert.ok(steps.indexOf(build) < steps.indexOf(collect));
 assert.ok(steps.indexOf(collect) < steps.indexOf(upload));
 assert.equal(upload.with.name, '${{ steps.plan.outputs.artifact }}');
 assert.equal(upload.with.path, 'build/native-qa/');
 assert.equal(upload.with['if-no-files-found'], 'error');
 assert.match(collect.run, /--out build\/native-qa$/);
 assert.match(plan.run, /p.artifactName/);
 assert.equal(steps.find(s => s.uses === 'actions/setup-node@v4').with.architecture, '${{ matrix.arch }}');
 assert.equal(steps.find(s => s.uses === 'actions/setup-node@v4').with['node-version'], '24.14.1');
 assert.equal(steps.find(s => s.uses === 'actions/setup-go@v5').with['go-version'], '1.25.10');
 assert.equal(steps.find(s => s.uses === 'actions/setup-go@v5').with.architecture, '${{ matrix.arch }}');
 assert.ok(steps.some(s => s.run?.includes("rustup set default-host '${{ matrix.rust }}'")));
 assert.ok(steps.some(s => s.run === 'pnpm install --frozen-lockfile'));
 assert.ok(steps.some(s => s.run?.includes("host: ${{ matrix.rust }}")));
 assert.ok(steps.some(s => s.run?.includes('docker info --format')));
 assert.ok(matrix.include.every(item => item.build.includes(item.target)));
 assert.equal(matrix.include.length, 6);
 for (const job of Object.values(workflow.jobs)) {
  assert.equal(job.permissions, undefined);
  for (const step of job.steps) {
   assert.equal(step['continue-on-error'], undefined);
   assert.doesNotMatch(JSON.stringify(step), /secrets\.|gh release|workflow_call|contents: write/);
  }
 }
});

test('installer checks consume the matching metadata and state unsupported ARM64 smoke', () => {
 const steps = workflow.jobs.native.steps;
 for (const item of matrix.include) {
  if (item.platform === 'darwin') {
   assert.match(item.build, /--sign - --check$/);
   assert.equal(item.check, 'producer-dmg-runtime-check');
  } else if (item.platform === 'linux') {
   assert.equal(steps.find(s => s.run === '${{ matrix.check }}').if, "runner.os == 'Linux'");
   assert.match(item.check, /--arch (amd64|arm64)$/);
  } else if (item.arch === 'x64') {
   const smoke = steps.find(s => s.run?.includes('./scripts/windows/smoke-install.ps1'));
   assert.equal(smoke.if, "matrix.target == 'windows-x64'");
   assert.match(smoke.run, /plan.installers\[0\].directory/);
   assert.match(smoke.run, /Count -ne 1/);
  } else {
   const unsupported = steps.find(s => s.if === "matrix.target == 'windows-arm64'");
   assert.match(unsupported.run, /UNSUPPORTED installed smoke/);
   assert.equal(item.check, 'unsupported-windows-arm64-smoke');
  }
 }
});
