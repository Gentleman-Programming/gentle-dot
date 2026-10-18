//! Bounded virtual-pointer actions over `zwlr_virtual_pointer_manager_v1`
//! (T4a, S1-S5): move, click (left/right, 1-3), drag and scroll against a
//! stock Wayland compositor, reusing the transport's total deadline and
//! cooperative [`CancelHandle`].
//!
//! What this binds, and nothing more: one virtual-pointer manager plus the
//! one caller-selected `wl_output`, at the versions the
//! [`CapabilitySnapshot`] negotiated. No seat is bound (the seat hint stays
//! `None`); no keyboard globals, no capture globals, no cursor sampling, no
//! primary-output claim. There is no production startup, no UI, and no live
//! input beyond the tested fake-peer path.
//!
//! Output mapping (verified against Niri
//! `src/protocols/virtual_pointer.rs` + `src/input/mod.rs`
//! `compute_absolute_location`, attribution in `THIRD_PARTY_NOTICES.md`):
//! the device is created with `create_virtual_pointer_with_output` bound to
//! the selected output, so the compositor maps normalized
//! `(x / x_extent, y / y_extent)` into that output's own logical geometry
//! (origin offset and rotation handled server-side). The client therefore
//! sends selected-output logical coordinates with extents equal to the
//! output's logical size — never the union bounding box the reference bridge
//! clamps into, and never a guessed global space. Coordinates outside the
//! selected output (including gaps) are refused before any request is sent.
//! A manager below version 2 has no output-bound constructor and fails here
//! with a truthful error instead of falling back to unmapped motion.
//!
//! Ownership: every operation consumes its [`Connection`] and closes it
//! on return (see below). A scope guard releases the operation's held
//! button (if any) and explicitly destroys the device with one best-effort
//! nonblocking flush on every exit — success, error, cancel, deadline, or
//! panic unwind. Only buttons this operation pressed are ever released, so
//! the physical user's state is untouched, and no held input survives
//! across operations (no fork, no pidfile, no shared caller state).
//! Delivery is confirmed by a bounded `wl_display.sync` barrier: a silent
//! or dead peer yields Timeout/Disconnected instead of a false success.
//! Every wait and pause is deadline/cancel bounded; the total deadline
//! includes the pauses.
//!
//! Lifecycle: sharing one connection across operations would accumulate one
//! `wl_registry` per operation, and `wl_registry` — like `wl_shm` and
//! pre-v3 `wl_output` — has no destructor, so no Drop or release call could
//! ever free it. Consuming the connection makes that accumulation
//! unrepresentable by construction: destructor-less objects die with the
//! connection close, while every object that does have a destructor (the
//! virtual pointer, its manager, and v3+ outputs) is explicitly
//! destroyed/released inline — release, then device destroy, then manager
//! destroy, then output release — before the confirming barrier on success
//! and best-effort on every error path. The fd closes with the dropped
//! `Connection`, which is also the dead-fd cleanup: no cache, no global
//! map, no forgotten object.
//!
//! Honest limits: the error-path release is best-effort — on a dead peer it
//! may never arrive, and whether a closed connection releases a stuck
//! button server-side is compositor-defined and unproven here (Niri's
//! `destroyed` handler only removes the resource; its default
//! `destroy_virtual_pointer` is a no-op and synthesizes no release). The
//! client therefore always sends release before destroy itself and never
//! relies on server-side cleanup; callers must treat post-failure device
//! state as unknown.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use wayland_client::protocol::{wl_callback, wl_output, wl_pointer, wl_registry};
use wayland_client::{Connection, Dispatch, EventQueue, QueueHandle};
use wayland_protocols_wlr::virtual_pointer::v1::client::{
    zwlr_virtual_pointer_manager_v1, zwlr_virtual_pointer_v1,
};

use super::capabilities::{CapabilityError, CapabilitySnapshot, NegotiatedGlobal, VIRTUAL_POINTER};
use super::outputs::Monitor;
use super::transport::{
    check_wait, flush_with_retry, read_ready_op, wait_readable, CancelHandle, TransportError,
};

/// Linux evdev button codes (see linux/input-event-codes.h), matching the
/// reference bridge so compositors see the same buttons.
const BTN_LEFT: u32 = 0x110;
const BTN_RIGHT: u32 = 0x111;

