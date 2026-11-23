import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const shell = process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh';
const run = (file, env = process.env) => spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8', env });
const lines = text => text.replaceAll('\r\n', '\n');

test('workflow permits one new exact branch and keeps the previous macOS exclusion', () => {
  const workflow = readFileSync('.github/workflows/windows-staged-daemon-phases-44794993333.yml', 'utf8');
  const ref = 'qa/windows-staged-daemon-phases-44794993333';
  assert.ok(workflow.includes(`on:\n  push:\n    branches:\n      - '${ref}'\npermissions:\n  actions: read\n  contents: read\njobs:\n  observe:`));
  assert.match(workflow, /github\.event_name == 'push' && github\.run_attempt == '1'\n    runs-on: windows-2022/);
  assert.equal((workflow.match(/github\.token/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /tauri build|upload-artifact|workflow_dispatch|publish|package\.ps1/);
  assert.match(readFileSync('.github/workflows/macos.yml', 'utf8'), /branches-ignore:\n      - 'qa\/windows-staged-owner-44794993333'\n      - 'qa\/windows-staged-daemon-phases-44794993333'\n    tags: \['\*\*'\]\n  pull_request:\n  workflow_dispatch:/);
});

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
