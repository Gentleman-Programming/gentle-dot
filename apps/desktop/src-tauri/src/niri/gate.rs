use crate::niri::{CompactSpot, PanelWindow};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

/// Budgets for one restore job (Linux only): at most this total per job,
/// one aggregate query/action pass at a time, worker-thread readiness polls
/// between passes.
#[cfg(target_os = "linux")]
pub(crate) const NATIVE_RESTORE_JOB: Duration = Duration::from_secs(30);
#[cfg(target_os = "linux")]
// Native nested Niri returned valid Windows replies in 0.74–2.01 s;
// 250 ms manufactured failures and flooded its queue with discarded queries.
pub(crate) const NATIVE_RESTORE_PASS: Duration = Duration::from_secs(3);
#[cfg(target_os = "linux")]
pub(crate) const NATIVE_RESTORE_POLL: Duration = Duration::from_millis(50);
/// Per-settle client-size budget (Linux only): one `settle_shared_size` poll
/// window. Live Niri honors the requested size only on remap, so a settle
/// must survive the 750 ms job that the old code consumed with ~15 stale
/// re-requests: 1200 ms covers the observed remap latency. Override with
/// `GENTLE_DOT_NIRI_SETTLE_MS` (100..10000 ms, invalid/zero fall back).
/// The job budget above covers two settles plus the rest of the sequence.
#[cfg(target_os = "linux")]
pub(crate) const NATIVE_SETTLE_DEFAULT_MS: u64 = 1200;
#[cfg(target_os = "linux")]
const NATIVE_SETTLE_MS_MIN: u64 = 100;
#[cfg(target_os = "linux")]
const NATIVE_SETTLE_MS_MAX: u64 = 10_000;
/// Stale slice before a settle remaps (Linux only): while the window stays
/// mapped with opacity 0 the size change never reaches the compositor, so a
/// settle that only re-requests spins stale; after this slice it must
/// hide+show and keep polling.
#[cfg(target_os = "linux")]
pub(crate) const NATIVE_SETTLE_REMAP_AFTER: Duration = Duration::from_millis(150);
#[cfg(target_os = "linux")]
pub(crate) fn parse_shared_settle_ms(raw: Option<&str>) -> Duration {
    let default = Duration::from_millis(NATIVE_SETTLE_DEFAULT_MS);
    let Some(value) = raw else { return default; };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return default;
    }
    let Ok(parsed) = trimmed.parse::<u64>() else { return default; };
    if parsed == 0 {
        return default;
    }
    if parsed < NATIVE_SETTLE_MS_MIN {
        return Duration::from_millis(NATIVE_SETTLE_MS_MIN);
    }
    if parsed > NATIVE_SETTLE_MS_MAX {
        return Duration::from_millis(NATIVE_SETTLE_MS_MAX);
    }
    Duration::from_millis(parsed)
}
#[cfg(target_os = "linux")]
pub(crate) fn shared_settle_budget() -> Duration {
    parse_shared_settle_ms(std::env::var("GENTLE_DOT_NIRI_SETTLE_MS").ok().as_deref())
}
/// Idle heartbeat for the restore wait.
#[cfg(target_os = "linux")]
const RESTORE_WAKE_TIMEOUT: Duration = Duration::from_millis(500);

/// Whether the hide hook captures the compact spot (Linux only):
/// compact and visibly mapped only, so expanded geometry can never overwrite it.
/// The mode hook does not consult the recorded flag — capture proves floating itself.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn native_capture_gate(desired_expanded: bool, visible: bool) -> bool {
    !desired_expanded && visible
}

/// Folds a fresh capture into memory (Linux only): `Some` wins while
/// `None`/errors preserve.
#[cfg(target_os = "linux")]
pub(crate) fn merge_compact_spot(current: Option<CompactSpot>, fresh: Option<CompactSpot>) -> Option<CompactSpot> {
    fresh.or(current)
}

/// Whether a queued restore job is still current: `job == current`.
/// Eligibility only — callers decide intent separately.
#[cfg(target_os = "linux")]
pub(crate) fn restore_job_fresh(job: u64, current: u64) -> bool {
    job == current
}

/// First-visible-frame gate (Niri compact only, Linux only):
/// opacity applied before mapping, so the first frame never shows the
/// pre-restore spot. Hidden is exactly 0, reveal restores exactly 1.
/// Not proven atomic: opacity 0 shares the map's main-thread closure,
/// but GTK commit timing is unverified.
#[cfg(target_os = "linux")]
pub(crate) const GATED_OPACITY_HIDDEN: f64 = 0.0;
#[cfg(target_os = "linux")]
pub(crate) const GATED_OPACITY_SHOWN: f64 = 1.0;

