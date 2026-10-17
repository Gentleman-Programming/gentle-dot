//! Linux-only Niri IPC foundation: reply decoding, panel selection,
//! compact-spot capture, mode-action builders, the bounded socket transport
//! (nonblocking connect, polls, framing), and the S2a position-independent
//! mode policy.
//!
//! Verified against Niri 26.04: `$NIRI_SOCKET` answers one JSON request line
//! with one `{"Ok":Response} | {"Err":string}` reply line, `'"Windows"'`
//! giving `Ok.Windows` and `'"Workspaces"'` giving `Ok.Workspaces`.
//! No shell wiring, persisted state, or fullscreen inference lives here
//! (Niri reports no fullscreen flag, so compact/expanded state stays app-owned).

use serde_json::Value;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub(crate) mod calibration;
pub(crate) mod base;
/// Niri gate/epoch/restore kernel moved from shell.rs: job freshness,
/// intent carry, cover planning and quiet helpers. Thin Tauri wrappers stay in shell.
pub(crate) mod gate;
/// Dormant shared-window restore planner/identity helper (T10/T11/T12/T19):
/// one-panel planning across Pair/PanelOnly/RoseOnly/Fullscreen, no caller yet.
#[allow(dead_code)]
pub(crate) mod unit_restore;
/// App-managed Niri config snippets (binds/login spawn): pure text transforms,
/// no I/O and no platform API, so this compiles identically on every target and
/// is only ever CALLED from Linux+Niri paths. `allow(dead_code)`: the transforms
/// land before their command wiring, and nothing outside Niri may call them.
#[allow(dead_code)]
pub(crate) mod kdl_binds;
/// Portable location plus the safe backup/validate/write path for that snippet.
/// Plain `std` only, every side effect injectable, so the production order is
/// testable without a real home directory. Nothing outside Linux+Niri calls it.
#[allow(dead_code)]
pub(crate) mod config_file;
/// Slice 4a pure routing and gate planners: tray/rose predicates, gate/hide
/// planners, fullscreen dispatch and the joint/unit route predicates. No
/// `AppHandle`, `Shell`, GTK or thread; `allow(dead_code)` until wiring lands.
#[allow(dead_code)]
pub(crate) mod route_gate;
/// Slice 4b dormant shared-unit state and cover executor: activation/open/
/// ready state, its panel snapshot, the transition planner/committer, the
/// main-thread cover executor and the worker-wake decision. No `AppHandle`,
/// GTK or thread; `allow(dead_code)` until the builder+worker unit lands.
#[allow(dead_code)]
pub(crate) mod unit_state;
/// Slice 4d dormant shared-surface runners: the legacy session route, the
/// startup plan and compact-mode planner, the shared restore/surface
/// predicates, the bounded render/animation waits, the mapped size settle
/// and the cached/uncached single-panel restore sequence. No `AppHandle`
/// or `Shell`; `allow(dead_code)` until the builder+worker unit lands.
#[allow(dead_code)]
pub(crate) mod unit;
/// Dormant Niri-only shared-unit surface (T10/T12/T19): pure scanline
/// geometry plus a thin main-thread GTK input-shape apply; no caller yet.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) mod unit_surface;

/// Single-line wire requests.
pub const WINDOWS_REQUEST: &str = "\"Windows\"";
pub const WORKSPACES_REQUEST: &str = "\"Workspaces\"";
/// Event-stream wire request (Niri 26.04): the compositor replies
/// `{"Ok":"Handled"}`, then streams one `Event` JSON object per line.
/// A dedicated connection serves the stream: Niri stops reading further
/// requests on it, so one-shot queries keep their own connections.
pub const EVENT_STREAM_REQUEST: &str = "\"EventStream\"";
/// Drag-settle debounce shared with the mac snapper: a rose move reanchors
/// the owned visible compact panel only after this much event quiet.
pub const FOLLOW_DEBOUNCE: Duration = Duration::from_millis(300);
/// Cap for one reply line, newline included (enforced by S1b framing).
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
        let ms = left.as_millis().min(i32::MAX as u128) as i32;
        let mut waiting = libc::pollfd { fd, events, revents: 0 };
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
    if bytes.is_empty() || bytes.contains(&0) || bytes.len() + 1 > std::mem::size_of_val(&addr.sun_path) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "niri: bad socket path"));
    }
    for (slot, byte) in addr.sun_path.iter_mut().zip(bytes.iter()) {
        *slot = *byte as libc::c_char;
    }
    // Trailing NUL comes from zeroing; length covers family + bytes + NUL.
    let len = (std::mem::size_of::<libc::sa_family_t>() + bytes.len() + 1) as libc::socklen_t;
    let raw = stream.as_raw_fd();
    if unsafe { libc::connect(raw, &addr as *const _ as *const libc::sockaddr, len) } != 0 {
        let error = io::Error::last_os_error();
        let progress = error.raw_os_error() == Some(libc::EINPROGRESS) || error.kind() == io::ErrorKind::WouldBlock;
        if !progress {
            return Err(error);
        }
        poll_ready(raw, libc::POLLOUT, end)?;
        let mut failed: libc::c_int = 0;
        let mut option_len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        let option = unsafe {
            libc::getsockopt(raw, libc::SOL_SOCKET, libc::SO_ERROR, &mut failed as *mut _ as *mut libc::c_void, &mut option_len)
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
            Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "niri: socket closed")),
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
            Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "niri: truncated reply")),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error),
        }
    }
}

