//! First internal adapter slice (T5, S1-S5): [`LinuxDesktop`], the [`Desktop`]
//! implementation over stock Niri/Wayland through an injected [`Backend`].
//!
//! Scope is deliberately narrow: selection, cancellation, and the capture/
//! input fan-out — no production startup, no UI, no Niri bindings, no CLI,
//! and no wiring into `mcp::Helper` (that guard wiring lands later, and this
//! module must not be read as enabling it).
//!
//! Connection ownership: every [`Desktop`] call opens a fresh exclusive
//! [`Connection`] per protocol phase and never retains one. Discovery
//! borrows its connection, while `collect` and each capture/input operation
//! consume theirs and close them on return, so the destructor-less registry
//! can never accumulate on a shared connection. The capture backend must
//! return the fused normalized image (rotate upright, downscale, encode
//! once); the adapter validates the encoded dimensions against the
//! normalized target and refuses raw buffers instead of mis-mapping them. By-value `Connection` alone
//! does not enforce this (it can be cloned): the contract is that backends
//! open a new connection per [`Backend::open`] call and the adapter never
//! clones or stores one. Tests pin the open counts.
//!
//! Cancellation: the adapter owns one [`OperationRegistry`]; every capture
//! and post registers its [`CancelHandle`] on entry and the [`OperationGuard`]
//! removes exactly its own entry on exit (success, error, or panic unwind),
//! so two concurrent calls never clear each other and no entry leaks.
//! [`OperationRegistry::cancel_all`] is the hook `Control::end` (Stop) calls:
//! the app wiring in `app.rs` installs it through `set_on_end`, so a Stop
//! cancels every in-flight capture and post.
//!
//! Monitor selection: screenshots use the stock Niri focused output, asked
//! through the existing Niri [`Client`](crate::niri::Client) request path
//! and matched against the enumerated `wl_output` names strictly (exact
//! string equality, no first/largest/primary/cursor guess). Pointer input
//! selects the output by validated [`OutputGeometry::contains_global`] and
//! refuses gaps and ambiguous overlaps before any input is sent. Keyboard
//! input binds a seat, not an output, so it needs no monitor.
//!
//! Truthfulness: the Niri runtime gate reuses the centralized
//! [`platform::is_niri`](crate::platform::is_niri) (no adapter-local
//! predicate); off-Niri the adapter refuses before any socket I/O.
//! `list_apps`/`open_app` fan out to the injected [`Backend`]: the concrete
//! Linux backend answers them from Niri's window inventory and GIO's
//! trusted desktop-entry launcher (T5a, S7), while a backend that configures
//! neither keeps the truthful unsupported refusal (never a faked empty list,
//! never a spawned shell); Accessibility, frontmost, focused and
//! window-owner queries report unknown under the explicit desktop-global
//! policy (never fabricated identities); `activate`
//! is a no-op until capabilities, UI and cancel are integrated later. Key
//! and text map the existing [`KeyCombo`] through the native keyboard API
//! without touching the Mac parser.
//!
//! Focus targeting (T4, S4/S5): [`Desktop::focused_window`] and
//! [`Desktop::focus_window`] expose Niri's `FocusedWindow` query and
//! `FocusWindow` action through [`super::focus`], reusing the existing
//! bounded [`Client`](crate::niri::Client) path. The window id is the
//! identity and the reply's pid only excludes Gentle Dot's own window;
//! per-app blocking is still never claimed. The check and the post are
//! separate IPC calls, so this seam does not pin a target against a focus
//! that moves between them.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use wayland_client::Connection;

use super::capabilities::CapabilitySnapshot;
use super::capture::CapturedFrame;
use super::normalize::normalized_target;
use super::outputs::Monitor;
use super::transport::CancelHandle;
use crate::computer::blocklist::AppIdentity;
use crate::computer::coords::Point;
use crate::computer::keys::KeyCombo;
use crate::computer::risk::{AxElement, Focus};
use crate::computer::{AppInfo, Capture, Desktop, FocusTarget, MouseButton, Permissions};