#[cfg(target_os = "linux")]
pub(crate) fn native_recovery_show_gated() -> bool {
    // Independent legacy direct-show route if shared IPC positioning fails.
    false
}

/// Whether a gated completion may reveal (Linux only): the job must still be
/// the current generation and still hold the gate (`job == current && gate ==
/// Some(job)`). Stale completions never reveal, refocus, or emit.
#[cfg(target_os = "linux")]
pub(crate) fn gate_reveal_fresh(job: u64, current: u64, gate: Option<u64>) -> bool {
    job == current && gate == Some(job)
}

/// Snapshots panel visibility for native hide/mode paths.
/// MUST run before taking any native lock: Tauri getters proxy to the main
/// thread and wait for a response, while main-thread handlers (tray toggle,
/// single-instance launch) take the mode lock to run — waiting on a getter
/// while holding that lock deadlocks permanently. Fail-closed and lock-free:
/// `Err` reads as hidden.
#[cfg(target_os = "linux")]
pub(crate) fn snapshot_visible<E>(getter: impl FnOnce() -> Result<bool, E>) -> bool {
    matches!(getter(), Ok(true))
}

/// Single capture decision for the hide and mode hooks: query only on
/// positive visibility AND a stable generation. The recorded mode flag is
/// NOT consulted — it is not proof of the compositor state; capture_compact_spot itself returns None for non-floating
/// panels. A negative/Err snapshot always skips — independent of epoch — and
/// any generation change also skips: a racing lifecycle may have remapped, and
/// capture-before-hide stays fail-closed on stale rather than inferring a
/// positive it never observed. Callers derive all inputs outside native locks.
#[cfg(target_os = "linux")]
pub(crate) fn decide_native_capture(
    visible: bool,
    snapshot_epoch: u64,
    current_epoch: u64,
    capture: impl FnOnce() -> Option<CompactSpot>,
) -> Option<CompactSpot> {
    if !visible || snapshot_epoch != current_epoch {
        return None;
    }
    capture()
}

/// Clips a readiness pause to the remaining job budget, so restore jobs end at exactly `NATIVE_RESTORE_JOB`: an unclipped sleep would
/// overshoot the deadline by up to one full poll past expiry.
#[cfg(target_os = "linux")]
pub(crate) fn clipped_poll(remaining: Duration) -> Duration {
    remaining.min(NATIVE_RESTORE_POLL)
}

/// Drains stale wakes; wakes carry no payload — the generation is shared —
/// so collapsing bursts is always safe.
#[cfg(target_os = "linux")]
pub(crate) const RESTORE_DRAIN_CAP: usize = 4;

#[cfg(target_os = "linux")]
pub(crate) fn drain_stale_wakes(rx: &mpsc::Receiver<()>, cap: usize) -> usize {
    let mut drained = 0;
    while drained < cap {
        if rx.try_recv().is_ok() {
            drained += 1;
        } else {
            break;
        }
    }
    drained
}

/// Opt-in Niri diagnostic trace: `GENTLE_DOT_NIRI_TRACE=1` only, default off.
/// Allowlist only: job/epoch/desired/visibility/capture gate/chosen id/floating/
/// position/output/delta/Handled/error category/queue result/worker end reason.
/// Never window JSON, titles, socket paths, accounts, env dumps, or content.
pub(crate) const NIRI_TRACE_PASS_CAP: usize = 15;
pub(crate) fn niri_trace_enabled(value: Option<&str>) -> bool {
    value == Some("1")
}
pub(crate) fn niri_trace_on() -> bool {
    niri_trace_enabled(std::env::var("GENTLE_DOT_NIRI_TRACE").ok().as_deref())
}
macro_rules! niri_trace {
    ($($arg:tt)*) => {
        if crate::niri::gate::niri_trace_on() {
            eprintln!("gentle-dot niri-trace {}", format!($($arg)*));
        }
    };
}

pub(crate) use niri_trace;
/// One-line allowlisted panel summary; no titles, socket paths, or window JSON.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn format_trace_panel(id: u64, floating: bool, pos: Option<(f64, f64)>, size: (i32, i32), output: Option<&str>, delta: Option<(i32, i32)>, handled: Option<bool>) -> String {
    let pos = pos.map_or("none".to_owned(), |(x, y)| format!("{x:.1},{y:.1}"));
    let delta = delta.map_or("none".to_owned(), |(dx, dy)| format!("{dx},{dy}"));
    let handled = handled.map_or("none".to_owned(), |h| h.to_string());
    format!("id={id} floating={floating} pos={pos} size={}x{} output={} delta={delta} handled={handled}", size.0, size.1, output.unwrap_or("none"))
}

/// Queue outcome of one restore handoff: `Sent` and
/// `Coalesced` (full channel) both reach the single worker — coalescing
/// converges on the latest generation after the wait drains — while
/// `Disconnected` has no consumer, so no completion will ever arrive.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestoreQueue {
    Sent,
    Coalesced,
    Disconnected,
}

