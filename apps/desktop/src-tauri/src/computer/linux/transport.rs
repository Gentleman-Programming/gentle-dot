//! Bounded Wayland transport (T3a, S1-S4): nonblocking Unix connects, `poll`
//! waits with a total deadline, and a cooperative cancel handle that wakes
//! every wait. Nothing here blocks unboundedly: `Connection::connect_to_env`
//! and `roundtrip` are never called, and the backend itself sends and
//! receives with `MSG_DONTWAIT` (verified in wayland-backend 0.3.17
//! `src/rs/socket.rs`), so WouldBlock is transient and retried within the
//! deadline, never mistaken for a dead connection.
//!
//! `WAYLAND_SOCKET` inheritance is refused ([`connect_inherited_refused`]):
//! duplicating an inherited fd shares one Wayland protocol stream with its
//! owner, so a second `Connection` on the duplicate corrupts both sides'
//! object-id state, and closing the duplicate never cancels the original.
//! Callers pass exclusive ownership of a connected stream to
//! [`connection_from_stream`] instead (single `Connection` per stream).
//! Capability discovery ([`discover`]) binds nothing beyond the registry
//! sweep itself. Fake-peer discovery is covered by tests; a sweep against a
//! real compositor is still untested.

use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::{AsFd, FromRawFd, IntoRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use wayland_client::backend::{ReadEventsGuard, WaylandError};
use wayland_client::protocol::{wl_callback, wl_registry};
use wayland_client::{Connection, Dispatch, QueueHandle};

use super::capabilities::{AdvertisedGlobal, CapabilitySnapshot};

/// How often a wait re-checks its deadline and cancel flag, so cancellation
/// wakes waits promptly without a wakeup fd.
const POLL_SLICE_MS: i32 = 20;

/// What went wrong on the transport. `op` names the step (`connect`,
/// `wait_readable`, `flush`, `discover`) for log truthfulness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError {
    pub kind: TransportKind,
    pub op: &'static str,
    pub detail: String,
}

/// Machine-readable transport failure classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    /// No compositor socket to talk to (missing env, missing path, refused).
    NoCompositor,
    /// The peer went away mid-handshake or mid-sweep.
    Disconnected,
    /// The requested path needs something this slice refuses or has not
    /// built yet (ambient `WAYLAND_SOCKET` adoption, abstract sockets).
    Unsupported,
    /// The total deadline elapsed before the step finished.
    Timeout,
    /// A [`CancelHandle`] fired before the step finished.
    Cancelled,
    /// A local I/O failure that is neither absence nor a hangup.
    Io,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} failed ({:?}): {}", self.op, self.kind, self.detail)
    }
}

impl std::error::Error for TransportError {}

/// Cooperative cancellation: cheap to clone, safe to share across threads.
/// Waits poll in [`POLL_SLICE_MS`] slices, so [`CancelHandle::cancel`] wakes
/// them within one slice instead of waiting out the deadline.
#[derive(Debug, Clone)]
pub struct CancelHandle {
    flag: Arc<AtomicBool>,
}

impl CancelHandle {
    pub fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }
}

