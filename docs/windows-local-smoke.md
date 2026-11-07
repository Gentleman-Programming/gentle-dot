# Windows development smoke and graceful quit

**Source implementation, not native acceptance.** MSVC/SDK installation was cancelled
(native 1602). Compilation, Rust tests, DPAPI admission, WebView startup and shutdown
have NOT been run. Do not launch until the parent verifies the prerequisites below.
No installer hooks are added here.

## Contract

- Opt in with Cargo feature `windows-smoke-test` **and** debug assertions on Windows.
  Without the feature, smoke variables are not read and the normal store factory
  still resolves Windows KnownFolder LocalAppData. HOME/LOCALAPPDATA redirection
  does **not** redirect that API. A Windows release with the feature is a compile error;
  ordinary releases retain their normal identity, environment and store behavior.
- Four explicit variables are required: `GENTLE_DOT_SMOKE_ROOT`,
  `GENTLE_DOT_SMOKE_RUNTIME_DIR`, `GENTLE_DOT_SMOKE_PORT`,
  `GENTLE_DOT_SMOKE_ENGRAM_PORT`. There is no missing/invalid-root fallback.
- Both paths must be absolute ordinary drive paths (no UNC/device paths, ADS,
  dot segments, trailing spaces/dots or Windows device names). Root must be NEW;
  its parent must exist on local NTFS. Existing roots, even previously owned smoke
  roots, are refused. A second launch forwards before creating directories, so
  `--toggle`/`--quit` can use the running session's existing root.
- Runtime is an explicit, previously prepared read-only code/artifact tree outside
  the fresh root, with the existing packaged-runtime layout, including
  `bin/private-storage.exe`, `bin/engram.exe`, `node/bin/node.exe`, `daemon/cli.mjs`,
  native channel/stop modules, Gentle Pi and its already-verified engine, and `ui/`.
  This mode does not prepare, rebuild, download or authenticate those artifacts.
- Ports must differ, be integers 1024–65535, and not 4317, 5173, 7437 or 7438.
  Example: daemon **14317**, private Engram **17438**. Occupied ports fail admission;
  they are checked again immediately before native daemon launch.

## State boundaries

Under the fresh root only:

| Path | Purpose |
| --- | --- |
| `data/config.json`, `data/desktop.json`, `data/token`, `data/daemon.*` | Dot config, placement, authentication and owned lifecycle |
| `data/agent`, `data/workspace` | Engine configuration and working directory |
| `data/home` | Engine HOME, AppData, temporary/cache state and private `.engram` |
| `profile` | Daemon HOME/USERPROFILE, connector-import home and private git-config path |
| `tmp` | Daemon TEMP/TMP/TMPDIR |
| `tauri` | Explicit Tauri app-directory root, including voice-model paths |
| `webview` | Explicit WebView2 data_directory for Dot, panel **and glow** |
| `secrets` | Real current-user DPAPI ciphertext; never the production namespace |

Directory admission reuses native DPAPI NTFS/reparse/DACL checks and pins ancestry;
no ACL repair or adoption of caller-owned directories. Internal hashed namespace
folders/lock files are also created by that validator. Failure may leave a partial
fresh fixture; choose another root rather than repairing/reusing it automatically.
The production `connector_store()` does not consume smoke configuration.

Before any service/store/webview starts, isolation must succeed. Context identity
becomes `dev.gentleman.gentle-dot.windows-smoke.r<SHA256>` before the single-instance
plugin initializes. The digest binds the validated canonical root's lossless UTF-16,
not one global smoke identity. Read-only native ancestry validation rejects junctions
and pins the existing root or its parent during canonicalization; a missing root is
not created for identity resolution. Same-root launches address the same instance;
different roots cannot forward to each other or to normal `dev.gentleman.gentle-dot`.
Concurrent smoke roots need distinct free port pairs. Autostart plugin setup,
HKCU Run queries and toggles are disabled in smoke builds.

