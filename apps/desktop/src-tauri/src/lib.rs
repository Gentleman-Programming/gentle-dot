pub mod alert;
pub mod app_channel;
pub mod approvals;
pub mod computer;
pub mod config;
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
#[cfg(windows)]
mod windows_process;

#[cfg(windows)]
pub(crate) mod windows_smoke;
#[cfg(all(windows, feature = "windows-smoke-test", not(debug_assertions)))]
compile_error!("windows-smoke-test is development-only; omit it from release builds");

pub use shell::run;
