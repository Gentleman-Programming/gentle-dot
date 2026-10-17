# Installing Gentle Dot

Gentle Dot ships as a self-contained app: it carries its own Node runtime, the assistant engine, and a fallback Engram. Nothing else needs to be installed first.

## macOS

Requirements: a Mac with Apple Silicon (M1 or later) and macOS 12.3 or later.

### Install

1. Open `Gentle Dot_<version>_aarch64.dmg`.
2. Drag **Gentle Dot** onto the **Applications** folder in the window that opens.
3. Eject the disk image.

### First open

The app is not notarized by Apple, so macOS blocks the first open. Approve it once:

- **macOS 15 (Sequoia) and later:**
  1. Open Gentle Dot from Applications. macOS says it cannot verify the app; click **Done**.
  2. Open **System Settings → Privacy & Security**, scroll to **Security**, and click **Open Anyway** next to the Gentle Dot message.
  3. Confirm with **Open Anyway** and your password.
- **macOS 12 to 14:** Control-click Gentle Dot in Applications, choose **Open**, then **Open** again.

Alternative from Terminal (any version), which removes the download quarantine from the app:

```sh
xattr -dr com.apple.quarantine "/Applications/Gentle Dot.app"
```

Only do this for a copy you got from someone you trust.

### Permissions for computer control

Computer control needs two macOS permissions. Open **Connectors → Computer** in Gentle Dot and click **Grant** for each, or add Gentle Dot by hand:

- **System Settings → Privacy & Security → Accessibility**: lets the assistant click and type.
- **System Settings → Privacy & Security → Screen Recording** (named **Screen & System Audio Recording** on macOS 15): lets the assistant take screenshots.

Restart Gentle Dot after granting Screen Recording.

macOS ties these grants to the app's signature. A DMG signed with a stable identity (see below) keeps them across updates. A build signed ad hoc (the default) gets a new signature on every build, so after an update the old entries stop working: remove Gentle Dot from both lists with the minus button and grant again.

### Where data lives

| What | Where |
|---|---|
| Settings, conversations, logs (`daemon.log`), the engine's own files | `~/.gentle-dot/` |
| Memory (Engram, project `gentle-dot`) | `~/.engram/`, shared with any other Engram user on this Mac |
| Launch at login (when turned on) | a LaunchAgent in `~/Library/LaunchAgents/` |

The app itself never changes after install; everything it writes goes to the folders above.

### Uninstall

1. In the menu bar item, turn off **Launch at login**, then quit Gentle Dot.
2. Drag `/Applications/Gentle Dot.app` to the Trash.
3. Optional: remove `~/.gentle-dot/` to delete settings and conversations.
4. Optional: reset the permissions:

   ```sh
   tccutil reset Accessibility dev.gentleman.gentle-dot
   tccutil reset ScreenCapture dev.gentleman.gentle-dot
   ```

Leave `~/.engram/` in place unless you want to delete every Engram memory on this Mac, not only Gentle Dot's.

### Build the DMG from source

On an Apple Silicon Mac with Node 24, pnpm, Rust (`rustc` on `PATH`), and Xcode command line tools:

```sh
pnpm install
pnpm package:mac                 # signs ad hoc
pnpm package:mac --sign "<identity>"   # or GENTLE_DOT_SIGN_IDENTITY="<identity>"
pnpm package:mac --check         # also mounts the DMG and smoke-tests the copied app's daemon
```

To keep permissions across updates, sign every release with the same identity. `scripts/package/create-signing-identity.sh` creates a self-signed one named "Gentle Dot Local Signing" in the login keychain (no trust setting or password needed); its designated requirement pins the certificate (`certificate leaf = H"…"`), so it stays the same across builds. Keep that keychain entry: a new certificate means everyone grants the permissions once more. The first signed build asks once per signed file to use the key; choose **Always Allow** on the first prompt.

The command stages the runtime (`build/runtime/darwin-arm64`), signs the runtime's binaries, builds the release app, and writes the DMG to `apps/desktop/src-tauri/target/release/bundle/dmg/`. `--skip-stage` reuses a runtime staged earlier; `--check-dmg <dmg>` checks an existing DMG without building.

## Linux

Gentle Dot ships as a self-contained package: it carries its own Node.js, assistant engine, and Engram, so nothing else needs to be installed first. Pick the file for your system (`dpkg --print-architecture` or `uname -m` tells which):

