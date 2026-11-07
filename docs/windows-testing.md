# Testing Gentle Dot on Windows

Thanks for testing! This guide walks you through building Gentle Dot from source on Windows 10 or Windows 11 (x86_64) and checking that it works. Building and running takes about 30 minutes, most of it the first build.

This checklist is **source-only**: it runs the app you just built, not an installed one. Self-contained NSIS/MSI packaging is available (`pnpm package:windows`, see [docs/install.md](install.md)), but builds, payload checks and installed-app acceptance must be repeated for the current source. Earlier Windows measurements below describe older revisions, not validation of this integration. Installing is deliberately **not** a step here — build and run instead. Expected results are requirements to check, not recorded passes. Where a step is pending, write **N/A** and note what happened.

## Before you start

1. Check your Windows version. In PowerShell, run:

   ```powershell
   winver
   [System.Environment]::OSVersion.Version
   ```

   Write down the result for the report (for example `Windows 11 24H2, 26100.1`). Windows 10 and 11, x86_64, are the supported targets; aarch64 comes later.
2. Check your toolchain. In PowerShell, run:

   ```powershell
   echo $env:PROCESSOR_ARCHITECTURE
   node --version
   pnpm --version
   rustc --version
   go version
   ```

   You need Windows 10 or 11 x86_64; Node.js 24; pnpm 11.5.0 (`corepack enable` picks up the version `package.json` pins); Rust stable with the MSVC toolchain; the Visual Studio Build Tools with the "Desktop development with C++" workload; WebView2 (Windows 11 ships it, Windows 10 may need the Evergreen Runtime); and Go 1.25.10 or newer, because `pnpm install` builds gentle-pi's Gentle AI binary from source on Windows. Write down each version.
3. Have an API key ready for one model provider (for example OpenAI, OpenRouter, or Anthropic). You need it in step 8.
4. Get the files: clone the repository or unpack the archive you were sent, then open **PowerShell** in that folder.

## Build from source

From the repository root:

```sh
pnpm install
pnpm --filter @gentle-dot/desktop build
```

The second command is a release build. With `apps/desktop/src-tauri/tauri.windows.conf.json`, the bundler also writes two installers under `apps/desktop/src-tauri/target/release/bundle/`: an NSIS per-user installer (`Gentle Dot_<version>_x64-setup.exe`) and an MSI per-machine installer (`Gentle Dot_<version>_x64_en-US.msi`). This plain build does **not** put the app's runtime in them; `pnpm package:windows` is what stages the runtime and writes the self-contained pair (see [docs/install.md](install.md)). This checklist runs the app directly, so do not install either artifact here:

```sh
apps/desktop/src-tauri/target/release/gentle-dot.exe
```

A **debug** build is not a substitute. One produced by `tauri dev` loads the UI from the Vite dev server named by `devUrl` and embeds no UI assets, so running `apps/desktop/src-tauri/target/debug/gentle-dot.exe` on its own opens a **blank white window** (measured). To work on the app, run `pnpm --filter @gentle-dot/desktop dev`, which starts that server first.

If the build fails inside a dependency's build script with a silent `cl.exe` error and no other output, see the troubleshooting table.

## Running the JavaScript tests

The daemon suite (`npx vitest run packages/daemon/test`, or `pnpm test` for everything) runs on a plain Windows install. Four of its tests need one thing a Windows user does not have by default: the privilege to create a **file** symlink. A plain install refuses it with `EPERM`, so instead of failing those four tests **skip**, and each prints one line on raw stderr naming what it skipped and the way out:

The diagnostic below omits only its private task-record reference; local task
records are not distributed.

```text
fixture-capabilities: skipping <the fixture>; this host refuses to create a file symlink (the attempt failed with EPERM), and a file symlink has no unprivileged substitute here (a junction is directory-only and a hardlink is not a link); turn on Windows Developer Mode, or run the suite from an elevated terminal, to run it.
```

Turn on **Developer Mode** (Settings → System → For developers) or run the suite from an **elevated** terminal, and the four run like any other test. Directory links are junctions, need no privilege, and run either way. The assertions that need no privilege keep running on a host without it — including the hardlink and the plain path spellings in the same file — and no fixture is ever quietly replaced by something weaker.

## Windows console compatibility

