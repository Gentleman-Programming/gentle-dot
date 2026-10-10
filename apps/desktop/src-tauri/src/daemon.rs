//! Spawns the daemon, and stops what it spawned. A daemon it spawns gets its end of the app's
//! private channel on fd 3 (S25.1, `app_channel`) and stops by itself when that channel closes, so it
//! lives as long as this app, crashes included (S35.2).
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
use std::os::fd::{BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
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

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_started(_pid: u32) -> Option<u64> {
    None
}

/// Records the daemon just spawned as `pid` (private, 0600).
pub fn record_launch(data_dir: &Path, pid: u32) -> io::Result<()> {
    let started = process_started(pid).ok_or_else(|| io::Error::other("the assistant is not running"))?;
    let mut file = OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(data_dir.join(PID_FILE))?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    use std::io::Write;
    writeln!(file, "{pid} {started}")
}

/// The daemon the pid file names, if it holds a launch.
pub fn recorded_launch(data_dir: &Path) -> Option<Launched> {
    let text = fs::read_to_string(data_dir.join(PID_FILE)).ok()?;
    let mut parts = text.split_whitespace();
    let launched = Launched { pid: parts.next()?.parse().ok()?, started: parts.next()?.parse().ok()? };
    (parts.next().is_none() && launched.pid > 1).then_some(launched)
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
fn stop_orphan(launch: Launched, grace: Duration) {
    let Ok(pid) = libc::pid_t::try_from(launch.pid) else {
        return;
    };
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
            let path = format!("{root}/bin:{root}/node/bin:/usr/bin:/bin:/usr/sbin:/sbin");
            (
                format!("{root}/node/bin/node"),
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
    fs::DirBuilder::new().recursive(true).mode(0o700).create(data_dir)?;
    fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))?;
    let log = OpenOptions::new().create(true).append(true).mode(0o600).open(data_dir.join("daemon.log"))?;
    log.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(log)
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

#[cfg(not(target_os = "macos"))]
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
    if let Some(fd) = channel.map(|fd| fd.as_raw_fd()) {
        // SAFETY: runs in the child between fork and exec and only calls dup2, which is
        // async-signal-safe. `fd` is above APP_FD (channel_pair), so dup2 makes a new fd 3
        // without close-on-exec, while the original closes at exec.
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(fd, APP_FD) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    Ok(Box::new(command.spawn()?))
}

/// Sends SIGTERM, waits up to `grace` for a clean exit, then kills.
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

    #[cfg(test)]
    fn with_launch(mut self, spec: LaunchSpec) -> Self {
        self.launch = Some(spec);
        self
    }

    #[cfg(test)]
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
    /// already on the port. Blocking: call off the main thread.
    pub fn ensure_running(&self, timeout: Duration) -> Result<(), String> {
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
        let spec = self.launch.clone().unwrap_or_else(|| {
            launch_spec(|key| std::env::var(key).ok(), cfg!(debug_assertions), self.runtime_dir.as_deref())
        });
        let log = open_private_log(&self.data_dir).map_err(|e| format!("cannot open daemon.log: {e}"))?;
        let pair = match &self.handler {
            Some(_) => Some(channel_pair().map_err(|e| format!("cannot open the assistant's channel: {e}"))?),
            None => None,
        };
        let channel_end = pair.as_ref().map(|(_, daemon_end)| {
            use std::os::fd::AsFd;
            daemon_end.as_fd()
        });
        let child = spawn_daemon(&spec, log, channel_end).map_err(|e| format!("cannot start {}: {e}", spec.program))?;
        // A relaunched app can then tell this daemon from one it did not launch (S35.2).
        if let Err(error) = record_launch(&self.data_dir, child.id()) {
            eprintln!("gentle-dot: cannot record the assistant's pid: {error}");
        }
        *slot = Some(child);
        // The daemon's end now lives only in the daemon.
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

    #[cfg(target_os = "macos")]
    #[test]
    fn without_a_channel_fd_3_is_closed_in_the_daemon() {
        let dir = scratch_dir("channel-none");
        let script = "if [ -e /dev/fd/3 ]; then echo open; else echo none; fi";
        let mut child = spawn_daemon(&sh_spec(script), open_private_log(&dir).unwrap(), None).unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(fs::read_to_string(dir.join("daemon.log")).unwrap(), "none\n");
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
        // Another live process under that number (here this test's own) is never taken for it.
        let me = std::process::id();
        fs::write(dir.join(PID_FILE), format!("{me} {}\n", process_started(me).unwrap() + 1)).unwrap();
        assert_eq!(live_orphan(&dir), None);
        fs::write(dir.join(PID_FILE), "not a launch\n").unwrap();
        assert_eq!(recorded_launch(&dir), None);
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