| System | File | Install |
|---|---|---|
| Debian 12+, Ubuntu 24.04+ (x86_64) | `gentle-dot_<version>_amd64.deb` | `sudo apt install ./gentle-dot_<version>_amd64.deb` |
| Debian 12+, Ubuntu 24.04+ (ARM64) | `gentle-dot_<version>_arm64.deb` | `sudo apt install ./gentle-dot_<version>_arm64.deb` |
| Arch Linux, Omarchy (x86_64) | `gentle-dot-<version>-1-x86_64.pkg.tar.zst` | `sudo pacman -U gentle-dot-<version>-1-x86_64.pkg.tar.zst` |

Keep the `./` with `apt`. The package manager adds WebKitGTK and tray support. Then open **Gentle Dot** from your app menu, or run `gentle-dot`.

- The app is `/usr/bin/gentle-dot`; its bundled runtime is in `/usr/lib/Gentle Dot/runtime`. Your data lives in `~/.gentle-dot`.
- First launch needs the network once: the engine installs its companion packages (about 20 seconds).
- Computer control is macOS only.
- Connector secrets (tokens and sign-ins) are kept in your desktop keyring through the Secret Service (GNOME Keyring or KWallet), encrypted on disk, never in `~/.gentle-dot`. In Passwords and Keys (Seahorse) they show as "Gentle Dot connector: …" in the login keyring. Connector approvals and connector changes go through the app's own dialogs, which the assistant cannot answer.
- **Limit on Linux:** while the keyring is unlocked (usually your whole session), any program running as your user can read those items, including commands the assistant runs in its shell (for example `secret-tool lookup service dev.gentleman.gentle-dot.connectors account <id>`). The Secret Service has no way to restrict which program reads an item. On macOS the Keychain lets only the signed app read them without asking; on Linux, protect the secrets by keeping the keyring locked when you are away and by connecting only the accounts you want the assistant to use.
- Without a keyring (no Secret Service in the session, common on minimal window-manager setups), connectors that need a secret do not run, and nothing is written to disk instead. `~/.gentle-dot/daemon.log` then says `no Secret Service in this desktop session (…); install and unlock a keyring such as GNOME Keyring or KWallet`. Install `gnome-keyring` (or KWallet), make sure it runs and is unlocked in your session, then quit Gentle Dot from the tray and open it again. Gentle Dot checks its connectors with a key kept in the keyring when it starts, so a keyring that was missing then keeps those connectors locked, and the assistant says to restart, until the next start. If the keyring goes away while Gentle Dot runs, the assistant says the keyring is missing. A locked keyring shows its unlock prompt when Gentle Dot starts or a connector needs a secret; dismissing it, or no answer within two minutes, refuses (dismissed at start, connectors that need a secret stay locked until Gentle Dot restarts).
- GNOME: add a custom shortcut that runs `/usr/bin/gentle-dot --toggle` (see docs/linux-testing.md, step 9). Debian needs the AppIndicator extension for the tray icon.
- Hyprland / Omarchy: paste `scripts/linux/hyprland/gentle-dot.lua` (or `.conf`) into your Hyprland config; it already calls `/usr/bin/gentle-dot --toggle`.
- Remove: `sudo apt remove gentle-dot` or `sudo pacman -R gentle-dot` (your data in `~/.gentle-dot` stays).
- Build the packages (needs Docker): `pnpm package:linux --arch <arm64|amd64>` (amd64 also builds the Arch package); check them in clean containers with `pnpm package:linux:check --arch <arm64|amd64>`. `node scripts/package/linux-cargo-check.mjs --arch <arm64|amd64>` runs the desktop crate's tests and clippy on Linux, the keyring store against a real GNOME Keyring on a private session bus, and the app channel checks.
- Developers can still build from source with `scripts/linux/setup-debian.sh` or `scripts/linux/setup-arch.sh` (app at `~/.local/bin/gentle-dot`).

## Windows

Gentle Dot targets Windows 10 and Windows 11, x86_64 (aarch64 is planned later); the runs so far are on Windows 11. There is **no packaged installer yet**: the port is in progress and several units are still pending, so today you build and run it from source. This section says how, where your data and secrets live, what does not work yet, and how to remove it. It is not a claim of parity with macOS or Linux.

Measured on Windows 11 x86_64: the app provisions `%USERPROFILE%\.gentle-dot`, starts its own daemon over the private named-pipe channel, and `GET http://127.0.0.1:4317/` answers HTTP 200; quitting exits with code 0 and takes its daemon with it. `cargo test --lib` reports 399 passed / 0 failed / 4 ignored. Everything else below is the intended behaviour a tester checks, or is marked "not yet".

