//! Niri shared-unit dormant state and cover executor, slice 4b (moved from
//! shell.rs): the dormant activation/open/ready state, its panel snapshot,
//! the lock-injected state adapters, the transition planner/committer, the
//! main-thread cover executor and the worker-wake decision. The routing
//! predicates (`unit_enabled` and friends) live in `route_gate`; the `Shell`
//! reader, the panel emit and the Tauri commands stay in shell.rs.

use crate::niri::route_gate::unit_enabled;
#[cfg(target_os = "linux")]
use std::sync::Mutex;
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "linux")]
use crate::niri::gate::*;
#[cfg(target_os = "linux")]
use crate::shell::CommandResult;

/// Dormant shared-unit logical state: explicit
/// activation plus logical chat-open for the single Niri surface. The PANEL
/// anchor stays `native_compact` — this adapter owns NO position, so one
/// source of truth remains. `active` starts FALSE; only the setup
/// activation flips it after builder+worker+follow readiness.
#[cfg(target_os = "linux")]
pub(crate) struct NiriUnitState {
    /// Explicit shared-surface activation (initial FALSE, separate from
    /// `joint_unit_active`, which gates follow/drag only).
    pub(crate) active: bool,
    /// Logical chat open (NOT GTK mapped visibility: a closed unit reads
    /// RoseOnly even while windows are physically mapped).
    pub(crate) open: bool,
    /// Render-ready generation the panel DOM-committed (handshake T10/T19):
    /// Some(revision) only after the enabled live-revision ack; cleared on
    /// every actual transition below; never a position (untouched).
    pub(crate) ready: Option<u64>,
}

#[cfg(target_os = "linux")]
impl NiriUnitState {
    pub(crate) fn dormant() -> Self {
        Self { active: false, open: false, ready: None }
    }
}

/// Shared-unit snapshot served to the panel (all OS): logical state only —
/// never an anchor or position (no `native_compact` bytes reach the UI).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NiriUnitSnapshot {
    pub(crate) enabled: bool,
    pub(crate) open: bool,
    pub(crate) rose_hidden: bool,
    pub(crate) fullscreen: bool,
    pub(crate) revision: u64,
}

impl NiriUnitSnapshot {
    /// Safe everywhere: off-Niri (and off-Linux) reads fully disabled.
    /// (Only the off-Linux command branch and tests call this; kept
    /// warning-free for the Linux service build.)
    #[allow(dead_code)]
    pub(crate) fn disabled() -> Self {
        Self { enabled: false, open: false, rose_hidden: false, fullscreen: false, revision: 0 }
    }
}

/// Snapshot from logical inputs (all OS): `revision` echoes the live epoch
/// so publishers can present it back to `publish_unit_*`. `fullscreen` is
/// the EFFECTIVE visible mode (open AND desired expanded): a closed unit
/// with stored desired expanded reads false, and reopening restores true —
/// the stored flag itself is never forced. Pure so tests pin the payload
/// shape without windows.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn unit_snapshot_for(
    active: bool,
    open: bool,
    rose_hidden: bool,
    expanded: bool,
    places_windows: bool,
    is_niri: bool,
    socket_present: bool,
    revision: u64,
) -> NiriUnitSnapshot {
    NiriUnitSnapshot {
        enabled: unit_enabled(active, places_windows, is_niri, socket_present),
        open,
        rose_hidden,
        fullscreen: open && expanded,
        revision,
    }
}

/// Publishes logical chat-open under a generation (Linux only): holds the
/// gate across the epoch read and the unit store (gate→unit), so a gate-held
/// bump — the shape of every production bumper (mode_take_generation,
/// take_hide_generation, gated handoffs) — cannot land between the check and
/// the store. A stale `expected` rejects with NO effects, so a late callback
/// can never flip a newer lifecycle. Caller contract: advance the epoch first
/// through a gate-owned handoff, then publish under the fresh revision, then
/// emit — same-revision changed state is ignored downstream. Dormant: the
/// activation unit will call this; no caller yet.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn publish_unit_open(
    gate: &Mutex<Option<u64>>,
    unit: &Mutex<NiriUnitState>,
    epoch: &AtomicU64,
    expected: u64,
    open: bool,
) -> bool {
    let _held = gate.lock().unwrap();
    if epoch.load(Ordering::SeqCst) != expected {
        return false;
    }
    let mut live = unit.lock().unwrap();
    live.open = open;
    live.ready = None;
    true
}

/// Final shared activation (Linux only): flips `active` TRUE only after the
/// builder mapped/parked the single surface, the worker channel runs, and
/// follow is spawned — all read live, never assumed. Gate-held publish under
/// the live epoch; a raced bump or any unreadiness leaves FALSE with no
/// effects. Last setup step; re-reporting TRUE when already on is idempotent.
#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
pub(crate) fn activate_shared_unit(
    gate: &Mutex<Option<u64>>,
    unit: &Mutex<NiriUnitState>,
    epoch: &AtomicU64,
    places_windows: bool,
    is_niri: bool,
    socket_present: bool,
    worker_ready: bool,
    follow_ready: bool,
    window_ready: bool,
) -> bool {
    if !(worker_ready && follow_ready && window_ready) {
        return false;
    }
    if places_windows || !is_niri || !socket_present {
        return false;
    }
    let live = epoch.load(Ordering::SeqCst);
    let _held = gate.lock().unwrap();
    if epoch.load(Ordering::SeqCst) != live {
        return false;
    }
    let mut live_state = unit.lock().unwrap();
    live_state.active = true;
    live_state.ready = None;
    true
}

