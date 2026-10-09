pub mod computer;
pub mod config;
pub mod daemon;
#[cfg(target_os = "macos")]
pub mod disclaimed;
pub mod geometry;
pub mod health;
pub mod platform;
pub mod position;
mod shell;
pub mod status;
pub mod voice;

pub use shell::run;
