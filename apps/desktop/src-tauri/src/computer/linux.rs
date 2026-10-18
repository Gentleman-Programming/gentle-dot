//! Native Linux/Wayland backend (T3a, S1-S4): bounded transport plus protocol
//! capability discovery against a stock Wayland compositor.
//!
//! Discovery only: this module never binds input (virtual pointer/keyboard) or
//! capture (screencopy) globals, starts no backend, and performs no screenshot
//! or input work (T3b/T4). Every wait carries a total deadline and a
//! cooperative [`transport::CancelHandle`]; there is no unbounded connect or
//! roundtrip anywhere in this module. Ambient `WAYLAND_SOCKET` adoption is
//! refused (shared protocol stream); fake-peer discovery is tested, while a
//! sweep against a real compositor is still untested.

pub mod capabilities;
pub mod geometry;
pub mod transport;

#[cfg(test)]
mod geometry_tests;

#[cfg(test)]
mod tests;