/// Total budget for one [`Desktop`] call, shared by every phase inside it
/// (discover, collect, capture/input, normalization). One deadline for the
/// whole operation, never reset per phase, so a slow phase cannot stretch
/// the call past this bound.
pub const OP_BUDGET: Duration = Duration::from_secs(10);

/// Niri IPC request for the focused output, sent through the existing
/// [`Client`](crate::niri::Client) path (`Request::FocusedOutput` serializes
/// to this JSON string). The reply decodes through
/// [`crate::niri::decode_reply`] and parses with
/// [`parse_focused_output_name`].
pub const FOCUSED_OUTPUT_REQUEST: &str = "\"FocusedOutput\"";

/// Parse a decoded Niri `FocusedOutput` reply into the focused connector
/// name (`None` when Niri reports no focused output). Anything else is a
/// truthful error, never a guessed name.
pub fn parse_focused_output_name(reply: &serde_json::Value) -> Result<Option<String>, String> {
    let Some(focused) = reply.get("FocusedOutput") else {
        return Err("niri FocusedOutput reply has no FocusedOutput field".to_owned());
    };
    if focused.is_null() {
        return Ok(None);
    }
    match focused.get("name").and_then(serde_json::Value::as_str) {
        Some(name) if !name.trim().is_empty() => Ok(Some(name.trim().to_owned())),
        _ => Err("niri FocusedOutput reply has no usable output name".to_owned()),
    }
}

/// The stock-Niri runtime gate, reusing the centralized
/// [`platform::is_niri`](crate::platform::is_niri) predicate (socket or
/// exact `niri` desktop token). No adapter-local detection exists; production
/// backends call this, tests inject [`Backend::is_niri`].
#[allow(dead_code)]
pub fn runtime_is_niri() -> bool {
    crate::platform::is_niri(&|key| std::env::var(key).ok())
}

/// Pick the monitor matching the Niri focused-output name with exact string
/// equality. `None` (or an empty/whitespace name) and unmatched names fail
/// truthfully; there is deliberately no fallback to the first, largest,
/// primary, or cursor output.
pub fn select_focused<'a>(
    monitors: &'a [Monitor],
    focused: Option<&str>,
) -> Result<&'a Monitor, String> {
    let name = focused.map(str::trim).filter(|name| !name.is_empty()).ok_or_else(|| {
        "niri reports no focused output, so no monitor can be selected \
         (refusing instead of guessing one)"
            .to_owned()
    })?;
    monitors
        .iter()
        .find(|monitor| monitor.name.as_deref() == Some(name))
        .ok_or_else(|| {
            format!(
                "niri focused output `{name}` matches no enumerated wl_output \
                 (refusing instead of falling back to another monitor)"
            )
        })
}

/// Pick the single monitor containing the global logical point. Points in
/// the gaps between outputs and points inside more than one output
/// (overlapping layouts) are refused before any input; non-finite inputs
/// never match.
pub fn select_for_point(monitors: &[Monitor], x: f64, y: f64) -> Result<&Monitor, String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("coordinates must be finite numbers".to_owned());
    }
    let mut found = None;
    let mut count = 0;
    for monitor in monitors {
        if monitor.geometry.contains_global(x, y) {
            found = Some(monitor);
            count += 1;
        }
    }
    match (found, count) {
        (Some(monitor), 1) => Ok(monitor),
        (_, 0) => Err(format!(
            "global point ({x}, {y}) is on no enumerated output \
             (gaps are refused, never clamped into an output)"
        )),
        _ => Err(format!(
            "global point ({x}, {y}) is inside {count} outputs; \
             refusing the ambiguous overlap instead of picking one"
        )),
    }
}

