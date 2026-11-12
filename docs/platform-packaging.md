# Native packaging targets

**Implemented:** target selection in Dot's existing Tauri producers. This adapts
Arise's six native OS/CPU jobs, not its Python/Qt/Inno application or installer.
**Not verified:** six native builds, installed acceptance, or publication. See the
[distribution ownership and evidence gates](distribution.md).

| Target | Producer | Native staging requirement |
| --- | --- | --- |
| `darwin-arm64` | `node scripts/package/package-mac.mjs` (unchanged default) | ARM64 macOS, matching Node/Rust |
| `darwin-x64` | `node scripts/package/package-mac.mjs --target darwin-x64` | Intel macOS, matching Node/Rust |
| `linux-x64` | `node scripts/package/package-linux.mjs --target linux-x64` | Existing amd64 Docker builder |
| `linux-arm64` | `node scripts/package/package-linux.mjs --target linux-arm64` | Existing arm64 Docker builder |
| `windows-x64` | `powershell -NoProfile -File scripts/windows/package.ps1` (unchanged default) | x64 Windows, matching Node/Go/Rust |
| `windows-arm64` | `powershell -NoProfile -File scripts/windows/package.ps1 -Target windows-arm64` | ARM64 Windows, matching Node/Go/Rust |

## Options and output

macOS accepts `--target darwin-arm64|darwin-x64`; existing signing, skip-stage,
DMG-check and Finder-layout options remain. The standalone POSIX runtime stager
also accepts `darwin-x64`; it still refuses a mismatched host **before writes**.
Windows uses its separate ZIP/EXE stager, not that POSIX layout. Each command
accepts `--target` only once, including repetitions of the same value; repetition
fails with `--target may be specified only once.` before side effects.

Linux retains `--arch amd64|arm64`, output directory, Engram version and
`--no-arch-package`. Use either `--target` or `--arch`, not both. Target aliases
reuse the existing container architecture mapping. The Arch package remains
amd64-only; ARM64 still produces a Debian package. Containers may be emulated;
runtime staging inside them must match their Node process architecture.

Windows stage/package scripts accept `-Target windows-x64|windows-arm64` and
`-Help`. `stage.ps1 -CheckHost` checks the native OS, Node and Go targets without
staging; packaging additionally checks Rust. Invalid targets/host mismatches
exit 2 before downloads or output creation. Default Windows staging remains
`build/windows/runtime`; use separate clean workspaces per target, never stage
both into the same directory. Explicit Windows targets use Tauri's target-specific
bundle directory; the default retains `target/release/bundle`. Intel macOS uses
`target/x86_64-apple-darwin/release/bundle`; ARM retains its existing directory.

## Integrity and capability boundary

Node remains pinned to 24.14.1, Windows Engram to 3.4.0. Archive checksums,
Windows full-runtime sealing, NSIS path guards/current-user installation, and
macOS pinned Gentle AI signature/digest preservation remain in place. Missing
upstream checksum entries still fail closed; no replacement hashes are invented.
Gentle Pi's Windows Gentle AI dependency uses its verified Go source-build path,
not an invented signed Windows archive. Native build dependencies remain required.

Windows staging passes its validated target to `runtime-integrity.mjs seal ROOT
[TARGET]`; verification is `verify ROOT REFERENCE_MANIFEST [TARGET]`. The path
guard's `hook ROOT OUTPUT.nsh [TARGET]` and `destination ROOT DESTINATION [TARGET]`
use the same identity check. `TARGET` is `windows-x64` (default) or
`windows-arm64`, stored as `win32-x64` or `win32-arm64` in schema 1. Existing x64
manifests remain compatible. ARM64 requires explicit selection; unknown or
mismatched identities fail before changing manifests or hook output. These static
checks retain existing executable/header and full-inventory guards; they do not
establish native execution or provider compatibility.

The selected **separate app/runtime/eyes/hands** distribution is not implemented
by these installer changes. There is no new component downloader or activation.
Existing Windows provider pins do not establish ARM64 eyes/hands artifacts; do
not advertise those providers as ARM64-supported or substitute x64 payloads.

## Manual native QA artifacts