/// One request line over an already-connected socket, bounded by `timeout`
/// total for write+read. Takes ownership so the socket closes on all paths;
/// tests use this with a fake socket pair, never a live compositor.
pub fn request_on(stream: UnixStream, request: &str, timeout: Duration) -> io::Result<Value> {
    if request.len() > REPLY_CAP {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "niri: request too large"));
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
        Self { path: path.to_path_buf(), timeout }
    }

    pub fn request(&self, request: &str) -> io::Result<Value> {
        let end = Instant::now() + self.timeout;
        let stream = connect(&self.path, end)?;
        request_on(stream, request, end.saturating_duration_since(Instant::now()))
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
            let detail = fields.get("Err").and_then(Value::as_str).unwrap_or("request failed");
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
            Some(pair) if pair.len() == 2 => (pair[0].as_i64().unwrap_or(0) as i32, pair[1].as_i64().unwrap_or(0) as i32),
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

/// Convenience for the exact rose title (`crate::platform::DOT_TITLE`): the
/// beside-rose anchor on Niri. Same pid+title uniqueness contract as the
/// panel selector: `None` when missing or ambiguous, never a focused-window
/// fallback and never an app-id guess.
pub fn own_dot_window(payload: &Value, pid: u32) -> Option<PanelWindow> {
    own_panel(payload, pid, crate::platform::DOT_TITLE)
}

/// Floating origin beside the rose (visible-rose reopen, Niri only): left of
/// the dot when its IPC x clears the panel width, else right, vertically
/// centered. Pure IPC dot/panel positions only, never GTK coordinates. No
/// output-extent clamp is applied: no `Outputs` geometry is verified against
/// Niri 26.04 in this tree, so the same-output guard in `plan_beside_rose`
/// is the only bound and Niri keeps the floated frame on screen per its own
/// rules. The default right-edge rose therefore lands the panel on its left;
/// a left-edge rose lands it on the right.
pub fn beside_rose_target(
    dot_pos: (f64, f64),
    dot_size: (i32, i32),
    panel_size: (i32, i32),
    gap: i32,
) -> (i32, i32) {
    let x = if dot_pos.0 > f64::from(panel_size.0) {
        (dot_pos.0 - f64::from(gap) - f64::from(panel_size.0)).round() as i32
    } else {
        (dot_pos.0 + f64::from(dot_size.0) + f64::from(gap)).round() as i32
    };
    let y = (dot_pos.1 + f64::from(dot_size.1) / 2.0 - f64::from(panel_size.1) / 2.0).round() as i32;
    (x, y)
}

/// Plans the visible-rose beside reopen (Niri only): the exact numeric panel
/// id plus a same-output `AdjustFixed` delta from the fresh IPC panel spot
/// to the fresh IPC beside-the-dot target, recomputed on every reopen.
/// `None` where the worker waits (transient nulls, missing dot) or stops
/// (tiling panel or dot, other/missing outputs, non-positive sizes,
/// non-finite positions). Never `SetFixed`, never GTK coordinates, never
/// the session-remembered spot.
pub fn plan_beside_rose(
    dot: &PanelWindow,
    dot_output: Option<&str>,
    panel: &PanelWindow,
    panel_output: Option<&str>,
    gap: i32,
) -> Option<(u64, i32, i32)> {
    if !panel.floating || !dot.floating {
        return None;
    }
    let dot_output = dot_output.filter(|name| !name.is_empty())?;
    let panel_output = panel_output.filter(|name| !name.is_empty())?;
    if dot_output != panel_output {
        return None;
    }
    if dot.size.0 <= 0 || dot.size.1 <= 0 || panel.size.0 <= 0 || panel.size.1 <= 0 {
        return None;
    }
    let dot_pos = dot.pos?;
    let panel_pos = panel.pos?;
    if !dot_pos.0.is_finite() || !dot_pos.1.is_finite() || !panel_pos.0.is_finite() || !panel_pos.1.is_finite() {
        return None;
    }
    let (tx, ty) = beside_rose_target(dot_pos, dot.size, panel.size, gap);
    Some((panel.id, tx - panel_pos.0.round() as i32, ty - panel_pos.1.round() as i32))
}

/// Floating origin for the rose beside the panel (Niri unhide with a
/// visible panel, mv347ejs leg 2): right of the panel, vertically centered.
/// Pure IPC panel/dot positions only, never GTK coordinates. No output-extent
/// clamp is applied: no `Outputs` geometry is verified against Niri 26.04 in
/// this tree, so the same-output guard in `plan_rose_beside_panel` is the
/// only bound and Niri keeps the floated frame on screen per its own rules —
/// the same contract as `beside_rose_target`. Right-of-panel keeps the live
/// FAIL geometry: panel (816,422) + 420 + 8 lands the rose at (1244,706).
///
pub fn rose_beside_panel_target(
    panel_pos: (f64, f64),
    panel_size: (i32, i32),
    dot_size: (i32, i32),
    gap: i32,
) -> (i32, i32) {
    let x = (panel_pos.0 + f64::from(panel_size.0) + f64::from(gap)).round() as i32;
    let y = (panel_pos.1 + f64::from(panel_size.1) / 2.0 - f64::from(dot_size.1) / 2.0).round() as i32;
    (x, y)
}

/// Plans the Niri-unhide rose move (mv347ejs leg 2): the exact numeric DOT id
/// plus a same-output `AdjustFixed` delta from the fresh IPC rose spot to the
/// fresh IPC beside-the-panel target. `None` where the caller waits
/// (transient nulls) or stops (tiling rose or panel, other/missing outputs,
/// non-positive sizes, non-finite positions). Never `SetFixed`, never GTK
/// coordinates, never the session-remembered spot — the same guards as
/// `plan_beside_rose`, with the move direction reversed so the panel stays
/// where the user put it and the rose joins it.
pub fn plan_rose_beside_panel(
    dot: &PanelWindow,
    dot_output: Option<&str>,
    panel: &PanelWindow,
    panel_output: Option<&str>,
    gap: i32,
) -> Option<(u64, i32, i32)> {
    if !panel.floating || !dot.floating {
        return None;
    }
    let dot_output = dot_output.filter(|name| !name.is_empty())?;
    let panel_output = panel_output.filter(|name| !name.is_empty())?;
    if dot_output != panel_output {
        return None;
    }
    if dot.size.0 <= 0 || dot.size.1 <= 0 || panel.size.0 <= 0 || panel.size.1 <= 0 {
        return None;
    }
    let dot_pos = dot.pos?;
    let panel_pos = panel.pos?;
    if !dot_pos.0.is_finite() || !dot_pos.1.is_finite() || !panel_pos.0.is_finite() || !panel_pos.1.is_finite() {
        return None;
    }
    let (tx, ty) = rose_beside_panel_target(panel_pos, panel.size, dot.size, gap);
    Some((dot.id, tx - dot_pos.0.round() as i32, ty - dot_pos.1.round() as i32))
}

/// Whether a hidden-no-spot panel may settle at its default anchor (mv347ejs
/// leg 1): floating with a finite mapped position and positive size only.
/// Tiling panels, null/transient positions, non-finite coordinates, and
/// non-positive sizes all read invalid and keep waiting — never an invented
/// fallback, never the origin guess.
pub fn default_anchor_valid(panel: &PanelWindow) -> bool {
    if !panel.floating || panel.size.0 <= 0 || panel.size.1 <= 0 {
        return false;
    }
    match panel.pos {
        Some((x, y)) if x.is_finite() && y.is_finite() => true,
        _ => false,
    }
}

/// Whether the default anchor has settled (mv347ejs leg 1): two consecutive
/// equal IPC reads. The first sighting arms (`None` -> false), the second
/// equal sighting settles (true); any drift re-arms. Exact equality: the
/// worker compares raw compositor floats, never rounded pixels.
pub fn default_anchor_settled(last: Option<(f64, f64)>, current: (f64, f64)) -> bool {
    last == Some(current)
}

/// Whether a default-anchor settle may complete a collapse-to-default
/// restore (unit 20a, Niri only): the job must still own the collapse
/// intent (`intent_fresh`: this generation ran the float transition before
/// any restore read, so both reads are post-transition frames), the panel's
/// output must resolve via workspaces (never `None`/empty), plus the
/// existing valid-geometry and two-equal-reads settle. Two equal reads
/// alone are NOT correctness: `MoveFloatingWindow` forces `animate=true`
/// and the IPC geometry omits animated offsets, so equality is not rendered
/// settlement — and without intent the pair could be any pre-transition
/// frame. No invented workarea and no `SetFixed`: the compositor default
/// float position (typically top-right per Niri rules) is adopted only
/// after this explicit check, never an arbitrary compositor spot.
pub fn collapse_default_ready(
    panel: &PanelWindow,
    output: Option<&str>,
    intent_fresh: bool,
    last: Option<(f64, f64)>,
    current: (f64, f64),
) -> bool {
    intent_fresh
        && output.is_some_and(|name| !name.is_empty())
        && default_anchor_valid(panel)
        && default_anchor_settled(last, current)
}

/// Cap for consecutive missing-window passes in one restore job (mv347ejs leg
/// 3): the time budget already bounds the loop, this second bound ends it
/// even under clock skew — never an infinite spin. Small by construction.
pub const MISSING_WINDOW_MAX_PASSES: usize = 16;

/// Whether a missing-window wait may retry (mv347ejs leg 3): time remains
/// AND the pass cap is not hit. Pure, allowlist-only inputs (durations plus
/// a counter) — never window JSON, titles, sockets, or accounts — so traces
/// and decisions stay secret-free.
pub fn missing_window_should_retry(elapsed: Duration, budget: Duration, consecutive: usize) -> bool {
    elapsed < budget && consecutive < MISSING_WINDOW_MAX_PASSES
}

/// Output name for a workspace id; accepts `{"Workspaces":[...]}` or a bare array.
pub fn workspace_output(payload: &Value, workspace: Option<u64>) -> Option<String> {
    let id = workspace?;
    let list = payload.as_array().or_else(|| payload.get("Workspaces")?.as_array())?;
    for entry in list {
        if entry.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        return entry.get("output").and_then(Value::as_str).filter(|name| !name.is_empty()).map(str::to_owned);
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
pub fn restore_delta(saved: &CompactSpot, current: Option<(f64, f64)>, current_output: Option<&str>) -> Option<(i32, i32)> {
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

/// Configure an exact mapped floating client; GTK resize alone is only a hint
/// on Wayland. Callers must still verify the resulting client size and identity.
pub fn action_fixed_geometry(id: u64, size: (i32, i32)) -> [String; 2] {
    [
        serde_json::json!({"Action":{"SetWindowWidth":{"id":id,"change":{"SetFixed":size.0}}}}).to_string(),
        serde_json::json!({"Action":{"SetWindowHeight":{"id":id,"change":{"SetFixed":size.1}}}}).to_string(),
    ]
}

/// Aggregate budget for one position-independent mode operation (S2a): the
/// `Windows` lookup plus the single mode action share this total, never a
/// fresh budget per request. Callers pass the remainder down per call.
/// Allow four valid replies (lookup, mode, width, height) on a compositor
/// measured at up to 2.01 s per reply, without creating a fresh retry budget.
pub const NATIVE_MODE_BUDGET: Duration = Duration::from_secs(12);

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

#[cfg(test)]
mod slow_compositor_regression {
    use super::*;

    #[test]
    fn native_mode_accepts_slow_valid_replies_within_total_budget() {
        let mut expanded = false;
        let mut wires = Vec::new();
        let mut request = |wire: &str, budget: Duration| {
            wires.push(wire.to_owned());
            let (client, mut server) = UnixStream::pair()?;
            let payload = if wire == WINDOWS_REQUEST {
                serde_json::json!({"Ok":{"Windows":[{"id":7,"pid":42,"title":"Gentle Dot Panel","is_floating":true,"layout":{"window_size":[420,640],"tile_pos_in_workspace_view":[24.0,12.0]},"workspace_id":1}]}})
            } else {
                serde_json::json!({"Ok":"Handled"})
            };
            let peer = std::thread::spawn(move || {
                let mut request = Vec::new();
                std::io::BufRead::read_until(
                    &mut std::io::BufReader::new(&mut server), b'\n', &mut request,
                ).unwrap();
                // Above the former 250 ms cutoff; far below the observed 2 s reply.
                std::thread::sleep(Duration::from_millis(300));
                let _ = writeln!(server, "{payload}");
            });
            let result = request_on(client, wire, budget);
            peer.join().unwrap();
            result
        };
        let result = apply_native_mode(&mut expanded, true, 42, &mut request);
        assert_eq!(result.unwrap(), true);
        assert!(expanded);
        assert_eq!(wires, [WINDOWS_REQUEST.to_owned(), action_tiling(7), action_set_window_width(7), action_reset_window_height(7)]);
    }
}

/// Whether a decoded mode-action reply reports success (S2b-1): Niri answers
/// a handled action with the literal `"Handled"`. Any other `Ok` payload is
/// not success and must leave the tracked mode untouched.
pub fn is_handled(reply: &Value) -> bool {
    reply.as_str() == Some("Handled")
}

/// Long-lived compositor event subscription (native follow, Linux only): one
/// dedicated connection per stream. `connect` sends `EventStream` and fails
/// closed unless the first reply line decodes to `Handled`; `next_line`
/// waits up to `timeout` per call, returning `Ok(None)` on quiet (the
/// caller uses that tick to check debounce/shutdown) and `Err` on EOF or
/// wire errors (the caller reconnects with capped backoff). Buffering lives
/// here so callers never split a JSON line across reads. Tests use the pure
/// parsers below with literal event JSON, never a live compositor.
pub struct EventStream {
    stream: UnixStream,
    buf: Vec<u8>,
}

impl EventStream {
    pub fn connect(path: &Path, timeout: Duration) -> io::Result<Self> {
        let end = Instant::now() + timeout;
        let stream = connect(path, end)?;
        set_nonblocking(&stream)?;
        let mut this = Self { stream, buf: Vec::new() };
        let mut line = String::with_capacity(EVENT_STREAM_REQUEST.len() + 1);
        line.push_str(EVENT_STREAM_REQUEST.trim_end_matches('\n'));
        line.push('\n');
        write_all(&mut this.stream, line.as_bytes(), end)?;
        let reply = read_line(&mut this.stream, end)?;
        if !is_handled(&decode_reply(&reply)?) {
            return Err(invalid("niri: unexpected event-stream response"));
        }
        Ok(this)
    }

    pub fn next_line(&mut self, timeout: Duration) -> io::Result<Option<String>> {
        use std::os::unix::io::AsRawFd;
        let fd = self.stream.as_raw_fd();
        let end = Instant::now() + timeout;
        loop {
            if let Some(at) = self.buf.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = self.buf.drain(..at).collect();
                self.buf.drain(..1);
                if line.len() > REPLY_CAP {
                    return Err(invalid("niri: event too large"));
                }
                return String::from_utf8(line).map(Some).map_err(invalid);
            }
            if self.buf.len() > REPLY_CAP {
                return Err(invalid("niri: event too large"));
            }
            if Instant::now() >= end {
                return Ok(None); // Quiet tick: debounce/shutdown check, not an error.
            }
            match poll_ready(fd, libc::POLLIN, end) {
                Ok(hit) if hit & libc::POLLHUP != 0 => {}
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::TimedOut => return Ok(None),
                Err(error) => return Err(error),
            }
            let mut chunk = [0u8; 8192];
            match self.stream.read(&mut chunk) {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "niri: event stream closed")),
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
        }
    }
}

/// Logical `tile_pos_in_workspace_view` from a `WindowLayout` value: `None`
/// for missing/null/malformed/non-finite positions (transient drag state),
/// never read as the origin.
fn event_layout_pos(layout: &Value) -> Option<(f64, f64)> {
    let pair = layout.get("tile_pos_in_workspace_view")?;
    if pair.is_null() {
        return None;
    }
    let pair = pair.as_array()?;
    if pair.len() != 2 {
        return None;
    }
    let (x, y) = (pair[0].as_f64()?, pair[1].as_f64()?);
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some((x, y))
}

/// Owned-dot signal from a `WindowOpenedOrChanged` event (Niri 26.04 reports
/// live rose drags in this form): `(dot id, live position-or-None)` only for
/// the exact `pid` plus rose title. The owned panel (same pid, panel title),
/// other pids, and other event shapes never signal, so panel-induced traffic
/// cannot feed back into follow.
pub fn dot_opened_signal(event: &Value, pid: u32, dot_title: &str) -> Option<(u64, Option<(f64, f64)>)> {
    let window = event.get("WindowOpenedOrChanged")?.get("window")?;
    if window.get("pid").and_then(Value::as_u64) != Some(u64::from(pid)) {
        return None;
    }
    if window.get("title").and_then(Value::as_str) != Some(dot_title) {
        return None;
    }
    let id = window.get("id").and_then(Value::as_u64)?;
    Some((id, window.get("layout").and_then(event_layout_pos)))
}

/// Owned-dot signal from a `WindowLayoutsChanged` event: `Some(pos-or-None)`
/// when the tracked `dot_id` is among the changes (`None` pos is transient
/// drag state — the caller waits, never anchors), `None` when the dot is
/// absent, so panel-induced entries for other ids are ignored by
/// construction. `dot_id` itself always comes from the exact pid+title
/// resolver or a vetted opened-signal, never a guess.
pub fn dot_layout_signal(event: &Value, dot_id: u64) -> Option<Option<(f64, f64)>> {
    let changes = event.get("WindowLayoutsChanged")?.get("changes")?.as_array()?;
    for change in changes {
        let pair = change.as_array()?;
        if pair.len() != 2 || pair[0].as_u64() != Some(dot_id) {
            continue;
        }
        return Some(event_layout_pos(&pair[1]));
    }
    None
}

/// Owned-panel signal from a `WindowOpenedOrChanged` event (UNIDAD bidir,
/// Linux only): `(panel id, live position-or-None)` only for the exact
/// `pid` plus panel title. Symmetric to `dot_opened_signal`: the owned rose
/// (same pid, rose title), other pids, and other event shapes never signal,
/// so rose-induced traffic cannot feed back into the panel arm.
pub fn panel_opened_signal(event: &Value, pid: u32, panel_title: &str) -> Option<(u64, Option<(f64, f64)>)> {
    let window = event.get("WindowOpenedOrChanged")?.get("window")?;
    if window.get("pid").and_then(Value::as_u64) != Some(u64::from(pid)) {
        return None;
    }
    if window.get("title").and_then(Value::as_str) != Some(panel_title) {
        return None;
    }
    let id = window.get("id").and_then(Value::as_u64)?;
    Some((id, window.get("layout").and_then(event_layout_pos)))
}

/// Owned-panel signal from a `WindowLayoutsChanged` event (UNIDAD bidir):
/// `Some(pos-or-None)` when the tracked `panel_id` is among the changes,
/// `None` when absent, so rose-induced entries for other ids are ignored by
/// construction. Symmetric to `dot_layout_signal`.
pub fn panel_layout_signal(event: &Value, panel_id: u64) -> Option<Option<(f64, f64)>> {
    let changes = event.get("WindowLayoutsChanged")?.get("changes")?.as_array()?;
    for change in changes {
        let pair = change.as_array()?;
        if pair.len() != 2 || pair[0].as_u64() != Some(panel_id) {
            continue;
        }
        return Some(event_layout_pos(&pair[1]));
    }
    None
}

/// Legacy chase helper (UNIDAD bidir): kept for history only — the worker
/// no longer consults it. It moved ONE side toward the other with fixed
/// dot-priority, which inverted user moves (live trace: panel dragged
/// +180,-90 was pulled back to (816,422)). Superseded by `plan_joint_moves`.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitMove {
    MovePanel { id: u64, dx: i32, dy: i32 },
    MoveRose { id: u64, dx: i32, dy: i32 },
    Settled,
    Wait,
}

#[allow(dead_code)]
pub fn plan_unit_move(
    dot: &PanelWindow,
    dot_output: Option<&str>,
    panel: &PanelWindow,
    panel_output: Option<&str>,
    gap: i32,
) -> UnitMove {
    let beside = plan_beside_rose(dot, dot_output, panel, panel_output, gap);
    let rose = plan_rose_beside_panel(dot, dot_output, panel, panel_output, gap);
    match (beside, rose) {
        (Some((id, dx, dy)), _) if dx != 0 || dy != 0 => UnitMove::MovePanel { id, dx, dy },
        (Some(_), Some((id, dx, dy))) if dx != 0 || dy != 0 => UnitMove::MoveRose { id, dx, dy },
        (Some((_, 0, 0)), Some((_, 0, 0))) => UnitMove::Settled,
        _ => UnitMove::Wait,
    }
}

/// Portable gate (additive, Niri only): every Niri/Wayland effect
/// (EventStream, AdjustFixed, joint anchor, gated opacity) runs ONLY here.
/// App-owned (macOS/X11), Hyprland, other compositors, and socket-less Niri
/// never enter. Pure so the environment matrix pins it without a runtime.
/// Niri cannot pre-position new windows: the compositor maps first (a fresh
/// rose lands at its default, e.g. exact center), so the joint pass imposes
/// the anchor AFTER mapping under gated opacity-0 — never a pixel claim.
pub fn joint_env_active(places_windows: bool, is_niri: bool, socket_present: bool) -> bool {
    !places_windows && is_niri && socket_present
}

/// Who moved the unit (EventStream side): the anchor follows ONLY this.
/// Own joint moves never set it — that is the whole anti-ping-pong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mover {
    Dot,
    Panel,
}