/// Genuine restore intent: what a restore job is
/// allowed to do with the session base. Freshness (generation equality) is
/// eligibility only — it never selects intent. `PreserveCompact` keeps the
/// remembered anchor; `CollapseToBase` is an explicit user/compositor base
/// reset; `BootstrapBase` is the first show with no session anchor yet.
/// Calibration of an explicit base is a later unit; until then a
/// base-unavailable job fails explicitly instead of adopting an arbitrary
/// compositor position.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestoreIntent {
    PreserveCompact,
    CollapseToBase,
    BootstrapBase,
}

/// Initial show without a session anchor explicitly bootstraps; reopen with a saved anchor preserves.
#[cfg(target_os = "linux")]
pub(crate) fn restore_intent_for_show(saved_some: bool) -> RestoreIntent {
    if saved_some {
        RestoreIntent::PreserveCompact
    } else {
        RestoreIntent::BootstrapBase
    }
}

/// Mode-request intent: leaving compact (expanded/fullscreen off)
/// returns the pair to the REMEMBERED compact spot — the
/// app never throws the user's position away on a mode change. Only a request
/// with nothing remembered falls back to the calibrated upper-right base.
/// Freshness gates the commit, never the intent; invalid (non-native)
/// requests never carry base intent.
#[cfg(target_os = "linux")]
pub(crate) fn restore_intent_for_mode_request(on: bool, native_valid: bool, anchored: bool) -> RestoreIntent {
    if !on && native_valid && !anchored {
        RestoreIntent::CollapseToBase
    } else {
        RestoreIntent::PreserveCompact
    }
}

/// Intent carry: a plain refresh that bumps past a
/// still-connected live gate must not downgrade an owed base intent. A
/// live owed `CollapseToBase`/`BootstrapBase` survives a `PreserveCompact`
/// refresh; every other combination stores the requested intent.
#[cfg(target_os = "linux")]
pub(crate) fn carried_restore_intent(
    owed: Option<(u64, RestoreIntent)>,
    current: u64,
    requested: RestoreIntent,
) -> RestoreIntent {
    match owed {
        Some((gen, owed_intent))
            if gen == current
                && matches!(
                    owed_intent,
                    RestoreIntent::CollapseToBase | RestoreIntent::BootstrapBase
                )
                && requested == RestoreIntent::PreserveCompact =>
        {
            owed_intent
        }
        _ => requested,
    }
}

/// Resolves the intent owning a restore job: the
/// stored generation must equal the job AND the job must still be the live
/// epoch. Stale jobs and missing metadata resolve to `None` — callers fail
/// closed instead of inferring intent from a nil anchor. Reads under the
/// gate domain (gate lock held across the intent read), so publication and
/// read observe one atomic generation. The expanded worker path never
/// consults this: tiling manages geometry, not the compact base.
#[cfg(target_os = "linux")]
pub(crate) fn resolve_job_intent(
    job: u64,
    epoch: &AtomicU64,
    gate: &Mutex<Option<u64>>,
    intents: &Mutex<Option<(u64, RestoreIntent)>>,
) -> Option<RestoreIntent> {
    let _domain = gate.lock().unwrap();
    if !restore_job_fresh(job, epoch.load(Ordering::SeqCst)) {
        return None;
    }
    match *intents.lock().unwrap() {
        Some((gen, intent)) if gen == job => Some(intent),
        _ => None,
    }
}

/// Signals the single restore worker: `try_send` never
/// blocks. Shared by every handoff below so the queue mapping is defined
/// once; the generation bump itself always runs inside the single domain.
#[cfg(target_os = "linux")]
pub(crate) fn signal_restore(tx: &mpsc::SyncSender<()>) -> RestoreQueue {
    match tx.try_send(()) {
        Ok(()) => RestoreQueue::Sent,
        Err(mpsc::TrySendError::Full(_)) => RestoreQueue::Coalesced,
        Err(mpsc::TrySendError::Disconnected(_)) => RestoreQueue::Disconnected,
    }
}