**Implemented, not remotely executed:** `.github/workflows/native-distributions.yml`
supports manual execution (`workflow_dispatch`) and pushes only to the exact
`qa/arise-native-installers-20261110` branch. It is read-only, fail-fast disabled
and artifact-only: no deployment, release publication, PR trigger or replacement
of `windows-native.yml`. The metadata
helper supplies all six native runners, target toolchains, build commands and
expected installer paths. A mismatched Node host fails before build output;
Rust must report the selected native host. Windows Go architecture is explicit.

| Platform | QA check written into CI | Missing proof |
| --- | --- | --- |
| Windows x64 | CI-only packaged Node+daemon launch contract, then existing isolated NSIS lifecycle smoke; matching installer path and x64 runtime identity | Native execution not run locally by this unit; physical Stop/provider acceptance separate |
| Windows ARM64 | Producer's staging checks and target identity; installer required | Installed smoke explicitly unsupported; x64/default smoke is never used |
| Linux x64/ARM64 | Native Docker server required; existing Debian/Ubuntu checks, plus Arch on x64 | Native Docker daemon/build prerequisites and container runtime checks not executed here |
| macOS x64/ARM64 | Existing producer `--sign - --check`: nested signatures, DMG mount/copy and daemon smoke | Ad hoc only, not notarized; GUI/installed acceptance separate |

CI uses Node `24.14.1`, pnpm `11.5.0` from `package.json`, Windows Go `1.25.10`,
existing stable Rust and `pnpm install --frozen-lockfile`. Linux keeps its existing
Debian Docker recipe, native architecture and Tauri libraries. These are supported
build inputs, **not a deterministic release lock**: stable Rust/container tags,
runtime npm ranges/latest Engram selection and postinstall inputs remain gaps.
Missing upstream checksums, installers or producer runtime manifests fail the job;
there is no `continue-on-error` fallback. ARM64 runner/tool availability is still a
native CI prerequisite, not proven by the structural tests.

### Packaged daemon launch contract (Windows x64 CI only)

After build and before installer smoke, CI invokes:

```powershell
./scripts/windows/test-daemon-startup.ps1 -Runtime "./build/windows/runtime"
```

It directly launches that staged `node/node.exe` with `daemon/cli.mjs`, not the GUI
or an ambient Node. The child environment is cleared and rebuilt from OS roots,
packaged Node/System32 PATH and fresh data/home/appdata/temp/cache directories under
`build/arise-ci-t6/daemon-<unique-id>`. No ambient profile, token, provider setting,
Node option or credential is forwarded. State is retained, not uploaded or cleaned.

An ephemeral loopback port uses the same reservation/release pattern as installer
smoke (a port-reuse race remains possible). At most 12 sanitized health probes run
within a 30-second deadline; an in-flight probe can add up to 3 seconds. Existing
TCP/HTTP/JSON/body limits are reused. Passing requires listener connection, HTTP 200
and a valid health shape, **not agent idle or installed readiness**. The existing
240-second installer smoke and all integrity checks still run unchanged afterward.

The CI OS adapter creates a private unnamed Windows Job Object with kill-on-close
and no breakaway permission. It creates Node **suspended**, assigns it to the job,
and only then resumes its primary thread. Assignment failure terminates the still
suspended root; no uncontained daemon execution is allowed. The Unicode environment
is explicitly constructed, and the inherited-handle list contains only an OS `NUL`
handle for stdin/stdout/stderr: no runner stdio, job handle, raw pipes or log files.

Only a fixed `daemon-startup-*` outcome is printed: passed, timeout, earlyexit,
invalid-runtime, not-ci, failed or cleanup-failed. Exit is 0 only for passed; every
other outcome exits 1. Cleanup unconditionally terminates the owned job, even when
the root exited, and waits at most five seconds for **zero active job processes**.
Root-only exit cannot certify descendant cleanup. Closing the last job handle is
the kill-on-close backstop; cleanup errors/timeouts still fail the contract.
There is no PID scanning or unrelated-process termination. This forced CI teardown
is not graceful-shutdown or physical Stop proof.

