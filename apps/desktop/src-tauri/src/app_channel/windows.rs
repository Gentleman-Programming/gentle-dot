//! Connected, dedicated Windows channel. No name is returned to the launcher.
//! Tests below require Windows; source presence is not native execution evidence.

use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::ptr::{null, null_mut};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::IO::*;
use windows_sys::Win32::System::Pipes::*;
use windows_sys::Win32::System::Threading::{CreateEventW, GetCurrentProcessId};

const PIPE_SDDL: &str = "D:P(A;;GA;;;OW)";

struct Descriptor(*mut std::ffi::c_void);
impl Descriptor {
    fn owner_only() -> io::Result<Self> {
        let text: Vec<u16> = PIPE_SDDL.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = null_mut();
        // SAFETY: terminated SDDL and writable output; LocalFree owns the resulting allocation.
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor))
    }
}
impl Drop for Descriptor {
    fn drop(&mut self) {
        // SAFETY: allocation returned by the SDDL converter, freed exactly once.
        unsafe { LocalFree(self.0) };
    }
}

/// Kept non-inheritable until the next owned launcher explicitly transfers it.
/// libuv's Windows pipe path uses FILE_FLAG_OVERLAPPED (v1.51.0 src/win/pipe.c,
/// uv__create_stdio_pipe_pair); no synchronous std::fs::File adapter is valid here.
/// Node adoption, CRT fd3 packing and descendant exclusion are NOT implemented by this type.
pub struct ChildEndpoint(OwnedHandle);
#[cfg(test)]
impl ChildEndpoint {
    pub(super) fn into_test_stream(self) -> ChannelStream { ChannelStream::new(self.0) }
}
impl AsRawHandle for ChildEndpoint {
    fn as_raw_handle(&self) -> RawHandle { self.0.as_raw_handle() }
}

