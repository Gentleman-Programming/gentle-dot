import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const shell = process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh';
const run = (file, env = process.env) => spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8', env });
const lines = text => text.replaceAll('\r\n', '\n');

const workflowFile = '.github/workflows/windows-staged-daemon-phases-44794993333.yml';
const branch = 'qa/windows-private-memory-reasons-45201908966';
const oldBranch = 'qa/windows-staged-daemon-phases-44794993333';
const repository = 'Gentleman-Programming/gentle-dot';
const workflowName = 'Windows staged daemon phases 44794993333';

test('phase workflow admits only the fresh exact push ref on attempt one', () => {
  const workflow = lines(readFileSync(workflowFile, 'utf8'));
  assert.equal(workflow.split('\n')[0], `name: ${workflowName}`);
  assert.equal(workflow.split('on:\n')[1]?.split('permissions:')[0], `  push:\n    branches:\n      - '${branch}'\n`);
  assert.ok(workflow.includes(`jobs:\n  observe:\n    if: github.repository == '${repository}' && github.ref == 'refs/heads/${branch}' && github.event_name == 'push' && github.run_attempt == '1'\n    runs-on: windows-2022\n`));
  assert.equal((workflow.match(/github\.token/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /tauri build|upload-artifact|workflow_dispatch|publish|package\.ps1/);
});

test('macOS adds only the fresh branch exclusion and keeps the existing triggers', () => {
  const macos = lines(readFileSync('.github/workflows/macos.yml', 'utf8'));
  assert.equal(macos.split('on:\n')[1]?.split('\npermissions:')[0],
    `  push:\n    branches-ignore:\n      - 'qa/windows-staged-owner-44794993333'\n      - '${oldBranch}'\n      - '${branch}'\n    tags: ['**']\n  pull_request:\n  workflow_dispatch:\n`);
});

for (const ref of [oldBranch, 'main']) {
  test(`staged wrapper refuses ${ref} before evaluating staged inputs`, () => {
    const result = run('scripts/windows/test/run-staged-daemon-phases.ps1', {
      ...process.env, OS: 'Windows_NT', CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'observe',
      GITHUB_REPOSITORY: repository, GITHUB_WORKFLOW: workflowName, GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: `refs/heads/${ref}`, GITHUB_WORKFLOW_REF: `${repository}/${workflowFile}@refs/heads/${ref}`,
      STAGED_PHASE_RUNTIME_SHA256: 'invalid', // Even an erroneously admitted host cannot continue.
    });
    assert.ifError(result.error);
    assert.deepEqual([result.status, lines(result.stdout), result.stderr], [1, 'daemon-phases-host-refused\n', '']);
  });
}

test('unapproved host refuses before evaluating staged input', () => {
  const result = run('scripts/windows/test/run-staged-daemon-phases.ps1', { ...process.env, RUNNER_ENVIRONMENT: 'self-hosted' });
  assert.ifError(result.error);
  assert.deepEqual([result.status, lines(result.stdout), result.stderr], [1, 'daemon-phases-host-refused\n', '']);
});

test('inert PowerShell AST, isolated compile environment, projection and cleanup cutoff', () => {
  const result = run('scripts/windows/test/staged-daemon-phases.test.ps1');
  assert.ifError(result.error);
  assert.deepEqual([result.status, lines(result.stdout), result.stderr], [0, 'daemon-phases-contract: passed\n', '']);
});