impl Default for CancelHandle {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve the compositor socket without touching the environment: an
/// absolute `display` is used as-is, otherwise it is joined onto
/// `runtime_dir`. Both arrive as explicit arguments so tests and callers
/// never depend on ambient process state.
pub fn resolve_socket_path(
    display: Option<&str>,
    runtime_dir: Option<&str>,
) -> Result<PathBuf, TransportError> {
    let display = display.filter(|name| !name.is_empty()).ok_or_else(|| TransportError {
        kind: TransportKind::NoCompositor,
        op: "connect",
        detail: "no Wayland display name was provided (WAYLAND_DISPLAY is unset or empty)"
            .to_owned(),
    })?;
    if Path::new(display).is_absolute() {
        return Ok(PathBuf::from(display));
    }
    let runtime = runtime_dir
        .filter(|dir| !dir.is_empty())
        .ok_or_else(|| TransportError {
            kind: TransportKind::NoCompositor,
            op: "connect",
            detail:
                "relative display without a runtime dir (XDG_RUNTIME_DIR is unset or empty)"
                    .to_owned(),
        })?;
    Ok(Path::new(runtime).join(display))
}

/// Ambient `WAYLAND_SOCKET` adoption is refused: duplicating the inherited
/// fd shares one Wayland protocol stream with its owner, so a second
/// `Connection` on the duplicate corrupts both sides' object-id state, and
/// closing the duplicate never cancels the original. Until a production owner
/// can enforce exclusive single-`Connection` ownership (T5), inherited-only
/// setups fail here with a clear reason instead of silently sharing the
/// stream. Reads no environment state and mutates none; hand exclusive
/// ownership of a connected stream to [`connection_from_stream`] instead.
pub fn connect_inherited_refused() -> Result<UnixStream, TransportError> {
    Err(TransportError {
        kind: TransportKind::Unsupported,
        op: "connect",
        detail: "WAYLAND_SOCKET inheritance is refused: the inherited fd shares one Wayland \
            protocol stream, so adopting it would corrupt both owners; hand exclusive ownership \
            of a connected stream to connection_from_stream instead (single Connection per \
            stream, enforced by the production owner)"
            .to_owned(),
    })
}

/// Nonblocking connect to `path` that returns by `deadline` or when `cancel`
/// fires. A missing/refused socket fails fast instead of hanging.
pub fn connect_bounded(
    path: &Path,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<UnixStream, TransportError> {
    check_wait("connect", deadline, cancel)?;
    let bytes = path.as_os_str().as_bytes();
    if bytes.is_empty() || bytes.len() >= 108 {
        return Err(TransportError {
            kind: TransportKind::NoCompositor,
            op: "connect",
            detail: format!("compositor socket path {} is missing or too long", path.display()),
        });
    }
    if bytes.contains(&0) {
        // A NUL byte can never name a filesystem socket and would silently
        // truncate the address; abstract-namespace sockets are unsupported.
        return Err(TransportError {
            kind: TransportKind::Io,
            op: "connect",
            detail: format!(
                "compositor socket path {} contains a NUL byte",
                path.display()
            ),
        });
    }
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(TransportError {
            kind: TransportKind::Io,
            op: "connect",
            detail: format!("cannot create a Unix socket: {}", std::io::Error::last_os_error()),
        });
    }
    // Owned immediately so every early return closes the fd.
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    let previous_flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if previous_flags < 0 {
        return Err(TransportError {
            kind: TransportKind::Io,
            op: "connect",
            detail: format!("cannot read socket flags: {}", std::io::Error::last_os_error()),
        });
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, previous_flags | libc::O_NONBLOCK) } < 0 {
        return Err(TransportError {
            kind: TransportKind::Io,
            op: "connect",
            detail: format!("cannot set nonblocking mode: {}", std::io::Error::last_os_error()),
        });
    }
    let bytes = path.as_os_str().as_bytes();
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in addr.sun_path.iter_mut().zip(bytes.iter()) {
        *slot = *byte as libc::c_char;
    }
    let addr_len =
        (std::mem::size_of::<libc::sa_family_t>() + bytes.len() + 1) as libc::socklen_t;
    let connected = unsafe {
        libc::connect(
            fd,
            &addr as *const libc::sockaddr_un as *const libc::sockaddr,
            addr_len,
        )
    };
    if connected != 0 {
        let errno = std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or(0);
        if errno != libc::EINPROGRESS {
            return Err(map_connect_errno(path, errno));
        }
        // Handshake in progress: wait for writability, then read SO_ERROR.
        wait_fd(owned.as_fd(), libc::POLLOUT, "connect", deadline, cancel)?;
        let mut failed: i32 = 0;
        let mut failed_len = std::mem::size_of::<i32>() as libc::socklen_t;
        let options_read = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                &mut failed as *mut i32 as *mut libc::c_void,
                &mut failed_len,
            )
        };
        if options_read != 0 {
            return Err(TransportError {
                kind: TransportKind::Io,
                op: "connect",
                detail: format!(
                    "cannot read the connect result: {}",
                    std::io::Error::last_os_error()
                ),
            });
        }
        if failed != 0 {
            return Err(map_connect_errno(
                path,
                failed,
            ));
        }
    }
    // Hand the backend a plain blocking socket; it manages its own flags.
    // A failed restore returns (the `OwnedFd` drop closes the connected
    // socket, so nothing leaks) instead of handing over unknown flags.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, previous_flags & !libc::O_NONBLOCK) } < 0 {
        return Err(TransportError {
            kind: TransportKind::Io,
            op: "connect",
            detail: format!(
                "cannot restore socket flags: {}",
                std::io::Error::last_os_error()
            ),
        });
    }
    let raw = owned.into_raw_fd();
    Ok(unsafe { UnixStream::from_raw_fd(raw) })
}