The embedded Win32 adapter is compiled only on actual CI launch. Local checks use
inert doubles and inspect creation/assignment/resume ordering and job accounting;
they do **not** compile or execute that adapter. Native compilation, nested-runner
job compatibility, descendant teardown and handle inheritance still need separately
authorized OS proof before native containment can be claimed.

Only the `darwin-arm64` runner row changes from `macos-15` to `macos-26`, the
[documented standard native ARM64 public runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The other five rows and Node/Rust host guards stay unchanged: no emulation, paid
runner or capacity guarantee is introduced. Intel's signed-byte compatibility
blocker remains unresolved. Local tests use inert sources and fake process/health
contracts; actual packaged execution and hosted macOS ARM64 acquisition still need
CI evidence. This instrumentation does not establish a Windows startup fix.

### Sanitized Windows startup diagnostics

`smoke-install.ps1 -Installer <setup.exe> [-DiagnosticsPath <new-file.json>]`
keeps the old invocation inert when the optional path is omitted. The opt-in file
is UTF-8 JSON, at most 1024 bytes, created without overwriting an existing file.
Only the existing smoke's newly created isolated CI data directory is used; no
personal/local profile, credential file or log is read for diagnostics.

| Fields | Allowed evidence |
| --- | --- |
| `schema`, `outcome` | Version 1; success, timeout, earlyexit, agenterror, or other |
| `processAlive`, `exitCode`, `pollCount` | Pre-cleanup boolean/nullable integer and bounded poll count |
| `listenerReachable`, `httpStatus` | HTTP response observed, nullable numeric status; null means unavailable, not proof of no listener |
| `healthShape`, `healthOk` | missing/array/object/other; nullable boolean |
| `agentState` | starting/idle/thinking/working/needs_you/restarting/error/unknown |
| `errorKind` | none/timeout/transport/other, selected by exception type only (unchanged legacy meaning) |
| Optional `probe.tcpState` | connected/refused/connecttimeout/unreachable/other/unknown |
| `probe.httpState`, `probe.httpStatus` | notattempted/response/statuserror/timeout/failure/other; nullable status 100–599 |
| `probe.jsonState` | notattempted/valid/invalid/oversize/other |
| `probe.healthShape`, `probe.healthState` | missing/array/object/other; notattempted/valid/invalidshape/other |

Legacy fields describe the existing readiness loop: successful REST requests
establish reachability but their status is unavailable from that helper; failed
HTTP responses may expose a numeric status. They are not reinterpreted.

The optional `probe` is a **single later snapshot**, after the readiness decision
and before existing cleanup, only when diagnostics are requested. A loopback-only
TCP connection has a 2500 ms cancellation budget (allowing Windows to report a
refusal rather than prematurely cancelling); a separate HTTP GET has a 500 ms
budget covering headers and body. No proxy, cookies, authentication, redirects or
retry is used. The response-header limit is 8 KiB; body reads stop at 4097 bytes
(4096 accepted, 4097 means oversize), with JSON parsing depth capped at 16. Only
allowlisted metadata leaves memory. `valid` health shape requires an object with a
boolean `ok` and a known agent-state enum; it does **not** assert idle/readiness.

TCP refusal, connect timeout and network/host unreachable are classified from
exception types/socket codes, never exception text. HTTP status errors, request/body
timeouts, other HTTP failures, invalid JSON and invalid health shapes are separate.
Unknown observation failures stay fixed categories; pre-launch failures may have
no `probe`. TCP and HTTP use separate connections and can race with process exit;
a connected TCP check is not proof that the earlier readiness request connected.
This small bounded extra observation does not retry readiness, restart the app,
change its 240-second deadline or feed success/failure decisions.
Unknown strings become fixed enums. Arbitrary content is never recursively redacted
or serialized: no stdout/stderr, app/daemon logs, health error text, exception
messages, URLs, headers, tokens, profiles, environment, usernames, paths or commands.
Unavailable metadata stays null/unknown; write failures emit only a fixed warning
and do not replace the original smoke failure. No secret fallback is attempted.

Only the Windows x64 job requests `$RUNNER_TEMP/windows-smoke-diagnostics.json`;
on failure it uploads that single file for seven days, never a profile/log/build
glob. A failure before the smoke runs can leave no file. Success creates the file
but does not upload this diagnostic artifact. The 240-second idle deadline,
success rules, cleanup, reinstall/uninstall ordering and ARM64 unsupported boundary
are unchanged. This is diagnostic instrumentation, **not an application fix**:
runs `42847087853` and `42865400061` timed out after building x64 NSIS. The latter
recorded 96 polls, process alive, and no recorded health response; null listener
metadata did not prove TCP refusal. The startup cause remains unknown. A new native QA run is still needed; pure helper/parsed-workflow tests
cannot establish installed readiness or effective Stop.

### CI helper commands

These commands never build, install, download, activate or publish anything:

```sh
pnpm package:ci:matrix
pnpm package:ci:plan --target windows-arm64 --source <40-character-lowercase-SHA>
pnpm package:ci:collect --target windows-arm64 --source <40-character-lowercase-SHA> --out <fresh-QA-directory>
node scripts/package/ci-native.mjs --help
```

`plan` and `collect` require a matching native OS/Node architecture. `--root DIR`
optionally selects the source/build root (default: current directory). Every valued
option may occur only once. Unknown options/targets, missing values, malformed SHA,
wrong runtime target identity, duplicate/missing installers and existing output
are rejected before collection writes. `matrix` accepts no options. There is no
default target: selectors must be explicit, avoiding accidental x64 smoke/builds.

Each uploaded artifact is `gentle-dot-VERSION-TARGET-FULLSHA-qa`; installer filenames
also identify that tuple. `QA-MANIFEST.json` records sizes/SHA256 for every installer
and the unchanged producer runtime manifest (`runtime-manifest.json`). This is
byte identity, not a publisher signature or an independent full-payload recheck.
CI check commands describe intended checks, not a manifest assertion that they
passed. The workflow uploads only after all required steps succeed, but ARM64
Windows installed acceptance remains explicitly unavailable.

App and runtime identities are represented separately while delivery remains
monolithic/embedded. Eyes/hands are unavailable in this CI, with no acquisition URL
and no ARM64 provider claim. A duplicate runtime ZIP would not implement the selected
lightweight format. See [remaining component acquisition/bootstrap work](distribution.md#what-exists-and-what-remains-planned).

### Deterministic checks only

`pnpm test:package-ci` uses an explicit non-native Node file allowlist. Set
`GENTLE_DOT_CI_TEST_ROOT` to a human-authorized system-temp directory first. Fixtures
are inert and retained for orchestrator-controlled cleanup; the test prints each
run directory. Structural checks parse YAML with the already-installed workspace
parser (no dependency installation). No full Vitest/native fixture suite is used.

**Next gate (Risk item 5):** independent CI/manifest verification and separate
platform-native build/runtime/installed acceptance. This unit does not grant remote
workflow dispatch, release, provider activation or application-install permission.

## Stable integration branch tests (S7)

**Implemented, not remotely executed:**
[the dedicated integration workflow](../.github/workflows/integration-tests.yml)
accepts pushes only on `docs/stable-integration-team` plus manual
`workflow_dispatch`. Push does not require registration on the default branch;
manual dispatch availability is not assumed before GitHub exposes the workflow.
Its positive paths filter covers app/package/script/container/packaging inputs,
lock/toolchain configuration, the two relevant QA workflows and the canonical
Windows workflow used by the structural prerequisite contract. Documentation or
ODD-evidence-only commits do not automatically repeat expensive native jobs.
No PR, main push, deployment, release, environment or secret access is introduced.

The `functional` jobs run on native Windows x64 (`windows-2022`) and Linux x64
(`ubuntu-24.04`): frozen pnpm install, TypeScript checking, full workspace Vitest
(including UI), UI build, and explicit deterministic CI contracts. Windows Vitest
globalSetup may build its private-storage Go helper on the disposable runner;
this is a prerequisite, not a skipped gate. Windows inert startup tests use the
runner's PowerShell 7 executable, not the System32 PowerShell 5 runtime.

Both Windows job paths now prepare `native/windows-stop.node` before workspace
tests or the runtime producer, respectively. They reuse the existing
`windows.yml` app-channel recipe: `ilammy/msvc-dev-cmd@v1.13.0` with x64 SDK
environment, Node headers and `win-x64/node.lib` for the running pinned Node
`24.14.1`, both verified against that official release's `SHASUMS256.txt` before
extraction/build, then `build:windows-stop` with an absolute `cl.exe` path and
explicit headers/library. Missing checksums, mismatches, extraction or build errors
fail the gate. This addresses a fresh-checkout prerequisite, not a new addon or
producer implementation; Linux execution and existing Go globalSetup are unchanged.

After functional gates, `native` jobs build and collect installed evidence for
only `windows-x64` and `linux-x64`, selecting unchanged shared metadata. Every
selected existing native QA step is retained: OS/Node/Rust host guards, Linux
native Docker architecture and clean-container installation/runtime checks;
Windows staged daemon launch followed by isolated NSIS install/hash/readiness,
reinstall/uninstall smoke, sanitized failure diagnostics, and installer/runtime
manifest collection. The Windows producer's fd3/nativeShutdown and integrity
requirements are not replaced by inert helper tests. Names distinguish static/UI
results from native-build/installed evidence; individual native steps distinguish
packaged launch from installed readiness. A failed prerequisite or check fails CI,
not an accepted skip. Artifacts remain QA-only, with unchanged 7/14-day retention.

Node `24.14.1`, pnpm `11.5.0`, Windows Go `1.25.10`, stable native Rust and the
existing Linux Docker recipe are reused. Existing six-target QA triggers and
`windows-native.yml` PR behavior are unchanged. There is no emulation, paid runner,
signature bypass, provider/microphone exercise or publication step.

**Local verification boundary:** parsed-YAML integration tests observed RED before
workflow creation (3 missing-file failures), then GREEN (3 passed). Imported
`ci-native`/`ci-workflow` deterministic contracts passed 6/6 using a physically
copied, lock-matching YAML `2.9.0` closure and retained inert fixtures. System32
PowerShell 5 inert startup contracts returned 4 passed/12 failed: its .NET lacks
`ProcessStartInfo.ArgumentList`, and first-use progress produced CLIXML on stderr.
No imported contract was weakened or corrected. A subsequent local prerequisite
correction selected the existing PowerShell 7.6.9 executable: the same 16 inert
contracts passed with empty stderr. The original PowerShell 5 failure remains
retained; neither result establishes Win32/native containment. No native app,
installer or provider ran on this host.

The bounded fresh-checkout prerequisite correction adds one parsed-YAML rule:
both Windows paths must initialize MSVC and prepare the checksum-verified,
Node-matching addon before their consumers. Its RED run kept the original three
contracts passing and failed only the missing-prerequisite rule. The focused GREEN
run passed all four contracts. The rule compares parsed steps and exact canonical
commands/guards plus ordering; it does not download headers/libraries or compile an
addon locally. Earlier RED3/GREEN3, CI6, PS5 failure, PS7 16/16 and the parent's
independent 33/33 evidence are retained, not replayed or replaced.

**Still incomplete:** historical T6 native proof failed unexpectedly after root
exit; its prior source-correction allowance is exhausted and is not reset here.
Neither this workflow nor its deterministic tests qualify Win32 descendant
containment, installed readiness, effective physical Stop or platform perfection.
The parent must independently verify the candidate, publish the exact branch,
observe its first current-candidate CI run and retain actual failures. Any further
native T6 correction/probe needs its own explicit authority; this workflow is not
permission to replay that exhausted probe. Runtime-lock/provenance gaps above
remain. I1's private-memory listener ownership/launcher qualification and cold-host
CI outcomes are still separate missing proof; this prerequisite correction does not
resolve them. Main was inspected as already included; no main port is part of this unit.

Source-transfer receipts live in the retained, excluded
`build/stable-consolidation-ci/` evidence directory. Seven CI/helper/test/docs
paths were imported byte-for-byte from primary HEAD `7c6adaf`; only this appended
section differs from the imported packaging document. Before/after receipts record
primary HEAD, status, logical/raw index and all seven SHA-256 identities. Mirror,
synthetic home/temp/cache and fixtures are retained for parent-controlled cleanup,
not intended as source delivery or uploaded diagnostic content.
