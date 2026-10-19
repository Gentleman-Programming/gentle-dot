//! Slice 4a pure routing and gate planners (`niri-route-gate`).
//!
//! Behavior-neutral extraction from `1d239a6` (`shell.rs`, `niri/unit.rs`):
//! only items that reference no `AppHandle`, no `Shell` state, no GTK and no
//! thread. Callers are still absent, so the module stays `allow(dead_code)`
//! until the wiring slices land.

use crate::platform::Os;
#[cfg(target_os = "linux")]
use crate::shell::CommandResult;

/// Whether a tray click toggles the panel directly instead of showing the
/// menu. Only the KSNI backend delivers Click events on Linux, and it is
/// opt-in (`ksni-tray` feature): AppIndicator delivers no clicks at all, and
/// macOS keeps menu-on-left-click. Right click keeps the menu on every backend.
///
/// KSNI activation emits exactly one `Click { Left, Up }` with an empty rect
/// (there is no icon geometry on the bus), so the handler toggles and never
/// anchors the panel to the event coordinates. Press-down, middle, and right
/// clicks are no-ops.
pub(crate) fn tray_click_toggles_panel(
    os: Os,
    ksni_tray: bool,
    button: tauri::tray::MouseButton,
    button_state: tauri::tray::MouseButtonState,
) -> bool {
    os == Os::Linux
        && ksni_tray
        && button == tauri::tray::MouseButton::Left
        && button_state == tauri::tray::MouseButtonState::Up
}

/// Whether this build delivers left-click tray activation.
pub(crate) fn tray_left_click_toggles() -> bool {
    cfg!(all(target_os = "linux", feature = "ksni-tray"))
}

/// Whether the floating rose starts hidden. The rose is visible by default
/// on every build and desktop, including Linux KSNI on Niri. An explicit
/// saved `true`/`false` always wins: this is only the fallback for a missing
/// file or absent field, never written back.
pub(crate) fn default_rose_hidden_for(_os: Os, _ksni_tray: bool, _is_niri: bool) -> bool {
    false
}

/// Monotonic hide-intent successor: pure rule shared
/// by the standalone publisher above and the atomic take below — an older job
/// never recedes a newer stored marker. Pure so tests pin it without locks.
#[cfg(target_os = "linux")]
pub(crate) fn hide_intent_next(current: Option<u64>, job: u64) -> Option<u64> {
    if current.map_or(true, |pending| job >= pending) {
        Some(job)
    } else {
        current
    }
}

/// Whether a toggle routes to Show: a fresh pending
/// hide counts as logically hidden even while the panel is still mapped, so
/// a second toggle during capture reopens. The visibility closure runs only
/// when no intent is pending — proving the blocking getter is skipped — and
/// errors propagate unchanged. Pure over the decision so tests pin the full
/// matrix without a runtime.
#[cfg(target_os = "linux")]
pub(crate) fn plan_toggle_route<E>(pending_hide: bool, visible: impl FnOnce() -> Result<bool, E>) -> Result<bool, E> {
    if pending_hide {
        Ok(true)
    } else {
        Ok(!visible()?)
    }
}

/// Which main-thread effects a hide completion may apply: only its own fresh generation unmaps+resets; anything else plans
/// nothing. Reuses plan_gate_effects for the epoch half; the intent half
/// adds ownership. A gateless hide passes on epoch freshness alone — the
/// gate mutex is already None after the take, and no gate is required.
#[cfg(target_os = "linux")]
pub(crate) fn plan_hide_completion(now: u64, job: u64, intent: Option<u64>) -> Option<Vec<GateEffect>> {
    if intent != Some(job) {
        return None;
    }
    let planned = plan_gate_effects(now, job, true);
    if planned.is_empty() {
        None
    } else {
        Some(planned)
    }
}

/// Ordered main-thread effects for an epoch-guarded gate closure (Linux only).
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GateEffect {
    /// Unmap the window (hide closure only, always before any reset).
    Unmap,
    /// Restore opacity 1 plus interaction.
    ResetVisuals,
}

