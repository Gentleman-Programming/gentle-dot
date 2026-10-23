//! Temporary seam of the Windows port (gentle-dot#89). `daemon.rs` spawns the daemon with Unix
//! primitives (fd 3, signals, file modes); its Windows side lands later in the chain and replaces
//! this file. Until then the shell builds and opens on Windows, and every start fails with
//! [`UNAVAILABLE`] instead of spawning anything.

use crate::app_channel::{AppChannel, Handler};
use crate::health::check_health;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const HEALTH_TIMEOUT: Duration = Duration::from_millis(300);

/// Why the assistant does not start on Windows yet.
pub const UNAVAILABLE: &str = "The Gentle Dot assistant does not run on Windows yet.";

/// Same message as the Unix build: one the app did not launch holds the port.
pub fn foreign_daemon_message(port: u16) -> String {
    format!(
        "Another Gentle Dot assistant is already running on port {port}, and this app did not start it \
(for example `pnpm dev`, or one left running by an older version of the app). Gentle Dot only uses an \
assistant it started itself, so connectors stay safe. Stop the other one (press Ctrl+C where `pnpm dev` \
runs, or quit the process listening on port {port}), then choose \"Restart assistant\" in the Gentle Dot menu."
    )
}

/// Where a bundled runtime would live, as on Unix.
pub fn runtime_dir(env: impl Fn(&str) -> Option<String>, resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    env("GENTLE_DOT_RUNTIME_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| resource_dir.map(|dir| dir.join("runtime")))
}

#[derive(Debug, PartialEq, Eq)]
pub enum RestartOutcome {
    Restarted,
    /// The daemon answers but was not started by this app.
    External,
    Failed(String),
}

/// The Unix `Daemon`'s interface, without a daemon behind it.
pub struct Daemon {
    port: u16,
}

impl Daemon {
    pub fn new(port: u16, _data_dir: PathBuf, _runtime_dir: Option<PathBuf>) -> Self {
        Self { port }
    }

    pub fn with_channel(self, _handler: Arc<dyn Handler>) -> Self {
        self
    }

    pub fn on_ready(self, _ready: Arc<dyn Fn() + Send + Sync>) -> Self {
        self
    }

    pub fn channel(&self) -> Option<Arc<AppChannel>> {
        None
    }

    pub fn is_healthy(&self) -> bool {
        check_health(self.port, HEALTH_TIMEOUT)
    }

    /// This app never launches a daemon here, so it would refuse any on the port.
    pub fn refusal(&self) -> Option<String> {
        None
    }

    pub fn wait_ready(&self, _timeout: Duration) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    pub fn wait_healthy(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.is_healthy() {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        false
    }

    pub fn ensure_running(&self, _timeout: Duration) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    pub fn owns_running(&self) -> bool {
        false
    }

    pub fn stop(&self) {}

    pub fn restart(&self, _timeout: Duration) -> RestartOutcome {
        RestartOutcome::Failed(UNAVAILABLE.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_start_fails_with_the_unavailable_message() {
        let daemon = Daemon::new(0, PathBuf::new(), None);
        assert_eq!(daemon.ensure_running(Duration::ZERO), Err(UNAVAILABLE.to_string()));
        assert_eq!(daemon.wait_ready(Duration::ZERO), Err(UNAVAILABLE.to_string()));
        assert_eq!(daemon.restart(Duration::ZERO), RestartOutcome::Failed(UNAVAILABLE.to_string()));
        assert!(daemon.channel().is_none());
        assert!(!daemon.owns_running());
    }
}
