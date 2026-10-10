//! Linux-only Niri pure window-selection/geometry helpers, bounded
//! socket-transport scaffolding, and pure action/mode policy.
//!
//! Selection and geometry stay pure: they select the single own window by
//! exact PID and title, decode floating geometry, and associate compact
//! spots with outputs. The transport below dials one request line over a
//! nonblocking `AF_UNIX` socket and decodes one `{"Ok":Response} |
//! {"Err":string}` reply line, with a single aggregate deadline covering
//! connect, write, and read, and a 1 MiB reply cap. Action builders emit
//! exact numeric-id wire JSON; the mode/capture/reconcile policy below
//! resolves the own window and shares one aggregate budget per operation.
//! It has no production callers yet: tests use owned temporary fake sockets
//! and injected request closures only, never a live compositor. Shell
//! wiring arrives in later slices.

use serde_json::Value;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Single-line wire requests.
pub const WINDOWS_REQUEST: &str = "\"Windows\"";
pub const WORKSPACES_REQUEST: &str = "\"Workspaces\"";
/// Cap for one reply line, newline included.
pub const REPLY_CAP: usize = 1024 * 1024;

fn invalid(message: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "niri: operation deadline exceeded")
}

/// Waits for `events` on `fd` until `end` (total deadline, never per-call
/// reset); `EINTR` retries against the same deadline. Returns the ready mask:
/// `POLLNVAL`/`POLLERR` fail bounded, while `POLLHUP` is returned so the
/// caller can still drain a buffered final reply instead of dropping it.
fn poll_ready(fd: libc::c_int, events: libc::c_short, end: Instant) -> io::Result<libc::c_short> {
    loop {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(timed_out());
        }
        let ms = left.as_millis().min(i32::MAX as u128) as libc::c_int;
        let mut waiting = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut waiting, 1, ms) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if ready == 0 {
            return Err(timed_out());
        }
        let hit = waiting.revents;
        if hit & libc::POLLNVAL != 0 {
            return Err(invalid("niri: invalid socket"));
        }
        if hit & libc::POLLERR != 0 {
            return Err(invalid("niri: socket error"));
        }
        return Ok(hit);
    }
}

fn set_nonblocking(stream: &UnixStream) -> io::Result<()> {
    use std::os::unix::io::AsRawFd;
    let fd = stream.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Non-blocking `AF_UNIX` connect bounded by the total deadline `end`.
/// `unsafe` is confined here: the socket is created with `SOCK_NONBLOCK` /
/// `SOCK_CLOEXEC` and wrapped at once, so every later path drops/closes it;
/// `sun_path` length plus path-byte/NUL guards run before any raw pointer or
/// `sockaddr` use. `std::UnixStream::connect` is not used: it blocks with no
/// connect deadline.
fn connect(path: &Path, end: Instant) -> io::Result<UnixStream> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::{AsRawFd, FromRawFd};
    let bytes = path.as_os_str().as_bytes();
    let kind = libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC;
    let fd = unsafe { libc::socket(libc::AF_UNIX, kind, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // Wrapped at once: every path below drops/closes the socket.
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    if bytes.is_empty()
        || bytes.contains(&0)
        || bytes.len() + 1 > std::mem::size_of_val(&addr.sun_path)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "niri: bad socket path",
        ));
    }
    for (slot, byte) in addr.sun_path.iter_mut().zip(bytes.iter()) {
        *slot = *byte as libc::c_char;
    }
    // Trailing NUL comes from zeroing; length covers family + bytes + NUL.
    let len = (std::mem::size_of::<libc::sa_family_t>() + bytes.len() + 1) as libc::socklen_t;
    let raw = stream.as_raw_fd();
    if unsafe { libc::connect(raw, &addr as *const _ as *const libc::sockaddr, len) } != 0 {
        let error = io::Error::last_os_error();
        let progress = error.raw_os_error() == Some(libc::EINPROGRESS)
            || error.kind() == io::ErrorKind::WouldBlock;
        if !progress {
            return Err(error);
        }
        poll_ready(raw, libc::POLLOUT, end)?;
        let mut failed: libc::c_int = 0;
        let mut option_len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        let option = unsafe {
            libc::getsockopt(
                raw,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                &mut failed as *mut _ as *mut libc::c_void,
                &mut option_len,
            )
        };
        if option != 0 {
            return Err(io::Error::last_os_error());
        }
        if failed != 0 {
            return Err(io::Error::from_raw_os_error(failed));
        }
    }
    Ok(stream)
}

fn write_all(stream: &mut UnixStream, buf: &[u8], end: Instant) -> io::Result<()> {
    use std::os::unix::io::AsRawFd;
    let fd = stream.as_raw_fd();
    let mut done = 0;
    while done < buf.len() {
        // Checked per loop, not only in the poll timeout: a peer that keeps
        // us writable must not stretch the write past the total budget.
        if Instant::now() >= end {
            return Err(timed_out());
        }
        poll_ready(fd, libc::POLLOUT, end)?;
        match stream.write(&buf[done..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "niri: socket closed",
                ))
            }
            Ok(n) => done += n,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn read_line(stream: &mut UnixStream, end: Instant) -> io::Result<String> {
    use std::os::unix::io::AsRawFd;
    let fd = stream.as_raw_fd();
    let mut buf = Vec::<u8>::new();
    loop {
        // Checked per loop, not only in the poll timeout: continuous data
        // without a newline must not stretch the read past the total budget.
        if Instant::now() >= end {
            return Err(timed_out());
        }
        if let Some(end_of_line) = buf.iter().position(|byte| *byte == b'\n') {
            buf.truncate(end_of_line);
            if buf.len() > REPLY_CAP {
                return Err(invalid("niri: reply too large"));
            }
            return String::from_utf8(buf).map_err(invalid);
        }
        if buf.len() > REPLY_CAP {
            return Err(invalid("niri: reply too large"));
        }
        // A HUP mask still falls through to `read`: buffered bytes that
        // complete the reply are kept, and only a newline-less EOF errors.
        poll_ready(fd, libc::POLLIN, end)?;
        let mut chunk = [0u8; 8192];
        match stream.read(&mut chunk) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "niri: truncated reply",
                ));
            }
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error),
        }
    }
}