The app's Windows daemon spawn requests `CREATE_NO_WINDOW`; the RPC supervisor
requests Node's `windowsHide` without changing its pipes, arguments or ownership.
The normal engine still runs through Gentle Shell, including its native adapters,
policy, signal forwarding and exit handling. The adaptation does not detach any
additional child.

The declared gentle-pi **4.6.0** launcher omits `windowsHide` at five child
creation sites. `scripts/package/windows-console.mjs` adds only that
Windows-conditional option in the **staged** package.
Normal Windows staging applies it after dependency installation; normal
`package-windows.mjs --skip-stage` applies it to the existing runtime before building.
Neither path edits the host dependency. The helper checks package name/version,
regular source leaves, the whole launcher hash and consumed launch-helper hashes
before writing, and is idempotent. The original launcher SHA-256 is
`f4e246c2da503ec84820b2dce067cc4a569b13809e5b2b9fa4001bbd677cc937`.
Staging also awaits read-only local-package admission before output replacement
or downloads. Unknown bytes or another package version stop packaging; inspect
the declared source rather than weakening the allowlist. Skip-stage does not refresh `MANIFEST.json` or repair
missing native RDD assets. Console suppression is not an RDD recovery claim.

Nonwriting checks: `node --experimental-strip-types --test --test-reporter=tap scripts/package/test/windows-console.node-test.mjs`.
They read the normal project's installed SDK and use in-memory spawn recording;
the Rust check is structural, not compilation or native GUI proof. After a future
owner build, verify no console appears and the existing LLM still responds. App
Quit/reuse/kill-tree behavior remains unchanged and needs independent Windows
verification; do not close a live owner console to reproduce the old failure.

## MCP diagnostic commands retired (source-only)

Ordinary `/mcp` and SDK subcommands still forward to the existing engine, without
an added owned diagnostic toast. `/discord-debug`, `/discord-trace`,
`/discord-status` and `/mcp-inventory` now receive the normal unsupported response,
including when supplied with arguments or attachments. Do not use them as manual
acceptance probes. Discord trace and private startup capture are retired; existing
files are left untouched. The optional Settings debug preference and private RDD capture are also retired from source.

[Finite internal connection hints](windows-mcp-indicative-diagnostics.md), ordinary
errors, credentials and approval/lifecycle handling remain. Source Node checks do
not establish native Windows acceptance, a root cause or Discord/Context7 recovery.
The owner builds; verify ordinary MCP and chat behavior only in the agreed environment.

### MCP request cancellation (source-only)

Cancelling a proxy request now leaves its shared upstream connection open. Previously,
handling the SDK's request-local `McpAbortError` closed that connection and could fail
other in-flight requests with `McpConnectionClosedError`. Genuine upstream closure
still fails pending requests and reconnects on the next ordinary request. Cancellation
responses and safe diagnostic categories are unchanged; warnings are not suppressed.

The regression uses the installed SDK's public in-memory transport, without network,
credentials or live SDK sessions. It proves this source defect, not that cancellation
caused the owner's Discord/Context7 failures or that those servers now work on Windows.

## Read-only RDD mode diagnostic (source-only)

In the normal managed app, ask the primary agent: **“Call `dot_review_status` with
`{}` and report the result.”** It is an owner-requested tool, not a slash command,
startup scan or automatic query. Child/reviewer agents do not receive it; normal SDK
tool allowlists, exclusions and explicit `defaultTools` remain authoritative.
Registration is inactive (`defaultActive: false`). At session startup, automatic
activation requires unset `defaultTools`, active read/edit/write plus Bash or
PowerShell, and a permitted direct tool in the SDK's filtered registry. Existing
active tools are preserved; empty, read-only and unknown loadouts are not expanded.
Explicitly naming the tool remains subject to the SDK's normal restrictions.

The tool calls the public native client's fixed `reviewMode` status operation with
the current tool cwd and operation signal, using its default resolver and inherited
managed-engine environment. The client bounds read-only execution to 30 seconds.
No operation, folder, executable, arguments or environment can be supplied.
Results use ordinary tool text/details, not the suppressed informational UI channel.
Only validated mode enums, fixed failure categories and optional
[indicative error hints](windows-rdd-indicative-diagnostics.md) are returned.
Raw messages, stderr, audit data, revisions, paths and extra native fields are omitted.

`on` means mode on, **not review approval or delivery authority**. This tool cannot
change mode, start/assess/recover a review or fix MCPs. The owner reported a real
managed-app status attempt ending in `non-zero`; this establishes neither the mode
nor its native failure cause. The additional hints have synthetic source evidence
only. Windows recovery and a fixed unavailable-status warning remain unproved.

