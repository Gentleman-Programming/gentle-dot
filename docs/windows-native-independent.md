# Independent Windows native implementation

Status: Windows shell/lifecycle foundations implemented; **not a verified Windows desktop port**.

## Current continuation (2026-10-22)

The authorized feature branch is pushed through W4. This current checkpoint supersedes older progress and test snapshots below where they differ; historical notes are retained for provenance. No PR, main merge, release, or CI run exists. The Windows CI workflow is a separate W5b work unit and remains staged. This W5a documentation/handoff update is intentionally a separate passive evidence unit, not a substitute for or bypass of native classification.

| Work unit | Published commit | Review state |
|---|---|---|
| W1 — Windows runtime discovery | `9a5c0b4e7c1aac6d82e7b46630268520e65f89e0` | Approved and acknowledged; authority burned |
| W2 — Windows daemon lifecycle | `ea1ade4f97209e98714e43b09e46ded435d25329` | Approved and acknowledged; authority burned |
| W3 — Credential Manager | `70cabf981d494525a4a63789c82ee44ffd67afb7` | Covered in the later W3+W4 review |
| W4 — Packaging and runtime integrity | `45213ba240c6c6e3cc40a2a82b149910c0b76961` | W3+W4 candidate approved and acknowledged; authority burned |

These reviews are candidate-scoped and informational; they do not prove native Rust execution, installed-app behavior, or desktop parity. Do not reopen the consumed W3+W4 target or implement its non-blocking advisories in place. Preserve those as follow-ups for a future authorized candidate.

### Current evidence

- Windows Node contract suite: 15 passed, zero failed or skipped; focused runtime and app-channel suites: 9 passed each. TypeScript build passed. PowerShell 5.1 and pwsh parsed all three installer scripts.
- The latest seven-suite Vitest run remains failed: 11 failed, 53 passed, one existing skip, plus an unhandled Unix socket `EACCES`; earlier full-suite run also failed with worker errors. These are not converted to skips or treated as Windows-wide proof.
- Rust application tests/build remain blocked before application compilation because MSVC `link.exe` is unavailable. A `windows-sys` dependency check is API/dependency evidence only. No native Credential Manager round trip, Job/ACL execution, or Windows Rust binary is verified.
- No Windows installer was produced or installed. An earlier stage reached runtime `npm install`, stalled for about 16.8 minutes, then was cancelled after verifying and stopping only owned processes. Runtime transitive dependency locking remains open.
- Windows capture, input, UI Automation, emergency stop, and voice backends remain unimplemented. Standalone CLI private-directory/file DACL safety is also unproven; Rust app-root ACL source is not evidence for it.
- Packaging manifest comparison detects file-tree drift relative to its manifest, not publisher authenticity. The smoke harness's forced process-tree cleanup is test cleanup, not graceful-shutdown or panic-stop proof.
- `gh run list` returned no CI runs because the Windows workflow has not yet been published in W5b. The frozen W4 advisories about runtime dependency determinism and smoke failure cleanup remain future work.

### Next boundary

W5a is limited to this evidence document, the historical handoff banner, and the task tracker. W5b is the distinct Windows CI workflow/integration-evidence unit. The orchestrator/native assessment owns whether that candidate needs review and any consent; this document grants none. No PR or other remote branch is authorized.

## Historical local Windows snapshot (2026-10-21)

The following dated continuation, test tables, and patch notes are retained as historical evidence. Use the current checkpoint above for present status; do not read historical counts or unverified claims as newer results.

## Local Windows continuation (2026-10-21)

This checkout now distinguishes Windows explicitly, uses non-template tray icons,
resolves the desktop home from USERPROFILE, discovers node.exe at build time, and
launches the packaged node/node.exe with a Windows PATH. The original Unix path is retained.

The Windows privileged channel uses anonymous child stdin/stdout pipes, not an
unauthenticated listener or shared secret file. Node blocks before importing the daemon
until the app has assigned the child to an unnamed kill-on-close Job Object. The app
removes Node preload variables; the daemon removes its non-secret transport selector
before starting children. Closing the channel requests orderly shutdown by EOF, then
the app enforces its bounded stop deadline. Windows does not trust editable PID files
to terminate unrelated processes. Native Job/crash cleanup still needs executable tests.

