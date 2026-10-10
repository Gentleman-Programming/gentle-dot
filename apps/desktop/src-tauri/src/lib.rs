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
#[cfg(target_os = "linux")]
pub mod niri;
pub mod platform;
pub mod position;
pub mod secure_store;
mod shell;
pub mod shortcut;
pub mod status;
pub mod voice;

pub use shell::run;
