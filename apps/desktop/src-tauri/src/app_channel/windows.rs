//! The Windows transport for the app's private channel: a named pipe whose credential is the
//! connecting process's PID matched against the daemon this app spawned (S25.1, W7b).
//!
//! The primitives are adapted from the credited draft `Row0902/gentle-dot#2`
//! (`isolated_bootstrap_windows.rs`, `app_channel_windows.rs`): a single-instance endpoint that is
//! non-inheritable from creation, per-direction `OVERLAPPED` events with a dedicated reader/writer
//! pair, and `CancelIoEx` cancellation that serializes with submission under a mutex and never
//! blocks the canceling thread. Unlike the draft, the pipe is created with default security
//! attributes (the handle is non-inheritable), and the credential is the accepted connection's PID
//! checked against the retained child. The pipe's name is not a secret; a same-user process may
//! find it in `\\.\pipe\` and connect, only to be refused and disconnected.

use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT, ERROR_BROKEN_PIPE,
    ERROR_IO_PENDING, ERROR_NOT_FOUND, ERROR_OPERATION_ABORTED, ERROR_PIPE_CONNECTED,
};
use windows_sys::Win32::Storage::FileSystem::{
    ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

/// The pipe lives in the `\\.\pipe\` namespace; the suffix is 16 random bytes as 32 lowercase hex.
const PREFIX: &str = r"\\.\pipe\gentle-dot-";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn random_name() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    let suffix: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{PREFIX}{suffix}"))
}

fn checked(value: i32) -> io::Result<()> {
    if value == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "the assistant did not connect to the channel in time")
}

/// The app's single-instance named pipe, created before the daemon is spawned so no other process
/// can take the name. It is non-inheritable from creation (default security attributes).
pub struct ServerEndpoint {
    handle: OwnedHandle,
    name: String,
}

impl ServerEndpoint {
    /// Creates a fresh endpoint with a random name.
    pub fn create() -> io::Result<Self> {
        let name = random_name()?;
        let name_wide = wide(&name);
        // SAFETY: `name_wide` is a NUL-terminated UTF-16 buffer alive through the call. A null
        // `lpSecurityAttributes` gives the handle the creator's default (non-inheritable) security.
        let handle = unsafe {
            CreateNamedPipeW(
                name_wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                4096,
                4096,
                0,
                ptr::null(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `handle` is a fresh, non-null pipe handle this structure now owns.
        Ok(Self { handle: unsafe { OwnedHandle::from_raw_handle(handle) }, name })
    }

    /// The full `\\.\pipe\…` name, handed to the daemon in `GENTLE_DOT_CHANNEL_PIPE`.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Accepts the one connection whose client PID is `pid`, while `alive()` reports the child still
    /// runs and before `deadline`. Any other connection (for example a same-user process that
    /// guessed the name) is disconnected and refused; the endpoint then waits again.
    pub fn accept(
        self,
        pid: u32,
        alive: impl Fn() -> bool + Send + 'static,
        deadline: Instant,
    ) -> io::Result<Connected> {
        let mut handle = self.handle;
        loop {
            if !alive() {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "the assistant exited before it connected to the channel",
                ));
            }
            if Instant::now() >= deadline {
                return Err(timed_out());
            }
            connect(&handle, deadline, &alive)?;
            let mut client_pid = 0u32;
            // SAFETY: `handle` is a connected server pipe handle and the out-pointer is valid.
            if unsafe { GetNamedPipeClientProcessId(handle.as_raw_handle(), &mut client_pid) } == 0 {
                return Err(io::Error::last_os_error());
            }
            if client_pid == pid {
                return Connected::new(handle);
            }
            // Retain a duplicate for the next accept, then disconnect the rejected instance. Both
            // handles name the same instance, so the next `ConnectNamedPipe` reuses it.
            let next = handle.try_clone()?;
            // SAFETY: `handle` owns a connected server pipe instance; the clone stays open.
            unsafe { DisconnectNamedPipe(handle.as_raw_handle()) };
            handle = next;
        }
    }
}

/// Waits for one client to connect. The `OVERLAPPED` and its event stay alive until
/// `GetOverlappedResult` reports settlement, even after a cancellation.
fn connect(
    handle: &OwnedHandle,
    deadline: Instant,
    alive: &(impl Fn() -> bool + Send + 'static),
) -> io::Result<()> {
    // SAFETY: an unnamed, manual-reset event.
    let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `event` is a fresh event handle this scope now owns.
    let event = unsafe { OwnedHandle::from_raw_handle(event) };
    let mut operation: OVERLAPPED = unsafe { std::mem::zeroed() };
    operation.hEvent = event.as_raw_handle();
    let raw = handle.as_raw_handle();
    // SAFETY: `raw` is a server pipe handle and `operation` is a valid OVERLAPPED alive here.
    let started = unsafe { ConnectNamedPipe(raw, &mut operation) };
    if started != 0 {
        return Ok(());
    }
    // SAFETY: reads this thread's last-error code.
    match unsafe { GetLastError() } {
        ERROR_PIPE_CONNECTED => return Ok(()),
        ERROR_IO_PENDING => {}
        _ => return Err(io::Error::last_os_error()),
    }
    loop {
        if !alive() {
            cancel(raw, &operation);
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "the assistant exited before it connected to the channel",
            ));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            cancel(raw, &operation);
            return Err(timed_out());
        }
        let millis = remaining.min(Duration::from_millis(10)).as_millis().max(1) as u32;
        // SAFETY: waiting on an event handle this scope owns, bounded by `millis`.
        match unsafe { WaitForSingleObject(event.as_raw_handle(), millis) } {
            WAIT_OBJECT_0 => {
                let mut transferred = 0u32;
                // SAFETY: the operation settled; `operation` is still valid.
                checked(unsafe { GetOverlappedResult(raw, &operation, &mut transferred, 1) })?;
                return Ok(());
            }
            WAIT_TIMEOUT => {}
            _ => {
                let error = io::Error::last_os_error();
                cancel(raw, &operation);
                return Err(error);
            }
        }
    }
}

