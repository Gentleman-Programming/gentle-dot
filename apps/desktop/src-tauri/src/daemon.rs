//! Attaches to a running daemon or spawns one, and stops what it spawned. A daemon it spawns gets
//! its end of the app's private channel on fd 3 (S25.1, `app_channel`); one it attached to gets none.

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
    /// Replaces [`launch_spec`] (tests).
    launch: Option<LaunchSpec>,
}

impl Daemon {
    pub fn new(port: u16, data_dir: PathBuf, runtime_dir: Option<PathBuf>) -> Self {
        Self { port, data_dir, runtime_dir, child: Mutex::new(None), channel: Mutex::new(None), handler: None, launch: None }
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

    /// The channel to the daemon, only while one this app spawned runs and the channel is open.
    pub fn channel(&self) -> Option<Arc<AppChannel>> {
        if !self.owns_running() {
            return None;
        }
        self.channel.lock().unwrap().clone().filter(|channel| channel.is_open())
    }

    pub fn is_healthy(&self) -> bool {
        check_health(self.port, HEALTH_TIMEOUT)
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

    /// Attaches to a healthy daemon, or spawns one. Blocking: call off the main thread.
    pub fn ensure_running(&self, timeout: Duration) -> Result<(), String> {
        if self.is_healthy() {
            return Ok(());
        }
        self.spawn()?;
        if self.wait_healthy(timeout) {
            Ok(())
        } else {
            Err(format!("the assistant did not answer on port {} (see daemon.log)", self.port))
        }
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
        }
        if let Some(channel) = self.channel.lock().unwrap().take() {
            channel.close();
        }
    }

    /// Blocking: call off the main thread.
    pub fn restart(&self, timeout: Duration) -> RestartOutcome {
        if !self.owns_running() && self.is_healthy() {
            return RestartOutcome::External;
        }
        self.stop();
        match self.ensure_running(timeout) {
            Ok(()) => RestartOutcome::Restarted,
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

    #[test]
    fn a_daemon_the_app_only_attached_to_gets_no_channel() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0u8; 512];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
            }
        });
        let handler = Arc::new(Opened::default());
        let daemon = Daemon::new(port, scratch_dir("channel-attached"), None)
            .with_channel(handler.clone())
            .with_launch(sh_spec(ECHO));
        daemon.ensure_running(Duration::from_secs(5)).unwrap();
        assert!(daemon.channel().is_none());
        assert_eq!(*handler.0.lock().unwrap(), 0);
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
