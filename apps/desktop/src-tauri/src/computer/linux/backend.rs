//! Concrete Wayland backend (T5b, S1-S5): the production
//! [`Backend`](super::desktop::Backend) over stock Niri/Wayland, consuming
//! only existing primitives — never reimplemented here.
//!
//! Connection contract: every [`Backend`](super::desktop::Backend) call
//! opens a fresh exclusive [`Connection`] per operation phase through
//! [`transport::connect_bounded`] plus [`transport::connection_from_stream`],
//! and never clones or retains it. By-value `Connection` alone does not
//! enforce this (it can be cloned): the owner rule is that [`WaylandBackend`]
//! opens exactly one connection per [`Backend::open`](super::desktop::Backend::open)
//! call, the adapter calls `open` once per phase (discover, collect,
//! capture/input), and neither side stores a connection or a clone past the
//! phase. Discovery borrows its connection; every other phase consumes its
//! own and closes it on return, so the destructor-less registry can never
//! accumulate on a shared stream.
//!
//! Selection: the Niri focused-output connector name arrives through the
//! existing [`Client`](crate::niri::Client) path
//! (`Request::FocusedOutput`, decoded by
//! [`decode_reply`](crate::niri::decode_reply)); the wire shape was
//! verified in the local niri source (`niri-ipc`: `Request::FocusedOutput`,
//! reply externally tagged `{"FocusedOutput": {"name": ...}}` or
//! `{"FocusedOutput": null}`, `Output.name: String`). The name is matched
//! strictly by the adapter against enumerated `wl_output` names; null,
//! missing, unmatched, or non-Niri is a truthful error naming what was
//! missing — never a first/largest/primary/cursor fallback. The runtime
//! gate stays the centralized
//! [`platform::is_niri`](crate::platform::is_niri); no backend-local
//! predicate exists.
//!
//! Truthfulness: capability gates run before any Wayland I/O and name the
//! missing protocol. `list_apps` derives the running managed applications
//! from Niri's bounded `Windows` inventory (T5a/S7), and `open_app` launches
//! an exact installed desktop entry through GIO's platform launcher; a
//! configured-less backend keeps the truthful unsupported refusal. AX/
//! frontmost/owner stay unknown; per-app blocking is never claimed, and a
//! launch acknowledgement is never reported as a verified window. Every
//! failure is a truthful error, never silent success. No production
//! startup, no UI, no `Control::end` wiring, no CLI, no Niri changes.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use wayland_client::Connection;

use super::capabilities::{
    CapabilitySnapshot, SCREENCOPY, VIRTUAL_KEYBOARD, VIRTUAL_POINTER, WL_OUTPUT, WL_SEAT, WL_SHM,
    XDG_OUTPUT_MANAGER,
};
use super::capture::CapturedFrame;
use super::desktop::{parse_focused_output_name, Backend, PointerAction, FOCUSED_OUTPUT_REQUEST};
use super::outputs::Monitor;
use super::transport::{
    connect_bounded, connection_from_stream, resolve_socket_path, CancelHandle,
};
use crate::computer::{AppInfo, MouseButton};
use crate::niri::Client;

/// Bound for one `connect` inside [`Backend::open`](super::desktop::Backend::open):
/// well under the adapter's per-operation budget, with its own fresh
/// [`CancelHandle`] (the trait passes no deadline into `open`, so the
/// connect cannot borrow the operation's).
const CONNECT_BUDGET: Duration = Duration::from_secs(3);

/// Total bound for one Niri `FocusedOutput` query (connect+write+read share
/// it, per [`Client`]). Like the connect above, the trait passes no
/// deadline into `focused_output`, so this fixed bound — well under the
/// adapter's per-operation budget — is documented, not hidden.
const NIRI_TIMEOUT: Duration = Duration::from_secs(2);

/// Gate capture capabilities before any Wayland I/O: screencopy pixels,
/// shared-memory pools, and enumerated outputs to select from. Names the
/// first missing protocol instead of attempting a doomed capture.
pub fn require_capture_caps(snapshot: &CapabilitySnapshot) -> Result<(), String> {
    snapshot.require(SCREENCOPY).map(|_| ()).map_err(|error| error.to_string())?;
    snapshot.require(WL_SHM).map(|_| ()).map_err(|error| error.to_string())?;
    snapshot.require(WL_OUTPUT).map(|_| ()).map_err(|error| error.to_string())?;
    Ok(())
}