/// Publishes shared-surface activation under a generation (Linux only): same
/// gate-held check→store and caller contract as `publish_unit_open` (advance
/// via a gate-owned handoff, publish fresh, then emit). Dormant: no caller yet.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn publish_unit_activation(
    gate: &Mutex<Option<u64>>,
    unit: &Mutex<NiriUnitState>,
    epoch: &AtomicU64,
    expected: u64,
    active: bool,
) -> bool {
    let _held = gate.lock().unwrap();
    if epoch.load(Ordering::SeqCst) != expected {
        return false;
    }
    let mut live = unit.lock().unwrap();
    live.active = active;
    live.ready = None;
    true
}

/// Render-ready acknowledgement (Linux only): stores `revision` as the DOM-committed
/// generation INSIDE the existing unit state — no position bytes anywhere. Accepts ONLY
/// when the shared unit is enabled AND the revision is the live epoch; stale or disabled
/// acks change nothing and report false. Gate→unit domain, same as the publishers above.
/// Dormant: the worker reveal gate reads this through `unit_ready_for`; the only caller
/// yet is the panel command below.
#[cfg(target_os = "linux")]
pub(crate) fn ack_unit_ready(
    gate: &Mutex<Option<u64>>,
    unit: &Mutex<NiriUnitState>,
    epoch: &AtomicU64,
    places_windows: bool,
    is_niri: bool,
    socket_present: bool,
    revision: u64,
) -> bool {
    let _held = gate.lock().unwrap();
    if epoch.load(Ordering::SeqCst) != revision {
        return false;
    }
    let mut live = unit.lock().unwrap();
    if !unit_enabled(live.active, places_windows, is_niri, socket_present) {
        return false;
    }
    live.ready = Some(revision);
    true
}

/// Ready query for the reveal worker (Linux only): true only when `revision` is still the
/// live epoch AND the panel committed exactly it. Brief holds, no waits — a render race
/// resolves as false and the worker retries on the next pass. Dormant: no caller yet.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn unit_ready_for(
    gate: &Mutex<Option<u64>>,
    unit: &Mutex<NiriUnitState>,
    epoch: &AtomicU64,
    revision: u64,
) -> bool {
    let _held = gate.lock().unwrap();
    epoch.load(Ordering::SeqCst) == revision && unit.lock().unwrap().ready == Some(revision)
}

/// Lock-injected snapshot core (Linux only): the production reader behind
/// `unit_snapshot_of`, over caller-supplied locks so concurrency tests can
/// drive the exact gate domain without an AppHandle. Holds the gate across
/// the revision read and every copy (gate→unit→expanded), so a bump cannot
/// split the pair: `revision` always matches the copied unit state.
/// Domain audit (B1/B2): every epoch bump in this file runs under the gate
/// lock (restore handoffs, mode_take_generation, take_hide_generation,
/// prepare_niri_show); existing orders are gate→intents and gate→hide, and
/// no code holds intents/hide/expanded across a gate acquisition (statement
/// temporaries, or nesting in the same direction) — so gate→unit→expanded
/// introduces no cycle. `rose_hidden` is atomic (no lock to order).
/// Future rule: expanded writers that must pair with unit snapshots join
/// this domain as gate→expanded; rose stays an atomic load inside the hold.
#[cfg(target_os = "linux")]
pub(crate) fn unit_snapshot_locked(
    gate: &Mutex<Option<u64>>,
    unit: &Mutex<NiriUnitState>,
    epoch: &AtomicU64,
    expanded: &Mutex<bool>,
    rose_hidden: &AtomicBool,
    places_windows: bool,
    is_niri: bool,
    socket_present: bool,
) -> NiriUnitSnapshot {
    let _held = gate.lock().unwrap();
    let revision = epoch.load(Ordering::SeqCst);
    let held = unit.lock().unwrap();
    unit_snapshot_for(held.active, held.open, rose_hidden.load(Ordering::SeqCst), *expanded.lock().unwrap(), places_windows, is_niri, socket_present, revision)
}

/// Shared-unit transition request (Linux only): one variant per command
/// route (tray, shortcut, single-instance, CLI all funnel into these).
/// Dormant: callsite branches land next unit; tests construct these meanwhile.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnitTransition {
    Open,
    Close,
    Toggle,
    SetRoseHidden(bool),
    SetExpanded(bool),
}

/// Decided shared-unit state (Linux only): pure product of
/// `plan_unit_transition`, committed atomically by `unit_transition_commit`.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UnitPlan {
    pub(crate) open: bool,
    pub(crate) expanded: bool,
    pub(crate) rose_hidden: bool,
    pub(crate) intent: RestoreIntent,
}

/// Plans shared-unit state from a route request (Linux only): toggle flips
/// logical open; rose/expanded setters carry the rest; Close keeps the
/// stored desired expanded (reopen restores the effective full mode) and
/// never forces the rose preference; opening without an anchor bootstraps
/// the calibrated base while every other route preserves. Pure.
#[cfg(target_os = "linux")]
pub(crate) fn plan_unit_transition(
    kind: UnitTransition,
    open: bool,
    expanded: bool,
    rose_hidden: bool,
    anchored: bool,
) -> UnitPlan {
    match kind {
        UnitTransition::Open => UnitPlan { open: true, expanded, rose_hidden, intent: restore_intent_for_show(anchored) },
        UnitTransition::Close => UnitPlan { open: false, expanded, rose_hidden, intent: RestoreIntent::PreserveCompact },
        UnitTransition::Toggle if !open => UnitPlan { open: true, expanded, rose_hidden, intent: restore_intent_for_show(anchored) },
        UnitTransition::Toggle => UnitPlan { open: false, expanded, rose_hidden, intent: RestoreIntent::PreserveCompact },
        UnitTransition::SetRoseHidden(hidden) => UnitPlan { open, expanded, rose_hidden: hidden, intent: RestoreIntent::PreserveCompact },
        UnitTransition::SetExpanded(on) => UnitPlan {
            open,
            expanded: on,
            rose_hidden,
            intent: restore_intent_for_mode_request(on, true, anchored),
        },
    }
}

