//! Spawns the daemon, and stops what it spawned. A daemon it spawns gets its end of the app's
//! private channel (S25.1, `app_channel`): on fd 3 on macOS and Linux, over a named pipe on
//! Windows, whose name the app hands over in `GENTLE_DOT_CHANNEL_PIPE`. The daemon stops by itself
//! when that channel closes, so it lives as long as this app, crashes included (S35.2).
//!
//! An app with a channel never attaches to a daemon it did not launch: that daemon has no channel,
//! so connectors would stay locked with no way out. When a healthy daemon holds the port at start,
//! the app stops it only if it can prove it launched it (`<data>/daemon.pid`, written at every spawn,
//! names the pid and the process start time); otherwise it refuses with
//! [`foreign_daemon_message`], which names the exit. An app without a channel attaches as before.

pub use crate::app_channel::APP_FD;
use crate::app_channel::{AppChannel, Handler};
use crate::health::check_health;
use std::fs::{self, File, OpenOptions};
use std::io;
#[cfg(unix)]
use std::os::fd::{BorrowedFd, FromRawFd, OwnedFd};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Origins of the `tauri dev` server, allowed only on daemons spawned by debug builds.
pub const DEV_ALLOWED_ORIGINS: &str = r#"["http://127.0.0.1:5173","http://localhost:5173"]"#;

const HEALTH_TIMEOUT: Duration = Duration::from_millis(300);
const STOP_GRACE: Duration = Duration::from_secs(5);
/// How long the app waits for the daemon it spawned to connect to the named-pipe channel.
#[cfg(windows)]
const CHANNEL_ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
/// The daemon stops its engine and memory first; a recorded orphan gets longer than a child.
const ORPHAN_GRACE: Duration = Duration::from_secs(10);
/// How long the port may take to be free after a recorded orphan stopped.
const PORT_RELEASE: Duration = Duration::from_secs(5);
/// `<data>/daemon.pid`: `<pid> <start time>` of the daemon this app launched last.
pub const PID_FILE: &str = "daemon.pid";

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

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn process_started(_pid: u32) -> Option<u64> {
    None
}

/// When `pid` started (its creation time, 100 ns ticks since 1601), while it is live; `None` once
/// it is gone or cannot be read. Windows has no `/proc`: the creation time comes from
/// `GetProcessTimes` over a handle opened only to query it, which a same-user process may do. A
/// process that has ended may still be openable by pid while another handle keeps its object alive
/// (the pid file tests hold the child), so liveness is its handle being unsignaled: a terminated
/// process is `WAIT_OBJECT_0`, not `WAIT_TIMEOUT`, and reads as gone here (W19).
#[cfg(windows)]
pub fn process_started(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, WAIT_TIMEOUT};
    use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return None;
    }
    // SAFETY: OpenProcess takes a pid and returns a handle or null; it dereferences nothing.
    // `SYNCHRONIZE` is what lets the handle be waited on below; it and the query right do not
    // confer any ability to read or change the process's memory.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        return None;
    }
    // SAFETY: a zero-timeout wait on a process handle: `WAIT_TIMEOUT` while it runs, and
    // `WAIT_OBJECT_0` once it has terminated (any other result fails closed below).
    let running = unsafe { WaitForSingleObject(process, 0) } == WAIT_TIMEOUT;
    let mut created = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut exited = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut kernel = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut user = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    // SAFETY: `process` is a live process handle and every out-pointer is a valid FILETIME.
    let ok = unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) };
    // SAFETY: `process` came from OpenProcess and is closed exactly once here.
    unsafe { CloseHandle(process) };
    (ok != 0 && running).then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

