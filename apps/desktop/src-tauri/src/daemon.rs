//! Attaches to a running daemon or spawns one, and stops what it spawned.

use crate::health::check_health;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
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

/// `<node> <daemon script>` with the build-time PATH; `GENTLE_DOT_NODE` and
/// `GENTLE_DOT_DAEMON_SCRIPT` override the build-time paths.
pub fn launch_spec(env: impl Fn(&str) -> Option<String>, dev: bool) -> LaunchSpec {
    let pick = |key: &str, fallback: &str| env(key).filter(|v| !v.is_empty()).unwrap_or_else(|| fallback.into());
    let mut envs = vec![("PATH".to_string(), env!("GENTLE_DOT_BUILD_PATH").to_string())];
    if dev {
        envs.push(("GENTLE_DOT_ALLOWED_ORIGINS".into(), DEV_ALLOWED_ORIGINS.into()));
    }
    LaunchSpec {
        program: pick("GENTLE_DOT_NODE", env!("GENTLE_DOT_BUILD_NODE")),
        args: vec![pick("GENTLE_DOT_DAEMON_SCRIPT", env!("GENTLE_DOT_BUILD_DAEMON_SCRIPT"))],
        envs,
    }
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

/// Sends SIGTERM, waits up to `grace` for a clean exit, then kills.
pub fn stop_child(child: &mut Child, grace: Duration) {
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
    child: Mutex<Option<Child>>,
}

impl Daemon {
    pub fn new(port: u16, data_dir: PathBuf) -> Self {
        Self { port, data_dir, child: Mutex::new(None) }
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
        let spec = launch_spec(|key| std::env::var(key).ok(), cfg!(debug_assertions));
        let log = open_private_log(&self.data_dir).map_err(|e| format!("cannot open daemon.log: {e}"))?;
        let child = Command::new(&spec.program)
            .args(&spec.args)
            .envs(spec.envs.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .spawn()
            .map_err(|e| format!("cannot start {}: {e}", spec.program))?;
        *slot = Some(child);
        Ok(())
    }

    /// True while a daemon spawned by this app is still running.
    pub fn owns_running(&self) -> bool {
        let mut slot = self.child.lock().unwrap();
        slot.as_mut().is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }

    /// Stops the daemon only if this app spawned it.
    pub fn stop(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            stop_child(&mut child, STOP_GRACE);
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

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
    }

    fn env_value<'a>(spec: &'a LaunchSpec, key: &str) -> Option<&'a str> {
        spec.envs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn launch_spec_uses_build_time_paths() {
        let spec = launch_spec(env_of(&[]), false);
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
        );
        assert_eq!(spec.program, "/opt/node");
        assert_eq!(spec.args, vec!["/srv/cli.ts".to_string()]);
        let spec = launch_spec(env_of(&[("GENTLE_DOT_NODE", "")]), false);
        assert_eq!(spec.program, env!("GENTLE_DOT_BUILD_NODE"));
    }

    #[test]
    fn only_dev_builds_allow_the_dev_server_origin() {
        let spec = launch_spec(env_of(&[]), true);
        assert_eq!(env_value(&spec, "GENTLE_DOT_ALLOWED_ORIGINS"), Some(DEV_ALLOWED_ORIGINS));
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