Independent verification found that closing the channel could wait behind a saturated
frame writer before the child stop deadline began. Shutdown now uses a separate handle:
Unix shutdown interrupts the socket without taking the writer mutex; Windows marks the
channel closed atomically and attempts EOF with try_lock only. A non-draining daemon
therefore cannot keep the owner from reaching its bounded child/Job termination path.
Regression tests saturate a Unix socket and a Windows owned child's pipe; the latter
also checks a 100 ms child grace deadline. `cargo test --locked --manifest-path
apps/desktop/src-tauri/Cargo.toml saturated -- --nocapture` remains blocked by the missing
MSVC linker; no native regression-test pass is claimed. The 14 Node contracts, typecheck,
isolated Windows API metadata, and whitespace checks were rerun successfully after this fix.

Connector secrets use Windows Credential Manager in the app's own service namespace,
not MemoryStore. Its 2560-byte credential limit returns an explicit error; larger tokens
need a future DPAPI-backed storage design. Data-directory protection changes only the
dedicated app folder, rejects reparse points and general profile/temp roots, and never
changes global permissions. ACL and credential roundtrip tests await a native Rust build.

| Check on this PC | Observed result |
| --- | --- |
| Node 24.13.1; pnpm 11.5.0; Rust 1.98.1 | Available |
| Locked dependency installation | Completed; Gentle AI 4.0.0 installed by gentle-pi without changing global Pi settings |
| `node --test scripts/windows/test/*.test.mjs` | Latest: 15 passed, 0 failed/skipped, including real anonymous-pipe protocol/EOF/descendant-selector integration and PS5/pwsh checksum valid/tampered-byte verification |
| `node node_modules/typescript/bin/tsc -b` | Passed after normalization |
| PowerShell scripts, PS5 and pwsh parser | All three scripts parsed |
| Full `node node_modules/vitest/vitest.mjs run` | Failed: 78 failed, 470 passed, 19 existing skipped; 28 worker errors; 359.73 s. The default 64 workers overloaded this host, alongside deterministic Unix assumptions |
| Targeted config/profile/engine-access Vitest, `--maxWorkers=2` | 11 failed, 28 passed, 1 existing skipped. Reproduces POSIX path/permission/user-ID assumptions independently of overload |
| `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --no-run` and `cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml` | Blocked before application compilation: MSVC `link.exe` unavailable; vswhere reported no registered installation |
| `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml -p windows-sys@0.61.2` and isolated `rustc --emit metadata` for new Windows modules | Passed; API/type evidence only, not executable/link/runtime evidence |
| `pnpm package:windows` | Two earlier attempts failed at Get-FileHash lookup. After a diagnosed source fix, one new attempt passed Node download/checksum/extraction and daemon bundling, then stopped making progress in runtime npm install. Cancelled the exact owned process tree after 16.8 minutes (PowerShell PID 28924/npm PID 3128, identity and start time rechecked); no installer or native compilation reached |
| `git diff --check` | Passed |

The first dependency-install attempt overlapped an automatically triggered second
installation and failed during a staging rename; the remaining installation completed.
That failure is not evidence of a provider defect. Subsequent commands were run directly
against installed tools to avoid another installation. New Windows transport tests also
exposed that Node's isFIFO reports false here despite st_mode=0x1000; the native mode
check now rejects terminals/files without relying on unavailable Windows S_IFIFO constants.
The previous packaging retry removed only the resolved, verified, empty
build/windows/runtime directory inside this checkout. The continuation removed that
same verified empty directory once, then replaced module-autoloaded Get-FileHash and
Expand-Archive with .NET SHA256 streams and ZipFile extraction. Streams and hashers are
disposed and checksum mismatch remains fatal. A new offline test invokes the production
download/checksum function on PS5 and pwsh and rejects tampered bytes. Real packaging
passed that former blocker; the exact underlying module-autoload failure remains unproven.
The partial generated staging tree is retained for diagnosis, not an installable runtime.

### Bounded portability follow-up

Runtime fixtures now use native absolute paths, path delimiters, USERPROFILE, readable
.exe fixtures, and platform-appropriate discovery instead of expecting a Unix login shell
on Windows. POSIX engine-access bracket tests explicitly provide a non-root identity
fixture on Windows; a separate test proves an unsupported effective identity refuses to
run. Production identity switching was not changed or emulated.

