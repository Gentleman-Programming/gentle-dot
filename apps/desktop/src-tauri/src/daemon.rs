//! Spawns the daemon, and stops what it spawned. A daemon it spawns gets its end of the app's
//! private channel on fd 3 (S25.1, `app_channel`) and stops by itself when that channel closes, so it
//! lives as long as this app, crashes included (S35.2).
//!
//! An app with a channel never attaches to a daemon it did not launch: that daemon has no channel,
//! so connectors would stay locked with no way out. When a healthy daemon holds the port at start,
//! the app stops it only if it can prove it launched it (`<data>/daemon.pid`, written at every spawn,
//! names the pid and the process start time); otherwise it refuses with
//! [`foreign_daemon_message`], which names the exit. An app without a channel attaches as before.

// Windows native launch adapter; Node channel adoption/exclusion remains separately guarded.
#[cfg(any(windows, test))]
mod windows_record;

mod launch;
pub use launch::*;
#[cfg(any(windows, test))]
mod windows;

pub use crate::app_channel::APP_FD;
use crate::app_channel::{AppChannel, Handler};
use crate::health::check_health;
#[cfg(unix)]
use std::fs;
use std::fs::File;
#[cfg(unix)]
use std::fs::OpenOptions;
use std::io;
#[cfg(unix)]
use std::os::fd::{BorrowedFd, FromRawFd, OwnedFd};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const HEALTH_TIMEOUT: Duration = Duration::from_millis(300);
const STOP_GRACE: Duration = Duration::from_secs(5);
/// The daemon stops its engine and memory first; a recorded orphan gets longer than a child.
const ORPHAN_GRACE: Duration = Duration::from_secs(10);
/// How long the port may take to be free after a recorded orphan stopped.
const PORT_RELEASE: Duration = Duration::from_secs(5);
/// Why the app neither starts nor uses the assistant: one it did not launch holds the port.
pub fn foreign_daemon_message(port: u16) -> String {
    format!(
        "Another Gentle Dot assistant is already running on port {port}, and this app did not start it \
(for example `pnpm dev`, or one left running by an older version of the app). Gentle Dot only uses an \
assistant it started itself, so connectors stay safe. Stop the other one (press Ctrl+C where `pnpm dev` \
runs, or quit the process listening on port {port}), then choose \"Restart assistant\" in the Gentle Dot menu."
    )
}

/// A daemon this app launched, as the pid file records it.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Launched {
    pub pid: u32,
    /// When the process started, in the platform's own units; tells it from a later process with the same pid.
    pub started: u64,
}

/// When `pid` started, while it is a live process (not a zombie); `None` once it is gone.
#[cfg(target_os = "macos")]
pub fn process_started(pid: u32) -> Option<u64> {
    let pid = libc::c_int::try_from(pid).ok()?;
    // SAFETY: an all-zero proc_bsdinfo is valid, and proc_pidinfo writes at most its size.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    // SAFETY: the buffer is a proc_bsdinfo of `size` bytes, as PROC_PIDTBSDINFO expects.
    let written = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    if written != size || info.pbi_status == libc::SZOMB {
        return None;
    }
    Some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

/// When `pid` started (clock ticks after boot, `/proc/<pid>/stat`), while it is live; `None` once gone.
#[cfg(target_os = "linux")]
pub fn process_started(pid: u32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The name may hold spaces and parentheses; the fields after it do not.
    let fields: Vec<&str> = stat.get(stat.rfind(')')? + 1..)?.split_whitespace().collect();
    if fields.first() == Some(&"Z") {
        return None;
    }
    fields.get(19)?.parse().ok()
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
pub fn process_started(_pid: u32) -> Option<u64> {
    None
}

/// Records the daemon just spawned as `pid` (private, 0600). A new file in the same folder renamed
/// over the pid file: never written through a symlink there, and never seen half written.
#[cfg(unix)]
pub fn record_launch(data_dir: &Path, pid: u32) -> io::Result<()> {
    let started = process_started(pid).ok_or_else(|| io::Error::other("the assistant is not running"))?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let temp = data_dir.join(format!(".{PID_FILE}.{}.{nanos}", std::process::id()));
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temp)
        .and_then(|mut file| {
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
            use std::io::Write;
            writeln!(file, "{pid} {started}")
        })
        .and_then(|()| fs::rename(&temp, data_dir.join(PID_FILE)));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

/// A pid file holds `<pid> <start time>`, far below this.
#[cfg(unix)]
const PID_FILE_MAX: u64 = 64;

/// Whether a pid read from the pid file may name a daemon to signal: never this app, its parent,
/// init, or the kernel.
#[cfg(unix)]
fn may_be_daemon(pid: u32) -> bool {
    // SAFETY: getppid(2) has no preconditions.
    let parent = u32::try_from(unsafe { libc::getppid() }).ok();
    pid > 1 && pid != std::process::id() && Some(pid) != parent
}

/// The daemon the pid file names, if it holds a launch. Only a small regular file is read: a
/// symlink, a FIFO, or anything else there is ignored (opened without following or blocking).
#[cfg(unix)]
pub fn recorded_launch(data_dir: &Path) -> Option<Launched> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(data_dir.join(PID_FILE))
        .ok()?;
    let meta = file.metadata().ok()?;
    if !meta.file_type().is_file() || meta.len() > PID_FILE_MAX {
        return None;
    }
    let mut text = String::new();
    io::Read::read_to_string(&mut io::Read::take(file, PID_FILE_MAX), &mut text).ok()?;
    let mut parts = text.split_whitespace();
    let launched = Launched { pid: parts.next()?.parse().ok()?, started: parts.next()?.parse().ok()? };
    (parts.next().is_none() && may_be_daemon(launched.pid)).then_some(launched)
}

/// The recorded daemon, while that same process still runs (a reused pid has another start time).
#[cfg(unix)]
pub fn live_orphan(data_dir: &Path) -> Option<Launched> {
    recorded_launch(data_dir).filter(|launch| process_started(launch.pid) == Some(launch.started))
}

/// Removes the pid file when it names `pid`.
#[cfg(unix)]
fn forget_launch(data_dir: &Path, pid: u32) {
    if recorded_launch(data_dir).is_some_and(|launch| launch.pid == pid) {
        let _ = fs::remove_file(data_dir.join(PID_FILE));
    }
}

/// SIGTERM to a recorded daemon that is not this app's child, then SIGKILL after `grace`.
/// Only the process the record names: a pid now used by another process is left alone.
#[cfg(unix)]
fn stop_orphan(launch: Launched, grace: Duration) {
    let Ok(pid) = libc::pid_t::try_from(launch.pid) else {
        return;
    };
    if !may_be_daemon(launch.pid) {
        return;
    }
    let same = || process_started(launch.pid) == Some(launch.started);
    for (signal, wait) in [(libc::SIGTERM, grace), (libc::SIGKILL, Duration::from_secs(2))] {
        if !same() {
            return;
        }
        // SAFETY: plain kill(2) on the process the record names, checked just above.
        unsafe { libc::kill(pid, signal) };
        let deadline = Instant::now() + wait;
        while same() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
    }
}

/// What [`Daemon::ensure_running`] does, from what it finds.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartPlan {
    /// Use the daemon that answers (an app without a channel loses nothing by attaching).
    Attach,
    /// Start a daemon, or wait for the one this app already started.
    Spawn,
    /// Stop the daemon an earlier app launched (the pid file proves it), then start one.
    ReplaceOrphan,
    /// A daemon this app cannot account for holds the port: neither attach nor stop it.
    Refuse,
}

#[cfg(unix)]
pub fn start_plan(healthy: bool, owns_child: bool, wants_channel: bool, orphan: bool) -> StartPlan {
    if !wants_channel {
        return if healthy { StartPlan::Attach } else { StartPlan::Spawn };
    }
    if owns_child {
        StartPlan::Spawn
    } else if orphan {
        StartPlan::ReplaceOrphan
    } else if healthy {
        StartPlan::Refuse
    } else {
        StartPlan::Spawn
    }
}

#[cfg(windows)]
pub fn open_private_log(data_dir: &Path) -> io::Result<File> {
    windows::open_private_log(data_dir)
}

/// Opens `<data_dir>/daemon.log` for appending. The folder is 0700 and the log
/// 0600 (looser modes are repaired) because the daemon's output is private.
#[cfg(unix)]
pub fn open_private_log(data_dir: &Path) -> io::Result<File> {
    fs::DirBuilder::new().recursive(true).mode(0o700).create(data_dir)?;
    fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))?;
    let log = OpenOptions::new().create(true).append(true).mode(0o600).open(data_dir.join("daemon.log"))?;
    log.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(log)
}

#[cfg(windows)]
pub fn channel_pair() -> io::Result<(crate::app_channel::ChannelStream, ChildEndpoint)> {
    crate::app_channel::windows::channel_pair()
}

/// A connected pair of Unix sockets: the app's end, and the daemon's, numbered above [`APP_FD`] so
/// placing it on fd 3 in the child never collides with it. Both are close-on-exec here.
#[cfg(unix)]
pub fn channel_pair() -> io::Result<(UnixStream, OwnedFd)> {
    let (app, daemon) = UnixStream::pair()?;
    let daemon = OwnedFd::from(daemon);
    use std::os::fd::AsRawFd;
    if daemon.as_raw_fd() > APP_FD {
        return Ok((app, daemon));
    }
    // SAFETY: duplicating a descriptor we own; the copy is owned by the returned OwnedFd.
    let copy = unsafe { libc::fcntl(daemon.as_raw_fd(), libc::F_DUPFD_CLOEXEC, APP_FD + 1) };
    if copy == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `copy` is a fresh descriptor nobody else owns.
    Ok((app, unsafe { OwnedFd::from_raw_fd(copy) }))
}

