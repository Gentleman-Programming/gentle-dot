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
- GNOME: add a custom shortcut that runs `/usr/bin/gentle-dot --toggle` (see docs/linux-testing.md, step 9). Debian needs the AppIndicator extension for the tray icon.
- Hyprland / Omarchy: paste `scripts/linux/hyprland/gentle-dot.lua` (or `.conf`) into your Hyprland config; it already calls `/usr/bin/gentle-dot --toggle`.
- Remove: `sudo apt remove gentle-dot` or `sudo pacman -R gentle-dot` (your data in `~/.gentle-dot` stays).
- Build the packages (needs Docker): `pnpm package:linux --arch <arm64|amd64>` (amd64 also builds the Arch package); check them in clean containers with `pnpm package:linux:check --arch <arm64|amd64>`.
- Developers can still build from source with `scripts/linux/setup-debian.sh` or `scripts/linux/setup-arch.sh` (app at `~/.local/bin/gentle-dot`).