/// Panel mapping for shared-unit state (Linux only): the single surface
/// stays mapped while open or while the rose is wanted (closed-with-rose is
/// RoseOnly); only closed-with-hidden-rose truly unmaps — desired expanded
/// is irrelevant when closed. The independent dot window is never touched
/// here. Pure.
/// Dormant: callsite branches land next unit; tests drive it meanwhile.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnitWindow {
    KeepMapped,
    // Unmapped close: no longer constructed (keeps the ONE
    // toplevel mapped; closes end covered). Kept so the cover executor's
    // Hide arm stays compiled for the parked-startup path.
    #[allow(dead_code)]
    Hide,
}

#[cfg(target_os = "linux")]
pub(crate) fn unit_window_for(open: bool, rose_hidden: bool, expanded: bool) -> UnitWindow {
    // S26: the ONE toplevel stays MAPPED across every transition, covered
    // (opacity 0 + unfocusable + click-through) only while both chat and
    // rose are hidden; a close with the rose wanted stays a visible
    // rose-only surface. The rose-visibility preference itself is
    // untouched. Desired expanded is irrelevant: a closed unit reads
    // RoseOnly sizing.
    let _ = (open, rose_hidden, expanded);
    UnitWindow::KeepMapped
}

/// Commits one shared-unit transition under a fresh gate-owned generation
/// (Linux only): single gate hold across enable-check, plan, bump, owned
/// gate carry, state writes (open/expanded/rose join gate ownership), and
/// intent publish (with the owed-base carry rule) — then returns the
/// snapshot at the new revision for the `dot://unit` emit. An owned cover
/// transfers with the generation (matching restore_handoff); ungated or
/// stale gates are left alone, never claimed or cleared. No worker wake
/// here: glue signals via `signal_restore` (still non-blocking `try_send`)
/// only after covered readiness is performed. Dormant/disabled reads route
/// legacy with zero effects: no generation, no writes, no signal. Never
/// touches `native_compact` (anchor preserved unless a future explicit
/// reset) and never calls the gate-locking publish/snapshot helpers under
/// its own hold (their stores are inlined). Dormant: active stays FALSE
/// until the builder+worker unit; unreachable in production until then.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn unit_transition_commit(
    gate: &Mutex<Option<u64>>,
    unit: &Mutex<NiriUnitState>,
    epoch: &AtomicU64,
    expanded: &Mutex<bool>,
    rose_hidden: &AtomicBool,
    intents: &Mutex<Option<(u64, RestoreIntent)>>,
    places_windows: bool,
    is_niri: bool,
    socket_present: bool,
    anchored: bool,
    kind: UnitTransition,
) -> Option<NiriUnitSnapshot> {
    let mut held = gate.lock().unwrap();
    let mut live = unit.lock().unwrap();
    if !unit_enabled(live.active, places_windows, is_niri, socket_present) {
        return None;
    }
    let mut mode = expanded.lock().unwrap();
    let plan = plan_unit_transition(kind, live.open, *mode, rose_hidden.load(Ordering::SeqCst), anchored);
    let next = epoch.fetch_add(1, Ordering::SeqCst) + 1;
    if *held == Some(next - 1) {
        *held = Some(next);
    }
    live.open = plan.open;
    live.ready = None;
    *mode = plan.expanded;
    rose_hidden.store(plan.rose_hidden, Ordering::SeqCst);
    {
        let mut stored = intents.lock().unwrap();
        *stored = Some((next, carried_restore_intent(*stored, next - 1, plan.intent)));
    }
    Some(unit_snapshot_for(live.active, live.open, plan.rose_hidden, plan.expanded, places_windows, is_niri, socket_present, next))
}

/// Main-thread execution effects for one shared-unit cover/hide pass
/// (Linux only): panel verbs only — no dot operation exists in this
/// vocabulary, so the executor cannot map, unmap, or reanchor the dot.
/// Order is the contract: CoverVisuals (opacity 0 + focus off) BEFORE Map
/// (show), Map BEFORE CoverInput (ignore on — the known tao abort
/// invariant); Hide unmaps BEFORE ResetVisuals (opacity 1 + focusable).
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnitExecEffect {
    CoverVisuals,
    Map,
    CoverInput,
    Unmap,
    ResetVisuals,
}

/// Execution outcome (Linux only): Applied ran every planned effect; Stale
/// planned nothing (job behind live epoch — zero effects, and the caller
/// emits/signals nothing); Failed stopped at the first failing effect
/// after exact-owned cleanup.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnitExecOutcome {
    Applied,
    Stale,
    Failed,
}

/// Plans main-thread effects for a fresh job (Linux only): stale jobs plan
/// nothing (zero effects — stale callbacks cannot hide/show/clear newer
/// state); KeepMapped covers-then-maps-then-arms-input; Hide unmaps-then-
/// resets. Pure: same stale-empty shape as `plan_gate_effects`.
#[cfg(target_os = "linux")]
pub(crate) fn plan_unit_exec(job: u64, current: u64, window: UnitWindow) -> Vec<UnitExecEffect> {
    if job != current {
        return Vec::new();
    }
    match window {
        UnitWindow::KeepMapped => vec![UnitExecEffect::CoverVisuals, UnitExecEffect::Map, UnitExecEffect::CoverInput],
        UnitWindow::Hide => vec![UnitExecEffect::Unmap, UnitExecEffect::ResetVisuals],
    }
}

