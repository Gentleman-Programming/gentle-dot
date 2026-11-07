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

## Windows

Requirements: Windows 10 or 11, x64. Windows 10 version 2004 (build 19041) is the minimum for excluding Gentle Dot's windows from screenshots, not a guarantee of capture eligibility: build, composition, session and owned-window checks can still refuse capture.

The source includes Windows connector approvals, DPAPI migration, voice and computer control. Current reconciled native/installer/live acceptance is not complete; previous installed-build results apply only to those earlier sources. See [runtime reconciliation](windows-runtime-reconciliation.md), [computer-control limits](windows-computer-reconciliation.md) and the [tester checklist](windows-testing.md).

### Install

1. Run `Gentle Dot_<version>_x64-setup.exe` (NSIS, per user), or the `.msi` for a per-machine installation requiring administrator rights.
2. Installers are unsigned. If SmartScreen shows **Windows protected your PC**, use **More info → Run anyway** only for an installer you built or trust.
3. Follow the installer. NSIS defaults to `%LOCALAPPDATA%\Gentle Dot`; MSI defaults to `Program Files\Gentle Dot`. The embedded WebView2 bootstrapper needs the internet if WebView2 is missing.

Quit Gentle Dot from its tray before updating: accepting the NSIS **Gentle Dot is running! Click OK to kill it** prompt terminates it without an orderly quit.

### First open

Open **Gentle Dot** from the Start menu. The panel shortcut defaults to **Ctrl+Shift+Space**, and the computer-control emergency stop is **Alt+Shift+Esc**. Change the panel shortcut and memory mode in Settings; the interface supports English and Spanish.

The bundled Windows launcher disables automatic home provisioning and companion installation. Go is a build prerequisite, not an installed-user requirement; provider/model requests and optional downloads still need a network connection. Voice and computer-control eligibility depend on the host's available capabilities; source presence is not live-device acceptance.

### Where data lives

| What | Where |
|---|---|
| App and bundled runtime | Install folder, with the runtime in `runtime\` |
| Settings, conversations, logs, engine home/workspace | `%USERPROFILE%\.gentle-dot\` |
| Connector secrets, encrypted for your Windows user | `%LOCALAPPDATA%\dev.gentleman.gentle-dot.connectors\` |
| Legacy connector store, retained unchanged during migration | `%LOCALAPPDATA%\Gentle Dot\secrets.dat` |
| WebView2 data | `%LOCALAPPDATA%\dev.gentleman.gentle-dot\` and `%APPDATA%\dev.gentleman.gentle-dot\` |
| Shared memory (Engram, project `gentle-dot`) | `%USERPROFILE%\.engram\` |
| Launch at login, when enabled | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` |

Private memory uses the assistant's own data instead of your shared Engram. The setting is saved and restarts the assistant when changed.

**DPAPI is user-scoped, not a same-user sandbox:** other programs running as you, including the assistant's shell, can decrypt these secrets. Migration validates legacy input, keeps the old file unchanged, refuses conflicting values and records encrypted completion receipts to prevent deleted secrets from reappearing. Isolated parser/migration fixtures do not certify real-profile migration or production long-path support.

### A connector secret that cannot be read

Each connector secret is one `.bin` file in a subfolder of `%LOCALAPPDATA%\dev.gentleman.gentle-dot.connectors\`. If one of those files is damaged, or was put there by something other than Gentle Dot, that secret can no longer be read or saved again. The error says `The app's secure store refused it: the secret store failed: …` (in the app or in `%USERPROFILE%\.gentle-dot\daemon.log`), and setting the connector up again does not help. When the damaged file holds the key Gentle Dot checks your connectors with, Gentle Dot says on every start that it could not check your connectors, and the connectors that need a secret stay locked. Restarting, as that notice suggests, does not help in this case.

Gentle Dot never repairs, replaces or deletes such a file, and it never keeps the secret unencrypted instead. That is on purpose. You have to remove it yourself. The file name is a hash and Gentle Dot does not show which file is broken, so remove the whole folder:

