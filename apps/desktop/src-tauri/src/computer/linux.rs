//! Native Linux/Wayland backend (T3a-T4b, S1-S5): bounded transport,
//! protocol capability discovery, bounded `wl_output` plus
//! `zxdg_output_v1` monitor enumeration, bounded full-output screencopy
//! capture, bounded virtual-pointer actions, and bounded virtual-keyboard
//! input against a stock Wayland compositor.
//!
//! Discovery, enumeration, capture, pointer and keyboard input only, plus
//! the first internal adapter slice ([`desktop`]: selection, cancellation
//! and fan-out over an injected backend), bounded screenshot
//! normalization ([`normalize`]), and the app surface ([`apps`]: the Niri
//! running-window inventory and the GIO trusted desktop-entry launcher,
//! T5a/S7): this module binds no output beyond the
//! selected one, starts no backend, performs no production startup or UI
//! work, and wires no helper. Keyboard operations
//! ([`keyboard`]) bind only the virtual-keyboard manager, one `wl_seat`,
//! and the uploaded keymap fd; pointer ([`pointer`]) and capture
//! ([`capture`]) bind their own globals per operation through exclusive
//! connections. There is no cursor or primary claim anywhere here.
//! deadline and a cooperative [`transport::CancelHandle`]; there is no
//! unbounded connect or roundtrip anywhere in this module. Ambient
//! `WAYLAND_SOCKET` adoption is refused (shared protocol stream); fake-peer
//! discovery and enumeration are tested, while sweeps against a real
//! compositor are still untested.

pub mod apps;
pub mod backend;
pub mod capabilities;
pub mod capture;
pub mod desktop;
#[cfg(target_os = "linux")]
pub mod dialogs;
pub mod focus;
#[cfg(all(test, target_os = "linux"))]
mod dialogs_tests;
pub mod geometry;
pub mod keyboard;
pub mod keymap;
pub mod normalize;
pub mod outputs;
pub mod pixels;
pub mod pointer;
pub mod transport;
#[cfg(target_os = "linux")]
pub mod working;

#[cfg(all(test, target_os = "linux"))]
mod working_tests;

#[cfg(test)]
mod apps_tests;

#[cfg(test)]
mod backend_tests;

#[cfg(test)]
mod capture_tests;

#[cfg(test)]
mod desktop_tests;

#[cfg(test)]
mod focus_tests;

#[cfg(test)]
mod geometry_tests;

#[cfg(test)]
mod keyboard_tests;

#[cfg(test)]
mod keymap_tests;

#[cfg(test)]
mod normalize_tests;

#[cfg(test)]
mod output_tests;

#[cfg(test)]
mod pointer_tests;

#[cfg(test)]
mod tests;