/// Starts the daemon with stdin from `/dev/null`, its output in `log`, and `channel` (from
/// [`channel_pair`]) on fd 3. On macOS the app disclaims responsibility for it, so it never
/// inherits the app's TCC grants (S24.1).
#[cfg(target_os = "macos")]
fn spawn_daemon(spec: &LaunchSpec, log: File, channel: Option<BorrowedFd<'_>>) -> io::Result<Box<dyn ChildProcess>> {
    let child = crate::disclaimed::spawn_disclaimed(&spec.program, &spec.args, &spec.envs, &log, channel)?;
    Ok(Box::new(child))
}

/// As on macOS, the daemon gets stdio and `channel` on fd 3 and no other descriptor of the app:
/// everything from fd 3 up (fd 4 up with a channel) is marked close-on-exec in the child, so a
/// descriptor some library of the app opened without close-on-exec never reaches the daemon. Node
/// then marks fd 3 close-on-exec at its own startup (libuv's `uv_disable_stdio_inheritance`), so
/// the daemon's children never get it either (`app-channel.ts` `childInherits` checks that).
#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_daemon(spec: &LaunchSpec, log: File, channel: Option<BorrowedFd<'_>>) -> io::Result<Box<dyn ChildProcess>> {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .envs(spec.envs.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    let channel = channel.map(|fd| fd.as_raw_fd());
    // SAFETY: runs in the child between fork and exec and only makes system calls (dup2, fcntl,
    // close_range, getrlimit), which are async-signal-safe; nothing allocates. `fd` is above
    // APP_FD (channel_pair), so dup2 makes a new fd 3 without close-on-exec, while the original
    // closes at exec.
    unsafe {
        command.pre_exec(move || {
            if let Some(fd) = channel {
                if libc::dup2(fd, APP_FD) == -1 {
                    return Err(io::Error::last_os_error());
                }
            }
            let first = if channel.is_some() { APP_FD + 1 } else { APP_FD };
            cloexec_from(first);
            Ok(())
        });
    }
    Ok(Box::new(command.spawn()?))
}

#[cfg(windows)]
fn spawn_daemon(spec: &LaunchSpec, log: File, channel: Option<&ChildEndpoint>, data_dir: &Path) -> Result<windows::WindowsChild, windows::SpawnFailure> {
    let channel = channel.ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported,
        "Windows channel-less launch awaits its equivalent graceful-stop adapter"))?;
    windows::spawn(spec, log, channel, data_dir)
}

/// Checked Windows owned shutdown; keep the dedicated channel open until this succeeds.
#[cfg(windows)]
pub fn stop_child(child: &mut dyn ChildProcess, grace: Duration) -> io::Result<()> {
    child.shutdown_owned(grace)
}

/// Marks every descriptor from `first` up close-on-exec. Called between fork and exec: system
/// calls only.
#[cfg(all(unix, not(target_os = "macos")))]
fn cloexec_from(first: libc::c_int) {
    #[cfg(target_os = "linux")]
    if let Ok(low) = libc::c_uint::try_from(first) {
        // SAFETY: close_range(2) with CLOSE_RANGE_CLOEXEC (Linux 5.11) only changes descriptor flags.
        if unsafe { libc::syscall(libc::SYS_close_range, low, libc::c_uint::MAX, libc::CLOSE_RANGE_CLOEXEC) } == 0 {
            return;
        }
    }
    // An older kernel: every descriptor up to the limit, one by one.
    // SAFETY: an all-zero rlimit is valid, and getrlimit writes only into it.
    let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
    // SAFETY: a valid out-pointer.
    let top = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == 0 {
        libc::c_int::try_from(limit.rlim_cur.min(1 << 20)).unwrap_or(1 << 20)
    } else {
        1 << 16
    };
    for fd in first..top {
        // SAFETY: F_SETFD on a descriptor number; one that is not open fails with EBADF, harmlessly.
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
}

/// Sends SIGTERM, waits up to `grace` for a clean exit, then kills.
#[cfg(unix)]
pub fn stop_child(child: &mut dyn ChildProcess, grace: Duration) {
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    let Ok(pid) = libc::pid_t::try_from(child.id()) else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };
    // SAFETY: `pid` belongs to a child we have not reaped yet, so it cannot be reused.
    unsafe { libc::kill(pid, libc::SIGTERM) };
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Debug, PartialEq, Eq)]
pub enum RestartOutcome {
    Restarted,
    /// The daemon answers but was not started by this app.
    External,
    Failed(String),
}

#[cfg(windows)]
struct WindowsRecovery {
    owner: windows::RecoveredLaunch,
    // First failure is latched: never reconnect/re-send or reacquire this launch.
    failure: Option<String>,
}

pub struct Daemon {
    port: u16,
    data_dir: PathBuf,
    runtime_dir: Option<PathBuf>,
    child: Mutex<Option<Box<dyn ChildProcess>>>,
    /// Every access is serialized by child first, including partial recovery owners.
    #[cfg(windows)]
    recovered: Mutex<Option<WindowsRecovery>>,
    /// The private channel to the daemon this app spawned; attached daemons have none.
    channel: Mutex<Option<Arc<AppChannel>>>,
    /// Serves the daemon's requests; without it no channel is made.
    handler: Option<Arc<dyn Handler>>,
    /// Why the last start neither started nor attached ([`foreign_daemon_message`]).
    refused: Mutex<Option<String>>,
    /// Told each time a start leaves a daemon the app may use answering.
    ready: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Replaces [`launch_spec`] (tests).
    launch: Option<LaunchSpec>,
    /// Replaces the `/health` probe (tests).
    #[cfg(test)]
    health: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl Daemon {
    pub fn new(port: u16, data_dir: PathBuf, runtime_dir: Option<PathBuf>) -> Self {
        Self {
            port,
            data_dir,
            runtime_dir,
            child: Mutex::new(None),
            #[cfg(windows)]
            recovered: Mutex::new(None),
            channel: Mutex::new(None),
            handler: None,
            refused: Mutex::new(None),
            ready: None,
            launch: None,
            #[cfg(test)]
            health: None,
        }
    }

    /// Every daemon this app spawns gets a channel served by `handler`.
    pub fn with_channel(mut self, handler: Arc<dyn Handler>) -> Self {
        self.handler = Some(handler);
        self
    }

    /// `ready` runs each time a start (at launch or from Restart assistant) leaves a daemon the app
    /// may use answering, so a window that was refused can connect without a reopen.
    pub fn on_ready(mut self, ready: Arc<dyn Fn() + Send + Sync>) -> Self {
        self.ready = Some(ready);
        self
    }

    #[cfg(all(test, unix))]
    fn with_launch(mut self, spec: LaunchSpec) -> Self {
        self.launch = Some(spec);
        self
    }

    #[cfg(all(test, unix))]
    fn with_health(mut self, health: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        self.health = Some(health);
        self
    }

    /// The channel to the daemon, only while one this app spawned runs and the channel is open.
    pub fn channel(&self) -> Option<Arc<AppChannel>> {
        if !self.owns_running() {
            return None;
        }
        self.channel.lock().unwrap().clone().filter(|channel| channel.is_open())
    }

    pub fn is_healthy(&self) -> bool {
        #[cfg(test)]
        if let Some(health) = &self.health {
            return health();
        }
        check_health(self.port, HEALTH_TIMEOUT)
    }

    /// Why the last start refused the daemon on the port, if it did.
    pub fn refusal(&self) -> Option<String> {
        self.refused.lock().unwrap().clone()
    }

    /// Waits until the daemon the app may use answers: one it launched when it wants a channel, any
    /// otherwise. Fails at once with the refusal when the port is held by a daemon it did not launch.
    pub fn wait_ready(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(reason) = self.refusal() {
                return Err(reason);
            }
            if (self.handler.is_none() || self.owns_running()) && self.is_healthy() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!("the assistant did not answer on port {} (see daemon.log)", self.port));
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    /// Polls `/health` until it answers or `timeout` elapses.
    pub fn wait_healthy(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.is_healthy() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    /// Spawns the daemon, or waits for the one this app spawned; see [`start_plan`] for a daemon
    /// already on the port. Tells [`Daemon::on_ready`] once it answers. Blocking: call off the main thread.
    pub fn ensure_running(&self, timeout: Duration) -> Result<(), String> {
        self.start(timeout)?;
        if let Some(ready) = &self.ready {
            ready();
        }
        Ok(())
    }

    #[cfg(windows)]
    fn windows_child_admission(&self, child: &Option<Box<dyn ChildProcess>>) -> Result<(), String> {
        if child.as_ref().is_some_and(|child| child.launch_failed()) {
            let mut refused = self.refused.lock().unwrap();
            // Keep the original startup and cleanup errors for this retained owner. A later
            // admission refusal must not erase the evidence explaining why it is retained.
            let reason = refused.get_or_insert_with(||
                "a failed Windows launch retains unfinished owned cleanup; stop must be retried".to_string());
            return Err(reason.clone());
        }
        Ok(())
    }

    #[cfg(windows)]
    fn windows_channel_admission(&self, channel: &Option<Arc<AppChannel>>) -> Result<(), String> {
        // Caller holds child -> channel. A retained logically closed channel must be cleared
        // by explicit successful checked stop, never forgotten or implicitly replaced by start.
        if let Some(channel) = channel.as_ref().filter(|channel| !channel.is_open()) {
            let detail = channel.close_error().map_or_else(
                || "native closure not yet established".to_string(),
                |code| format!("Windows error {code}"),
            );
            let reason = format!("the assistant's channel shutdown is unfinished ({detail})");
            *self.refused.lock().unwrap() = Some(reason.clone());
            return Err(reason);
        }
        Ok(())
    }

    #[cfg(windows)]
    fn windows_refuse(&self, reason: String) -> String {
        self.refused.lock().unwrap().get_or_insert(reason).clone()
    }

    // Stop callers need this attempt's reason, not an unrelated sticky admission refusal.
    #[cfg(windows)]
    fn windows_stop_failure(&self, reason: String) -> Result<(), String> {
        self.windows_refuse(reason.clone());
        Err(reason)
    }

    #[cfg(windows)]
    fn windows_wait_port(&self) -> Result<(), String> {
        let deadline = Instant::now() + PORT_RELEASE;
        while self.is_healthy() && Instant::now() < deadline { thread::sleep(Duration::from_millis(100)); }
        if self.is_healthy() { return Err(foreign_daemon_message(self.port)); }
        Ok(())
    }

    /// Caller holds child throughout acquisition, stop, exact deletion and port release.
    /// The installed failure latch prevents all later admissions and stop reconnects.
    /// Retirement deletes the exact launch record but leaves the owner witness as a
    /// non-authoritative tombstone, removed by the next launch's `publish_owner`.
    /// A leftover witness never becomes stop authority (#129).
    #[cfg(windows)]
    fn windows_recovery_admission(&self, child: &Option<Box<dyn ChildProcess>>) -> Result<(), String> {
        if child.is_some() { return Ok(()); }
        let mut slot = self.recovered.lock().unwrap();
        if slot.is_none() {
            windows::ensure_record_directory(&self.data_dir)
                .map_err(|error| self.windows_refuse(format!("Windows record ancestry admission failed: {error}")))?;
            // A launch whose owning app exited needs no stop: the kernel already ended its
            // Job. A witnessed launch that is not proven ended is refused; only legacy records
            // without a witness continue to the existing recovered-launch route.
            match windows::retire_if_owner_exited(&self.data_dir) {
                Ok(true) => {
                    eprintln!("gentle-dot: previous Windows launch retired after its owning app exited");
                    return Ok(());
                }
                Ok(false) => {}
                Err(error) => {
                    let reason = format!("Windows previous launch admission refused: {error}");
                    *self.refused.lock().unwrap() = Some(reason.clone());
                    return Err(reason);
                }
            }
            match windows::acquire_recovered_launch(&self.data_dir) {
                Ok(None) => return Ok(()),
                Ok(Some(owner)) => *slot = Some(WindowsRecovery { owner, failure: None }),
                Err(failure) => {
                    let reason = format!("Windows recorded launch admission refused: {}", failure.error);
                    if let Some(owner) = failure.retained {
                        *slot = Some(WindowsRecovery { owner, failure: Some(reason.clone()) });
                    }
                    *self.refused.lock().unwrap() = Some(reason.clone());
                    return Err(reason);
                }
            }
        }
        let recovery = slot.as_mut().unwrap();
        if let Some(reason) = &recovery.failure {
            *self.refused.lock().unwrap() = Some(reason.clone());
            return Err(reason.clone());
        }
        let completion = recovery.owner.stop(ORPHAN_GRACE)
            .and_then(|()| recovery.owner.delete_record())
            .map_err(|error| format!("Windows recorded launch shutdown/deletion is unfinished: {error}"))
            .and_then(|()| self.windows_wait_port());
        if let Err(reason) = completion {
            recovery.failure = Some(reason.clone());
            *self.refused.lock().unwrap() = Some(reason.clone());
            return Err(reason);
        }
        drop(slot.take());
        Ok(())
    }

    #[cfg(windows)]
    fn start(&self, timeout: Duration) -> Result<(), String> {
        let mut slot = self.child.lock().unwrap();
        self.windows_child_admission(&slot)?;
        self.windows_channel_admission(&self.channel.lock().unwrap())?;
        self.windows_recovery_admission(&slot)?;
        let owns_child = match slot.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                Ok(Some(_)) => false,
                Err(error) => {
                    child.retain_failure();
                    return Err(self.windows_refuse(format!("Windows owned launch status is uncertain: {error}")));
                }
            },
            None => false,
        };
        *self.refused.lock().unwrap() = None;
        if !owns_child && slot.is_none() && self.is_healthy() {
            if self.handler.is_none() { return Ok(()); }
            let reason = foreign_daemon_message(self.port);
            *self.refused.lock().unwrap() = Some(reason.clone());
            return Err(reason);
        }
        self.spawn_locked(slot)?;
        self.wait_ready(timeout)
    }