## PowerShell process operations (source-only)

The owned process adapter can be reviewed and tested independently. The process-only
slice neither activates it nor copies it into installed resources; registration and
packaging belong to the following integration slice. Its tests use in-memory process
doubles only, with no real commands, SDK sessions or isolated environments:

```sh
node --experimental-strip-types --test --test-reporter=tap packages/daemon/test/powershell-operations.node-test.mjs
```

This test split is mechanical reorganization, not new behavior or a new RED/GREEN
cycle. The earlier module-absent RED1 establishes absent native capability, not
26 separately observed behavioral REDs. Native Windows acceptance remains pending.

Tree-termination failure remains visible even if fallback kill emits an error or
throws. Timed-out terminators drain late errors until close; callbacks do not escape.

## Native Windows PowerShell (no-confirm policy is source-only)

On Windows, the **primary agent** substitutes system Windows PowerShell for Bash
only when `defaultTools` is unset, Bash is active and PowerShell is permitted by the
SDK's filtered tool registry. This is a distinct `powershell` tool: commands are
PowerShell syntax, not Bash aliases or silently translated scripts.
macOS/Linux keep their existing tools. Child agents do not register this executor.
Explicit `defaultTools`, tool allowlists/exclusions and loadouts without Bash are
respected; this does not grant a restricted reviewer additional tools.

The owner accepted positive PowerShell execution in the installed managed app,
including Word/text and Chrome/Google actions (S22). That acceptance predates the
new no-confirm policy (S19): its delivery and installed behavior remain unverified.
SDK adapter tests do not prove all managed-app activation conditions or cancellation
flows. Validation must use the normal existing environment, without creating a
profile or changing policy/configuration just to make the check pass.

| Behavior | Contract |
|---|---|
| Executable | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (normally `C:\Windows`); no `pwsh`, Git Bash, PATH search or installation |
| Invocation | Hidden console, no profile, noninteractive, UTF-16LE encoded argv; no ExecutionPolicy switch |
| Command | Literal Unicode/multiline user text after a fixed UTF-8 console-output initialization; no shell interpolation or syntax translation |
| Context | Current SDK tool cwd and the exact environment supplied by the SDK, unchanged; no copied homes/profiles, environment overrides or `PI_*` injection by this extension |
| Results | Streams stdout/stderr through the pinned SDK definition; preserves process exit status, spawn failures and SDK output/truncation behavior |
| Stop/timeout | Timeout is in seconds. Pre-abort starts nothing; cancellation targets only this operation's live PID/tree using system `taskkill.exe /PID … /T /F`. Termination failure is reported, not success |
| Failure | A hidden fail-closed definition shadows the SDK's default PowerShell backend if initialization fails; normal Bash startup remains available |
| Packaging | The guard and all four owned imported siblings are copied together; dependency pins, lock and manifest rules are unchanged |

The adapter uses the pinned **Pi SDK 1.5.0 public factory with explicit custom
operations**, never its default backend (which prefers `pwsh` and bypasses policy).
PowerShell has direct exposure: when inactive it is not callable from codemode.
Both normal direct calls and codemode's `ctx.executeTool` dispatch enter the SDK's
`tool_call` hook before execution. Registration does not waive the restrictions below.
After shell exit, pipes drain until close, with a 250 ms bound for inherited pipes;
a stuck tree terminator is bounded to 1 s and reported as a termination failure.
This is process ownership and best-effort termination, **not an OS sandbox**.

Focused nonwriting adapter checks (no shell execution or SDK sessions):

```sh
node --experimental-strip-types --test --test-reporter=tap packages/daemon/test/powershell-operations.node-test.mjs packages/daemon/test/windows-powershell.node-test.mjs
```

### Primary policy and safety restrictions

Routine **primary `powershell` tool calls no longer request per-command confirmation**
(S19). This is the default policy, not cached approval, a YOLO toggle or a new mode.
Private-file and connector-management command blocks still run first and cannot be
overridden. The guard rejects pre-aborted PowerShell calls even without a UI;
execution-time cancellation remains the responsibility of the unchanged SDK/tool
and owned process operations. Missing or throwing confirmation UI is not consulted
for an otherwise permitted primary PowerShell call. This does not activate an
inactive tool or bypass the restricted registry or fail-closed executor.

