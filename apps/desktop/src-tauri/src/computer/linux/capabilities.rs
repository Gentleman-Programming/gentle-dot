//! Pure capability negotiation over advertised Wayland globals (T3a, S3-S4).
//!
//! No compositor-name inference: a capability is present only when the
//! compositor advertises its interface, and anything absent fails closed with
//! the interface name as the reason. Version caps below are the versions T3b/T4
//! will bind at, verified against the vendored protocol XML (wayland.xml and
//! the wlr/misc protocol sources); negotiation takes the minimum of advertised
//! and cap so newer compositors keep working.

/// Core `wl_shm` versions we bind at (reference binds v1; enough for T3b pools).
pub const WL_SHM_MAX: u32 = 1;
/// `wl_seat` versions we bind at (reference binds v7; protocol max is 11).
pub const WL_SEAT_MAX: u32 = 7;
/// `wl_output` versions we bind at (protocol max is 4).
pub const WL_OUTPUT_MAX: u32 = 4;
/// `zxdg_output_manager_v1` versions we bind at (protocol max is 3).
pub const XDG_OUTPUT_MANAGER_MAX: u32 = 3;
/// `zwlr_virtual_pointer_manager_v1` versions we bind at (protocol max is 2).
pub const VIRTUAL_POINTER_MAX: u32 = 2;
/// `zwp_virtual_keyboard_manager_v1` versions we bind at (protocol max is 1).
pub const VIRTUAL_KEYBOARD_MAX: u32 = 1;
/// `zwlr_screencopy_manager_v1` versions we bind at (protocol max is 3).
pub const SCREENCOPY_MAX: u32 = 3;

/// Advertised interface names, exactly as they appear on `wl_registry`.
pub const WL_SHM: &str = "wl_shm";
pub const WL_SEAT: &str = "wl_seat";
pub const WL_OUTPUT: &str = "wl_output";
pub const XDG_OUTPUT_MANAGER: &str = "zxdg_output_manager_v1";
pub const VIRTUAL_POINTER: &str = "zwlr_virtual_pointer_manager_v1";
pub const VIRTUAL_KEYBOARD: &str = "zwp_virtual_keyboard_manager_v1";
pub const SCREENCOPY: &str = "zwlr_screencopy_manager_v1";

/// One `wl_registry.global` advertisement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdvertisedGlobal {
    pub name: u32,
    pub interface: String,
    pub version: u32,
}

/// An advertised global bound at a version both sides support.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NegotiatedGlobal {
    pub name: u32,
    pub advertised: u32,
    pub negotiated: u32,
}

/// Which globals a stock compositor offers, with negotiated bind versions.
/// Singletons keep the highest advertised version; `outputs` keeps every
/// advertised `wl_output` (one per physical output).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CapabilitySnapshot {
    pub shm: Option<NegotiatedGlobal>,
    pub seat: Option<NegotiatedGlobal>,
    pub outputs: Vec<NegotiatedGlobal>,
    pub xdg_output_manager: Option<NegotiatedGlobal>,
    pub virtual_pointer: Option<NegotiatedGlobal>,
    pub virtual_keyboard: Option<NegotiatedGlobal>,
    pub screencopy: Option<NegotiatedGlobal>,
}

/// A truthful missing-capability error: names the interface, never a
/// compositor guess, so other compositors fail clearly instead of silently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityError {
    pub interface: &'static str,
    pub detail: String,
}

impl std::fmt::Display for CapabilityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "compositor does not advertise {} ({})",
            self.interface, self.detail
        )
    }
}

impl std::error::Error for CapabilityError {}