    #[cfg(unix)]
    fn start(&self, timeout: Duration) -> Result<(), String> {
        let wants_channel = self.handler.is_some();
        let owns_child = self.owns_running();
        let orphan = if wants_channel && !owns_child { live_orphan(&self.data_dir) } else { None };
        *self.refused.lock().unwrap() = None;
        match start_plan(self.is_healthy(), owns_child, wants_channel, orphan.is_some()) {
            StartPlan::Attach => return Ok(()),
            StartPlan::Refuse => {
                let reason = foreign_daemon_message(self.port);
                *self.refused.lock().unwrap() = Some(reason.clone());
                return Err(reason);
            }
            StartPlan::ReplaceOrphan => {
                if let Some(orphan) = orphan {
                    eprintln!("gentle-dot: stopping the assistant an earlier Gentle Dot left running (pid {})", orphan.pid);
                    stop_orphan(orphan, ORPHAN_GRACE);
                    forget_launch(&self.data_dir, orphan.pid);
                }
                let deadline = Instant::now() + PORT_RELEASE;
                while self.is_healthy() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(100));
                }
                if self.is_healthy() {
                    let reason = foreign_daemon_message(self.port);
                    *self.refused.lock().unwrap() = Some(reason.clone());
                    return Err(reason);
                }
            }
            StartPlan::Spawn => {}
        }
        self.spawn()?;
        self.wait_ready(timeout)
    }

    #[cfg(any(unix, test))]
    fn spawn(&self) -> Result<(), String> {
        self.spawn_locked(self.child.lock().unwrap())
    }

    fn spawn_locked(&self, mut slot: std::sync::MutexGuard<'_, Option<Box<dyn ChildProcess>>>) -> Result<(), String> {
        #[cfg(windows)]
        let mut channel_slot = self.channel.lock().unwrap();
        // Recheck under both ownership guards before any launch work; keep the channel
        // installed/locked until replacement installation has completed.
        #[cfg(windows)]
        self.windows_child_admission(&slot)?;
        #[cfg(windows)]
        self.windows_channel_admission(&channel_slot)?;
        if let Some(child) = slot.as_mut() {
            #[cfg(unix)]
            if matches!(child.try_wait(), Ok(None)) { return Ok(()); }
            #[cfg(windows)]
            match child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(_)) => child.shutdown_owned(Duration::ZERO)
                    .map_err(|error| self.windows_refuse(format!("cannot replace unfinished owned Windows daemon: {error}")))?,
                Err(error) => {
                    child.retain_failure();
                    return Err(self.windows_refuse(format!("cannot establish owned Windows daemon status: {error}")));
                }
            }
        }
        #[cfg(windows)]
        {
            if slot.is_some() {
                if let Err(reason) = self.windows_wait_port() {
                    slot.as_mut().unwrap().retain_failure();
                    return Err(self.windows_refuse(reason));
                }
                if let Some(channel) = channel_slot.as_ref() {
                    if let Err(error) = channel.close() {
                        return Err(self.windows_refuse(format!("cannot replace unfinished Windows channel: {error}")));
                    }
                }
                drop(channel_slot.take());
                drop(slot.take());
            }
            // Direct spawn has the same fallible admission, under the same guard.
            self.windows_recovery_admission(&slot)?;
            if self.is_healthy() { return Err(self.windows_refuse(foreign_daemon_message(self.port))); }
            *self.refused.lock().unwrap() = None;
        }
        #[cfg(windows)]
        if self.handler.is_none() {
            let reason = "Windows channel-less launch awaits its equivalent graceful-stop adapter".to_string();
            *self.refused.lock().unwrap() = Some(reason.clone());
            return Err(reason);
        }
        let spec = match &self.launch {
            Some(spec) => spec.clone(),
            None => {
                validate_packaged_runtime(
                    |key| std::env::var(key).ok(),
                    cfg!(windows) && !cfg!(debug_assertions)
                        && option_env!("GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED") == Some("1"),
                    self.runtime_dir.as_deref(),
                )?;
                launch_spec(|key| std::env::var(key).ok(), cfg!(debug_assertions), self.runtime_dir.as_deref())
            }
        };
        let log = open_private_log(&self.data_dir).map_err(|e| format!("cannot open daemon.log: {e}"))?;
        let pair = match &self.handler {
            Some(_) => Some(channel_pair().map_err(|e| format!("cannot open the assistant's channel: {e}"))?),
            None => None,
        };
        #[cfg(unix)]
        let channel_end = pair.as_ref().map(|(_, daemon_end)| {
            use std::os::fd::AsFd;
            daemon_end.as_fd()
        });
        #[cfg(unix)]
        let child = spawn_daemon(&spec, log, channel_end).map_err(|e| format!("cannot start {}: {e}", spec.program))?;
        #[cfg(windows)]
        let mut child = match spawn_daemon(&spec, log, pair.as_ref().map(|(_, endpoint)| endpoint), &self.data_dir) {
            Ok(child) => child,
            Err(mut failure) => {
                let reason = format!("cannot start Windows daemon: {}; cleanup: {}", failure.primary,
                    failure.cleanup.as_ref().map_or_else(|| "no unfinished cleanup".to_string(), ToString::to_string));
                if let Some(owner) = failure.unfinished.take() { *slot = Some(Box::new(owner)); }
                *self.refused.lock().unwrap() = Some(reason.clone());
                return Err(reason);
            }
        };
        // A relaunched app can then tell this daemon from one it did not launch (S35.2).
        #[cfg(unix)]
        if let Err(error) = record_launch(&self.data_dir, child.id()) {
            eprintln!("gentle-dot: cannot record the assistant's pid: {error}");
        }
        #[cfg(windows)]
        {
            // No channel-less adapter is claimed. Constructor above refuses that route.
            let reader = match (pair, self.handler.as_ref()) {
                (Some((endpoint, _)), Some(handler)) => AppChannel::start(endpoint, handler.clone()),
                _ => Err(io::Error::new(io::ErrorKind::Unsupported, "Windows channel-present launch required")),
            };
            let channel = match reader {
                Ok(channel) => channel,
                Err(error) => {
                    child.reject_launch();
                    let cleanup = child.shutdown_owned(Duration::ZERO);
                    let reason = format!("cannot establish Windows daemon channel: {error}; cleanup: {}",
                        cleanup.as_ref().err().map_or_else(|| "completed".to_string(), ToString::to_string));
                    // Even completed channel-start failure retires only after an explicit
                    // checked stop/port release; do not discard its launch diagnosis.
                    *slot = Some(Box::new(child));
                    *self.refused.lock().unwrap() = Some(reason.clone());
                    return Err(reason);
                }
            };
            *slot = Some(Box::new(child));
            *channel_slot = Some(channel.clone());
            drop(channel_slot);
            drop(slot);
            if let Some(handler) = &self.handler { handler.opened(&channel); }
        }
        #[cfg(unix)]
        { *slot = Some(child); }
        // The daemon's end now lives only in the daemon.
        #[cfg(unix)]
        if let (Some((app_end, _)), Some(handler)) = (pair, &self.handler) {
            match AppChannel::start(app_end, handler.clone()) {
                Ok(channel) => {
                    handler.opened(&channel);
                    *self.channel.lock().unwrap() = Some(channel);
                }
                Err(error) => eprintln!("gentle-dot: cannot read the assistant's channel: {error}"),
            }
        }
        Ok(())
    }

    /// True while a daemon spawned by this app is still running.
    pub fn owns_running(&self) -> bool {
        let mut slot = self.child.lock().unwrap();
        #[cfg(unix)]
        { slot.as_mut().is_some_and(|child| matches!(child.try_wait(), Ok(None))) }
        #[cfg(windows)]
        {
            match slot.as_mut() {
                None => false,
                Some(child) => match child.try_wait() {
                    Ok(None) => true,
                    Ok(Some(_)) => false,
                    Err(error) => {
                        child.retain_failure();
                        self.windows_refuse(format!("Windows owned launch status is uncertain: {error}"));
                        false
                    }
                },
            }
        }
    }

    /// Stops the daemon only if this app spawned it, and closes its channel.
    #[cfg(unix)]
    pub fn stop(&self) {
        let child = self.child.lock().unwrap().take();
        if let Some(mut child) = child {
            stop_child(child.as_mut(), STOP_GRACE);
            forget_launch(&self.data_dir, child.id());
        }
        let channel = self.channel.lock().unwrap().take();
        if let Some(channel) = channel {
            channel.close();
        }
    }

    /// Windows keeps ownership installed until checked close succeeds. The child guard
    /// serializes stop with both start-plan admission and actual launch/replacement.
    /// Returns this checked stop's outcome independently of the admission refusal latch.
    #[cfg(windows)]
    pub fn stop(&self) -> Result<(), String> {
        let mut child_slot = self.child.lock().unwrap();
        let mut channel_slot = self.channel.lock().unwrap();
        // Only failed-launch cleanup may close first: its listener may not exist.
        // Established launches must authenticate while fd3 remains open, otherwise
        // daemon-side EOF aborts drain and prevents a clean managed root exit.
        let close_first = child_slot.as_ref().map_or(true, |child| !child.shutdown_requires_channel());
        if close_first {
            if let Some(channel) = channel_slot.as_ref() {
                if let Err(error) = channel.close() {
                    return self.windows_stop_failure(format!("the assistant's channel shutdown is unfinished: {error}"));
                }
            }
        }
        if let Some(child) = child_slot.as_mut() {
            if child.shutdown_requires_channel() && channel_slot.is_none() {
                let reason = "Windows channel-less graceful shutdown awaits its equivalent adapter".to_string();
                *self.refused.lock().unwrap() = Some(reason.clone());
                return Err(reason);
            }
            let grace = if child.shutdown_requires_channel() { STOP_GRACE } else { Duration::ZERO };
            if let Err(error) = stop_child(child.as_mut(), grace) {
                return self.windows_stop_failure(format!("owned Windows daemon shutdown/deletion is unfinished: {error}"));
            }
            if let Err(reason) = self.windows_wait_port() {
                child.retain_failure();
                return self.windows_stop_failure(reason);
            }
        }
        if !close_first {
            if let Some(channel) = channel_slot.as_ref() {
                if let Err(error) = channel.close() {
                    // Even after exact retirement, unfinished parent I/O retains both
                    // installed owners. Never turn cancellation uncertainty into success.
                    return self.windows_stop_failure(format!("the assistant's channel shutdown is unfinished: {error}"));
                }
            }
        }
        let has_recovered = self.recovered.lock().unwrap().is_some();
        if has_recovered { self.windows_recovery_admission(&child_slot)?; }
        drop(child_slot.take());
        drop(channel_slot.take());
        Ok(())
    }

    /// Blocking: call off the main thread.
    pub fn restart(&self, timeout: Duration) -> RestartOutcome {
        if self.handler.is_none() && !self.owns_running() && self.is_healthy() {
            return RestartOutcome::External;
        }
        #[cfg(unix)]
        self.stop();
        #[cfg(windows)]
        if let Err(reason) = self.stop() { return RestartOutcome::Failed(reason); }
        #[cfg(windows)]
        {
            let child = self.child.lock().unwrap();
            let channel = self.channel.lock().unwrap();
            if self.recovered.lock().unwrap().is_some()
                || child.as_ref().is_some_and(|child| child.launch_failed())
                || channel.as_ref().is_some_and(|channel| !channel.is_open())
                || (child.is_some() && channel.is_none()) {
                return RestartOutcome::Failed(self.refusal().unwrap_or_else(||
                    "owned Windows daemon shutdown is unfinished".into()));
            }
        }
        match self.ensure_running(timeout) {
            Ok(()) => RestartOutcome::Restarted,
            Err(_) if self.refusal().is_some() => RestartOutcome::External,
            Err(message) => RestartOutcome::Failed(message),
        }
    }
}

