# Testing Gentle Dot on Linux

Thanks for testing! This guide walks you through installing Gentle Dot from source and checking that it works on your desktop. It takes about 30 minutes, most of it waiting for the first build.

We test three setups. Pick the one you have:

| Setup | Desktop | Session | How the app runs |
|---|---|---|---|
| **A. Debian 12 or 13** | GNOME | Wayland (default) | Under XWayland, set automatically |
| **B. Ubuntu 24.04 or later** | GNOME | Wayland (default) | Under XWayland, set automatically |
| **C. Omarchy** (Arch) | Hyprland | Wayland | Native Wayland, with window rules you paste |

The tray icon, the floating rose, the panel, and the toggle shortcut should work on all three. Where Wayland does not allow something, there is a workaround, explained below.

## Before you start

1. Check your session type. In a terminal, run:

   ```sh
   echo "$XDG_SESSION_TYPE / $XDG_CURRENT_DESKTOP"
   ```

   Write down the answer for the report (for example `wayland / ubuntu:GNOME` or `wayland / Hyprland`).
2. Have an API key ready for one model provider (for example OpenAI, OpenRouter, or Anthropic). You need it in step 8.
3. Get the source code: clone the repository or unpack the archive you were sent, then open a terminal in its folder.

## What the setup script does

| Step | Uses sudo? |
|---|---|
| Installs the system libraries the app needs (WebKitGTK, tray support, compilers) | **Yes**, and it asks first |
| Installs Node.js 24 in `~/.local/share/gentle-dot` (only if you do not already have Node.js 24 or later) | No |
| Installs Rust with rustup in `~/.rustup` and `~/.cargo` (only if you do not have Rust 1.90 or later) | No |
| Builds the app from the source folder | No |
| Adds the `gentle-dot` command in `~/.local/bin` and a "Gentle Dot" entry in your app menu | No |

You can run the script again at any time; it skips what is already done. `scripts/linux/uninstall.sh` removes the command, the menu entry, and the private Node.js. It keeps your assistant data unless you pass `--purge`.

## How the app handles Wayland

| Topic | GNOME (Debian, Ubuntu) | Hyprland (Omarchy) |
|---|---|---|
| Window placement, always on top, snapping to the edge | Work, because the app runs under XWayland | Done by the window rules you paste in step 3C. Snapping to the edge does not happen. |
| Global shortcut | Add a custom shortcut in GNOME Settings (step 7) | `SUPER + ALT + D`, from the binding you paste in step 3C |
| Tray icon | Needs the AppIndicator extension. Ubuntu has it on already; Debian needs it enabled (step 6). | Shown by Waybar |
| Panel background | Solid dark, with no blur behind it | Same |

`gentle-dot --toggle` shows or hides the panel of the running app. If the app is not running, the command starts it and opens the panel.

## The checklist

Do each step in order and note **Pass**, **Fail**, or **Partial** for each one. If something fails, keep going; later steps often still work.

### 1. Install

| Your setup | Command |
|---|---|
| A. Debian or B. Ubuntu | `scripts/linux/setup-debian.sh` |
| C. Omarchy | `scripts/linux/setup-arch.sh` |

**Expected:** each step prints a numbered heading (`==> 1. Checking the system` and so on). The script explains why it needs sudo before it asks for your password. It ends with `Done.` and asks "Start Gentle Dot now?". Answer **no** for now.

If the build fails, copy the last 40 lines of the output into the report.

### 2. Run the installer again

Run the same command a second time.

**Expected:** it finishes in under a minute, says "All present" for the system libraries, and does not ask for sudo.

### 3. Desktop setup

**A. Debian and B. Ubuntu:** nothing to do here.

**C. Omarchy:** first check which kind of Hyprland configuration you have:

```sh
hyprctl version | head -n 1
ls ~/.config/hypr/hyprland.lua ~/.config/hypr/hyprland.conf 2>/dev/null
```