/// One request line over an already-connected socket, bounded by `timeout`
/// total for write+read. Takes ownership so the socket closes on all paths;
/// tests use this with a fake socket pair, never a live compositor.
/// `pub` for the upcoming action slices; still no production callers.
pub fn request_on(stream: UnixStream, request: &str, timeout: Duration) -> io::Result<Value> {
    if request.len() > REPLY_CAP {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "niri: request too large",
        ));
    }
    let end = Instant::now() + timeout;
    set_nonblocking(&stream)?;
    let mut stream = stream;
    let mut line = String::with_capacity(request.len() + 1);
    line.push_str(request.trim_end_matches('\n'));
    line.push('\n');
    write_all(&mut stream, line.as_bytes(), end)?;
    decode_reply(&read_line(&mut stream, end)?)
}

/// Bounded client built from an explicit socket path and a total operation
/// deadline (connect+write+read share it, never reset per call). A fresh
/// connection serves every request; callers making several queries in one
/// mode operation must budget that aggregate explicitly.
pub struct Client {
    path: PathBuf,
    timeout: Duration,
}

impl Client {
    pub fn new(path: &Path, timeout: Duration) -> Self {
        Self {
            path: path.to_path_buf(),
            timeout,
        }
    }

    pub fn request(&self, request: &str) -> io::Result<Value> {
        let end = Instant::now() + self.timeout;
        let stream = connect(&self.path, end)?;
        request_on(
            stream,
            request,
            end.saturating_duration_since(Instant::now()),
        )
    }
}

/// Decodes one reply line, failing closed: wire `Err` and unexpected shapes
/// are errors, never defaulted values.
pub fn decode_reply(line: &str) -> io::Result<Value> {
    let reply: Value = serde_json::from_str(line).map_err(invalid)?;
    match &reply {
        Value::Object(fields) => {
            if let Some(ok) = fields.get("Ok") {
                return Ok(ok.clone());
            }
            let detail = fields
                .get("Err")
                .and_then(Value::as_str)
                .unwrap_or("request failed");
            Err(invalid(format!("niri: {detail}")))
        }
        _ => Err(invalid("niri: unexpected reply shape")),
    }
}

/// A window owned by this app: its Niri id, tiling/floating mode, size, the
/// logical `tile_pos_in_workspace_view` (`None` may occur, e.g. during an
/// interactive move, so it is skipped, never read as the origin), and its
/// workspace.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelWindow {
    pub id: u64,
    pub floating: bool,
    pub size: (i32, i32),
    pub pos: Option<(f64, f64)>,
    pub workspace: Option<u64>,
}

/// The single window owned by `pid` with exactly `title`. `None` when
/// missing, id-less, or ambiguous: never a focused-window fallback, never an
/// app-id guess.
pub fn own_panel(payload: &Value, pid: u32, title: &str) -> Option<PanelWindow> {
    let windows = payload.as_array().or_else(|| payload.get("Windows")?.as_array())?;
    let mut found = None;
    for window in windows {
        let Some(id) = window.get("id").and_then(Value::as_u64) else { continue };
        let owned = window.get("pid").and_then(Value::as_u64) == Some(u64::from(pid));
        let titled = window.get("title").and_then(Value::as_str) == Some(title);
        if !(owned && titled) {
            continue;
        }
        let layout = window.get("layout");
        let size = layout.and_then(|layout| layout.get("window_size")).and_then(Value::as_array);
        let (width, height) = match size {
            Some(pair) if pair.len() == 2 => {
                (pair[0].as_i64().unwrap_or(0) as i32, pair[1].as_i64().unwrap_or(0) as i32)
            }
            _ => (0, 0),
        };
        let pos = layout.and_then(|layout| layout.get("tile_pos_in_workspace_view")).and_then(|pos| {
            let pair = pos.as_array()?;
            if pair.len() != 2 {
                return None;
            }
            Some((pair[0].as_f64()?, pair[1].as_f64()?))
        });
        if found.is_some() {
            return None; // Ambiguous: two windows claim this pid and title.
        }
        found = Some(PanelWindow {
            id,
            floating: window.get("is_floating").and_then(Value::as_bool).unwrap_or(false),
            size: (width, height),
            pos,
            workspace: window.get("workspace_id").and_then(Value::as_u64),
        });
    }
    found
}

/// Convenience for the exact production title (`crate::platform::PANEL_TITLE`).
pub fn own_panel_window(payload: &Value, pid: u32) -> Option<PanelWindow> {
    own_panel(payload, pid, crate::platform::PANEL_TITLE)
}

/// Output name for a workspace id; accepts `{"Workspaces":[...]}` or a bare array.
pub fn workspace_output(payload: &Value, workspace: Option<u64>) -> Option<String> {
    let id = workspace?;
    let list = payload.as_array().or_else(|| payload.get("Workspaces")?.as_array())?;
    for entry in list {
        if entry.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        return entry
            .get("output")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .map(str::to_owned);
    }
    None
}

