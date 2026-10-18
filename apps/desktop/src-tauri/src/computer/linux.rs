//! Native Linux/Wayland backend (T3a-T4a, S1-S5): bounded transport,
//! protocol capability discovery, bounded `wl_output` plus
//! `zxdg_output_v1` monitor enumeration, bounded full-output screencopy
//! capture, and bounded virtual-pointer actions against a stock Wayland
//! compositor.
//!
//! Discovery, enumeration, capture and pointer input only: this module binds
//! no virtual-keyboard globals, starts no backend, and performs no keyboard
//! work (T4b). Capture ([`capture`]) binds only the screencopy manager,
//! `wl_shm`, and the one selected output; pointer ([`pointer`]) binds only
//! the virtual-pointer manager and the one selected output through
//! `create_virtual_pointer_with_output`. There is no production startup, no
//! UI, and no cursor or primary claims anywhere in this module.
//! deadline and a cooperative [`transport::CancelHandle`]; there is no
//! unbounded connect or roundtrip anywhere in this module. Ambient
//! `WAYLAND_SOCKET` adoption is refused (shared protocol stream); fake-peer
//! discovery and enumeration are tested, while sweeps against a real
//! compositor are still untested.

pub mod capabilities;
pub mod capture;
pub mod geometry;
pub mod keyboard;
pub mod keymap;
pub mod outputs;
pub mod pixels;
pub mod pointer;
pub mod transport;

#[cfg(test)]
mod capture_tests;

#[cfg(test)]
mod geometry_tests;

#[cfg(test)]
mod output_tests;

#[cfg(test)]
mod pointer_tests;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod keyboard_tests;

#[cfg(test)]
mod keymap_tests;