The legacy exact-command preview helper and Bridge handling remain compatible;
other tools' approval dialogs and SDK guards are unchanged.

Child agents loading Dot's child guard are denied all `powershell` calls without
asking, including deletion aliases and Git destructive commands. PowerShell is
**not activated in child profiles**. Existing Bash and connector policy is unchanged;
private-file command matching remains best effort, not an OS sandbox.

These source units do not fix RDD, install anything, or establish native Windows
execution proof. The focused public-hook regression uses in-memory doubles, never
real commands:

```sh
node --experimental-strip-types --test --test-reporter=tap packages/daemon/test/powershell-approval.node-test.mjs
```

The public Bridge regression uses in-memory service adapters and a recording client;
it does not prove the rendered Windows UI. Remaining owner validation in the normal
existing Windows environment includes:

- New primary no-confirm behavior with literal Unicode/multiline commands; private-file,
  child/reviewer and pre-abort restrictions must still prevent execution.
- Real stdout/stderr, nonzero exit, cwd/environment inheritance, timeout and own-tree
  cancellation without a console appearing or unrelated applications stopping.
- Normal LLM/session startup, non-Windows behavior and installed resource copies.

Full worktree SDK typing, all cancellation flows, Windows 10 coverage and installed
acceptance of the new no-confirm policy remain unverified. Earlier positive owner
acceptance is not proof of those outcomes. Do not create an isolated environment/profile
or change execution policy to perform these checks. WXdiag/RDD diagnosis is a separate unit.

## The checklist

Do each step in order and note **Pass**, **Fail**, **Partial**, or **N/A** for each one. If something fails, keep going; later steps often still work.

### 1. Build

`pnpm install` then `pnpm --filter @gentle-dot/desktop build`.

**Expected:** `pnpm install` finishes, including gentle-pi's postinstall (which needs Go). The build finishes and produces `apps/desktop/src-tauri/target/release/gentle-dot.exe`.

### 2. First launch

Run `apps/desktop/src-tauri/target/release/gentle-dot.exe`.

**Expected:**
- Within a few seconds, a black circle with a glowing pink rose appears at the right edge of the screen, vertically centered.
- The app provisions `%USERPROFILE%\.gentle-dot`, with `agent\`, `sessions\`, `identity.md`, and `token` (measured on Windows 11).
- The app spawns its own daemon. Open a browser at `http://127.0.0.1:4317/`: the page answers HTTP 200 with the title "Gentle Dot" (measured on Windows 11).

The panel is opaque unless the backdrop gate fires. On Windows 11 (build ≥ 22000) with transparency effects on, a local session, and DWM composition on, the app asks for `Mica`, and only then should a blur appear behind the panel. Tauri gives no readback, so this is a **tester's visual check**: if the panel is opaque on a machine that meets all four conditions, note it — the request is gated but not proven.

### 3. The rose stays on top

Open a few other windows and click on them.

**Expected:** the rose stays above the other windows.

### 4. Click opens the panel

Click the rose (without dragging).

**Expected:** a 420 × 640 dark panel opens next to the rose, and the cursor is in the message box. Press `Esc`: the panel hides. Click the rose again: it opens again.

### 5. Drag and snap

Drag the rose to the middle of the screen and let go.

**Expected:** within half a second, the rose moves to the nearest screen edge.

### 6. Tray icon and menu

**Expected:**
- A small rose appears in the notification area. Clicking it opens a menu: Open, Open in browser, Restart assistant, Launch at login, Quit.
- **Open** shows the panel. **Open in browser** opens the same chat in your browser.

If the webview's developer console reports `tray icon is missing`, note your build; an early build had an ordering bug that is fixed.

### 7. Toggle shortcut

The Windows default global shortcut is `Ctrl+Shift+Space` (`Alt+Space` on macOS and Linux; on Windows `Alt+Space` opens the window menu, so a global hotkey on it would take that away).

**Expected** (measured on Windows 11): pressing `Ctrl+Shift+Space` toggles the panel — it opens when hidden and hides when open, from any app (including with the panel focused). In the panel's Settings, change the shortcut and confirm the new combination toggles the panel; **Reset to default** returns to `Ctrl+Shift+Space` (measured: `Ctrl+Alt+Space` toggled, and the reset came back to `Ctrl+Shift+Space`). Pressing `Alt+Space` opens the Windows window menu, not the panel (measured).

