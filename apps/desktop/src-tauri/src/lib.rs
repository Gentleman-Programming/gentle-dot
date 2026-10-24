pub mod alert;
pub mod app_channel;
pub mod approvals;
pub mod computer;
pub mod config;
#[cfg(unix)]
pub mod daemon;
// Temporary seam of the Windows port (gentle-dot#89): the daemon lifecycle is Unix only until its
// Windows side lands, so on Windows the shell starts with an assistant that refuses to start.
#[cfg(windows)]
#[path = "daemon_unavailable.rs"]
pub mod daemon;
#[cfg(target_os = "macos")]
pub mod disclaimed;
pub mod geometry;
pub mod health;
pub mod platform;
pub mod position;
pub mod secure_store;
mod shell;
pub mod shortcut;
pub mod status;
pub mod voice;

pub use shell::run;
