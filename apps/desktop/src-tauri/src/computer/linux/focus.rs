//! Stock-Niri focus targeting (T4, S4/S5): the `FocusedWindow` query and the
//! exact-window `FocusWindow` action, both over the existing
//! [`Client`](crate::niri::Client)/[`is_handled`](crate::niri::is_handled) path — no shell
//! command, no new transport, no second IPC dialect. The window **id** is the identity; the
//! pid from the reply only excludes Gentle Dot's own window, and a window whose owner Niri
//! does not report is never treated as targetable keyboard input.
//!
//! Wire shapes verified against the local `niri-ipc` source
//! (`Action::FocusWindow { id }` and `Response::FocusedWindow(Option<Window>)`): the request
//! serializes to the JSON string `"FocusedWindow"`, the reply decodes to
//! `{"FocusedWindow": {...Window...}}` or `{"FocusedWindow": null}`, and the action to
//! `{"Action":{"FocusWindow":{"id":N}}}` answered with `"Handled"`.
//!
//! Why an explicit seam instead of the own-window hide/restore ring: `LinuxWorking` is
//! id-only and hides nothing on Linux, so it cannot keep Gentle Dot's own window from taking
//! the focus a dialog hands it. Restoring the exact window observed before the dialog is the
//! safe replacement for remembering and re-activating an arbitrary last app.
//!
//! Residual TOCTOU: the check (`focused_window`) and the post are separate IPC calls, so a
//! compositor that moves the focus in between is not pinned by this module. The MCP layer
//! re-reads the focus before each individual post and refuses on a mismatch, but no
//! compositor guarantee of an atomic check-plus-post is claimed here.

use serde_json::Value;
use std::path::Path;
use std::time::Duration;

use crate::niri::{is_handled, Client};

/// `Request::FocusedWindow` serializes to this JSON string (niri-ipc).
pub const FOCUSED_WINDOW_REQUEST: &str = "\"FocusedWindow\"";

/// The fields of the focused `Window` this seam reads. Missing optional fields stay `None`;
/// a reply without a window id, or with a non-positive pid, is refused, never guessed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FocusedWindow {
    pub id: u64,
    pub pid: Option<i32>,
    pub title: Option<String>,
    pub app_id: Option<String>,
}

/// `Action::FocusWindow { id }` for an exact window id, as the wire JSON string.
pub fn action_focus_window(id: u64) -> String {
    serde_json::json!({"Action": {"FocusWindow": {"id": id}}}).to_string()
}

/// Decode a `FocusedWindow` reply. `Ok(None)` when Niri reports no focused window; any other
/// shape is a truthful error, never a fabricated window.
pub fn parse_focused_window(reply: &Value) -> Result<Option<FocusedWindow>, String> {
    let Some(focused) = reply.get("FocusedWindow") else {
        return Err("niri FocusedWindow reply has no FocusedWindow field".to_owned());
    };
    if focused.is_null() {
        return Ok(None);
    }
    let id = focused
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| "niri FocusedWindow reply has no usable window id".to_owned())?;
    let pid = match focused.get("pid") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let raw = value
                .as_i64()
                .ok_or_else(|| "niri FocusedWindow reply has a non-numeric pid".to_owned())?;
            let pid = i32::try_from(raw)
                .map_err(|_| "niri FocusedWindow reply pid is out of range".to_owned())?;
            // 0 and negative are not real owner processes (pid 0 is the kernel); a
            // reply carrying one is refused instead of being read as an external app.
            if pid <= 0 {
                return Err("niri FocusedWindow reply has a non-positive pid".to_owned());
            }
            Some(pid)
        }
    };
    Ok(Some(FocusedWindow {
        id,
        pid,
        title: focused.get("title").and_then(Value::as_str).map(str::to_owned),
        app_id: focused.get("app_id").and_then(Value::as_str).map(str::to_owned),
    }))
}

/// Ask Niri for the focused window over the existing bounded client path. One total timeout
/// for connect+write+read; never an unbounded poll.
pub fn query_focused_window(socket: &Path, timeout: Duration) -> Result<Option<FocusedWindow>, String> {
    let client = Client::new(socket, timeout);
    let reply = client
        .request(FOCUSED_WINDOW_REQUEST)
        .map_err(|error| format!("niri FocusedWindow request failed over {}: {error}", socket.display()))?;
    parse_focused_window(&reply).map_err(|detail| format!("niri FocusedWindow reply unusable: {detail}"))
}

/// Focus an exact window id again. The reply must report `Handled`; anything else is a
/// truthful error, never a silent success.
pub fn focus_window(socket: &Path, id: u64, timeout: Duration) -> Result<(), String> {
    let client = Client::new(socket, timeout);
    let reply = client
        .request(&action_focus_window(id))
        .map_err(|error| format!("niri FocusWindow request failed over {}: {error}", socket.display()))?;
    if !is_handled(&reply) {
        return Err("niri FocusWindow reply was not Handled".to_owned());
    }
    Ok(())
}