/// Render a [`KeyCombo`] back into the `mod+mod+key` grammar the native
/// keyboard API parses (`press_combo`): Mac-conventional order
/// (`cmd+shift+t`, `ctrl+alt+delete`), `cmd` spelled `cmd` (the keyboard
/// layer drives Super), then the canonical key name. No Mac parser
/// changes: this only formats, parsing stays untouched.
pub fn key_combo_string(combo: &KeyCombo) -> String {
    let mut parts = Vec::new();
    if combo.modifiers.cmd {
        parts.push("cmd");
    }
    if combo.modifiers.ctrl {
        parts.push("ctrl");
    }
    if combo.modifiers.alt {
        parts.push("alt");
    }
    if combo.modifiers.shift {
        parts.push("shift");
    }
    if combo.modifiers.fn_key {
        parts.push("fn");
    }
    parts.push(combo.key);
    parts.join("+")
}

/// One pointer operation, already resolved to selected-output coordinates by
/// the adapter. The backend executes it through one exclusive connection.
#[derive(Debug, Clone)]
pub enum PointerAction {
    Move {
        x: f64,
        y: f64,
    },
    Click {
        x: f64,
        y: f64,
        button: MouseButton,
        count: u8,
    },
    Drag {
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
    },
    Scroll {
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    },
}

/// The injectable backend seam: fresh exclusive connections, protocol
/// operations, and the Niri focused-output query. Production backends speak
/// the real protocols (T5); tests inject fakes that record calls and return
/// canned data without touching a compositor. Every method taking a
/// [`Connection`] consumes exactly one fresh connection and never retains
/// or clones it.
pub trait Backend: Send + Sync {
    /// The centralized Niri runtime gate for this backend.
    fn is_niri(&self) -> bool;
    /// The Niri focused-output connector name (`None` when Niri reports no
    /// focused output).
    fn focused_output(&self) -> Result<Option<String>, String>;
    /// The window Niri reports as focused (`None` when none is focused). The
    /// window id is the target identity; the pid, when present, only excludes
    /// our own window. A bounded single request, never an unbounded poll.
    fn focused_window(&self) -> Result<Option<super::focus::FocusedWindow>, String>;
    /// Focus the window with `id` again. The reply must report `Handled`; any
    /// other reply is a truthful error, never a guessed success.
    fn focus_window(&self, id: u64) -> Result<(), String>;
    /// Open one fresh exclusive Wayland connection. Called once per
    /// protocol phase; never retained, never cloned by the adapter.
    fn open(&self) -> Result<Connection, String>;
    /// Sweep the registry on a borrowed connection.
    fn discover(
        &self,
        conn: &Connection,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<CapabilitySnapshot, String>;
    /// Enumerate outputs, consuming the connection.
    fn collect(
        &self,
        conn: Connection,
        snapshot: &CapabilitySnapshot,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<Vec<Monitor>, String>;
    /// Capture the selected monitor, consuming the connection. Must return
    /// the fused normalized image: JPEG bytes of the upright downscaled
    /// target (see `normalize::normalized_target`), with `width`/`height`
    /// equal to that target. The adapter validates the dimensions and
    /// refuses raw buffers.
    fn capture(
        &self,
        conn: Connection,
        snapshot: &CapabilitySnapshot,
        monitor: &Monitor,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<CapturedFrame, String>;
    /// Run one pointer action on the selected monitor, consuming the
    /// connection.
    fn pointer(
        &self,
        action: PointerAction,
        conn: Connection,
        snapshot: &CapabilitySnapshot,
        monitor: &Monitor,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<(), String>;
    /// Press one `mod+mod+key` combo, consuming the connection.
    fn press_combo(
        &self,
        combo: &str,
        conn: Connection,
        snapshot: &CapabilitySnapshot,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<(), String>;
    /// Type text, consuming the connection.
    fn type_text(
        &self,
        text: &str,
        conn: Connection,
        snapshot: &CapabilitySnapshot,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<(), String>;
    /// The running managed applications this backend can name
    /// (`list_apps`, T5a/S7). The default is a truthful unsupported refusal,
    /// so a backend that configures no inventory source returns no faked
    /// empty list. `deadline` is the caller's total budget and `cancel` its
    /// cooperative handle.
    fn list_apps(&self, deadline: Instant, cancel: &CancelHandle) -> Result<Vec<AppInfo>, String> {
        let _ = (deadline, cancel);
        Err("list_apps is unsupported by this backend: no running-app inventory source \
             is configured (refusing instead of returning a faked empty list)"
            .to_owned())
    }
    /// Launch an installed desktop entry by exact id or unambiguous display
    /// name (`open_app`, T5a/S7). The default is a truthful unsupported
    /// refusal, so a backend that configures no launcher never spawns a
    /// shell. A successful return is the launcher's acknowledgement only,
    /// never proof that a window appeared or gained focus.
    fn open_app(&self, name: &str, deadline: Instant, cancel: &CancelHandle) -> Result<(), String> {
        let _ = (name, deadline, cancel);
        Err("open_app is unsupported by this backend: no trusted launcher is configured \
             (refusing instead of spawning a shell)"
            .to_owned())
    }
}

/// Registry of in-flight operation [`CancelHandle`]s, owned by the adapter.
/// Each call registers on entry and its [`OperationGuard`] removes exactly
/// its own entry on exit, so concurrent calls never clear each other and no
/// entry survives its operation.
#[derive(Debug, Default)]
pub struct OperationRegistry {
    next: Mutex<u64>,
    active: Mutex<Vec<(u64, CancelHandle)>>,
}

/// RAII guard for one registered operation: holds the handle the operation
/// checks and unregisters exactly its own id on drop (all exits, including
/// panic unwind), leaving concurrent operations untouched.
pub struct OperationGuard<'a> {
    registry: &'a OperationRegistry,
    id: u64,
    /// The handle this operation passes to every bounded wait.
    pub handle: CancelHandle,
}

impl OperationRegistry {
    /// Register one operation and hand back its guard (which owns the only
    /// removal of this id).
    pub fn register(&self) -> OperationGuard<'_> {
        let id = {
            let mut next = self.next.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let id = *next;
            *next = next.wrapping_add(1);
            id
        };
        let handle = CancelHandle::new();
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((id, handle.clone()));
        OperationGuard { registry: self, id, handle }
    }

    /// Cancel every in-flight operation. `Control::end` (Stop) reaches this
    /// through the app wiring in `app.rs`.
    pub fn cancel_all(&self) {
        let active = self.active.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for (_, handle) in active.iter() {
            handle.cancel();
        }
    }

    /// How many operations are currently registered (tests only).
    pub fn active_count(&self) -> usize {
        self.active.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).len()
    }
}

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        // Remove exactly our own entry; concurrent operations keep theirs.
        let mut active =
            self.registry.active.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        active.retain(|(id, _)| *id != self.id);
    }
}

/// The Linux desktop: [`Desktop`] over an injected [`Backend`] with a
/// per-adapter [`OperationRegistry`]. No production startup, no UI, no
/// helper wiring — selection, cancellation and fan-out only.
pub struct LinuxDesktop<B> {
    backend: B,
    ops: OperationRegistry,
}

impl<B> LinuxDesktop<B> {
    pub fn new(backend: B) -> Self {
        Self { backend, ops: OperationRegistry::default() }
    }

