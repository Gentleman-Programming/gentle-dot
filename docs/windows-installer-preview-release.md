# Windows installer testing prerelease

This workflow builds Windows x64 on `windows-2022`, using the existing producer and guards. It does not modify the approved download page, run an installer on the publisher's computer or declare a stable release.

## Trigger and source identity

Workflow: `.github/workflows/windows-installer-preview.yml`. Initial runs use a **new unique** `qa/windows-installer-preview/<commit>` branch push containing the reviewed workflow. This works without merging a new dispatch workflow into `main`. Future manual `workflow_dispatch` use requires GitHub to register that workflow on the default branch. Never force-update someone else's QA branch or rerun an unchanged failed candidate blindly.

The exact source is `github.sha`. Builds use native x64 Rust, Node24.14.1, Go1.25.10 and workspace-pinned pnpm11.5.0. Workspace installation is frozen; the existing runtime producer's separate npm/postinstall lock gap is not silently claimed fixed.

## Mandatory checks

1. Validate native host/source plan. Initialize existing x64 MSVC/SDK, obtain the exact running Node24.14.1 release's public headers and `win-x64/node.lib`, verify their unique published SHA-256 entries **before extraction**, then execute the established `build:windows-stop` command with absolute compiler/headers/library paths. Load the resulting addon to check ABI compatibility. Only then build with `scripts/windows/package.ps1 -Target windows-x64`; do not remove its missing-addon guard.
2. Collect the existing source-bound QA payload: installer, producer runtime manifest and `QA-MANIFEST.json`.
3. After one build, run packaged Node/daemon startup and isolated install/readiness/reinstall/uninstall in **two separate Windows jobs in parallel**. `fail-fast: false` ensures one failed check does not hide/cancel the other. No `continue-on-error`, shared profile/process environment, or installer path/integrity guard bypass.
4. Retain the three-file QA payload and a separate archive of only the staged product runtime. Each check downloads artifacts from this same run, verifies the archive's SHA-256 from the producer job output **before extraction**, validates the exact source-bound QA payload, and verifies the restored runtime against the producer manifest. No arbitrary run-ID input or installer extraction.
5. Both checks retain their own sanitized diagnostics even on failure. A failed check remains a failed workflow and cannot publish. Only successful source contracts, build, **and both acceptance jobs** enable publication, which re-verifies the exact three QA files again.

The initial source7c169e2 run44604197343 failed before packaging because the native addon prerequisite was missing; no installer or release was produced. The bounded correction reuses `.github/workflows/windows.yml`'s established public-input recipe in this new workflow only. It does not change the producer or historical runtime/port checks. A new candidate is a changed hypothesis, not a rerun of the failing source; downstream success is not assumed.

## Parallel jobs and focused retries

```text
contracts → build once ┬→ Check startup   ─┬→ publish prerelease
                       └→ Check lifecycle ─┘
```

The fast contracts job runs the YAML/payload tests and the inert PowerShell7 startup suite before spending time compiling. The startup and lifecycle jobs use independent runners, isolated data and ephemeral loopback ports. Artifacts remain immutable for14days. GitHub **Re-run failed jobs** on the same run/source can reuse the successful build's artifacts; do not rerun all jobs, overwrite old artifacts, or rerun failures blindly. A changed source still needs its own build. The producer previously took9m50s versus7s to detect startup failure: parallel acceptance checks do **not** make Rust compilation faster, and no speedup is claimed without measurement.

The failed source560c4e9 run44605857828 produced an installer, but startup returned `daemon-startup-earlyexit` and hid the cause by design; lifecycle/publication were skipped. This is not a validated installer or proof of a product fix. The new fan-out prevents that failure from suppressing lifecycle evidence.

Startup opt-in: `./scripts/windows/test-daemon-startup.ps1 -Runtime ./build/windows/runtime -DiagnosticsPath NEW.json`. Omit `-DiagnosticsPath` for the previous exact fixed stdout/exit behavior. Diagnostics project only bounded outcome, the owned process's numeric exit code and sanitized health/TCP/HTTP enums; raw stdout/stderr remain `NUL`, no profile/error-message contents are recorded, and existing files are never overwritten. Diagnostics occur after the readiness decision and cannot change its result or replace whole-owned-job cleanup. Exit code alone may not establish the root cause.

Only the publication job has `contents: write`; its token reference is scoped to the publication step. No credentials are embedded, copied from a user profile or printed. Checkout does not persist Git credentials. Native app building happens on Windows; the Ubuntu publication job only verifies/uploads the existing bytes.

## Release boundary

Tag: `windows-preview-<run-id>-<attempt>`, immutable exact source target. GitHub release is **prerelease** and **not latest**. Notes identify source/run and say that publisher signature and manual acceptance are not established. The stable web page intentionally excludes it. Use its direct GitHub prerelease page for testing; do not represent it as a stable anonymous installer.

Windows may warn about an unsigned installer. Review its origin and use isolated/disposable test state; do not overwrite a production installation or user data without the separate backup/recovery authorization. This workflow's CI lifecycle check is not permission to install locally.

## Local source checks (no real packages or installers)

```sh
node --test scripts/package/test/windows-preview-release.test.mjs scripts/package/test/ci-workflow.test.mjs
node scripts/package/windows-preview-release.mjs --help
# Read-only verification in CI after downloading this run's artifact:
node scripts/package/windows-preview-release.mjs DIRECTORY FULL_SOURCE_SHA
```

Tests retain synthetic temp files without cleanup, use the already-installed workspace YAML parser and check exact stdout/stderr/exit plus input preservation. No build, provider, real installer or GitHub token is exercised locally. Existing six-target QA workflow and website remain unchanged.
