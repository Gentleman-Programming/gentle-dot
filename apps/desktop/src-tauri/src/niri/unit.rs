//! Slice 4d dormant shared-surface runners (`niri-surface`).
//!
//! Behavior-neutral extraction from `1d239a6` (`niri/unit.rs`): the legacy
//! session route, the startup plan and compact-mode planner, the shared
//! restore/surface predicates, the bounded render/animation waits, the
//! mapped size settle and the cached/uncached single-panel restore sequence.
//! The routing/state planners already live in `route_gate`/`unit_state` and
//! are not redefined here; the `Shell` driver stays in shell.rs, so the
//! module stays `allow(dead_code)` until the wiring slices land.

use crate::platform;
#[cfg(target_os = "linux")]
use std::sync::Mutex;
#[cfg(target_os = "linux")]
use crate::niri::gate::*;
#[cfg(target_os = "linux")]
use crate::niri::gate::niri_trace;
#[cfg(target_os = "linux")]
use crate::niri::CompactSpot;
#[cfg(target_os = "linux")]
use std::thread;
#[cfg(target_os = "linux")]
use std::time::Duration;

/// The five legacy toggle/hide/shortcut/show branches route on the session
/// alone: deliberately WITHOUT the socket requirement, which is today's
/// observable behaviour there. The unit route requires the socket instead
/// via `native_niri_mode`; the two predicates must stay distinct.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn niri_route_env(places_windows: bool) -> bool {
    !places_windows && platform::is_niri(&|key| std::env::var(key).ok())
}

/// Startup plan for the single surface (Linux only): a fresh process never
/// opens chat, so RoseOnly sizing either way; the map decision is the closed
/// twin of `unit_window_for` — mapped rose, parked hidden rose.
#[cfg(target_os = "linux")]
pub(crate) struct SharedStartup {
    pub(crate) size: (i32, i32),
    pub(crate) map: bool,
}

/// Compact mode from logical state (Linux only): effective fullscreen wins
/// whatever the saved preference says (the rose is then hidden by
/// `rose_visible_for_mode`, the preference itself untouched); an open chat
/// pairs with a shown rose and stands alone with a hidden one; a closed
/// chat maps RoseOnly even with stored desired expanded — logical open,
/// never GTK mapped visibility, decides. Dormant: no builder consumes modes yet.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn unit_mode_for(
    open: bool,
    rose_hidden: bool,
    expanded: bool,
) -> crate::niri::unit_surface::UnitMode {
    use crate::niri::unit_surface::UnitMode;
    if open && expanded {
        UnitMode::Fullscreen
    } else if open && rose_hidden {
        UnitMode::PanelOnly
    } else if open {
        UnitMode::Pair
    } else {
        UnitMode::RoseOnly
    }
}

/// Shared-surface worker route core: execution
/// adapter plus readiness/resize contract. ONE exact PANEL surface, no DOT
/// queries/moves/follow (`unit_restore` moves the exact panel id; the seam
/// tests assert every move id is the panel). Anchor stays `native_compact`;
/// drag commits separately via `commit_dragged_anchor`. `active` stays FALSE,
/// so old two-window/non-Niri paths stay byte-identical.
/// Partition: predicate, mode/shape contracts, render-ack wait, ordered
/// sequence seam, drag commit, and the AppHandle runtime below. Builder and
/// follow activation stay next unit; `active` remains FALSE, no rollout.
#[cfg(target_os = "linux")]
pub(crate) fn shared_restore_mode(
    open: bool,
    rose_hidden: bool,
    expanded: bool,
) -> crate::niri::unit_restore::UnitRestoreMode {
    use crate::niri::unit_restore::UnitRestoreMode as R;
    // Effective-closed fullscreen reads RoseOnly (stored expanded preserved
    // for reopen; Hide glue unmaps the hidden-rose close separately).
    if open && expanded {
        R::Fullscreen
    } else if open && rose_hidden {
        R::PanelOnly
    } else if open {
        R::Pair
    } else {
        R::RoseOnly
    }
}

/// Surface-mode twin (Linux only): the GTK input region reapplied after
/// reveal/reset (the Tauri cursor proxy overwrites the widget shape).
#[cfg(target_os = "linux")]
pub(crate) fn shared_surface_mode(
    mode: crate::niri::unit_restore::UnitRestoreMode,
) -> Option<crate::niri::unit_surface::UnitMode> {
    use crate::niri::unit_restore::UnitRestoreMode as R;
    use crate::niri::unit_surface::UnitMode as U;
    match mode {
        R::Pair => Some(U::Pair),
        R::PanelOnly => Some(U::PanelOnly),
        R::RoseOnly => Some(U::RoseOnly),
        R::Fullscreen => Some(U::Fullscreen),
    }
}

/// Sequenced outcome (Linux only): `Revealed` carries the preserved PANEL
/// anchor for the gate-owned commit (`None`: managed fullscreen with no stored
/// anchor); `Silent` is stale (no effect); `Cancelled` is exact-owned failure.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SharedOutcome {
    Revealed(Option<CompactSpot>),
    Silent,
    Cancelled(&'static str),
}

/// Bounded render-ack wait (Linux only): polls `ready` (fresh
/// `unit_ready_for` in production) outside state locks; stale stops at once.
#[cfg(target_os = "linux")]
pub(crate) fn await_shared_render(
    fresh: &impl Fn() -> bool,
    ready: &mut impl FnMut() -> bool,
    budget: Duration,
) -> bool {
    let start = std::time::Instant::now();
    loop {
        if !fresh() {
            return false;
        }
        if ready() {
            return fresh();
        }
        if start.elapsed() >= budget {
            return false;
        }
        thread::sleep(clipped_poll(budget.saturating_sub(start.elapsed())));
    }
}

/// Bounded move-animation settle: Niri animates floating
/// moves (`move_floating_window(..., true)`) while IPC omits the animated
/// offset, so the cover stays through this bounded budget before reveal.
/// Freshness-checked polls only; never an unbounded sleep, never a rendered
/// proof claim. Returns false when superseded (caller goes Silent).
#[cfg(target_os = "linux")]
const NATIVE_ANIMATION_SETTLE: Duration = Duration::from_millis(350);

#[cfg(target_os = "linux")]
pub(crate) fn await_shared_animation(fresh: &impl Fn() -> bool, budget: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < budget {
        if !fresh() {
            return false;
        }
        thread::sleep(clipped_poll(budget.saturating_sub(start.elapsed())));
    }
    fresh()
}

/// Capture guard: config-independent. A raw wire
/// position becomes the remembered anchor ONLY when (a) this process has
/// already completed a placement it commanded — witnessed by a remembered
/// anchor, which is in-session-only and is written solely by worker-finish,
/// drag, and capture commits, never loaded from disk — so a compositor
/// fresh-map base can never SEED the anchor (first placement belongs to the
/// explicit Bootstrap path, which moves the exact id and commits its own
/// result); and (b) the candidate differs from that remembered anchor, so
/// an IPC echo of our own last commanded placement is never mistaken for a
/// new one. No output size, scale, work area, margin, or coordinate
/// constant is consulted: the same predicate holds on every output and
/// margin config, and the mapped-only pipeline (no remap after prepare)
/// means a fresh base cannot appear mid-session while an anchor exists.
/// Exact float equality is deliberate: the translation is a deterministic
/// function of the wire values, so a true echo compares equal and any real
/// drag — however small — differs and still captures.
/// (Replaces four exact (size,x,y) pairs lifted from one 2560-wide trace,
/// which silently disabled on any other geometry.)
#[cfg(target_os = "linux")]
pub(crate) fn shared_capture_is_transient(remembered: Option<&CompactSpot>, candidate: &CompactSpot) -> bool {
    let Some(remembered) = remembered else {
        return true;
    };
    remembered.output == candidate.output
        && remembered.x == candidate.x
        && remembered.y == candidate.y
}

/// Rose-toggle gate in the expanded (fullscreen-covering) mode: fullscreen
/// implies no rose, so the shared branch must not start a transition there.
#[cfg(target_os = "linux")]
pub(crate) fn shared_rose_toggle_allowed(expanded: bool) -> bool {
    !expanded
}

