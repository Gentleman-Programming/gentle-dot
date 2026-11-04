# Windows packaging preflight

**Implemented:** the Windows package entry preserves automatic staging, validates the
runtime before icon generation/build, and selects NSIS and MSI. **Pending:** bundled
Git acquisition, inclusion and discovery. This is the approved R6a subset, **not
completion of S6 or release acceptance**.

## Commands

Run from a native Windows build host with Node available on PATH:

```powershell
# Stages build/windows/runtime, validates it, then requests both installers.
./scripts/windows/package.ps1

# Validate only; never stages, generates icons, writes bundle config or builds.
./scripts/windows/package.ps1 --check
./scripts/windows/package.ps1 --check --runtime 'D:\Build Inputs\runtime'

# Reuse the default staged runtime, without invoking stage.ps1.
./scripts/windows/package.ps1 --skip-stage

# An explicit runtime also suppresses staging. It is not modified or resealed.
./scripts/windows/package.ps1 --runtime 'D:\Build Inputs\runtime' --bundles nsis
./scripts/windows/package.ps1 --skip-stage --bundles msi
./scripts/windows/package.ps1 --help
```

`--bundles` accepts exactly `nsis`, `msi`, or `nsis,msi` (the default).
`--runtime` resolves relative paths against the caller's working directory.
`--check` takes precedence over staging and building; it can be combined with
`--skip-stage`. Unknown options, missing option values and invalid bundle selections
fail before staging or build writes. Errors exit 1 with
`Windows packaging: MESSAGE` on stderr. Successful preflight exits 0 and prints
`Windows runtime verified: PATH`; help exits 0 without building.

Automatic staging still refuses an existing default runtime. It does **not**
replace, delete, repair or migrate that directory. Use `--skip-stage` to validate
and package it, or select an independently prepared runtime with `--runtime`.
No command copies the user's Git/npm installation, profile or credentials.

## Integrity and ownership

The build-host Node executes `package-plan.mjs`; unverified runtime executables
are not executed during preflight. It consumes the existing
`WINDOWS-INTEGRITY.json` and reuses the stager's inventory, SHA-256 and payload
checks: complete file-set equality, no links, mandatory Node/Engram/launcher/private
storage/daemon/UI files, exactly one native Gentle AI executable, and Windows `MZ`
headers. Validation never reseals a changed payload. An `MZ` header is only a
structural check, not architecture, signature or execution proof.

A self-authored manifest/hash list is not publisher provenance or a signature.
The unchanged stager verifies its pinned Node and Engram archive bytes against
upstream checksum lists; its dependency installation is not a frozen production
lock acceptance claim. A trusted Git producer recipe, full payload identities,
license/notices and discovery contract remain necessary before bundled Git can be
implemented. No download URL or checksum was invented for that deferred work.

The generated resource map packages the selected runtime at `runtime`. Both the
Windows Tauri config and the package entry select NSIS/MSI, with NSIS retaining
`currentUser` installation. Go launch/private-storage helpers, Rust stdio/Job
ownership and daemon native-addon handling are unchanged.

## Existing runtime and acceptance harness

The selected-base launcher and acceptance boundaries remain unchanged:

- Staging requires Go on the Windows build host. The runtime builder compiles a
  standard-library-only native `bin/pi.exe`; it derives adjacent `node/node.exe`
  and the bundled engine CLI from its own location, forwards argv directly without
  a shell, and preserves child stdio and exit status. Unix builds retain `bin/pi`.
- Staging pins Node `24.14.1` and Engram `3.4.0`. It builds the daemon, installs runtime
  dependencies with npm `--omit=dev` and no bin links, then assembles the helpers,
  Engram, UI and integrity manifest. This change does not update those versions.
- Windows CI run `39800141932` remains a failed integration result (47 failed,
  749 passed, 18 skipped); installer execution and installed-runtime acceptance
  remain pending. A launcher build/test pass does not close those gates.
- `smoke-install.ps1` remains a separate acceptance harness: isolated per-user
  install, runtime-manifest check, daemon health wait, stopped-app reinstall,
  canary preservation, then uninstall. Its `taskkill /T /F` cleanup is test cleanup,
  not proof of graceful shutdown or emergency-stop behavior. It was not run here.