/// Scroll magnitude per wheel notch, matching the reference bridge and the
/// x11-bridge convention: positive `dy` scrolls down, positive `dx` scrolls
/// right.
const SCROLL_STEP: f64 = 15.0;

/// Axis ticks refused past this per operation: each tick is two requests,
/// so an unbounded vector could otherwise hold the deadline hostage. Named
/// in the desktop-global tool catalog, which must move with it.
pub(crate) const MAX_SCROLL_TICKS: u32 = 120;

/// Drag interpolation steps (plus the exact endpoints): enough for the
/// compositor to see motion while held, few enough to stay well inside the
/// deadline with [`DRAG_STEP_MS`] pauses.
pub(super) const DRAG_STEPS: u32 = 8;
/// Pause between drag interpolation steps; the total deadline includes these.
const DRAG_STEP_MS: u64 = 8;
/// Settle pause between click repeats; the total deadline includes these.
const CLICK_GAP_MS: u64 = 50;

/// Pointer buttons this slice supports: left and right only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerButton {
    Left,
    Right,
}

impl PointerButton {
    fn evdev(self) -> u32 {
        match self {
            Self::Left => BTN_LEFT,
            Self::Right => BTN_RIGHT,
        }
    }
}

/// What went wrong performing a pointer action. Validation failures fire
/// before any Wayland request is sent; every variant names the guilty party
/// and never guesses a compositor.
#[derive(Debug, Clone)]
pub enum PointerError {
    /// The socket wait failed (timeout, cancel, disconnect, I/O).
    Transport(TransportError),
    /// The compositor does not advertise a required global.
    MissingProtocol(CapabilityError),
    /// No advertised `wl_output` has this registry name.
    UnknownOutput { registry_name: u32 },
    /// Global point outside the selected output (gaps refused, never clamped).
    OutsideOutput { registry_name: u32, x: f64, y: f64 },
    /// The manager predates the output-bound constructor (needs version 2).
    UnsupportedOutputBound { advertised: u32 },
    /// Click count outside 1..=3.
    InvalidCount { count: u32 },
    /// Scroll vector non-finite or past the per-operation tick cap.
    InvalidScroll { dx: f64, dy: f64, detail: String },
    /// A coordinate is NaN or infinite.
    NonFiniteCoordinate,
}

impl std::fmt::Display for PointerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => write!(f, "{error}"),
            Self::MissingProtocol(error) => write!(f, "{error}"),
            Self::UnknownOutput { registry_name } => write!(
                f,
                "no advertised wl_output has registry name {registry_name}"
            ),
            Self::OutsideOutput { registry_name, x, y } => write!(
                f,
                "global point ({x}, {y}) is not inside output {registry_name} \
                 (gaps are refused, never clamped)"
            ),
            Self::UnsupportedOutputBound { advertised } => write!(
                f,
                "compositor advertises zwlr_virtual_pointer_manager_v1 version {advertised}; \
                 output-bound pointers need version 2 \
                 (create_virtual_pointer_with_output), refusing instead of \
                 guessing a global coordinate space"
            ),
            Self::InvalidCount { count } => {
                write!(f, "click count must be 1..=3 (got {count})")
            }
            Self::InvalidScroll { dx, dy, detail } => {
                write!(f, "scroll ({dx}, {dy}) is refused: {detail}")
            }
            Self::NonFiniteCoordinate => write!(f, "coordinates must be finite numbers"),
        }
    }
}

impl std::error::Error for PointerError {}

impl From<TransportError> for PointerError {
    fn from(error: TransportError) -> Self {
        Self::Transport(error)
    }
}

impl From<CapabilityError> for PointerError {
    fn from(error: CapabilityError) -> Self {
        Self::MissingProtocol(error)
    }
}