/// Wakes the single restore worker: bumps the generation
/// INSIDE the single gate domain and, when a gated show owns
/// the current generation, carries that gate forward to the new job — the
/// queued worker pass then settles AND reveals under one eligibility, so a
/// plain refresh (rose-unhide joint wake, ungated expanded show) can never
/// bump past a fresh gate and strand it at opacity 0. A stale or absent
/// gate is never adopted: a successor owns newer visuals, and the ungated
/// no-gate wake keeps its historical behavior (bump plus signal, gate
/// untouched). The generation-owned intent publishes in the same hold with
/// the carry rule: a `PreserveCompact` refresh never downgrades
/// an owed `CollapseToBase`/`BootstrapBase`. Brief gate hold only, never
/// across socket IPC or main-thread waits; callers holding `native_restore`
/// nest restore-before-gate, never the reverse.
#[cfg(target_os = "linux")]
pub(crate) fn restore_handoff(
    tx: &mpsc::SyncSender<()>,
    epoch: &AtomicU64,
    gate: &Mutex<Option<u64>>,
    intent: RestoreIntent,
    intents: &Mutex<Option<(u64, RestoreIntent)>>,
) -> (u64, RestoreQueue) {
    let mut held = gate.lock().unwrap();
    let current = epoch.load(Ordering::SeqCst);
    let owned_fresh = *held == Some(current);
    let owed = *intents.lock().unwrap();
    let next = epoch.fetch_add(1, Ordering::SeqCst) + 1;
    *intents.lock().unwrap() = Some((next, carried_restore_intent(owed, current, intent)));
    if owned_fresh {
        *held = Some(next);
        niri_trace!("handoff job={next} gate=carried-forward");
    }
    let queue = signal_restore(tx);
    niri_trace!("handoff job={next} queue={queue:?}");
    (next, queue)
}

#[cfg(target_os = "linux")]
pub(crate) fn queue_reaches_worker(queue: RestoreQueue) -> bool {
    !matches!(queue, RestoreQueue::Disconnected)
}

/// Atomic gated handoff (Linux only): bumps the generation, publishes the
/// gate, then signals capacity-1 — all under the gate lock, so the epoch and
/// the gate move together before any worker wake is observable. A fast worker
/// can therefore never complete/reveal before the store and strand opacity 0;
/// two rapid shows serialize here, so epoch order always matches gate order.
/// The signal itself never blocks (`try_send`), so holding the brief gate
/// lock across it cannot deadlock the worker's reveal (which takes the same
/// lock only briefly on completion).
#[cfg(target_os = "linux")]
pub(crate) fn gated_restore_handoff(
    tx: &mpsc::SyncSender<()>,
    epoch: &AtomicU64,
    gate: &Mutex<Option<u64>>,
    intent: RestoreIntent,
    intents: &Mutex<Option<(u64, RestoreIntent)>>,
) -> (u64, RestoreQueue) {
    gated_restore_handoff_with_send(epoch, gate, intent, intents, |_, _, _| match tx.try_send(()) {
        Ok(()) => RestoreQueue::Sent,
        Err(mpsc::TrySendError::Full(_)) => RestoreQueue::Coalesced,
        Err(mpsc::TrySendError::Disconnected(_)) => RestoreQueue::Disconnected,
    })
}

/// Test seam for the atomic gated handoff (Linux only): publication (epoch
/// bump + gate store) runs before the `send` dispatch, all under the gate
/// lock. Production passes the real `try_send`; tests pass a dispatch
/// observer that asserts the publication is already visible at send time, so
/// a store-after-send regression fails deterministically without sleeps or
/// threads. Behavior is identical to the inlined form: same lock scope,
/// same bump/store/send order, same queue mapping.
#[cfg(target_os = "linux")]
pub(crate) fn gated_restore_handoff_with_send(
    epoch: &AtomicU64,
    gate: &Mutex<Option<u64>>,
    intent: RestoreIntent,
    intents: &Mutex<Option<(u64, RestoreIntent)>>,
    send: impl FnOnce(u64, Option<u64>, RestoreIntent) -> RestoreQueue,
) -> (u64, RestoreQueue) {
    let mut held = gate.lock().unwrap();
    let next = epoch.fetch_add(1, Ordering::SeqCst) + 1;
    *held = Some(next);
    *intents.lock().unwrap() = Some((next, intent));
    let queue = send(next, *held, intent);
    niri_trace!("handoff gated job={next} queue={queue:?}");
    (next, queue)
}

/// Expected-generation compare-and-handoff: under
/// the single domain, proceed only while the epoch still equals `expected`.
/// A show/hide/mode interleaving between our commit and our handoff returns
/// `None` having queued NOTHING — never stealing the newer gate, never
/// bumping past it so a newer gated show stays revealable. The check and
/// the bump/publish share one hold, so no interleave can split them. The
/// caller treats `None` as a harmless supersede and reports a fresh read.
#[cfg(target_os = "linux")]
pub(crate) fn gated_handoff_if_expected(
    tx: &mpsc::SyncSender<()>,
    epoch: &AtomicU64,
    gate: &Mutex<Option<u64>>,
    expected: u64,
    intent: RestoreIntent,
    intents: &Mutex<Option<(u64, RestoreIntent)>>,
) -> Option<(u64, RestoreQueue)> {
    let mut held = gate.lock().unwrap();
    if epoch.load(Ordering::SeqCst) != expected {
        niri_trace!("handoff gated refuse stale expected={expected}");
        return None;
    }
    let next = epoch.fetch_add(1, Ordering::SeqCst) + 1;
    *held = Some(next);
    *intents.lock().unwrap() = Some((next, intent));
    let queue = signal_restore(tx);
    niri_trace!("handoff gated job={next} queue={queue:?}");
    Some((next, queue))
}