/// A captured floating spot: output plus logical position.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactSpot {
    pub output: String,
    pub x: f64,
    pub y: f64,
}

/// Captures a floating panel's logical spot. Tiling panels (the expanded
/// normal mode) are never captured; stale null positions and non-finite or
/// non-positive geometry yield `None`. The origin (0,0) is a real spot.
pub fn compact_spot(panel: &PanelWindow, output: Option<String>) -> Option<CompactSpot> {
    if !panel.floating || panel.size.0 <= 0 || panel.size.1 <= 0 {
        return None;
    }
    let (x, y) = panel.pos?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some(CompactSpot { output: output.filter(|name| !name.is_empty())?, x, y })
}

/// Delta that moves the floating panel back to `saved`: same output only
/// (workspace ids need not match, the output frame is identical either way).
pub fn restore_delta(
    saved: &CompactSpot,
    current: Option<(f64, f64)>,
    current_output: Option<&str>,
) -> Option<(i32, i32)> {
    if current_output != Some(saved.output.as_str()) {
        return None;
    }
    let (x, y) = current?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some(((saved.x - x).round() as i32, (saved.y - y).round() as i32))
}

/// Mode builders take a known numeric id only. Tiling is the expanded normal
/// mode, floating is compact. There is deliberately no `SetFixed` builder:
/// raw snapshots already include the working-area offset, so absolute moves
/// must go through `restore_delta` plus `action_move_floating`.
pub fn action_tiling(id: u64) -> String {
    format!("{{\"Action\":{{\"MoveWindowToTiling\":{{\"id\":{id}}}}}}}")
}

pub fn action_floating(id: u64) -> String {
    format!("{{\"Action\":{{\"MoveWindowToFloating\":{{\"id\":{id}}}}}}}")
}

pub fn action_move_floating(id: u64, dx: i32, dy: i32) -> String {
    format!("{{\"Action\":{{\"MoveFloatingWindow\":{{\"id\":{id},\"x\":{{\"AdjustFixed\":{dx}}},\"y\":{{\"AdjustFixed\":{dy}}}}}}}}}")
}

/// Full-column-width action for an exact window id (S5): `SetProportion` is a
/// proportion of the working area (niri-ipc 26.4 `SizeChange`), so 100.0 fills
/// the column. Numeric id only: never a focused-window fallback.
pub fn action_set_window_width(id: u64) -> String {
    format!("{{\"Action\":{{\"SetWindowWidth\":{{\"id\":{id},\"change\":{{\"SetProportion\":100.0}}}}}}}}")
}

/// Automatic-height action for an exact window id (S5): resets a fixed height
/// back to automatic so the expanded window fills managed height.
pub fn action_reset_window_height(id: u64) -> String {
    format!("{{\"Action\":{{\"ResetWindowHeight\":{{\"id\":{id}}}}}}}")
}

/// Managed-geometry pair for an exact window id (S5b): full-column width plus
/// automatic height, shared by the mode transition, the same-mode retry, and
/// the worker remap path so the sequence is defined once. Numeric id only.
pub fn action_managed_geometry(id: u64) -> [String; 2] {
    [action_set_window_width(id), action_reset_window_height(id)]
}

/// Aggregate budget for one position-independent mode operation (S2a): the
/// `Windows` lookup plus the single mode action share this total, never a
/// fresh budget per request. Callers pass the remainder down per call.
pub const NATIVE_MODE_BUDGET: Duration = Duration::from_millis(250);

/// Position-independent native mode transition (S2a): tiling is the expanded
/// normal mode, floating is compact. Resolves the exact own window by pid and
/// production title, then issues exactly one mode action for its id. Returns
/// the mode in effect: the requested one only after the action reply reports
/// `Handled`. Missing/ambiguous windows are a bounded no-op returning the
/// previous mode; wire errors and unexpected action payloads propagate with
/// the mode untouched — except geometry below, which runs post-flip. A request
/// matching the current mode sends no queries. No position capture or restore
/// lives here (S2b); never a focused-window fallback, never `SetFixed`.
///
/// Managed geometry on expand (S5a): after the tiling reports `Handled`, the
/// mode flips immediately then full-column width plus automatic height follow
/// for the same id, all inside the one aggregate budget. A geometry failure
/// therefore surfaces as an error WITH the mode already honestly expanded —
/// never a false compact report after tiling succeeded. Compact stays a single
/// floating action; callers own size/constraints around it.
pub fn apply_native_mode(
    expanded: &mut bool,
    on: bool,
    pid: u32,
    request: &mut impl FnMut(&str, Duration) -> io::Result<Value>,
) -> io::Result<bool> {
    if *expanded == on {
        return Ok(*expanded);
    }
    let start = Instant::now();
    let windows = request(WINDOWS_REQUEST, NATIVE_MODE_BUDGET.saturating_sub(start.elapsed()))?;
    let Some(panel) = own_panel_window(&windows, pid) else {
        return Ok(*expanded);
    };
    let action = if on { action_tiling(panel.id) } else { action_floating(panel.id) };
    let outcome = request(&action, NATIVE_MODE_BUDGET.saturating_sub(start.elapsed()))?;
    if !is_handled(&outcome) {
        return Err(invalid("niri: unexpected action response"));
    }
    *expanded = on;
    if on {
        for wire in action_managed_geometry(panel.id) {
            let reply = request(&wire, NATIVE_MODE_BUDGET.saturating_sub(start.elapsed()))?;
            if !is_handled(&reply) {
                return Err(invalid("niri: unexpected action response"));
            }
        }
    }
    Ok(*expanded)
}