/// Move the pointer to the global logical point (`x`, `y`), which must lie
/// inside `monitor`. No button is touched. Consumes `conn` and closes it
/// before returning (see the module lifecycle note).
pub fn move_pointer(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    monitor: &Monitor,
    x: f64,
    y: f64,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<(), PointerError> {
    let resolved = resolve(snapshot, monitor)?;
    let point = to_output_point(monitor, x, y)?;
    run(conn, &resolved, deadline, cancel, |scope| {
        scope.motion_abs(&point);
        Ok(())
    })
}

/// Click `button` `count` times (1..=3) at the global logical point
/// (`x`, `y`), which must lie inside `monitor`. Every press is released
/// inside the same operation. Consumes `conn` and closes it before
/// returning (see the module lifecycle note).
pub fn click_pointer(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    monitor: &Monitor,
    x: f64,
    y: f64,
    button: PointerButton,
    count: u32,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<(), PointerError> {
    if !(1..=3).contains(&count) {
        return Err(PointerError::InvalidCount { count });
    }
    let resolved = resolve(snapshot, monitor)?;
    let point = to_output_point(monitor, x, y)?;
    run(conn, &resolved, deadline, cancel, |scope| {
        scope.motion_abs(&point);
        for repeat in 0..count {
            if repeat > 0 {
                bounded_pause(deadline, cancel, CLICK_GAP_MS)?;
            }
            scope.press(button.evdev());
            scope.release_held();
        }
        Ok(())
    })
}

/// Press the left button at (`from_x`, `from_y`), move through interpolated
/// steps to (`to_x`, `to_y`), then release. Both endpoints must lie inside
/// `monitor`; the button is released on every exit, including cancel and
/// deadline, before the device is destroyed. Consumes `conn` and closes it
/// before returning (see the module lifecycle note).
pub fn drag_pointer(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    monitor: &Monitor,
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<(), PointerError> {
    let resolved = resolve(snapshot, monitor)?;
    let from = to_output_point(monitor, from_x, from_y)?;
    let to = to_output_point(monitor, to_x, to_y)?;
    run(conn, &resolved, deadline, cancel, |scope| {
        scope.motion_abs(&from);
        scope.press(BTN_LEFT);
        // The press reaches the peer before the steps even if the next
        // check fails, so a cancelled drag always has a press to release.
        flush_with_retry(scope.conn, "pointer", deadline, cancel)?;
        let path = drag_path(from, to);
        {
            // Each step is flushed while the button is held, so the peer sees
            // the interpolation instead of one burst at the release, and the
            // pause is deadline/Stop bounded instead of a bare sleep.
            let mut step = DragStep {
                check: || check_wait("pointer", deadline, cancel).map_err(PointerError::from),
                motion: |point: &OutputPoint| {
                    scope.motion_abs(point);
                    Ok(())
                },
                flush: || {
                    flush_with_retry(scope.conn, "pointer", deadline, cancel)
                        .map_err(PointerError::from)
                },
                pause: || {
                    bounded_pause(deadline, cancel, DRAG_STEP_MS).map_err(PointerError::from)
                },
            };
            deliver_drag_steps(&path, &mut step)?;
        }
        check_wait("pointer", deadline, cancel)?;
        scope.motion_abs(&to);
        scope.release_held();
        Ok(())
    })
}

/// The interpolated points of a drag, one per [`DRAG_STEPS`], ending exactly
/// at `to` (`t = step / DRAG_STEPS`, matching the reference bridge). Kept
/// pure so the path can be pinned without a socket.
pub(super) fn drag_path(from: OutputPoint, to: OutputPoint) -> Vec<OutputPoint> {
    (1..=DRAG_STEPS)
        .map(|step| {
            let t = f64::from(step) / f64::from(DRAG_STEPS);
            OutputPoint {
                x: (f64::from(from.x) + (f64::from(to.x) - f64::from(from.x)) * t).round()
                    as u32,
                y: (f64::from(from.y) + (f64::from(to.y) - f64::from(from.y)) * t).round()
                    as u32,
                x_extent: from.x_extent,
                y_extent: from.y_extent,
            }
        })
        .collect()
}

/// The effects of one drag step, injected so the per-step cadence can be
/// pinned deterministically: `check` gates the step, `motion` moves,
/// `flush` pushes the queued requests to the peer, and `pause` waits between
/// steps.
pub(super) struct DragStep<C, M, F, P> {
    pub check: C,
    pub motion: M,
    pub flush: F,
    pub pause: P,
}

/// Drive `steps` through `step` in a fixed cadence: check, motion, flush,
/// pause for every step. A failing effect ends the delivery immediately, so
/// a mid-drag Stop or deadline aborts before the next step is queued.
pub(super) fn deliver_drag_steps<C, M, F, P>(
    steps: &[OutputPoint],
    step: &mut DragStep<C, M, F, P>,
) -> Result<(), PointerError>
where
    C: FnMut() -> Result<(), PointerError>,
    M: FnMut(&OutputPoint) -> Result<(), PointerError>,
    F: FnMut() -> Result<(), PointerError>,
    P: FnMut() -> Result<(), PointerError>,
{
    for point in steps {
        (step.check)()?;
        (step.motion)(point)?;
        (step.flush)()?;
        (step.pause)()?;
    }
    Ok(())
}

/// Move to the global logical point (`x`, `y`) inside `monitor`, then emit
/// `dx`/`dy` worth of axis ticks (positive `dy` scrolls down, positive `dx`
/// scrolls right, [`SCROLL_STEP`] units per tick). Vectors past
/// [`MAX_SCROLL_TICKS`] total ticks are refused before any input.
/// Consumes `conn` and closes it before returning (see the module
/// lifecycle note).
pub fn scroll_pointer(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    monitor: &Monitor,
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<(), PointerError> {
    if !dx.is_finite() || !dy.is_finite() {
        return Err(PointerError::NonFiniteCoordinate);
    }
    // Tick counts, not units: one axis event per rounded unit, like the
    // reference bridge. Sums are checked before any request is sent.
    let vertical = dy.round().abs();
    let horizontal = dx.round().abs();
    if vertical + horizontal > f64::from(MAX_SCROLL_TICKS) {
        return Err(PointerError::InvalidScroll {
            dx,
            dy,
            detail: format!(
                "more than {MAX_SCROLL_TICKS} axis ticks in one operation; \
split the scroll into several calls"
            ),
        });
    }
    let resolved = resolve(snapshot, monitor)?;
    let point = to_output_point(monitor, x, y)?;
    run(conn, &resolved, deadline, cancel, |scope| {
        scope.motion_abs(&point);
        // One deadline/Stop check per tick: a long scroll ends between ticks instead of
        // queueing the whole vector as one uninterruptible burst (S6).
        for _ in 0..vertical as u32 {
            check_wait("pointer", deadline, cancel)?;
            let value = if dy > 0.0 { SCROLL_STEP } else { -SCROLL_STEP };
            scope.axis(wl_pointer::Axis::VerticalScroll, value);
        }
        for _ in 0..horizontal as u32 {
            check_wait("pointer", deadline, cancel)?;
            let value = if dx > 0.0 { SCROLL_STEP } else { -SCROLL_STEP };
            scope.axis(wl_pointer::Axis::HorizontalScroll, value);
        }
        Ok(())
    })
}

/// Capability handles for one operation: the manager plus the selected
/// output's registry entry.
struct Resolved {
    manager: NegotiatedGlobal,
    output: NegotiatedGlobal,
}

/// Bind nothing until every handle checks out: unknown outputs, missing
/// protocols and pre-v2 managers fail before any Wayland request is sent.
fn resolve(snapshot: &CapabilitySnapshot, monitor: &Monitor) -> Result<Resolved, PointerError> {
    let output = snapshot
        .outputs
        .iter()
        .find(|global| global.name == monitor.registry_name)
        .copied()
        .ok_or(PointerError::UnknownOutput { registry_name: monitor.registry_name })?;
    let manager = snapshot.require(VIRTUAL_POINTER)?;
    if manager.negotiated < 2 {
        return Err(PointerError::UnsupportedOutputBound { advertised: manager.advertised });
    }
    Ok(Resolved { manager, output })
}

/// A validated position in the selected output's logical space, with the
/// extents the absolute-motion request maps it through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct OutputPoint {
    pub x: u32,
    pub y: u32,
    pub x_extent: u32,
    pub y_extent: u32,
}

/// Map a global logical point into the selected output's logical space.
/// Non-finite inputs and points outside the output (gaps included) are
/// refused, never clamped: `contains_global` is half-open, so `floor` lands
/// every accepted point on a valid `u32` coordinate.
fn to_output_point(monitor: &Monitor, gx: f64, gy: f64) -> Result<OutputPoint, PointerError> {
    if !gx.is_finite() || !gy.is_finite() {
        return Err(PointerError::NonFiniteCoordinate);
    }
    let geometry = &monitor.geometry;
    if !geometry.contains_global(gx, gy) {
        return Err(PointerError::OutsideOutput {
            registry_name: monitor.registry_name,
            x: gx,
            y: gy,
        });
    }
    Ok(OutputPoint {
        x: (gx - f64::from(geometry.x())).floor() as u32,
        y: (gy - f64::from(geometry.y())).floor() as u32,
        x_extent: geometry.logical_width() as u32,
        y_extent: geometry.logical_height() as u32,
    })
}

/// Millisecond timestamp for the event `time` fields (wall clock, like the
/// reference bridge; only ordering within one device matters).
fn now_ms() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u32)
        .unwrap_or(0)
}

/// Sleep `millis` within the total deadline: check before and after so a
/// fired cancel or an elapsed deadline never sleeps through unnoticed. The
/// granularity is one pause, like the transport's poll slices.
fn bounded_pause(
    deadline: Instant,
    cancel: &CancelHandle,
    millis: u64,
) -> Result<(), TransportError> {
    check_wait("pointer", deadline, cancel)?;
    std::thread::sleep(Duration::from_millis(millis));
    check_wait("pointer", deadline, cancel)
}

/// Owned device for one operation: the virtual pointer plus the button this
/// operation currently holds (if any). The guard releases the held button
/// and explicitly destroys the device with one best-effort nonblocking flush
/// on every exit; only buttons this operation pressed are ever released.
struct PointerScope<'a> {
    conn: &'a Connection,
    pointer: Option<zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1>,
    held: Option<u32>,
}