// The app's own files, and only the user who runs it reads them. Unix expresses that with mode
// bits, and refuses to follow a symlink or block on a FIFO at those paths. Windows has no mode
// bits, and privacy there comes from the ACL of the profile folder the data folder lives in, so
// these entries are created and opened plainly (L13, `posix-modes.ts`).
#[cfg(unix)]
fn create_private(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

#[cfg(not(unix))]
fn create_private(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// Opens an app-owned file for reading without following a symlink or blocking on a FIFO there.
/// Windows has no such entry types to refuse, so it opens plainly.
#[cfg(unix)]
fn open_private_read(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)
}

#[cfg(not(unix))]
fn open_private_read(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

/// The folder the app keeps its own files in. Unix also repairs a looser mode on it.
#[cfg(unix)]
fn create_private_dir(path: &Path) -> io::Result<()> {
    fs::DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> io::Result<()> {
    fs::DirBuilder::new().recursive(true).create(path)
}

#[cfg(unix)]
fn open_appended_private(path: &Path) -> io::Result<File> {
    let log = OpenOptions::new().create(true).append(true).mode(0o600).open(path)?;
    log.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(log)
}

#[cfg(not(unix))]
fn open_appended_private(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/// Records the daemon just spawned as `pid` (private, 0600). A new file in the same folder renamed
/// over the pid file: never written through a symlink there, and never seen half written.
pub fn record_launch(data_dir: &Path, pid: u32) -> io::Result<()> {
    let started = process_started(pid).ok_or_else(|| io::Error::other("the assistant is not running"))?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let temp = data_dir.join(format!(".{PID_FILE}.{}.{nanos}", std::process::id()));
    let written = create_private(&temp)
        .and_then(|mut file| {
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
const PID_FILE_MAX: u64 = 64;

/// Whether a pid read from the pid file may name a daemon to signal: never this app, its parent,
/// init, or the kernel.
#[cfg(unix)]
fn may_be_daemon(pid: u32) -> bool {
    // SAFETY: getppid(2) has no preconditions.
    let parent = u32::try_from(unsafe { libc::getppid() }).ok();
    pid > 1 && pid != std::process::id() && Some(pid) != parent
}

/// Windows has no `getppid` in `std`, and this process's parent is not readable there without a
/// Win32 call, so the parent check is absent. What remains still refuses this process and the
/// kernel's low pids. Like the Unix arm, only a pid that names a recorded live process reaches it.
#[cfg(not(unix))]
fn may_be_daemon(pid: u32) -> bool {
    pid > 1 && pid != std::process::id()
}

/// The daemon the pid file names, if it holds a launch. Only a small regular file is read: a
/// symlink, a FIFO, or anything else there is ignored (opened without following or blocking).
pub fn recorded_launch(data_dir: &Path) -> Option<Launched> {
    let file = open_private_read(&data_dir.join(PID_FILE)).ok()?;
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
pub fn live_orphan(data_dir: &Path) -> Option<Launched> {
    recorded_launch(data_dir).filter(|launch| process_started(launch.pid) == Some(launch.started))
}

/// Removes the pid file when it names `pid`.
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

/// Windows has no `SIGTERM` and no `std` way to end a process that is not its child, so the polite
/// phase cannot exist there either: the process is terminated outright with `TerminateProcess`
/// after re-checking that the pid still names the recorded process. `grace` is how long the caller
/// lets the process exit before the port is re-checked (W19).
#[cfg(windows)]
fn stop_orphan(launch: Launched, grace: Duration) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_TERMINATE};
    if !may_be_daemon(launch.pid) {
        return;
    }
    // Checked just before terminating, exactly as the Unix arm does: a pid now used by another
    // process (another start time) is left alone.
    if process_started(launch.pid) != Some(launch.started) {
        return;
    }
    // SAFETY: OpenProcess takes a pid and a rights mask and returns a handle or null.
    let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, launch.pid) };
    if process.is_null() {
        return;
    }
    // SAFETY: `process` is a live process handle from OpenProcess, and terminating it is the point.
    unsafe { TerminateProcess(process, 1) };
    // SAFETY: waiting on a handle this process owns, with a bounded timeout.
    unsafe { WaitForSingleObject(process, u32::try_from(grace.as_millis()).unwrap_or(u32::MAX)) };
    // SAFETY: `process` came from OpenProcess and is closed exactly once here.
    unsafe { CloseHandle(process) };
}

#[cfg(not(any(unix, windows)))]
fn stop_orphan(_launch: Launched, _grace: Duration) {}

/// What [`Daemon::ensure_running`] does, from what it finds.
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub envs: Vec<(String, String)>,
}

/// `<node> <daemon script>` (S29.5). With a bundled runtime (`<runtime>/daemon/cli.mjs`
/// exists) that is the runtime's own Node and daemon, a PATH of the runtime plus the
/// system folders, and `GENTLE_DOT_RUNTIME`; otherwise the build-time paths and PATH.
/// `GENTLE_DOT_NODE` and `GENTLE_DOT_DAEMON_SCRIPT` override the program and script in both.
pub fn launch_spec(env: impl Fn(&str) -> Option<String>, dev: bool, runtime: Option<&Path>) -> LaunchSpec {
    let pick = |key: &str, fallback: String| env(key).filter(|v| !v.is_empty()).unwrap_or(fallback);
    let bundled = runtime.filter(|dir| dir.join("daemon/cli.mjs").is_file());
    let (node, script, mut envs) = match bundled {
        Some(dir) => {
            let root = dir.display().to_string();
            // Windows stages Node at `node/node.exe` beside its npm, and joins PATH with `;`.
            let (node, path) = if cfg!(windows) {
                (format!("{root}/node/node.exe"), format!("{root}/bin;{root}/node"))
            } else {
                (
                    format!("{root}/node/bin/node"),
                    format!("{root}/bin:{root}/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
                )
            };
            (
                node,
                format!("{root}/daemon/cli.mjs"),
                vec![("PATH".to_string(), path), ("GENTLE_DOT_RUNTIME".to_string(), root)],
            )
        }
        None => (
            env!("GENTLE_DOT_BUILD_NODE").to_string(),
            env!("GENTLE_DOT_BUILD_DAEMON_SCRIPT").to_string(),
            vec![("PATH".to_string(), env!("GENTLE_DOT_BUILD_PATH").to_string())],
        ),
    };
    if dev {
        envs.push(("GENTLE_DOT_ALLOWED_ORIGINS".into(), DEV_ALLOWED_ORIGINS.into()));
    }
    LaunchSpec {
        program: pick("GENTLE_DOT_NODE", node),
        args: vec![pick("GENTLE_DOT_DAEMON_SCRIPT", script)],
        envs,
    }
}

/// Where a bundled runtime would live: `GENTLE_DOT_RUNTIME_DIR`, else the app's `runtime`
/// resource. `launch_spec` uses it only when it holds `daemon/cli.mjs`.
pub fn runtime_dir(env: impl Fn(&str) -> Option<String>, resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    env("GENTLE_DOT_RUNTIME_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| resource_dir.map(|dir| dir.join("runtime")))
}

/// Opens `<data_dir>/daemon.log` for appending. The folder is 0700 and the log
/// 0600 (looser modes are repaired) because the daemon's output is private.
pub fn open_private_log(data_dir: &Path) -> io::Result<File> {
    create_private_dir(data_dir)?;
    open_appended_private(&data_dir.join("daemon.log"))
}

/// A spawned process the app polls, stops, and reaps: a `std::process::Child`, or on macOS a
/// daemon spawned with its TCC responsibility disclaimed (`disclaimed`).
pub trait ChildProcess: Send {
    fn id(&self) -> u32;
    /// The exit status once the process ended (reaping it), `None` while it runs.
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>>;
    /// Sends SIGKILL unless the process was already reaped.
    fn kill(&mut self) -> io::Result<()>;
    fn wait(&mut self) -> io::Result<ExitStatus>;
}

impl ChildProcess for Child {
    fn id(&self) -> u32 {
        Child::id(self)
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        Child::try_wait(self)
    }

    fn kill(&mut self) -> io::Result<()> {
        Child::kill(self)
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        Child::wait(self)
    }
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

/// Windows has no fd 3 to place a channel on and no other descriptor of the app to withhold, so
/// the daemon gets its stdio and the log and nothing else. The channel is a named pipe the app
/// creates before the spawn; the daemon receives its name in `GENTLE_DOT_CHANNEL_PIPE` (set on
/// `spec.envs` before this runs) and connects to it.
#[cfg(windows)]
fn spawn_daemon(spec: &LaunchSpec, log: File) -> io::Result<Box<dyn ChildProcess>> {
    use std::process::{Command, Stdio};
    let child = Command::new(&spec.program)
        .args(&spec.args)
        .envs(spec.envs.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()?;
    Ok(Box::new(child))
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

/// Windows has no `SIGTERM`, and `std` offers no way to ask a child to stop, so the polite phase
/// cannot exist there: the child is terminated outright and `grace` has nothing to wait for. A
/// daemon stopped this way is killed rather than asked to finish (L30).
#[cfg(not(unix))]
pub fn stop_child(child: &mut dyn ChildProcess, _grace: Duration) {
    if !matches!(child.try_wait(), Ok(None)) {
        return;
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

pub struct Daemon {
    port: u16,
    data_dir: PathBuf,
    runtime_dir: Option<PathBuf>,
    child: Mutex<Option<Box<dyn ChildProcess>>>,
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
            channel: Mutex::new(None),
            handler: None,
            refused: Mutex::new(None),
            ready: None,
            launch: None,
            #[cfg(test)]
            health: None,
        }
    }

    /// Every daemon this app spawns gets a channel served by `handler`: the fd-3 socketpair on
    /// macOS and Linux, the named pipe the app creates before the spawn on Windows.
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

    #[cfg(test)]
    fn with_launch(mut self, spec: LaunchSpec) -> Self {
        self.launch = Some(spec);
        self
    }

    #[cfg(test)]
    // Its only callers are the POSIX-only tests, so it has no callers on Windows by design.
    #[cfg_attr(not(unix), allow(dead_code))]
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

    fn spawn(&self) -> Result<(), String> {
        let mut slot = self.child.lock().unwrap();
        if let Some(child) = slot.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return Ok(());
            }
        }
        // The pipe name is pushed into the child's environment below, so the spec is mutable on Windows.
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut spec = self.launch.clone().unwrap_or_else(|| {
            launch_spec(|key| std::env::var(key).ok(), cfg!(debug_assertions), self.runtime_dir.as_deref())
        });
        let log = open_private_log(&self.data_dir).map_err(|e| format!("cannot open daemon.log: {e}"))?;
        #[cfg(unix)]
        let pair = match &self.handler {
            Some(_) => Some(channel_pair().map_err(|e| format!("cannot open the assistant's channel: {e}"))?),
            None => None,
        };
        #[cfg(unix)]
        let channel_end = pair.as_ref().map(|(_, daemon_end)| {
            use std::os::fd::AsFd;
            daemon_end.as_fd()
        });
        // Created before the spawn, with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so no other process can
        // take the name while the child starts.
        #[cfg(windows)]
        let endpoint = match &self.handler {
            Some(_) => Some(
                crate::app_channel::windows::ServerEndpoint::create()
                    .map_err(|e| format!("cannot open the assistant's channel: {e}"))?,
            ),
            None => None,
        };
        // The name is not a secret; the accepted connection's PID, checked against the child, is.
        #[cfg(windows)]
        if let Some(endpoint) = &endpoint {
            spec.envs.push(("GENTLE_DOT_CHANNEL_PIPE".to_string(), endpoint.name().to_string()));
        }
        #[cfg(unix)]
        let child = spawn_daemon(&spec, log, channel_end).map_err(|e| format!("cannot start {}: {e}", spec.program))?;
        #[cfg(not(unix))]
        let child = spawn_daemon(&spec, log).map_err(|e| format!("cannot start {}: {e}", spec.program))?;
        let pid = child.id();
        // A relaunched app can then tell this daemon from one it did not launch (S35.2).
        if let Err(error) = record_launch(&self.data_dir, pid) {
            eprintln!("gentle-dot: cannot record the assistant's pid: {error}");
        }
        *slot = Some(child);
        // The child's creation time, so a recycled PID cannot pass the liveness check (W19).
        #[cfg(windows)]
        let started = process_started(pid);
        // Never hold the child mutex while waiting on the pipe: `owns_running` locks it too.
        drop(slot);
        // The daemon's end now lives only in the daemon.
        #[cfg(unix)]
        {
            if let (Some((app_end, _)), Some(handler)) = (pair, &self.handler) {
                match AppChannel::start(app_end, handler.clone()) {
                    Ok(channel) => {
                        handler.opened(&channel);
                        *self.channel.lock().unwrap() = Some(channel);
                    }
                    Err(error) => eprintln!("gentle-dot: cannot read the assistant's channel: {error}"),
                }
            }
        }
        #[cfg(windows)]
        {
            if let (Some(endpoint), Some(handler)) = (endpoint, &self.handler) {
                let deadline = Instant::now() + CHANNEL_ACCEPT_TIMEOUT;
                // The recorded-creation-time liveness check (W19) needs no lock, so the accept never
                // touches the child mutex it just released; a recycled PID fails the comparison.
                match endpoint.accept(pid, move || started.is_some_and(|started| process_started(pid) == Some(started)), deadline) {
                    Ok(connected) => match AppChannel::start(connected, handler.clone()) {
                        Ok(channel) => {
                            handler.opened(&channel);
                            *self.channel.lock().unwrap() = Some(channel);
                        }
                        Err(error) => eprintln!("gentle-dot: cannot read the assistant's channel: {error}"),
                    },
                    Err(error) => eprintln!("gentle-dot: cannot open the assistant's channel: {error}"),
                }
            }
        }
        Ok(())
    }

    /// True while a daemon spawned by this app is still running.
    pub fn owns_running(&self) -> bool {
        let mut slot = self.child.lock().unwrap();
        slot.as_mut().is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }

    /// Stops the daemon only if this app spawned it, and closes its channel.
    pub fn stop(&self) {
        let child = self.child.lock().unwrap().take();
        if let Some(mut child) = child {
            stop_child(child.as_mut(), STOP_GRACE);
            forget_launch(&self.data_dir, child.id());
        }
        if let Some(channel) = self.channel.lock().unwrap().take() {
            channel.close();
        }
    }

    /// Blocking: call off the main thread.
    pub fn restart(&self, timeout: Duration) -> RestartOutcome {
        if self.handler.is_none() && !self.owns_running() && self.is_healthy() {
            return RestartOutcome::External;
        }
        self.stop();
        match self.ensure_running(timeout) {
            Ok(()) => RestartOutcome::Restarted,
            Err(_) if self.refusal().is_some() => RestartOutcome::External,
            Err(message) => RestartOutcome::Failed(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    #[cfg(unix)]
    use std::os::fd::{AsFd, AsRawFd};
    #[cfg(unix)]
    use std::os::unix::net::UnixStream;
    #[cfg(unix)]
    use std::process::Command;
    #[cfg(windows)]
    use std::process::{Command, Stdio};

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
        assert!(Path::new(&spec.args[0]).ends_with("packages/daemon/src/cli.ts"));
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
        let (program, path) = if cfg!(windows) {
            (format!("{root}/node/node.exe"), format!("{root}/bin;{root}/node"))
        } else {
            (
                format!("{root}/node/bin/node"),
                format!("{root}/bin:{root}/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
            )
        };
        assert_eq!(spec.program, program);
        assert_eq!(spec.args, vec![format!("{root}/daemon/cli.mjs")]);
        assert_eq!(env_value(&spec, "PATH"), Some(path.as_str()));
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
        let node = if cfg!(windows) {
            runtime.join("node/node.exe")
        } else {
            runtime.join("node/bin/node")
        };
        assert_eq!(Path::new(&spec.program), node);
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

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn daemon_log_is_private_when_created() {
        let dir = scratch_dir("log-new").join("data");
        open_private_log(&dir).unwrap();
        assert_eq!(mode_of(&dir), 0o700);
        assert_eq!(mode_of(&dir.join("daemon.log")), 0o600);
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
    fn read_line(stream: &UnixStream) -> String {
        // macOS refuses socket options (EINVAL) once the other end has closed; reading still works.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        line
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn the_channel_end_is_never_one_the_daemon_could_clobber() {
        let (_app, daemon_end) = channel_pair().unwrap();
        assert!(daemon_end.as_raw_fd() > APP_FD, "{}", daemon_end.as_raw_fd());
    }

    #[cfg(unix)]
    #[test]
    fn without_a_channel_fd_3_is_closed_in_the_daemon() {
        let dir = scratch_dir("channel-none");
        let script = "if [ -e /dev/fd/3 ]; then echo open; else echo none; fi";
        let mut child = spawn_daemon(&sh_spec(script), open_private_log(&dir).unwrap(), None).unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(fs::read_to_string(dir.join("daemon.log")).unwrap(), "none\n");
    }

    #[cfg(unix)]
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
    #[cfg(unix)]
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

    #[cfg(unix)]
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

    /// The named-pipe peer fixture: dispatched by env var, a no-op in a normal run. It answers one
    /// request with `{"echo": <id>}` over the pipe the app named in `GENTLE_DOT_CHANNEL_PIPE`.
    #[cfg(windows)]
    #[test]
    fn windows_channel_echo_daemon_fixture() {
        let Ok(role) = std::env::var("GENTLE_DOT_TEST_ECHO_ROLE") else { return };
        if role != "daemon" {
            return;
        }
        let name = std::env::var("GENTLE_DOT_CHANNEL_PIPE").expect("a pipe name");
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut client = loop {
            match std::fs::OpenOptions::new().read(true).write(true).open(&name) {
                Ok(file) => break file,
                Err(error) => {
                    assert!(Instant::now() < deadline, "could not connect to the channel: {error}");
                    thread::sleep(Duration::from_millis(20));
                }
            }
        };
        let mut reader = BufReader::new(client.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let frame: crate::app_channel::Frame = serde_json::from_str(&line).unwrap();
        let crate::app_channel::Frame::Request { id, .. } = frame else { panic!("expected a request") };
        let response = crate::app_channel::Frame::Response { id, result: Some(serde_json::json!({"echo": id})), error: None };
        writeln!(client, "{}", serde_json::to_string(&response).unwrap()).unwrap();
    }

    /// The Windows wiring: the endpoint is created before the spawn, `GENTLE_DOT_CHANNEL_PIPE`
    /// reaches the child, the accepted connection's PID is the child's, and the channel is opened.
    #[cfg(windows)]
    #[test]
    fn a_daemon_this_app_spawned_gets_a_named_pipe_channel_until_it_stops() {
        let handler = Arc::new(Opened::default());
        let spec = LaunchSpec {
            program: std::env::current_exe().unwrap().display().to_string(),
            args: vec!["--exact".into(), "daemon::tests::windows_channel_echo_daemon_fixture".into()],
            envs: vec![("GENTLE_DOT_TEST_ECHO_ROLE".into(), "daemon".into())],
        };
        let daemon =
            Daemon::new(0, scratch_dir("channel-pipe"), None).with_channel(handler.clone()).with_launch(spec);
        assert!(daemon.channel().is_none());
        daemon.spawn().unwrap();
        let channel = daemon.channel().expect("a channel to the spawned daemon");
        assert_eq!(*handler.0.lock().unwrap(), 1, "opened fired once");
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    /// Set on a child of this very test binary that has to stay alive while the pid file names it.
    #[cfg(windows)]
    const PID_HOLDER: &str = "GENTLE_DOT_TEST_PID_HOLDER";

    /// A live process with a readable creation time, without a shell: a copy of this test binary
    /// that sleeps. The harness runs [`the_pid_holder_waits_until_it_is_killed`] when a pid-file
    /// test asks for one, and that test returns at once in an ordinary run.
    #[cfg(windows)]
    fn sleeper() -> std::process::Child {
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "daemon::tests::the_pid_holder_waits_until_it_is_killed", "--nocapture"])
            .env(PID_HOLDER, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    /// Not a test of its own: it is the body of the process [`sleeper`] starts.
    #[cfg(windows)]
    #[test]
    fn the_pid_holder_waits_until_it_is_killed() {
        if std::env::var_os(PID_HOLDER).is_none() {
            return;
        }
        thread::sleep(Duration::from_secs(120));
    }

    #[cfg(windows)]
    #[test]
    fn a_live_process_has_a_start_time_and_a_dead_one_does_not() {
        let mut child = sleeper();
        let started = process_started(child.id()).expect("a live process has a start time");
        assert_eq!(process_started(child.id()), Some(started), "the start time is stable while it runs");
        assert!(process_started(std::process::id()).is_some(), "this process is live");
        assert_eq!(process_started(0), None);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(process_started(child.id()), None, "a process that ended has no start time");
    }

    #[cfg(windows)]
    #[test]
    fn the_pid_file_names_a_live_process_and_drops_it_when_it_dies() {
        let dir = scratch_dir("pid-file-windows");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(recorded_launch(&dir), None);
        let mut child = sleeper();
        record_launch(&dir, child.id()).unwrap();
        let recorded = recorded_launch(&dir).expect("a recorded launch");
        assert_eq!(recorded.pid, child.id());
        assert_eq!(live_orphan(&dir), Some(recorded));
        // Another start time under that number names a different process: never taken for it.
        fs::write(dir.join(PID_FILE), format!("{} {}\n", child.id(), recorded.started + 1)).unwrap();
        assert_eq!(live_orphan(&dir), None);
        fs::write(dir.join(PID_FILE), format!("{} {}\n", child.id(), recorded.started)).unwrap();
        assert_eq!(live_orphan(&dir), Some(recorded));
        // The app itself is never a daemon it may stop.
        fs::write(dir.join(PID_FILE), format!("{} {}\n", std::process::id(), 1)).unwrap();
        assert_eq!(recorded_launch(&dir), None);
        fs::write(dir.join(PID_FILE), format!("{} {}\n", child.id(), recorded.started)).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(live_orphan(&dir), None, "the record is dropped once the process is gone");
    }

    #[cfg(windows)]
    #[test]
    fn stopping_a_recorded_orphan_terminates_only_the_process_it_recorded() {
        let dir = scratch_dir("stop-orphan-windows");
        fs::create_dir_all(&dir).unwrap();
        let mut orphan = sleeper();
        record_launch(&dir, orphan.id()).unwrap();
        let recorded = recorded_launch(&dir).unwrap();
        // A pid whose live start time is not the recorded one is left alone.
        stop_orphan(Launched { pid: recorded.pid, started: recorded.started + 1 }, Duration::from_secs(2));
        assert_eq!(orphan.try_wait().unwrap(), None, "a different start time was terminated");
        // The recorded process is terminated and stops running.
        stop_orphan(recorded, Duration::from_secs(5));
        let deadline = Instant::now() + Duration::from_secs(5);
        while orphan.try_wait().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(orphan.try_wait().unwrap().is_some(), "the recorded orphan is still running");
        assert_eq!(process_started(recorded.pid), None);
        // Never this app, whatever the record says.
        stop_orphan(Launched { pid: std::process::id(), started: 1 }, Duration::from_secs(1));
    }

    /// A pid file naming `pid` with its real start time, as `record_launch` would write it.
    #[cfg(unix)]
    fn launch_line(pid: u32) -> String {
        format!("{pid} {}\n", process_started(pid).expect("a live process"))
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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
