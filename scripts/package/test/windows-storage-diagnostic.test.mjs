import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const store = resolve('node_modules/.pnpm');
const yaml = readdirSync(store).find(name => /^yaml@/.test(name));
const { parse } = await import(pathToFileURL(resolve(store, yaml, 'node_modules/yaml/dist/index.js')));
const branch = 'qa/windows-storage-diagnostic-44794993333';
const repo = 'Gentleman-Programming/gentle-dot';
const read = path => readFileSync(path, 'utf8');

test('standalone diagnostic has one Windows job and only its exact read-only push trigger', () => {
  const workflow = parse(read('.github/workflows/windows-storage-diagnostic.yml'));
  assert.deepEqual(workflow.on, { push: { branches: [branch] } });
  assert.deepEqual(workflow.permissions, { actions: 'read', contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['checks']);
  const job = workflow.jobs.checks;
  assert.equal(job.if, `github.repository == '${repo}' && github.ref == 'refs/heads/${branch}'`);
  assert.equal(job['runs-on'], 'windows-2022');
  assert.equal(job.permissions, undefined);
  assert.match(job.steps[0].uses, /^actions\/checkout@[a-f0-9]{40}$/);
  assert.deepEqual(job.steps[0].with, { 'persist-credentials': false, ref: '${{ github.sha }}' });
  assert.equal(job.steps.length, 8);
  assert.deepEqual(job.steps.slice(1).map(step => step.env), [{ GH_TOKEN: '${{ github.token }}' }, ...Array(6).fill(undefined)]);
  assert.equal(job.steps[3].run, './scripts/windows/test/run-packaged-storage-admission.ps1');
  assert.equal(job.steps[3]['timeout-minutes'], 2);
  assert.doesNotMatch(JSON.stringify(job.steps), /gh release|upload-artifact|package\.ps1|smoke-install|GITHUB_JOB\s*=/);
});

test('original producer and both archives are authenticated before unpacking or probing', () => {
  const { steps } = parse(read('.github/workflows/windows-storage-diagnostic.yml')).jobs.checks;
  const acquire = steps[1].run, restore = steps[2].run;
  for (const text of [repo, '44794993333', '266ad28490e6dfeb5503400beea9dc2c565b333f',
    '14659228446', '74dfbd3bc141eadc0d01ef2e4ea5fd645c60b4a3f5caaa05a8796435a6e851cf',
    '14659433165', '93d3199024ad5f465d3f9f5649698517955b01d3721e4c1a1e2c3f4f6e764aee',
    '.github/workflows/windows-installer-preview.yml', 'windows-preview-runtime', 'windows-installer-preview']) {
    assert.ok(acquire.includes(text), text);
  }
  assert.match(acquire, /--hostname github\.com/);
  assert.match(acquire, /\$run\.status -cne 'completed'/);
  assert.match(acquire, /\$run\.repository\.private -ne \$false/);
  assert.match(acquire, /\$build\[0\]\.conclusion -cne 'success'/);
  assert.match(acquire, /\$metadata\.expired -ne \$false/);
  assert.match(acquire, /\$metadata\.workflow_run\.id -ne \$runId/);
  assert.match(acquire, /\$metadata\.digest -cne "sha256:\$\(\$artifact\.Hash\)"/);
  assert.match(acquire, /gh api --hostname github\.com "\$endpoint\/zip" > \$zip 2>\$null/);
  assert.match(acquire, /Get-FileHash -Algorithm SHA256 -LiteralPath \$zip/);
  assert.doesNotMatch(acquire, /Expand-Archive|tar -xf/);
  assert.match(restore, /Expand-Archive[\s\S]*windows-preview-release\.mjs[\s\S]*tar -xf[\s\S]*runtime-integrity\.mjs verify/);
  assert.doesNotMatch(restore, /GH_TOKEN|gh api|setup\.exe/);
});

test('managed trace authenticates the desktop and runs only after the frozen builder dependencies', () => {
  const { steps } = parse(read('.github/workflows/windows-storage-diagnostic.yml')).jobs.checks;
  for (const pin of ['14660115322', 'windows-preview-desktop', '0ebd7f24240a85bccc6077b23fa50a413a87da901968ce74923301f1ae499e92']) {
    assert.ok(steps[1].run.includes(pin));
  }
  assert.match(steps[2].run, /Get-FileHash[\s\S]*122f315f652cebc8d9a5d5e21658fac8e8253fa27c1bcfcbec59938e35adf4f4/);
  assert.match(steps[4].uses, /^actions\/setup-node@[a-f0-9]{40}$/);
  assert.equal(steps[4].with['node-version'], '24.14.1');
  assert.match(steps[5].uses, /^pnpm\/action-setup@[a-f0-9]{40}$/);
  assert.match(steps[6].run, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.equal(steps[7].run, './scripts/windows/test/run-startup-phase-trace.ps1');
  assert.ok(steps[7]['timeout-minutes'] <= 3);
  const wrapper = read('scripts/windows/test/run-startup-phase-trace.ps1');
  assert.match(wrapper, /\$temp = Get-TraceRunnerTemp \$env:RUNNER_TEMP[\s\S]*Join-Path \$temp "gentle-dot-startup-trace-\$suffix"[\s\S]*Invoke-TraceBundle \$suffix/);
  assert.doesNotMatch(wrapper, /GetTempPath|--out-dir/);
});

test('PowerShell wrapper emits only fixed classifications or a validated Node result', () => {
  const script = read('scripts/windows/test/run-packaged-storage-admission.ps1');
  const stages = [
    ['host', "$env:RUNNER_ENVIRONMENT -cne 'github-hosted'"],
    ['paths', 'Assert-OrdinaryDirectories $temp'],
    ['image', '[IO.File]::GetAttributes($image)'],
    ['launch', '[Diagnostics.Process]::Start($info)'],
    ['parse', '$child.ExitCode -eq 0'],
  ];
  let previous = -1;
  for (const [label, operation] of stages) {
    const assignment = script.indexOf(`$result = 'wrapper-${label}-failed'`);
    const guard = script.indexOf(operation);
    assert.ok(assignment > previous && guard > assignment, label);
    previous = guard;
  }
  assert.match(script, /GITHUB_REF -cne 'refs\/heads\/qa\/windows-storage-diagnostic-44794993333'/);
  assert.match(script, /\.Environment\.Clear\(\)/);
  assert.match(script, /\.StandardError\.BaseStream\.CopyToAsync\(\[IO\.Stream\]::Null\)/);
  assert.match(script, /\$child\.ExitCode -eq 1[\s\S]*entry-\(\?:host\|paths\|image\|probe\)-failed/);
  assert.match(script, /\$child\.ExitCode -eq 0 -and \$output -ceq 'ok ok ok ok'/);
  assert.match(script, /if \(\$result -cne 'ok ok ok ok'\) \{ exit 1 \}/);
  assert.doesNotMatch(script, /Write-(?:Host|Output|Error|Warning).*\$(?:output|_|Error)|Invoke-Expression/);
});

test('inert wrapper output grammar admits only fixed Node refusals and complete tuples', () => {
  const script = read('scripts/windows/test/run-packaged-storage-admission.ps1');
  const phase = script.match(/\$phase = '([^']+)'/)[1];
  const body = script.match(/-cmatch "\\A(.+)\\z"/)[1];
  // Exercise the actual regex body without launching PowerShell or packaged Node.
  const grammar = new RegExp(`^(?:${body.replaceAll('$phase', phase)})(?![\\s\\S])`);
  for (const input of ['entry-host-failed', 'entry-paths-failed', 'entry-image-failed', 'entry-probe-failed',
    'ok ok ok ok', 'launch-failed timeout skipped skipped', 'ok helper-failed unexpected-effect skipped']) {
    assert.ok(grammar.test(input), input);
  }
  for (const input of ['entry-parse-failed', 'ENTRY-HOST-FAILED', 'entry-image-failed D:\\raw-path', '',
    'ok ok ok', 'ok ok ok ok more', 'ok ok ok ok\nlog', 'ok ok ok ok\n']) {
    assert.ok(!grammar.test(input), input);
  }
});