- If you have `hyprland.lua` (Omarchy 4, or Hyprland 0.55 and later), use [`scripts/linux/hyprland/gentle-dot.lua`](../scripts/linux/hyprland/gentle-dot.lua). Paste it at the end of `~/.config/hypr/hyprland.lua`. Omarchy 4 configures Hyprland in Lua: see `config/hypr/hyprland.lua` and `default/hypr/helpers.lua` (`o.window`, `o.bind`) in the Omarchy repository, tag [v4.0.4](https://github.com/basecamp/omarchy/tree/v4.0.4/config/hypr), released 2026-09-15 and checked on 2026-10-08.
- If you have only `hyprland.conf`, use [`scripts/linux/hyprland/gentle-dot.conf`](../scripts/linux/hyprland/gentle-dot.conf). Paste it at the end of `~/.config/hypr/hyprland.conf`. It has one block for Hyprland 0.53 and 0.54, and one for 0.48 to 0.52 (before 0.48, write `windowrulev2` instead of `windowrule`). Keep only the block for your version.

Hyprland reloads the file when you save it. If it shows a configuration error, write the error message in the report.

### 4. First launch

Open **Gentle Dot** from your app menu (or run `~/.local/bin/gentle-dot` in a terminal, which also shows its log messages).

**Expected:**
- Within a few seconds, a black circle with a glowing pink rose appears at the right edge of the screen, vertically centered.
- After up to 20 seconds the rose stops looking dimmed: the assistant is ready.
- Around the circle, the desktop shows through. A black or white square around the circle is a **Fail**: write down your GPU and driver.
- **Hyprland:** the rose has no border, shadow, or blur.

### 5. The rose stays on top

Open a few other windows and click on them. Switch to another workspace.

**Expected:** the rose stays above the other windows and appears on every workspace.

### 6. Drag and snap

Drag the rose to the middle of the screen and let go.

**Expected:**
- **GNOME:** within half a second, the rose moves to the nearest screen edge, 12 px away from it. Quit and reopen the app (step 13): the rose comes back where you left it.
- **Hyprland:** the rose moves with the pointer and stays where you drop it (no snapping). After a restart it goes back to the position from the window rules.

### 7. Click opens the panel

Click the rose (without dragging).

**Expected:** a 420 × 640 dark panel opens next to the rose, and the cursor is in the message box. The panel background is solid dark, not see-through. Press `Esc`: the panel hides. Click the rose again: it opens again.

### 8. Tray icon and menu

**Debian only:** turn on the AppIndicator extension, then log out and back in:

```sh
gnome-extensions enable ubuntu-appindicators@ubuntu.com
```

**Expected:**
- A small rose appears in the top bar (GNOME) or in Waybar (Omarchy). It is light gray with a dark outline, and readable on both light and dark bars.
- Clicking it opens a menu: Open, Open in browser, Restart assistant, Launch at login, Quit.
- **Open** shows the panel. **Open in browser** opens the same chat in your browser.
- Hovering over the icon may show "Gentle Dot — Ready". Many Linux panels do not show tray tooltips, so this is not a failure.
- While the assistant answers (step 11), the icon's outer petals turn dashed. When it waits for your answer, an amber dot appears on the icon.

### 9. Toggle shortcut

**GNOME:** open Settings → Keyboard → View and Customize Shortcuts → Custom Shortcuts → Add Shortcut:
- Name: `Gentle Dot`
- Command: `/home/<you>/.local/bin/gentle-dot --toggle` (the full path; the setup script printed it)
- Shortcut: `Super + Alt + D`

Or set the same shortcut from a terminal:

```sh
path=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/gentle-dot/
gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings "['$path']"
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$path name 'Gentle Dot'
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$path command "$HOME/.local/bin/gentle-dot --toggle"
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$path binding '<Super><Alt>d'
```

The first `gsettings` line replaces any custom shortcuts you already have. If you have some, use the Settings app instead.

**Hyprland:** the binding is already in the snippet from step 3.

**Expected:** pressing `Super + Alt + D` while any other app has focus shows the panel; pressing it again hides it. Also run `~/.local/bin/gentle-dot --toggle` in a terminal: it toggles the panel and returns right away.

The app's own `Alt + Space` shortcut works only on an X11 session. On Wayland, desktops do not let apps register global shortcuts, which is why you set one in your desktop settings instead. On GNOME, `Alt + Space` is also the window menu.

### 10. Sign in with an API key

In the panel, type `/login` and press Enter (or use the **Accounts** icon in the header). Choose **API key**, pick your provider, paste the key, and confirm.

**Expected:** the provider shows as connected. The key never appears again in the chat.

### 11. Chat

Ask "What can you do?".

**Expected:** the answer streams in word by word, and the rose glows with a moving light while the assistant works.

### 12. Approval card

Open **Connectors** in the header and choose **Add another connector**. When the chat asks which one, answer "the filesystem MCP server, for my Documents folder".

**Expected:** the assistant does not add anything by itself. A card titled "Add …?" shows what would run on your computer and which secrets it needs, with an **Add** button and **Decline**. Choose **Decline**: the card goes away and nothing is added.

### 13. Profiles

Open **Profiles** (the sliders icon in the header). Create a profile, rename it, switch to it, and switch back.

**Expected:** each change shows right away, and no error appears.

### 14. Connectors

Open **Connectors** in the header.

**Expected:** it lists Gmail, Slack, Discord, Notion, Linear, and Atlassian, plus "Add another connector". You do not need to connect any of them; open two or three guides and check that they read well.

### 15. Quit and relaunch

Choose **Quit** in the tray menu, then open Gentle Dot again from the app menu.

**Expected:** the rose and the tray icon disappear on Quit. On relaunch, the rose comes back (on GNOME, where you left it), and the panel shows your earlier conversation.

### 16. Launch at login (optional)

Turn on **Launch at login** in the tray menu, log out, and log back in.

**Expected:** the rose appears after login. Turn the option off again afterwards.

## Reporting Wayland limitations

Some things Wayland does not allow at all, and we already work around them: apps cannot place their own windows, stay on top by themselves, or register global shortcuts. If you notice something else that does not work the same way as on other systems, write in the report:

1. what you did,
2. what you expected,
3. what happened instead,
4. the output of `echo "$XDG_SESSION_TYPE $GDK_BACKEND $WAYLAND_DISPLAY $DISPLAY"`, run in the same terminal you started the app from.

For a quick comparison on GNOME, you can start the app as a native Wayland client with `GDK_BACKEND=wayland ~/.local/bin/gentle-dot`, and note which steps change.

## Troubleshooting

| Symptom | Try |
|---|---|
| The panel or rose is blank, or the app prints `Failed to create GBM buffer` (often with NVIDIA) | Quit the app, then start it with `WEBKIT_DISABLE_DMABUF_RENDERER=1 ~/.local/bin/gentle-dot`. Note in the report whether it helped. |
| The rose stays dimmed | Look at `~/.gentle-dot/daemon.log` and attach it (see below). |
| No tray icon on GNOME | Check that the AppIndicator extension is on: `gnome-extensions list --enabled` |
| `gentle-dot: command not found` | Use the full path, `~/.local/bin/gentle-dot` |

## Report template

Copy this into your message and fill it in.

```text
## Gentle Dot Linux test report

Distribution and version:     (for example Ubuntu 24.04.3)
Desktop:                      (GNOME 46 / Hyprland 0.56.2 / Omarchy 4.0.4)
Session type:                 (output of: echo "$XDG_SESSION_TYPE / $XDG_CURRENT_DESKTOP")
Hyprland config:              (hyprland.lua or hyprland.conf; Omarchy only)
GPU and driver:               (output of: lspci -k | grep -A 2 -E "VGA|3D")
CPU architecture:             (output of: uname -m)
Source version:               (output of: git rev-parse --short HEAD, or the archive name)

| # | Step                       | Result (Pass / Fail / Partial) | Notes |
|---|----------------------------|--------------------------------|-------|
| 1 | Install                    |                                |       |
| 2 | Run the installer again    |                                |       |
| 3 | Desktop setup              |                                |       |
| 4 | First launch               |                                |       |
| 5 | Rose stays on top          |                                |       |
| 6 | Drag and snap              |                                |       |
| 7 | Click opens the panel      |                                |       |
| 8 | Tray icon and menu         |                                |       |
| 9 | Toggle shortcut            |                                |       |
| 10| Sign in with an API key    |                                |       |
| 11| Chat                       |                                |       |
| 12| Approval card              |                                |       |
| 13| Profiles                   |                                |       |
| 14| Connectors                 |                                |       |
| 15| Quit and relaunch          |                                |       |
| 16| Launch at login (optional) |                                |       |

Wayland limitations noticed:

Screenshots: (the rose on the desktop, the open panel, the tray icon)

Logs: (see below)
```

### Logs to attach

- The terminal output of `~/.local/bin/gentle-dot`, if you started it from a terminal.
- The assistant log, with the access key removed. The key is a secret: never share `~/.gentle-dot/token`. This command copies the log and masks the key:

  ```sh
  sed "s/$(cat ~/.gentle-dot/token)/<token>/g" ~/.gentle-dot/daemon.log > ~/gentle-dot-daemon.log
  ```

  Then attach `~/gentle-dot-daemon.log`. Look through it before sending it, and remove anything else you consider private.
