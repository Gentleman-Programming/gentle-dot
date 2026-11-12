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
#[cfg(feature = "local-preview")]
mod preview;
#[cfg(all(feature = "local-preview", not(windows)))]
compile_error!("local-preview is qualified for Windows only");
pub mod secure_store;
mod shell;
pub mod shortcut;
pub mod status;
pub mod voice;
#[cfg(windows)]
mod windows_process;

pub use shell::run;
