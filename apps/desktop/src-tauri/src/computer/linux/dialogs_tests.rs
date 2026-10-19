//! Linux dialog checks (T5c, S1-S5): the exact desktop-global policy copy
//! and refusing defaults. The live plugin dialog needs an app handle, so
//! these pin the copy and the choices the implementation asks with — never
//! a webview, never an allowing default. Deterministic, no compositor.

use super::dialogs::{CONFIRM_CHOICE, GRANT_CHOICE, YOLO_CHOICE, YOLO_TEXT};
use crate::computer::GLOBAL_GRANT_TEXT;

#[test]
fn the_grant_copy_names_the_linux_desktop_without_per_app_exclusion() {
    assert!(GLOBAL_GRANT_TEXT.contains("Linux desktop"), "{GLOBAL_GRANT_TEXT}");
    assert!(GLOBAL_GRANT_TEXT.contains("30 minutes"), "{GLOBAL_GRANT_TEXT}");
    assert!(GLOBAL_GRANT_TEXT.contains("no reliable per-app exclusion"), "{GLOBAL_GRANT_TEXT}");
    assert!(!GLOBAL_GRANT_TEXT.contains("Mac"), "{GLOBAL_GRANT_TEXT}");
}

#[test]
fn every_linux_dialog_defaults_to_its_refusing_button() {
    for choice in [GRANT_CHOICE, CONFIRM_CHOICE, YOLO_CHOICE] {
        assert_eq!(choice.alert_buttons(), [choice.refuse, choice.allow]);
        assert!(!choice.allows_response(Some(crate::alert::REFUSE_RESPONSE)));
        assert!(!choice.allows_response(None));
    }
    assert_eq!(GRANT_CHOICE, crate::alert::Choice { allow: "Allow", refuse: "Deny" });
    assert_eq!(CONFIRM_CHOICE, crate::alert::Choice { allow: "Allow", refuse: "Cancel" });
    assert_eq!(YOLO_CHOICE, crate::alert::Choice { allow: "Turn On", refuse: "Cancel" });
}

#[test]
fn the_yolo_copy_matches_the_app_layer() {
    assert!(YOLO_TEXT.contains("yolo mode"), "{YOLO_TEXT}");
    assert!(YOLO_TEXT.contains("1 hour"), "{YOLO_TEXT}");
}

#[test]
fn the_linux_yolo_copy_names_the_stop_key_this_desktop_really_has() {
    // Whatever copy this platform's Yolo dialog asks with must name the Stop
    // binding the user actually has: the compositor-owned key the managed Niri
    // snippet writes. The Mac notation has no meaning here and must not leak in.
    assert!(!YOLO_TEXT.contains('⌥'), "the Mac notation reached the Linux dialog: {YOLO_TEXT}");
    assert!(
        YOLO_TEXT.contains(crate::niri::kdl_binds::STOP_KEY),
        "the Linux Stop key {:?} must be named: {YOLO_TEXT}",
        crate::niri::kdl_binds::STOP_KEY
    );
}