/// Runs one execution pass over injected main-thread effects (Linux only):
/// ONE continuous gate hold across recheck, every setter, and ownership
/// install/cleanup — never any gate-locking publish/snapshot helper under a
/// hold (their stores stay inlined). Every production bumper takes this
/// gate, so no generation can land mid-ops: stale setters cannot run on a
/// newer lifecycle. Setters here are synchronous nonwaiting tao proxies and
/// direct GTK writes (established: only getters block); never a getter,
/// IPC, socket, or main-thread wait runs under this hold, and injected
/// test ops must likewise take no state locks. The per-effect epoch read is
/// defense against a future non-domain writer: stop before REMAINING
/// effects the moment a newer lifecycle owns, and never install then.
/// KeepMapped installs `Some(job)` only after every effect succeeds (still
/// fresh); Hide clears exactly an owned install; any first failure runs
/// exact-owned cleanup.
#[cfg(target_os = "linux")]
pub(crate) fn run_unit_cover_exec(
    ops: &mut impl FnMut(UnitExecEffect) -> CommandResult<()>,
    gate: &Mutex<Option<u64>>,
    epoch: &AtomicU64,
    job: u64,
    window: UnitWindow,
) -> UnitExecOutcome {
    let mut held = gate.lock().unwrap();
    if epoch.load(Ordering::SeqCst) != job {
        return UnitExecOutcome::Stale;
    }
    for effect in plan_unit_exec(job, job, window) {
        if epoch.load(Ordering::SeqCst) != job {
            return UnitExecOutcome::Stale;
        }
        if ops(effect).is_err() {
            if epoch.load(Ordering::SeqCst) == job && *held == Some(job) {
                *held = None;
            }
            return UnitExecOutcome::Failed;
        }
    }
    if epoch.load(Ordering::SeqCst) != job {
        return UnitExecOutcome::Stale;
    }
    match window {
        UnitWindow::KeepMapped => *held = Some(job),
        UnitWindow::Hide => {
            if *held == Some(job) {
                *held = None;
            }
        }
    }
    UnitExecOutcome::Applied
}

/// Exact-owned dispatch cleanup (Linux only): clears a gate this job still
/// owns while still current; stale epochs and foreign gate values are left
/// alone. Runs when the main-thread queue itself fails (cover never ran).
#[cfg(target_os = "linux")]
pub(crate) fn cleanup_unit_dispatch(gate: &Mutex<Option<u64>>, epoch: &AtomicU64, job: u64) {
    let mut held = gate.lock().unwrap();
    if epoch.load(Ordering::SeqCst) == job && *held == Some(job) {
        *held = None;
    }
}

/// Worker-wake decision after a successful covered map (Linux only):
/// Sent/Coalesced proceed (a pending wake still resolves); an absent sender
/// or Disconnected cancels through exact-owned gated cancellation, or the
/// panel strands transparent. Pure.
/// RED shape: always proceeds.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnitWake {
    Proceed,
    Cancel,
}