    /// Cancel every in-flight capture/post. `Control::end` (Stop) reaches this
    /// through the app wiring in `app.rs`.
    pub fn cancel_all(&self) {
        self.ops.cancel_all();
    }

    /// How many operations are currently registered (tests only).
    pub fn active_operations(&self) -> usize {
        self.ops.active_count()
    }
}

impl<B: Backend> LinuxDesktop<B> {
    fn gate(&self, op: &'static str) -> Result<(), String> {
        if self.backend.is_niri() {
            return Ok(());
        }
        Err(format!(
            "{op} refused: this backend only runs on stock Niri \
             (centralized Niri gate closed, no Wayland I/O attempted)"
        ))
    }

    fn snapshot(
        &self,
        op: &'static str,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<CapabilitySnapshot, String> {
        let conn = self.backend.open().map_err(|detail| format!("{op} failed: {detail}"))?;
        self.backend
            .discover(&conn, deadline, cancel)
            .map_err(|detail| format!("{op} failed: {detail}"))
        // `conn` drops here: discovery borrows only, and the sweep registry
        // dies with it instead of accumulating.
    }

    fn monitors(
        &self,
        op: &'static str,
        snapshot: &CapabilitySnapshot,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<Vec<Monitor>, String> {
        let conn = self.backend.open().map_err(|detail| format!("{op} failed: {detail}"))?;
        self.backend
            .collect(conn, snapshot, deadline, cancel)
            .map_err(|detail| format!("{op} failed: {detail}"))
    }
}

impl<B: Backend> Desktop for LinuxDesktop<B> {
    fn permissions(&self) -> Permissions {
        // Synchronous, so no protocol probe: screencopy needs no portal
        // permission, and there is no Accessibility or Screen Recording
        // concept to claim on Linux — both flags stay false on Niri and off
        // it. `screenshots_supported` names Niri presence only (the MCP layer
        // gates on it with a Linux-truthful message, while AX/SR never gate
        // the global path); per-operation failures still fail closed.
        if self.backend.is_niri() {
            Permissions { accessibility: false, screen_recording: false, screenshots_supported: true }
        } else {
            Permissions {
                accessibility: false,
                screen_recording: false,
                screenshots_supported: false,
            }
        }
    }