/// Classify a connect-time errno: absence and refusal mean no compositor,
/// anything else is a local I/O failure.
fn map_connect_errno(path: &Path, errno: i32) -> TransportError {
    let detail = format!(
        "cannot connect to compositor socket {}: {}",
        path.display(),
        std::io::Error::from_raw_os_error(errno)
    );
    let kind = match errno {
        libc::ENOENT | libc::ECONNREFUSED | libc::EACCES | libc::ENOTSOCK => {
            TransportKind::NoCompositor
        }
        _ => TransportKind::Io,
    };
    TransportError {
        kind,
        op: "connect",
        detail,
    }
}

/// Wait until `fd` is readable (or hung up), bounded by `deadline` and
/// `cancel`. A silent peer yields [`TransportKind::Timeout`]; a closed peer
/// yields [`TransportKind::Disconnected`].
pub fn wait_readable<Fd: AsFd>(
    fd: Fd,
    op: &'static str,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<(), TransportError> {
    let revents = wait_fd(fd.as_fd(), libc::POLLIN | libc::POLLERR | libc::POLLHUP, op, deadline, cancel)?;
    // A hangup or error with no data means the peer went away; readable data
    // (even a zero-length read, which surfaces at `read` time) is success.
    let hung_up = revents & (libc::POLLERR | libc::POLLHUP) as i32 != 0;
    let readable = revents & libc::POLLIN as i32 != 0;
    if hung_up && !readable {
        return Err(TransportError {
            kind: TransportKind::Disconnected,
            op,
            detail: "the compositor closed the connection while waiting".to_owned(),
        });
    }
    Ok(())
}

/// Wrap an already-connected stream in a real `wayland_client::Connection`.
/// `Backend::connect` performs no I/O, so this stays bounded. Ownership
/// rule for every Linux operation (`outputs::collect`, `capture::*`,
/// `pointer::*`): each operation consumes its `Connection` and closes it
/// before returning — one connection per operation. A shared borrowed
/// connection would accumulate one `wl_registry` per operation, and
/// `wl_registry` (like `wl_shm` and pre-v3 `wl_output`) has no destructor,
/// so nothing could ever free it; consuming the connection makes that leak
/// unrepresentable, with the fd close as the dead-fd cleanup. `discover`
/// is the only borrower: it binds nothing but the sweep registry, which
/// dies with the consumed connection right after. The consumed connection
/// is never shared across threads for concurrent reads either, because
/// Wayland object ids are per-connection state (see
/// [`connect_inherited_refused`] for why ambient fds are refused instead
/// of duplicated).
pub fn connection_from_stream(stream: UnixStream) -> Result<Connection, TransportError> {
    Connection::from_socket(stream).map_err(|error| TransportError {
        kind: TransportKind::Io,
        op: "connect",
        detail: format!("the Wayland backend rejected the socket: {error}"),
    })
}

