import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = path => readFileSync(path, 'utf8');
const dir = 'apps/desktop/src-tauri';
const branch = 'qa/windows-staged-owner-44794993333';
const shell = process.env.GENTLE_DOT_TEST_PWSH || (process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh');
const flags = ['-NoProfile', '-NonInteractive', '-File'];

test('one SHA-bound Windows x64 build and one staged observation, without bundling or publishing', () => {
  const workflow = read('.github/workflows/windows-staged-owner-44794993333.yml');
  assert.match(workflow, new RegExp(`push:\\s+branches:\\s+- '${branch}'`));
  assert.match(workflow, /runs-on: windows-2022/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}\s+with:\s+ref: \$\{\{ github.sha \}\}\s+persist-credentials: false/);
  assert.match(workflow, /node-version: '24\.14\.1'/);
  assert.match(workflow, /go-version: '1\.25\.10'/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /SHASUMS256\.txt/);
  assert.equal((workflow.match(/tauri build --no-bundle --target x86_64-pc-windows-msvc/g) ?? []).length, 1);
  assert.equal((workflow.match(/run-staged-owner-observation\.ps1/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /workflow_dispatch|upload-artifact|package\.ps1|secrets\.|GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED/);
  assert.match(read('.github/workflows/macos.yml'), new RegExp(`branches-ignore:\\s+- '${branch}'\\s+- 'qa/windows-staged-daemon-phases-44794993333'\\s+tags: \\['\\*\\*'\\]\\s+pull_request:\\s+workflow_dispatch:`));
});

test('opt-in is compile-only and selectors are not inherited by Node', () => {
  const build = read(`${dir}/build.rs`);
  for (const name of ['CARGO_CFG_TARGET_OS', 'CARGO_CFG_TARGET_ARCH', 'CI', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_WORKFLOW', 'GITHUB_JOB', 'GITHUB_WORKFLOW_REF', 'GENTLE_DOT_CI_OWNER_BUILD']) {
    assert.match(build, new RegExp(`"${name}"`));
  }
  assert.match(build, /rerun-if-env-changed=\{key\}/);
  assert.match(build, /rustc-cfg=windows_owner_observation/);
  assert.match(read(`${dir}/src/daemon.rs`), /#\[cfg\(all\(windows, windows_owner_observation\)\)\]\s*mod windows_owner_trace;/);
  const owner = read(`${dir}/src/daemon/windows.rs`);
  assert.match(owner, /windows_owner_trace::is_selector/);
  const trace = read(`${dir}/src/daemon/windows_owner_trace.rs`);
  assert.match(trace, /set_nonblocking\(true\)/);
  assert.doesNotMatch(trace, /println!|last_os_error|raw_os_error/);
});

test('wrapper rejects the wrong host with exact exit and streams', () => {
  const r = spawnSync(shell, [...flags, 'scripts/windows/test/run-staged-owner-observation.ps1'], {
    encoding: 'utf8', env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
  });
  assert.ifError(r.error);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, `owner-observation-host-refused${process.platform === 'win32' ? '\r\n' : '\n'}`);
});

test('inert PowerShell internal host gate, AST, receiver and cleanup cutoff', () => {
  const r = spawnSync(shell, [...flags, 'scripts/windows/test/staged-owner-observation.test.ps1'], { encoding: 'utf8' });
  assert.ifError(r.error);
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.replaceAll('\r\n', '\n'), 'owner-observation-contract: passed\n');
});