    fn capture(&self) -> Result<Capture, String> {
        self.gate("capture")?;
        let guard = self.ops.register();
        let cancel = &guard.handle;
        let deadline = Instant::now() + OP_BUDGET;
        let snapshot = self.snapshot("capture", deadline, cancel)?;
        let monitors = self.monitors("capture", &snapshot, deadline, cancel)?;
        let focused = self
            .backend
            .focused_output()
            .map_err(|detail| format!("capture failed: {detail}"))?;
        let monitor = select_focused(&monitors, focused.as_deref())?;
        let conn = self.backend.open().map_err(|detail| format!("capture failed: {detail}"))?;
        let frame = self
            .backend
            .capture(conn, &snapshot, monitor, deadline, cancel)
            .map_err(|detail| format!("capture failed: {detail}"))?;
        // The backend must return the fused normalized image: the encoded
        // dimensions equal the normalized target (upright size downscaled).
        // A raw buffer here is refused instead of mis-mapped — the
        // decode/re-encode roundtrip is gone from this path entirely.
        let (tw, th, geometry) = normalized_target(&monitor.geometry);
        if (frame.width, frame.height) != (tw, th) {
            return Err(format!(
                "capture failed: backend returned {}x{} but the normalized target is {}x{}; \
                 the fused rotate/downscale/encode path is required (raw buffers refused)",
                frame.width, frame.height, tw, th
            ));
        }
        if frame.jpeg.is_empty() {
            return Err("capture failed: backend returned empty JPEG bytes".to_owned());
        }
        Ok(Capture { data: frame.jpeg, mime_type: "image/jpeg", geometry })
    }

    fn post(&self, event: &super::super::InputEvent) -> Result<(), String> {
        use super::super::InputEvent;
        self.gate("input")?;
        let guard = self.ops.register();
        let cancel = &guard.handle;
        let deadline = Instant::now() + OP_BUDGET;
        match event {
            InputEvent::Move(at) => self.post_pointer(
                PointerAction::Move { x: at.x, y: at.y },
                *at,
                None,
                deadline,
                cancel,
            ),
            InputEvent::Click { at, button, count } => self.post_pointer(
                PointerAction::Click { x: at.x, y: at.y, button: *button, count: *count },
                *at,
                None,
                deadline,
                cancel,
            ),
            InputEvent::Drag { from, to } => {
                self.post_pointer(PointerAction::Drag {
                    from_x: from.x,
                    from_y: from.y,
                    to_x: to.x,
                    to_y: to.y,
                }, *from, Some(*to), deadline, cancel)
            }
            InputEvent::Scroll { at, dx, dy } => self.post_pointer(
                PointerAction::Scroll { x: at.x, y: at.y, dx: f64::from(*dx), dy: f64::from(*dy) },
                *at,
                None,
                deadline,
                cancel,
            ),
            InputEvent::Key(combo) => {
                let snapshot = self.snapshot("keyboard", deadline, cancel)?;
                let text = key_combo_string(combo);
                let conn =
                    self.backend.open().map_err(|detail| format!("keyboard failed: {detail}"))?;
                self.backend
                    .press_combo(&text, conn, &snapshot, deadline, cancel)
                    .map_err(|detail| format!("keyboard failed: {detail}"))
            }
            InputEvent::Text(text) => {
                let snapshot = self.snapshot("keyboard", deadline, cancel)?;
                let conn =
                    self.backend.open().map_err(|detail| format!("keyboard failed: {detail}"))?;
                self.backend
                    .type_text(text, conn, &snapshot, deadline, cancel)
                    .map_err(|detail| format!("keyboard failed: {detail}"))
            }
        }
    }

