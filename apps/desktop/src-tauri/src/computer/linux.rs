//! Native Linux/Wayland backend (T3a-T3b1, S1-S4): bounded transport,
//! protocol capability discovery, and bounded `wl_output` plus
//! `zxdg_output_v1` monitor enumeration against a stock Wayland compositor.
//!
//! Discovery and enumeration only: this module never binds input (virtual
//! pointer/keyboard) globals, starts no backend, and performs no input work
//! (T4). Capture ([`capture`]) binds only the screencopy manager, `wl_shm`,
//! and the one selected output, and returns JPEG bytes plus validated
//! geometry; there is no production startup, no UI, and no cursor or primary
//! claims anywhere in this module.
//! deadline and a cooperative [`transport::CancelHandle`]; there is no
//! unbounded connect or roundtrip anywhere in this module. Ambient
//! `WAYLAND_SOCKET` adoption is refused (shared protocol stream); fake-peer
//! discovery and enumeration are tested, while sweeps against a real
//! compositor are still untested.

pub mod capabilities;
pub mod capture;
pub mod geometry;
pub mod outputs;
pub mod pixels;
pub mod transport;

#[cfg(test)]
mod capture_tests;

#[cfg(test)]
mod geometry_tests;

#[cfg(test)]
mod output_tests;

#[cfg(test)]
mod tests;