#[cfg(target_os = "linux")]
pub(crate) fn plan_unit_wake(wake: Option<RestoreQueue>) -> UnitWake {
    match wake {
        Some(RestoreQueue::Sent) | Some(RestoreQueue::Coalesced) => UnitWake::Proceed,
        _ => UnitWake::Cancel,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::niri::gate::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_snapshot_serializes_without_anchors() {
        // The UI payload is exactly {enabled,open,roseHidden,fullscreen,
        // revision}: logical state only, never an anchor or position.
        let live = unit_snapshot_for(true, true, false, false, false, true, true, 7);
        let value = serde_json::to_value(&live).unwrap();
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["enabled", "fullscreen", "open", "revision", "roseHidden"]);
        assert_eq!(value["enabled"], true);
        assert_eq!(value["open"], true);
        assert_eq!(value["roseHidden"], false);
        assert_eq!(value["fullscreen"], false);
        assert_eq!(value["revision"], 7);
        // Off-Niri reads disabled (revision still echoes the live epoch).
        let off = unit_snapshot_for(true, true, false, false, true, false, false, 7);
        assert!(!off.enabled);
        assert_eq!(off.revision, 7);
        // The disabled literal is fully false at revision zero.
        let value = serde_json::to_value(&NiriUnitSnapshot::disabled()).unwrap();
        assert_eq!(value["enabled"], false);
        assert_eq!(value["revision"], 0);
        // Effective fullscreen: a closed unit with stored desired expanded
        // reads fullscreen false; reopening restores the effective mode.
        let closed_full = unit_snapshot_for(true, false, true, true, false, true, true, 9);
        assert!(!closed_full.fullscreen);
        assert_eq!(closed_full.revision, 9);
        let reopened = unit_snapshot_for(true, true, true, true, false, true, true, 10);
        assert!(reopened.fullscreen);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_stale_publish_is_noop() {
        // Epoch change rejects stale mutations with no effects; a current
        // revision applies exactly once. Lock-injected (no Shell/AppHandle).
        use std::sync::atomic::AtomicU64;
        let gate = Mutex::new(None);
        let unit = Mutex::new(NiriUnitState::dormant());
        let epoch = AtomicU64::new(9);
        assert!(!publish_unit_open(&gate, &unit, &epoch, 8, true), "stale open must not apply");
        assert!(!publish_unit_activation(&gate, &unit, &epoch, 8, true), "stale activation must not apply");
        assert!(!unit.lock().unwrap().open);
        assert!(!unit.lock().unwrap().active);
        assert!(publish_unit_activation(&gate, &unit, &epoch, 9, true));
        assert!(publish_unit_open(&gate, &unit, &epoch, 9, true));
        assert!(unit.lock().unwrap().active);
        assert!(unit.lock().unwrap().open);
        epoch.store(10, Ordering::SeqCst);
        assert!(!publish_unit_open(&gate, &unit, &epoch, 9, false), "superseded revision must not close");
        assert!(unit.lock().unwrap().open);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_ready_handshake() {
        // Render-ready ack: stale rejected, matching accepted, disabled is
        // zero-effects, and a new revision resets readiness. Lock-injected.
        use std::sync::atomic::AtomicU64;
        let gate = Mutex::new(None);
        let unit = Mutex::new(NiriUnitState::dormant());
        let epoch = AtomicU64::new(9);
        assert!(!ack_unit_ready(&gate, &unit, &epoch, false, true, true, 9), "dormant ack changes nothing");
        assert!(unit.lock().unwrap().ready.is_none());
        assert!(publish_unit_activation(&gate, &unit, &epoch, 9, true));
        assert!(!ack_unit_ready(&gate, &unit, &epoch, true, true, true, 9), "app-placed sessions stay old-path");
        assert!(unit.lock().unwrap().ready.is_none());
        assert!(!ack_unit_ready(&gate, &unit, &epoch, false, true, true, 8), "stale ack rejected");
        assert!(unit.lock().unwrap().ready.is_none());
        assert!(ack_unit_ready(&gate, &unit, &epoch, false, true, true, 9), "live enabled ack accepted");
        assert_eq!(unit.lock().unwrap().ready, Some(9));
        assert!(unit_ready_for(&gate, &unit, &epoch, 9));
        assert!(!unit_ready_for(&gate, &unit, &epoch, 8));
        epoch.store(10, Ordering::SeqCst);
        assert!(!unit_ready_for(&gate, &unit, &epoch, 9), "old ack must not match the new job");
        assert!(publish_unit_open(&gate, &unit, &epoch, 10, true), "fresh transition applies");
        assert!(unit.lock().unwrap().ready.is_none(), "actual transition clears readiness");
        assert!(!unit_ready_for(&gate, &unit, &epoch, 10), "worker waits for the new ack");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_publish_is_gate_serialized_against_bumps() {
        // B1: a gate-held epoch bump (the shape of every production bumper:
        // mode_take_generation/take_hide_generation/gated handoffs) must not
        // land inside the check→store window. Main holds the gate while a
        // worker publishes, then bumps and releases: the worker must block
        // until release, then refuse stale with no effects. Bounded channel
        // rendezvous only — no sleeps, no unbounded waits.
        use std::sync::atomic::AtomicU64;
        let gate = Mutex::new(None);
        let unit = Mutex::new(NiriUnitState::dormant());
        let epoch = AtomicU64::new(9);
        let (done_tx, done_rx) = mpsc::channel::<bool>();
        thread::scope(|scope| {
            let held = gate.lock().unwrap();
            scope.spawn(|| {
                done_tx.send(publish_unit_open(&gate, &unit, &epoch, 9, true)).unwrap();
            });
            // Still inside the hold, the worker must not have finished: a
            // completed publish here proves the check→store window is NOT
            // serialized (pre-B1 shape), and the asserts below then observe
            // a stale store reported fresh.
            assert!(
                done_rx.recv_timeout(Duration::from_millis(100)).is_err(),
                "publish must block on the held gate"
            );
            epoch.fetch_add(1, Ordering::SeqCst);
            drop(held);
            assert_eq!(done_rx.recv_timeout(Duration::from_secs(30)).unwrap(), false);
        });
        assert_eq!(epoch.load(Ordering::SeqCst), 10);
        assert!(!unit.lock().unwrap().open, "stale publish must store nothing");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_plan_maps_routes_to_state_and_intent() {
        // Planner matrix: toggle flips logical open only; setters carry the
        // rest; compact routes preserve; collapse without an anchor falls
        // back to the calibrated base (S15/S17), everything else preserves.
        use RestoreIntent::*;
        assert_eq!(
            plan_unit_transition(UnitTransition::Toggle, false, false, false, true),
            UnitPlan { open: true, expanded: false, rose_hidden: false, intent: PreserveCompact }
        );
        assert_eq!(
            plan_unit_transition(UnitTransition::Toggle, true, false, false, true),
            UnitPlan { open: false, expanded: false, rose_hidden: false, intent: PreserveCompact }
        );
        assert_eq!(
            plan_unit_transition(UnitTransition::Open, false, false, true, true),
            UnitPlan { open: true, expanded: false, rose_hidden: true, intent: PreserveCompact }
        );
        assert_eq!(
            plan_unit_transition(UnitTransition::Close, true, false, false, true),
            UnitPlan { open: false, expanded: false, rose_hidden: false, intent: PreserveCompact }
        );
        assert_eq!(
            plan_unit_transition(UnitTransition::SetRoseHidden(true), true, false, false, true),
            UnitPlan { open: true, expanded: false, rose_hidden: true, intent: PreserveCompact }
        );
        assert_eq!(
            plan_unit_transition(UnitTransition::SetExpanded(true), true, false, true, true),
            UnitPlan { open: true, expanded: true, rose_hidden: true, intent: PreserveCompact }
        );
        assert_eq!(
            plan_unit_transition(UnitTransition::SetExpanded(false), true, true, true, true),
            UnitPlan { open: true, expanded: false, rose_hidden: true, intent: PreserveCompact }
        );
        assert_eq!(
            plan_unit_transition(UnitTransition::SetExpanded(false), true, true, true, false),
            UnitPlan { open: true, expanded: false, rose_hidden: true, intent: CollapseToBase }
        );
        assert_eq!(
            plan_unit_transition(UnitTransition::Close, true, true, false, true),
            UnitPlan { open: false, expanded: true, rose_hidden: false, intent: PreserveCompact },
            "Close keeps the stored desired expanded for reopen"
        );
        assert_eq!(
            plan_unit_transition(UnitTransition::Open, false, false, false, false),
            UnitPlan { open: true, expanded: false, rose_hidden: false, intent: BootstrapBase },
            "unanchored open must calibrate the base"
        );
        assert_eq!(
            plan_unit_transition(UnitTransition::Toggle, false, false, true, false),
            UnitPlan { open: true, expanded: false, rose_hidden: true, intent: BootstrapBase },
            "unanchored toggle-to-open must calibrate the base"
        );
        assert_eq!(
            plan_unit_transition(UnitTransition::Toggle, true, false, false, false),
            UnitPlan { open: false, expanded: false, rose_hidden: false, intent: PreserveCompact },
            "toggle-to-close needs no base"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_window_decides_mapping_without_the_dot() {
        // S26/Bug 1: the single surface stays mapped on every transition —
        // open, fullscreen, close with rose wanted, and close with hidden
        // rose (covered at opacity 0, never unmapped). Physical visibility
        // is never an input.
        assert_eq!(unit_window_for(true, false, false), UnitWindow::KeepMapped);
        assert_eq!(unit_window_for(true, true, true), UnitWindow::KeepMapped);
        assert_eq!(unit_window_for(false, false, false), UnitWindow::KeepMapped);
        assert_eq!(unit_window_for(false, true, false), UnitWindow::KeepMapped);
        assert_eq!(unit_window_for(false, false, true), UnitWindow::KeepMapped);
        assert_eq!(
            unit_window_for(false, true, true),
            UnitWindow::KeepMapped,
            "closed fullscreen with hidden rose stays mapped covered: desired expanded is irrelevant when closed"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_commit_routes_toggle_open_hide() {
        // Production commit through the real helper (lock-injected): toggle
        // from closed+rose-shown opens at a fresh revision with preserved
        // intent; hide then lands logical false while staying mapped
        // covered (Bug 1: commit, no reveal — never a visible rose-only
        // surface). No worker wake here: glue signals via `signal_restore`
        // only after covered readiness is performed.
        use std::sync::atomic::AtomicU64;
        let gate = Mutex::new(None);
        let unit = Mutex::new(NiriUnitState::dormant());
        unit.lock().unwrap().active = true;
        let epoch = AtomicU64::new(9);
        let expanded = Mutex::new(false);
        let rose = AtomicBool::new(false);
        let intents = Mutex::new(None);
        let snap = unit_transition_commit(&gate, &unit, &epoch, &expanded, &rose, &intents, false, true, true, true, UnitTransition::Toggle)
            .expect("active Niri toggle must route shared");
        assert_eq!(snap.revision, 10);
        assert!(snap.enabled && snap.open);
        assert!(unit.lock().unwrap().open);
        assert_eq!(epoch.load(Ordering::SeqCst), 10);
        assert_eq!(*intents.lock().unwrap(), Some((10, RestoreIntent::PreserveCompact)));
        assert_eq!(unit_window_for(snap.open, snap.rose_hidden, snap.fullscreen), UnitWindow::KeepMapped);
        let hid = unit_transition_commit(&gate, &unit, &epoch, &expanded, &rose, &intents, false, true, true, true, UnitTransition::Close)
            .expect("hide must route shared");
        assert_eq!(hid.revision, 11);
        assert!(!hid.open, "hide lands logical false");
        assert!(!unit.lock().unwrap().open);
        assert_eq!(unit_window_for(hid.open, hid.rose_hidden, hid.fullscreen), UnitWindow::KeepMapped, "hide stays mapped covered");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_commit_dormant_or_non_niri_routes_legacy_untouched() {
        // Dormant (never activated) and every non-Niri env route legacy:
        // no generation, no writes, no intent. Only the fully
        // active Niri row commits.
        use std::sync::atomic::AtomicU64;
        for (active, places, is_niri, socket, routed) in [
            (false, false, true, true, false),
            (true, true, true, true, false),
            (true, false, false, true, false),
            (true, false, true, false, false),
            (true, false, true, true, true),
        ] {
            let gate = Mutex::new(None);
            let unit = Mutex::new(NiriUnitState::dormant());
            unit.lock().unwrap().active = active;
            let epoch = AtomicU64::new(9);
            let expanded = Mutex::new(false);
            let rose = AtomicBool::new(false);
            let intents = Mutex::new(None);
            let res = unit_transition_commit(&gate, &unit, &epoch, &expanded, &rose, &intents, places, is_niri, socket, true, UnitTransition::Toggle);
            assert_eq!(res.is_some(), routed, "active={active} places={places} niri={is_niri} socket={socket}");
            if !routed {
                assert_eq!(epoch.load(Ordering::SeqCst), 9, "no generation taken");
                assert!(!unit.lock().unwrap().open, "no state written");
                assert_eq!(*intents.lock().unwrap(), None, "no intent published");
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_commit_supersedes_stale_snapshots() {
        // Sequential commits supersede: the first snapshot goes stale
        // (revision behind live), live state is the latest commit, and the
        // epoch advanced exactly once per commit — stale callbacks keyed to
        // the old revision must not mutate, show, or hide newer state.
        use std::sync::atomic::AtomicU64;
        let gate = Mutex::new(None);
        let unit = Mutex::new(NiriUnitState::dormant());
        unit.lock().unwrap().active = true;
        let epoch = AtomicU64::new(9);
        let expanded = Mutex::new(false);
        let rose = AtomicBool::new(false);
        let intents = Mutex::new(None);
        let commit = |kind| {
            unit_transition_commit(&gate, &unit, &epoch, &expanded, &rose, &intents, false, true, true, true, kind).unwrap()
        };
        let first = commit(UnitTransition::Toggle);
        let second = commit(UnitTransition::Close);
        assert_eq!((first.revision, second.revision), (10, 11));
        assert_eq!(epoch.load(Ordering::SeqCst), 11);
        assert_ne!(first.revision, epoch.load(Ordering::SeqCst), "first snapshot is stale");
        assert!(!unit.lock().unwrap().open, "live state is the latest commit");
        assert!(!second.open);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_commit_carries_owned_gate_leaves_others() {
        // Owned cover transfers: a gate holding exactly the pre-bump
        // generation moves to the fresh revision in the same hold (matching
        // restore_handoff); ungated (None) claims no coverage; a stale gate
        // belongs to another lifecycle and is left alone — never cleared.
        // Stale owed base intent never carries into the fresh publish.
        use std::sync::atomic::AtomicU64;
        let commit = |gate_val, owed: Option<(u64, RestoreIntent)>| {
            let gate = Mutex::new(gate_val);
            let unit = Mutex::new(NiriUnitState::dormant());
            unit.lock().unwrap().active = true;
            let epoch = AtomicU64::new(9);
            let expanded = Mutex::new(false);
            let rose = AtomicBool::new(false);
            let intents = Mutex::new(owed);
            let snap = unit_transition_commit(&gate, &unit, &epoch, &expanded, &rose, &intents, false, true, true, true, UnitTransition::Toggle).unwrap();
            let held = *gate.lock().unwrap();
            let stored = *intents.lock().unwrap();
            (snap.revision, held, stored)
        };
        assert_eq!(commit(Some(9), None), (10, Some(10), Some((10, RestoreIntent::PreserveCompact))));
        assert_eq!(commit(None, None), (10, None, Some((10, RestoreIntent::PreserveCompact))));
        assert_eq!(commit(Some(7), None), (10, Some(7), Some((10, RestoreIntent::PreserveCompact))));
        assert_eq!(
            commit(Some(9), Some((7, RestoreIntent::CollapseToBase))),
            (10, Some(10), Some((10, RestoreIntent::PreserveCompact))),
            "stale owed base must not carry"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_cover_executes_opacity_map_input_in_order() {
        // Exact effect order: opacity-0+focus-off BEFORE map, map BEFORE
        // input-arm (tao abort invariant). A fresh job applies all three
        // and installs owned gate coverage.
        use std::sync::atomic::AtomicU64;
        let gate = Mutex::new(None);
        let epoch = AtomicU64::new(9);
        let mut log: Vec<UnitExecEffect> = Vec::new();
        let mut ops = |effect: UnitExecEffect| -> CommandResult<()> {
            log.push(effect);
            Ok(())
        };
        assert_eq!(run_unit_cover_exec(&mut ops, &gate, &epoch, 9, UnitWindow::KeepMapped), UnitExecOutcome::Applied);
        assert_eq!(log, vec![UnitExecEffect::CoverVisuals, UnitExecEffect::Map, UnitExecEffect::CoverInput]);
        assert_eq!(*gate.lock().unwrap(), Some(9));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_cover_hide_unmaps_and_resets_with_owned_cleanup() {
        // Hide unmaps before resetting visuals, then clears exactly the
        // owned gate — never a foreign value, never after a stale epoch.
        use std::sync::atomic::AtomicU64;
        let gate = Mutex::new(Some(9));
        let epoch = AtomicU64::new(9);
        let mut log: Vec<UnitExecEffect> = Vec::new();
        let mut ops = |effect: UnitExecEffect| -> CommandResult<()> {
            log.push(effect);
            Ok(())
        };
        assert_eq!(run_unit_cover_exec(&mut ops, &gate, &epoch, 9, UnitWindow::Hide), UnitExecOutcome::Applied);
        assert_eq!(log, vec![UnitExecEffect::Unmap, UnitExecEffect::ResetVisuals]);
        assert_eq!(*gate.lock().unwrap(), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_cover_stale_plans_nothing() {
        // A stale queued callback runs zero effects and touches nothing:
        // no hide/show/clear, no emit/signal downstream (outcome-gated).
        use std::sync::atomic::AtomicU64;
        let gate = Mutex::new(Some(7));
        let epoch = AtomicU64::new(10);
        let mut log: Vec<UnitExecEffect> = Vec::new();
        let mut ops = |effect: UnitExecEffect| -> CommandResult<()> {
            log.push(effect);
            Ok(())
        };
        assert_eq!(run_unit_cover_exec(&mut ops, &gate, &epoch, 9, UnitWindow::Hide), UnitExecOutcome::Stale);
        assert!(log.is_empty());
        assert_eq!(*gate.lock().unwrap(), Some(7));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_cover_failure_stops_and_cleans_owned_gate() {
        // The first failing effect stops the pass; an owned install is
        // cleared while still current, a foreign gate value is left alone.
        use std::sync::atomic::AtomicU64;
        let run_failing = |gate_val: Option<u64>| {
            let gate = Mutex::new(gate_val);
            let epoch = AtomicU64::new(9);
            let mut log: Vec<UnitExecEffect> = Vec::new();
            let mut ops = |effect: UnitExecEffect| -> CommandResult<()> {
                log.push(effect);
                if effect == UnitExecEffect::Map {
                    Err("injected cover failure".to_owned())
                } else {
                    Ok(())
                }
            };
            let outcome = run_unit_cover_exec(&mut ops, &gate, &epoch, 9, UnitWindow::KeepMapped);
            let held = *gate.lock().unwrap();
            (outcome, log, held)
        };
        assert_eq!(
            run_failing(Some(9)),
            (UnitExecOutcome::Failed, vec![UnitExecEffect::CoverVisuals, UnitExecEffect::Map], None)
        );
        assert_eq!(
            run_failing(Some(7)),
            (UnitExecOutcome::Failed, vec![UnitExecEffect::CoverVisuals, UnitExecEffect::Map], Some(7))
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_dispatch_cleanup_clears_only_owned_current() {
        // Main-thread queue failure (cover never ran): clear exactly the
        // owned current install; stale epochs and foreign values stay.
        use std::sync::atomic::AtomicU64;
        let gate = Mutex::new(Some(9));
        let epoch = AtomicU64::new(9);
        cleanup_unit_dispatch(&gate, &epoch, 9);
        assert_eq!(*gate.lock().unwrap(), None);
        *gate.lock().unwrap() = Some(9);
        epoch.store(10, Ordering::SeqCst);
        cleanup_unit_dispatch(&gate, &epoch, 9);
        assert_eq!(*gate.lock().unwrap(), Some(9), "stale epoch keeps its metadata");
        *gate.lock().unwrap() = Some(7);
        cleanup_unit_dispatch(&gate, &epoch, 9);
        assert_eq!(*gate.lock().unwrap(), Some(7), "foreign gate keeps its metadata");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_cover_holds_gate_across_setters() {
        // Owned-lock guarantee: a gate-held bumper (every production bumper
        // shape) cannot land mid-ops — it blocks until the pass completes.
        // The worker parks inside its first effect (bounded rendezvous);
        // the bumper must still be waiting, then both finish serialized:
        // Applied, full order, install at 9, bump to 10. Proves stale
        // setters can never run on a newer lifecycle. Test-only hold across
        // a channel wait (bounded 30s, main guarantees release); production
        // ops are synchronous nonblocking setters and never wait under hold.
        use std::sync::atomic::AtomicU64;
        let gate = Mutex::new(None);
        let epoch = AtomicU64::new(9);
        let (inside_tx, inside_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (bumped_tx, bumped_rx) = mpsc::channel::<u64>();
        let (done_tx, done_rx) = mpsc::channel::<(UnitExecOutcome, Vec<UnitExecEffect>)>();
        let (gate_ref, epoch_ref) = (&gate, &epoch);
        thread::scope(|scope| {
            scope.spawn(move || {
                let mut log: Vec<UnitExecEffect> = Vec::new();
                let mut first = true;
                let mut ops = |effect: UnitExecEffect| -> CommandResult<()> {
                    log.push(effect);
                    if first {
                        first = false;
                        inside_tx.send(()).unwrap();
                        release_rx.recv_timeout(Duration::from_secs(30)).unwrap();
                    }
                    Ok(())
                };
                let outcome = run_unit_cover_exec(&mut ops, gate_ref, epoch_ref, 9, UnitWindow::KeepMapped);
                done_tx.send((outcome, log)).unwrap();
            });
            inside_rx.recv_timeout(Duration::from_secs(30)).unwrap();
            scope.spawn(move || {
                let _held = gate_ref.lock().unwrap();
                let next = epoch_ref.fetch_add(1, Ordering::SeqCst) + 1;
                bumped_tx.send(next).unwrap();
            });
            assert!(
                bumped_rx.recv_timeout(Duration::from_millis(100)).is_err(),
                "bumper must block while the cover holds the gate"
            );
            release_tx.send(()).unwrap();
            let (outcome, log) = done_rx.recv_timeout(Duration::from_secs(30)).unwrap();
            assert_eq!(outcome, UnitExecOutcome::Applied);
            assert_eq!(log, vec![UnitExecEffect::CoverVisuals, UnitExecEffect::Map, UnitExecEffect::CoverInput]);
            assert_eq!(bumped_rx.recv_timeout(Duration::from_secs(30)).unwrap(), 10);
        });
        assert_eq!(epoch.load(Ordering::SeqCst), 10);
        assert_eq!(*gate.lock().unwrap(), Some(9), "install lands before the blocked bump");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_cover_stops_remaining_effects_on_newer_owner() {
        // A newer lifecycle owning the epoch mid-ops (here a gateless bump
        // injected by the effect itself, modeling a non-domain writer)
        // stops the pass before the REMAINING effects: the stale setter
        // never runs, the gate is untouched, nothing emits downstream.
        use std::sync::atomic::AtomicU64;
        let gate = Mutex::new(None);
        let epoch = AtomicU64::new(9);
        let mut log: Vec<UnitExecEffect> = Vec::new();
        let mut ops = |effect: UnitExecEffect| -> CommandResult<()> {
            log.push(effect);
            if effect == UnitExecEffect::Map {
                epoch.fetch_add(1, Ordering::SeqCst);
            }
            Ok(())
        };
        assert_eq!(run_unit_cover_exec(&mut ops, &gate, &epoch, 9, UnitWindow::KeepMapped), UnitExecOutcome::Stale);
        assert_eq!(log, vec![UnitExecEffect::CoverVisuals, UnitExecEffect::Map]);
        assert_eq!(*gate.lock().unwrap(), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_wake_proceeds_only_on_live_worker() {
        // Sent and Coalesced (a wake already pending) proceed; an absent
        // sender or Disconnected cancels through exact-owned gated
        // cancellation instead of stranding the panel transparent.
        assert_eq!(plan_unit_wake(Some(RestoreQueue::Sent)), UnitWake::Proceed);
        assert_eq!(plan_unit_wake(Some(RestoreQueue::Coalesced)), UnitWake::Proceed);
        assert_eq!(plan_unit_wake(Some(RestoreQueue::Disconnected)), UnitWake::Cancel);
        assert_eq!(plan_unit_wake(None), UnitWake::Cancel);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_commit_then_window_missing_cleans_owned_gate() {
        // D1 sequence at the production core (no AppHandle headless): a
        // commit carries the owned gate to the fresh revision; a window
        // lookup failure afterwards runs the same exact-owned cleanup as a
        // queue failure — the carried install is cleared, committed state
        // itself is never rewritten by cleanup.
        use std::sync::atomic::AtomicU64;
        let gate = Mutex::new(Some(9));
        let unit = Mutex::new(NiriUnitState::dormant());
        unit.lock().unwrap().active = true;
        let epoch = AtomicU64::new(9);
        let expanded = Mutex::new(false);
        let rose = AtomicBool::new(false);
        let intents = Mutex::new(None);
        let snap = unit_transition_commit(&gate, &unit, &epoch, &expanded, &rose, &intents, false, true, true, true, UnitTransition::Toggle).unwrap();
        assert_eq!((snap.revision, *gate.lock().unwrap()), (10, Some(10)));
        cleanup_unit_dispatch(&gate, &epoch, snap.revision);
        assert_eq!(*gate.lock().unwrap(), None);
        assert!(unit.lock().unwrap().open, "cleanup never rewrites committed state");
        assert_eq!(epoch.load(Ordering::SeqCst), 10);
    }
}