/// Panel origin implied by a rose position: exact inverse of
/// `rose_beside_panel_target`. Pure IPC geometry only.
pub fn panel_implied_by_rose(
    rose_pos: (f64, f64),
    rose_size: (i32, i32),
    panel_size: (i32, i32),
    gap: i32,
) -> (i32, i32) {
    let x = (rose_pos.0 - f64::from(panel_size.0) - f64::from(gap)).round() as i32;
    let y = (rose_pos.1 - f64::from(panel_size.1) / 2.0 + f64::from(rose_size.1) / 2.0).round() as i32;
    (x, y)
}

/// Joint outcome from the ONE anchor: both destinations in the same pass.
/// `Moves` carries up to two exact-id AdjustFixed deltas (`None` = already
/// home); the worker sends both under one mode-lock hold and one epoch
/// check — sequential wire requests (Niri has no atomic batch), never an
/// intermediate reveal. `Wait` is fail-closed (transient nulls retry,
/// tiling/output/size stops); never `SetFixed`, never GTK coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JointMove {
    Settled,
    Moves { panel: Option<(u64, i32, i32)>, rose: Option<(u64, i32, i32)> },
    Wait,
}

/// Joint plan from the unit anchor (panel spot; rose derived beside-panel
/// right-centered). Guards: both floating, positive sizes, finite mapped
/// positions, non-empty outputs with dot == panel == anchor.output.
pub fn plan_joint_moves(
    anchor: &CompactSpot,
    dot: &PanelWindow,
    dot_output: Option<&str>,
    panel: &PanelWindow,
    panel_output: Option<&str>,
    gap: i32,
) -> JointMove {
    if !panel.floating || !dot.floating {
        return JointMove::Wait;
    }
    if dot.size.0 <= 0 || dot.size.1 <= 0 || panel.size.0 <= 0 || panel.size.1 <= 0 {
        return JointMove::Wait;
    }
    let dot_pos = match dot.pos {
        Some(pos) if pos.0.is_finite() && pos.1.is_finite() => pos,
        _ => return JointMove::Wait,
    };
    let panel_pos = match panel.pos {
        Some(pos) if pos.0.is_finite() && pos.1.is_finite() => pos,
        _ => return JointMove::Wait,
    };
    let dot_output = match dot_output.filter(|name| !name.is_empty()) {
        Some(name) => name,
        None => return JointMove::Wait,
    };
    let panel_output = match panel_output.filter(|name| !name.is_empty()) {
        Some(name) => name,
        None => return JointMove::Wait,
    };
    if dot_output != panel_output || panel_output != anchor.output.as_str() {
        return JointMove::Wait;
    }
    if !anchor.x.is_finite() || !anchor.y.is_finite() {
        return JointMove::Wait;
    }
    let (ptx, pty) = (anchor.x.round() as i32, anchor.y.round() as i32);
    let (rtx, rty) = rose_beside_panel_target((anchor.x, anchor.y), panel.size, dot.size, gap);
    let panel_delta = (ptx - panel_pos.0.round() as i32, pty - panel_pos.1.round() as i32);
    let rose_delta = (rtx - dot_pos.0.round() as i32, rty - dot_pos.1.round() as i32);
    let panel_move = (panel_delta != (0, 0)).then_some((panel.id, panel_delta.0, panel_delta.1));
    let rose_move = (rose_delta != (0, 0)).then_some((dot.id, rose_delta.0, rose_delta.1));
    match (panel_move, rose_move) {
        (None, None) => JointMove::Settled,
        (panel, rose) => JointMove::Moves { panel, rose },
    }
}