#[cfg(all(test, windows))]
mod windows_ownership_tests {
    use super::*;
    use std::process::ExitStatus;
    use std::sync::{mpsc, Barrier, TryLockError};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct RefusingHandler;
    impl Handler for RefusingHandler {
        fn approve(&self, _: &crate::approvals::ApprovalRequest) -> bool { false }
    }
    // Only the existing-child readiness branch is synthetic. No process is launched and
    // these tests make no native-launch, adoption, or descendant-exclusion claim.
    struct LiveChild;
    impl ChildProcess for LiveChild {
        fn id(&self) -> u32 { 1 }
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> { Ok(None) }
        fn kill(&mut self) -> io::Result<()> { panic!("no native child in ownership test") }
        fn wait(&mut self) -> io::Result<ExitStatus> { panic!("no native child in ownership test") }
    }

    struct FailedChild;
    impl ChildProcess for FailedChild {
        fn id(&self) -> u32 { 2 }
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> { Err(io::Error::other("unfinished launch")) }
        fn kill(&mut self) -> io::Result<()> { panic!("no native child in admission test") }
        fn wait(&mut self) -> io::Result<ExitStatus> { panic!("no native child in admission test") }
        fn launch_failed(&self) -> bool { true }
    }

    /// A daemon this app did not launch: it answers `/health` on a port of its own.
    fn foreign_daemon() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                use std::io::{Read, Write};
                let _ = stream.read(&mut [0u8; 512]);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
            }
        });
        port
    }

    // Formerly the unavailable seam's Windows test (#99); now through the real admission.
    #[test]
    fn an_app_with_a_channel_refuses_a_daemon_it_did_not_launch() {
        let port = foreign_daemon();
        // An empty private directory: no launch record, so admission reaches the health check.
        let dir = std::env::temp_dir().join(format!("gentle-foreign-{}-{port}", std::process::id()));
        windows::ensure_record_directory(&dir).unwrap();
        let daemon = Daemon::new(port, dir.clone(), None).with_channel(Arc::new(RefusingHandler));
        assert_eq!(daemon.ensure_running(Duration::from_secs(5)), Err(foreign_daemon_message(port)));
        assert_eq!(daemon.refusal(), Some(foreign_daemon_message(port)));
        assert!(!daemon.owns_running());
        assert!(daemon.channel().is_none());
        assert_eq!(daemon.wait_ready(Duration::from_millis(300)), Err(foreign_daemon_message(port)));
        assert_eq!(daemon.restart(Duration::from_secs(2)), RestartOutcome::External);
        assert!(!dir.join(PID_FILE).exists());
    }

    #[test]
    fn repeated_failed_launch_admission_preserves_primary_and_cleanup_errors() {
        let ready = Arc::new(AtomicUsize::new(0));
        let daemon = Daemon::new(1, PathBuf::new(), None).on_ready(Arc::new({
            let ready = ready.clone(); move || { ready.fetch_add(1, Ordering::SeqCst); }
        }));
        *daemon.child.lock().unwrap() = Some(Box::new(FailedChild));
        let original = "cannot start node.exe: resume failed; owned cleanup failed".to_string();
        *daemon.refused.lock().unwrap() = Some(original.clone());
        for with_closed_channel in [false, true] {
            let peer = if with_closed_channel {
                let (endpoint, peer) = channel_pair().unwrap();
                let channel = AppChannel::start(endpoint, Arc::new(RefusingHandler)).unwrap();
                channel.close().unwrap();
                assert!(!channel.is_open());
                *daemon.channel.lock().unwrap() = Some(channel);
                Some(peer)
            } else { None };
            for _ in 0..2 {
                assert_eq!(daemon.ensure_running(Duration::ZERO), Err(original.clone()));
                assert_eq!(daemon.spawn(), Err(original.clone()));
                assert_eq!(daemon.refusal(), Some(original.clone()));
                assert!(daemon.child.lock().unwrap().as_ref().unwrap().launch_failed());
                assert_eq!(ready.load(Ordering::SeqCst), 0);
            }
            drop(peer);
        }
        drop(daemon.channel.lock().unwrap().take());
        drop(daemon.child.lock().unwrap().take());
    }

    #[test]
    fn authenticated_stop_failure_keeps_channel_open_and_both_owners() {
        struct StopChild { channel: Arc<AppChannel>, calls: Arc<AtomicUsize> }
        impl ChildProcess for StopChild {
            fn id(&self) -> u32 { 2 }
            fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> { Ok(None) }
            fn kill(&mut self) -> io::Result<()> { panic!("no native process in ordering test") }
            fn wait(&mut self) -> io::Result<ExitStatus> { panic!("no native process in ordering test") }
            fn shutdown_owned(&mut self, _: Duration) -> io::Result<()> {
                assert!(self.channel.is_open(), "authenticated request must precede channel close");
                self.calls.fetch_add(1, Ordering::SeqCst);
                Err(io::Error::other("synthetic authenticated stop uncertainty"))
            }
        }
        let daemon = Daemon::new(1, PathBuf::new(), None);
        let (endpoint, peer) = channel_pair().unwrap();
        let channel = AppChannel::start(endpoint, Arc::new(RefusingHandler)).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        *daemon.child.lock().unwrap() = Some(Box::new(StopChild {
            channel: channel.clone(), calls: calls.clone(),
        }));
        *daemon.channel.lock().unwrap() = Some(channel.clone());
        let stale = "synthetic unrelated startup refusal".to_string();
        *daemon.refused.lock().unwrap() = Some(stale.clone());
        for _ in 0..2 {
            // Debug permits a behavioral RED against the existing unit-returning stop,
            // without requiring a missing diagnostic API to fail compilation instead.
            let diagnostic = format!("{:?}", daemon.stop());
            assert!(channel.is_open());
            assert!(daemon.child.lock().unwrap().is_some());
            assert!(Arc::ptr_eq(daemon.channel.lock().unwrap().as_ref().unwrap(), &channel));
            assert_eq!(daemon.refusal(), Some(stale.clone()), "retain the admission latch independently");
            assert_eq!(diagnostic, format!("{:?}", Err::<(), String>(
                "owned Windows daemon shutdown/deletion is unfinished: synthetic authenticated stop uncertainty".into())),
                "exit needs this stop attempt's exact reason, not the stale admission refusal");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        drop(daemon.child.lock().unwrap().take());
        let _ = daemon.stop(); // Cleanup only: the child was already dropped.
        drop(peer);
    }

    #[test]
    fn successful_windows_stop_has_no_exit_diagnostic_despite_stale_refusal() {
        let mut daemon = Daemon::new(1, PathBuf::new(), None);
        daemon.health = Some(Arc::new(|| false));
        let (endpoint, peer) = channel_pair().unwrap();
        let channel = AppChannel::start(endpoint, Arc::new(RefusingHandler)).unwrap();
        *daemon.channel.lock().unwrap() = Some(channel.clone());
        let stale = "synthetic unrelated startup refusal".to_string();
        *daemon.refused.lock().unwrap() = Some(stale.clone());
        let diagnostic = format!("{:?}", daemon.stop());
        assert!(!channel.is_open());
        assert!(daemon.child.lock().unwrap().is_none());
        assert!(daemon.channel.lock().unwrap().is_none());
        assert_eq!(daemon.refusal(), Some(stale));
        assert_eq!(diagnostic, format!("{:?}", Ok::<(), String>(())),
            "successful checked stop must not report a stale refusal at exit");
        drop(peer);
    }

    #[test]
    fn retained_failed_launch_cannot_be_healthy_or_replaced_and_failed_stop_keeps_both_owners() {
        let ready = Arc::new(AtomicUsize::new(0));
        let mut daemon = Daemon::new(1, PathBuf::new(), None)
            .with_channel(Arc::new(RefusingHandler))
            .on_ready(Arc::new({ let ready = ready.clone(); move || { ready.fetch_add(1, Ordering::SeqCst); } }));
        daemon.health = Some(Arc::new(|| true));
        *daemon.child.lock().unwrap() = Some(Box::new(FailedChild));
        let (endpoint, peer) = channel_pair().unwrap();
        let retained = AppChannel::start(endpoint, Arc::new(RefusingHandler)).unwrap();
        *daemon.channel.lock().unwrap() = Some(retained.clone());
        retained.test_inject_cancel_error(windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED as i32);
        assert!(daemon.stop().is_err());
        assert!(daemon.child.lock().unwrap().is_some());
        assert!(Arc::ptr_eq(daemon.channel.lock().unwrap().as_ref().unwrap(), &retained));
        assert!(!daemon.owns_running());
        assert!(daemon.ensure_running(Duration::ZERO).is_err());
        assert!(daemon.spawn().is_err());
        assert_eq!(ready.load(Ordering::SeqCst), 0);
        retained.test_inject_cancel_error(0);
        assert!(daemon.stop().is_err()); // Synthetic child's unsupported checked cleanup must also retain both.
        assert!(daemon.child.lock().unwrap().is_some());
        assert!(Arc::ptr_eq(daemon.channel.lock().unwrap().as_ref().unwrap(), &retained));
        assert!(matches!(daemon.restart(Duration::ZERO), RestartOutcome::Failed(_)));
        drop(daemon.child.lock().unwrap().take());
        let _ = daemon.stop(); // Cleanup only: the child was already dropped.
        drop(peer);
    }

    struct CompletedChild(Arc<AtomicUsize>);
    impl ChildProcess for CompletedChild {
        fn id(&self) -> u32 { 3 }
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            use std::os::windows::process::ExitStatusExt;
            Ok(Some(ExitStatus::from_raw(1))) // A forced exit is not a clean exit.
        }
        fn kill(&mut self) -> io::Result<()> { panic!("synthetic completed child") }
        fn wait(&mut self) -> io::Result<ExitStatus> { panic!("synthetic completed child") }
        fn shutdown_owned(&mut self, _: Duration) -> io::Result<()> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn completed_child_close_failure_blocks_restart_until_checked_retry() {
        let mut daemon = Daemon::new(1, PathBuf::new(), None).with_channel(Arc::new(RefusingHandler));
        daemon.health = Some(Arc::new(|| false));
        let calls = Arc::new(AtomicUsize::new(0));
        *daemon.child.lock().unwrap() = Some(Box::new(CompletedChild(calls.clone())));
        let (endpoint, peer) = channel_pair().unwrap();
        let retained = AppChannel::start(endpoint, Arc::new(RefusingHandler)).unwrap();
        *daemon.channel.lock().unwrap() = Some(retained.clone());
        retained.test_inject_cancel_error(windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED as i32);
        let error = daemon.stop().unwrap_err();
        assert!(error.starts_with("the assistant's channel shutdown is unfinished:"));
        match daemon.restart(Duration::ZERO) {
            RestartOutcome::Failed(reason) => assert_eq!(reason, error),
            _ => panic!("restart must propagate checked stop failure"),
        }
        assert!(daemon.child.lock().unwrap().is_some());
        assert!(Arc::ptr_eq(daemon.channel.lock().unwrap().as_ref().unwrap(), &retained));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        retained.test_inject_cancel_error(0);
        daemon.stop().unwrap();
        assert!(daemon.child.lock().unwrap().is_none());
        assert!(daemon.channel.lock().unwrap().is_none());
        drop(peer);
    }

    #[test]
    fn exited_root_replacement_retains_both_owners_when_old_channel_close_fails() {
        let mut daemon = Daemon::new(1, PathBuf::new(), None).with_channel(Arc::new(RefusingHandler));
        daemon.health = Some(Arc::new(|| false));
        // Regression must stop before this deliberately invalid launcher is reached.
        daemon.launch = Some(LaunchSpec { program: "must-not-launch".into(), args: vec![], envs: vec![] });
        let calls = Arc::new(AtomicUsize::new(0));
        *daemon.child.lock().unwrap() = Some(Box::new(CompletedChild(calls.clone())));
        let (endpoint, peer) = channel_pair().unwrap();
        let retained = AppChannel::start(endpoint, Arc::new(RefusingHandler)).unwrap();
        *daemon.channel.lock().unwrap() = Some(retained.clone());
        retained.test_inject_cancel_error(windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED as i32);
        assert!(daemon.spawn().unwrap_err().starts_with("cannot replace unfinished Windows channel:"));
        assert!(daemon.child.lock().unwrap().is_some());
        assert!(Arc::ptr_eq(daemon.channel.lock().unwrap().as_ref().unwrap(), &retained));
        assert!(retained.close_error().is_some());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(daemon.spawn().is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1, "admission rejects a logically closed retained channel");
        retained.test_inject_cancel_error(0);
        daemon.stop().unwrap();
        assert!(daemon.child.lock().unwrap().is_none());
        assert!(daemon.channel.lock().unwrap().is_none());
        drop(peer);
    }

    fn failed_close_serializes_start(direct_spawn: bool) {
        let ready = Arc::new(AtomicUsize::new(0));
        let mut daemon = Daemon::new(1, PathBuf::new(), None)
            .with_channel(Arc::new(RefusingHandler))
            .on_ready(Arc::new({
                let ready = ready.clone();
                move || { ready.fetch_add(1, Ordering::SeqCst); }
            }));
        daemon.health = Some(Arc::new(|| true));
        let daemon = Arc::new(daemon);
        let (endpoint, peer) = channel_pair().unwrap();
        let retained = AppChannel::start(endpoint, Arc::new(RefusingHandler)).unwrap();
        *daemon.channel.lock().unwrap() = Some(retained.clone());
        retained.test_inject_cancel_error(windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED as i32);
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        retained.test_close_barriers(entered.clone(), release.clone());
        let stopping = thread::spawn({ let daemon = daemon.clone(); move || daemon.stop() });
        entered.wait();
        // A controlled pause INSIDE checked close proves both ownership guards remain held:
        // no empty slot can be observed and neither admission nor replacement can pass.
        let child_locked = matches!(daemon.child.try_lock(), Err(TryLockError::WouldBlock));
        let channel_locked = matches!(daemon.channel.try_lock(), Err(TryLockError::WouldBlock));
        let (attempt_tx, attempt_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let starting = thread::spawn({
            let daemon = daemon.clone();
            move || {
                attempt_tx.send(()).unwrap();
                let result = if direct_spawn { daemon.spawn() } else { daemon.ensure_running(Duration::ZERO) };
                result_tx.send(result).unwrap();
            }
        });
        attempt_rx.recv().unwrap();
        let premature_result = result_rx.try_recv().ok();
        let completed_early = premature_result.is_some();
        // Release/join the controlled stop before asserting invariants, including on a
        // regression: an assertion must not strand a thread at the test-only barrier.
        release.wait();
        let stopped = stopping.join().unwrap();
        let result = premature_result.unwrap_or_else(|| result_rx.recv_timeout(Duration::from_secs(2)).unwrap());
        starting.join().unwrap();
        assert!(child_locked, "start admission must remain blocked by checked stop");
        assert!(channel_locked, "retained channel must remain installed and guarded");
        assert!(!completed_early, "start must not complete during checked close");
        assert!(result.is_err());
        assert!(stopped.is_err(), "the controlled checked close must fail");
        assert!(Arc::ptr_eq(daemon.channel.lock().unwrap().as_ref().unwrap(), &retained));
        assert!(retained.close_error().is_some());
        assert!(daemon.refusal().is_some());
        assert_eq!(ready.load(Ordering::SeqCst), 0);

        // Explicit checked retry, not start, is what permits the slot to be cleared.
        retained.test_inject_cancel_error(0);
        assert_eq!(daemon.stop(), Ok(()));
        assert!(daemon.channel.lock().unwrap().is_none());
        assert_eq!(retained.close_error(), None);
        drop(peer);
        // Exercise successful readiness after retry without invoking the absent launcher.
        let (endpoint, next_peer) = channel_pair().unwrap();
        let replacement = AppChannel::start(endpoint, Arc::new(RefusingHandler)).unwrap();
        {
            let mut child = daemon.child.lock().unwrap();
            let mut channel = daemon.channel.lock().unwrap();
            daemon.windows_channel_admission(&channel).unwrap();
            *child = Some(Box::new(LiveChild));
            *channel = Some(replacement.clone());
        }
        daemon.ensure_running(Duration::ZERO).unwrap();
        assert_eq!(ready.load(Ordering::SeqCst), 1);
        drop(daemon.child.lock().unwrap().take()); // Drop the synthetic child, never signal a PID.
        let _ = daemon.stop(); // Cleanup only: the child was already dropped.
        drop(next_peer);
    }

    #[test]
    fn failed_close_blocks_start_plan_and_ready_until_checked_retry() {
        failed_close_serializes_start(false);
    }
    #[test]
    fn failed_close_blocks_actual_spawn_replacement_until_checked_retry() {
        failed_close_serializes_start(true);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::app_channel::{AppChannel, Handler};
    use std::io::{BufRead, BufReader, Write};
    use std::os::fd::{AsFd, AsRawFd};
    use std::os::unix::net::UnixStream;
    use std::process::Command;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
    }

    fn env_value<'a>(spec: &'a LaunchSpec, key: &str) -> Option<&'a str> {
        spec.envs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn launch_spec_uses_build_time_paths() {
        let spec = launch_spec(env_of(&[]), false, None);
        assert_eq!(spec.program, env!("GENTLE_DOT_BUILD_NODE"));
        assert_eq!(spec.args, vec![env!("GENTLE_DOT_BUILD_DAEMON_SCRIPT").to_string()]);
        assert!(spec.args[0].ends_with("packages/daemon/src/cli.ts"));
        assert_eq!(env_value(&spec, "PATH"), Some(env!("GENTLE_DOT_BUILD_PATH")));
        assert_eq!(env_value(&spec, "GENTLE_DOT_ALLOWED_ORIGINS"), None);
    }

    #[test]
    fn launch_spec_honors_runtime_overrides() {
        let spec = launch_spec(
            env_of(&[("GENTLE_DOT_NODE", "/opt/node"), ("GENTLE_DOT_DAEMON_SCRIPT", "/srv/cli.ts")]),
            false,
            None,
        );
        assert_eq!(spec.program, "/opt/node");
        assert_eq!(spec.args, vec!["/srv/cli.ts".to_string()]);
        let spec = launch_spec(env_of(&[("GENTLE_DOT_NODE", "")]), false, None);
        assert_eq!(spec.program, env!("GENTLE_DOT_BUILD_NODE"));
    }

    #[test]
    fn only_dev_builds_allow_the_dev_server_origin() {
        let spec = launch_spec(env_of(&[]), true, None);
        assert_eq!(env_value(&spec, "GENTLE_DOT_ALLOWED_ORIGINS"), Some(DEV_ALLOWED_ORIGINS));
    }

    /// A fake `runtime/` tree, with `daemon/cli.mjs` only when `with_daemon`.
    fn fake_runtime(name: &str, with_daemon: bool) -> PathBuf {
        let runtime = scratch_dir(name).join("runtime");
        fs::create_dir_all(runtime.join("daemon")).unwrap();
        fs::create_dir_all(runtime.join("node/bin")).unwrap();
        if with_daemon {
            fs::write(runtime.join("daemon/cli.mjs"), "").unwrap();
        }
        runtime
    }

    #[test]
    fn launch_spec_runs_the_bundled_runtime_when_present() {
        let runtime = fake_runtime("runtime-bundled", true);
        let spec = launch_spec(env_of(&[]), false, Some(&runtime));
        let root = runtime.display().to_string();
        assert_eq!(spec.program, format!("{root}/node/bin/node"));
        assert_eq!(spec.args, vec![format!("{root}/daemon/cli.mjs")]);
        assert_eq!(
            env_value(&spec, "PATH"),
            Some(format!("{root}/bin:{root}/node/bin:/usr/bin:/bin:/usr/sbin:/sbin").as_str())
        );
        assert_eq!(env_value(&spec, "GENTLE_DOT_RUNTIME"), Some(root.as_str()));
        assert_eq!(env_value(&spec, "GENTLE_DOT_ALLOWED_ORIGINS"), None);
        let spec = launch_spec(env_of(&[]), true, Some(&runtime));
        assert_eq!(env_value(&spec, "GENTLE_DOT_ALLOWED_ORIGINS"), Some(DEV_ALLOWED_ORIGINS));
    }

    #[test]
    fn launch_spec_keeps_the_build_machine_launch_without_a_bundled_daemon() {
        let today = LaunchSpec {
            program: env!("GENTLE_DOT_BUILD_NODE").into(),
            args: vec![env!("GENTLE_DOT_BUILD_DAEMON_SCRIPT").into()],
            envs: vec![("PATH".into(), env!("GENTLE_DOT_BUILD_PATH").into())],
        };
        let runtime = fake_runtime("runtime-empty", false);
        assert_eq!(launch_spec(env_of(&[]), false, Some(&runtime)), today);
        assert_eq!(launch_spec(env_of(&[]), false, Some(&runtime.join("missing"))), today);
        assert_eq!(launch_spec(env_of(&[]), false, None), today);
    }

    #[test]
    fn overrides_win_over_the_bundled_runtime() {
        let runtime = fake_runtime("runtime-override", true);
        let spec = launch_spec(
            env_of(&[("GENTLE_DOT_NODE", "/opt/node"), ("GENTLE_DOT_DAEMON_SCRIPT", "/srv/cli.ts")]),
            false,
            Some(&runtime),
        );
        assert_eq!(spec.program, "/opt/node");
        assert_eq!(spec.args, vec!["/srv/cli.ts".to_string()]);
        assert_eq!(env_value(&spec, "GENTLE_DOT_RUNTIME"), Some(runtime.display().to_string().as_str()));
        let spec = launch_spec(env_of(&[("GENTLE_DOT_NODE", "")]), false, Some(&runtime));
        assert_eq!(spec.program, runtime.join("node/bin/node").display().to_string());
    }

    #[test]
    fn runtime_dir_is_the_runtime_resource_unless_overridden() {
        let resources = Some(PathBuf::from("/Applications/Gentle Dot.app/Contents/Resources"));
        let bundled = Some(PathBuf::from("/Applications/Gentle Dot.app/Contents/Resources/runtime"));
        assert_eq!(runtime_dir(env_of(&[]), resources.clone()), bundled);
        assert_eq!(runtime_dir(env_of(&[("GENTLE_DOT_RUNTIME_DIR", "")]), resources.clone()), bundled);
        assert_eq!(
            runtime_dir(env_of(&[("GENTLE_DOT_RUNTIME_DIR", "/srv/runtime")]), resources),
            Some(PathBuf::from("/srv/runtime"))
        );
        assert_eq!(
            runtime_dir(env_of(&[("GENTLE_DOT_RUNTIME_DIR", "/srv/runtime")]), None),
            Some(PathBuf::from("/srv/runtime"))
        );
        assert_eq!(runtime_dir(env_of(&[]), None), None);
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("gentle-dot-{name}-{}-{nanos}", std::process::id()))
    }

    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn daemon_log_is_private_when_created() {
        let dir = scratch_dir("log-new").join("data");
        open_private_log(&dir).unwrap();
        assert_eq!(mode_of(&dir), 0o700);
        assert_eq!(mode_of(&dir.join("daemon.log")), 0o600);
    }

    #[test]
    fn daemon_log_repairs_looser_modes() {
        let dir = scratch_dir("log-old");
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(dir.join("daemon.log"), "old line\n").unwrap();
        fs::set_permissions(dir.join("daemon.log"), fs::Permissions::from_mode(0o644)).unwrap();
        use std::io::Write;
        writeln!(open_private_log(&dir).unwrap(), "new line").unwrap();
        assert_eq!(mode_of(&dir), 0o700);
        assert_eq!(mode_of(&dir.join("daemon.log")), 0o600);
        assert_eq!(fs::read_to_string(dir.join("daemon.log")).unwrap(), "old line\nnew line\n");
    }

    fn sh_spec(script: &str) -> LaunchSpec {
        LaunchSpec { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()], envs: vec![] }
    }

    fn read_line(stream: &UnixStream) -> String {
        // macOS refuses socket options (EINVAL) once the other end has closed; reading still works.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        line
    }

    #[test]
    fn the_daemon_gets_its_end_of_the_channel_on_fd_3() {
        let dir = scratch_dir("channel-fd");
        let (app, daemon_end) = channel_pair().unwrap();
        let script = "if [ -S /dev/fd/3 ]; then kind=socket; else kind=other; fi; \
IFS= read -r line <&3; printf '%s %s\\n' \"$kind\" \"$line\" >&3";
        let mut child = spawn_daemon(&sh_spec(script), open_private_log(&dir).unwrap(), Some(daemon_end.as_fd())).unwrap();
        drop(daemon_end);
        (&app).write_all(b"ping\n").unwrap();
        assert_eq!(read_line(&app), "socket ping\n");
        assert!(child.wait().unwrap().success());
        // Once the daemon is gone, nothing else holds the other end.
        assert_eq!(read_line(&app), "");
    }

    #[test]
    fn the_channel_end_is_never_one_the_daemon_could_clobber() {
        let (_app, daemon_end) = channel_pair().unwrap();
        assert!(daemon_end.as_raw_fd() > APP_FD, "{}", daemon_end.as_raw_fd());
    }

    #[test]
    fn without_a_channel_fd_3_is_closed_in_the_daemon() {
        let dir = scratch_dir("channel-none");
        let script = "if [ -e /dev/fd/3 ]; then echo open; else echo none; fi";
        let mut child = spawn_daemon(&sh_spec(script), open_private_log(&dir).unwrap(), None).unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(fs::read_to_string(dir.join("daemon.log")).unwrap(), "none\n");
    }

    #[test]
    fn no_other_descriptor_of_the_app_reaches_the_daemon() {
        let dir = scratch_dir("channel-only");
        let log = open_private_log(&dir).unwrap();
        // A descriptor some library opened without close-on-exec (F_DUPFD leaves the flag clear).
        // SAFETY: duplicating a descriptor we own; the copy is owned by `stray`.
        let stray = unsafe { OwnedFd::from_raw_fd(libc::fcntl(log.as_raw_fd(), libc::F_DUPFD, 60)) };
        assert!(stray.as_raw_fd() >= 60);
        let (_app, daemon_end) = channel_pair().unwrap();
        let script = format!(
            "if [ -S /dev/fd/3 ]; then echo channel; fi; if [ -e /dev/fd/{} ]; then echo leaked; else echo closed; fi",
            stray.as_raw_fd()
        );
        let mut child = spawn_daemon(&sh_spec(&script), log, Some(daemon_end.as_fd())).unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(fs::read_to_string(dir.join("daemon.log")).unwrap(), "channel\nclosed\n");
    }

    /// The real thing on this platform: the app's spawn hands fd 3 to Node running the daemon's
    /// stand-in (packages/daemon/test/fixtures/app-channel-child.ts), which opens the channel the way
    /// the daemon does and reports what the children it spawns see on fd 3. Needs Node 24 on PATH
    /// (or `GENTLE_DOT_TEST_NODE`): `cargo test a_node_daemon -- --ignored`.
    #[test]
    #[ignore = "needs Node 24 and the repository's daemon sources"]
    fn a_node_daemon_keeps_the_channel_from_its_children() {
        use std::os::unix::fs::MetadataExt;
        let dir = scratch_dir("channel-node");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/daemon/test/fixtures/app-channel-child.ts");
        let node = std::env::var("GENTLE_DOT_TEST_NODE").unwrap_or_else(|_| "node".into());
        let path = std::env::var("PATH").unwrap_or_default();
        let spec = LaunchSpec {
            program: node,
            args: vec![fixture.to_string_lossy().into_owned()],
            envs: vec![("PATH".into(), path)],
        };
        let (app, daemon_end) = channel_pair().unwrap();
        let own = File::from(daemon_end.try_clone().unwrap()).metadata().unwrap();
        // Node shows `dev` signed (macOS's dev_t is an i32 and a socket's is -1).
        let identity = format!("{}:{}", own.dev() as i64, own.ino());
        let mut child = spawn_daemon(&spec, open_private_log(&dir).unwrap(), Some(daemon_end.as_fd())).unwrap();
        drop(daemon_end);
        app.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let mut line = String::new();
        BufReader::new(&app).read_line(&mut line).unwrap();
        let log = || fs::read_to_string(dir.join("daemon.log")).unwrap_or_default();
        let frame: serde_json::Value = serde_json::from_str(&line).unwrap_or_else(|_| panic!("no report: {line:?} {}", log()));
        assert_eq!(frame["method"], "report", "{frame} {}", log());
        (&app).write_all(format!("{{\"kind\":\"response\",\"id\":{},\"result\":{{}}}}\n", frame["id"]).as_bytes()).unwrap();
        assert!(child.wait().unwrap().success(), "{}", log());
        let report = &frame["params"];
        // The daemon holds the socket this app handed over; none of its children does.
        assert_eq!(report["identity"], identity.as_str(), "{report}");
        assert_ne!(report["fromSpawn"], identity.as_str(), "{report}");
        assert_ne!(report["fromSpawnSync"], identity.as_str(), "{report}");
        assert_eq!(report["fromShell"], "none", "{report}");
        // And the daemon's startup probe would have seen a leak, had there been one.
        assert_eq!(report["detectsALeak"], true, "{report}");
    }

    #[derive(Default)]
    struct Opened(Mutex<usize>);

    impl Handler for Opened {
        fn approve(&self, _: &crate::approvals::ApprovalRequest) -> bool {
            false
        }

        fn opened(&self, _: &Arc<AppChannel>) {
            *self.0.lock().unwrap() += 1;
        }
    }

    /// A daemon stand-in that answers every request on fd 3 with `{"echo": <id>}`.
    const ECHO: &str = r#"while IFS= read -r line <&3; do