struct State {
    handle: Option<OwnedHandle>,
    closed: bool,
    active: usize,
    close_error: Option<i32>,
}
struct Shared {
    state: Mutex<State>,
    drained: Condvar,
    #[cfg(test)]
    cancel_error: std::sync::atomic::AtomicI32,
    #[cfg(test)]
    cancel_barriers: Mutex<Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>>,
}
#[derive(Clone)]
pub struct ChannelStream(Arc<Shared>);
impl ChannelStream {
    fn new(handle: OwnedHandle) -> Self {
        Self(Arc::new(Shared {
            state: Mutex::new(State { handle: Some(handle), closed: false, active: 0, close_error: None }),
            drained: Condvar::new(),
            #[cfg(test)]
            cancel_error: std::sync::atomic::AtomicI32::new(0),
            #[cfg(test)]
            cancel_barriers: Mutex::new(None),
        }))
    }
    pub fn try_clone(&self) -> io::Result<Self> {
        if self.0.state.lock().unwrap_or_else(PoisonError::into_inner).closed {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "channel closed"));
        }
        Ok(self.clone())
    }
    pub(super) fn close_error(&self) -> Option<i32> {
        self.0.state.lock().unwrap_or_else(PoisonError::into_inner).close_error
    }
    #[cfg(test)]
    pub(super) fn inject_cancel_error(&self, code: i32) {
        self.0.cancel_error.store(code, std::sync::atomic::Ordering::SeqCst);
    }
    #[cfg(test)]
    pub(super) fn close_barriers(&self, entered: Arc<std::sync::Barrier>, release: Arc<std::sync::Barrier>) {
        *self.0.cancel_barriers.lock().unwrap() = Some((entered, release));
    }
    #[cfg(test)]
    pub(super) fn active_operations(&self) -> usize {
        self.0.state.lock().unwrap().active
    }
    fn cancel(&self, handle: HANDLE) -> io::Result<()> {
        #[cfg(test)]
        {
            let barriers = self.0.cancel_barriers.lock().unwrap().take();
            if let Some((entered, release)) = barriers {
                entered.wait();
                release.wait();
            }
            let code = self.0.cancel_error.load(std::sync::atomic::Ordering::SeqCst);
            if code != 0 { return Err(io::Error::from_raw_os_error(code)); }
        }
        // SAFETY: caller retains a live owned handle under the initiation mutex.
        if unsafe { CancelIoEx(handle, null()) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NOT_FOUND as i32) { return Err(error); }
        }
        Ok(())
    }
    /// Success means cancellation completions were drained and the sole handle released.
    /// Failure means logically closed ONLY: handle, active buffers and OVERLAPPED operations
    /// remain owned/live. The controller must retain the channel and retry checked shutdown;
    /// failure is not EOF, native closure, or permission to forget the unfinished operations.
    /// No writer mutex is needed to interrupt a blocked write.
    pub fn shutdown(&self) -> io::Result<()> {
        self.shutdown_until(std::time::Instant::now() + std::time::Duration::from_secs(2))
    }
    fn shutdown_until(&self, deadline: std::time::Instant) -> io::Result<()> {
        let mut state = self.0.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.closed = true;
        if let Some(handle) = &state.handle {
            if let Err(error) = self.cancel(handle.as_raw_handle()) {
                state.close_error = Some(error.raw_os_error().unwrap_or(ERROR_GEN_FAILURE as i32));
                return Err(error);
            }
        }
        while state.active != 0 {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                state.close_error = Some(ERROR_TIMEOUT as i32);
                return Err(io::Error::new(io::ErrorKind::TimedOut,
                    "Windows channel cancellation completion deadline elapsed"));
            }
            let (next, _) = self.0.drained.wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
        }
        state.handle.take();
        state.close_error = None;
        Ok(())
    }
    fn transfer(&self, buffer: *mut u8, length: usize, write: bool) -> io::Result<usize> {
        if length == 0 { return Ok(0); }
        // Each operation has its own manual-reset event and OVERLAPPED; neither is moved or
        // freed until GetOverlappedResult observes completion (including cancellation).
        let event = owned(unsafe { CreateEventW(null(), 1, 0, null()) })?;
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event.as_raw_handle();
        let mut state = self.0.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.closed { return Err(io::Error::new(io::ErrorKind::BrokenPipe, "channel closed")); }
        let handle = state.handle.as_ref().expect("open channel handle").as_raw_handle();
        let count = length.min(u32::MAX as usize) as u32;
        // SAFETY: caller retains its buffer until completion; the shared state retains the
        // handle and prevents cancellation from racing initiation.
        let started = unsafe {
            if write { WriteFile(handle, buffer, count, null_mut(), &mut overlapped) }
            else { ReadFile(handle, buffer, count, null_mut(), &mut overlapped) }
        };
        if started == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                return if !write && error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) { Ok(0) } else { Err(error) };
            }
        }
        state.active += 1;
        drop(state);
        let mut transferred = 0;
        // SAFETY: event, OVERLAPPED, buffer and handle remain live through completion.
        let result = if unsafe { GetOverlappedResult(handle, &overlapped, &mut transferred, 1) } != 0 {
            Ok(transferred as usize)
        } else {
            let error = io::Error::last_os_error();
            if !write && error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) { Ok(0) } else { Err(error) }
        };
        let mut state = self.0.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.active -= 1;
        self.0.drained.notify_all();
        result
    }
}
impl Read for ChannelStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> { self.transfer(bytes.as_mut_ptr(), bytes.len(), false) }
}
impl Write for ChannelStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { self.transfer(bytes.as_ptr().cast_mut(), bytes.len(), true) }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
    // SAFETY: fresh native handle; no other owner exists.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

pub fn channel_pair() -> io::Result<(ChannelStream, ChildEndpoint)> {
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| io::Error::other("channel randomness unavailable"))?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    // Internal ephemeral name only: never returned, logged, persisted or passed to a child.
    let name: Vec<u16> = format!(r"\\.\pipe\gentle-dot-{suffix}").encode_utf16().chain(Some(0)).collect();
    pair_named(&name)
}