The native daemon environment starts empty. The only caller variable read into it
is `SystemRoot`. Generated system variables are WINDIR, COMSPEC, PATHEXT and PATH
(runtime bin/Node plus System32/Windows only). Generated profile variables are
HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP, TMP, TMPDIR and XDG config/data/cache/state.
Generated git variables are GIT_CONFIG_GLOBAL (private profile) and GIT_CONFIG_NOSYSTEM=1.
Generated Dot variables select the private data/agent/workspace, loopback host,
explicit port, runtime/UI, development origins, private Engram/port and disabled
subagents; ENGRAM_BIN selects the staged executable. No inherited provider tokens,
proxy settings, ENGRAM_URL, NODE_OPTIONS, NODE_PATH or alternate agent/runtime
commands are passed. The existing engine isolation code derives its private HOME
and Engram endpoint from these values, rather than the user's global memory.

This is namespace isolation, not an OS sandbox. Same-user processes and staged
code are trusted. Port availability checks have a check/start race; do not share
these test ports with other services. No provider, microphone, computer action or
connector import is authorized by these instructions.

## Build and caller example (PowerShell, repository root)

Prerequisites: completed MSVC/SDK; existing trusted voice/native dependencies;
already-built `packages/ui/dist/app`; an independently verified staged runtime.
The commands below are a future caller contract, **not commands run in this unit**.
Do not use `cargo run` with the caller's unrestricted environment.

```powershell
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --features windows-smoke-test,tauri/custom-protocol
$repo = (Get-Location).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('gentle-dot-smoke-' + [guid]::NewGuid())
# This tree must already have passed runtime/provenance checks; do not build providers here.
$runtime = Join-Path $repo 'build\windows\runtime'
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = Join-Path $repo 'apps\desktop\src-tauri\target\debug\gentle-dot.exe'
$start.WorkingDirectory = $repo
$start.UseShellExecute = $false
$start.EnvironmentVariables.Clear()
$start.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
$start.EnvironmentVariables['GENTLE_DOT_SMOKE_ROOT'] = $root
$start.EnvironmentVariables['GENTLE_DOT_SMOKE_RUNTIME_DIR'] = $runtime
$start.EnvironmentVariables['GENTLE_DOT_SMOKE_PORT'] = '14317'
$start.EnvironmentVariables['GENTLE_DOT_SMOKE_ENGRAM_PORT'] = '17438'
$process = [Diagnostics.Process]::Start($start)
```

This builds a **debug** executable with embedded UI, not a development-server UI.
No persistent environment/registry changes. For a second launch, reuse the same
`$start` and set `$start.Arguments = '--toggle'` or `'--quit'` before Start.
For normal release compilation omit the smoke feature entirely:
`cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --release --features tauri/custom-protocol`.
Smoke environment variables then have no effect on profile/store selection.

## Windows installer-facing CLI

`gentle-dot.exe --quit` sends a narrow shutdown request to an existing instance via
Tauri single-instance dispatch. `--quit` wins over `--toggle`; it takes no PID/name
or target argument. It calls the same `app.exit(0)` path as tray Quit, preserving
managed owned-daemon shutdown and foreign-daemon refusal. No blanket taskkill.
With no existing instance it exits before config/store, daemon, voice or webviews.
Ordinary launch still shows the panel in an existing instance; `--toggle` still
toggles it and opens it on first launch. Other OS argument behavior is unchanged.

The requesting process's exit is **not confirmation that shutdown completed**.
A future installer must await the actual old app's exit with a bounded timeout,
preserve data, and refuse replacement on uncertainty; no force-kill fallback.
The smoke binary addresses smoke only, never the installed production instance.

## Parent verification still required

Run focused Rust tests for `windows_smoke::tests`, the platform launch tests and
native environment encoding in both ordinary and smoke debug configurations.
The three `secure_store::windows::tests::smoke_*` admission tests are explicitly
ignored native fixtures (one requires symlink permission); run them deliberately
in a fresh system-temp context. Retain the existing native owned/foreign-daemon
lifecycle tests. Verify default/release ignores smoke configuration and that a
release+smoke build is rejected, without launching the normal user profile.

Native proof must then observe fresh-root startup, all three WebView paths,
DPAPI namespace admission, private config/engine/memory paths, occupied-port refusal,
second-instance toggle/quit, and no-instance quit with zero service startup. No
such native evidence is claimed here. The inherited duplicate Windows `stop_child`
definitions in `src/daemon.rs` are outside this unit's edit surfaces and must be
resolved separately before compiling. Do not mistake manifest parsing for compilation.