/// Anchor update from the user mover only. Panel mover keeps the panel spot;
/// dot mover stores the implied panel spot (inverse geometry). `None` on any
/// unresolvable input (tiling, sizes, null/non-finite, output mismatch) so
/// the caller preserves the old anchor fail-closed.
pub fn anchor_from_mover(
    mover: Mover,
    dot: &PanelWindow,
    dot_output: Option<&str>,
    panel: &PanelWindow,
    panel_output: Option<&str>,
    gap: i32,
) -> Option<CompactSpot> {
    let dot_output = dot_output.filter(|name| !name.is_empty())?;
    let panel_output = panel_output.filter(|name| !name.is_empty())?;
    if dot_output != panel_output {
        return None;
    }
    match mover {
        Mover::Panel => compact_spot(panel, Some(panel_output.to_owned())),
        Mover::Dot => {
            if !dot.floating || !panel.floating {
                return None;
            }
            if dot.size.0 <= 0 || dot.size.1 <= 0 || panel.size.0 <= 0 || panel.size.1 <= 0 {
                return None;
            }
            let dot_pos = dot.pos?;
            if !dot_pos.0.is_finite() || !dot_pos.1.is_finite() {
                return None;
            }
            let (x, y) = panel_implied_by_rose(dot_pos, dot.size, panel.size, gap);
            Some(CompactSpot { output: dot_output.to_owned(), x: x as f64, y: y as f64 })
        }
    }
}

/// Mover-scoped joint outcome (rosa-dir fix): on a user-Dot wake the rose
/// never moves — it is already where the user put it, and moving it is what
/// produced the "meet in the middle" (panel to a stale anchor while the
/// rose chased the live panel). Dot wake keeps the panel leg only; Panel
/// wake keeps the rose leg only (symmetry already correct live, pinned
/// here); no mover (reopen/unhide/restore/collapse) keeps both legs.
/// A filtered-out leg reads Settled when the kept leg is home, never a
/// chase of the already-placed side. Pure so tests pin it without IPC.
///
/// Fullscreen exit (maximizar→achicar): the unit ALWAYS returns to the
/// base/default anchor — the compositor-placed floating frame
/// (settled-verified, never invented coordinates, never `SetFixed`; Niri
/// exposes no `Outputs` geometry in this tree, so "esquina superior
/// derecha" is wherever the compositor floats the panel, typically
/// top-right per Niri rules) with the rose joined beside-panel in the same
/// joint pass under the gate. Explicit decision, user-requested: exiting
/// fullscreen RESETS the session anchor (`native_compact = None`, mover
/// cleared); outside fullscreen the anchor is untouched (only the user
/// mover and the hide/expand capture write it). No dialogs, portable gate
/// intact (Niri-native only).
/// Whether a mode flip is a genuine fullscreen exit to default (Linux
/// only): was expanded and collapsing, on the Niri-native gate only.
/// App-owned sessions, non-Niri compositors, and socket-less Niri never
/// reset — their anchor semantics stay untouched. Pure so tests pin the
/// matrix without windows or IPC.
pub fn fullscreen_exit_to_default(
    was_expanded: bool,
    on: bool,
    places_windows: bool,
    is_niri: bool,
    socket_present: bool,
) -> bool {
    was_expanded && !on && joint_env_active(places_windows, is_niri, socket_present)
}

/// Filters one joint plan to the user mover (see above): `None` keeps the
/// full two-leg pass; `Some(Dot)` keeps the panel leg; `Some(Panel)` keeps
/// the rose leg. `Settled`/`Wait` pass through untouched.
pub fn joint_moves_for_mover(mover: Option<Mover>, joint: JointMove) -> JointMove {
    let (panel, rose) = match joint {
        JointMove::Moves { panel, rose } => (panel, rose),
        settled_or_wait => return settled_or_wait,
    };
    match mover {
        None => JointMove::Moves { panel, rose },
        Some(Mover::Dot) => match panel {
            Some(_) => JointMove::Moves { panel, rose: None },
            None => JointMove::Settled,
        },
        Some(Mover::Panel) => match rose {
            Some(_) => JointMove::Moves { panel: None, rose },
            None => JointMove::Settled,
        },
    }
}

/// Anti-feedback gate (UNIDAD bidir): after a programmatic move of one side,
/// its compositor echoes are ignored until `until`; the other side stays
/// armable. Pure instants only — never window JSON or titles.
pub fn suppress_active(now: Instant, until: Option<Instant>) -> bool {
    matches!(until, Some(t) if now < t)
}

/// Id from a `WindowClosed` event, if any: the follower clears its tracked
/// dot id on exactly this id so a remapped rose re-resolves instead of
/// following a dead window.
pub fn window_closed_id(event: &Value) -> Option<u64> {
    event.get("WindowClosed")?.get("id").and_then(Value::as_u64)
}

/// Whether a debounced dot signal may wake the single restore worker
/// (native follow, Linux only): hide, expanded/fullscreen, hidden panels,
/// and app-owned fullscreen all win — only a visible compact panel with a
/// shown rose reanchors. Pure so tests pin the matrix without a runtime.
pub fn follow_wake_eligible(rose_hidden: bool, expanded: bool, panel_visible: bool, fullscreen: bool) -> bool {
    !rose_hidden && !expanded && panel_visible && !fullscreen
}

/// Whether the last dot signal is old enough to act on: fires only after
/// the full quiet interval, matching the mac 300 ms drag-settle reanchor.
pub fn debounce_due(last_signal: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_signal) >= FOLLOW_DEBOUNCE
}

/// Follow decision for the owned shared Niri window: return the workspace to
/// move to, `Some` only when every input is known, the target differs from
/// ours, and no move for that target is already in flight. A different
/// in-flight target is superseded (the newer switch wins); arrival clears the
/// marker in the caller. Pure so the truth table pins it without IPC.
pub fn follow_workspace_target(
    own_workspace: Option<u64>,
    active_on_output: Option<u64>,
    owned_known: bool,
    in_flight: Option<u64>,
) -> Option<u64> {
    if !owned_known {
        return None;
    }
    let own = own_workspace?;
    let target = active_on_output?;
    if own == target || in_flight == Some(target) {
        return None;
    }
    Some(target)
}

/// Why `follow_workspace_target` produced no target for one workspace
/// activation: `None` means ready (the predicate would move), otherwise the
/// missing input — `"owned-id"`, `"own-workspace"`, `"workspaces-list"` —
/// or the no-op cause (`"same-workspace"`, `"in-flight"`). Same argument
/// order as the predicate; the check order mirrors it, so the two can never
/// disagree on ready-vs-skip. Pure so the follow loop logs one skip line
/// per activation without re-deriving the truth table inline.
pub fn follow_skip_reason(
    own_workspace: Option<u64>,
    active_on_output: Option<u64>,
    owned_known: bool,
    in_flight: Option<u64>,
) -> Option<&'static str> {
    if !owned_known {
        return Some("owned-id");
    }
    let (Some(own), Some(target)) = (own_workspace, active_on_output) else {
        return Some(if own_workspace.is_none() { "own-workspace" } else { "workspaces-list" });
    };
    if own == target {
        return Some("same-workspace");
    }
    if in_flight == Some(target) {
        return Some("in-flight");
    }
    None
}

/// Exact wire JSON for one follow move: explicit window id plus `Id` workspace
/// reference with `focus: false`, so the move preserves floating position,
/// never steals focus, and never changes the active workspace.
pub fn action_move_to_workspace(window_id: u64, workspace_id: u64) -> String {
    format!("{{\"Action\":{{\"MoveWindowToWorkspace\":{{\"window_id\":{window_id},\"reference\":{{\"Id\":{workspace_id}}},\"focus\":false}}}}}}")
}

/// Id from a `WorkspaceActivated` event (`"now the active workspace on its
/// output"`, not necessarily focused). `None` for every other event shape.
pub fn workspace_activated_id(event: &Value) -> Option<u64> {
    event.get("WorkspaceActivated")?.get("id")?.as_u64()
}

