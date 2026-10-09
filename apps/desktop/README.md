# Gentle Dot desktop (macOS and Linux)

The Tauri 2 shell around the Gentle Dot UI: a floating Dot, an expandable panel, a menu bar item, and a global shortcut. The contract between Rust and the UI is §9 of [`docs/design.md`](../../docs/design.md). Linux is covered [below](#linux).

## Requirements

- macOS, Xcode command line tools, Node 24, pnpm.
- Rust stable through rustup. If another `cargo` without `rustc` (for example from Nix) comes first on `PATH`, put rustup first:

  ```sh
  export PATH=/opt/homebrew/opt/rustup/bin:$PATH
  ```

- `src-tauri/.cargo/config.toml` pins the linker and C compiler to Apple's `/usr/bin/cc` for the macOS targets only (`CC_<target>`), because a Nix GCC `cc` on `PATH` cannot link against the macOS SDK. Linux builds use the system `cc`.

## Run

```sh
pnpm --filter @gentle-dot/desktop dev
```

This starts the UI dev server on `http://127.0.0.1:5173` and opens the Dot. Debug builds spawn the daemon with `GENTLE_DOT_ALLOWED_ORIGINS='["http://127.0.0.1:5173","http://localhost:5173"]'`, because the daemon rejects WebSocket origins outside its allowlist and `tauri dev` serves the UI from that origin. Release builds never set it; there the UI loads from `tauri://localhost`, which the daemon always allows. A daemon that was already running when the app started keeps its own allowlist.

## Build

```sh
pnpm --filter @gentle-dot/desktop tauri build --debug --bundles app   # debug .app
pnpm --filter @gentle-dot/desktop build                                # release
```

The bundle is written to `src-tauri/target/{debug,release}/bundle/macos/Gentle Dot.app`. Run the Rust unit tests with `cargo test` inside `src-tauri`.

## The daemon and `PATH`

On launch, the app checks `GET http://127.0.0.1:<port>/health`. If nothing answers, it spawns `<node> <repo>/packages/daemon/src/cli.ts` and writes its output to `~/.gentle-dot/daemon.log`.

Apps opened from Finder get a minimal `PATH`, but the daemon needs `gentle-shell`. So `build.rs` records three values at build time: the absolute `node` path, the daemon script path, and the build `PATH`. The spawned daemon runs with that `PATH`. Build from a shell where `node` and `gentle-shell` resolve, and rebuild if they move.

Runtime overrides:

| Variable | Effect |
|---|---|
| `GENTLE_DOT_NODE` | `node` binary used to start the daemon |
| `GENTLE_DOT_DAEMON_SCRIPT` | Daemon entry point |
| `GENTLE_DOT_DATA_DIR` | Data directory (default `~/.gentle-dot`) |
| `GENTLE_DOT_PORT` | Daemon port (default `4317`, otherwise `port` in `config.json`) |

`shortcut` in `~/.gentle-dot/config.json` changes the global shortcut (default `Alt+Space`). The Dot position is saved in `~/.gentle-dot/desktop.json` as `dot_points`, in macOS points (the screen space every monitor shares, whatever its scale factor). The `dot` key written by older builds was in physical pixels and is ignored, so the Dot starts once more at the right edge of the main display.

## Menu bar

| Item | What it does |
|---|---|
| Open (`⌥ Space`) | Shows the panel next to the Dot. The shortcut toggles it. |
| New conversation | Shows the panel and emits `dot://new-conversation` so the UI starts a new conversation. |
| Open in browser | Opens `http://127.0.0.1:<port>/#token=…` in the default browser. |
| Restart assistant | Restarts the daemon if the app started it. If it was started elsewhere, shows a dialog instead. |
| Launch at login | Turns the login item on or off (macOS LaunchAgent). This menu item is the source of truth; `launchAtLogin` in `config.json` is not read. |
| Quit | Stops the daemon the app started (SIGTERM), then quits. A daemon started elsewhere keeps running. |

The menu bar icon changes with the agent state that the UI reports through `set_dot_state` (ready, working, needs you, unavailable), and the tooltip names it.

## Icons

All icons come from the rose (`docs/brand/`). `scripts/make-icon.mjs` renders them with Playwright's Chromium:

- `src-tauri/icons/tray/<glyph>.png` and `<glyph>@2x.png` (18 and 36 px): the menu bar glyph `rose-glyph.svg` for `ready`, `working` (dashed outer petals), `needs-you` (badge dot), and `unavailable` (dimmed). They are template images, so macOS uses only their alpha and tints them for the menu bar. The app embeds the 36 px files, which macOS draws at 18 pt.
- `src-tauri/icons/source.png` (1024 px): the neon rose `rose-source.png` on a black macOS squircle with a faint pink rim.
- `packages/ui/public/favicon.svg` and `favicon.png`: the glyph in neon pink for the browser tab.

```sh
node scripts/make-icon.mjs
pnpm --filter @gentle-dot/desktop tauri icon src-tauri/icons/source.png -o /tmp/gentle-dot-icons
cp /tmp/gentle-dot-icons/{32x32,64x64,128x128,128x128@2x}.png /tmp/gentle-dot-icons/icon.{icns,png} src-tauri/icons/
```

`node scripts/make-icon.mjs --linux-tray` renders only `src-tauri/icons/tray/linux/<glyph>.png` (32 px): the same four states for Linux trays, which do not tint icons and can be light or dark, so the glyph is light gray over a dark outline, with an amber badge for `needs-you`.

`tauri icon` also writes Android, iOS, and Windows icons, which this macOS app does not use, so they go to a scratch directory and only the files `tauri.conf.json` lists (plus `64x64.png`) are copied.

## Linux

Debian and Ubuntu (GNOME) and Omarchy (Arch with Hyprland) are built from source on the user's machine, because the app records the build machine's `node` and daemon paths (see above). The setup scripts install the system libraries (the only step that uses sudo, after asking), Node 24 under `~/.local/share/gentle-dot` when no Node 24+ is present, pnpm through corepack, and Rust through rustup, then build with `tauri build --no-bundle` and install `~/.local/bin/gentle-dot` and a menu entry:

```sh
scripts/linux/setup-debian.sh    # Debian, Ubuntu (apt)
scripts/linux/setup-arch.sh      # Omarchy, Arch (pacman)
scripts/linux/uninstall.sh       # removes the launcher, menu entry, and private Node; --purge also ~/.gentle-dot
```

The binary is `src-tauri/target/release/gentle-dot`. Tester checklist: [`docs/linux-testing.md`](../../docs/linux-testing.md).

What differs from macOS (decided in `src/platform.rs`, unit-tested on both systems):

| Topic | macOS | GNOME on Wayland (Debian, Ubuntu) | Hyprland (Omarchy) |
|---|---|---|---|
| Display backend | — | XWayland: the app sets `GDK_BACKEND=x11` before GTK starts, when the session is Wayland, the desktop is not Hyprland, `DISPLAY` is set, and the user did not choose a `GDK_BACKEND` | Native Wayland |
| Dot placement, snapping, panel next to the Dot | The app | The app | Hyprland window rules, matched by title (`Gentle Dot`, `Gentle Dot Panel`): [`scripts/linux/hyprland/`](../../scripts/linux/hyprland/) has a `hyprland.lua` form (Omarchy 4) and a `hyprland.conf` form |
| Global shortcut | `Alt+Space` from the app | A desktop custom shortcut running `gentle-dot --toggle` (XWayland only sees keys while an X11 window has focus, and `Alt+Space` is GNOME's window menu) | A Hyprland `bind` running `gentle-dot --toggle` (the app does not register one) |
| Panel background | `HudWindow` vibrancy | Opaque: the panel URL carries `effects=none` | Same as GNOME |
| Tray glyphs | Template images | `icons/tray/linux/` (needs the AppIndicator GNOME extension; Ubuntu ships it on) | Same, shown by Waybar |

`gentle-dot --toggle` reaches the running app through `tauri-plugin-single-instance` (D-Bus on Linux), which toggles the panel; any other second launch shows it. Started with `--toggle` while not running, the app opens the panel once it is up.

macOS-only calls (`accept_first_mouse`, the `HudWindow` effect, the accessory activation policy) are behind `cfg(target_os = "macos")`; the template flag follows `status::is_template`. The `macos-private-api` feature and `macOSPrivateApi: true` stay on every platform: tauri-build checks the `tauri` features in `Cargo.toml` against the merged `tauri.conf.json`, every `tauri` dependency entry including target-specific ones, so splitting them per target fails the build. They only change macOS code; the Linux build in a Debian container compiles with them. `Info.plist` (`LSUIElement`) is read only by the macOS bundle.

