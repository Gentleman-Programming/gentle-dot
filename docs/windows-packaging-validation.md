# Windows runtime packaging and validation

The Windows packaging path stages a relocatable runtime, records file hashes, builds a per-user NSIS installer, and provides a separate install smoke test. Source and fixture checks below do not prove a working installer or clean-machine acceptance.

## What the staged path does

- `package:windows` runs `scripts/windows/package.ps1`, which generates an icon, stages `build/windows/runtime`, then invokes Tauri to build an NSIS bundle configured for current-user installation.
- Staging requires Go on the Windows build host. The runtime builder compiles a standard-library-only native `bin/pi.exe`; it derives adjacent `node/node.exe` and the bundled engine CLI from its own location, forwards argv directly without a shell, and preserves child stdio and exit status. Unix builds keep the existing `bin/pi` shell wrapper.
- Staging pins Node `24.14.1` and Engram `3.4.0`; each archive is checked against the upstream SHA-256 listing before extraction. The daemon bundle is built, then its runtime dependencies are installed with npm `--omit=dev` and no bin links; the native launcher, Engram, UI, and integrity manifest are assembled. The Windows runtime integrity manifest requires and hashes `bin/pi.exe`.
- Windows CI run `39800141932` remains a failed integration result (47 failed, 749 passed, 18 skipped); installer execution and installed-runtime acceptance remain pending. A launcher build/test pass does not close those gates.
- The manifest inventories runtime files by SHA-256, rejects links/unsupported entries, requires key runtime files and exactly one bundled Gentle AI executable, and checks only the `MZ` prefix of selected executables. Verify compares both missing/changed and unexpected files to the supplied manifest.
- This detects later tree drift relative to that manifest. It does not authenticate the manifest, establish publisher trust, verify a PE signature, or prove all executable bytes are valid. Upstream archive checksums likewise are not a signature guarantee.
- `smoke-install.ps1` is a separate acceptance harness: isolated per-user install, runtime-manifest check, daemon health wait, stopped-app reinstall, canary preservation, then uninstall. Its `taskkill /T /F` cleanup is test cleanup, not proof of graceful shutdown or emergency-stop behavior.

## Destination guard (S2 / S4, T6)

The Windows packager now refuses destinations that cannot contain the **entire verified staged payload** within conservative legacy NSIS path limits. This is a refusal/supported-path correction, not arbitrary-long-path extraction support. No inventory exclusions, global `LongPathsEnabled` changes, elevation requirement, or Unix packaging changes are introduced.

### Build and QA usage

`package.ps1` runs the existing inventory verifier through `installer-path-guard.mjs`, generates `build/windows/installer-path-hooks.nsh`, and sets `bundle.windows.nsis.installerHooks` in its generated config. Malformed manifests, unsafe relative keys, and staged drift stop packaging. The budget also includes the integrity manifest, `gentle-dot.exe`, `uninstall.exe`, all parent directories, and empty staged directories.

Internal helper commands (Node, no dependencies):

```text
node scripts/windows/installer-path-guard.mjs hook STAGED_ROOT OUTPUT.nsh
node scripts/windows/installer-path-guard.mjs destination STAGED_ROOT ABSOLUTE_DESTINATION
```

The second command prints only the accepted destination, or an English error to stderr and exit 2. It accepts local absolute drive paths, preserves spaces/UTF-16 code units, strips trailing separators, and rejects traversal. A rejected length reports the exact staged destination budget. `smoke-install.ps1 -Installer SETUP.exe` keeps its public option and lifecycle, but chooses `build/windows/qa-<unique-id>/Installed Gentle Dot` with repo-local data. It verifies this destination **before creating QA data**; a deeper checkout that cannot fit stops with the computed budget, never falls back outside the repository. NSIS registration/shortcuts remain real user-profile effects: the harness still requires explicit authorization and a separate prior-installation preflight.

### Limits and hook placement