/// Plain twin of the above: joins the domain
/// without touching the gate value, and likewise refuses once superseded —
/// an unconditional plain bump past a newer gated show would strand it at
/// opacity 0 with its reveal guard unreachable.
#[cfg(target_os = "linux")]
pub(crate) fn plain_handoff_if_expected(
    tx: &mpsc::SyncSender<()>,
    epoch: &AtomicU64,
    gate: &Mutex<Option<u64>>,
    expected: u64,
    intent: RestoreIntent,
    intents: &Mutex<Option<(u64, RestoreIntent)>>,
) -> Option<(u64, RestoreQueue)> {
    let _held = gate.lock().unwrap();
    if epoch.load(Ordering::SeqCst) != expected {
        niri_trace!("handoff plain refuse stale expected={expected}");
        return None;
    }
    let next = epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let owed = *intents.lock().unwrap();
    *intents.lock().unwrap() = Some((next, carried_restore_intent(owed, expected, intent)));
    let queue = signal_restore(tx);
    niri_trace!("handoff job={next} queue={queue:?}");
    Some((next, queue))
}

/// Explicit reveal eligibility (Linux only): only a worker-confirmed settled
/// geometry may reveal, plus the existing freshness contract (current
/// generation and held gate). Deadline expiry, unresolvable geometry, and any
/// stale lifecycle all read ineligible and must stay hidden — never a reveal
/// at the default anchor. Stale jobs never reveal, refocus, or emit.
#[cfg(target_os = "linux")]
pub(crate) fn settled_reveal_eligible(settled: bool, job: u64, current: u64, gate: Option<u64>) -> bool {
    settled && gate_reveal_fresh(job, current, gate)
}

#[cfg(target_os = "linux")]
pub(crate) fn gated_needs_reveal_fallback(queue: RestoreQueue) -> bool {
    !queue_reaches_worker(queue)
}

/// Collapse cover acknowledgment: the main-thread
/// cover closure signals after applying opacity 0, and the mode path waits
/// for that signal BEFORE any float/size socket IPC — the acknowledged
/// order replaces the old queue-then-float race, where unordered
/// main-thread vs socket delivery could show a misplaced frame at opacity
/// 1. `Stale` (superseded while waiting) aborts the mode op; `Timeout`
/// proceeds with a best-effort visual reset, so no silent opacity-0
/// stranding on any path.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoverAck {
    Acked,
    Timeout,
    Stale,
}

/// Bound for one collapse-cover acknowledgment.
/// Event-driven (`recv_timeout`), never a fixed sleep ordering fence.
#[cfg(target_os = "linux")]
pub(crate) const COLLAPSE_COVER_ACK: Duration = Duration::from_millis(250);

/// Waits for the collapse cover with NO state lock held:
#[cfg(target_os = "linux")]
pub(crate) fn await_cover_ack(
    rx: &mpsc::Receiver<()>,
    job: u64,
    epoch: &AtomicU64,
    budget: Duration,
) -> CoverAck {
    let fresh = || restore_job_fresh(job, epoch.load(Ordering::SeqCst));
    match rx.recv_timeout(budget) {
        Ok(()) if fresh() => CoverAck::Acked,
        Ok(()) => CoverAck::Stale,
        Err(_) if fresh() => CoverAck::Timeout,
        Err(_) => CoverAck::Stale,
    }
}

/// Whether a dispatched collapse cover may apply:
/// fresh generation AND above the cancellation water. A timed-out waiter is
/// gone while its job is still fresh, so epoch-only freshness would let the
/// late cover re-apply opacity 0 after cleanup — the shared high-water mark
/// closes that. Watermark form: `cancelled` names the highest
/// cancelled generation, so any job at or below it is dead-or-cancelled while
/// any newer uncancelled job still applies. Identical outcomes to `!=` in
/// every reachable state (a fresh job always outranks the mark by native_epoch
/// monotonicity — marks only ever name fresh jobs); fail-closed otherwise.
#[cfg(target_os = "linux")]
pub(crate) fn cover_apply_allowed(job: u64, current: u64, cancelled: Option<u64>) -> bool {
    restore_job_fresh(job, current) && cancelled.map_or(true, |marked| job > marked)
}

