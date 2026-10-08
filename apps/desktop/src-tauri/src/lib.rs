pub mod computer;
pub mod config;
pub mod daemon;
pub mod geometry;
pub mod health;
pub mod platform;
pub mod position;
mod shell;
pub mod status;

pub use shell::run;