### 8. Sign in with an API key

In the panel, type `/login` and press Enter (or use the **Accounts** icon in the header). Choose **API key**, pick your provider, paste the key, and confirm.

**Expected:** the provider shows as connected. The key never appears again in the chat.

### 9. Chat

Ask "What can you do?".

**Expected:** the answer streams in word by word, and the rose glows with a moving light while the assistant works.

### 10. Profiles

Open **Profiles** (the sliders icon in the header). Create a profile, rename it, switch to it, and switch back.

**Expected:** each change shows right away, and no error appears.

### 11. Connectors

Open **Connectors** in the header.

**Expected:** it lists Gmail, Slack, Discord, Notion, Linear, and Atlassian, plus "Add another connector". Open two or three guides and check that they read well. **Connecting one that needs a secret or an approval works over the app's private channel (W7); a connector whose secret is missing fails closed rather than falling back to a file.**

### 12. Connector secrets and approvals

The app and the daemon talk over a private channel the app creates **before** it spawns the daemon: a named pipe whose name the daemon receives in `GENTLE_DOT_CHANNEL_PIPE`. The credential is the connection itself — the app accepts it only when the connecting process is the daemon it just spawned — so a daemon the app did not start is refused instead of answered.

**Expected:** a connector that needs a secret asks for it in the app, and the value reaches the daemon over the channel and is kept in the app's store (step 14). An action that needs approval opens a native dialog naming the connector, the action and the preview; **Decline** is the default, an unanswered dialog is refused after 120 s, and a decline leaves nothing running. A connector whose secret is missing fails closed with "Open the Gentle Dot app to use this connector." Quit the app while a chat is running: the daemon it spawned stops with it, and relaunching starts a new one.

### 13. Quit and relaunch

Choose **Quit** in the tray menu, then run the app again.

**Expected** (Quit is measured on Windows 11): the rose and the tray icon disappear on Quit, and the process exits with code 0, taking its daemon with it. On relaunch, the rose and the tray icon appear again.

### 14. The Windows secret store (optional, developer check)

From `apps/desktop/src-tauri`, run:

```sh
cargo test --lib
```

**Expected:** the suite succeeds, with unavailable host capabilities reported explicitly. Earlier Windows 11 measurements observed 399 passed / 0 failed / 4 ignored on an older revision; repeat for this source. Current connector entries are DPAPI-protected per-entry files under `%LOCALAPPDATA%\dev.gentleman.gentle-dot.connectors\`; legacy `%LOCALAPPDATA%\Gentle Dot\secrets.dat` is retained read-only during validated migration. You do not need to create a secret for this check.

### 15. Voice — owner acceptance required

Source now connects Windows WASAPI capture to the existing local Parakeet model and uses system/browser speech for replies. This is not a recorded Windows pass. The owner builds and installs; do not redownload an already-installed model or replace the existing daemon environment.

With microphone access permitted by Windows, record a short Spanish message, finish dictation, and confirm the expected transcript reaches chat. A completed reply to that spoken turn should be audible when unmuted; ordinary typed turns remain silent. Verify mute cancels speech immediately and persists after reopening the panel; verify Stop, cancellation and a new recording retire pending playback. Denied microphone access or device loss must produce an error, not apparent successful capture.

Record actual results and failures separately. See [capture contract and checklist](windows-voice-capture.md) and [spoken-output lifecycle](windows-voice-output.md). Compilation, privacy/device checks, real transcription and audible Windows output have not been verified in this source environment.

### 16. Computer control — not yet on Windows

Computer control is macOS-only today (W13).

**Expected today:** the feature is unavailable. Write **N/A**.

### 17. Launch at login

Autostart uses `tauri-plugin-autostart`, whose Windows backend registers the app as **`Gentle Dot`** under the Windows `Run` key. It writes `HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`; when the app runs with administrator rights it writes `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` instead, and that entry starts it for every user.

**Expected:**
1. In the tray menu, turn **Launch at login** on.
2. Open `regedit`, press **F5** to refresh, and look in **both** `HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` and `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`: a value named `Gentle Dot` points at `gentle-dot.exe` (measured on Windows 11, in `HKLM` because that run was elevated; `regedit` needs the refresh to show it).
3. Quit Gentle Dot, sign out and back in (or restart), and confirm it launches again.
4. Turn **Launch at login** off and confirm the value is gone from the key that held it (measured on Windows 11: the `HKLM` value disappeared as soon as the item was turned off).

## Troubleshooting

| Symptom | Try |
|---|---|
| `pnpm install` fails in gentle-pi's postinstall asking for Go 1.25.10 or newer | Install Go 1.25.10 or newer and run `pnpm install` again. |
| A cold build fails inside a dependency's build script with `cl.exe` exit code 2 and no other output | The shell is missing the Windows SDK include/library paths (`stddef.h`). Run the build from a `.bat` that sets `INCLUDE` and `LIB` explicitly; that is the workaround that worked here. A Developer Command Prompt through `vcvars64.bat` does not run well from git-bash. |
| `biome check` reports around 178 errors, one per line, after switching branches | CRLF left over in an existing checkout. Renormalize with `git add --renormalize .`, then confirm `git diff --stat` stays empty. |
| The app opens but no webview loads | You are running a **debug** build. Debug builds load the UI from the Vite dev server, which is not running (measured on Windows 11). Build a release with `pnpm --filter @gentle-dot/desktop build`, or start the UI dev server first. |
| A connector that needs a secret or an approval never runs | Expected: the daemon and the app are not connected. The app answers secret requests and approvals over the private channel it creates before it spawns the daemon (W7); a daemon started outside the app has no channel and refuses both. |
| `Ctrl+Shift+Space` does not toggle the panel | Check that another app does not hold that combination; pick another shortcut in the panel's Settings. `Alt+Space` opening the Windows window menu is expected: it is Windows' window-menu key, not this app's default. |
| The webview console reports `tray icon is missing` | Note your build. An early build had an ordering bug that is fixed. |
| `%USERPROFILE%\.gentle-dot\daemon.log` says the connector cannot get its secrets | Expected until W7 lands. |

## Report template

Copy this into your message and fill it in.

```text
## Gentle Dot Windows test report