/// Whether a decoded mode-action reply reports success (S2b-1): Niri answers
/// a handled action with the literal `"Handled"`. Any other `Ok` payload is
/// not success and must leave the tracked mode untouched.
pub fn is_handled(reply: &Value) -> bool {
    reply.as_str() == Some("Handled")
}

/// Captures the own floating panel's compact spot (S2b-1) for the hide/expand
/// hooks: resolves the unique pid+title window, then its workspace output.
/// Shares one aggregate budget across both queries with the remainder passed
/// down, never reset. `Ok(None)` — missing/ambiguous window, tiling panel,
/// null position, invalid size, or unknown output — and `Err` both mean the
/// caller preserves its remembered spot; nothing is invented (no fallbacks,
/// no origin guess). Tiling panels return before the workspaces query; the
/// S2b-2 shell guard additionally never calls this while expanded.
pub fn capture_compact_spot(
    pid: u32,
    request: &mut impl FnMut(&str, Duration) -> io::Result<Value>,
) -> io::Result<Option<CompactSpot>> {
    let start = Instant::now();
    let windows = request(WINDOWS_REQUEST, NATIVE_MODE_BUDGET.saturating_sub(start.elapsed()))?;
    let Some(panel) = own_panel_window(&windows, pid) else {
        return Ok(None);
    };
    if !panel.floating {
        return Ok(None);
    }
    let workspaces = request(WORKSPACES_REQUEST, NATIVE_MODE_BUDGET.saturating_sub(start.elapsed()))?;
    Ok(compact_spot(&panel, workspace_output(&workspaces, panel.workspace)))
}