/// Workspaces list inside any known envelope: a bare array, `{"Workspaces":
/// [...]}`, `{"WorkspacesChanged": {"workspaces": [...]}}`, or
/// `{"workspaces": [...]}`.
fn workspaces_entries(payload: &Value) -> Option<&Vec<Value>> {
    if let Some(list) = payload.as_array() {
        return Some(list);
    }
    if let Some(list) = payload.get("Workspaces").and_then(Value::as_array) {
        return Some(list);
    }
    if let Some(list) = payload
        .get("WorkspacesChanged")
        .and_then(|inner| inner.get("workspaces"))
        .and_then(Value::as_array)
    {
        return Some(list);
    }
    payload.get("workspaces").and_then(Value::as_array)
}

/// Active workspace id on `output`: the entry with matching non-empty output
/// and `is_active`. `None` when unknown, so the caller waits instead of
/// guessing across outputs.
pub fn active_workspace_on_output(payload: &Value, output: &str) -> Option<u64> {
    if output.is_empty() {
        return None;
    }
    let list = workspaces_entries(payload)?;
    for entry in list {
        if entry.get("output").and_then(Value::as_str) != Some(output) {
            continue;
        }
        if entry.get("is_active").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        return entry.get("id").and_then(Value::as_u64);
    }
    None
}

/// Our window's workspace inside a stream event: `Some(workspace-or-None)`
/// when `window_id` is present (`None` workspace is a transient state the
/// caller waits on), `None` when the event says nothing about that window.
/// Covers `WindowsChanged` (full replace) and `WindowOpenedOrChanged`.
pub fn window_workspace_in_event(event: &Value, window_id: u64) -> Option<Option<u64>> {
    if let Some(windows) = event
        .get("WindowsChanged")
        .and_then(|inner| inner.get("windows"))
        .and_then(Value::as_array)
    {
        for window in windows {
            if window.get("id").and_then(Value::as_u64) != Some(window_id) {
                continue;
            }
            return Some(window.get("workspace_id").and_then(Value::as_u64));
        }
        return None;
    }
    let window = event.get("WindowOpenedOrChanged")?.get("window")?;
    if window.get("id").and_then(Value::as_u64) != Some(window_id) {
        return None;
    }
    Some(window.get("workspace_id").and_then(Value::as_u64))
}