impl<'a> PointerScope<'a> {
    fn new(conn: &'a Connection, pointer: zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1) -> Self {
        Self { conn, pointer: Some(pointer), held: None }
    }

    /// Absolute motion plus its closing frame.
    fn motion_abs(&self, point: &OutputPoint) {
        if let Some(pointer) = self.pointer.as_ref() {
            pointer.motion_absolute(now_ms(), point.x, point.y, point.x_extent, point.y_extent);
            pointer.frame();
        }
    }

    /// Button press plus its closing frame; remembered for the guard.
    fn press(&mut self, button: u32) {
        if let Some(pointer) = self.pointer.as_ref() {
            pointer.button(now_ms(), button, wl_pointer::ButtonState::Pressed);
            pointer.frame();
        }
        self.held = Some(button);
    }

    /// Release the owned button (if any) plus its closing frame.
    fn release_held(&mut self) {
        if let Some(button) = self.held.take() {
            if let Some(pointer) = self.pointer.as_ref() {
                pointer.button(now_ms(), button, wl_pointer::ButtonState::Released);
                pointer.frame();
            }
        }
    }

    /// One scroll tick plus its closing frame.
    fn axis(&self, axis: wl_pointer::Axis, value: f64) {
        if let Some(pointer) = self.pointer.as_ref() {
            pointer.axis(now_ms(), axis, value);
            pointer.frame();
        }
    }