Windows version and build:    (for example Windows 11 24H2, 26100.1)
Architecture:                 (output of: echo $env:PROCESSOR_ARCHITECTURE)
Node / pnpm:                  (output of: node --version; pnpm --version)
Rust / Go:                    (output of: rustc --version; go version)
WebView2:                     (Windows 11 built-in, or the Evergreen Runtime version)
Source version:               (output of: git rev-parse --short HEAD, or the archive name)
Install method:               (source; no package path yet)
Build command:                (pnpm --filter @gentle-dot/desktop build)

| # | Step                          | Result (Pass / Fail / Partial / N/A) | Notes |
|---|-------------------------------|--------------------------------------|-------|
| 1 | Build                         |                                      |       |
| 2 | First launch                  |                                      |       |
| 3 | Rose stays on top             |                                      |       |
| 4 | Click opens the panel         |                                      |       |
| 5 | Drag and snap                 |                                      |       |
| 6 | Tray icon and menu            |                                      |       |
| 7 | Toggle shortcut               |                                      | Windows default Ctrl+Shift+Space |
| 8 | Sign in with an API key       |                                      |       |
| 9 | Chat                          |                                      |       |
|10 | Profiles                      |                                      |       |
|11 | Connectors (list and guides)  |                                      |       |
|12 | Secrets and approvals (not yet)|                                     | W7    |
|13 | Quit and relaunch             |                                      |       |
|14 | Secret store tests (optional) |                                      |       |
|15 | Voice (not yet)               |                                      | W12   |
|16 | Computer control (not yet)    |                                      | W13   |
|17 | Launch at login               |                                      | `Gentle Dot` in the Run key |

Screenshots: (the rose on the desktop, the open panel, the tray icon)

Logs: (see below)
```

### Logs to attach

- The terminal output of `gentle-dot.exe`, if you started it from a terminal.
- The assistant log, with the access key removed. The key is a secret: never share `%USERPROFILE%\.gentle-dot\token`. In PowerShell, this copies the log and masks the key:

  ```powershell
  $token = (Get-Content "$env:USERPROFILE\.gentle-dot\token" -Raw).Trim()
  (Get-Content "$env:USERPROFILE\.gentle-dot\daemon.log" -Raw) -replace [regex]::Escape($token), '<token>' |
    Set-Content "$env:TEMP\gentle-dot-daemon.log"
  ```

  Then attach `%TEMP%\gentle-dot-daemon.log`. Look through it before sending it, and remove anything else you consider private.