For destination length `D` (excluding trailing separators), every installed file suffix `F` must satisfy `D + 1 + F.length <= 259`; every directory suffix `P` must satisfy `D + 1 + P.length <= 247`. Lengths are UTF-16 code units. The directory ceiling conservatively reserves NUL in addition to the documented `MAX_PATH - 12` directory allowance. See [Microsoft's maximum-path documentation](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation).

The [official Tauri hook documentation](https://v2.tauri.app/distribute/windows-installer/) describes PREINSTALL before files/registry/shortcuts. However, the [2.12.1 template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi) places previous-uninstaller execution in `PageLeaveReinstall` **before Directory and every section**; WebView2 setup and `SetOutPath` also precede PREINSTALL. A hidden section alone is therefore insufficient.

The hook extension now uses the [documented MUI_CUSTOMFUNCTION_GUIINIT callback](https://nsis.sourceforge.io/Docs/Modern%20UI%202/Readme.html) to validate the initial supplied/default destination before maintenance pages. Silent mode has no GUI/pages, so a mandatory hidden first section guards that route; PREINSTALL rechecks before payload extraction. An existing GUI-init callback definition causes a compile-time error, not silent replacement. No duplicate `.onInit`, full template copy, or registry mutation is added. Recheck these ownership/order assumptions after a Tauri upgrade and in the next generated product installer.

Native and Node validation reject dot/dot-dot components rather than resolving traversal to a sibling. Supplied unsupported `/D` destinations exit 2 before the previous-uninstall branch, destination creation, prerequisites or payload extraction. Ordinary GUI setup displays an actionable English message; `/S` and `/P` suppress the dialog and return 2 with empty stdout/stderr. This is not an upgrade transaction: if a user supplies a valid initial destination, authorizes maintenance, then changes the destination to an invalid one on the later Directory page, rejecting that later path cannot undo the already-authorized uninstall. Existing maintenance behavior for valid initial destinations is retained.

Current staged inventory: 28,345 hashed files; maximum destination **108 UTF-16 code units** (file maximum 150, directory maximum 121). The generated QA destination on this checkout is 98 code units, leaving 10 units of destination headroom. Limiting file suffix:

```text
runtime/daemon/node_modules/@earendil-works/pi-agent-core/node_modules/@earendil-works/pi-ai/dist/providers/qwen-token-plan-individual.models.d.ts.map
```

Longest directory suffix:

```text
runtime/daemon/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/type/engine/constructor_parameters
```

These are observations, not hard-coded budgets: packaging recomputes them from its staged tree.

### Bounded native evidence and remaining acceptance

- Initial deterministic rule tests failed because the guard module did not exist. The no-guard native fixture returned 0 instead of required 2. A second RED using actual Tauri ordering proved PREINSTALL alone created the rejected destination; the early section fixed that.
- The isolated NSIS fixture uses the existing Tauri compiler, a shared 30-second deadline, no registry/shortcuts/app, and writes only `build/windows/path-guard-fixtures/run-*`. It checks exact exit/stdout/stderr, rejection before directory creation, unchanged existing sentinel/counter bytes, supported paths with spaces/astral Unicode/trailing separators, and actual directory/file lengths **247/259**. A no-guard valid-case differential preserves bytes and exit/output. The no-guard **248/260** case returns **0 with payload absent**, reproducing the extraction cliff without touching the product.
- One fixture invocation initially rejected a valid spaced/trailing-separator path because Node applied CRT argument quoting. Using NSIS's documented verbatim final `/D=` argument corrected the fixture; the PowerShell harness already uses that convention.
- Earlier writer runs reported 5/5 focused and 21/21 suite on this checkout. Independent verification superseded portability confidence: **20 passed / 1 failed**, zero skips, with the Unicode fixture ending in a space at a 97-character base. The corrected fixture reserves the complete astral pair and a final legal character, and derives its boundary suffix from the available base budget rather than assuming a short checkout.
- Correction RED reproduced all three findings: maintenance `/P` returned 0 and changed the substituted uninstall counter; native traversal was accepted; the 97-character Unicode case raised ENOENT. Correction fixtures model Tauri's `PageLeaveReinstall` upgrade/uninstall branch, substituting only external uninstall effects with an owned file counter. They exercise actual MUI GUI-init under `/P`, the `/S` section route, compile-time callback collision rejection, and unchanged valid maintenance effects. No real uninstaller, app, registry, packaging or lifecycle script is executed.
- Corrected focused run: **7/7 passed**. The full Windows Node suite was run once for this correction: **23/23 passed**, zero skips. Each guarded maintenance/traversal `/P` and `/S` invocation exited 2 with stdout/stderr empty, unchanged counter `0`, unchanged sentinel, and no rejected destination. The unguarded `/P` maintenance baseline exited 0 and changed the counter to `uninstall-effect`; unguarded `/S` traversal exited 0 and wrote the escaped sibling payload. Valid `/P` maintenance effects matched baseline. PS5 parsing of package/smoke scripts passed. Commands used child-local portable PS7 PATH and scoped telemetry/update/module-cache settings.
- Native fixtures/evidence are intentionally retained in the ignored fixture directory. The failed product installation/registration and original setup bytes are preserved. No product rebuild, app launch, reinstall, uninstall, or overall Windows acceptance is claimed here; the parent owns the next bundle run and installed verification. Packaging risk **item 5** remains an independent verification boundary.

Rollback boundary: remove this destination-guard helper/test and its wiring in `package.ps1`/`smoke-install.ps1`, plus this documentation section, as one cohesive unit. Do not revert the earlier checksum/runtime fixes or touch preserved installations. The cohesive original-plus-correction source/tests/docs unit forecasts roughly 500 authored changed lines, above the advisory 400-line review size; boundary proof stays with the behavior, with disposition owned by the parent.

## Current checksum correction (S2 / T3)

The single bounded native Windows PowerShell fetch used `Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 "https://github.com/Gentleman-Programming/engram/releases/download/v3.4.0/checksums.txt"` (outer process timeout: 45 seconds). It exited 0 with HTTP 200 under PS `5.1.26100.9711`; `.Content.GetType().FullName` was `System.Byte[]`. The exact listing was logged as base64 and escaped JSON: six UTF-8/ASCII lines, LF endings, final LF, no BOM. Its Windows x64 entry was exactly:

```text
3065736ec7ff8137eb3fc607275f542ea13bb743a5157318c8a8770f11ce3289  engram_3.4.0_windows_amd64.zip
```

The production function previously applied a text regex to that byte array. It now decodes byte-array content as UTF-8 before matching; existing string handling, archive hashing, missing-entry rejection, pins and function interface remain unchanged. No executable ZIP was fetched for this diagnosis, and there is no digest fallback.

Observed validation:

- `node --test --test-name-pattern="stage handles observed PS5" scripts/windows/test/stage.test.mjs`: RED exit 1, stdout empty, script stderr `Expected 'Checksum mismatch: engram_3.4.0_windows_amd64.zip'; got 'Missing checksum for engram_3.4.0_windows_amd64.zip'`. GREEN exit 0, 1/1 passed; script stdout `PS5 checksum regression passed`, stderr empty. The fixture replays the exact fetched listing against synthetic `abc` bytes, expecting mismatch, not claiming a real archive download. Additional controlled byte/string listings verify valid bytes, tampering and absent entries. Rejections return no verified path or staged consumer artifact; absent entries initiate zero archive downloads. Tampered downloads remain untrusted temp files until fixture teardown.
- Initial fixture-runner failures were not behavioral RED: an oversized encoded invocation produced `spawnSync powershell.exe EPERM`; stdin `-Command -` then produced empty stdout without executing the final block. The fixture now evaluates stdin as one script block.
- Native PS5 differential against `b1c1876` extracted the production function from each version and used unchanged string content with valid and tampered bytes. Both exited 0, stderr empty, with identical stdout: `text: verified abc`, `Checksum mismatch: archive.zip`, `rejected: no staged artifact` (CRLF-terminated). Both temporary fixture directories were removed in teardown.
- `node --test scripts/windows/test/*.test.mjs`: exit 1, 15 passed / 1 failed. The new PS5 regression passed before the unchanged dual-host test failed on `spawnSync pwsh.exe ENOENT`. Its PS5 portion passed; PowerShell 7 coverage remains required, not waived.

Packaging risk item 5 and download-integrity risk item 2 remain review boundaries. The existing partial `build/windows/runtime` was preserved; no packaging rerun, installation or installed acceptance occurred. This correction does not establish a complete installer or successful real Engram ZIP verification.

## Historical evidence and boundaries (W4, not current-host proof)

- `node --test scripts/windows/test/*.test.mjs` — passed, 15/15 on Windows with zero skips.
- `node --test scripts/windows/test/integrity.test.mjs scripts/windows/test/stage.test.mjs` — passed, 5/5; fixture-tree integrity and real checksum function with mocked network responses.
- PowerShell AST `ParseFile` checks — passed for `package.ps1`, `stage.ps1`, and `smoke-install.ps1` under both Windows PowerShell 5.1 and pwsh. Scripts were not executed.
- `git diff --check` — passed.

No runtime lock or clean staging tree is established here: an earlier staging attempt reached `npm install` and stalled for about 16.8 minutes before it was cancelled after verifying and stopping only owned processes. The Windows packager, downloader, installer, and smoke-install script were not run for this W4 preparation; no installer was created. The runtime dependency tree may therefore depend on current resolution. CI workflow and broader integration evidence are W5, not this unit.

Rollback is the W4 unit in `scripts/windows/package.ps1`, `scripts/windows/stage.ps1`, `scripts/windows/runtime-integrity.mjs`, `scripts/windows/smoke-install.ps1`, `scripts/windows/test/integrity.test.mjs`, `scripts/windows/test/stage.test.mjs`, `package.json`, `apps/desktop/src-tauri/tauri.windows.conf.json`, and this document; consider downstream consumers before reverting it.
