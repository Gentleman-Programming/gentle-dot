//! Bounded monitor enumeration (T3b1, S1-S4): bind every advertised
//! `wl_output` plus one `zxdg_output_v1` each, then collect connector names,
//! transforms, current modes and logical geometry into validated
//! [`OutputGeometry`] values.
//!
//! The sweep reuses the transport's total deadline and cooperative cancel
//! handle ([`wait_readable`], [`check_wait`], [`flush_with_retry`]): there is
//! no unbounded roundtrip. Completion is version-aware, per the protocol
//! XML. `wl_output.done` exists only at version 2 and up: version-1 outputs
//! send neither `done` nor `scale` (which then defaults to 1), so for them
//! geometry plus the current mode, seen behind the `wl_display.sync`
//! barrier, is the complete description. `zxdg_output_v1.done` is deprecated
//! from version 3 onward (compositors must send `wl_output.done` instead), so
//! at xdg version 3 the xdg burst is covered by the `wl_output` batch, while
//! below v3 the xdg `done` itself is required.
//! The barrier only proves the server answered: if it fires while an output
//! is still half-described, that output fails as [`OutputsError::Incomplete`]
//! right away instead of burning the rest of the deadline.
//!
//! Geometry rules (the whole point is to feed [`OutputGeometry`] truthfully):
//! - The logical position comes from xdg-output, never from the deprecated
//!   `wl_output.geometry` x/y. Negative origins are preserved.
//! - The buffer size is the current hardware mode (pre-transform); the
//!   transform travels alongside, so rotated outputs stay transposed exactly
//!   once inside [`OutputGeometry`].
//! - The nominal scale is derived per output from the upright mode size over
//!   the logical size (the actual fractional ratio), never the integer
//!   `wl_output.scale`, which stays a fallback-free diagnostic: with both
//!   sizes known it is simply not consulted. The constructor then checks the
//!   mode against that ratio, so a mismatched mode fails instead of mapping.
//! - Names prefer `wl_output.name` (v4+) over the xdg name and stay `None`
//!   when the compositor sends neither: no `output-N` fabrication.
//! - Nothing here reports a pointer position or picks a primary output: a
//!   global desktop mode has no cursor to read and no target to name.
//!
//! Reference divergence (attribution in `THIRD_PARTY_NOTICES.md`): the
//! per-output accumulator and the fractional mode-over-logical idea follow
//! `wlroots-bridge` `screens.rs`/`conn.rs`, but the waits are bounded
//! deadline/cancel sweeps instead of double `roundtrip`s, rotation is kept in
//! the validated geometry instead of an untransformed `Screen`, and there is
//! no primary-at-(0,0) or name-fallback synthesis.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use wayland_client::protocol::{wl_callback, wl_output, wl_registry};
use wayland_client::{Connection, Dispatch, QueueHandle, WEnum};
use wayland_protocols::xdg::xdg_output::zv1::client::{
    zxdg_output_manager_v1, zxdg_output_v1,
};

use super::capabilities::{
    CapabilityError, CapabilitySnapshot, XDG_OUTPUT_MANAGER, WL_OUTPUT,
};
use super::geometry::{GeometryError, OutputGeometry, OutputTransform};
use super::transport::{
    check_wait, flush_with_retry, read_ready_op, wait_readable, CancelHandle, TransportError,
};

/// One enumerated monitor: its registry name (the stable handle for capture
/// and logging), the optional connector name, the validated geometry, and
/// the mode refresh in mHz. There is deliberately no cursor position and no
/// primary flag: neither exists in a global desktop sweep.
#[derive(Debug, Clone)]
pub struct Monitor {
    pub registry_name: u32,
    pub name: Option<String>,
    pub geometry: OutputGeometry,
    pub refresh_millihz: u32,
}

/// What went wrong enumerating outputs. Every variant names the guilty party
/// (interface name, registry name, missing field) and never guesses a
/// compositor.
#[derive(Debug, Clone)]
pub enum OutputsError {
    /// The socket wait failed (timeout, cancel, disconnect, I/O).
    Transport(TransportError),
    /// The compositor does not advertise a required global.
    MissingProtocol(CapabilityError),
    /// The `sync` barrier fired while this output was still half-described;
    /// `detail` lists the missing pieces.
    Incomplete { registry_name: u32, detail: String },
    /// The compositor withdrew this global mid-sweep (`global_remove`).
    Withdrawn { registry_name: u32 },
    /// The collected fields contradict each other (bad transform, mismatched
    /// mode, non-positive extents).
    InvalidGeometry { registry_name: u32, source: GeometryError },
}