/// Reconciles an observed panel layout with the desired mode (S2b-1),
/// separate from the tracked-mode early return: a remapped window floats by
/// rule even while the tracked mode still says expanded, so the exact new id
/// must tile. Returns the single numeric-id action when actual and desired
/// disagree, `None` when aligned. Never a focused-window fallback (the panel
/// comes from the pid+title resolver), never `SetFixed`.
pub fn reconcile_action(panel: &PanelWindow, desired_expanded: bool) -> Option<String> {
    match (desired_expanded, panel.floating) {
        (true, true) => Some(action_tiling(panel.id)),
        (false, false) => Some(action_floating(panel.id)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::thread;

    fn win(id: u64, pid: u64, title: &str, floating: bool, pos: Value) -> Value {
        serde_json::json!({"id": id, "pid": pid, "title": title, "workspace_id": 7,
            "is_floating": floating,
            "layout": {"tile_pos_in_workspace_view": pos, "window_size": [420, 200]}})
    }

    fn panel(floating: bool, size: (i32, i32), pos: Option<(f64, f64)>) -> PanelWindow {
        PanelWindow { id: 1, floating, size, pos, workspace: Some(7) }
    }

    /// A floating panel at a real spot on the first output.
    fn fl(pos: Option<(f64, f64)>) -> PanelWindow {
        panel(true, (420, 200), pos)
    }

    fn out() -> Option<String> {
        Some("DP-1".to_owned())
    }

    #[test]
    fn selects_only_the_unique_pid_and_title_match() {
        let at = serde_json::json!([10.0, 20.0]);
        let payload = serde_json::json!({"Windows": [
            win(1, 100, "Gentle Dot Panel", true, at.clone()),
            win(2, 100, "Gentle Dot", true, at.clone()),
            win(3, 999, "Gentle Dot Panel", true, at.clone()),
            serde_json::json!({"pid": 100, "title": "Gentle Dot Panel"}),
        ]});
        let found = own_panel(&payload, 100, "Gentle Dot Panel").unwrap();
        assert_eq!(found.id, 1);
        assert!(found.floating);
        assert_eq!(found.pos, Some((10.0, 20.0)));
        assert_eq!(found.size, (420, 200));
        assert_eq!(found.workspace, Some(7));
        // The exact production title resolves through the same selector.
        assert_eq!(own_panel_window(&payload, 100), Some(found));
    }

    #[test]
    fn ambiguous_or_missing_panels_are_none() {
        let dup = serde_json::json!({"Windows": [
            win(1, 100, "Gentle Dot Panel", true, Value::Null),
            win(2, 100, "Gentle Dot Panel", false, Value::Null),
        ]});
        assert!(own_panel(&dup, 100, "Gentle Dot Panel").is_none());
        // A bare array (already-unwrapped `Ok.Windows`) is accepted too.
        let bare = Value::Array(vec![win(4, 100, "Gentle Dot Panel", false, Value::Null)]);
        assert_eq!(own_panel(&bare, 100, "Gentle Dot Panel").unwrap().id, 4);
        assert!(own_panel(&serde_json::json!({"Windows": []}), 100, "Gentle Dot Panel").is_none());
    }

    #[test]
    fn compact_spot_captures_only_floating_finite_spots() {
        let floating = fl(Some((10.0, 20.0)));
        let spot = CompactSpot { output: "DP-1".to_owned(), x: 10.0, y: 20.0 };
        assert_eq!(compact_spot(&floating, out()), Some(spot));
        // The origin is a genuine spot; missing or empty outputs are not.
        assert!(compact_spot(&fl(Some((0.0, 0.0))), out()).is_some());
        assert!(compact_spot(&floating, Some(String::new())).is_none());
        assert!(compact_spot(&floating, None).is_none());
        // Expanded (tiling) windows are never captured as compact spots.
        assert!(compact_spot(&panel(false, (420, 640), Some((10.0, 20.0))), out()).is_none());
        // A floated window with a stale null position is skipped, never read as the origin.
        assert!(compact_spot(&fl(None), out()).is_none());
        for bad in [panel(true, (0, 0), Some((10.0, 20.0))), panel(true, (-420, 200), Some((10.0, 20.0)))]
        {
            assert!(compact_spot(&bad, out()).is_none());
        }
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(compact_spot(&fl(Some((bad, 20.0))), out()).is_none());
            assert!(compact_spot(&fl(Some((10.0, bad))), out()).is_none());
        }
    }

    #[test]
    fn restore_needs_the_same_output_and_a_current_spot() {
        let saved = CompactSpot { output: "DP-1".to_owned(), x: 100.0, y: 200.0 };
        assert_eq!(restore_delta(&saved, Some((90.0, 205.0)), Some("DP-1")), Some((10, -5)));
        assert_eq!(restore_delta(&saved, None, Some("DP-1")), None);
        assert_eq!(restore_delta(&saved, Some((90.0, 205.0)), Some("HDMI-1")), None);
        assert_eq!(restore_delta(&saved, Some((90.0, 205.0)), None), None);
        assert_eq!(restore_delta(&saved, Some((f64::NAN, 205.0)), Some("DP-1")), None);
        // Workspace outputs resolve by id; missing or empty outputs never match.
        let workspaces = serde_json::json!({"Workspaces": [{"id": 7, "output": "DP-1"}, {"id": 8}]});
        assert_eq!(workspace_output(&workspaces, Some(7)), Some("DP-1".to_owned()));
        assert_eq!(workspace_output(&workspaces, Some(8)), None);
        assert_eq!(workspace_output(&workspaces, Some(99)), None);
        assert_eq!(workspace_output(&workspaces, None), None);
    }

    #[test]
    fn wire_errors_fail_closed() {
        assert!(decode_reply(r#"{"Err":"no such window"}"#).is_err());
        let ok = decode_reply(r#"{"Ok":{"Windows":[]}}"#).unwrap();
        assert!(ok["Windows"].is_array());
        assert!(decode_reply("not json").is_err());
        assert!(decode_reply(r#"{"Wat":{}}"#).is_err());
    }

    /// Private fake-socket lifecycle: unique path per test (pid + name, so
    /// parallel tests never share), removed before bind and on drop. This
    /// temp socket is the sole allowed test artifact; nothing else is written.
    struct TempSocket {
        path: std::path::PathBuf,
    }

    impl TempSocket {
        fn named(name: &str) -> Self {
            let file = format!("niri-s1b-{}-{name}.sock", std::process::id());
            let path = std::env::temp_dir().join(file);
            let _ = std::fs::remove_file(&path);
            Self { path }
        }
    }

    impl Drop for TempSocket {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn reply_line(body: &[u8]) -> Vec<u8> {
        body.iter().chain(b"\n".iter()).copied().collect()
    }

    /// Fake Niri over a socket pair: one reply for one request line. Socket
    /// timeouts on both ends bound every test even if either side stalls.
    fn fake_niri(reply: Vec<u8>, timeout: Duration) -> io::Result<Value> {
        let (client, mut server) = UnixStream::pair()?;
        server.set_read_timeout(Some(Duration::from_secs(2)))?;
        server.set_write_timeout(Some(Duration::from_secs(2)))?;
        let worker = thread::spawn(move || {
            let mut byte = [0u8; 1];
            loop {
                match server.read(&mut byte) {
                    Ok(0) => break,
                    Ok(_) if byte[0] == b'\n' => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            let _ = server.write_all(&reply);
        });
        let outcome = request_on(client, WINDOWS_REQUEST, timeout);
        worker.join().unwrap();
        outcome
    }

    #[test]
    fn transport_round_trips_one_reply_line() {
        let ok = fake_niri(
            reply_line(br#"{"Ok":{"Windows":[]}}"#),
            Duration::from_secs(2),
        )
        .unwrap();
        assert!(ok["Windows"].is_array());
        assert!(fake_niri(reply_line(br#"{"Err":"boom"}"#), Duration::from_secs(2)).is_err());
    }

    #[test]
    fn transport_rejects_truncated_and_oversized_replies() {
        // Closed mid-line: a truncated reply, never a partial value.
        assert!(fake_niri(b"{\"Ok\":".to_vec(), Duration::from_secs(2)).is_err());
        // Past the 1 MiB cap with no newline: rejected even as the sender stalls on a full buffer.
        assert!(fake_niri(vec![b'x'; REPLY_CAP + 16], Duration::from_secs(5)).is_err());
    }

    #[test]
    fn transport_times_out_on_a_silent_socket() {
        let (client, mut server) = UnixStream::pair().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let worker = thread::spawn(move || {
            let mut byte = [0u8; 1];
            while let Ok(n) = server.read(&mut byte) {
                if n == 0 || byte[0] == b'\n' {
                    break;
                }
            }
            // Silent past the client deadline, then close so the join stays bounded.
            thread::sleep(Duration::from_secs(1));
        });
        let error = request_on(client, WINDOWS_REQUEST, Duration::from_millis(200)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        worker.join().unwrap();
    }

    #[test]
    fn connect_serves_a_request_over_a_real_listener() {
        let socket = TempSocket::named("ok");
        let listener = UnixListener::bind(&socket.path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let worker = thread::spawn(move || {
            // Bounded accept: the join must not hang even if the client never dials.
            let start = Instant::now();
            loop {
                match listener.accept() {
                    Ok((mut peer, _)) => {
                        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                        let mut byte = [0u8; 1];
                        loop {
                            match peer.read(&mut byte) {
                                Ok(_) if byte[0] == b'\n' => break,
                                Ok(_) => {}
                                Err(_) => break,
                            }
                        }
                        let _ = peer.write_all(&reply_line(br#"{"Ok":{"Windows":[]}}"#));
                        break;
                    }
                    Err(_) if start.elapsed() < Duration::from_secs(5) => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });
        let payload = Client::new(&socket.path, Duration::from_secs(2))
            .request(WINDOWS_REQUEST)
            .unwrap();
        assert!(payload["Windows"].is_array());
        worker.join().unwrap();
    }

    #[test]
    fn connect_rejects_bad_or_missing_socket_paths() {
        let missing = TempSocket::named("absent");
        let dial = |path: &std::path::Path| {
            Client::new(path, Duration::from_secs(2)).request(WINDOWS_REQUEST)
        };
        // Nothing listening: fast refusal through the real connect path, never a hang.
        assert!(dial(&missing.path).is_err());
        assert!(dial(std::path::Path::new("")).is_err());
        assert!(dial(std::path::Path::new("niri-\0-sock")).is_err());
        let long = format!("{}/{}", std::env::temp_dir().display(), "s".repeat(200));
        assert!(dial(std::path::Path::new(&long)).is_err());
    }

    #[test]
    fn action_builders_emit_exact_wire_json() {
        assert_eq!(action_tiling(9), r#"{"Action":{"MoveWindowToTiling":{"id":9}}}"#);
        assert_eq!(action_floating(9), r#"{"Action":{"MoveWindowToFloating":{"id":9}}}"#);
        let moved = r#"{"Action":{"MoveFloatingWindow":{"id":9,"x":{"AdjustFixed":10},"y":{"AdjustFixed":-5}}}}"#;
        assert_eq!(action_move_floating(9, 10, -5), moved);
        // Ids stay numeric after a JSON round trip, never strings or nulls.
        for action in [action_tiling(9), action_floating(9), action_move_floating(9, 0, 0)] {
            let parsed: Value = serde_json::from_str(&action).unwrap();
            let by_path = |pointer: &str| parsed.pointer(pointer).cloned();
            let id = by_path("/Action/MoveWindowToTiling/id")
                .or_else(|| by_path("/Action/MoveWindowToFloating/id"))
                .or_else(|| by_path("/Action/MoveFloatingWindow/id"));
            assert!(id.is_some_and(|id| id.is_u64()), "{action}");
        }
    }

    #[test]
    fn native_mode_expand_tiles_the_exact_own_window() {
        let at = serde_json::json!([10.0, 20.0]);
        let windows =
            serde_json::json!({"Windows": [win(9, 100, crate::platform::PANEL_TITLE, true, at)]});
        let mut calls: Vec<(String, Duration)> = Vec::new();
        let mut request = |wire: &str, timeout: Duration| -> io::Result<Value> {
            calls.push((wire.to_owned(), timeout));
            if wire == WINDOWS_REQUEST {
                Ok(windows.clone())
            } else {
                Ok(serde_json::json!("Handled"))
            }
        };
        let mut expanded = false;
        assert!(apply_native_mode(&mut expanded, true, 100, &mut request).unwrap());
        assert!(expanded);
        assert_eq!(calls.len(), 4);
        assert_eq!(calls[0].0, WINDOWS_REQUEST);
        assert_eq!(calls[1].0, action_tiling(9));
        assert_eq!(calls[2].0, action_set_window_width(9));
        assert_eq!(calls[3].0, action_reset_window_height(9));
        // One aggregate budget across all four: each share never exceeds the last.
        assert!(calls[0].1 <= NATIVE_MODE_BUDGET);
        for window in calls.windows(2) {
            assert!(window[1].1 <= window[0].1);
        }
    }

    #[test]
    fn native_mode_compact_floats_the_exact_own_window() {
        let at = serde_json::json!([10.0, 20.0]);
        let windows =
            serde_json::json!({"Windows": [win(9, 100, crate::platform::PANEL_TITLE, false, at)]});
        let mut calls: Vec<(String, Duration)> = Vec::new();
        let mut request = |wire: &str, timeout: Duration| -> io::Result<Value> {
            calls.push((wire.to_owned(), timeout));
            if wire == WINDOWS_REQUEST {
                Ok(windows.clone())
            } else {
                Ok(serde_json::json!("Handled"))
            }
        };
        let mut expanded = true;
        assert!(!apply_native_mode(&mut expanded, false, 100, &mut request).unwrap());
        assert!(!expanded);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].0, action_floating(9));
        assert!(calls[1].1 <= calls[0].1);
    }

    #[test]
    fn native_mode_same_request_sends_no_queries() {
        let mut calls = 0;
        let mut request = |_: &str, _: Duration| -> io::Result<Value> {
            calls += 1;
            Ok(serde_json::json!({}))
        };
        let mut expanded = true;
        assert!(apply_native_mode(&mut expanded, true, 100, &mut request).unwrap());
        assert!(expanded);
        let mut compact = false;
        assert!(!apply_native_mode(&mut compact, false, 100, &mut request).unwrap());
        assert!(!compact);
        assert_eq!(calls, 0);
    }

    #[test]
    fn native_mode_missing_or_ambiguous_windows_are_bounded_no_ops() {
        let at = serde_json::json!([10.0, 20.0]);
        let title = crate::platform::PANEL_TITLE;
        for windows in [
            serde_json::json!({"Windows": []}),
            serde_json::json!({"Windows": [win(9, 999, title, true, at.clone())]}),
            serde_json::json!({"Windows": [
                win(9, 100, title, true, at.clone()),
                win(10, 100, title, false, Value::Null),
            ]}),
        ] {
            let mut calls = 0;
            let mut request = |wire: &str, _: Duration| -> io::Result<Value> {
                calls += 1;
                assert_eq!(wire, WINDOWS_REQUEST);
                Ok(windows.clone())
            };
            let mut expanded = false;
            assert!(!apply_native_mode(&mut expanded, true, 100, &mut request).unwrap());
            assert!(!expanded);
            // Only the lookup ran: no mode action follows an unresolvable window.
            assert_eq!(calls, 1);
        }
    }

    #[test]
    fn native_mode_wire_errors_keep_the_previous_mode() {
        let at = serde_json::json!([10.0, 20.0]);
        let windows =
            serde_json::json!({"Windows": [win(9, 100, crate::platform::PANEL_TITLE, true, at)]});
        // A failing lookup never reports success and never flips the mode.
        let mut failing = |_: &str, _: Duration| -> io::Result<Value> { Err(invalid("niri: boom")) };
        let mut expanded = false;
        assert!(apply_native_mode(&mut expanded, true, 100, &mut failing).is_err());
        assert!(!expanded);
        // A failing action also keeps the previous mode, never the requested one.
        let mut calls = 0;
        let mut action_fails = |wire: &str, _: Duration| -> io::Result<Value> {
            calls += 1;
            if wire == WINDOWS_REQUEST {
                Ok(windows.clone())
            } else {
                Err(invalid("niri: boom"))
            }
        };
        assert!(apply_native_mode(&mut expanded, true, 100, &mut action_fails).is_err());
        assert!(!expanded);
        assert_eq!(calls, 2);
    }

    #[test]
    fn capture_resolves_the_own_floating_spot_within_one_budget() {
        let title = crate::platform::PANEL_TITLE;
        let at = serde_json::json!([10.0, 20.0]);
        let windows = serde_json::json!({"Windows": [win(9, 100, title, true, at)]});
        let workspaces = serde_json::json!({"Workspaces": [{"id": 7, "output": "DP-1"}]});
        let mut calls: Vec<(String, Duration)> = Vec::new();
        let mut request = |wire: &str, timeout: Duration| -> io::Result<Value> {
            calls.push((wire.to_owned(), timeout));
            if wire == WINDOWS_REQUEST {
                Ok(windows.clone())
            } else {
                Ok(workspaces.clone())
            }
        };
        let spot = capture_compact_spot(100, &mut request).unwrap().unwrap();
        assert_eq!(spot, CompactSpot { output: "DP-1".to_owned(), x: 10.0, y: 20.0 });
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, WINDOWS_REQUEST);
        assert_eq!(calls[1].0, WORKSPACES_REQUEST);
        // One aggregate budget: the second query shares the remainder, never a reset.
        assert!(calls[0].1 <= NATIVE_MODE_BUDGET);
        assert!(calls[1].1 <= calls[0].1);
    }

    #[test]
    fn capture_skips_anything_the_caller_must_not_remember() {
        let title = crate::platform::PANEL_TITLE;
        let at = serde_json::json!([10.0, 20.0]);
        let known = serde_json::json!({"Workspaces": [{"id": 7, "output": "DP-1"}]});
        let unknown = serde_json::json!({"Workspaces": [{"id": 8, "output": "HDMI-1"}]});
        let sided = serde_json::json!({"id": 9, "pid": 100, "title": title, "is_floating": true,
            "layout": {"tile_pos_in_workspace_view": at.clone(), "window_size": [420, 640]}});
        let origin = CompactSpot { output: "DP-1".to_owned(), x: 0.0, y: 0.0 };
        let cases: Vec<(Value, Value, Option<CompactSpot>, usize)> = vec![
            (serde_json::json!({"Windows": []}), known.clone(), None, 1),
            (serde_json::json!({"Windows": [win(9, 999, title, true, at.clone())]}), known.clone(), None, 1),
            (serde_json::json!({"Windows": [win(9, 100, title, true, at.clone()),
                win(10, 100, title, false, Value::Null)]}), known.clone(), None, 1),
            // Tiling (expanded) panels never reach the workspaces query; the
            // S2b-2 shell guard owns that call-site rule, this is defense in depth.
            (serde_json::json!({"Windows": [win(9, 100, title, false, at.clone())]}), known.clone(), None, 1),
            // Floating but position-less (e.g. interactive move): skipped, never the origin.
            (serde_json::json!({"Windows": [win(9, 100, title, true, Value::Null)]}), known.clone(), None, 2),
            // Unknown output and missing workspace: no invented fallback.
            (serde_json::json!({"Windows": [win(9, 100, title, true, at.clone())]}), unknown.clone(), None, 2),
            (serde_json::json!({"Windows": [sided]}), known.clone(), None, 2),
            // The origin is a genuine spot.
            (serde_json::json!({"Windows": [win(9, 100, title, true, serde_json::json!([0.0, 0.0]))]}),
                known.clone(), Some(origin), 2),
        ];
        for (windows, workspaces, expected, queries) in cases {
            let mut calls = 0;
            let mut request = |wire: &str, _: Duration| -> io::Result<Value> {
                calls += 1;
                if wire == WINDOWS_REQUEST {
                    Ok(windows.clone())
                } else {
                    assert_eq!(wire, WORKSPACES_REQUEST);
                    Ok(workspaces.clone())
                }
            };
            assert_eq!(capture_compact_spot(100, &mut request).unwrap(), expected);
            assert_eq!(calls, queries);
        }
        // A failing query propagates: the caller keeps its old spot on Err too.
        let mut failing = |_: &str, _: Duration| -> io::Result<Value> { Err(invalid("niri: boom")) };
        assert!(capture_compact_spot(100, &mut failing).is_err());
    }

    #[test]
    fn reconcile_retiles_a_remapped_float_when_expanded_is_desired() {
        // Tracked mode already says expanded, so apply_native_mode would
        // early-return; the actual remapped window still floats by rule and
        // needs its exact new id tiled. No state is faked: the action follows
        // the observed layout, not the tracked bool.
        let remapped =
            PanelWindow { id: 11, floating: true, size: (420, 640), pos: None, workspace: Some(7) };
        assert_eq!(reconcile_action(&remapped, true), Some(action_tiling(11)));
    }

    #[test]
    fn reconcile_refloats_a_tiled_window_when_compact_is_desired() {
        let tiled =
            PanelWindow { id: 11, floating: false, size: (800, 600), pos: None, workspace: Some(7) };
        assert_eq!(reconcile_action(&tiled, false), Some(action_floating(11)));
    }

    #[test]
    fn reconcile_aligned_layouts_send_no_action() {
        let expanded =
            PanelWindow { id: 11, floating: false, size: (800, 600), pos: None, workspace: Some(7) };
        assert_eq!(reconcile_action(&expanded, true), None);
        let compact = PanelWindow {
            id: 11, floating: true, size: (420, 640), pos: Some((10.0, 20.0)), workspace: Some(7),
        };
        assert_eq!(reconcile_action(&compact, false), None);
    }

    #[test]
    fn action_responses_require_the_handled_marker() {
        assert!(is_handled(&serde_json::json!("Handled")));
        for unexpected in [serde_json::json!({}), serde_json::json!(null), serde_json::json!("OK")] {
            assert!(!is_handled(&unexpected), "{unexpected}");
        }
    }

    #[test]
    fn mode_actions_reject_unexpected_ok_payloads() {
        let at = serde_json::json!([10.0, 20.0]);
        let windows =
            serde_json::json!({"Windows": [win(9, 100, crate::platform::PANEL_TITLE, true, at)]});
        let mut request = |wire: &str, _: Duration| -> io::Result<Value> {
            if wire == WINDOWS_REQUEST {
                Ok(windows.clone())
            } else {
                Ok(serde_json::json!({}))
            }
        };
        let mut expanded = false;
        let error = apply_native_mode(&mut expanded, true, 100, &mut request).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(!expanded);
    }

    #[test]
    fn managed_geometry_builders_emit_exact_verified_wire_json() {
        // Shapes verified against niri-ipc 26.4 (`SizeChange::SetProportion` is
        // a proportion of the working area; action replies are `Handled`).
        assert_eq!(
            action_set_window_width(9),
            r#"{"Action":{"SetWindowWidth":{"id":9,"change":{"SetProportion":100.0}}}}"#
        );
        assert_eq!(
            action_reset_window_height(9),
            r#"{"Action":{"ResetWindowHeight":{"id":9}}}"#
        );
        let width: Value = serde_json::from_str(&action_set_window_width(9)).unwrap();
        assert_eq!(width.pointer("/Action/SetWindowWidth/id"), Some(&serde_json::json!(9)));
        assert_eq!(
            width.pointer("/Action/SetWindowWidth/change/SetProportion"),
            Some(&serde_json::json!(100.0))
        );
    }

    #[test]
    fn managed_geometry_pair_bundles_width_then_height() {
        let pair = action_managed_geometry(9);
        assert_eq!(pair[0], action_set_window_width(9));
        assert_eq!(pair[1], action_reset_window_height(9));
    }

    #[test]
    fn native_expand_grows_managed_geometry_after_tiling() {
        // S5: tiling a constraint-fixed window clamps small; the expand plan
        // must follow the tile with full-column width plus automatic height —
        // exact own id, one aggregate budget across all four requests.
        let at = serde_json::json!([10.0, 20.0]);
        let windows =
            serde_json::json!({"Windows": [win(9, 100, crate::platform::PANEL_TITLE, true, at)]});
        let mut calls: Vec<(String, Duration)> = Vec::new();
        let mut request = |wire: &str, timeout: Duration| -> io::Result<Value> {
            calls.push((wire.to_owned(), timeout));
            if wire == WINDOWS_REQUEST {
                Ok(windows.clone())
            } else {
                Ok(serde_json::json!("Handled"))
            }
        };
        let mut expanded = false;
        assert!(apply_native_mode(&mut expanded, true, 100, &mut request).unwrap());
        assert!(expanded);
        assert_eq!(calls.len(), 4);
        assert_eq!(calls[1].0, action_tiling(9));
        assert_eq!(calls[2].0, action_set_window_width(9));
        assert_eq!(calls[3].0, action_reset_window_height(9));
        for window in calls.windows(2) {
            assert!(window[1].1 <= window[0].1);
        }
    }

    #[test]
    fn native_expand_geometry_failure_keeps_honest_expanded_mode() {
        // Tiling succeeded (Handled) but managed geometry did not: the mode
        // stays expanded — never a false compact report — while the error
        // still surfaces instead of vanishing.
        for failing in [action_set_window_width(9), action_reset_window_height(9)] {
            let at = serde_json::json!([10.0, 20.0]);
            let windows =
                serde_json::json!({"Windows": [win(9, 100, crate::platform::PANEL_TITLE, true, at)]});
            let mut request = |wire: &str, _: Duration| -> io::Result<Value> {
                if wire == WINDOWS_REQUEST {
                    Ok(windows.clone())
                } else if wire == failing {
                    Ok(serde_json::json!({"unexpected": "ok"}))
                } else {
                    Ok(serde_json::json!("Handled"))
                }
            };
            let mut expanded = false;
            let error = apply_native_mode(&mut expanded, true, 100, &mut request).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            assert!(expanded);
        }
    }
}