/// Requests cancellation of an in-flight `ConnectNamedPipe` and waits for it to settle, so the
/// stack `OVERLAPPED` and its event outlive the operation.
fn cancel(handle: HANDLE, operation: &OVERLAPPED) {
    // SAFETY: requesting cancellation of this thread's overlapped I/O on `handle`.
    unsafe { CancelIoEx(handle, operation) };
    let mut transferred = 0u32;
    // SAFETY: `operation` is still a valid, live OVERLAPPED on this stack.
    unsafe { GetOverlappedResult(handle, operation, &mut transferred, 1) };
}

/// An accepted, PID-verified pipe connection split into independently signaled I/O halves.
pub struct Connected {
    pub(crate) reader: PipeReader,
    pub(crate) writer: PipeWriter,
    pub(crate) read_cancel: PipeCancellation,
    pub(crate) write_cancel: PipeCancellation,
}

impl Connected {
    fn new(handle: OwnedHandle) -> io::Result<Self> {
        let reader_event = direction_event()?;
        let writer_event = direction_event()?;
        let pipe = Arc::new(handle);
        let reader = PipeReader(PipeDirection { pipe: pipe.clone(), event: reader_event, state: Default::default() });
        let writer = PipeWriter(PipeDirection { pipe, event: writer_event, state: Default::default() });
        let read_cancel = reader.cancellation();
        let write_cancel = writer.cancellation();
        Ok(Self { reader, writer, read_cancel, write_cancel })
    }
}

fn direction_event() -> io::Result<OwnedHandle> {
    // SAFETY: an unnamed, manual-reset event.
    let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `event` is a fresh event handle this scope now owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(event) })
}

#[derive(Debug, Default)]
struct TransferState {
    revoked: bool,
    // Address of the boxed OVERLAPPED, valid only while protected by this mutex.
    active: Option<usize>,
}