## Build prerequisites and evidence boundary

Real installer builds still require the project's Windows Node/pnpm/Go/Rust/Tauri
build prerequisites. Tauri supports the explicit `--bundles nsis,msi` selection.
MSI additionally requires the Windows VBScript optional feature described in
[Tauri's Windows installer documentation](https://v2.tauri.app/distribute/windows-installer/).
These scripts do not enable OS features, install tools, configure signing or bypass
version mismatches. Confirm those prerequisites independently before a real build.

Offline fixture checks:

```text
node --test scripts/windows/test/package.test.mjs scripts/windows/test/stage.test.mjs
node --test scripts/windows/test/*.test.mjs
```

Package fixtures copy only packaging sources into isolated temporary repositories,
use a fake stage entry and fake pnpm executable, and validate tiny synthetic `MZ`
payloads with real host Node. They assert exit/stdout/stderr, staging/build calls,
bundle/resource selection and unchanged rejected runtime bytes. One preservation
case invokes the real stager only against an existing directory, before downloads.
Checksum tests mock only network responses. Integrity/runtime fixtures remain
retained; child environments are explicitly allowlisted with isolated profiles.
The fixture root used for this reconciliation is the explicitly authorized
`C:/Users/maicolj/AppData/Local/Temp/gentle-dot-windows-es-verify`; there is no automatic
cleanup. PowerShell 7 coverage is reported unavailable when `pwsh.exe` is absent.

R6a observed fixture results (physically copied sources, isolated child environment):

- Baseline stage/checksum check: 1 passed; PowerShell 7 was unavailable.
- RED against the unchanged package implementation: 16 package failures, 1 stage pass.
- Final focused package/stage run: 28 passed, 1 explicitly skipped PowerShell 7 subtest.
- Integrity/runtime preservation: 13 passed.
- Uncommitted differential against selected base `65bac`: existing public `seal` and
  `verify` commands with extra `--check` input retained identical stdout, stderr,
  exit status and manifest bytes.
- One stricter fixture-output check exposed PS5 module-autoload progress on stderr;
  suppressing progress only in that fixture fixed it. The failure and passing
  rerun are retained, with checksum/error assertions unchanged.
- Full Windows suite: pending the separately owned channel hygiene prerequisite;
  the parent owns the subsequent integration result.

These tests do **not** prove actual staging downloads, native provider execution,
installer creation, signing, installed-app behavior, Git availability, cross-platform
qualification or CI success. The full Windows suite is an integration gate after
the separately owned channel fixture hygiene lands; report its actual result,
not an assumption based on the focused tests.

## Retained historical evidence (selected base, not a fresh R6a result)

The previous W4 record reported these checks; they are retained as historical
claims rather than relabeled as this change's verification:

- `node --test scripts/windows/test/*.test.mjs` — passed, 15/15 on Windows with zero skips.
- `node --test scripts/windows/test/integrity.test.mjs scripts/windows/test/stage.test.mjs`
  — passed, 5/5; fixture-tree integrity and the real checksum function with mocked network.
- PowerShell AST `ParseFile` checks — passed for `package.ps1`, `stage.ps1`, and
  `smoke-install.ps1` under Windows PowerShell 5.1 and pwsh; scripts were not executed.
- `git diff --check` — passed.

No runtime lock or clean staging tree was established by W4: an earlier staging
attempt reached npm install and stalled for about 16.8 minutes before cancellation,
after verifying and stopping only owned processes. The packager, downloader,
installer and smoke harness were not run for W4; no installer was created.
Current dependency resolution and broader CI/installed acceptance remain open.

The historical W4 rollback surface includes `package.ps1`, `stage.ps1`,
`runtime-integrity.mjs`, `smoke-install.ps1`, integrity/stage tests, `package.json`,
`tauri.windows.conf.json`, and this document. R6a additionally adds
`package-plan.mjs` and package CLI tests; consider downstream consumers before
reverting either work unit. No runtime replacement or data migration is authorized
by a source rollback.