fn pair_named(name: &[u16]) -> io::Result<(ChannelStream, ChildEndpoint)> {
    let descriptor = Descriptor::owner_only()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    // SAFETY: terminated private name, valid security descriptor. One first-instance local
    // duplex byte pipe; all partial failures release already acquired handles through RAII.
    let server = owned(unsafe { CreateNamedPipeW(name.as_ptr(),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, 65536, 65536, 0, &attributes) })?;
    let client = owned(unsafe { CreateFileW(name.as_ptr(), GENERIC_READ | GENERIC_WRITE,
        0, &attributes, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, null_mut()) })?;
    // CreateFileW has already connected the client. The ConnectNamedPipe API contract
    // explicitly permits connection between CreateNamedPipeW and ConnectNamedPipe (the
    // latter would report ERROR_PIPE_CONNECTED). No accept is necessary here: verify the
    // connected endpoints directly below. Setup initiates no OVERLAPPED operation, so every
    // setup failure has plain handle RAII, no cancellation/wait or stack lifetime escape.
    let mut client_pid = 0;
    let mut server_pid = 0;
    // Query only our pipe endpoints, never open or inspect a process by PID.
    if unsafe { GetNamedPipeClientProcessId(server.as_raw_handle(), &mut client_pid) } == 0
        || unsafe { GetNamedPipeServerProcessId(client.as_raw_handle(), &mut server_pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let controller = unsafe { GetCurrentProcessId() };
    if client_pid != controller || server_pid != controller {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "channel ownership mismatch"));
    }
    // Both endpoints are already connected; max instances = 1 leaves no accepting instance.
    Ok((ChannelStream::new(server), ChildEndpoint(client)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};

    #[test]
    fn endpoints_are_owned_non_inheritable_and_child_is_overlapped() {
        let (mut parent, child) = channel_pair().unwrap();
        fn owned(_: &ChildEndpoint) {}
        owned(&child);
        let mut flags = 0;
        assert_ne!(unsafe { GetHandleInformation(child.as_raw_handle(), &mut flags) }, 0);
        assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
        let state = parent.0.state.lock().unwrap();
        assert_ne!(unsafe { GetHandleInformation(state.handle.as_ref().unwrap().as_raw_handle(), &mut flags) }, 0);
        assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
        drop(state);
        // Exercise the native child with the same explicit OVERLAPPED semantics as the parent.
        let mut child = ChannelStream::new(child.0);
        parent.write_all(b"{\"kind\":\"response\",\"id\":1}\n").unwrap();
        let mut bytes = [0; 27];
        child.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"{\"kind\":\"response\",\"id\":1}\n");
        parent.shutdown().unwrap();
        assert_eq!(child.read(&mut bytes).unwrap(), 0);
    }

    #[test]
    fn close_cancels_pending_read_and_releases_writer_clones() {
        let (parent, child) = channel_pair().unwrap();
        let mut reader = parent.try_clone().unwrap();
        let retained_writer = parent.try_clone().unwrap();
        let (tx, rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let mut byte = [0];
            tx.send(reader.read(&mut byte)).unwrap();
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while parent.0.state.lock().unwrap().active == 0 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(parent.0.state.lock().unwrap().active, 1, "read must be pending before cancellation");
        parent.shutdown().unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap().is_err());
        thread.join().unwrap();
        let mut peer = ChannelStream::new(child.0);
        assert_eq!(peer.read(&mut [0]).unwrap(), 0);
        assert!(retained_writer.try_clone().is_err());
    }

    #[test]
    fn close_deadline_retains_handle_until_checked_retry() {
        let (parent, child) = channel_pair().unwrap();
        let mut reader = parent.try_clone().unwrap();
        let thread = std::thread::spawn(move || reader.read(&mut [0]));
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while parent.active_operations() == 0 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(parent.active_operations(), 1);
        // Holding the initiation lock makes a zero-budget drain deterministic even if
        // the kernel has already completed cancellation: the reader has not retired yet.
        let error = parent.shutdown_until(std::time::Instant::now()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(parent.close_error(), Some(ERROR_TIMEOUT as i32));
        assert!(parent.0.state.lock().unwrap().handle.is_some());
        assert!(parent.try_clone().is_err());
        parent.shutdown().unwrap();
        assert!(thread.join().unwrap().is_err());
        assert_eq!(parent.active_operations(), 0);
        assert!(parent.0.state.lock().unwrap().handle.is_none());
        assert_eq!(parent.close_error(), None);
        drop(child);
    }

    #[test]
    fn creation_failure_returns_no_endpoints() {
        assert!(pair_named(&[0]).is_err());
    }

    #[test]
    fn first_instance_collision_fails_without_replacing_connected_pair() {
        let mut random = [0; 32];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let name: Vec<u16> = format!(r"\\.\pipe\gentle-dot-test-{suffix}").encode_utf16().chain(Some(0)).collect();
        let (parent, child) = pair_named(&name).unwrap();
        assert!(pair_named(&name).is_err());
        parent.shutdown().unwrap();
        drop(child);
    }

    #[test]
    fn acl_is_explicit_protected_owner_only() {
        assert_eq!(PIPE_SDDL, "D:P(A;;GA;;;OW)");
        let _descriptor = Descriptor::owner_only().unwrap();
    }
}
