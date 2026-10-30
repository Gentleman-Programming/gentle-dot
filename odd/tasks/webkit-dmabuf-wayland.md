# WebKitGTK dmabuf explicit-sync crash on native Wayland (Error 71)

Objective: the app must start and keep running on Hyprland + NVIDIA Wayland, where WebKitGTK's
DMA-BUF renderer currently commits without an acquire timeline and the compositor closes the
connection (`Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display`).
Upstream: WebKitGTK bug 280210. Issue draft pending (gh token is read-only on this repo).

Branch: `fix/webkit-dmabuf-wayland` · Test runner: `cargo test` in `apps/desktop/src-tauri` ·
Delivery: work-unit commit on this branch; push/PR are the user's decision.

## Diagnosis evidence (observed 2026-09-17)

- `WAYLAND_DEBUG=1`: `wl_display#1.error(wp_linux_drm_syncobj_surface_v1#50, 4, "Missing acquire timeline")` one frame after the first commit.
- Environment: Hyprland 0.56.2, mesa 26.2.2, gtk3 3.24.52, webkit2gtk-4.1 2.52.6, nvidia-open-dkms 615.71.09.
- Verified workaround: `WEBKIT_DISABLE_DMABUF_RENDERER=1` → 0 protocol errors over repeated 12 s runs, rose window renders at the monitor edge.
- `libayatana-appindicator is deprecated` warning is unrelated (cosmetic).

## Tasks

- **T1 — RED: platform helper with tests.** `platform::webkit_renderer_env(env)` returns
  `Some("1")` only when running as a native Wayland client and `WEBKIT_DISABLE_DMABUF_RENDERER`
  is unset; a user-set value, an X11/XWayland backend, and a non-Wayland session return `None`.
  Tests follow the existing `env_of` table style in `platform.rs`.
  - Evidence: `cargo test` fails to compile / fails assertion before the implementation exists.
- **T2 — GREEN: apply it before GTK starts.** In `shell::run()`, right after the `GDK_BACKEND`
  block, set `WEBKIT_DISABLE_DMABUF_RENDERER` from the helper under `#[cfg(target_os = "linux")]`.
  - Evidence: `cargo test` green.
- **T3 — Hyprland snippets.** `hl.env("WEBKIT_DISABLE_DMABUF_RENDERER", "1")` in
  `scripts/linux/hyprland/gentle-dot.lua` and `env = WEBKIT_DISABLE_DMABUF_RENDERER,1` in
  `gentle-dot.conf`, with a comment citing WebKitGTK bug 280210 (session-wide coverage for the
  user's choice "Ambos").
  - Evidence: both files updated; syntax-only review (no Hyprland reload in this session).
- **T4 — Docs.** `docs/linux-testing.md` "How the app handles Wayland" + `apps/desktop/README.md`
  display-backend table note the workaround and its reason.
  - Evidence: doc diff reviewed against the observed log.
- **T5 — Build and runtime verification.** `cargo test` (workspace), release rebuild via
  `pnpm --filter @gentle-dot/desktop tauri build --no-bundle`, then launch **without** any
  external env: app must survive >10 s with `WAYLAND_DEBUG=1` showing 0 `wl_display#1.error`
  and the rose window present in `hyprctl clients`.
  - Evidence: recorded command outputs.
- **T6 — Work-unit commit.** Conventional Commit on `fix/webkit-dmabuf-wayland` with tests and
  docs alongside the behavior.
  - Evidence: `f4890e3` (6 files, +54 -1).

## Out of scope

- Upstream WebKitGTK fix (bug 280210), NVIDIA driver changes, session-wide Hyprland config of
  the user (`hyprland.lua` already requires the repo snippet; T3 rides on that).
- Push / PR creation (gh token lacks write on this repo).

## Log

- 2026-09-17: branch created; diagnosis complete; T1 delegated to gentle-ai-worker (RED tests written; worker then failed with an assistant error, T2-T4 finished inline as fallback).
- 2026-09-17 T1 RED observed: `error[E0425]: cannot find function webkit_renderer_env` (cargo test exit 101).
- 2026-09-17 T2 GREEN: `cargo test` → `310 passed; 0 failed; 2 ignored`, including
  `platform::tests::native_wayland_disables_the_dmabuf_renderer` and
  `platform::tests::only_native_wayland_clients_get_the_dmabuf_renderer_off`.
- 2026-09-17 T3+T4: snippets and docs updated (lua, conf, linux-testing.md, desktop README).
- 2026-09-17 T5: release rebuilt (`tauri build --no-bundle`, `Finished release in 1m 03s`).
  Runtime check with `WAYLAND_DEBUG=1` and **no external** `WEBKIT_DISABLE_DMABUF_RENDERER`:
  process alive 16 s, 401 frame callbacks, `wl_display#1.error` count 0, `Error 71` count 0,
  window `gentle-dot | Gentle Dot | [1282, 348] [72, 72]` in `hyprctl clients`.
- 2026-09-17 T6: committed `f4890e3`; ODD record committed separately as `docs(odd)`.