/// Connect (inherited fd or socket path) and sweep the registry once with a
/// total deadline, returning negotiated capabilities. Binds nothing beyond
/// the sweep: no input or capture globals are bound or used.
pub fn discover(
    conn: &Connection,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<CapabilitySnapshot, TransportError> {
    use std::sync::atomic::Ordering;
    let mut queue = conn.new_event_queue::<RegistryState>();
    let qh = queue.handle();
    let _registry = conn.display().get_registry(&qh, ());
    // A `wl_display.sync` roundtrip bound: every global advertised before the
    // server answers this callback has been dispatched once it fires, so the
    // sweep is complete without an unbounded roundtrip.
    let done = Arc::new(AtomicBool::new(false));
    let _callback = conn.display().sync(&qh, SyncDone(done.clone()));
    flush_with_retry(conn, "discover", deadline, cancel)?;
    let mut state = RegistryState::default();
    // Shared backend handle: `poll_fd` borrows from it, so it must outlive
    // every wait in the sweep.
    let backend = conn.backend();
    loop {
        check_wait("discover", deadline, cancel)?;
        queue.dispatch_pending(&mut state).map_err(|error| TransportError {
            kind: TransportKind::Disconnected,
            op: "discover",
            detail: format!("cannot dispatch compositor events: {error}"),
        })?;
        if done.load(Ordering::Acquire) {
            break;
        }
        match queue.prepare_read() {
            Some(guard) => {
                wait_readable(backend.poll_fd(), "discover", deadline, cancel)?;
                if !read_ready(guard)? {
                    // Spurious readiness (or a WouldBlock race with another
                    // thread's guard): no data yet, loop back within the
                    // deadline instead of calling it a disconnect.
                    continue;
                }
            }
            // Defensive: the pure-Rust backend always grants a guard (its
            // `try_new` cannot fail), so this only fires on the system
            // backend while another thread owns the read. Yield briefly
            // instead of hot-spinning; the bounds still hold at loop top.
            None => std::thread::sleep(Duration::from_millis(1)),
        }
    }
    Ok(CapabilitySnapshot::negotiate(&state.globals))
}

/// Read one ready batch off the socket: `Ok(true)` means data was read (the
/// caller loops back to dispatch it), `Ok(false)` means a transient
/// WouldBlock with no data (the caller retries within its deadline).
/// Anything else is a dead connection. `ReadEventsGuard::read` documents the
/// WouldBlock case, and the backend sends/receives with `MSG_DONTWAIT`, so
/// neither this nor the flush below ever blocks. `op` names the step for log
/// truthfulness (`discover` keeps the original label; `outputs` names the
/// enumeration sweep).
pub(crate) fn read_ready_op(guard: ReadEventsGuard, op: &'static str) -> Result<bool, TransportError> {
    match guard.read() {
        Ok(_) => Ok(true),
        Err(error) if is_wouldblock(&error) => Ok(false),
        Err(error) => Err(TransportError {
            kind: TransportKind::Disconnected,
            op,
            detail: format!("lost the compositor connection mid-sweep: {error}"),
        }),
    }
}

/// [`read_ready_op`] with the discovery label, so the existing registry sweep
/// keeps its byte-identical errors.
pub(crate) fn read_ready(guard: ReadEventsGuard) -> Result<bool, TransportError> {
    read_ready_op(guard, "discover")
}

/// A backend WouldBlock is transient (a full kernel send buffer, a read
/// race), never fatal: the backend itself does not store it
/// (`store_if_not_wouldblock_and_return_error`). Only WouldBlock retries;
/// every other error is terminal.
fn is_wouldblock(error: &WaylandError) -> bool {
    matches!(error, WaylandError::Io(io) if io.kind() == std::io::ErrorKind::WouldBlock)
}

/// Registry collector for the initial sweep: records advertisements only.
#[derive(Default)]
struct RegistryState {
    globals: Vec<AdvertisedGlobal>,
}

impl Dispatch<wl_registry::WlRegistry, ()> for RegistryState {
    fn event(
        state: &mut Self,
        _registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } => state.globals.push(AdvertisedGlobal {
                name,
                interface,
                version,
            }),
            // A global withdrawn mid-sweep was never usable; drop it so the
            // snapshot never reports a stale capability.
            wl_registry::Event::GlobalRemove { name } => {
                state.globals.retain(|global| global.name != name);
            }
            _ => {}
        }
    }
}