| Latest follow-up check | Observed result |
| --- | --- |
| Three-suite runtime/engine-access/isolation run, maxWorkers=2 | 29 passed, 3 failed in 132.58 s; runtime suite passed. Two failures are retained private file/directory mode assertions; one is daemon close hook timeout |
| Seven-suite focused run, maxWorkers=2 | Failed naturally: 11 failed, 53 passed, 1 existing skipped; 1 unhandled Unix pair.sock EACCES; 5 failed files/2 passed; 517.48 s. Finished before bounded cleanup, so no test process was killed |
| Full suite follow-up | Not launched after the focused run exhausted the bounded local budget; the earlier failed full-suite evidence remains above |
| TypeScript build | Passed after normalization |
| PS5 and pwsh parse of all installer scripts | Passed on both hosts |

Logs live in generated build/windows: node-contracts-portability.log,
portability-focus.log, portability-focus-final.log, typecheck-portability.log,
package-portability.log, and portability-cancellation.log. Cancellation is not a successful
build/test result, and no unverified attribution to unrelated host processes is made.

**Security blocker:** Node standalone private-directory/private-file creation still relies
on chmod. Windows POSIX mode bits do not prove DACL privacy. The existing Rust app-root
DACL work does not establish standalone CLI safety. Dedicated current-user/SYSTEM DACL
enforcement and inspection are required before claiming private standalone files; the
failing privacy assertions were not weakened or skipped. Windows child-guard denial and
CLI owner-loss fixtures still need native ACL/anonymous-stdio coverage. No CI prerequisite
gate was removed, and no test failures were converted to continue-on-error.

### Still required before calling this a working port

- Obtain MSVC/Windows SDK on an authorized build host and complete native Rust tests,
  including the new Job/EOF and unique Credential Manager fixture tests. Unix descriptor
  tests remain Unix-specific; common admission/store behavior has Windows coverage.
- Compare failing suites against the exact base before classifying regressions; replace
  POSIX-only fixture assumptions with genuine platform checks, not broad excludes/skips.
  Use `--maxWorkers=2` on this PC. CI retains its mandatory test/build gates.
- Diagnose the cancelled runtime npm install before a new packaging attempt. If restarting,
  remove only the verified generated build/windows/runtime tree.
  Pin transitive runtime dependencies; prove the installed runtime with no global pnpm.
- Implement the Windows Desktop backend (capture/DPI, mouse, Unicode keyboard, windows,
  UI Automation risk/protected-field inspection) behind existing grants and confirmations.
- Wire and prove Windows overlay, accessible emergency stop, cancellation, input release,
  stale-grant invalidation, and no automatic resume. There is no Windows control endpoint yet.
- Implement Windows microphone/transcription/TTS with independent device/provider errors.
  Voice remains honestly unavailable; no synthetic success or fallback was added.
- Build an installer, then verify actual installation/startup/upgrade/uninstall and native
  capabilities on this PC. No installer was produced or installed in this slice, so no
  screenshot/input/voice/emergency-stop acceptance claim is made.

Rollback boundary: the Windows-specific Rust modules and cfg branches, stdio transport
selector, generated ICO, and script fixes are one cohesive shell/lifecycle work unit.
The supplied independent runtime-discovery and packaging patch remains preserved.
No main merge, release, commit or push was performed by this implementation worker.
The portability-test/checksum follow-up rolls back independently by reverting the three
changed test files, stage.ps1, stage.test.mjs, and this evidence update; prior lifecycle
work and supplied patch remain intact.

The sections below retain the supplied patch's historical scope/evidence.

## Baseline and scope

Branch `feat/windows-native-independent` starts directly from upstream main
`8cb20ee888c88be2b359258a65499c20b59e2a86`. No commits or implementation from PR #57
were merged, cherry-picked or used as a source for this branch's changes.

Preserve Gentle Dot's UI, agent integration and native computer-control contract.
Develop Windows support independently. Do not turn a passing unit test or a successful
build into a claim of desktop parity. No release or merge to main is part of this slice.

## Implemented here

The installed daemon resolves Engram on Windows without spawning a Unix login shell.
Resolution uses an explicit readable absolute `.exe` override, then absolute entries
in the user's Windows PATH, known user folders, and the packaged binary. A broken
explicit override produces an error; a missing binary is never reported as installed.
Case-insensitive environment keys, spaces, UNC locations and duplicate PATH entries
are handled. Empty, drive-relative and root-relative entries cannot select an executable
from the current working directory. File discovery follows valid filesystem junctions;
it does not claim to verify executable integrity, ownership, ACLs or version compatibility.

The engine isolation code identifies the real Windows user home through USERPROFILE,
or HOMEDRIVE plus HOMEPATH, before the OS home fallback. An inherited MSYS HOME no
longer decides the user's memory and Git configuration location on Windows.
No global PATH, ACL, environment variable, package installation or permission is changed.
The existing Unix discovery path is retained.