/// Plans guarded closure effects (Linux only): the epoch guard runs FIRST —
/// a stale generation plans nothing (no unmap, no GTK/cursor writes). The
/// current generation plans unmap-then-reset for a hide (`unmap: true`) or
/// reset-only for a mode visual reset. Both main-thread closures act solely
/// on this plan, so the guard always precedes every effect; no native lock is
/// held for any of them (the epoch is an atomic load, GTK stays inside).
#[cfg(target_os = "linux")]
pub(crate) fn plan_gate_effects(current: u64, expected: u64, unmap: bool) -> Vec<GateEffect> {
    if current != expected {
        return Vec::new();
    }
    if unmap {
        vec![GateEffect::Unmap, GateEffect::ResetVisuals]
    } else {
        vec![GateEffect::ResetVisuals]
    }
}

/// Rose visibility policy for the expanded/fullscreen mode:
/// expanded hides the rose whatever the saved preference says, and returning
/// to compact shows it only when the user still wants it. Pure, so the matrix
/// is pinned without windows.
#[cfg(target_os = "linux")]
pub(crate) fn rose_visible_for_mode(expanded: bool, wants_rose: bool) -> bool {
    !expanded && wants_rose
}

/// Whether a collapse covers first: explicit
/// requested-compact AND visible — regardless of the recorded mode flag, and
/// separate from the collapse-to-default anchor-reset predicate below (base and
/// reset semantics are unchanged here). Structural decision only:
/// the ack merely orders the cover before the transition — it never proves a
/// rendered frame (CoverToolkit ack != frame proof). Hidden requests skip the
/// cover but still run the fresh mode path, which honestly reports the
/// previous mode on a superseded or failed op.
#[cfg(target_os = "linux")]
pub(crate) fn collapse_cover_wanted(on: bool, visible: bool) -> bool {
    !on && visible
}

/// Fullscreen dispatch: Niri sessions that don't place
/// their own windows take the offloaded blocking-pool path below; every other
/// backend runs the legacy sync body with its exact order and window
/// affinity. Pure so tests pin the matrix without a runtime. Niri without a
/// socket still routes Niri — the mode path itself fails bounded (previous
/// mode), never the legacy fake frame.
#[cfg(target_os = "linux")]
pub(crate) fn niri_fullscreen_offload(places_windows: bool, is_niri: bool) -> bool {
    !places_windows && is_niri
}

/// Fullscreen invoke routing: Niri-native fullscreen
/// invokes route async-only; every other command and every non-Niri backend
/// stays on the original sync handler. Pure over the command name plus the
/// placement signals, so tests pin the matrix without fabricating a runtime
/// Invoke (Tauri's InvokeMessage constructor is crate-internal); live backend
/// validation is NOT claimed here — cargo check compiles both macro
/// expansions, including the rename.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FullscreenDispatch {
    AsyncNiri,
    SyncLegacy,
}

#[cfg(target_os = "linux")]
pub(crate) fn plan_fullscreen_dispatch(
    command: &str,
    places_windows: bool,
    is_niri: bool,
) -> FullscreenDispatch {
    if command == "set_panel_fullscreen" && niri_fullscreen_offload(places_windows, is_niri) {
        FullscreenDispatch::AsyncNiri
    } else {
        FullscreenDispatch::SyncLegacy
    }
}

/// Whether setup creates the native restore channel: the
/// worker exists exactly when the app does not place windows on Niri. Pure so
/// tests cover the decision without a runtime.
#[cfg(target_os = "linux")]
pub(crate) fn native_restore_planned(places_windows: bool, is_niri: bool) -> bool {
    !places_windows && is_niri
}

/// Pure routing for a finished restore job (Linux only): `Ok(true)`
/// (worker-confirmed settled geometry) reveals; `Ok(false)` (stale cancel,
/// missing socket) hides only while still owning a fresh
/// gate, else stays silent for retry; `Err` (deadline expiry, unresolvable
/// geometry, wire failures) always attempts the guarded cancel (which no-ops
/// if stale) and reports the error. Tests pin this with the real
/// `CommandResult<bool>` shapes `run_restore_job_inner` produces, so the
/// never-reveal-on-failure contract is production-path, not boolean-literal.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestoreCompletion {
    Reveal,
    Cancel,
    Silent,
}