/// Records a cover cancellation as a monotonic high-water mark: an older
/// job can never erase a newer mark — last-writer-wins would let a late cover
/// of the newer job re-apply after cleanup. Safe by native_epoch
/// monotonicity: marks only ever name fresh jobs, so the water never exceeds
/// the epoch and never blocks a newer uncancelled job (stale jobs are already
/// blocked by the epoch check in `cover_apply_allowed`).
#[cfg(target_os = "linux")]
pub(crate) fn cancel_cover_at(mark: &Mutex<Option<u64>>, job: u64) {
    let mut held = mark.lock().unwrap();
    if held.map_or(true, |marked| job > marked) {
        *held = Some(job);
    }
}

/// Takes one mode generation: bumps the epoch and
/// clears the gate atomically under the gate lock — brief, never across
/// socket or main-thread waits — so rapid toggles/show/hide serialize on
/// generations: no older job can reveal, and no newer gate is interleaved
/// between our bump and our clear. One lock only (the gate lock, shared
/// with every handoff publisher); the transition IPC below runs lock-free
/// and commits through `commit_mode_if_fresh`.
#[cfg(target_os = "linux")]
pub(crate) fn mode_take_generation(epoch: &AtomicU64, gate: &Mutex<Option<u64>>) -> u64 {
    let mut held = gate.lock().unwrap();
    let next = epoch.fetch_add(1, Ordering::SeqCst) + 1;
    *held = None;
    niri_trace!("mode take job={next}");
    next
}

/// Commits a mode result: one brief lock plus a
/// generation check, no waits. A fresh job publishes its transitioned mode;
/// a superseded job keeps the newer committed mode (last committer wins,
/// converging with the worker's actual-vs-desired reconcile).
#[cfg(target_os = "linux")]
pub(crate) fn commit_mode_if_fresh(expanded: &Mutex<bool>, job: u64, epoch: &AtomicU64, proposed: bool) -> bool {
    let mut held = expanded.lock().unwrap();
    if restore_job_fresh(job, epoch.load(Ordering::SeqCst)) {
        *held = proposed;
    } else {
        niri_trace!("mode commit skip stale job={job} keep={}", *held);
    }
    *held
}

/// Generation-domain lock order: gate → compact,
/// gate → mover, gate → hide. Every epoch bump and every anchor/mover/hide
/// mutation takes the gate lock first, so each freshness check and its write share one hold
/// and no bump can interleave between them. Compact, mover, and hide never
/// nest with each other; the mode lock (`native_expanded`) never nests with the
/// gate (mode commits release it before any handoff runs). No socket IPC,
/// Tauri getter, or main-thread wait ever runs under these locks, and no
/// caller holds compact/mover while acquiring the gate — so this order
/// cannot deadlock against itself.
///
/// Single synchronized anchor commit: the
/// generation recheck plus the write run under gate→compact, so a stale
/// wake can never undo a collapse reset or a newer user anchor, and a bump
/// attempted between check and store serializes outside instead of
/// interleaving. Callers do all IPC/geometry lock-free first and pass the
/// computed value; only this brief commit holds locks, and it never waits.
/// Returns whether the write landed. Covers anchor writes from worker mover
/// wakes, default adoption, collapse resets, and hide/mode capture merges
/// alike.
#[cfg(target_os = "linux")]
pub(crate) fn commit_compact_anchor(
    compact: &Mutex<Option<CompactSpot>>,
    gate: &Mutex<Option<u64>>,
    epoch: &AtomicU64,
    job: u64,
    next: Option<CompactSpot>,
) -> bool {
    commit_compact_anchor_with_hook(compact, gate, epoch, job, next, || {})
}

/// Atomic anchor commit with an injectable seam:
/// the production commit above delegates here with a no-op hook, so the
/// seam executes the exact production order — never a test-only copy.
/// `hook` runs between the freshness check and the store while gate and
/// compact are both held; tests use it to prove a gate-domain bump
/// attempted exactly there cannot interleave.

#[cfg(target_os = "linux")]
pub(crate) fn commit_compact_anchor_with_hook(
    compact: &Mutex<Option<CompactSpot>>,
    gate: &Mutex<Option<u64>>,
    epoch: &AtomicU64,
    job: u64,
    next: Option<CompactSpot>,
    hook: impl FnOnce(),
) -> bool {
    let _domain = gate.lock().unwrap();
    let mut held = compact.lock().unwrap();
    if !restore_job_fresh(job, epoch.load(Ordering::SeqCst)) {
        niri_trace!("anchor commit refuse stale job={job}");
        return false;
    }
    hook();
    *held = next;
    true
}