/// Fires the `wl_display.sync` roundtrip bound: one callback, then stop.
struct SyncDone(Arc<AtomicBool>);

impl Dispatch<wl_callback::WlCallback, SyncDone> for RegistryState {
    fn event(
        _state: &mut Self,
        _callback: &wl_callback::WlCallback,
        _event: wl_callback::Event,
        data: &SyncDone,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        // The sweep is complete: the server answers `sync` after replaying
        // every current global, in order.
        data.0.store(true, Ordering::Release);
    }
}

/// Poll `fd` once for `events`, waiting at most `timeout_ms`. Returns the
/// ready revents, 0 on a quiet slice, or -1 when `poll` itself fails.
fn poll_once(fd: std::os::unix::io::BorrowedFd<'_>, events: i16, timeout_ms: i32) -> i32 {
    use std::os::unix::io::AsRawFd;
    let mut waiting = libc::pollfd {
        fd: fd.as_raw_fd(),
        events,
        revents: 0,
    };
    let ready = unsafe { libc::poll(&mut waiting, 1, timeout_ms) };
    if ready < 0 {
        // EINTR just ends this slice early; the waiter re-checks its bound.
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            0
        } else {
            -1
        };
    }
    if ready == 0 {
        0
    } else {
        waiting.revents as i32
    }
}

/// Fail fast when cancellation or the deadline already passed. Shared by the
/// registry sweep and the output enumeration so both honor the same total
/// deadline and cancel handle instead of growing their own waits.
pub(crate) fn check_wait(op: &'static str, deadline: Instant, cancel: &CancelHandle) -> Result<(), TransportError> {
    if cancel.is_cancelled() {
        return Err(TransportError {
            kind: TransportKind::Cancelled,
            op,
            detail: "cancelled before the wait finished".to_owned(),
        });
    }
    if Instant::now() >= deadline {
        return Err(TransportError {
            kind: TransportKind::Timeout,
            op,
            detail: "the total deadline elapsed".to_owned(),
        });
    }
    Ok(())
}

/// Poll `fd` for `events` in short slices so cancel wakes the wait within
/// one slice; the deadline bounds the total.
fn wait_fd(
    fd: std::os::unix::io::BorrowedFd<'_>,
    events: i16,
    op: &'static str,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<i32, TransportError> {
    loop {
        check_wait(op, deadline, cancel)?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        let slice_ms = remaining
            .as_millis()
            .min(POLL_SLICE_MS as u128)
            .min(i32::MAX as u128) as i32;
        let revents = poll_once(fd, events, slice_ms);
        if revents < 0 {
            return Err(TransportError {
                kind: TransportKind::Io,
                op,
                detail: format!("cannot poll the compositor socket: {}", std::io::Error::last_os_error()),
            });
        }
        if revents != 0 {
            return Ok(revents);
        }
    }
}

/// Flush queued Wayland requests without blocking: a WouldBlock (full
/// kernel send buffer) retries within the deadline, anything else is a dead
/// connection. The send path uses `MSG_DONTWAIT`, so this never blocks.
/// Shared by the registry sweep and the output enumeration (`op` names the
/// step for log truthfulness).
pub(crate) fn flush_with_retry(
    conn: &Connection,
    op: &'static str,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<(), TransportError> {
    loop {
        check_wait(op, deadline, cancel)?;
        match conn.flush() {
            Ok(()) => return Ok(()),
            Err(error) if is_wouldblock(&error) => {
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(error) => {
                return Err(TransportError {
                    kind: TransportKind::Disconnected,
                    op,
                    detail: format!("cannot flush requests to the compositor: {error}"),
                });
            }
        }
    }
}