impl CapabilitySnapshot {
    /// Fold raw registry advertisements into negotiated capabilities.
    pub fn negotiate(advertised: &[AdvertisedGlobal]) -> Self {
        let mut snapshot = Self::default();
        // Highest advertised version wins each singleton; binding takes the
        // minimum of that and the cap, so newer compositors keep working.
        let keep = |slot: &mut Option<NegotiatedGlobal>, global: &AdvertisedGlobal, cap: u32| {
            let negotiated = NegotiatedGlobal {
                name: global.name,
                advertised: global.version,
                negotiated: global.version.min(cap),
            };
            if slot.is_none_or(|current| current.advertised < global.version) {
                *slot = Some(negotiated);
            }
        };
        for global in advertised {
            match global.interface.as_str() {
                WL_SHM => keep(&mut snapshot.shm, global, WL_SHM_MAX),
                WL_SEAT => keep(&mut snapshot.seat, global, WL_SEAT_MAX),
                WL_OUTPUT => snapshot.outputs.push(NegotiatedGlobal {
                    name: global.name,
                    advertised: global.version,
                    negotiated: global.version.min(WL_OUTPUT_MAX),
                }),
                XDG_OUTPUT_MANAGER => {
                    keep(&mut snapshot.xdg_output_manager, global, XDG_OUTPUT_MANAGER_MAX);
                }
                VIRTUAL_POINTER => keep(&mut snapshot.virtual_pointer, global, VIRTUAL_POINTER_MAX),
                VIRTUAL_KEYBOARD => {
                    keep(&mut snapshot.virtual_keyboard, global, VIRTUAL_KEYBOARD_MAX);
                }
                SCREENCOPY => keep(&mut snapshot.screencopy, global, SCREENCOPY_MAX),
                _ => {}
            }
        }
        snapshot
    }

    /// Singleton capability by interface name (`wl_output` yields the first
    /// output; use [`CapabilitySnapshot::outputs`] for all of them).
    pub fn get(&self, interface: &str) -> Option<NegotiatedGlobal> {
        match interface {
            WL_SHM => self.shm,
            WL_SEAT => self.seat,
            WL_OUTPUT => self.outputs.first().copied(),
            XDG_OUTPUT_MANAGER => self.xdg_output_manager,
            VIRTUAL_POINTER => self.virtual_pointer,
            VIRTUAL_KEYBOARD => self.virtual_keyboard,
            SCREENCOPY => self.screencopy,
            _ => None,
        }
    }

    /// Interface names this snapshot lacks, in discovery order.
    pub fn missing(&self) -> Vec<&'static str> {
        let mut missing = Vec::new();
        if self.shm.is_none() {
            missing.push(WL_SHM);
        }
        if self.seat.is_none() {
            missing.push(WL_SEAT);
        }
        if self.outputs.is_empty() {
            missing.push(WL_OUTPUT);
        }
        if self.xdg_output_manager.is_none() {
            missing.push(XDG_OUTPUT_MANAGER);
        }
        if self.virtual_pointer.is_none() {
            missing.push(VIRTUAL_POINTER);
        }
        if self.virtual_keyboard.is_none() {
            missing.push(VIRTUAL_KEYBOARD);
        }
        if self.screencopy.is_none() {
            missing.push(SCREENCOPY);
        }
        missing
    }

    /// The negotiated global for `interface`, or a truthful
    /// [`CapabilityError`] naming it when the compositor lacks it.
    pub fn require(&self, interface: &str) -> Result<NegotiatedGlobal, CapabilityError> {
        if let Some(found) = self.get(interface) {
            return Ok(found);
        }
        Err(CapabilityError {
            interface: canonical(interface),
            detail: format!("not advertised by this compositor (asked for {interface})"),
        })
    }
}

/// Map an interface name to its static form so errors never echo an
/// unexpected owned string as the label.
fn canonical(interface: &str) -> &'static str {
    match interface {
        WL_SHM => WL_SHM,
        WL_SEAT => WL_SEAT,
        WL_OUTPUT => WL_OUTPUT,
        XDG_OUTPUT_MANAGER => XDG_OUTPUT_MANAGER,
        VIRTUAL_POINTER => VIRTUAL_POINTER,
        VIRTUAL_KEYBOARD => VIRTUAL_KEYBOARD,
        SCREENCOPY => SCREENCOPY,
        _ => "unknown",
    }
}