/// Generation-owned mover clear: the freshness
/// check plus the clear share gate→mover, so a superseded collapse never
/// clears a mover a newer follow just wrote. Returns whether it cleared.
#[cfg(target_os = "linux")]
pub(crate) fn clear_mover_if_fresh(
    mover: &Mutex<Option<crate::niri::Mover>>,
    gate: &Mutex<Option<u64>>,
    epoch: &AtomicU64,
    job: u64,
) -> bool {
    let _domain = gate.lock().unwrap();
    let mut held = mover.lock().unwrap();
    if !restore_job_fresh(job, epoch.load(Ordering::SeqCst)) {
        niri_trace!("mover clear refuse stale job={job}");
        return false;
    }
    *held = None;
    true
}

/// Generation-owned mover put-back: same domain —
/// a superseded worker drops its retained mover instead of resurrecting it
/// over a newer lifecycle. Returns whether it stored.
#[cfg(target_os = "linux")]
pub(crate) fn restore_mover_if_fresh(
    mover: &Mutex<Option<crate::niri::Mover>>,
    gate: &Mutex<Option<u64>>,
    epoch: &AtomicU64,
    job: u64,
    retained: crate::niri::Mover,
) -> bool {
    let _domain = gate.lock().unwrap();
    let mut held = mover.lock().unwrap();
    if !restore_job_fresh(job, epoch.load(Ordering::SeqCst)) {
        niri_trace!("mover put-back refuse stale job={job}");
        return false;
    }
    *held = Some(retained);
    true
}

/// Runs one composed Niri wire sequence under I/O ownership: runs `work` —
/// mode capture/apply or worker passes — so mode and worker traffic serialize
/// instead of interleaving mid-transaction. Returns None without running
/// `work` when superseded before the first wire. Deliberately NO post-`work`
/// freshness check: a successful handoff bumps the epoch as a SELF
/// publication, and re-checking after it would self-stale;
/// callers gate commits on the pre-handoff generation through the existing
/// fresh helpers, and wire effects reconcile on the next pass — no false
/// atomicity is claimed.
#[cfg(target_os = "linux")]
pub(crate) fn native_io_sequenced<T>(
    io: &Mutex<()>,
    epoch: &AtomicU64,
    job: u64,
    work: impl FnOnce() -> T,
) -> Option<T> {
    let _hold = io.lock().unwrap();
    if !restore_job_fresh(job, epoch.load(Ordering::SeqCst)) {
        return None;
    }
    Some(work())
}

/// Failed-operation unwind ownership: which
/// generation a cover unwind reset may run under, if any. Only a
/// dispatched cover for the still-current generation unwinds here — a
/// successor owns newer visuals, and a never-dispatched cover needs
/// nothing. Production feeds the result into the epoch-guarded
/// `queue_gate_reset`, so `Some` can never reset a newer gate either.
#[cfg(target_os = "linux")]
pub(crate) fn unwind_reset_generation(cover_dispatched: bool, job: u64, current: u64) -> Option<u64> {
    if cover_dispatched && restore_job_fresh(job, current) {
        Some(job)
    } else {
        None
    }
}

/// Which generation a dispatched collapse cover may reset under: `Own` while our failed op still owns the visuals, `Current`
/// when no live gate owns them (refused/missing/dead handoff, or a failure
/// superseded by a gateless wake) so the delivery guard passes. A live
/// newer gate always wins: stale old resets deliberately no-op instead of
/// uncovering it — the obligation transfers to the newer show's
/// settle→reveal, a newer mode's own cover chain, or unhide's wake. Pure so
/// tests cover every outcome shape without a runtime; the caller applies it
/// through `apply_cover_cleanup` and never resets a queued handoff early
/// (the reveal owns visuals until settle).
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoverCleanup {
    Own(u64),
    Current(u64),
}

#[cfg(target_os = "linux")]
pub(crate) fn plan_cover_cleanup(
    cover_dispatched: bool,
    outcome_err: bool,
    handoff_queued: bool,
    job: u64,
    current: u64,
    gate: Option<u64>,
) -> Option<CoverCleanup> {
    if !cover_dispatched {
        return None;
    }
    if !outcome_err && handoff_queued {
        return None;
    }
    if gate == Some(current) && current != job {
        return None;
    }
    // The unwind primitive owns the same-generation case; a
    // superseded failure with no live visual owner uncovers under the
    // current generation instead of stranding.
    match unwind_reset_generation(cover_dispatched, job, current) {
        Some(generation) => Some(CoverCleanup::Own(generation)),
        None => Some(CoverCleanup::Current(current)),
    }
}

/// Shared collapse-cover finish: the ONE production
/// path wired to BOTH the stale-ack arm and the post-transition tail, so no
/// early return can bypass cleanup once a cover is dispatched. Snapshots the
/// current generation plus the held gate, plans, and routes through `enqueue`;
/// production passes the real applier, tests a recorder — the suite fails if
/// the finish ever stops invoking the applier.
#[cfg(target_os = "linux")]
pub(crate) fn finish_collapse_cover_with(
    cover_dispatched: bool,
    job: u64,
    outcome_err: bool,
    handoff_queued: bool,
    current: u64,
    gate: Option<u64>,
    enqueue: &mut impl FnMut(CoverCleanup),
) {
    if let Some(cleanup) =
        plan_cover_cleanup(cover_dispatched, outcome_err, handoff_queued, job, current, gate)
    {
        enqueue(cleanup);
    }
}