/// Whether a shared job reveals at opacity 1 (Linux only): opens reveal;
/// a close reveals the rose-only surface while the rose is wanted and stays
/// covered only when both chat and rose are hidden (open=false AND
/// rose_hidden=true — nothing left to show). The saved rose preference
/// itself is never flipped here: closing the chat never hides the rose.
/// Fullscreen is untouched (hides the rose there without preference
/// change). Pure so tests pin it.
#[cfg(target_os = "linux")]
pub(crate) fn shared_job_reveals(open: bool, rose_hidden: bool) -> bool {
    open || !rose_hidden
}

/// Bounded native client-size settle (Linux/Niri only): GTK supplies size
/// constraints and the exact owned floating id receives compositor configure
/// actions. Re-query `window_size` before accepting; `Handled` alone is not
/// proof. Prepared frames never remap. The pre-prepare recovery may still
/// remap once, bounded by the job and per-settle budgets (`shared_settle_budget()`):
/// `None` continues the sequence; `Some` is terminal: stale generations stay
/// `Silent` (no effect), a failed toolkit step keeps the step's existing
/// cancel reason, and an exhausted budget cancels `unit size unsettled`
/// (expected vs observed go to the log). Each observed size transition is
/// traced with elapsed ms since the job start. Never moves anything: the
/// caller only proceeds to `prepare`/`finish` once the exact expected size
/// is observed. Remap-allowing wrapper: the helper test pins the remap
/// path; mapped-only production calls `settle_shared_size_policy` with
/// `allow_remap=false` and cancels honest instead of silently remapping.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn settle_shared_size(
    expected: (i32, i32),
    unacked: &'static str,
    pid: u32,
    start: std::time::Instant,
    budget: Duration,
    fresh: &impl Fn() -> bool,
    resize: &mut impl FnMut((i32, i32)) -> bool,
    hide: &mut impl FnMut() -> bool,
    show: &mut impl FnMut() -> bool,
    request: &mut impl FnMut(&str, Duration) -> std::io::Result<serde_json::Value>,
) -> Option<SharedOutcome> {
    settle_shared_size_policy(expected, unacked, pid, start, budget, fresh, resize, hide, show, request, true)
}

/// Once preparation pins an id, a resize must keep that mapping alive.
#[cfg(target_os = "linux")]
pub(crate) fn settle_shared_size_policy(
    expected: (i32, i32), unacked: &'static str, pid: u32,
    start: std::time::Instant, budget: Duration,
    fresh: &impl Fn() -> bool,
    resize: &mut impl FnMut((i32, i32)) -> bool,
    hide: &mut impl FnMut() -> bool, show: &mut impl FnMut() -> bool,
    request: &mut impl FnMut(&str, Duration) -> std::io::Result<serde_json::Value>,
    allow_remap: bool,
) -> Option<SharedOutcome> {
    let settle_budget = shared_settle_budget();
    let settle_start = std::time::Instant::now();
    let mut observed: Option<(i32, i32)> = None;
    let mut remapped = false;
    loop {
        if !fresh() {
            return Some(SharedOutcome::Silent);
        }
        let remaining = budget.saturating_sub(start.elapsed()).min(settle_budget.saturating_sub(settle_start.elapsed()));
        if remaining.is_zero() {
            eprintln!("gentle-dot: shared size unsettled expected={expected:?} observed={observed:?}");
            return Some(SharedOutcome::Cancelled("unit size unsettled"));
        }
        match request(crate::niri::WINDOWS_REQUEST, remaining.min(NATIVE_RESTORE_PASS)) {
            Ok(windows) => {
                if let Some(panel) = crate::niri::own_panel_window(&windows, pid) {
                    if Some(panel.size) != observed {
                        niri_trace!("shared settle expected={expected:?} observed={:?} elapsed_ms={}", panel.size, start.elapsed().as_millis());
                        observed = Some(panel.size);
                    }
                    if panel.size == expected {
                        return None;
                    }
                    if panel.floating {
                        // GTK updates constraints; Niri owns the configure.
                        // Never substitute remapping for a prepared identity.
                        for wire in crate::niri::action_fixed_geometry(panel.id, expected) {
                            if !fresh() { return Some(SharedOutcome::Silent); }
                            let left = budget.saturating_sub(start.elapsed())
                                .min(settle_budget.saturating_sub(settle_start.elapsed()));
                            if left.is_zero() {
                                return Some(SharedOutcome::Cancelled("unit size unsettled"));
                            }
                            match request(&wire, left.min(NATIVE_RESTORE_PASS)) {
                                Ok(reply) if crate::niri::is_handled(&reply) => {}
                                Ok(_) => return Some(SharedOutcome::Cancelled("unit size request rejected")),
                                Err(_) if !fresh() => return Some(SharedOutcome::Silent),
                                Err(_) => return Some(SharedOutcome::Cancelled("unit size request failed")),
                            }
                        }
                    }
                }
            }
            Err(_) => {}
        }
        if !fresh() {
            return Some(SharedOutcome::Silent);
        }
        if allow_remap && !remapped && settle_start.elapsed() >= NATIVE_SETTLE_REMAP_AFTER {
            if !hide() {
                return Some(SharedOutcome::Cancelled(unacked));
            }
            if !show() {
                return Some(SharedOutcome::Cancelled(unacked));
            }
            remapped = true;
            niri_trace!("shared settle remap expected={expected:?} elapsed_ms={}", start.elapsed().as_millis());
            thread::sleep(clipped_poll(remaining));
            continue;
        }
        if !resize(expected) {
            return Some(SharedOutcome::Cancelled(unacked));
        }
        thread::sleep(clipped_poll(budget.saturating_sub(start.elapsed()).min(settle_budget.saturating_sub(settle_start.elapsed()))));
    }
}

/// Single-PANEL restore sequence (Linux only): the production seam behind the
/// shared worker. MAPPED-ONLY: size plus opacity plus input only —
/// never hide()/show() (no unmap/remap, no None gap, stable Niri id). Order:
/// cover-ack -> exact-id refloat (compact only) -> constraint release (mapped,
/// via SharedNativeOps::apply_size_policy) -> pinned 420x640 (mapped settle,
/// no remap) -> `prepare` (fresh work-area) -> mapped mode resize (500/420/72)
/// -> mapped settle without remapping -> `finish` (tile + identity +
/// move/requery, still covered so the base 2036,56/2464,56 and the fallback
/// 2485,1365 are never a visible intermediate) -> bounded move-animation
/// settle (cover stays; IPC omits the animated offset) -> bounded render-ack
/// -> reveal (opens only) or covered (closes stay at opacity 0). A size that
/// never settles while mapped cancels honest (`unit size unsettled`) instead
/// of silently remapping. The release is mandatory: GTK clamps `set_size`
/// to the pinned min=max while the window is non-resizable (how it is built,
/// and how reveal leaves it), so sizing before releasing would silently keep
/// the previous frame. No step after preparation replaces the validated
/// mapping: Wayland size requests commit asynchronously, while hide/show
/// would replace the Niri id captured by preparation. Lock-free:
/// GTK/ack closures run outside state locks; the caller commits the anchor
/// under gate/epoch only when fresh. Fullscreen verifies identity with zero
/// moves and preserves the anchor. RoseOnly mode implies closed: it ends
/// covered with no render-ack wait and no reveal.
/// Uncached entry: every transition probes, exactly as before. Cached
/// callers use `run_shared_unit_sequence_cached` directly.
#[cfg(target_os = "linux")]
#[allow(dead_code)] // production routes through the cached variant; tests pin both.
pub(crate) fn run_shared_unit_sequence(
    pid: u32,
    anchor: Option<&CompactSpot>,
    mode: crate::niri::unit_restore::UnitRestoreMode,
    rose_hidden: bool,
    gap: i32,
    margin: f64,
    budget: Duration,
    fresh: impl Fn() -> bool,
    cover: &mut impl FnMut() -> bool,
    release: &mut impl FnMut() -> bool,
    resize: &mut impl FnMut((i32, i32)) -> bool,
    hide: &mut impl FnMut() -> bool,
    show: &mut impl FnMut() -> bool,
    request: &mut impl FnMut(&str, Duration) -> std::io::Result<serde_json::Value>,
    render_ready: &mut impl FnMut() -> bool,
    steps: &mut Vec<&'static str>,
) -> SharedOutcome {
    let mut sink = None;
    let mut sink_clear = false;
    run_shared_unit_sequence_cached(pid, anchor, mode, rose_hidden, gap, margin, budget, fresh,
        cover, release, resize, hide, show, request, render_ready, steps, None, &mut sink, &mut sink_clear)
}