### Requirements

- Windows 10 or Windows 11, x86_64. aarch64 is not supported yet.
- **Node.js 24** and **pnpm 11.5.0** (the version `package.json` pins; `corepack enable` picks it up).
- **Rust stable with the MSVC toolchain**, plus the **Visual Studio Build Tools with the "Desktop development with C++" workload** (the linker and C compiler).
- **WebView2**: Windows 11 ships it; Windows 10 gets the Evergreen Runtime if it is missing.
- **Go 1.25.10 or newer.** `pnpm install` also needs Go on Windows, because gentle-pi's postinstall builds its package-local Gentle AI binary from source there. On macOS and Linux the same postinstall downloads a pinned release archive, so this requirement is Windows-only.

### Build from source

Building the Windows installers needs Node.js 24, pnpm, Rust with the MSVC toolchain, the Visual Studio Build Tools with the "Desktop development with C++" workload, and Go 1.25.10 or newer — `pnpm install` builds gentle-pi's Gentle AI binary from source on Windows, and so does the staging step.

From the repository root:

```sh
pnpm install
pnpm package:windows           # add --check to verify both installers (needs 7-Zip)
```

`pnpm package:windows` stages the app's runtime (`build/runtime/win-x64`: Node, the assistant engine, a fallback Engram, the daemon, and the web UI), then runs the release build and writes two **self-contained** installers under `apps/desktop/src-tauri/target/release/bundle/`:

| Installer | File | Installs to | Needs |
|---|---|---|---|
| NSIS, per user | `nsis/Gentle Dot_<version>_x64-setup.exe` | `%LOCALAPPDATA%\Gentle Dot` | nothing |
| MSI, per machine | `msi/Gentle Dot_<version>_x64_en-US.msi` | `Program Files\Gentle Dot` | an administrator |

At version 0.1.0 they measure 79,267,489 bytes (75.6 MB) and 125,985,987 bytes (120.1 MB), because each carries the 317.9 MB runtime compressed. `--skip-stage` reuses a runtime staged earlier. `--check` verifies an installer before you trust it, and **installs nothing**: it extracts each payload, compares every one of the ~28,000 files against the staged runtime, checks the SHA-256 of six of them (the manifest, `node\node.exe`, `bin\pi.cmd`, `bin\engram.exe`, the daemon bundle, and the engine binary), and deletes the extractions.

The app finds its runtime in `runtime\` beside `Gentle Dot.exe` (override with `GENTLE_DOT_RUNTIME_DIR`). Measured on Windows 11 x86_64 with the NSIS installer: `"Gentle Dot_0.1.0_x64-setup.exe" /S /D=<folder>` exits 0 and leaves `Gentle Dot.exe`, `runtime\` and `uninstall.exe` in that folder, with an Add/Remove Programs entry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Gentle Dot`; the installed `runtime\` holds all 28,273 staged files byte for byte, and running its `bin\pi.cmd`, `bin\engram.exe` and engine binary with no Go on `PATH` reports `1.0.4`, `engram 3.4.0` and `gentle-ai 4.0.0`. The MSI was not installed, because it needs an administrator.

**The installers are not signed** — there is no code-signing identity in this project yet — so Windows shows its "unrecognized app" warning.

`pnpm --filter @gentle-dot/desktop build` still works and is a plain release build: it writes the same two installers, but **they do not carry the runtime**, which is what [docs/windows-testing.md](windows-testing.md) uses.

You can also run the built app directly: `apps/desktop/src-tauri/target/release/gentle-dot.exe`.

### Where data lives

| What | Where |
|---|---|
| Settings, conversations, logs (`daemon.log`), the access key (`token`), the engine's own home and workspace | `%USERPROFILE%\.gentle-dot` |
| Connector secrets | `%LOCALAPPDATA%\Gentle Dot\secrets.dat` |
| The installed app and its runtime (only if you used an installer) | `%LOCALAPPDATA%\Gentle Dot` (NSIS, per user) or `Program Files\Gentle Dot` (MSI, per machine) |
| Installer output (build only) | `apps/desktop/src-tauri/target/release/bundle/` |

The app itself never changes after it is built; everything it writes goes to the folders above.

### Panel shortcut and launch at login

The panel opens with the global shortcut **`Ctrl+Shift+Space`**. macOS and Linux keep `Alt+Space`, which is Windows' window-menu key and a poor default for a global hotkey (it would take that menu away from every app). Change it in the panel's Settings or as `shortcut` in `config.json`; **Launch at login** in the tray menu registers the app as **`Gentle Dot`** under the Windows `Run` key — normally `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, or `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` when the app runs with administrator rights, which starts it for every user.