## Delivery sequence and acceptance

1. **Native shell and runtime lifecycle:** Windows platform discrimination, data location,
   packaged Node/Gentle binaries, authenticated app/daemon channel, DPAPI secrets and
   owned-process cleanup. Test installation and upgrade as a normal user, including
   spaces, junctions, launch from Explorer without HOME, and preservation of chat data.
   Missing dependencies must identify their stage and repair action, not silently use
   an unrelated global installation. Do not loosen ACL checks to make installation pass.
2. **Native vision:** implement the existing Desktop capture contract on Windows;
   test monitor selection, negative origins, mixed DPI, image scaling, stale geometry,
   locked/session-disconnected screens and exclusion of the app's approval surfaces.
   Report unavailable/protected capture explicitly; no fabricated screenshot success.
3. **Native input and target inspection:** implement mouse/keyboard and window targeting,
   plus UI Automation risk inspection, behind the existing MCP helper and session grant.
   Do not expose a direct daemon input path that bypasses confirmations. Preserve secret
   field handling and blocked targets. Do not elevate to control UAC or higher-integrity apps.
4. **Stop and observation:** register and display a Windows-tested panic shortcut;
   invalidate queued work and captures on stop, expiry and session changes; release held
   input. An old task must not regain control after a new grant. Prove no automatic resume.
   Maintain an accessible stop control while the agent hides the chat for capture.
5. **Audio:** device enumeration, input capture and independent transcription/TTS status;
   avoid selecting an unavailable default microphone or implying that a model download
   fixes a device-open error. No silent voice/provider substitution.
6. **Release validation:** native Windows CI, installer smoke and interactive Windows
   11 tests; Windows 10 claims require their own validation. Keep macOS/Linux regression
   suites. Test multiple monitors, 100/125/150/200% DPI and a second personal machine.

## Evidence for this slice

Run from the repository root with Node 24:

```sh
node --test scripts/windows/test/runtime.test.mjs
```

Nine tests passed on Linux, including Windows path/environment decisions and a host
filesystem check through the production resolver. Windows decisions use an injected
file probe; this does **not** exercise NTFS permissions or a native Windows process.

Pending: full TypeScript typecheck/Vitest, native Windows test execution, Rust compilation,
installed app startup, screenshot/input/stop/UI checks. Rust and project node_modules
were not available in this development environment at the time of this slice.

## Completion rule

A capability is complete only when its implementation, failure behavior, cancellation
and real platform check are recorded at the same commit. Native screen/control support
remains unavailable until its backend and safety wiring are implemented and verified.

## Installer and CI scaffolding (not yet executed on Windows)

`pnpm package:windows` now invokes the independent PowerShell staging/build scripts.
It stages Node 24.14.1, Engram 3.4.0, the daemon's lockfile-resolved direct dependencies,
Gentle's native binary and the UI. Node/Engram downloads are checked against upstream
SHA-256 lists. An inventory checks every staged file when copied into an installed app;
this detects packaging corruption, not publisher authenticity or code signing.
Transitive runtime npm dependencies still resolve during staging; full reproducibility
requires a runtime npm lockfile in a later slice.

The per-user NSIS bundle includes the runtime. It has no release publication step and
is unsigned. Source builds need Git, Go, Node/pnpm, Rust/MSVC and WebView2 on the build
host; the end-user prerequisite behavior still needs validation on a clean Windows PC.

`.github/workflows/windows-native.yml` runs Windows TypeScript and Rust jobs independently.
The installer depends on both. Its smoke test compares the entire runtime against the
staged manifest, launches the installed executable with a fresh data directory and no
HOME, requires `/health` to report `agentState=idle`, verifies no runtime changes, then
checks stopped-app reinstall and uninstall with a data canary. The test uses forced
owned-process-tree cleanup; it is NOT proof of graceful shutdown, an upgrade while the
app is running, emergency stop, real provider responses, or native screen/control/audio.
Those checks remain open. Only a fully successful installer job uploads a QA artifact.

Validation here: 13 Node tests passed on Linux; workflow YAML parsed and dependencies
checked. PowerShell execution, Rust/Vitest and installation were NOT run locally.
Known next blockers in main: unguarded UnixStream and Unix filesystem/process APIs in
`app_channel.rs` and `daemon.rs`, Windows secrets storage, native launcher/runtime paths,
and macOS-only computer helper activation. The Rust gate is expected to expose these;
there is no `continue-on-error` or broad skip to conceal them.
