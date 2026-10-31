# Testing Gentle Dot on Windows

Thanks for testing! This guide walks you through building Gentle Dot from source on Windows 10 or Windows 11 (x86_64) and checking that it works. Building and running takes about 30 minutes, most of it the first build.

This checklist is **source-only**: it runs the app you just built, not an installed one. A self-contained installer now exists (`pnpm package:windows`, see [docs/install.md](install.md)), its payload is verified file by file, and the NSIS one has been run silently on Windows 11 and read back — its installed `runtime\` is byte-identical to the staged one and its engine starts with no Go installed. An installed copy **has** been launched, and it does not get past `starting` (W30 in `odd/tasks/windows-port.md`: installed from the NSIS `.exe` twice on Windows 11, and the panel never reached `ready`), so installing it is deliberately **not** a step here — build and run instead, and do not read the installer as a proven path yet: the release-only start regression is open. Several features are not there yet, and they are marked **not yet on Windows** instead of being presented as if they work. The expected results below are what the app should do; a few checks have already been measured on Windows 11 and say so. Where a step is pending, write **N/A** and note what happened.

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

```text
fixture-capabilities: skipping <the fixture>; this host refuses to create a file symlink (the attempt failed with EPERM), and a file symlink has no unprivileged substitute here (a junction is directory-only and a hardlink is not a link); turn on Windows Developer Mode, or run the suite from an elevated terminal, to run it (see odd/tasks/windows-port.md).
```

Turn on **Developer Mode** (Settings → System → For developers) or run the suite from an **elevated** terminal, and the four run like any other test. Directory links are junctions, need no privilege, and run either way. The assertions that need no privilege keep running on a host without it — including the hardlink and the plain path spellings in the same file — and no fixture is ever quietly replaced by something weaker.

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

The app and the daemon talk over a private channel the app creates **before** it spawns the daemon: a connected pipe pair whose far end the daemon receives as fd 3 through the launch's explicit handle-inheritance list, the launch owned by a stop record written before the child executes. The connection is the credential — a daemon the app did not start is refused instead of answered.

**Expected:** a connector that needs a secret asks for it in the app, and the value reaches the daemon over the channel and is kept in the app's store (step 14). An action that needs approval opens a native dialog naming the connector, the action and the preview; **Decline** is the default, an unanswered dialog is refused after 120 s, and a decline leaves nothing running. A connector whose secret is missing fails closed with "Open the Gentle Dot app to use this connector." Quit the app while a chat is running: the daemon it spawned stops with it, and relaunching starts a new one.

### 13. Quit and relaunch

Choose **Quit** in the tray menu, then run the app again.

**Expected** (Quit is measured on Windows 11): the rose and the tray icon disappear on Quit, and the process exits with code 0, taking its daemon with it. On relaunch, the rose and the tray icon appear again.

### 14. The Windows secret store (optional, developer check)

From `apps/desktop/src-tauri`, run:

```sh
cargo test --lib
```

**Expected** (measured on Windows 11): the suite passes, 399 passed / 0 failed / 4 ignored. `%LOCALAPPDATA%\Gentle Dot\secrets.dat` is where a connector secret would be written; you do not need to create one for this check.

### 15. Voice — not yet on Windows

Voice capture is W12 and not done.

**Expected today:** the mic button reports voice as unavailable. Write **N/A**.

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