1. Quit Gentle Dot from its tray icon (**Quit**), so it does not use the folder while you delete it.
2. Delete `%LOCALAPPDATA%\dev.gentleman.gentle-dot.connectors\`. Only your Windows user (or an administrator) can.
3. Open Gentle Dot again. This removes every connector secret, including the key that checks your connectors. On this start Gentle Dot makes a new key, so it moves `connectors.json` aside as `connectors.rejected-<time>.json` in `%USERPROFILE%\.gentle-dot\`, starts with no connectors, and says connectors were changed while it was closed. This happens even if you had no connectors, because Gentle Dot signs `connectors.json` from its first start.
4. Add your connectors again in **Connectors** and sign in again.

### Uninstall

1. Quit Gentle Dot from its tray, then use **Settings → Apps → Installed apps → Gentle Dot → Uninstall**, or NSIS's `uninstall.exe` in the install folder.
2. Optional: delete `%USERPROFILE%\.gentle-dot\` to remove conversations/settings and the WebView2 data directories above to clear window data.
3. To remove connector credentials completely, remove both the current connector directory and the retained legacy `secrets.dat`. Removing only current entries/receipts while keeping a legacy source can allow a later fresh migration.

Keep `%USERPROFILE%\.engram\` unless you intend to delete all shared Engram memories, not only Gentle Dot's.

### Build the installer from source

Use Windows x64, Node 24 or newer, the declared pnpm 11.5.0, Rust with MSVC, Visual Studio's **Desktop development with C++** workload/Windows SDK, and Go 1.25.10 or newer. Run in a developer shell with the SDK's `INCLUDE` and `LIB`. The native addon's Node headers and `node.lib` must match the Node used to build it and be checked against Node's published checksums; [.github/workflows/windows.yml](../.github/workflows/windows.yml) shows provisioning. Replace the placeholder paths below.

```powershell
pnpm install
pnpm --filter @gentle-dot/daemon build:windows-stop -- --compiler "<full-path-to-cl.exe>" --headers "<node-headers>/include/node" --node-lib "<node.lib>"
$env:GENTLE_DOT_BUILD_GO = "C:\Program Files\Go\bin\go.exe"
pnpm package:windows
```

`GENTLE_DOT_BUILD_GO` must name the real `GOROOT\bin\go.exe`, not a package-manager shim. Staging uses it to build the pinned package-local Gentle AI from source, with Go module/binary provenance; it does not download an unsigned Windows release asset. The addon `daemon/native/windows-stop.node` is mandatory. The runtime also compiles
`bin/private-storage.exe` with the existing Go helper builder; keep `go` available
on the build shell's PATH. Neither Go nor build tools are installed-user requirements.

| Command | Result |
|---|---|
| `pnpm package:windows` | Stage `build/runtime/windows-x64`, build NSIS + MSI |
| `pnpm package:windows --skip-stage` | Reuse that stage, build NSIS + MSI |
| Either above with `--check` | Verify both payloads after building |
| `pnpm package:runtime --target windows-x64` | Stage only, without packaging |
| `pnpm package:windows --runtime <dir>` | Package an explicit stage as NSIS only |
| Explicit `--runtime <dir>` with `--check` | Verify NSIS only |

An explicit runtime must share the checkout's volume/share so the frontend path can remain relative to `src-tauri`. Node is `node/bin/node.exe`, npm is `node/lib/node_modules/npm`; the old `win-x64` staging target and `node/node.exe` layout are not accepted.

Outputs are under `apps/desktop/src-tauri/target/release/bundle/nsis/` and `bundle/msi/`. `--check` needs 7-Zip and Windows Installer: it extracts into owned temporary folders (MSI uses `msiexec /a`), compares full file lists and sample/engine hashes, and cleans the temporary extraction even on failure. It does not install or launch Gentle Dot. These commands describe intended executable behavior; an actual reconciled Windows package/extraction run remains separate verification.

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
