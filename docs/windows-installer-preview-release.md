# Windows installer testing prerelease

This workflow builds Windows x64 on `windows-2022`, using the existing producer and guards. It does not modify the approved download page, run an installer on the publisher's computer or declare a stable release.

## Trigger and source identity

Workflow: `.github/workflows/windows-installer-preview.yml`. Initial runs use a **new unique** `qa/windows-installer-preview/<commit>` branch push containing the reviewed workflow. This works without merging a new dispatch workflow into `main`. Future manual `workflow_dispatch` use requires GitHub to register that workflow on the default branch. Never force-update someone else's QA branch or rerun an unchanged failed candidate blindly.

The exact source is `github.sha`. Builds use native x64 Rust, Node24.14.1, Go1.25.10 and workspace-pinned pnpm11.5.0. Workspace installation is frozen; the existing runtime producer's separate npm/postinstall lock gap is not silently claimed fixed.

## Mandatory checks

1. Validate native host/source plan and build with `scripts/windows/package.ps1 -Target windows-x64`.
2. Collect the existing source-bound QA payload: installer, producer runtime manifest and `QA-MANIFEST.json`.
3. Execute packaged Node/daemon startup contract and isolated install/readiness/reinstall/uninstall checks. No `continue-on-error` and no bypass of installer path/integrity guards.
4. Retain a collected payload even if later acceptance fails; retain sanitized smoke diagnostics. A failed check remains a failed workflow and does not publish a prerelease.
5. Only a successful build/check job enables the separate publication job. It re-verifies exact file names, roles, target, source, lengths and SHA-256, rejects extra files/symlinks, then uploads exactly the three verified files.

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
