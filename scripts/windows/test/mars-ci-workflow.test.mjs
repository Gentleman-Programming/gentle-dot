import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Public configuration policy, not a substitute for executing the producer in CI.
const workflow = new URL('../../../.github/workflows/mars-windows-artifacts.yml', import.meta.url);
function source() { return readFileSync(workflow, 'utf8'); }
function section(text, name) {
  const match = text.match(new RegExp(`^${name}:\\n([\\s\\S]*?)(?=^\\S|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `missing ${name}`);
  return match[1];
}

test('only the explicit build-prefix push bootstraps this workflow', () => {
  assert.equal(section(source(), 'on'), "  push:\n    branches:\n      - 'build/mars-windows-ci-*'\n\n");
});
test('one bounded Windows 2022 artifact job with read-only credentials', () => {
  const text = source();
  assert.equal(section(text, 'permissions'), '  contents: read\n\n');
  const jobs = section(text, 'jobs');
  assert.deepEqual([...jobs.matchAll(/^  ([\w-]+):$/gm)].map(m => m[1]), ['windows-artifacts']);
  assert.match(jobs, /^    runs-on: windows-2022$/m);
  assert.match(jobs, /^    timeout-minutes: 60$/m);
  assert.match(jobs, /uses: actions\/checkout@v4\n        with:\n          persist-credentials: false/);
  assert.doesNotMatch(text, /\b(?:secrets|id-token|write-all|pull_request|workflow_run|workflow_dispatch)\b/);
});
test('baseline action versions, fresh tools and no hidden execution steps', () => {
  const text = source();
  assert.deepEqual([...text.matchAll(/uses: (.+)/g)].map(m => m[1]), [
    'actions/checkout@v4', 'pnpm/action-setup@v4', 'actions/setup-node@v4',
    'actions/setup-go@v5', 'actions/upload-artifact@v4',
  ]);
  assert.match(text, /node-version: '24\.15\.0'/);
  assert.match(text, /go-version: '1\.25\.10'/);
  assert.match(text, /cache: false/);
  assert.deepEqual([...text.matchAll(/^        run: (.+)$/gm)].map(m => m[1]), [
    './scripts/windows/build-mars-ci.ps1',
  ]);
  assert.doesNotMatch(text, /(?:publish|release|signing|gh |curl |Invoke-WebRequest|printenv|Get-ChildItem Env:)/i);
});
test('upload only explicit Windows outputs, checksums and provenance', () => {
  const text = source();
  assert.equal((text.match(/uses: actions\/upload-artifact/g) ?? []).length, 1);
  assert.match(text, /if-no-files-found: error/);
  assert.match(text, /include-hidden-files: false/);
  assert.match(text, /retention-days: 7/);
  const paths = text.split('          path: |\n')[1]?.trimEnd();
  assert.equal(paths, [
    '            build/mars-ci/artifacts/*-setup.exe',
    '            build/mars-ci/artifacts/SHA256SUMS.txt',
    '            build/mars-ci/artifacts/provenance.json',
  ].join('\n'));
});