/// Cached restore lookup: read-only queries inside the
/// caller's job budget — zero moves. Returns a finish-ready plan when the
/// live output still matches the cached layout key, the live layer set still
/// matches the recorded one, and the remembered anchor sits on that output;
/// `None` (miss) on anything else, including a missing anchor (bootstrap must
/// probe), a key or layer-set change, a no-fit target, or any query error —
/// the caller then runs the probe path, which refreshes the cache.
/// Stale generations also miss here; the probe path's `prepare` reports them
/// Silent without sending anything further. The remembered anchor is reused
/// verbatim and never re-derived from a probe position.
#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
pub(crate) fn cached_unit_restore(
    pid: u32,
    anchor: Option<&CompactSpot>,
    mode: crate::niri::unit_restore::UnitRestoreMode,
    cached: &crate::niri::unit_restore::CachedCalibration,
    gap: i32,
    margin: f64,
    budget: Duration,
    fresh: &impl Fn() -> bool,
    request: &mut impl FnMut(&str, Duration) -> std::io::Result<serde_json::Value>,
) -> Option<crate::niri::unit_restore::PreparedRestore> {
    use crate::niri::unit_restore::UnitRestoreMode as R;
    if mode == R::Fullscreen || !fresh() {
        return None;
    }
    let anchor = anchor?;
    if anchor.output.is_empty() {
        return None;
    }
    let start = std::time::Instant::now();
    let remaining = || budget.saturating_sub(start.elapsed());
    let windows = request(crate::niri::WINDOWS_REQUEST, remaining().min(NATIVE_RESTORE_PASS)).ok()?;
    let panel = crate::niri::own_panel_window(&windows, pid).filter(|window| window.floating)?;
    if !fresh() {
        return None;
    }
    let workspaces = request(crate::niri::WORKSPACES_REQUEST, remaining().min(NATIVE_RESTORE_PASS)).ok()?;
    let output = crate::niri::workspace_output(&workspaces, panel.workspace)?;
    if output != anchor.output || output != cached.key.output {
        return None;
    }
    let outputs = request(crate::niri::unit_restore::OUTPUTS_REQUEST, remaining().min(NATIVE_RESTORE_PASS)).ok()?;
    if crate::niri::unit_restore::output_key(&outputs, &output).as_ref() != Some(&cached.key) {
        return None;
    }
    // A failed Layers query forces a probe rather than reusing an unverified
    // entry; the finish-time position check stays the safety net either way.
    let layers = request(crate::niri::unit_restore::LAYERS_REQUEST, remaining().min(NATIVE_RESTORE_PASS)).ok()?;
    let live = crate::niri::unit_restore::layer_snapshot(&layers)?;
    if live != cached.layers {
        return None;
    }
    if mode == R::RoseOnly && cached.panel_offset.is_none() {
        return None;
    }
    let size = crate::niri::unit_restore::surface_size(mode)?;
    let surface_target =
        crate::niri::unit_restore::plan_surface_target(anchor, mode, &cached.area, margin)?;
    Some(crate::niri::unit_restore::PreparedRestore {
        pid,
        mode,
        measured: crate::niri::unit_restore::MeasuredArea {
            output,
            workspace: panel.workspace,
            panel_id: panel.id,
            area: cached.area,
            panel_offset: cached.panel_offset,
        },
        surface_target,
        remembered: anchor.clone(),
        surface_size: size,
        gap,
        margin,
        bootstrapped: false,
    })
}

/// Cache refresh after a successful probe: one Outputs
/// query plus one read-only Layers query inside the job budget; writes
/// `cache_out` only while fresh with a valid key. Query failures leave the
/// previous cache untouched — a failed probe never poisons the cache with a
/// partial measurement.
#[cfg(target_os = "linux")]
pub(crate) fn refresh_unit_cache(
    prepared: &crate::niri::unit_restore::PreparedRestore,
    budget: Duration,
    fresh: &impl Fn() -> bool,
    request: &mut impl FnMut(&str, Duration) -> std::io::Result<serde_json::Value>,
    cache_out: &mut Option<crate::niri::unit_restore::CachedCalibration>,
) {
    if !fresh() {
        return;
    }
    let Ok(outputs) = request(crate::niri::unit_restore::OUTPUTS_REQUEST, budget.min(NATIVE_RESTORE_PASS)) else {
        return;
    };
    if !fresh() {
        return;
    }
    let Some(key) = crate::niri::unit_restore::output_key(&outputs, &prepared.measured.output) else {
        return;
    };
    let Ok(layers) = request(crate::niri::unit_restore::LAYERS_REQUEST, budget.min(NATIVE_RESTORE_PASS)) else {
        return;
    };
    if !fresh() {
        return;
    }
    let Some(layers) = crate::niri::unit_restore::layer_snapshot(&layers) else {
        return;
    };
    *cache_out = Some(crate::niri::unit_restore::CachedCalibration {
        key,
        area: prepared.measured.area,
        panel_offset: prepared.measured.panel_offset,
        layers,
    });
}

/// Environment-change invalidation: a `ConfigLoaded`
/// reload (a live 26.04 event) may move the work area while the remembered
/// anchor stays legal, so the finish re-query can never fire. The `Layers`
/// event arm stays only for future niri versions — 26.04 exposes `Layers`
/// solely as a request/response pair, and the live mechanism is the
/// read-only query on each cache hit — so a bar change without a reload is
/// caught there, not here.
/// Drops the stored calibration under the gate lock so the next transition
/// re-probes once and re-fills the entry; a stale generation (`fresh()`
/// false) clears nothing and records nothing. Pure decision lives in
/// `unit_restore::environment_invalidates`; this only applies the effect.
/// Event-driven only: no timers, sleeps or periodic polling — a bounded
/// re-probe while covered/hidden already exists in the worker path, and a
/// timer here could only race a visible frame, so none is added.
/// Returns whether the signal invalidated (even when the cache was already
/// empty: the baseline still advances, so the next change is detectable).
#[cfg(target_os = "linux")]
pub(crate) fn note_environment_event(
    gate: &Mutex<Option<u64>>,
    unit_cache: &Mutex<Option<crate::niri::unit_restore::CachedCalibration>>,
    event: &serde_json::Value,
    last_layers: &mut Option<Vec<crate::niri::unit_restore::LayerIdentity>>,
    fresh: &impl Fn() -> bool,
) -> bool {
    if !fresh() {
        return false;
    }
    if !crate::niri::unit_restore::environment_invalidates(event, last_layers) {
        return false;
    }
    // Same gate domain as the probe commit/clear: a superseded job never
    // drops an entry it did not observe (rechecked under the lock).
    let _domain = gate.lock().unwrap();
    if !fresh() {
        return false;
    }
    unit_cache.lock().unwrap().take();
    true
}

