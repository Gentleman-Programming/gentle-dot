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
| Windows x64 | Existing isolated NSIS lifecycle smoke; explicit target-specific installer path, existing x64 runtime identity | Not run by this unit; physical Stop/provider acceptance separate |
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