    fn list_apps(&self) -> Result<Vec<AppInfo>, String> {
        self.gate("list_apps")?;
        let guard = self.ops.register();
        let deadline = Instant::now() + OP_BUDGET;
        self.backend
            .list_apps(deadline, &guard.handle)
            .map_err(|detail| format!("list_apps failed: {detail}"))
    }

    fn open_app(&self, name: &str) -> Result<(), String> {
        self.gate("open_app")?;
        let guard = self.ops.register();
        let deadline = Instant::now() + OP_BUDGET;
        self.backend
            .open_app(name, deadline, &guard.handle)
            .map_err(|detail| format!("open_app failed: {detail}"))
    }

    fn element_at(&self, _at: Point) -> Vec<AxElement> {
        // No Accessibility equivalent: unknown, never fabricated.
        Vec::new()
    }

    fn focused_element(&self) -> Option<Focus> {
        None
    }

    fn frontmost_app(&self) -> Option<AppIdentity> {
        None
    }

    fn focused_app(&self) -> Option<AppIdentity> {
        None
    }

    fn window_owner_at(&self, _at: Point) -> Option<AppIdentity> {
        None
    }

    fn activate(&self, _pid: i32) {
        // No Linux activation until capabilities, UI and cancel are
        // integrated later; deliberately a silent no-op (never a fake).
    }

    fn focused_window(&self) -> Result<Option<FocusTarget>, String> {
        self.gate("focus")?;
        let _guard = self.ops.register();
        let window = self
            .backend
            .focused_window()
            .map_err(|detail| format!("focus failed: {detail}"))?;
        Ok(window.map(|window| FocusTarget {
            window_id: window.id,
            pid: window.pid,
            title: window.title,
            app_id: window.app_id,
        }))
    }

    fn focus_window(&self, target: &FocusTarget) -> Result<(), String> {
        self.gate("focus")?;
        let _guard = self.ops.register();
        // The exact window id, never a pid or first-window fallback.
        self.backend
            .focus_window(target.window_id)
            .map_err(|detail| format!("focus restore failed: {detail}"))
    }
}

impl<B: Backend> LinuxDesktop<B> {
    fn post_pointer(
        &self,
        action: PointerAction,
        at: Point,
        second: Option<Point>,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<(), String> {
        let snapshot = self.snapshot("pointer", deadline, cancel)?;
        let monitors = self.monitors("pointer", &snapshot, deadline, cancel)?;
        let monitor = select_for_point(&monitors, at.x, at.y)?;
        if let Some(other) = second {
            // Drags need both endpoints on the same output: the pointer
            // operation binds exactly one.
            if !monitor.geometry.contains_global(other.x, other.y) {
                return Err(format!(
                    "drag refused: from ({}, {}) selects output {} but to ({}, {}) is outside it \
                     (endpoints must share one output)",
                    at.x,
                    at.y,
                    monitor.registry_name,
                    other.x,
                    other.y
                ));
            }
        }
        let conn = self.backend.open().map_err(|detail| format!("pointer failed: {detail}"))?;
        self.backend
            .pointer(action, conn, &snapshot, monitor, deadline, cancel)
            .map_err(|detail| format!("pointer failed: {detail}"))
    }
}