#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_shared_unit_sequence_cached(
    pid: u32,
    anchor: Option<&CompactSpot>,
    mode: crate::niri::unit_restore::UnitRestoreMode,
    rose_hidden: bool,
    gap: i32,
    margin: f64,
    budget: Duration,
    fresh: impl Fn() -> bool,
    cover: &mut impl FnMut() -> bool,
    release: &mut impl FnMut() -> bool,
    resize: &mut impl FnMut((i32, i32)) -> bool,
    hide: &mut impl FnMut() -> bool,
    show: &mut impl FnMut() -> bool,
    request: &mut impl FnMut(&str, Duration) -> std::io::Result<serde_json::Value>,
    render_ready: &mut impl FnMut() -> bool,
    steps: &mut Vec<&'static str>,
    cached: Option<crate::niri::unit_restore::CachedCalibration>,
    cache_out: &mut Option<crate::niri::unit_restore::CachedCalibration>,
    // Set when a cached plan failed verification: the stored entry is stale
    // and must be dropped unless this same job refreshes `cache_out`. The
    // driver clears the stored entry on Cancelled, or when Revealed without
    // a refresh; a refresh overwrites it instead. Never set on Silent.
    cache_clear: &mut bool,
) -> SharedOutcome {
    use crate::niri::unit_restore::UnitRestoreMode as R;
    let start = std::time::Instant::now();
    let remaining = || budget.saturating_sub(start.elapsed());
    if !fresh() {
        return SharedOutcome::Silent;
    }
    // Managed fullscreen: exact panel identity, zero moves, anchor preserved.
    if mode == R::Fullscreen {
        steps.push("cover");
        if !cover() {
            return SharedOutcome::Cancelled("unit cover unacked");
        }
        steps.push("managed-verify");
        let found = request(crate::niri::WINDOWS_REQUEST, remaining().min(NATIVE_RESTORE_PASS)).ok()
            .and_then(|windows| crate::niri::own_panel_window(&windows, pid)).is_some();
        if !found {
            return if fresh() { SharedOutcome::Cancelled("unit panel unavailable") } else { SharedOutcome::Silent };
        }
        steps.push("render-ack");
        if !await_shared_render(&fresh, render_ready, remaining()) {
            return if fresh() { SharedOutcome::Cancelled("unit render ack absent") } else { SharedOutcome::Silent };
        }
        steps.push("reveal");
        return if fresh() { SharedOutcome::Revealed(anchor.cloned()) } else { SharedOutcome::Silent };
    }
    steps.push("cover");
    if !cover() {
        return SharedOutcome::Cancelled("unit cover unacked");
    }
    // B1 refloat before the pinned resize: a tiled panel (the fullscreen
    // prologue left it tiling) never becomes floating on its own, so polling
    // alone times out. Query the exact owned id; on !floating send the existing
    // float action, require Handled AND a re-queried floating identity — never
    // Handled alone, never a focused-window fallback. Missing/err retries
    // bounded (transient remap); stale is silent; failure exact-cancels.
    // Fullscreen stays managed above; all compact modes refloat here.
    loop {
        if !fresh() {
            return SharedOutcome::Silent;
        }
        if remaining().is_zero() {
            return SharedOutcome::Cancelled("unit layout not ready");
        }
        let panel = match request(crate::niri::WINDOWS_REQUEST, remaining().min(NATIVE_RESTORE_PASS)) {
            Ok(windows) => crate::niri::own_panel_window(&windows, pid),
            Err(_) => None,
        };
        let Some(panel) = panel else {
            thread::sleep(clipped_poll(remaining()));
            continue;
        };
        if panel.floating {
            break;
        }
        let Some(wire) = crate::niri::reconcile_action(&panel, false) else {
            return if fresh() { SharedOutcome::Cancelled("unit refloat unavailable") } else { SharedOutcome::Silent };
        };
        steps.push("float");
        let handled = match request(&wire, remaining().min(NATIVE_RESTORE_PASS)) {
            Ok(reply) => crate::niri::is_handled(&reply),
            Err(_) => false,
        };
        if !handled {
            return if fresh() { SharedOutcome::Cancelled("unit refloat rejected") } else { SharedOutcome::Silent };
        }
        let afloat = request(crate::niri::WINDOWS_REQUEST, remaining().min(NATIVE_RESTORE_PASS)).ok()
            .and_then(|windows| crate::niri::own_panel_window(&windows, pid))
            .is_some_and(|moved| moved.id == panel.id && moved.floating);
        if !afloat {
            return if fresh() { SharedOutcome::Cancelled("unit refloat unverified") } else { SharedOutcome::Silent };
        }
        break;
    }
    if !fresh() {
        return SharedOutcome::Silent;
    }
    // Work-area cache: read-only queries inside the job budget, zero
    // moves. A hit plans straight from the remembered anchor plus the cached
    // area; first placements, misses, and key changes probe below and refresh
    // the cache on success. A hit whose finish observes a clamp/drift drops
    // the stale entry (`cache_clear`) and re-probes in the SAME job, since
    // struts are unobservable and the outcome mismatch is the only signal.
    let cached_hit = match cached {
        Some(ref cache) => cached_unit_restore(pid, anchor, mode, cache, gap, margin, remaining(), &fresh, request),
        None => None,
    };
    steps.push("release");
    // Mapped-only calibration: the toplevel stays mapped; the release
    // plus resizes below run through apply_size_policy while mapped and
    // settle by re-querying the compositor commit. No hide/show here: an
    // unmap would remap at the window-rule base and break first-visible.
    let _ = hide;
    let _ = show;
    if !release() {
        return if fresh() { SharedOutcome::Cancelled("unit size release unacked") } else { SharedOutcome::Silent };
    }
    if !fresh() {
        return SharedOutcome::Silent;
    }
    // Self-correcting cache: at most one cached attempt, then at
    // most one bounded probe in the SAME job. Struts are unobservable, so a
    // clamped/drifted finish outcome is the invalidation signal: the stale
    // entry is dropped and the probe path completes the job instead of
    // cancelling on (or reusing) stale geometry. Same aggregate budget and
    // freshness checks; superseded jobs still go Silent with no writes.
    let mut pending_hit = cached_hit;
    let remembered = loop {
        let prepared;
        let from_cache;
        if let Some(hit) = pending_hit.take() {
            steps.push("cached");
            prepared = hit;
            from_cache = true;
        } else {
        steps.push("420");
        if !resize((420, 640)) {
            return SharedOutcome::Cancelled("unit base resize unacked");
        }
        // Settle the mapped calibration frame before `prepare` measures it: the
        // resize ack is not the compositor commit, so observe 420x640 with
        // bounded mapped re-issues; a stale frame cancels honest instead of
        // silently remapping.
        if let Some(outcome) = settle_shared_size_policy((420, 640), "unit base resize unacked", pid, start, budget, &fresh, &mut *resize, &mut *hide, &mut *show, &mut *request, false) {
            return outcome;
        }
        if !fresh() {
            return SharedOutcome::Silent;
        }
        steps.push("prepare");
        let probed = match crate::niri::unit_restore::prepare(pid, anchor, mode, gap, margin, remaining(), &fresh, request) {
            Ok(Some(prepared)) => prepared,
            Ok(None) => return SharedOutcome::Silent,
            Err(_) => return if fresh() { SharedOutcome::Cancelled("unit prepare unresolvable") } else { SharedOutcome::Silent },
        };
        // A fresh probe refreshes the per-output cache; failures and stale
        // generations leave the previous entry untouched.
        refresh_unit_cache(&probed, remaining(), &fresh, request, cache_out);
        prepared = probed;
        from_cache = false;
        }
        if !fresh() {
            return SharedOutcome::Silent;
        }
        steps.push("mode-resize");
        let Some(size) = crate::niri::unit_restore::surface_size(mode) else {
            return SharedOutcome::Cancelled("unit mode unsupported");
        };
        // `prepare` pins the mapped Niri id. Unmapping destroys that identity;
        // resize and settle in place until the compositor commits the new size.
        if !resize(size) {
            return SharedOutcome::Cancelled("unit mode resize unacked");
        }
        // Never remap after preparation: timeout cancels without replacing the
        // validated frame. Identity checks in `finish` remain unchanged.
        if let Some(outcome) = settle_shared_size_policy(size, "unit mode resize unacked", pid, start, budget, &fresh, &mut *resize, &mut *hide, &mut *show, &mut *request, false) {
            return outcome;
        }
        if !fresh() {
            return SharedOutcome::Silent;
        }
        steps.push("finish");
        match crate::niri::unit_restore::finish(&prepared, remaining(), &fresh, request) {
            Ok(Some(remembered)) => break remembered,
            Ok(None) => return SharedOutcome::Silent,
            Err(error) => {
                eprintln!("gentle-dot: shared unit finish failed: {error}");
                if from_cache {
                    // Outcome mismatch on a cached plan: the area changed
                    // under an identical layout key. Drop the stale entry so
                    // it is never reused, then re-probe in this same job.
                    steps.push("cache-miss");
                    *cache_out = None;
                    *cache_clear = true;
                    if !fresh() {
                        return SharedOutcome::Silent;
                    }
                    continue;
                }
                return if fresh() { SharedOutcome::Cancelled("unit finish unverified") } else { SharedOutcome::Silent };
            }
        }
    };
    if !fresh() {
        return SharedOutcome::Silent;
    }
    // Both-hidden close (open=false AND rose_hidden=true, RoseOnly sizing)
    // ends covered: the unit stays mapped at opacity 0 with no render-ack
    // wait and no reveal — nothing is left to show. Any other close keeps
    // the wanted 72x72 rose visible and falls through to the bounded
    // animate-settle + render-ack + reveal below, like the open arm. The
    // rose-visibility preference itself is untouched either way.
    if mode == R::RoseOnly && rose_hidden {
        steps.push("covered");
        if !fresh() {
            return SharedOutcome::Silent;
        }
        return SharedOutcome::Revealed(Some(remembered));
    }
    // Move-animation settle: Niri animates the finish move while IPC
    // omits the animated offset, so hold the cover through a bounded budget
    // before reveal. Not a rendered proof, never an unbounded sleep.
    steps.push("animate-settle");
    if !await_shared_animation(&fresh, remaining().min(NATIVE_ANIMATION_SETTLE)) {
        return SharedOutcome::Silent;
    }
    if !fresh() {
        return SharedOutcome::Silent;
    }
    steps.push("render-ack");
    if !await_shared_render(&fresh, render_ready, remaining()) {
        return if fresh() { SharedOutcome::Cancelled("unit render ack absent") } else { SharedOutcome::Silent };
    }
    steps.push("reveal");
    if !fresh() {
        return SharedOutcome::Silent;
    }
    SharedOutcome::Revealed(Some(remembered))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::niri::route_gate::{native_niri_mode, niri_socket_present};

    /// Worker-pass windows fixture (unit 20f1): exact pid+title panel and
    /// dot on one workspace; positions scripted per pass, sizes fixed.
    #[cfg(target_os = "linux")]
    fn worker_windows(panel_pos: Option<(f64, f64)>, dot_pos: Option<(f64, f64)>) -> serde_json::Value {
        let pid = std::process::id();
        let layout = |pos: Option<(f64, f64)>, size: (i32, i32)| match pos {
            Some((x, y)) => serde_json::json!({"tile_pos_in_workspace_view": [x, y], "window_size": [size.0, size.1], "tile_size": [size.0, size.1]}),
            None => serde_json::json!({"window_size": [size.0, size.1], "tile_size": [size.0, size.1]}),
        };
        serde_json::json!({"Windows": [
            {"id": 9, "pid": pid, "title": crate::platform::PANEL_TITLE, "workspace_id": 7,
             "is_floating": true, "layout": layout(panel_pos, (420, 640))},
            {"id": 7, "pid": pid, "title": crate::platform::DOT_TITLE, "workspace_id": 7,
             "is_floating": true, "layout": layout(dot_pos, (72, 72))},
        ]})
    }

    #[test]
    fn legacy_niri_route_survives_a_socketless_session_that_native_mode_refuses() {
        // Today's observable split: the five legacy toggle/hide/shortcut/show
        // branches route on the Niri session alone, while the unit route also
        // needs the socket. A missing socket with a niri desktop token must keep
        // the legacy route true and the native mode false, so nobody merges them.
        // Only this test touches the process environment, under a static guard,
        // with prior values restored on drop.
        static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _held = ENV_GUARD.lock().unwrap();
        struct PriorEnv {
            socket: Option<String>,
            desktop: Option<String>,
        }
        impl Drop for PriorEnv {
            fn drop(&mut self) {
                match &self.socket {
                    Some(value) => std::env::set_var("NIRI_SOCKET", value),
                    None => std::env::remove_var("NIRI_SOCKET"),
                }
                match &self.desktop {
                    Some(value) => std::env::set_var("XDG_CURRENT_DESKTOP", value),
                    None => std::env::remove_var("XDG_CURRENT_DESKTOP"),
                }
            }
        }
        let _prior = PriorEnv {
            socket: std::env::var("NIRI_SOCKET").ok(),
            desktop: std::env::var("XDG_CURRENT_DESKTOP").ok(),
        };
        std::env::remove_var("NIRI_SOCKET");
        assert!(!niri_socket_present());
        std::env::set_var("NIRI_SOCKET", "");
        assert!(!niri_socket_present());
        std::env::set_var("NIRI_SOCKET", "/run/user/1000/niri.sock");
        assert!(niri_socket_present());
        std::env::remove_var("NIRI_SOCKET");
        std::env::set_var("XDG_CURRENT_DESKTOP", "niri");
        assert!(niri_route_env(false));
        assert!(!niri_route_env(true));
        assert!(!native_niri_mode(false, true, false));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_mode_derives_preference_and_expanded() {
        use crate::niri::unit_surface::UnitMode;
        // Fullscreen wins over every preference; an open chat pairs with a
        // shown rose and stands alone with a hidden one; a closed chat is
        // rose-only from LOGICAL open only — physical GTK visibility is never
        // an input, so mapped windows cannot flip the mode.
        assert_eq!(unit_mode_for(true, false, true), UnitMode::Fullscreen);
        assert_eq!(unit_mode_for(true, true, true), UnitMode::Fullscreen);
        assert_eq!(unit_mode_for(true, false, false), UnitMode::Pair);
        assert_eq!(unit_mode_for(true, true, false), UnitMode::PanelOnly);
        assert_eq!(unit_mode_for(false, false, false), UnitMode::RoseOnly);
        assert_eq!(unit_mode_for(false, true, false), UnitMode::RoseOnly);
        // Desired-vs-effective: a closed unit maps RoseOnly even with stored
        // desired expanded; reopening restores the effective full mode.
        assert_eq!(unit_mode_for(false, false, true), UnitMode::RoseOnly);
        assert_eq!(unit_mode_for(false, true, true), UnitMode::RoseOnly);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shared_settle_configures_owned_mapped_size_without_remap() {
        use serde_json::json;
        let mut size = (72, 72);
        let mut wires = Vec::new();
        let mut request = |wire: &str, timeout: Duration| {
            assert!(!timeout.is_zero());
            wires.push(wire.to_owned());
            if wire == crate::niri::WINDOWS_REQUEST {
                let mut frame = worker_windows(Some((100.0,100.0)), Some((700.0,100.0)));
                frame["Windows"][0]["layout"]["window_size"] = json!([size.0,size.1]);
                frame["Windows"][0]["layout"]["tile_size"] = json!([size.0,size.1]);
                return Ok(frame);
            }
            let action: serde_json::Value = serde_json::from_str(wire).unwrap();
            if let Some(change) = action["Action"].get("SetWindowWidth") {
                assert_eq!(change["id"],9);
                size.0 = change["change"]["SetFixed"].as_i64().unwrap() as i32;
            } else if let Some(change) = action["Action"].get("SetWindowHeight") {
                assert_eq!(change["id"],9);
                size.1 = change["change"]["SetFixed"].as_i64().unwrap() as i32;
            } else {
                panic!("unexpected sizing wire: {wire}");
            }
            Ok(json!("Handled"))
        };
        let outcome = settle_shared_size_policy(
            (500,640), "unit mode resize unacked", std::process::id(),
            std::time::Instant::now(), Duration::from_millis(250), &|| true,
            &mut |_| true, // GTK-only resize does not configure this compositor.
            &mut || panic!("must not unmap the prepared id"),
            &mut || panic!("must not remap the prepared id"),
            &mut request, false,
        );
        assert_eq!(outcome,None,"must request native size instead of waiting on GTK alone");
        assert_eq!(size,(500,640));
        assert_eq!(wires.iter().filter(|w| w.contains("SetWindowWidth")).count(),1);
        assert_eq!(wires.iter().filter(|w| w.contains("SetWindowHeight")).count(),1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shared_settle_remaps_when_mapped_stale() {
        use serde_json::{json, Value};
        use std::cell::Cell;
        use std::io;
        // Direct settle seam: the compositor holds the old size while mapped
        // and only adopts the queued size on hide+show. A settle that only
        // re-requests would spin stale to the budget; this one must remap.
        struct Frame {
            size: Cell<(i32, i32)>,
            pending: Cell<Option<(i32, i32)>>,
            remaps: Cell<usize>,
            resizes: Cell<usize>,
        }
        fn windows(size: (i32, i32)) -> Value {
            json!({"Windows": [
                {"id": 9, "pid": 42, "title": crate::platform::PANEL_TITLE, "workspace_id": 7, "is_floating": true,
                 "layout": {"window_size": [size.0, size.1], "tile_size": [size.0 as f64, size.1 as f64], "window_offset_in_tile": [0.0, 0.0], "tile_pos_in_workspace_view": [0.0, 0.0]}},
            ]})
        }
        fn reply(wire: &str, size: (i32,i32)) -> io::Result<Value> {
            let asked: Value = serde_json::from_str(wire)?;
            if asked == json!("Windows") { return Ok(windows(size)); }
            for label in ["SetWindowWidth", "SetWindowHeight"] {
                if let Some(change) = asked["Action"].get(label) {
                    assert_eq!(change["id"],9);
                    assert!(change["change"]["SetFixed"].as_i64().is_some_and(|v| v > 0));
                    // Deliberately ACK without committing: the old recovery
                    // and honest-budget-expiry behaviors must remain tested.
                    return Ok(json!("Handled"));
                }
            }
            panic!("unexpected settle request: {wire}");
        }
        // Stale-then-remap: resize queues only, hide+show adopts, settle
        // succeeds and remapped at least once.
        let frame = Frame { size: Cell::new((200, 200)), pending: Cell::new(None), remaps: Cell::new(0), resizes: Cell::new(0) };
        let start = std::time::Instant::now();
        let mut resize = |size: (i32, i32)| { frame.resizes.set(frame.resizes.get() + 1); frame.pending.set(Some(size)); true };
        let mut hide = || true;
        let mut show = || { frame.remaps.set(frame.remaps.get() + 1); if let Some(size) = frame.pending.get() { frame.size.set(size); } true };
        let mut request = |wire: &str, _: Duration| reply(wire,frame.size.get());
        let outcome = settle_shared_size((420, 640), "unit base resize unacked", 42, start,
            Duration::from_secs(2), &|| true, &mut resize, &mut hide, &mut show, &mut request);
        assert_eq!(outcome, None);
        assert_eq!(frame.size.get(), (420, 640));
        assert!(frame.remaps.get() >= 1);
        assert!(frame.resizes.get() >= 1);
        // Already correct: the first poll observes the size, so no remap
        // and no re-request is needed.
        let frame = Frame { size: Cell::new((420, 640)), pending: Cell::new(None), remaps: Cell::new(0), resizes: Cell::new(0) };
        let start = std::time::Instant::now();
        let mut resize = |size: (i32, i32)| { frame.resizes.set(frame.resizes.get() + 1); frame.pending.set(Some(size)); true };
        let mut hide = || { frame.remaps.set(frame.remaps.get() + 1); true };
        let mut show = || { frame.remaps.set(frame.remaps.get() + 1); true };
        let mut request = |wire: &str, _: Duration| reply(wire,frame.size.get());
        let outcome = settle_shared_size((420, 640), "unit base resize unacked", 42, start,
            Duration::from_secs(2), &|| true, &mut resize, &mut hide, &mut show, &mut request);
        assert_eq!(outcome, None);
        assert_eq!(frame.remaps.get(), 0);
        assert_eq!(frame.resizes.get(), 0);
        // Budget expiry: even the remap never lands, so the settle names the
        // stall instead of continuing.
        let frame = Frame { size: Cell::new((200, 200)), pending: Cell::new(None), remaps: Cell::new(0), resizes: Cell::new(0) };
        let start = std::time::Instant::now();
        let mut resize = |size: (i32, i32)| { frame.pending.set(Some(size)); true };
        let mut hide = || true;
        let mut show = || { frame.remaps.set(frame.remaps.get() + 1); true };
        let mut request = |wire: &str, _: Duration| reply(wire,frame.size.get());
        let outcome = settle_shared_size((420, 640), "unit base resize unacked", 42, start,
            Duration::from_millis(400), &|| true, &mut resize, &mut hide, &mut show, &mut request);
        assert_eq!(outcome, Some(SharedOutcome::Cancelled("unit size unsettled")));
        assert!(frame.remaps.get() >= 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shared_settle_budget_parsing() {
        // Default covers the observed remap latency; the job covers two
        // settles plus the rest of the sequence.
        assert_eq!(parse_shared_settle_ms(None), Duration::from_millis(1200));
        assert_eq!(parse_shared_settle_ms(Some("")), Duration::from_millis(1200));
        assert_eq!(parse_shared_settle_ms(Some("bogus")), Duration::from_millis(1200));
        assert_eq!(parse_shared_settle_ms(Some("0")), Duration::from_millis(1200));
        assert_eq!(parse_shared_settle_ms(Some("50")), Duration::from_millis(100));
        assert_eq!(parse_shared_settle_ms(Some("500")), Duration::from_millis(500));
        assert_eq!(parse_shared_settle_ms(Some("20000")), Duration::from_millis(10_000));
        assert_eq!(NATIVE_SETTLE_DEFAULT_MS, 1200);
        assert!(NATIVE_RESTORE_JOB >= Duration::from_millis(2 * NATIVE_SETTLE_DEFAULT_MS + 500));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shared_transition_never_unmaps_during_mode_change() {
        // S26 RED: the mapped-only pipeline must never hide()/show() the
        // toplevel mid-transition (no None gap, stable id). Panicking
        // hide/show prove the production seam calls no unmap/remap step.
        use crate::niri::unit_restore::UnitRestoreMode as R;
        use serde_json::{json, Value};
        use std::cell::Cell;
        use std::io;
        struct Mapped {
            size: Cell<(i32, i32)>,
            pos: Cell<(f64, f64)>,
        }
        impl Mapped {
            fn adopt(&self, size: (i32, i32)) {
                match size {
                    (420, 640) => self.size.set((420, 640)),
                    (500, 640) => self.size.set((500, 640)),
                    (72, 72) => self.size.set((72, 72)),
                    _ => {}
                }
            }
            fn tile(&self) -> (f64, f64) {
                match self.size.get() {
                    (420, 640) => (420.5, 640.5),
                    (500, 640) => (508.0, 648.0),
                    (72, 72) => (80.0, 80.0),
                    (w, h) => (w as f64, h as f64),
                }
            }
            fn offset(&self) -> (f64, f64) {
                match self.size.get() {
                    (420, 640) => (0.0, 0.0),
                    _ => (4.0, 4.0),
                }
            }
            fn request(&self, wire: &str, _: Duration) -> io::Result<Value> {
                let asked: Value = serde_json::from_str(wire)?;
                if asked == json!("Version") {
                    return Ok(json!({"Version": "26.04 (test)"}));
                }
                if asked == json!("Windows") {
                    let (sw, sh) = self.size.get();
                    let (tw, th) = self.tile();
                    let (ox, oy) = self.offset();
                    let (px, py) = self.pos.get();
                    return Ok(json!({"Windows": [
                        {"id": 9, "pid": 42, "title": crate::platform::PANEL_TITLE, "workspace_id": 7, "is_floating": true,
                         "layout": {"window_size": [sw, sh], "tile_size": [tw, th], "window_offset_in_tile": [ox, oy], "tile_pos_in_workspace_view": [px, py]}},
                    ]}));
                }
                if asked == json!("Workspaces") {
                    return Ok(json!({"Workspaces": [{"id": 7, "output": "DP-1"}]}));
                }
                if asked == json!("Outputs") {
                    return Ok(json!({"Outputs": {"DP-1": {"name": "DP-1", "logical": {"x": 0, "y": 0, "width": 2560, "height": 1440, "scale": 1.0, "transform": "Normal"}}}}));
                }
                if asked == json!("Layers") {
                    return Ok(json!({"Layers": []}));
                }
                for label in ["SetWindowWidth", "SetWindowHeight"] {
                    if let Some(change) = asked["Action"].get(label) {
                        if let Some(v) = change["change"]["SetFixed"].as_i64() {
                            let (w, h) = self.size.get();
                            if label == "SetWindowWidth" {
                                self.adopt((v as i32, h));
                            } else {
                                self.adopt((w, v as i32));
                            }
                        }
                        return Ok(json!("Handled"));
                    }
                }
                if asked.get("Action").is_some() {
                    let mover = &asked["Action"]["MoveFloatingWindow"];
                    if mover.is_object() {
                        assert_eq!(mover["id"], 9);
                        if let (Some(dx), Some(dy)) = (mover["x"]["AdjustFixed"].as_i64(), mover["y"]["AdjustFixed"].as_i64()) {
                            let (x, y) = self.pos.get();
                            self.pos.set((x + dx as f64, y + dy as f64));
                        } else {
                            let axis = |v: &Value, o: f64, e: f64| if let Some(f) = v["SetFixed"].as_f64() { o + f } else { o + e - 75.0 };
                            self.pos.set((axis(&mover["x"], 12.0, 1280.0), axis(&mover["y"], 30.0, 1000.0)));
                        }
                        return Ok(json!("Handled"));
                    }
                    return Ok(json!("Handled"));
                }
                Ok(json!("Handled"))
            }
        }
        let fake = Mapped { size: Cell::new((500, 640)), pos: Cell::new((200.0, 100.0)) };
        let mut steps = Vec::new();
        let mut cover = || true;
        let mut release = || true;
        let mut resize = |size: (i32, i32)| { fake.size.set(size); true };
        let mut hide = || panic!("S26: transition must not unmap (hide)");
        let mut show = || panic!("S26: transition must not remap (show)");
        let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
        let mut ready = || true;
        let anchor = crate::niri::CompactSpot { output: "DP-1".into(), x: 100.0, y: 200.0 };
        let outcome = run_shared_unit_sequence(42, Some(&anchor), R::Pair, false, 8, 12.0,
            Duration::from_secs(2), || true, &mut cover, &mut release, &mut resize, &mut hide, &mut show, &mut request, &mut ready, &mut steps);
        assert!(matches!(outcome, SharedOutcome::Revealed(_)));
        assert!(!steps.iter().any(|s| *s == "remap" || *s == "float-hide"), "no unmap/remap step: {steps:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shared_rose_toggle_refused_while_fullscreen() {
        // Fullscreen implies no rose; the shared branch must refuse a rose
        // toggle instead of starting a transition.
        assert!(!shared_rose_toggle_allowed(true), "fullscreen blocks the rose toggle");
        assert!(shared_rose_toggle_allowed(false), "minimized keeps the toggle");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shared_cached_transition_skips_probe_moves() {
        // T10: calibrate ONCE per output. The first placement probes and
        // fills the cache; the repeat reuses it with zero probe moves; an
        // output key change re-measures. Probe moves are the calibration
        // SetFixed/SetProportion detours; the single AdjustFixed finish
        // move (or none at target) is the only motion a cached path allows.
        use crate::niri::unit_restore::{CachedCalibration, UnitRestoreMode as R};
        use serde_json::{json, Value};
        use std::cell::{Cell, RefCell};
        use std::io;
        fn anchor(x: f64, y: f64) -> crate::niri::CompactSpot {
            crate::niri::CompactSpot { output: "DP-1".into(), x, y }
        }
        struct Fake {
            pos: Cell<(f64, f64)>,
            accept: bool,
            size: Cell<(i32, i32)>,
            tile: Cell<(f64, f64)>,
            offset: Cell<(f64, f64)>,
            scale: Cell<f64>,
            log: RefCell<Vec<Value>>,
        }
        impl Fake {
            fn live() -> Self {
                Self { pos: Cell::new((200.0, 100.0)), accept: true, size: Cell::new((200, 200)),
                    tile: Cell::new((200.0, 200.0)), offset: Cell::new((0.0, 0.0)),
                    scale: Cell::new(1.0), log: RefCell::new(vec![]) }
            }
            fn adopt(&self, size: (i32, i32)) {
                match size {
                    (420, 640) => { self.size.set((420, 640)); self.tile.set((420.5, 640.5)); self.offset.set((0.0, 0.0)); }
                    (500, 640) => { self.size.set((500, 640)); self.tile.set((508.0, 648.0)); self.offset.set((4.0, 4.0)); }
                    (72, 72) => { self.size.set((72, 72)); self.tile.set((80.0, 80.0)); self.offset.set((4.0, 4.0)); }
                    _ => {}
                }
            }
            fn request(&self, wire: &str, _: Duration) -> io::Result<Value> {
                let asked: Value = serde_json::from_str(wire)?;
                self.log.borrow_mut().push(asked.clone());
                if asked == json!("Version") {
                    return Ok(json!({"Version": "26.04 (test)"}));
                }
                if asked == json!("Windows") {
                    let (px, py) = self.pos.get();
                    let (sw, sh) = self.size.get();
                    let (tw, th) = self.tile.get();
                    let (ox, oy) = self.offset.get();
                    return Ok(json!({"Windows": [
                        {"id": 9, "pid": 42, "title": crate::platform::PANEL_TITLE, "workspace_id": 7, "is_floating": true,
                         "layout": {"window_size": [sw, sh], "tile_size": [tw, th], "window_offset_in_tile": [ox, oy], "tile_pos_in_workspace_view": [px, py]}},
                    ]}));
                }
                if asked == json!("Workspaces") {
                    return Ok(json!({"Workspaces": [{"id": 7, "output": "DP-1"}]}));
                }
                if asked == json!("Outputs") {
                    return Ok(json!({"Outputs": {"DP-1": {"name": "DP-1",
                        "logical": {"x": 0, "y": 0, "width": 2560, "height": 1440, "scale": self.scale.get(), "transform": "Normal"}}}}));
                }
                if asked == json!("Layers") {
                    return Ok(json!({"Layers": []}));
                }
                let mover = &asked["Action"]["MoveFloatingWindow"];
                assert_eq!(mover["id"], 9, "cached route moves the exact PANEL id only");
                if self.accept {
                    if let (Some(dx), Some(dy)) = (mover["x"]["AdjustFixed"].as_i64(), mover["y"]["AdjustFixed"].as_i64()) {
                        let (x, y) = self.pos.get();
                        self.pos.set((x + dx as f64, y + dy as f64));
                    } else {
                        let axis = |v: &Value, o: f64, e: f64| if let Some(f) = v["SetFixed"].as_f64() { o + f } else { o + e - 75.0 };
                        self.pos.set((axis(&mover["x"], 12.0, 1280.0), axis(&mover["y"], 30.0, 1000.0)));
                    }
                }
                Ok(json!("Handled"))
            }
            /// Calibration detours (SetFixed/SetProportion); the finish
            /// AdjustFixed move is counted separately.
            fn probes(&self) -> usize {
                self.log.borrow().iter().filter(|w| {
                    w.pointer("/Action/MoveFloatingWindow/id").and_then(Value::as_u64) == Some(9)
                        && w.pointer("/Action/MoveFloatingWindow/x/AdjustFixed").is_none()
                }).count()
            }
            fn adjusts(&self) -> usize {
                self.log.borrow().iter().filter(|w| {
                    w.pointer("/Action/MoveFloatingWindow/x/AdjustFixed").is_some()
                }).count()
            }
        }
        fn run(fake: &Fake, spot: &crate::niri::CompactSpot, cached: Option<CachedCalibration>, fresh: &impl Fn() -> bool)
            -> (SharedOutcome, Vec<&'static str>, Option<CachedCalibration>) {
            let mut steps = Vec::new();
            let mut cache_out = None;
            let mut cache_clear = false;
            let mut cover = || true;
            let mut release = || true;
            let mut resize = |size: (i32, i32)| { fake.adopt(size); true };
            let mut hide = || true;
            let mut show = || true;
            let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
            let mut ready = || true;
            let outcome = run_shared_unit_sequence_cached(42, Some(spot), R::Pair, false, 8, 12.0,
                Duration::from_secs(2), fresh, &mut cover, &mut release, &mut resize, &mut hide, &mut show,
                &mut request, &mut ready, &mut steps, cached, &mut cache_out, &mut cache_clear);
            (outcome, steps, cache_out)
        }
        // First placement probes and fills the cache.
        let fake = Fake::live();
        let (outcome, steps, cache) = run(&fake, &anchor(100.0, 200.0), None, &|| true);
        assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
        assert!(steps.contains(&"prepare"), "first placement must probe: {steps:?}");
        let cache = cache.expect("probe success fills the cache");
        assert_eq!(cache.key.output, "DP-1");
        assert_eq!((cache.key.width, cache.key.height), (2560, 1440));
        assert_eq!(cache.area.origin, (12.0, 30.0));
        assert_eq!(cache.area.size, (1280.0, 1000.0));
        assert_eq!(fake.pos.get(), (100.0, 200.0));
        let (probes, adjusts) = (fake.probes(), fake.adjusts());
        assert!(probes > 0, "first placement probes");
        // Second transition, already at target: no probe moves, no move at all.
        let (outcome, steps, _) = run(&fake, &anchor(100.0, 200.0), Some(cache.clone()), &|| true);
        assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
        assert!(steps.contains(&"cached"), "same-output repeat must use the cache: {steps:?}");
        assert!(!steps.contains(&"prepare"), "cached path issues no probes: {steps:?}");
        assert_eq!(fake.probes(), probes, "cached path issues no probe moves");
        assert_eq!(fake.adjusts(), adjusts, "anchor already matches: no move at all");
        assert_eq!(fake.pos.get(), (100.0, 200.0));
        // Reopen from the compositor base: exactly one move to the target.
        fake.pos.set((2036.0, 56.0));
        let (outcome, _, _) = run(&fake, &anchor(100.0, 200.0), Some(cache.clone()), &|| true);
        assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
        assert_eq!(fake.probes(), probes, "reopen from base still probes nothing");
        assert_eq!(fake.adjusts(), adjusts + 1, "single move straight to the target");
        assert_eq!(fake.pos.get(), (100.0, 200.0));
        // Output key change (scale): re-measure and refresh the cache.
        fake.scale.set(2.0);
        let (outcome, steps, cache2) = run(&fake, &anchor(100.0, 200.0), Some(cache), &|| true);
        assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
        assert!(steps.contains(&"prepare"), "key change must re-measure: {steps:?}");
        assert!(fake.probes() > probes, "re-measure probes again");
        assert_eq!(cache2.expect("re-measure refreshes the cache").key.scale, 2.0);
        // Superseded jobs write nothing: silent and no cache.
        let (outcome, _, cache_out) = run(&fake, &anchor(100.0, 200.0), None, &|| false);
        assert_eq!(outcome, SharedOutcome::Silent);
        assert!(cache_out.is_none(), "superseded jobs never write the cache");
        // Failed probes poison nothing either.
        let stuck = Fake { accept: false, ..Fake::live() };
        let (outcome, _, cache_out) = run(&stuck, &anchor(100.0, 200.0), None, &|| true);
        assert!(matches!(outcome, SharedOutcome::Cancelled(_)));
        assert!(cache_out.is_none(), "failed probes never poison the cache");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shared_layer_query_guards_cache_reuse() {
        use crate::niri::unit_restore::{CachedCalibration, UnitRestoreMode as R};
        use serde_json::{json, Value};
        use std::cell::{Cell, RefCell};
        use std::io;
        fn anchor(x: f64, y: f64) -> crate::niri::CompactSpot {
            crate::niri::CompactSpot { output: "DP-1".into(), x, y }
        }
        fn bar() -> Value {
            json!({"namespace": "bar", "output": "DP-1", "layer": "Top", "keyboard_interactivity": "None"})
        }
        struct Fake {
            pos: Cell<(f64, f64)>,
            size: Cell<(i32, i32)>,
            tile: Cell<(f64, f64)>,
            offset: Cell<(f64, f64)>,
            layers: RefCell<Vec<Value>>,
            fail_layers: Cell<bool>,
            log: RefCell<Vec<Value>>,
        }
        impl Fake {
            fn live() -> Self {
                Self { pos: Cell::new((200.0, 100.0)), size: Cell::new((200, 200)),
                    tile: Cell::new((200.0, 200.0)), offset: Cell::new((0.0, 0.0)),
                    layers: RefCell::new(vec![bar()]), fail_layers: Cell::new(false), log: RefCell::new(vec![]) }
            }
            fn adopt(&self, size: (i32, i32)) {
                match size {
                    (420, 640) => { self.size.set((420, 640)); self.tile.set((420.5, 640.5)); self.offset.set((0.0, 0.0)); }
                    (500, 640) => { self.size.set((500, 640)); self.tile.set((508.0, 648.0)); self.offset.set((4.0, 4.0)); }
                    _ => {}
                }
            }
            fn request(&self, wire: &str, _: Duration) -> io::Result<Value> {
                let asked: Value = serde_json::from_str(wire)?;
                self.log.borrow_mut().push(asked.clone());
                if asked == json!("Version") {
                    return Ok(json!({"Version": "26.04 (test)"}));
                }
                if asked == json!("Windows") {
                    let (px, py) = self.pos.get();
                    let (sw, sh) = self.size.get();
                    let (tw, th) = self.tile.get();
                    let (ox, oy) = self.offset.get();
                    return Ok(json!({"Windows": [
                        {"id": 9, "pid": 42, "title": crate::platform::PANEL_TITLE, "workspace_id": 7, "is_floating": true,
                         "layout": {"window_size": [sw, sh], "tile_size": [tw, th], "window_offset_in_tile": [ox, oy], "tile_pos_in_workspace_view": [px, py]}},
                    ]}));
                }
                if asked == json!("Workspaces") {
                    return Ok(json!({"Workspaces": [{"id": 7, "output": "DP-1"}]}));
                }
                if asked == json!("Outputs") {
                    return Ok(json!({"Outputs": {"DP-1": {"name": "DP-1",
                        "logical": {"x": 0, "y": 0, "width": 2560, "height": 1440, "scale": 1.0, "transform": "Normal"}}}}));
                }
                if asked == json!("Layers") {
                    if self.fail_layers.get() {
                        return Err(io::Error::new(io::ErrorKind::TimedOut, "niri: layers unavailable"));
                    }
                    return Ok(json!({"Layers": self.layers.borrow().clone()}));
                }
                let mover = &asked["Action"]["MoveFloatingWindow"];
                assert_eq!(mover["id"], 9);
                if let (Some(dx), Some(dy)) = (mover["x"]["AdjustFixed"].as_i64(), mover["y"]["AdjustFixed"].as_i64()) {
                    let (x, y) = self.pos.get();
                    self.pos.set((x + dx as f64, y + dy as f64));
                } else {
                    let axis = |v: &Value, o: f64, e: f64| if let Some(f) = v["SetFixed"].as_f64() { o + f } else { o + e - 75.0 };
                    self.pos.set((axis(&mover["x"], 12.0, 1280.0), axis(&mover["y"], 30.0, 1000.0)));
                }
                Ok(json!("Handled"))
            }
            fn probes(&self) -> usize {
                self.log.borrow().iter().filter(|w| {
                    w.pointer("/Action/MoveFloatingWindow/id").and_then(Value::as_u64) == Some(9)
                        && w.pointer("/Action/MoveFloatingWindow/x/AdjustFixed").is_none()
                }).count()
            }
        }
        fn run(fake: &Fake, spot: &crate::niri::CompactSpot, cached: Option<CachedCalibration>, fresh: &impl Fn() -> bool)
            -> (SharedOutcome, Vec<&'static str>, Option<CachedCalibration>) {
            let mut steps = Vec::new();
            let mut cache_out = None;
            let mut cache_clear = false;
            let mut cover = || true;
            let mut release = || true;
            let mut resize = |size: (i32, i32)| { fake.adopt(size); true };
            let mut hide = || true;
            let mut show = || true;
            let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
            let mut ready = || true;
            let outcome = run_shared_unit_sequence_cached(42, Some(spot), R::Pair, false, 8, 12.0,
                Duration::from_secs(2), fresh, &mut cover, &mut release, &mut resize, &mut hide, &mut show,
                &mut request, &mut ready, &mut steps, cached, &mut cache_out, &mut cache_clear);
            (outcome, steps, cache_out)
        }
        let spot = anchor(100.0, 200.0);
        let fake = Fake::live();
        let (outcome, _, cache) = run(&fake, &spot, None, &|| true);
        assert_eq!(outcome, SharedOutcome::Revealed(Some(spot.clone())));
        let cache = cache.expect("probe records the layer set");
        assert_eq!(cache.layers.len(), 1, "recorded environment holds the bar");
        assert_eq!(cache.layers[0].namespace, "bar");
        let probes = fake.probes();
        // Unchanged set reuses with zero extra probes.
        let (outcome, steps, _) = run(&fake, &spot, Some(cache.clone()), &|| true);
        assert_eq!(outcome, SharedOutcome::Revealed(Some(spot.clone())));
        assert!(steps.contains(&"cached") && !steps.contains(&"prepare"));
        assert_eq!(fake.probes(), probes, "unchanged layers issue no extra probe");
        // Changed set under an identical Outputs key misses and re-probes.
        fake.layers.borrow_mut().clear();
        let (outcome, steps, refilled) = run(&fake, &spot, Some(cache.clone()), &|| true);
        assert_eq!(outcome, SharedOutcome::Revealed(Some(spot.clone())));
        assert!(steps.contains(&"prepare"), "changed layers re-probe: {steps:?}");
        assert!(fake.probes() > probes, "changed layers probe again");
        assert_eq!(refilled.expect("re-probe records the new set").layers.len(), 0);
        // Failed query forces a probe instead of reusing the entry.
        fake.layers.borrow_mut().push(bar());
        fake.fail_layers.set(true);
        let probes = fake.probes();
        let (outcome, steps, _) = run(&fake, &spot, Some(cache.clone()), &|| true);
        assert_eq!(outcome, SharedOutcome::Revealed(Some(spot.clone())));
        assert!(steps.contains(&"prepare"), "failed query probes: {steps:?}");
        assert!(fake.probes() > probes);
        fake.fail_layers.set(false);
        // Stale generation still writes nothing.
        let (outcome, _, cache_out) = run(&fake, &spot, None, &|| false);
        assert_eq!(outcome, SharedOutcome::Silent);
        assert!(cache_out.is_none(), "stale generation writes nothing");
    }
}