id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\1/')
printf '{"kind":"response","id":%s,"result":{"echo":%s}}\n' "$id" "$id" >&3
done"#;

    #[test]
    fn a_daemon_this_app_spawned_gets_a_channel_until_it_stops() {
        let handler = Arc::new(Opened::default());
        let daemon = Daemon::new(1, scratch_dir("channel-own"), None)
            .with_channel(handler.clone())
            .with_launch(sh_spec(ECHO));
        assert!(daemon.channel().is_none());
        daemon.spawn().unwrap();
        let channel = daemon.channel().expect("a channel to the spawned daemon");
        assert_eq!(*handler.0.lock().unwrap(), 1);
        let answer = channel.request("ping", serde_json::json!({}), Duration::from_secs(5)).unwrap();
        assert_eq!(answer, serde_json::json!({"echo": 1}));
        daemon.stop();
        assert!(daemon.channel().is_none());
        assert!(!channel.is_open());
    }

    /// A stand-in for a daemon this app did not launch (`pnpm dev`, or one an older app left): it
    /// answers `/health` on a port of its own.
    fn foreign_daemon() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0u8; 512];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
            }
        });
        port
    }

    #[test]
    fn the_start_plan_attaches_only_where_no_channel_is_lost() {
        use StartPlan::*;
        // (healthy, owns its child, wants a channel, a live orphan it launched) -> plan
        let cases = [
            ((false, false, true, false), Spawn),
            ((true, true, true, false), Spawn),
            ((true, false, true, false), Refuse),
            ((true, false, true, true), ReplaceOrphan),
            ((false, false, true, true), ReplaceOrphan),
            ((true, true, true, true), Spawn),
            ((true, false, false, false), Attach),
            ((true, false, false, true), Attach),
            ((false, false, false, false), Spawn),
        ];
        for ((healthy, owns, wants, orphan), plan) in cases {
            assert_eq!(start_plan(healthy, owns, wants, orphan), plan, "{healthy} {owns} {wants} {orphan}");
        }
    }

    #[test]
    fn an_app_that_wants_a_channel_never_attaches_to_a_daemon_it_did_not_launch() {
        let port = foreign_daemon();
        let handler = Arc::new(Opened::default());
        let dir = scratch_dir("channel-foreign");
        let daemon = Daemon::new(port, dir.clone(), None).with_channel(handler.clone()).with_launch(sh_spec(ECHO));
        let refused = daemon.ensure_running(Duration::from_secs(5)).unwrap_err();
        assert_eq!(refused, foreign_daemon_message(port));
        // The message names the way out.
        assert!(refused.contains("pnpm dev") && refused.contains("Restart assistant"), "{refused}");
        assert!(!daemon.owns_running());
        assert!(daemon.channel().is_none());
        assert_eq!(*handler.0.lock().unwrap(), 0);
        // The panel gets the same reason instead of a connection to the other daemon.
        assert_eq!(daemon.wait_ready(Duration::from_millis(300)), Err(foreign_daemon_message(port)));
        assert_eq!(daemon.restart(Duration::from_secs(2)), RestartOutcome::External);
        assert!(!dir.join(PID_FILE).exists());
    }

    #[test]
    fn an_app_without_a_channel_still_attaches_to_a_running_daemon() {
        let port = foreign_daemon();
        let daemon = Daemon::new(port, scratch_dir("attach-no-channel"), None).with_launch(sh_spec(ECHO));
        daemon.ensure_running(Duration::from_secs(5)).unwrap();
        assert!(!daemon.owns_running());
        assert_eq!(daemon.wait_ready(Duration::from_millis(300)), Ok(()));
    }

    #[test]
    fn the_pid_file_names_only_the_process_it_recorded() {
        let dir = scratch_dir("pid-file");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(recorded_launch(&dir), None);
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        record_launch(&dir, child.id()).unwrap();
        assert_eq!(mode_of(&dir.join(PID_FILE)), 0o600);
        let recorded = recorded_launch(&dir).expect("a recorded launch");
        assert_eq!(recorded.pid, child.id());
        assert_eq!(live_orphan(&dir), Some(recorded));
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(live_orphan(&dir), None);
        // Another live process under that number (a later start time) is never taken for it.
        let mut other = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let started = process_started(other.id()).unwrap();
        fs::write(dir.join(PID_FILE), format!("{} {}\n", other.id(), started + 1)).unwrap();
        assert_eq!(live_orphan(&dir), None);
        other.kill().unwrap();
        other.wait().unwrap();
        fs::write(dir.join(PID_FILE), "not a launch\n").unwrap();
        assert_eq!(recorded_launch(&dir), None);
    }

    /// A pid file naming `pid` with its real start time, as `record_launch` would write it.
    fn launch_line(pid: u32) -> String {
        format!("{pid} {}\n", process_started(pid).expect("a live process"))
    }

    #[test]
    fn the_pid_file_never_names_the_app_its_parent_or_the_system() {
        let dir = scratch_dir("pid-self");
        fs::create_dir_all(&dir).unwrap();
        let me = std::process::id();
        // SAFETY: getppid(2) has no preconditions.
        let parent = u32::try_from(unsafe { libc::getppid() }).unwrap();
        for pid in [me, parent] {
            fs::write(dir.join(PID_FILE), launch_line(pid)).unwrap();
            assert_eq!(recorded_launch(&dir), None, "pid {pid}");
            assert_eq!(live_orphan(&dir), None, "pid {pid}");
        }
        for pid in [0, 1] {
            fs::write(dir.join(PID_FILE), format!("{pid} 1\n")).unwrap();
            assert_eq!(recorded_launch(&dir), None, "pid {pid}");
        }
    }

    #[test]
    fn a_pid_file_that_is_a_symlink_is_not_read_and_its_target_is_untouched() {
        let dir = scratch_dir("pid-symlink-read");
        fs::create_dir_all(&dir).unwrap();
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let target = dir.join("elsewhere");
        let line = launch_line(child.id());
        fs::write(&target, &line).unwrap();
        std::os::unix::fs::symlink(&target, dir.join(PID_FILE)).unwrap();
        assert_eq!(recorded_launch(&dir), None);
        assert_eq!(live_orphan(&dir), None);
        assert_eq!(fs::read_to_string(&target).unwrap(), line);
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn recording_a_launch_never_writes_through_a_symlink() {
        let dir = scratch_dir("pid-symlink-write");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("elsewhere");
        fs::write(&target, "keep me\n").unwrap();
        std::os::unix::fs::symlink(&target, dir.join(PID_FILE)).unwrap();
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        record_launch(&dir, child.id()).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep me\n");
        let file = fs::symlink_metadata(dir.join(PID_FILE)).unwrap();
        assert!(file.file_type().is_file(), "{:?}", file.file_type());
        assert_eq!(file.permissions().mode() & 0o777, 0o600);
        assert_eq!(recorded_launch(&dir).map(|launch| launch.pid), Some(child.id()));
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn recording_a_launch_replaces_the_pid_file_whole() {
        use std::os::unix::fs::MetadataExt;
        let dir = scratch_dir("pid-atomic");
        fs::create_dir_all(&dir).unwrap();
        let mut first = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut second = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        record_launch(&dir, first.id()).unwrap();
        let before = fs::metadata(dir.join(PID_FILE)).unwrap().ino();
        record_launch(&dir, second.id()).unwrap();
        // A new file renamed over the old one: a reader sees one launch or the other, never half.
        assert_ne!(fs::metadata(dir.join(PID_FILE)).unwrap().ino(), before);
        assert_eq!(fs::read_to_string(dir.join(PID_FILE)).unwrap(), launch_line(second.id()));
        // Nothing else is left in the folder.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        for child in [&mut first, &mut second] {
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }

    #[test]
    fn a_pid_file_that_is_not_a_small_regular_file_is_not_read() {
        let dir = scratch_dir("pid-odd");
        fs::create_dir_all(&dir).unwrap();
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        // A real launch followed by padding past any launch's size.
        fs::write(dir.join(PID_FILE), format!("{}{}", launch_line(child.id()), " ".repeat(4096))).unwrap();
        assert_eq!(live_orphan(&dir), None);
        fs::remove_file(dir.join(PID_FILE)).unwrap();
        // A FIFO would block a plain open; it is refused at once.
        let fifo = std::ffi::CString::new(dir.join(PID_FILE).as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: mkfifo(2) on a path we own, from a valid C string.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(live_orphan(&dir), None);
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn a_refused_app_announces_its_assistant_once_a_restart_starts_it() {
        let dir = scratch_dir("ready-after-restart");
        // Another daemon answers on the port until the user stops it; then only this app's own does.
        let foreign = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let health = {
            let (dir, foreign) = (dir.clone(), foreign.clone());
            Arc::new(move || foreign.load(std::sync::atomic::Ordering::SeqCst) || live_orphan(&dir).is_some())
        };
        let ready = Arc::new(Mutex::new(0usize));
        let daemon = {
            let ready = ready.clone();
            Daemon::new(1, dir.clone(), None)
                .with_channel(Arc::new(Opened::default()))
                .with_launch(sh_spec(ECHO))
                .with_health(health)
                .on_ready(Arc::new(move || *ready.lock().unwrap() += 1))
        };
        assert_eq!(daemon.ensure_running(Duration::from_secs(5)), Err(foreign_daemon_message(1)));
        assert_eq!(*ready.lock().unwrap(), 0);
        // The user follows the refusal's exit: stops the other one, then "Restart assistant".
        foreign.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(daemon.restart(Duration::from_secs(5)), RestartOutcome::Restarted);
        assert_eq!(*ready.lock().unwrap(), 1);
        // What the panel asks next now succeeds instead of repeating the refusal.
        assert_eq!(daemon.wait_ready(Duration::from_millis(300)), Ok(()));
        assert!(daemon.channel().is_some());
        daemon.stop();
    }

    #[test]
    fn a_relaunched_app_after_a_crashed_one_gets_a_channel() {
        let dir = scratch_dir("relaunch");
        // The port answers while the daemon named in the pid file runs.
        let health = {
            let dir = dir.clone();
            Arc::new(move || recorded_launch(&dir).is_some_and(|launch| process_started(launch.pid) == Some(launch.started)))
        };
        // An earlier app launched a daemon that outlived it without its channel (an older daemon).
        let orphan_script = "exec 3<&-; exec /bin/sleep 30";
        let crashed = Daemon::new(1, dir.clone(), None)
            .with_channel(Arc::new(Opened::default()))
            .with_launch(sh_spec(orphan_script))
            .with_health(health.clone());
        crashed.spawn().unwrap();
        let orphan = recorded_launch(&dir).expect("the launch is recorded");
        // The app is gone; the orphan is reparented and reaped by init (here, by this thread).
        let mut child = crashed.child.lock().unwrap().take().unwrap();
        drop(crashed);
        let reaper = thread::spawn(move || child.wait());

        let handler = Arc::new(Opened::default());
        let relaunched = Daemon::new(1, dir.clone(), None)
            .with_channel(handler.clone())
            .with_launch(sh_spec(ECHO))
            .with_health(health);
        relaunched.ensure_running(Duration::from_secs(10)).unwrap();
        assert!(reaper.join().unwrap().is_ok());
        assert_eq!(process_started(orphan.pid), None);
        let channel = relaunched.channel().expect("a channel to the new daemon");
        assert_eq!(*handler.0.lock().unwrap(), 1);
        let answer = channel.request("ping", serde_json::json!({}), Duration::from_secs(5)).unwrap();
        assert_eq!(answer, serde_json::json!({"echo": 1}));
        let recorded = recorded_launch(&dir).expect("the new launch is recorded");
        assert_ne!(recorded.pid, orphan.pid);
        relaunched.stop();
        assert!(!dir.join(PID_FILE).exists());
    }

    #[test]
    fn stop_child_terminates_with_sigterm() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let started = Instant::now();
        stop_child(&mut child, Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(2));
        let status = child.try_wait().unwrap().expect("child has exited");
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGTERM));
    }

    #[test]
    fn stop_child_kills_after_the_grace_period() {
        let mut child = Command::new("/bin/sh").args(["-c", "trap '' TERM; sleep 30"]).spawn().unwrap();
        thread::sleep(Duration::from_millis(100));
        stop_child(&mut child, Duration::from_millis(300));
        let status = child.try_wait().unwrap().expect("child has exited");
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }
}