/// Execution-time cover ownership: re-evaluated inside
/// the delivery closure, never frozen at queue time. `SkipNewer` while a live
/// newer gate holds the current epoch — that successor's restore owns the
/// reveal, never uncover it. Otherwise the pending uncover still applies even
/// when gateless bumps advanced the epoch without installing a visual owner;
/// `ResetClearOwn` additionally releases our own stale gate in the same hold.
/// Pure so tests cover every delivery shape without a runtime.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CoverDelivery {
    ResetClearOwn,
    Reset,
    SkipNewer,
}

#[cfg(target_os = "linux")]
fn plan_cover_delivery(job: u64, now: u64, gate: Option<u64>) -> CoverDelivery {
    if gate == Some(now) && now != job {
        return CoverDelivery::SkipNewer;
    }
    if gate == Some(job) {
        return CoverDelivery::ResetClearOwn;
    }
    CoverDelivery::Reset
}

/// Runs one delivery decision with injected effects:
/// the production closure calls this under its brief gate hold with the real
/// GTK writes; tests drive it with a recorder behind a fake event queue.
#[cfg(target_os = "linux")]
pub(crate) fn run_cover_delivery(
    job: u64,
    now: u64,
    gate: &mut Option<u64>,
    effects: &mut impl FnMut(),
) -> bool {
    match plan_cover_delivery(job, now, *gate) {
        CoverDelivery::SkipNewer => false,
        CoverDelivery::Reset => {
            effects();
            true
        }
        CoverDelivery::ResetClearOwn => {
            *gate = None;
            effects();
            true
        }
    }
}

/// Runs the delivery decision with injected effects under ONE gate hold: the epoch loads INSIDE the acquired gate, so a
/// publisher landing between a pre-lock load and the lock — which the old
/// order decided with a stale epoch and could uncover a newer gate — is
/// always observed. `hook` runs under the hold before the load; tests use it
/// to prove no publisher can interleave there. Production passes a no-op;
/// the production GTK callback and the tests share this exact runner.
#[cfg(target_os = "linux")]
pub(crate) fn run_cover_cleanup_locked_with(
    job: u64,
    epoch: &AtomicU64,
    gate: &Mutex<Option<u64>>,
    apply: &mut impl FnMut(),
    hook: impl FnOnce(),
) -> bool {
    let mut held = gate.lock().unwrap();
    hook();
    let now = epoch.load(Ordering::SeqCst);
    run_cover_delivery(job, now, &mut held, apply)
}

/// Production/test runner: same callback order as
/// the queued GTK delivery — gate hold, epoch load, decide, setters.
#[cfg(target_os = "linux")]
pub(crate) fn run_cover_cleanup_locked(
    job: u64,
    epoch: &AtomicU64,
    gate: &Mutex<Option<u64>>,
    apply: &mut impl FnMut(),
) -> bool {
    run_cover_cleanup_locked_with(job, epoch, gate, apply, || {})
}

/// Waits for restore work: `None` only on disconnect, so
/// the worker exits at shutdown instead of spinning.
#[cfg(target_os = "linux")]
pub(crate) fn restore_take(rx: &mpsc::Receiver<()>, epoch: &AtomicU64) -> Option<u64> {
    loop {
        match rx.recv_timeout(RESTORE_WAKE_TIMEOUT) {
            Ok(()) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
        }
    }
    // Bounded collapse of payload-free wakes: the newest shared load below
    // converges, so a hot producer can never spin this wait without bound.
    drain_stale_wakes(rx, RESTORE_DRAIN_CAP);
    Some(epoch.load(Ordering::SeqCst))
}

/// Plans the compact position restore: exact window id plus
/// same-output AdjustFixed delta for a settled floating panel, `None` where the
/// worker waits (transient nulls) or stops. Never `SetFixed`, never raw coords.
#[cfg(target_os = "linux")]
pub(crate) fn plan_compact_restore(
    saved: Option<&CompactSpot>,
    panel: &PanelWindow,
    output: Option<&str>,
) -> Option<(u64, i32, i32)> {
    let saved = saved?;
    if !panel.floating || panel.size.0 <= 0 || panel.size.1 <= 0 {
        return None;
    }
    let pos = panel.pos?;
    let (dx, dy) = crate::niri::restore_delta(saved, Some(pos), output)?;
    Some((panel.id, dx, dy))
}