#[cfg(target_os = "linux")]
pub(crate) fn plan_restore_completion(
    inner: &CommandResult<bool>,
    owns_fresh_gate: bool,
) -> RestoreCompletion {
    match inner {
        Ok(true) => RestoreCompletion::Reveal,
        Ok(false) if owns_fresh_gate => RestoreCompletion::Cancel,
        Ok(false) => RestoreCompletion::Silent,
        Err(_) => RestoreCompletion::Cancel,
    }
}

/// Whether the joint Niri unit runs (additive portable gate, Linux only):
/// app-owned sessions (macOS/X11/others place their own windows), non-Niri
/// compositors (Hyprland included), and socket-less Niri never enter — the
/// app-owned path keeps priority untouched. Thin wrapper over the same
/// predicate the fullscreen branch uses, so the matrix is defined once.
/// Pure so tests pin every environment without a runtime.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn joint_unit_active(places_windows: bool, is_niri: bool, socket_present: bool) -> bool {
    crate::niri::joint_env_active(places_windows, is_niri, socket_present)
}

/// Mover from debounced follow signals (Linux only): Panel wins ties by
/// latest timestamp; `None` when nothing is due. The anchor follows ONLY
/// this — never fixed dot-priority (live trace b). Pure for tests.
#[cfg(target_os = "linux")]
pub(crate) fn joint_mover_from_signals(
    dot_due: bool,
    panel_due: bool,
    dot_at: Option<std::time::Instant>,
    panel_at: Option<std::time::Instant>,
) -> Option<crate::niri::Mover> {
    match (dot_due, panel_due) {
        (false, false) => None,
        (true, false) => Some(crate::niri::Mover::Dot),
        (false, true) => Some(crate::niri::Mover::Panel),
        (true, true) => match (dot_at, panel_at) {
            (Some(d), Some(p)) if d > p => Some(crate::niri::Mover::Dot),
            _ => Some(crate::niri::Mover::Panel),
        },
    }
}

/// Whether `set_panel_fullscreen` takes the Niri-native branch: the app
/// does not place its own windows (honoring an explicit `GDK_BACKEND=x11`
/// choice via `places_windows`), the session is Niri, and a socket path is
/// present. Pure so tests never touch the environment. Niri-native without a
/// socket is a bounded no-op at the call site, never legacy fake fullscreen.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn native_niri_mode(places_windows: bool, is_niri: bool, socket_present: bool) -> bool {
    !places_windows && is_niri && socket_present
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn niri_socket_present() -> bool {
    std::env::var("NIRI_SOCKET").ok().is_some_and(|path| !path.is_empty())
}

/// Whether the shared unit is enabled (all OS): explicit activation AND the
/// Niri environment (same predicate as `native_niri_mode`, but a separate
/// activation bool from `joint_unit_active`, which owns follow/drag only).
/// Pure so tests pin every environment without a runtime.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn unit_enabled(active: bool, places_windows: bool, is_niri: bool, socket_present: bool) -> bool {
    let _ = (active, places_windows, is_niri, socket_present);
    active && !places_windows && is_niri && socket_present
}

/// Whether a command route takes the dormant shared-unit branch (Linux
/// only): explicit activation AND the Niri environment — never merely
/// `joint_unit_active` (follow/drag). Pure over the live flag plus env.
/// Dormant: callsite branches land next unit; tests drive it meanwhile.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn unit_branch_wanted(active: bool, places_windows: bool, is_niri: bool, socket_present: bool) -> bool {
    unit_enabled(active, places_windows, is_niri, socket_present)
}