/// Gate collection capabilities before any Wayland I/O: enumerated outputs
/// plus the xdg-output metadata the collector maps them with.
pub fn require_collect_caps(snapshot: &CapabilitySnapshot) -> Result<(), String> {
    snapshot.require(WL_OUTPUT).map(|_| ()).map_err(|error| error.to_string())?;
    snapshot
        .require(XDG_OUTPUT_MANAGER)
        .map(|_| ())
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Gate pointer capabilities before any Wayland I/O: the virtual-pointer
/// manager plus the enumerated output the action binds to.
pub fn require_pointer_caps(snapshot: &CapabilitySnapshot) -> Result<(), String> {
    snapshot.require(VIRTUAL_POINTER).map(|_| ()).map_err(|error| error.to_string())?;
    snapshot.require(WL_OUTPUT).map(|_| ()).map_err(|error| error.to_string())?;
    Ok(())
}

/// Gate keyboard capabilities before any Wayland I/O: the virtual-keyboard
/// manager plus the seat the keyboard is created on.
pub fn require_keyboard_caps(snapshot: &CapabilitySnapshot) -> Result<(), String> {
    snapshot.require(VIRTUAL_KEYBOARD).map(|_| ()).map_err(|error| error.to_string())?;
    snapshot.require(WL_SEAT).map(|_| ()).map_err(|error| error.to_string())?;
    Ok(())
}

/// The concrete production backend: resolved socket names plus nothing
/// else. No connection is stored (see the module contract); every phase
/// opens its own through [`Backend::open`](super::desktop::Backend::open).
#[derive(Debug)]
pub struct WaylandBackend {
    niri_socket: PathBuf,
    display: String,
    runtime_dir: Option<String>,
}

impl WaylandBackend {
    /// Resolve both socket names from `env` without connecting: the Niri
    /// socket must be named (unset/empty fails closed) and the Wayland
    /// display must resolve to a path (absolute, or relative with a runtime
    /// dir). Neither socket is touched — absence fails here, unreachability
    /// fails truthfully per operation.
    pub fn with_env(env: &impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let niri_socket = env("NIRI_SOCKET").filter(|path| !path.is_empty()).ok_or_else(|| {
            "wayland backend refused: NIRI_SOCKET is unset or empty, so no Niri \
             focused-output query is possible (failing closed instead of guessing)"
                .to_owned()
        })?;
        let display = env("WAYLAND_DISPLAY").filter(|name| !name.is_empty());
        let runtime_dir = env("XDG_RUNTIME_DIR").filter(|dir| !dir.is_empty());
        // Validate now so an unresolvable transport fails at construction,
        // not mid-operation; the error names the missing variable.
        resolve_socket_path(display.as_deref(), runtime_dir.as_deref()).map_err(|error| {
            format!("wayland backend refused: no Wayland transport to connect to ({error})")
        })?;
        Ok(Self {
            niri_socket: PathBuf::from(niri_socket),
            // Validated above, so `open` can always re-resolve this.
            display: display.unwrap_or_default(),
            runtime_dir,
        })
    }

    /// Production constructor: resolves from the live process environment.
    pub fn new() -> Result<Self, String> {
        Self::with_env(&|key| std::env::var(key).ok())
    }

    /// The Niri socket path this backend queries (tests only).
    pub fn niri_socket_path(&self) -> &Path {
        &self.niri_socket
    }
}

impl Backend for WaylandBackend {
    fn is_niri(&self) -> bool {
        // The centralized gate, rechecked live on every call: no
        // backend-local predicate, no cached verdict that could go stale.
        crate::platform::is_niri(&|key| std::env::var(key).ok())
    }

    fn focused_output(&self) -> Result<Option<String>, String> {
        if !self.is_niri() {
            return Err("niri focused output refused: the centralized Niri gate is closed \
                 in this session (no Wayland I/O attempted)"
                .to_owned());
        }
        let client = Client::new(&self.niri_socket, NIRI_TIMEOUT);
        let reply = client.request(FOCUSED_OUTPUT_REQUEST).map_err(|error| {
            format!("niri FocusedOutput request failed over {}: {error}", self.niri_socket.display())
        })?;
        // `Output.name: String` (verified in niri-ipc); null means Niri
        // reports no focused output. Anything else is a truthful error,
        // never a guessed connector.
        parse_focused_output_name(&reply).map_err(|detail| {
            format!("niri FocusedOutput reply unusable: {detail}")
        })
    }

    fn focused_window(&self) -> Result<Option<super::focus::FocusedWindow>, String> {
        if !self.is_niri() {
            return Err("niri focused window refused: the centralized Niri gate is closed \
                 in this session (no Wayland I/O attempted)"
                .to_owned());
        }
        super::focus::query_focused_window(&self.niri_socket, NIRI_TIMEOUT)
    }

    fn focus_window(&self, id: u64) -> Result<(), String> {
        if !self.is_niri() {
            return Err("niri focus window refused: the centralized Niri gate is closed \
                 in this session (no Wayland I/O attempted)"
                .to_owned());
        }
        super::focus::focus_window(&self.niri_socket, id, NIRI_TIMEOUT)
    }

    fn open(&self) -> Result<Connection, String> {
        // One fresh exclusive connection per call; never cloned, never
        // retained past the phase that asked for it.
        let path =
            resolve_socket_path(Some(&self.display).filter(|name| !name.is_empty()).map(String::as_str), self.runtime_dir.as_deref())
                .map_err(|error| error.to_string())?;
        let deadline = Instant::now() + CONNECT_BUDGET;
        let cancel = CancelHandle::new();
        let stream = connect_bounded(&path, deadline, &cancel).map_err(|error| error.to_string())?;
        connection_from_stream(stream).map_err(|error| error.to_string())
    }

    fn list_apps(&self, deadline: Instant, cancel: &CancelHandle) -> Result<Vec<AppInfo>, String> {
        if !self.is_niri() {
            return Err("niri windows refused: the centralized Niri gate is closed \
                 in this session (no Wayland I/O attempted)"
                .to_owned());
        }
        if cancel.is_cancelled() {
            return Err("niri windows query cancelled before it started".to_owned());
        }
        // The bounded single request keeps the documented two-second bound,
        // never stretched past the caller's total budget.
        let timeout = deadline.saturating_duration_since(Instant::now()).min(NIRI_TIMEOUT);
        if timeout.is_zero() {
            return Err("niri windows query refused: the operation deadline elapsed".to_owned());
        }
        super::apps::query_running_apps(&self.niri_socket, timeout)
    }

    fn open_app(&self, name: &str, _deadline: Instant, _cancel: &CancelHandle) -> Result<(), String> {
        // GIO's platform launcher starts the selected entry's own trusted
        // `Exec`; the name is only compared, never compiled into a command.
        super::apps::launch_installed_app(name)
    }

    fn discover(
        &self,
        conn: &Connection,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<CapabilitySnapshot, String> {
        super::transport::discover(conn, deadline, cancel).map_err(|error| error.to_string())
    }

    fn collect(
        &self,
        conn: Connection,
        snapshot: &CapabilitySnapshot,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<Vec<Monitor>, String> {
        require_collect_caps(snapshot)?;
        super::outputs::collect(conn, snapshot, deadline, cancel)
            .map_err(|error| error.to_string())
    }

    fn capture(
        &self,
        conn: Connection,
        snapshot: &CapabilitySnapshot,
        monitor: &Monitor,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<CapturedFrame, String> {
        require_capture_caps(snapshot)?;
        // The fused normalized tail: rotate upright, downscale, encode
        // once — the adapter validates the encoded dimensions.
        super::capture::capture_monitor_normalized(conn, snapshot, monitor, deadline, cancel)
            .map_err(|error| error.to_string())
    }

    fn pointer(
        &self,
        action: PointerAction,
        conn: Connection,
        snapshot: &CapabilitySnapshot,
        monitor: &Monitor,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<(), String> {
        require_pointer_caps(snapshot)?;
        let map_button = |button: MouseButton| match button {
            MouseButton::Left => super::pointer::PointerButton::Left,
            MouseButton::Right => super::pointer::PointerButton::Right,
        };
        match action {
            PointerAction::Move { x, y } => {
                super::pointer::move_pointer(conn, snapshot, monitor, x, y, deadline, cancel)
            }
            PointerAction::Click { x, y, button, count } => super::pointer::click_pointer(
                conn,
                snapshot,
                monitor,
                x,
                y,
                map_button(button),
                u32::from(count),
                deadline,
                cancel,
            ),
            PointerAction::Drag { from_x, from_y, to_x, to_y } => super::pointer::drag_pointer(
                conn, snapshot, monitor, from_x, from_y, to_x, to_y, deadline, cancel,
            ),
            PointerAction::Scroll { x, y, dx, dy } => {
                super::pointer::scroll_pointer(conn, snapshot, monitor, x, y, dx, dy, deadline, cancel)
            }
        }
        .map_err(|error| error.to_string())
    }

    fn press_combo(
        &self,
        combo: &str,
        conn: Connection,
        snapshot: &CapabilitySnapshot,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<(), String> {
        require_keyboard_caps(snapshot)?;
        super::keyboard::press_combo(conn, snapshot, combo, deadline, cancel)
            .map_err(|error| error.to_string())
    }

    fn type_text(
        &self,
        text: &str,
        conn: Connection,
        snapshot: &CapabilitySnapshot,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<(), String> {
        require_keyboard_caps(snapshot)?;
        super::keyboard::type_text(conn, snapshot, text, deadline, cancel)
            .map_err(|error| error.to_string())
    }
}