/// Cancels a direction. The `pipe` and `state` are shared with the direction that registered the
/// in-flight operation, so `cancel` reaches exactly that operation.
#[derive(Debug, Clone)]
pub(crate) struct PipeCancellation {
    pipe: Arc<OwnedHandle>,
    state: Arc<Mutex<TransferState>>,
}

impl PipeCancellation {
    /// Permanently revokes this direction without waiting for I/O settlement.
    pub(crate) fn cancel(&self) -> io::Result<()> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.revoked = true;
        if let Some(address) = state.active {
            // The worker registers, submits and unregisters under this same mutex, so it retains
            // the operation, buffer and event through actual completion.
            // SAFETY: `address` is the OVERLAPPED the worker registered under this mutex.
            let result =
                unsafe { CancelIoEx(self.pipe.as_raw_handle(), address as *const OVERLAPPED) };
            if result == 0 {
                let error = io::Error::last_os_error();
                // Completion may have won the cancellation race.
                if error.raw_os_error() != Some(ERROR_NOT_FOUND as i32) {
                    return Err(error);
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
struct PipeDirection {
    pipe: Arc<OwnedHandle>,
    event: OwnedHandle,
    state: Arc<Mutex<TransferState>>,
}

impl PipeDirection {
    fn transfer(&mut self, buffer: *mut u8, length: usize, read: bool) -> io::Result<usize> {
        if length == 0 {
            return Ok(0);
        }
        let mut operation: Box<OVERLAPPED> = Box::new(unsafe { std::mem::zeroed() });
        operation.hEvent = self.event.as_raw_handle();
        let raw = self.pipe.as_raw_handle();
        let length = length.min(u32::MAX as usize) as u32;
        // Serialize revocation with registration AND submission. Cancellation cannot miss a
        // just-submitted operation or permit I/O after revocation.
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.revoked {
            return Err(io::Error::from_raw_os_error(ERROR_OPERATION_ABORTED as i32));
        }
        state.active = Some((&mut *operation as *mut OVERLAPPED) as usize);
        // SAFETY: `raw` is a pipe handle and `operation`/`buffer` stay alive through settlement.
        let started = unsafe {
            if read {
                ReadFile(raw, buffer, length, ptr::null_mut(), &mut *operation)
            } else {
                WriteFile(raw, buffer, length, ptr::null_mut(), &mut *operation)
            }
        };
        if started == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                state.active = None;
                if read && error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                    return Ok(0);
                }
                return Err(error);
            }
        }
        drop(state);
        // CancelIoEx merely requests cancellation. Keep all I/O storage alive until this wait
        // settles, then unregister before destroying the box.
        let mut transferred = 0u32;
        // SAFETY: `operation` is a valid, live OVERLAPPED and `raw` owns the operation.
        let completed = unsafe { GetOverlappedResult(raw, &*operation, &mut transferred, 1) };
        let error = (completed == 0).then(io::Error::last_os_error);
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .active = None;
        if let Some(error) = error {
            if read && error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                return Ok(0);
            }
            return Err(error);
        }
        Ok(transferred as usize)
    }
}

/// The read half of an accepted connection.
#[derive(Debug)]
pub(crate) struct PipeReader(PipeDirection);

impl PipeReader {
    fn cancellation(&self) -> PipeCancellation {
        PipeCancellation { pipe: self.0.pipe.clone(), state: self.0.state.clone() }
    }
}

impl Read for PipeReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.transfer(buffer.as_mut_ptr(), buffer.len(), true)
    }
}

/// The write half of an accepted connection. `write` returns a short count and `write_all` iterates.
#[derive(Debug)]
pub(crate) struct PipeWriter(PipeDirection);

impl PipeWriter {
    fn cancellation(&self) -> PipeCancellation {
        PipeCancellation { pipe: self.0.pipe.clone(), state: self.0.state.clone() }
    }
}

impl Write for PipeWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.transfer(buffer.as_ptr().cast_mut(), buffer.len(), false)
    }

    fn flush(&mut self) -> io::Result<()> {
        // Writes wait for completion; no userspace buffering remains to flush.
        Ok(())
    }
}