/// How long the follower waits for the next event line: the remaining quiet
/// while a signal is pending, else the idle poll quantum (a quiet tick
/// re-checks shutdown/reconnect bounds without spinning).
pub fn follow_wait(pending: Option<Instant>, now: Instant, idle: Duration) -> Duration {
    match pending {
        Some(last) => FOLLOW_DEBOUNCE.saturating_sub(now.saturating_duration_since(last)),
        None => idle,
    }
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
        for bad in [panel(true, (0, 0), Some((10.0, 20.0))), panel(true, (-420, 200), Some((10.0, 20.0)))] {
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
    fn follow_workspace_target_truth_table() {
        // Some only when every input is known, the target differs from ours,
        // and no move for that target is already in flight.
        assert_eq!(follow_workspace_target(Some(1), Some(2), true, None), Some(2));
        assert_eq!(follow_workspace_target(Some(1), Some(2), true, Some(9)), Some(2));
        assert_eq!(follow_workspace_target(Some(2), Some(2), true, None), None);
        assert_eq!(follow_workspace_target(None, Some(2), true, None), None);
        assert_eq!(follow_workspace_target(Some(1), None, true, None), None);
        assert_eq!(follow_workspace_target(Some(1), Some(2), false, None), None);
        assert_eq!(follow_workspace_target(Some(1), Some(2), true, Some(2)), None);
        assert_eq!(follow_workspace_target(None, None, false, Some(2)), None);
    }

    #[test]
    fn follow_skip_reason_names_missing_input() {
        // Mirrors `follow_workspace_target`: `None` means ready (a target
        // would be produced), every `None`-target case names its input.
        assert_eq!(follow_skip_reason(Some(1), Some(2), true, None), None);
        assert_eq!(follow_skip_reason(Some(1), Some(2), true, Some(9)), None);
        assert_eq!(
            follow_skip_reason(Some(1), Some(2), false, None),
            Some("owned-id")
        );
        assert_eq!(follow_skip_reason(None, Some(2), true, None), Some("own-workspace"));
        assert_eq!(follow_skip_reason(Some(1), None, true, None), Some("workspaces-list"));
        assert_eq!(follow_skip_reason(Some(2), Some(2), true, None), Some("same-workspace"));
        assert_eq!(follow_skip_reason(Some(1), Some(2), true, Some(2)), Some("in-flight"));
        assert_eq!(follow_skip_reason(None, None, false, Some(2)), Some("owned-id"));
    }

    #[test]
    fn follow_workspace_event_helpers() {
        let activated = serde_json::json!({"WorkspaceActivated": {"id": 5, "focused": false}});
        assert_eq!(workspace_activated_id(&activated), Some(5));
        assert_eq!(workspace_activated_id(&serde_json::json!({"WindowsChanged": {"windows": []}})), None);
        let changed = serde_json::json!({"WorkspacesChanged": {"workspaces": [
            {"id": 1, "output": "DP-1", "is_active": false},
            {"id": 2, "output": "DP-1", "is_active": true},
            {"id": 3, "output": "HDMI-1", "is_active": true}
        ]}});
        assert_eq!(active_workspace_on_output(&changed, "DP-1"), Some(2));
        assert_eq!(active_workspace_on_output(&changed, "HDMI-1"), Some(3));
        assert_eq!(active_workspace_on_output(&changed, "OTHER"), None);
        let moved = serde_json::json!({"WindowsChanged": {"windows": [
            {"id": 9, "workspace_id": 2},
            {"id": 10, "workspace_id": 1}
        ]}});
        assert_eq!(window_workspace_in_event(&moved, 9), Some(Some(2)));
        assert_eq!(window_workspace_in_event(&moved, 11), None);
        let opened = serde_json::json!({"WindowOpenedOrChanged": {"window": {"id": 9, "workspace_id": 4}}});
        assert_eq!(window_workspace_in_event(&opened, 9), Some(Some(4)));
        assert_eq!(window_workspace_in_event(&opened, 10), None);
        let move_action = action_move_to_workspace(9, 2);
        assert_eq!(move_action, r#"{"Action":{"MoveWindowToWorkspace":{"window_id":9,"reference":{"Id":2},"focus":false}}}"#);
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
        let ok = fake_niri(reply_line(br#"{"Ok":{"Windows":[]}}"#), Duration::from_secs(2)).unwrap();
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
        server.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
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
                    Err(_) if start.elapsed() < Duration::from_secs(5) => thread::sleep(Duration::from_millis(10)),
                    Err(_) => break,
                }
            }
        });
        let payload = Client::new(&socket.path, Duration::from_secs(2)).request(WINDOWS_REQUEST).unwrap();
        assert!(payload["Windows"].is_array());
        worker.join().unwrap();
    }

    #[test]
    fn connect_rejects_bad_or_missing_socket_paths() {
        let missing = TempSocket::named("absent");
        let dial = |path: &std::path::Path| Client::new(path, Duration::from_secs(2)).request(WINDOWS_REQUEST);
        // Nothing listening: fast refusal through the real connect path, never a hang.
        assert!(dial(&missing.path).is_err());
        assert!(dial(std::path::Path::new("")).is_err());
        assert!(dial(std::path::Path::new("niri-\0-sock")).is_err());
        let long = format!("{}/{}", std::env::temp_dir().display(), "s".repeat(200));
        assert!(dial(std::path::Path::new(&long)).is_err());
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
    fn dot_selector_needs_the_unique_pid_and_rose_title() {
        let at = serde_json::json!([10.0, 20.0]);
        let payload = serde_json::json!({"Windows": [
            win(1, 100, "Gentle Dot", true, at.clone()),
            win(2, 100, "Gentle Dot Panel", true, at.clone()),
            win(3, 999, "Gentle Dot", true, at.clone()),
        ]});
        assert_eq!(own_dot_window(&payload, 100).unwrap().id, 1);
        assert!(own_dot_window(&serde_json::json!({"Windows": []}), 100).is_none());
        let dup = serde_json::json!({"Windows": [
            win(1, 100, "Gentle Dot", true, at.clone()),
            win(2, 100, "Gentle Dot", true, at),
        ]});
        assert!(own_dot_window(&dup, 100).is_none());
    }

    #[test]
    fn beside_rose_targets_the_roomy_side_recomputed_every_reopen() {
        // Default right-edge rose: panel lands left, vertically centered.
        assert_eq!(beside_rose_target((1852.0, 500.0), (72, 72), (420, 640), 8), (1424, 216));
        // Left-edge rose: panel lands right instead; no output clamp here.
        assert_eq!(beside_rose_target((12.0, 500.0), (72, 72), (420, 640), 8), (92, 216));
        // Pure IPC positions: the same dot recomputes the same target, so
        // every reopen re-derives it instead of reusing a remembered spot.
        assert_eq!(
            beside_rose_target((1852.0, 500.0), (72, 72), (420, 640), 8),
            beside_rose_target((1852.0, 500.0), (72, 72), (420, 640), 8)
        );
    }

    #[test]
    fn beside_rose_plans_adjustfixed_deltas_on_the_same_output_only() {
        let dot = PanelWindow { id: 5, floating: true, size: (72, 72), pos: Some((1852.0, 500.0)), workspace: Some(7) };
        let panel = PanelWindow { id: 11, floating: true, size: (420, 640), pos: Some((90.0, 205.0)), workspace: Some(7) };
        // Same output: exact panel id plus the delta to the beside target.
        let (id, dx, dy) = plan_beside_rose(&dot, Some("DP-1"), &panel, Some("DP-1"), 8).unwrap();
        assert_eq!(id, 11);
        let (tx, ty) = beside_rose_target((1852.0, 500.0), (72, 72), (420, 640), 8);
        assert_eq!((dx, dy), (tx - 90, ty - 205));
        // The move wire stays AdjustFixed-only: never SetFixed, never raw coords.
        let wire = action_move_floating(id, dx, dy);
        assert!(wire.contains("AdjustFixed"));
        assert!(!wire.contains("SetFixed"));
        // Already beside: settled, no move needed.
        let home = PanelWindow { pos: Some((tx as f64, ty as f64)), ..panel };
        assert_eq!(plan_beside_rose(&dot, Some("DP-1"), &home, Some("DP-1"), 8), Some((11, 0, 0)));
        // Fail closed: other/missing outputs, tiling, nulls, bad sizes.
        assert!(plan_beside_rose(&dot, Some("DP-1"), &panel, Some("HDMI-1"), 8).is_none());
        assert!(plan_beside_rose(&dot, None, &panel, Some("DP-1"), 8).is_none());
        assert!(plan_beside_rose(&dot, Some(""), &panel, Some("DP-1"), 8).is_none());
        let tiled = PanelWindow { floating: false, ..panel };
        assert!(plan_beside_rose(&dot, Some("DP-1"), &tiled, Some("DP-1"), 8).is_none());
        let tiled_dot = PanelWindow { floating: false, ..dot };
        assert!(plan_beside_rose(&tiled_dot, Some("DP-1"), &panel, Some("DP-1"), 8).is_none());
        let null = PanelWindow { pos: None, ..panel };
        assert!(plan_beside_rose(&dot, Some("DP-1"), &null, Some("DP-1"), 8).is_none());
        let tiny = PanelWindow { size: (0, 0), ..panel };
        assert!(plan_beside_rose(&dot, Some("DP-1"), &tiny, Some("DP-1"), 8).is_none());
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

    fn dot_window_json(id: u64, pid: u64, title: &str, pos: Value) -> Value {
        serde_json::json!({"WindowOpenedOrChanged": {"window":
            {"id": id, "pid": pid, "title": title, "workspace_id": 7,
            "is_floating": true,
            "layout": {"tile_pos_in_workspace_view": pos, "window_size": [72, 72]}}}})
    }

    fn layouts_json(changes: Value) -> Value {
        serde_json::json!({"WindowLayoutsChanged": {"changes": changes}})
    }

    fn layout_value(x: f64, y: f64) -> Value {
        serde_json::json!({"tile_pos_in_workspace_view": [x, y], "window_size": [72, 72]})
    }

    #[test]
    fn follow_opened_signal_needs_the_exact_pid_and_rose_title() {
        let at = serde_json::json!([1852.0, 500.0]);
        // The owned rose move arrives as OpenedOrChanged: id plus live pos.
        assert_eq!(
            dot_opened_signal(&dot_window_json(5, 100, "Gentle Dot", at.clone()), 100, "Gentle Dot"),
            Some((5, Some((1852.0, 500.0))))
        );
        // Transient null layout still identifies the dot id, never a position.
        assert_eq!(
            dot_opened_signal(&dot_window_json(5, 100, "Gentle Dot", Value::Null), 100, "Gentle Dot"),
            Some((5, None))
        );
        // The owned panel, another pid, and unknown shapes never signal.
        assert!(dot_opened_signal(&dot_window_json(11, 100, "Gentle Dot Panel", at.clone()), 100, "Gentle Dot").is_none());
        assert!(dot_opened_signal(&dot_window_json(5, 999, "Gentle Dot", at.clone()), 100, "Gentle Dot").is_none());
        assert!(dot_opened_signal(&layouts_json(serde_json::json!([])), 100, "Gentle Dot").is_none());
        assert!(dot_opened_signal(&serde_json::json!({"WindowClosed": {"id": 5}}), 100, "Gentle Dot").is_none());
    }

    #[test]
    fn follow_layouts_signal_routes_only_the_known_dot_id() {
        // Panel-induced layout traffic (our own AdjustFixed) never signals:
        // only the tracked dot id does.
        let changes = serde_json::json!([[11, layout_value(90.0, 205.0)], [5, layout_value(1840.0, 480.0)]]);
        assert_eq!(dot_layout_signal(&layouts_json(changes), 5), Some(Some((1840.0, 480.0))));
        let panel_only = serde_json::json!([[11, layout_value(90.0, 205.0)]]);
        assert!(dot_layout_signal(&layouts_json(panel_only), 5).is_none());
        // A null layout for the dot is a transient wait, never the origin.
        let null = serde_json::json!([[5, {"tile_pos_in_workspace_view": null, "window_size": [72, 72]}]]);
        assert_eq!(dot_layout_signal(&layouts_json(null), 5), Some(None));
        // Non-finite positions never become anchors either.
        let bad = serde_json::json!([[5, {"tile_pos_in_workspace_view": [1.0, null], "window_size": [72, 72]}]]);
        assert_eq!(dot_layout_signal(&layouts_json(bad), 5), Some(None));
        assert!(dot_layout_signal(&dot_window_json(5, 100, "Gentle Dot", serde_json::json!([1.0, 2.0])), 5).is_none());
    }

    #[test]
    fn follow_closed_signal_carries_only_the_exact_id() {
        assert_eq!(window_closed_id(&serde_json::json!({"WindowClosed": {"id": 5}})), Some(5));
        assert!(window_closed_id(&layouts_json(serde_json::json!([]))).is_none());
    }

    #[test]
    fn follow_wake_needs_visible_compact_rose_shown_panel() {
        // Hide, expanded (fullscreen path), hidden panels, and app-owned
        // fullscreen all win over follow: only a visible compact panel with
        // a shown rose reanchors.
        assert!(follow_wake_eligible(false, false, true, false));
        for blocked in [
            (true, false, true, false),
            (false, true, true, false),
            (false, false, false, false),
            (false, false, true, true),
            (true, true, false, true),
        ] {
            assert!(!follow_wake_eligible(blocked.0, blocked.1, blocked.2, blocked.3), "{blocked:?}");
        }
    }

    #[test]
    fn follow_debounce_fires_only_after_quiet() {
        let now = Instant::now();
        // A fresh signal is not due; exactly the quiet interval is due.
        assert!(!debounce_due(now, now));
        assert!(!debounce_due(now, now + FOLLOW_DEBOUNCE - Duration::from_millis(1)));
        assert!(debounce_due(now, now + FOLLOW_DEBOUNCE));
        assert!(debounce_due(now, now + FOLLOW_DEBOUNCE + Duration::from_secs(1)));
        // The wait quantum is the remaining quiet, else the idle poll.
        assert_eq!(follow_wait(Some(now), now, Duration::from_secs(1)), FOLLOW_DEBOUNCE);
        assert_eq!(follow_wait(Some(now), now + FOLLOW_DEBOUNCE, Duration::from_secs(1)), Duration::ZERO);
        assert_eq!(follow_wait(None, now, Duration::from_secs(1)), Duration::from_secs(1));
    }

    #[test]
    fn rose_moves_beside_the_panel_on_niri_unhide() {
        // Live FAIL mv347ejs leg (2): chat moved to (1185,162), then unhide
        // left the rose at the saved spot (1244,706) and pulled the panel
        // back to (816,422). Expected: the ROSE moves beside the moved
        // panel, never the panel back. Right-of-panel, vertically centered.
        assert_eq!(rose_beside_panel_target((816.0, 422.0), (420, 640), (72, 72), 8), (1244, 706));
        assert_eq!(rose_beside_panel_target((1185.0, 162.0), (420, 640), (72, 72), 8), (1613, 446));
        // Pure IPC geometry: same inputs recompute the same target.
        assert_eq!(
            rose_beside_panel_target((1185.0, 162.0), (420, 640), (72, 72), 8),
            rose_beside_panel_target((1185.0, 162.0), (420, 640), (72, 72), 8)
        );
    }

    #[test]
    fn rose_beside_panel_plans_exact_dot_adjustfixed_on_same_output() {
        let dot = PanelWindow { id: 30, floating: true, size: (72, 72), pos: Some((1244.0, 706.0)), workspace: Some(7) };
        let panel = PanelWindow { id: 28, floating: true, size: (420, 640), pos: Some((1185.0, 162.0)), workspace: Some(7) };
        // Exact DOT id plus the delta to beside-the-panel, same output only.
        let (id, dx, dy) = plan_rose_beside_panel(&dot, Some("DP-1"), &panel, Some("DP-1"), 8).unwrap();
        assert_eq!(id, 30);
        let (tx, ty) = rose_beside_panel_target((1185.0, 162.0), (420, 640), (72, 72), 8);
        assert_eq!((dx, dy), (tx - 1244, ty - 706));
        let wire = action_move_floating(id, dx, dy);
        assert!(wire.contains("AdjustFixed"));
        assert!(!wire.contains("SetFixed"));
        // Already beside: settled, no move needed.
        let home = PanelWindow { pos: Some((tx as f64, ty as f64)), ..dot };
        assert_eq!(plan_rose_beside_panel(&home, Some("DP-1"), &panel, Some("DP-1"), 8), Some((30, 0, 0)));
        // Fail closed: other/missing outputs, tiling either side, nulls, bad sizes.
        assert!(plan_rose_beside_panel(&dot, Some("DP-1"), &panel, Some("HDMI-1"), 8).is_none());
        assert!(plan_rose_beside_panel(&dot, None, &panel, Some("DP-1"), 8).is_none());
        assert!(plan_rose_beside_panel(&dot, Some(""), &panel, Some("DP-1"), 8).is_none());
        let tiled_dot = PanelWindow { floating: false, ..dot };
        assert!(plan_rose_beside_panel(&tiled_dot, Some("DP-1"), &panel, Some("DP-1"), 8).is_none());
        let tiled_panel = PanelWindow { floating: false, ..panel };
        assert!(plan_rose_beside_panel(&dot, Some("DP-1"), &tiled_panel, Some("DP-1"), 8).is_none());
        let null = PanelWindow { pos: None, ..dot };
        assert!(plan_rose_beside_panel(&null, Some("DP-1"), &panel, Some("DP-1"), 8).is_none());
        let tiny = PanelWindow { size: (0, 0), ..dot };
        assert!(plan_rose_beside_panel(&tiny, Some("DP-1"), &panel, Some("DP-1"), 8).is_none());
    }

    #[test]
    fn hidden_default_anchor_needs_a_settled_floating_spot() {
        // Live FAIL mv347ejs leg (1): hidden-no-spot gated then cancelled,
        // leaving the panel hidden. Expected: reveal at the verified default
        // anchor once settled — never a permanent cancel, bounded retry.
        assert!(default_anchor_valid(&fl(Some((90.0, 205.0)))));
        assert!(default_anchor_valid(&fl(Some((0.0, 0.0)))));
        assert!(!default_anchor_valid(&panel(false, (420, 640), Some((90.0, 205.0)))));
        assert!(!default_anchor_valid(&fl(None)));
        assert!(!default_anchor_valid(&panel(true, (0, 0), Some((90.0, 205.0)))));
        assert!(!default_anchor_valid(&fl(Some((f64::NAN, 205.0)))));
        // Settle needs two consecutive equal reads: first arms, second reveals.
        assert!(!default_anchor_settled(None, (90.0, 205.0)));
        assert!(default_anchor_settled(Some((90.0, 205.0)), (90.0, 205.0)));
        assert!(!default_anchor_settled(Some((91.0, 205.0)), (90.0, 205.0)));
    }

    #[test]
    fn collapse_default_needs_intent_output_and_settle_not_just_equal_reads() {
        // Unit 20a: two equal arbitrary reads are NOT default correctness —
        // `MoveFloatingWindow` forces `animate=true` and IPC geometry omits
        // animated offsets, so equality is not rendered settlement. A default
        // settle additionally needs this generation's collapse intent (the
        // float transition ran before any restore read) plus a resolved
        // output. Never invented coordinates, never `SetFixed`.
        let floating = fl(Some((816.0, 422.0)));
        // Equal reads without intent never settle, even with an output.
        assert!(!collapse_default_ready(&floating, Some("DP-1"), false, Some((816.0, 422.0)), (816.0, 422.0)));
        // Intent plus settle without a resolved output never settles either.
        assert!(!collapse_default_ready(&floating, None, true, Some((816.0, 422.0)), (816.0, 422.0)));
        assert!(!collapse_default_ready(&floating, Some(""), true, Some((816.0, 422.0)), (816.0, 422.0)));
        // Intent + output + two equal reads settle.
        assert!(collapse_default_ready(&floating, Some("DP-1"), true, Some((816.0, 422.0)), (816.0, 422.0)));
        // First sighting only arms; drift re-arms — even with intent+output.
        assert!(!collapse_default_ready(&floating, Some("DP-1"), true, None, (816.0, 422.0)));
        assert!(!collapse_default_ready(&floating, Some("DP-1"), true, Some((100.0, 100.0)), (816.0, 422.0)));
        // Tiling or invalid geometry never settles at default.
        let tiled = panel(false, (420, 640), Some((816.0, 422.0)));
        assert!(!collapse_default_ready(&tiled, Some("DP-1"), true, Some((816.0, 422.0)), (816.0, 422.0)));
        assert!(!collapse_default_ready(&fl(None), Some("DP-1"), true, None, (816.0, 422.0)));
    }

    #[test]
    fn missing_window_retry_is_bounded_and_secret_free() {
        // Live FAIL mv347ejs leg (3): panel id28 vanished, job3 spun on
        // missing-window to the deadline plus a fleeting 240x157 dialog.
        // The wait must end by time AND by pass count — never infinite — and
        // carry no window JSON, titles, sockets, or accounts.
        let budget = Duration::from_millis(750);
        assert!(missing_window_should_retry(Duration::from_millis(0), budget, 0));
        assert!(missing_window_should_retry(Duration::from_millis(749), budget, 0));
        assert!(!missing_window_should_retry(budget, budget, 0));
        assert!(!missing_window_should_retry(Duration::from_secs(10), budget, 0));
        assert!(!missing_window_should_retry(Duration::from_millis(0), budget, MISSING_WINDOW_MAX_PASSES));
        assert!(!missing_window_should_retry(Duration::from_millis(0), budget, MISSING_WINDOW_MAX_PASSES + 5));
        assert!(MISSING_WINDOW_MAX_PASSES <= 32, "pass cap stays small, no spin");
    }

    #[test]
    fn unit_panel_signals_need_the_exact_pid_and_panel_title() {
        // UNIDAD bidir: la contraparte simétrica de dot_opened/dot_layout.
        // Solo el panel propio (mismo pid + título panel) señala; la rosa,
        // otro pid y formas desconocidas nunca arman el follow del otro lado.
        let at = serde_json::json!([816.0, 422.0]);
        assert_eq!(
            panel_opened_signal(&dot_window_json(28, 100, "Gentle Dot Panel", at.clone()), 100, "Gentle Dot Panel"),
            Some((28, Some((816.0, 422.0))))
        );
        assert_eq!(
            panel_opened_signal(&dot_window_json(28, 100, "Gentle Dot Panel", Value::Null), 100, "Gentle Dot Panel"),
            Some((28, None))
        );
        assert!(panel_opened_signal(&dot_window_json(5, 100, "Gentle Dot", at.clone()), 100, "Gentle Dot Panel").is_none());
        assert!(panel_opened_signal(&dot_window_json(28, 999, "Gentle Dot Panel", at.clone()), 100, "Gentle Dot Panel").is_none());
        assert!(panel_opened_signal(&layouts_json(serde_json::json!([])), 100, "Gentle Dot Panel").is_none());
        // Layouts: solo el panel trackeado señala; la rosa no lo dispara.
        let both = serde_json::json!([[5, layout_value(1444.0, 786.0)], [28, layout_value(820.0, 430.0)]]);
        assert_eq!(panel_layout_signal(&layouts_json(both), 28), Some(Some((820.0, 430.0))));
        let rose_only = serde_json::json!([[5, layout_value(1444.0, 786.0)]]);
        assert!(panel_layout_signal(&layouts_json(rose_only), 28).is_none());
        let null = serde_json::json!([[28, {"tile_pos_in_workspace_view": null, "window_size": [420, 640]}]]);
        assert_eq!(panel_layout_signal(&layouts_json(null), 28), Some(None));
    }

    #[test]
    fn unit_move_resolves_one_direction_then_settles() {
        // UNIDAD: un solo dato (panel compacto; rosa derivada). Dot con
        // prioridad cuando la rosa está visible: si el panel no está beside,
        // se mueve el panel; si ya está beside pero la rosa no, se mueve la
        // rosa; si ambos asentados, nada; nulls/outputs/tiling esperan.
        let dot = PanelWindow { id: 30, floating: true, size: (72, 72), pos: Some((1444.0, 786.0)), workspace: Some(7) };
        let panel = PanelWindow { id: 28, floating: true, size: (420, 640), pos: Some((816.0, 422.0)), workspace: Some(7) };
        // Rosa movida (+200,+80): el panel debe ir a su beside.
        match plan_unit_move(&dot, Some("DP-1"), &panel, Some("DP-1"), 8) {
            UnitMove::MovePanel { id, dx, dy } => {
                assert_eq!(id, 28);
                let (tx, ty) = beside_rose_target((1444.0, 786.0), (72, 72), (420, 640), 8);
                assert_eq!((dx, dy), (tx - 816, ty - 422));
                assert!(action_move_floating(id, dx, dy).contains("AdjustFixed"));
            }
            other => panic!("esperaba MovePanel, fue {other:?}"),
        }
        // Panel beside pero rosa fuera: se mueve la rosa (id exacto dot).
        // Caso borde-izquierdo (asimétrico: beside va a la derecha del dot,
        // la rosa siempre a la derecha del panel): dot en (12,500), panel en
        // su beside (92,216), la rosa debe ir a (520,500).
        let left_dot = PanelWindow { id: 30, floating: true, size: (72, 72), pos: Some((12.0, 500.0)), workspace: Some(7) };
        let (btx, bty) = beside_rose_target((12.0, 500.0), (72, 72), (420, 640), 8);
        assert_eq!((btx, bty), (92, 216));
        let right_panel = PanelWindow { id: 28, floating: true, size: (420, 640), pos: Some((btx as f64, bty as f64)), workspace: Some(7) };
        match plan_unit_move(&left_dot, Some("DP-1"), &right_panel, Some("DP-1"), 8) {
            UnitMove::MoveRose { id, dx, dy } => {
                assert_eq!(id, 30);
                let (rx, ry) = rose_beside_panel_target((btx as f64, bty as f64), (420, 640), (72, 72), 8);
                assert_eq!((rx, ry), (520, 500));
                assert_eq!((dx, dy), (rx - 12, ry - 500));
            }
            other => panic!("esperaba MoveRose, fue {other:?}"),
        }
        // Ambos asentados: nada que mover (borde-derecho, simétrico).
        let (stx, sty) = beside_rose_target((1444.0, 786.0), (72, 72), (420, 640), 8);
        let settled_panel = PanelWindow { pos: Some((stx as f64, sty as f64)), ..panel };
        let rpos = rose_beside_panel_target((stx as f64, sty as f64), (420, 640), (72, 72), 8);
        assert_eq!(rpos, (1444, 786));
        let settled_dot = PanelWindow { pos: Some((rpos.0 as f64, rpos.1 as f64)), ..dot };
        assert_eq!(plan_unit_move(&settled_dot, Some("DP-1"), &settled_panel, Some("DP-1"), 8), UnitMove::Settled);
        // Espera fail-closed: nulls, outputs distintos, tiling.
        let null_panel = PanelWindow { pos: None, ..panel };
        assert_eq!(plan_unit_move(&dot, Some("DP-1"), &null_panel, Some("DP-1"), 8), UnitMove::Wait);
        assert_eq!(plan_unit_move(&dot, Some("DP-1"), &panel, Some("HDMI-1"), 8), UnitMove::Wait);
        let tiled = PanelWindow { floating: false, ..panel };
        assert_eq!(plan_unit_move(&dot, Some("DP-1"), &tiled, Some("DP-1"), 8), UnitMove::Wait);
    }

    #[test]
    fn joint_env_matrix_gates_all_niri_work() {
        // Portable: solo Niri nativo con socket ejecuta EventStream/
        // AdjustFixed/ancla/gated; Hyprland/X11/macOS/otros nunca.
        assert!(joint_env_active(false, true, true));
        assert!(!joint_env_active(true, true, true));
        assert!(!joint_env_active(false, false, true));
        assert!(!joint_env_active(false, true, false));
        assert!(!joint_env_active(true, false, false));
        assert!(!joint_env_active(false, false, false));
    }

    #[test]
    fn joint_pass_computes_both_destinations_from_the_anchor() {
        // Traza viva: ancla panel (816,422) DP-1; rosa remapeada al centro
        // exacto 1244 debe imponerse el ancla en la MISMA pasada (2 deltas).
        let anchor = CompactSpot { output: "DP-1".to_owned(), x: 816.0, y: 422.0 };
        let dot = PanelWindow { id: 30, floating: true, size: (72, 72), pos: Some((1244.0, 706.0)), workspace: Some(7) };
        let panel = PanelWindow { id: 85, floating: true, size: (420, 640), pos: Some((816.0, 422.0)), workspace: Some(7) };
        match plan_joint_moves(&anchor, &dot, Some("DP-1"), &panel, Some("DP-1"), 8) {
            JointMove::Settled => {}
            other => panic!("esperaba Settled con la unidad en casa, fue {other:?}"),
        }
        // Desplazados ambos: la misma pasada devuelve AMBOS deltas.
        let dot2 = PanelWindow { pos: Some((1400.0, 700.0)), ..dot };
        let panel2 = PanelWindow { pos: Some((900.0, 500.0)), ..panel };
        match plan_joint_moves(&anchor, &dot2, Some("DP-1"), &panel2, Some("DP-1"), 8) {
            JointMove::Moves { panel, rose } => {
                assert_eq!(panel, Some((85, -84, -78)));
                assert_eq!(rose, Some((30, -156, 6)));
            }
            other => panic!("esperaba ambos deltas, fue {other:?}"),
        }
        // Asentados: nada.
        assert!(matches!(
            plan_joint_moves(&anchor, &dot, Some("DP-1"), &panel, Some("DP-1"), 8),
            JointMove::Settled
        ));
        // Fail-closed: nulls/outputs/tiling esperan.
        let null_dot = PanelWindow { pos: None, ..dot };
        assert!(matches!(plan_joint_moves(&anchor, &null_dot, Some("DP-1"), &panel, Some("DP-1"), 8), JointMove::Wait));
        assert!(matches!(plan_joint_moves(&anchor, &dot, Some("DP-1"), &panel, Some("HDMI-1"), 8), JointMove::Wait));
        let tiled = PanelWindow { floating: false, ..panel };
        assert!(matches!(plan_joint_moves(&anchor, &dot, Some("DP-1"), &tiled, Some("DP-1"), 8), JointMove::Wait));
    }

    #[test]
    fn joint_anchor_follows_only_the_user_mover() {
        // (b): mover chat +180,-90 debe derivar ancla del PANEL, nunca
        // prioridad fija al dot que devuelve el panel a (816,422).
        let dot = PanelWindow { id: 30, floating: true, size: (72, 72), pos: Some((1244.0, 706.0)), workspace: Some(7) };
        let moved_panel = PanelWindow { id: 85, floating: true, size: (420, 640), pos: Some((996.0, 332.0)), workspace: Some(7) };
        let anchor = anchor_from_mover(Mover::Panel, &dot, Some("DP-1"), &moved_panel, Some("DP-1"), 8).unwrap();
        assert_eq!(anchor, CompactSpot { output: "DP-1".to_owned(), x: 996.0, y: 332.0 });
        // Mover rosa deriva el panel implicado (inversa exacta).
        let moved_dot = PanelWindow { pos: Some((1444.0, 786.0)), ..dot };
        let home_panel = PanelWindow { id: 85, floating: true, size: (420, 640), pos: Some((816.0, 422.0)), workspace: Some(7) };
        let anchor2 = anchor_from_mover(Mover::Dot, &moved_dot, Some("DP-1"), &home_panel, Some("DP-1"), 8).unwrap();
        let (ix, iy) = panel_implied_by_rose((1444.0, 786.0), (72, 72), (420, 640), 8);
        assert_eq!((anchor2.x.round() as i32, anchor2.y.round() as i32), (ix, iy));
        // Outputs distintos o nulls: None.
        assert!(anchor_from_mover(Mover::Panel, &dot, Some("DP-1"), &moved_panel, Some("HDMI-1"), 8).is_none());
    }

    #[test]
    fn dot_mover_anchor_roundtrips_to_the_fresh_rose() {
        // Mover-Dot reciente: el ancla es la inversa exacta de la rosa
        // fresca, asi la rosa derivada vuelve a la rosa fresca (delta 0).
        let fresh_rose = (1444.0, 786.0);
        let (ix, iy) = panel_implied_by_rose(fresh_rose, (72, 72), (420, 640), 8);
        assert_eq!((ix, iy), (1016, 502));
        let (rx, ry) = rose_beside_panel_target((ix as f64, iy as f64), (420, 640), (72, 72), 8);
        assert_eq!((rx, ry), (1444, 786));
    }

    #[test]
    fn dot_mover_moves_only_the_panel_to_beside_fresh_rose() {
        // Conductual: mover-Dot reciente -> destino panel = beside(rosa
        // nueva), id movido = solo panel; mover-Panel simetrico intacto.
        let fresh_dot = PanelWindow { id: 30, floating: true, size: (72, 72), pos: Some((1444.0, 786.0)), workspace: Some(7) };
        let stale_panel = PanelWindow { id: 85, floating: true, size: (420, 640), pos: Some((816.0, 422.0)), workspace: Some(7) };
        let anchor = anchor_from_mover(Mover::Dot, &fresh_dot, Some("DP-1"), &stale_panel, Some("DP-1"), 8).unwrap();
        assert_eq!((anchor.x.round() as i32, anchor.y.round() as i32), (1016, 502));
        let joint = plan_joint_moves(&anchor, &fresh_dot, Some("DP-1"), &stale_panel, Some("DP-1"), 8);
        let filtered = joint_moves_for_mover(Some(Mover::Dot), joint);
        assert_eq!(filtered, JointMove::Moves { panel: Some((85, 200, 80)), rose: None });
        // Simetria Panel intacta: solo se mueve la rosa.
        let moved_panel = PanelWindow { pos: Some((996.0, 332.0)), ..stale_panel };
        let home_dot = PanelWindow { pos: Some((1244.0, 706.0)), ..fresh_dot };
        let anchor_p = anchor_from_mover(Mover::Panel, &home_dot, Some("DP-1"), &moved_panel, Some("DP-1"), 8).unwrap();
        let joint_p = plan_joint_moves(&anchor_p, &home_dot, Some("DP-1"), &moved_panel, Some("DP-1"), 8);
        let filtered_p = joint_moves_for_mover(Some(Mover::Panel), joint_p);
        assert!(matches!(filtered_p, JointMove::Moves { panel: None, rose: Some((30, _, _)) }));
        // Sin mover (reopen/unhide/restore): sin filtro.
        assert_eq!(joint_moves_for_mover(None, joint), joint);
    }

    #[test]
    fn fullscreen_exit_returns_to_default_only_on_niri_native() {
        // Genuine Niri-native collapse resets to default; everything else
        // keeps its anchor semantics untouched (portable gate intact).
        assert!(fullscreen_exit_to_default(true, false, false, true, true));
        assert!(!fullscreen_exit_to_default(false, false, false, true, true));
        assert!(!fullscreen_exit_to_default(true, true, false, true, true));
        assert!(!fullscreen_exit_to_default(true, false, true, true, true));
        assert!(!fullscreen_exit_to_default(true, false, false, false, true));
        assert!(!fullscreen_exit_to_default(true, false, false, true, false));
        assert!(!fullscreen_exit_to_default(false, true, false, true, true));
    }

    #[test]
    fn unit_follow_suppress_blocks_own_move_feedback() {
        // Anti-feedback bidir: tras mover un lado, sus ecos se ignoran
        // hasta que pase el quiet; el otro lado sigue armable.
        let now = Instant::now();
        let future = now + FOLLOW_DEBOUNCE + Duration::from_millis(50);
        assert!(suppress_active(now, Some(future)));
        assert!(!suppress_active(future, Some(future)));
        assert!(!suppress_active(now, None));
        assert!(!suppress_active(now, Some(now)));
    }
}