    /// Explicit device destroy. A dropped proxy alone never sends the
    /// protocol destructor, so without this the compositor would keep the
    /// device object alive for as long as it keeps the connection — and
    /// whether it would also keep a stuck button is compositor-defined
    /// and unproven, which is why release always precedes destroy here.
    fn destroy_now(&mut self) {
        if let Some(pointer) = self.pointer.take() {
            pointer.destroy();
        }
    }
}

impl Drop for PointerScope<'_> {
    fn drop(&mut self) {
        // Release before destroy on the same device, then one best-effort
        // nonblocking flush. Drop cannot fail, so the original result is
        // never swallowed; on a dead connection the requests may never
        // arrive, and no server-side cleanup is relied upon (see the module
        // lifecycle note).
        self.release_held();
        self.destroy_now();
        let _ = self.conn.flush();
    }
}

/// Bind the manager plus the selected output, create the output-bound
/// device, run `act`, then tear everything explicitly destructible down and
/// confirm every request (teardown included) through a bounded
/// `wl_display.sync` barrier. The error path tears down best-effort before
/// returning, so the owned button is released and the device, manager and
/// output are destroyed/released even on error, cancel or deadline paths.
/// Requires an exclusive operation connection: the caller must not retain a
/// `Connection` clone. Consumption closes it on return only under that contract,
/// freeing the destructor-less registry (and any pre-v3 output) server-side.
fn run(
    conn: Connection,
    resolved: &Resolved,
    deadline: Instant,
    cancel: &CancelHandle,
    act: impl FnOnce(&mut PointerScope<'_>) -> Result<(), PointerError>,
) -> Result<(), PointerError> {
    let mut queue = conn.new_event_queue::<PointerDispatch>();
    let qh = queue.handle();
    let registry = conn.display().get_registry(&qh, ());
    let manager: zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1 =
        registry.bind(resolved.manager.name, resolved.manager.negotiated, &qh, ());
    let output: wl_output::WlOutput =
        registry.bind(resolved.output.name, resolved.output.negotiated, &qh, ());
    // No seat hint: the compositor assigns a default seat, and binding
    // `wl_seat` would widen this slice for nothing.
    let device = manager.create_virtual_pointer_with_output(None, Some(&output), &qh, ());
    let mut scope = PointerScope::new(&conn, device);
    if let Err(error) = act(&mut scope) {
        teardown(&mut scope, &manager, &output, resolved.output.negotiated);
        let _ = conn.flush();
        return Err(error);
    }
    // The normal exit holds nothing (actions release inline) and tears
    // down before the barrier, so success means the compositor saw
    // everything including the teardown.
    teardown(&mut scope, &manager, &output, resolved.output.negotiated);
    let arrived = Arc::new(AtomicBool::new(false));
    let _callback = conn.display().sync(&qh, SyncDone(arrived.clone()));
    flush_with_retry(&conn, "pointer", deadline, cancel)?;
    let mut state = PointerDispatch;
    await_delivery(&mut queue, &mut state, &arrived, &conn, deadline, cancel)?;
    Ok(())
}

/// Explicit per-operation teardown, in dependency order: the owned button
/// release, the device destroy, the manager destroy, then the output
/// release. `wl_output.release` exists only since version 3, so below that
/// no release is fabricated: the connection close frees the output
/// server-side instead.
fn teardown(
    scope: &mut PointerScope<'_>,
    manager: &zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1,
    output: &wl_output::WlOutput,
    output_version: u32,
) {
    scope.release_held();
    scope.destroy_now();
    manager.destroy();
    if output_version >= 3 {
        output.release();
    }
}

/// Wait for the confirming barrier within the total deadline: dispatch until
/// the callback fires, reading only when the socket is readable. A silent
/// peer yields Timeout, a closed one Disconnected — never a false success.
fn await_delivery(
    queue: &mut EventQueue<PointerDispatch>,
    state: &mut PointerDispatch,
    arrived: &Arc<AtomicBool>,
    conn: &Connection,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<(), TransportError> {
    let backend = conn.backend();
    loop {
        check_wait("pointer", deadline, cancel)?;
        queue.dispatch_pending(state).map_err(|error| TransportError {
            kind: super::transport::TransportKind::Disconnected,
            op: "pointer",
            detail: format!("cannot dispatch compositor events: {error}"),
        })?;
        if arrived.load(Ordering::Acquire) {
            return Ok(());
        }
        match queue.prepare_read() {
            Some(guard) => {
                wait_readable(backend.poll_fd(), "pointer", deadline, cancel)?;
                if !read_ready_op(guard, "pointer")? {
                    continue;
                }
            }
            // Defensive: the pure-Rust backend always grants a guard; sleep
            // instead of hot-spinning, bounds still hold at loop top.
            None => std::thread::sleep(Duration::from_millis(1)),
        }
    }
}

/// Queue state for one operation: the registry burst needs no collection
/// (binds use the snapshot), only the confirming barrier does.
struct PointerDispatch;

impl Dispatch<wl_registry::WlRegistry, ()> for PointerDispatch {
    fn event(
        _state: &mut Self,
        _registry: &wl_registry::WlRegistry,
        _event: wl_registry::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        // Advertisements outside this operation's snapshot stay ignored.
    }
}

struct SyncDone(Arc<AtomicBool>);

impl Dispatch<wl_callback::WlCallback, SyncDone> for PointerDispatch {
    fn event(
        _state: &mut Self,
        _callback: &wl_callback::WlCallback,
        _event: wl_callback::Event,
        data: &SyncDone,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        // Every request sent before the barrier has been processed.
        data.0.store(true, Ordering::Release);
    }
}

wayland_client::delegate_noop!(PointerDispatch: ignore zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1);
wayland_client::delegate_noop!(PointerDispatch: ignore zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1);
wayland_client::delegate_noop!(PointerDispatch: ignore wl_output::WlOutput);