### Connector secrets and the Windows limit

On Windows, connector secrets (tokens, client secrets, imported header and environment values, and OAuth sign-ins) live in a single file the app owns, `%LOCALAPPDATA%\Gentle Dot\secrets.dat`. It is written with `CryptProtectData` and read with `CryptUnprotectData` at the default user scope (never `CRYPTPROTECT_LOCAL_MACHINE`), is bound to each id, and is replaced atomically. The Windows Credential Manager is deliberately not used: a generic credential's blob is capped at 2560 bytes, and the daemon keeps a sign-in as one JSON secret that already measures 2744 bytes for a Microsoft-backed connector before any token exists.

**Limit on Windows:** any process running as the same user — the agent's shell included — can read these secrets, exactly as the Linux limit above states for the Secret Service. DPAPI's documented scope is "only the same user account on the same machine". Deleting `secrets.dat` clears everything. The honest ceiling is the same as everywhere else in this family: neither a DPAPI file nor a Credential Manager item protects against other applications running in the same userspace (Electron documents this for Windows in as many words). Chrome's App-Bound Encryption — a SYSTEM COM broker that validates the calling executable — is the state of the art and is **not** implemented here. One more DPAPI property worth knowing: it derives its keys from your Windows account, so if an administrator resets your password (rather than you changing it), previously protected data may become unreadable unless a recovery agent or a DPAPI backup key is in place.

### What does not work yet on Windows

The port is incomplete on purpose. Each item names the unit that carries it.

- **Connectors that need a secret or an approval work over the private channel** (W7). The app creates a named pipe before it spawns the daemon and hands over its name in `GENTLE_DOT_CHANNEL_PIPE`; the credential is the accepted connection's pid against the child the app just spawned, so a daemon the app did not start is refused rather than answered. A connector that needs a secret asks for it in the app and the value reaches the daemon over that channel; a connector whose secret is missing fails closed rather than falling back to a file.
- **Voice** (W12) and **computer control** (W13, macOS-only today) are not available.
- **The panel's blur is gated and unverified** (W8d): the app asks for `Mica` only on Windows 11 (build ≥ 22000) with transparency effects on, a local session, and DWM composition on; otherwise the panel is opaque. Tauri gives no readback, so the blur can still silently fail even when those facts hold — the gate is the mitigation, and confirming it is the tester's visual check in [docs/windows-testing.md](windows-testing.md).

Nothing else in the Windows install path is missing: the self-contained installer is built by `pnpm package:windows` (W11), its payload is verified, and the engine it carries is the project's own Go SumDB source build of the pinned Gentle AI module — unsigned, hash-pinned in `integrity.json`, and not an upstream release asset, because upstream stopped publishing unsigned Windows builds.

For a step-by-step tester checklist, see [docs/windows-testing.md](windows-testing.md).

### Uninstall

1. Quit Gentle Dot from the tray.
2. If you built from source, delete the folder you built or the built app; if you installed one of the installers, remove **Gentle Dot** from **Settings → Apps → Installed apps** (the NSIS installer writes its own `uninstall.exe` next to the app as well).
3. Optional: delete `%USERPROFILE%\.gentle-dot` to remove settings and conversations.
4. Optional: delete `%LOCALAPPDATA%\Gentle Dot` to remove `secrets.dat` and the connector secrets it holds.

The NSIS uninstaller removes the app folder and its Add/Remove Programs entry, but leaves an empty `HKCU\Software\Gentleman Programming\Gentle Dot` key behind — that is Tauri's installer template, not this app. Deleting it is optional.

### For developers

**Line endings after switching branches.** `.gitattributes` (`* text=auto eol=lf`) heals a fresh clone, but an existing Windows checkout that switches branches keeps CRLF on files that are identical between the branches, and `biome check` then reports around 178 errors that are only line endings. The fix is to renormalize the tracked files:

```sh
git add --renormalize .
git diff --stat   # must stay empty
```

**A cold build that fails inside a dependency.** A cold build can fail inside a dependency's build script with a silent `cl.exe` exit code 2 and empty stderr. That is a missing Windows SDK include path (`stddef.h`), not a defect in this repository. The workaround that worked is a `.bat` that sets `INCLUDE` and `LIB` explicitly before the build; a Developer Command Prompt through `vcvars64.bat` does not run well from git-bash.
