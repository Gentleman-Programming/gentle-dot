use super::*;
use crate::niri::gate::*;

#[test]
fn native_follow_matches_the_mac_drag_settle_quiet() {
    // Native follow reanchors only after the same 300 ms drag-settle
    // quiet the mac snapper waits before re-snapping the Dot: the
    // debounce is defined once in niri.rs and must stay that interval.
    assert_eq!(crate::niri::FOLLOW_DEBOUNCE, DRAG_SETTLE);
    assert_eq!(crate::niri::FOLLOW_DEBOUNCE, Duration::from_millis(300));
}

#[test]
fn panel_capture_needs_mapped_size_and_shown_state_not_origin() {
    // A genuine (0, 0) origin is valid; a never-mapped 0x0 frame is not.
    assert!(panel_capture_valid(true, false, 420, 640, true));
    assert!(panel_capture_valid(true, false, 420, 640, true));
    assert!(!panel_capture_valid(true, false, 0, 0, true));
    assert!(!panel_capture_valid(true, false, 420, 0, true));
    assert!(!panel_capture_valid(true, false, 0, 640, true));
    // Startup bogus rect: never shown, never accepted even with size.
    assert!(!panel_capture_valid(true, false, 420, 640, false));
    // Fullscreen and native Wayland coordinates are not authoritative.
    assert!(!panel_capture_valid(true, true, 420, 640, true));
    assert!(!panel_capture_valid(false, false, 420, 640, true));
}