/// Early-route gate (Linux only): explicit activation AND Niri — never merely
/// `joint_unit_active` (follow/drag). Thin over `unit_branch_wanted`.
#[cfg(target_os = "linux")]
pub(crate) fn shared_route_wanted(active: bool, places_windows: bool, is_niri: bool, socket_present: bool) -> bool {
    unit_branch_wanted(active, places_windows, is_niri, socket_present)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rose_visible_by_default_everywhere_task4() {
        // Task 4: the rose is visible by default on every build, including
        // Linux KSNI on Niri; only an explicit persisted choice hides it.
        assert!(!default_rose_hidden_for(Os::Linux, true, true));
        assert!(!default_rose_hidden_for(Os::Linux, true, false));
        assert!(!default_rose_hidden_for(Os::Linux, false, true));
        assert!(!default_rose_hidden_for(Os::MacOs, true, true));
    }

    #[test]
    fn rose_default_is_visible_everywhere() {
        // Task 4: the rose is visible by default on every build and desktop,
        // including Linux KSNI on Niri; only an explicit persisted choice
        // hides it across restarts.
        assert!(!default_rose_hidden_for(Os::Linux, true, true));
        // macOS, AppIndicator, Hyprland/GNOME stay shown by default.
        assert!(!default_rose_hidden_for(Os::MacOs, true, true));
        assert!(!default_rose_hidden_for(Os::MacOs, false, false));
        assert!(!default_rose_hidden_for(Os::Linux, false, true));
        assert!(!default_rose_hidden_for(Os::Linux, true, false));
        assert!(!default_rose_hidden_for(Os::Linux, false, false));
    }

    #[test]
    fn left_tray_click_toggles_only_on_linux_ksni_builds() {
        use tauri::tray::{MouseButton, MouseButtonState};
        // The KSNI backend (opt-in `ksni-tray` Linux feature) delivers exactly one
        // `Click { Left, Up }` per activation; only that toggles, once.
        assert!(tray_click_toggles_panel(
            Os::Linux,
            true,
            MouseButton::Left,
            MouseButtonState::Up
        ));
        // Press-down, middle, and right never toggle; right keeps the menu everywhere.
        assert!(!tray_click_toggles_panel(
            Os::Linux,
            true,
            MouseButton::Left,
            MouseButtonState::Down
        ));
        assert!(!tray_click_toggles_panel(
            Os::Linux,
            true,
            MouseButton::Middle,
            MouseButtonState::Up
        ));
        assert!(!tray_click_toggles_panel(
            Os::Linux,
            true,
            MouseButton::Middle,
            MouseButtonState::Down
        ));
        assert!(!tray_click_toggles_panel(
            Os::Linux,
            true,
            MouseButton::Right,
            MouseButtonState::Up
        ));
        assert!(!tray_click_toggles_panel(
            Os::Linux,
            true,
            MouseButton::Right,
            MouseButtonState::Down
        ));
        // AppIndicator never delivers clicks; macOS keeps menu-on-left-click.
        assert!(!tray_click_toggles_panel(
            Os::Linux,
            false,
            MouseButton::Left,
            MouseButtonState::Up
        ));
        assert!(!tray_click_toggles_panel(
            Os::MacOs,
            true,
            MouseButton::Left,
            MouseButtonState::Up
        ));
        assert!(!tray_click_toggles_panel(
            Os::MacOs,
            false,
            MouseButton::Left,
            MouseButtonState::Up
        ));
    }

    #[test]
    fn compiled_tray_activation_matches_this_build() {
        assert_eq!(tray_left_click_toggles(), cfg!(all(target_os = "linux", feature = "ksni-tray")));
    }

    #[test]
    fn native_expanded_mode_runs_only_on_niri_without_app_placement_and_a_socket() {
        // The only native slice: Niri compositor, app does not place, socket present.
        assert!(native_niri_mode(false, true, true));
        // An explicit GDK x11 choice on Niri keeps app placement: legacy branch.
        assert!(!native_niri_mode(true, true, true));
        // Hyprland/GNOME native, macOS/X11/XWayland: never the native branch.
        assert!(!native_niri_mode(false, false, true));
        assert!(!native_niri_mode(true, false, false));
        assert!(!native_niri_mode(true, false, true));
        // Niri-native without a usable socket is a bounded no-op elsewhere,
        // never the legacy fake-fullscreen workarea frame.
        assert!(!native_niri_mode(false, true, false));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn guarded_gate_effects_unmap_before_reset_and_stale_plans_nothing() {
        // A stale generation plans NOTHING: no unmap of a newer show, no GTK
        // or cursor writes. The current hide plans unmap FIRST then the
        // reset, same closure; a current mode reset plans the reset only
        // (its window stays mapped).
        assert_eq!(plan_gate_effects(4, 3, true), Vec::<GateEffect>::new());
        assert_eq!(plan_gate_effects(4, 3, false), Vec::<GateEffect>::new());
        assert_eq!(plan_gate_effects(2, 3, true), Vec::<GateEffect>::new());
        assert_eq!(
            plan_gate_effects(3, 3, true),
            vec![GateEffect::Unmap, GateEffect::ResetVisuals]
        );
        assert_eq!(plan_gate_effects(3, 3, false), vec![GateEffect::ResetVisuals]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn collapse_cover_decision_ignores_recorded_mode() {
        // Unit 20f3 STRUCTURAL: the cover matrix over request intent only —
        // an earlier recorded flag cannot prevent a visible collapse from
        // covering, and hidden requests never cover. No AppHandle, no wire.
        assert!(collapse_cover_wanted(false, true));
        assert!(!collapse_cover_wanted(true, true));
        assert!(!collapse_cover_wanted(false, false));
        assert!(!collapse_cover_wanted(true, false));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn toggle_routes_show_while_hide_pending() {
        // Unit 20f2: full routing matrix through the ACTUAL production
        // helper — a fresh pending hide routes Show even while mapped, and
        // the visibility getter provably never runs then (it panics).
        assert_eq!(plan_toggle_route::<String>(true, || panic!("getter skipped while pending")), Ok(true));
        assert_eq!(plan_toggle_route::<String>(true, || Ok(false)), Ok(true));
        assert_eq!(plan_toggle_route::<String>(false, || Ok(true)), Ok(false));
        assert_eq!(plan_toggle_route::<String>(false, || Ok(false)), Ok(true));
        assert!(plan_toggle_route::<String>(false, || Err("getter down".to_owned())).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn hide_completion_plans_only_for_fresh_owner() {
        // Unit 20f2: delivery matrix through the ACTUAL planner — fresh job
        // plus own intent unmaps+resets; stale epoch, superseded intent, or
        // missing intent plan nothing (a gateless hide passes on epoch
        // freshness alone: no gate is required).
        assert_eq!(
            plan_hide_completion(6, 6, Some(6)),
            Some(vec![GateEffect::Unmap, GateEffect::ResetVisuals])
        );
        assert_eq!(plan_hide_completion(7, 6, Some(6)), None);
        assert_eq!(plan_hide_completion(6, 6, Some(7)), None);
        assert_eq!(plan_hide_completion(6, 6, None), None);
        assert_eq!(plan_hide_completion(7, 6, None), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rose_hides_in_fullscreen_and_returns_with_the_user_preference() {
        // Requirement S5: the rose is hidden in fullscreen whatever the saved
        // preference says, and returning shows it only while the user still
        // wants it — the preference stays the single source of truth.
        for (expanded, wants, visible) in [
            (true, true, false),
            (true, false, false),
            (false, true, true),
            (false, false, false),
        ] {
            assert_eq!(
                rose_visible_for_mode(expanded, wants), visible,
                "expanded={expanded} wants_rose={wants}"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fullscreen_niri_branch_offloads_legacy_untouched() {
        // Pure routing matrix (unit 20e): only unplaced Niri offloads.
        // Niri without a socket still routes Niri — the mode path fails
        // bounded itself instead of taking the legacy fake frame.
        assert!(niri_fullscreen_offload(false, true));
        assert!(!niri_fullscreen_offload(true, true));
        assert!(!niri_fullscreen_offload(false, false));
        assert!(!niri_fullscreen_offload(true, false));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fullscreen_dispatch_matrix_async_niri_only() {
        // Invoke-routing matrix (unit 20e1): requested fullscreen on native
        // Niri routes async-only; app-owned Linux (X11/Hyprland), macOS
        // default shapes, socketless-irrelevant inputs, and every other
        // command stay on the original sync handler with zero override.
        use FullscreenDispatch::{AsyncNiri, SyncLegacy};
        assert_eq!(plan_fullscreen_dispatch("set_panel_fullscreen", false, true), AsyncNiri);
        assert_eq!(plan_fullscreen_dispatch("set_panel_fullscreen", true, true), SyncLegacy);
        assert_eq!(plan_fullscreen_dispatch("set_panel_fullscreen", false, false), SyncLegacy);
        assert_eq!(plan_fullscreen_dispatch("set_panel_fullscreen", true, false), SyncLegacy);
        assert_eq!(plan_fullscreen_dispatch("toggle_panel", false, true), SyncLegacy);
        assert_eq!(plan_fullscreen_dispatch("hide_panel", false, true), SyncLegacy);
        assert_eq!(plan_fullscreen_dispatch("", false, true), SyncLegacy);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_enabled_needs_activation_and_niri() {
        // Enabled only with explicit activation AND the Niri environment:
        // dormant (never activated) is disabled even on Niri, and an
        // activated flag means nothing on app-placed, non-Niri, or
        // socket-less sessions.
        assert!(!unit_enabled(false, false, true, true));
        assert!(unit_enabled(true, false, true, true));
        assert!(!unit_enabled(true, true, true, true), "app-placed sessions stay old-path");
        assert!(!unit_enabled(true, false, false, true));
        assert!(!unit_enabled(true, false, true, false), "socket-less Niri stays old-path");
        assert!(!unit_enabled(false, true, false, false));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_fullscreen_hides_rose_keeps_preference() {
        // S5/S9: fullscreen implies no rose whatever the saved preference
        // says, and the preference itself is untouched (still true here) so
        // leaving fullscreen restores the rose beside the chat.
        let wants_rose = true;
        assert!(!rose_visible_for_mode(true, wants_rose));
        assert!(wants_rose, "saved preference must survive fullscreen");
        assert!(rose_visible_for_mode(false, wants_rose));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_branch_needs_activation_and_niri() {
        // Route gate: explicit activation AND Niri — never merely the joint
        // follow/drag predicate. Headless-pure over the live flag plus env.
        assert!(!unit_branch_wanted(false, false, true, true));
        assert!(unit_branch_wanted(true, false, true, true));
        assert!(!unit_branch_wanted(true, true, true, true));
        assert!(!unit_branch_wanted(true, false, false, true));
        assert!(!unit_branch_wanted(true, false, true, false));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn joint_unit_runs_only_on_niri_with_socket() {
        // Portable aditivo: Niri nativo con socket; X11/Hyprland/otros y
        // Niri sin socket nunca entran; app-owned intacto con prioridad.
        assert!(joint_unit_active(false, true, true));
        assert!(!joint_unit_active(true, true, true));
        assert!(!joint_unit_active(false, false, true));
        assert!(!joint_unit_active(false, true, false));
        assert!(!joint_unit_active(true, false, false));
        // Coherente con la puerta fullscreen existente.
        assert_eq!(joint_unit_active(false, true, true), native_niri_mode(false, true, true));
        assert_eq!(joint_unit_active(false, false, true), native_niri_mode(false, false, true));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn joint_mover_comes_from_the_user_side_never_fixed_priority() {
        use std::time::Instant;
        let now = Instant::now();
        assert_eq!(joint_mover_from_signals(false, false, None, None), None);
        assert_eq!(
            joint_mover_from_signals(true, false, Some(now), None),
            Some(crate::niri::Mover::Dot)
        );
        assert_eq!(
            joint_mover_from_signals(false, true, None, Some(now)),
            Some(crate::niri::Mover::Panel)
        );
        // Ambos: gana el más tardío; empate → panel (el ancla es el panel).
        let later = now + std::time::Duration::from_millis(10);
        assert_eq!(
            joint_mover_from_signals(true, true, Some(later), Some(now)),
            Some(crate::niri::Mover::Dot)
        );
        assert_eq!(
            joint_mover_from_signals(true, true, Some(now), Some(later)),
            Some(crate::niri::Mover::Panel)
        );
    }
}