impl std::fmt::Display for OutputsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => write!(f, "{error}"),
            Self::MissingProtocol(error) => write!(f, "{error}"),
            Self::Incomplete { registry_name, detail } => write!(
                f,
                "output {registry_name} sent incomplete metadata: {detail}"
            ),
            Self::Withdrawn { registry_name } => write!(
                f,
                "output {registry_name} was withdrawn by the compositor \
                 during enumeration (wl_registry.global_remove)"
            ),
            Self::InvalidGeometry { registry_name, source } => {
                write!(f, "output {registry_name} has invalid geometry: {source}")
            }
        }
    }
}

impl std::error::Error for OutputsError {}

impl From<TransportError> for OutputsError {
    fn from(error: TransportError) -> Self {
        Self::Transport(error)
    }
}

impl From<CapabilityError> for OutputsError {
    fn from(error: CapabilityError) -> Self {
        Self::MissingProtocol(error)
    }
}

/// Enumerate every advertised `wl_output` with its xdg-output metadata,
/// bounded by `deadline` and `cancel`. Binds nothing beyond this sweep: no
/// input, capture or cursor globals are bound or used. Consumes `conn` and
/// closes it before returning: one connection per operation, so the sweep's
/// registry (which has no destructor) can never accumulate on a shared
/// connection.
pub fn collect(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<Vec<Monitor>, OutputsError> {
    if snapshot.outputs.is_empty() {
        return Err(CapabilityError {
            interface: WL_OUTPUT,
            detail: "no wl_output was advertised by this compositor".to_owned(),
        }
        .into());
    }
    let manager = snapshot.require(XDG_OUTPUT_MANAGER)?;
    let mut queue = conn.new_event_queue::<Collector>();
    let qh = queue.handle();
    let registry = conn.display().get_registry(&qh, ());
    let proxy: zxdg_output_manager_v1::ZxdgOutputManagerV1 =
        registry.bind(manager.name, manager.negotiated, &qh, ());
    let mut slots = Vec::with_capacity(snapshot.outputs.len());
    for (index, global) in snapshot.outputs.iter().enumerate() {
        let wl: wl_output::WlOutput = registry.bind(global.name, global.negotiated, &qh, index);
        let xdg = proxy.get_xdg_output(&wl, &qh, index);
        slots.push(Slot::new(global.name, global.negotiated, wl, xdg));
    }
    let sync_done = Arc::new(AtomicBool::new(false));
    let callback = conn.display().sync(&qh, SyncFlag(sync_done.clone()));
    flush_with_retry(&conn, "outputs", deadline, cancel)?;
    let mut state = Collector {
        slots,
        xdg_version: manager.negotiated,
        sync_done,
        _registry: registry,
        _manager: proxy,
        _callback: callback,
    };
    let backend = conn.backend();
    loop {
        check_wait("outputs", deadline, cancel)?;
        queue.dispatch_pending(&mut state).map_err(|error| TransportError {
            kind: super::transport::TransportKind::Disconnected,
            op: "outputs",
            detail: format!("cannot dispatch compositor events: {error}"),
        })?;
        if let Some(name) = state.withdrawn_output() {
            return Err(OutputsError::Withdrawn { registry_name: name });
        }
        if state.complete() {
            break;
        }
        if state.sync_done.load(Ordering::Acquire) {
            // The server answered the barrier: anything still missing is never
            // coming in this sweep. Fail now instead of idling to the deadline.
            return Err(state.first_gap());
        }
        match queue.prepare_read() {
            Some(guard) => {
                wait_readable(backend.poll_fd(), "outputs", deadline, cancel)?;
                if !read_ready_op(guard, "outputs")? {
                    continue;
                }
            }
            // Defensive: the pure-Rust backend always grants a guard; sleep a
            // millisecond instead of hot-spinning, bounds still hold at loop top.
            None => std::thread::sleep(Duration::from_millis(1)),
        }
    }
    state.slots.iter().map(Slot::monitor).collect()
}

/// One bound output and the metadata collected for it so far.
struct Slot {
    registry_name: u32,
    wl_version: u32,
    // No `wl_output.geometry` x/y slot: those coordinates are deprecated in
    // favor of the xdg logical position and stay ignored (the transform from
    // the same event is the only part this sweep keeps). Likewise the
    // integer `wl_output.scale` is never stored: with the mode and the
    // logical size both known, the derived fractional ratio below is
    // authoritative and the integer scale is not consulted.
    transform_raw: Option<i32>,
    mode: Option<(i32, i32, i32)>,
    wl_name: Option<String>,
    wl_done: bool,
    logical_pos: Option<(i32, i32)>,
    logical_size: Option<(i32, i32)>,
    xdg_name: Option<String>,
    xdg_done: bool,
    removed: bool,
    _wl: wl_output::WlOutput,
    _xdg: zxdg_output_v1::ZxdgOutputV1,
}

impl Slot {
    fn new(
        registry_name: u32,
        wl_version: u32,
        wl: wl_output::WlOutput,
        xdg: zxdg_output_v1::ZxdgOutputV1,
    ) -> Self {
        Self {
            registry_name,
            wl_version,
            transform_raw: None,
            mode: None,
            wl_name: None,
            wl_done: false,
            logical_pos: None,
            logical_size: None,
            xdg_name: None,
            xdg_done: false,
            removed: false,
            _wl: wl,
            _xdg: xdg,
        }
    }

    /// The wl batch is done when `done` fired, except at version 1 where no
    /// `done` exists and geometry plus the current mode are the description.
    fn wl_batch_done(&self) -> bool {
        self.wl_version < 2 || self.wl_done
    }

    /// The xdg burst is done through its own `done` below v3, and through the
    /// wl batch at v3+, where the xdg `done` is deprecated.
    fn xdg_burst_done(&self, xdg_version: u32) -> bool {
        if xdg_version >= 3 {
            self.wl_batch_done()
        } else {
            self.xdg_done
        }
    }

    fn complete(&self, xdg_version: u32) -> bool {
        !self.removed
            && self.transform_raw.is_some()
            && self.mode.is_some()
            && self.logical_pos.is_some()
            && self.logical_size.is_some()
            && self.wl_batch_done()
            && self.xdg_burst_done(xdg_version)
    }

    fn gap(&self, xdg_version: u32) -> Option<&'static str> {
        if self.transform_raw.is_none() {
            return Some("no wl_output.geometry yet");
        }
        if self.mode.is_none() {
            return Some("no current wl_output.mode yet");
        }
        if self.logical_pos.is_none() {
            return Some("no zxdg_output_v1.logical_position yet");
        }
        if self.logical_size.is_none() {
            return Some("no zxdg_output_v1.logical_size yet");
        }
        if !self.wl_batch_done() {
            return Some("wl_output.done is still pending (version 2+)");
        }
        if !self.xdg_burst_done(xdg_version) {
            return Some("zxdg_output_v1.done is still pending (below version 3)");
        }
        None
    }

    /// Build the validated monitor: prefer the xdg logical extents (the
    /// deprecated wl x/y stay ignored), keep the pre-transform mode as the
    /// buffer, and derive the nominal scale from the upright mode over the
    /// logical size so fractional ratios survive the integer `wl_output.scale`.
    fn monitor(&self) -> Result<Monitor, OutputsError> {
        let invalid = |source: GeometryError| OutputsError::InvalidGeometry {
            registry_name: self.registry_name,
            source,
        };
        let (x, y) = self.logical_pos.ok_or_else(|| OutputsError::Incomplete {
            registry_name: self.registry_name,
            detail: "no zxdg_output_v1.logical_position yet".to_owned(),
        })?;
        let (lw, lh) = self.logical_size.ok_or_else(|| OutputsError::Incomplete {
            registry_name: self.registry_name,
            detail: "no zxdg_output_v1.logical_size yet".to_owned(),
        })?;
        let (mode_w, mode_h, refresh) =
            self.mode.ok_or_else(|| OutputsError::Incomplete {
                registry_name: self.registry_name,
                detail: "no current wl_output.mode yet".to_owned(),
            })?;
        let raw = self.transform_raw.ok_or_else(|| OutputsError::Incomplete {
            registry_name: self.registry_name,
            detail: "no wl_output.geometry yet".to_owned(),
        })?;
        if lw <= 0 || lh <= 0 {
            return Err(invalid(GeometryError::EmptyExtent { field: "logical_width" }));
        }
        if mode_w <= 0 || mode_h <= 0 {
            return Err(invalid(GeometryError::EmptyExtent { field: "buffer_width" }));
        }
        let transform = OutputTransform::from_raw(raw).map_err(invalid)?;
        // The mode is pre-transform hardware pixels: unswap the logical size
        // before deriving the ratio so rotation never skews the scale.
        let (upright_lw, _) = if transform.swaps_axes() { (lh, lw) } else { (lw, lh) };
        let nominal = mode_w as f64 / upright_lw as f64;
        let geometry =
            OutputGeometry::new(x, y, lw, lh, nominal, raw, mode_w, mode_h).map_err(invalid)?;
        Ok(Monitor {
            registry_name: self.registry_name,
            // Prefer the core-protocol name; never invent one.
            name: self.wl_name.clone().or_else(|| self.xdg_name.clone()),
            geometry,
            refresh_millihz: refresh.max(0) as u32,
        })
    }
}

