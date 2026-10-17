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

### Arch / Niri: build, install, and update

Use the packaged app, not `tauri dev`, to update an installation managed by pacman. Building requires Docker, Node.js 24 or later, and pnpm; run the build as your normal user, **not with sudo**. From the repository root, run these commands in Bash:

```bash
pnpm install --frozen-lockfile
mkdir -p build/package-tmp
export TMPDIR="$PWD/build/package-tmp"
package_dir="$(mktemp -d "$PWD/build/package-tmp/niri-package-XXXXXX")"
pnpm package:linux --arch amd64 --ksni-tray --out "$package_dir" &&
  sudo pacman -U "$package_dir"/gentle-dot-*.pkg.tar.zst
```

The fresh output directory contains only this build's package: no version or tag is hardcoded, and the wildcard cannot select an older build. `TMPDIR` keeps packaging temporaries on the repository filesystem instead of a possibly full `/tmp`. Do not run the install command if packaging fails. Pacman asks for confirmation; keep that prompt enabled.

**Update:** quit Gentle Dot through its tray menu, obtain the source revision you want to install, and run the same commands again. `pacman -U` installs or updates the local package, including reinstalling a corrected build with the same version. It preserves `~/.gentle-dot`, your desktop keyring, and Engram. Then launch `/usr/bin/gentle-dot` and check `pacman -Q gentle-dot`. Avoid a source-build launcher in `~/.local/bin` shadowing the packaged command (`command -v gentle-dot` shows which one your shell uses).

No pacman-package install helper currently exists. `scripts/linux/setup-arch.sh` is a **source-build** installer, not the package update path above. Generated packages belong outside Git; do not commit `.pkg.tar.zst` files.

### Niri desktop setup and login launch

Build with `--ksni-tray` as above for the StatusNotifier tray. The flag selects the Linux tray backend; it does **not** install KDL rules. It remains opt-in to preserve the default AppIndicator behavior on other Linux desktops; it does not change macOS.

**Niri window rules are required for the intended first-map floating, decoration-free, non-focus-stealing behavior.** On first Niri launch, the app attempts to add its managed include and `Alt+Space` toggle binding, with backup and validation. It heals matching window-rule blocks that already exist, but does not create missing rule blocks. Follow the [Niri desktop setup](linux-testing.md#3-desktop-setup) to ensure the shipped window rules are present; do not treat a working shortcut as proof that the rules were installed. Keep existing user bindings and startup entries when merging the rules.

**Launch at login** is controlled from the app's tray menu. A normal `niri-session` runs XDG Autostart through `xdg-desktop-autostart.target`, so `~/.config/autostart/gentle-dot.desktop` is sufficient. The toggle removes an older managed `spawn-at-startup` block from the Gentle Dot include while preserving your window rules and bindings. Do not use both mechanisms: duplicate launches can arrive while the app is still starting. If you launch bare Niri without session integration, use `spawn-at-startup` as an alternative, not an additional launch. A configuration reload is not a reboot or proof of login launch.

Check the configuration without launching another instance:

```sh
niri validate --config "$HOME/.config/niri/config.kdl"
```

After an update that changes the executable's location, disable and enable **Launch at login** from the final installed app to refresh its recorded path. To test it, save your work, quit Gentle Dot, and log out and back into Niri (or reboot). The tray should appear without opening the app manually. See the [Linux checklist](linux-testing.md) for compact/fullscreen, shortcut, and login-launch checks.

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