struct Collector {
    slots: Vec<Slot>,
    xdg_version: u32,
    sync_done: Arc<AtomicBool>,
    _registry: wl_registry::WlRegistry,
    _manager: zxdg_output_manager_v1::ZxdgOutputManagerV1,
    _callback: wl_callback::WlCallback,
}

impl Collector {
    fn slot(&mut self, index: usize) -> Option<&mut Slot> {
        self.slots.get_mut(index)
    }

    fn complete(&self) -> bool {
        !self.slots.is_empty() && self.slots.iter().all(|slot| slot.complete(self.xdg_version))
    }

    fn withdrawn_output(&self) -> Option<u32> {
        self.slots.iter().find(|slot| slot.removed).map(|slot| slot.registry_name)
    }

    fn first_gap(&self) -> OutputsError {
        for slot in &self.slots {
            if slot.removed {
                return OutputsError::Withdrawn { registry_name: slot.registry_name };
            }
            if let Some(gap) = slot.gap(self.xdg_version) {
                return OutputsError::Incomplete {
                    registry_name: slot.registry_name,
                    detail: gap.to_owned(),
                };
            }
        }
        OutputsError::Incomplete { registry_name: 0, detail: "no outputs to collect".to_owned() }
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for Collector {
    fn event(
        state: &mut Self,
        _registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        // New globals are outside this sweep's snapshot and stay ignored; a
        // removal of a bound output fails the sweep instead of dropping it.
        if let wl_registry::Event::GlobalRemove { name } = event {
            for slot in &mut state.slots {
                if slot.registry_name == name {
                    slot.removed = true;
                }
            }
        }
    }
}

impl Dispatch<wl_output::WlOutput, usize> for Collector {
    fn event(
        state: &mut Self,
        _proxy: &wl_output::WlOutput,
        event: wl_output::Event,
        index: &usize,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        let Some(slot) = state.slot(*index) else { return };
        match event {
            wl_output::Event::Geometry { transform, .. } => {
                slot.transform_raw = Some(match transform {
                    WEnum::Value(kind) => kind as i32,
                    WEnum::Unknown(raw) => raw as i32,
                });
            }
            wl_output::Event::Mode { flags, width, height, refresh } => {
                let current = flags
                    .into_result()
                    .map(|set| set.contains(wl_output::Mode::Current))
                    .unwrap_or(false);
                if current {
                    slot.mode = Some((width, height, refresh));
                }
            }
            wl_output::Event::Done => slot.wl_done = true,
            // Integer scale deliberately unstored: the fractional ratio
            // derived in `monitor` is authoritative (see the module docs).
            wl_output::Event::Scale { .. } => {}
            wl_output::Event::Name { name } => slot.wl_name = Some(name),
            _ => {}
        }
    }
}

impl Dispatch<zxdg_output_v1::ZxdgOutputV1, usize> for Collector {
    fn event(
        state: &mut Self,
        _proxy: &zxdg_output_v1::ZxdgOutputV1,
        event: zxdg_output_v1::Event,
        index: &usize,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        let Some(slot) = state.slot(*index) else { return };
        match event {
            zxdg_output_v1::Event::LogicalPosition { x, y } => {
                slot.logical_pos = Some((x, y));
            }
            zxdg_output_v1::Event::LogicalSize { width, height } => {
                slot.logical_size = Some((width, height));
            }
            zxdg_output_v1::Event::Done => slot.xdg_done = true,
            zxdg_output_v1::Event::Name { name } if slot.wl_name.is_none() => {
                // The core-protocol name wins when both arrive; the xdg name
                // is only a fallback, and `None` stays `None`.
                slot.xdg_name = Some(name);
            }
            _ => {}
        }
    }
}

wayland_client::delegate_noop!(Collector: ignore zxdg_output_manager_v1::ZxdgOutputManagerV1);

struct SyncFlag(Arc<AtomicBool>);

impl Dispatch<wl_callback::WlCallback, SyncFlag> for Collector {
    fn event(
        _state: &mut Self,
        _callback: &wl_callback::WlCallback,
        _event: wl_callback::Event,
        flag: &SyncFlag,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        // The barrier answered: every burst sent before it has been dispatched.
        flag.0.store(true, Ordering::Release);
    }
}
