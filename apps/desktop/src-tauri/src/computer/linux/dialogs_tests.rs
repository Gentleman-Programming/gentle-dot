//! Linux dialog checks (T5c, S1-S5): the exact desktop-global policy copy
//! and refusing defaults. The live plugin dialog needs an app handle, so
//! these pin the copy and the choices the implementation asks with — never
//! a webview, never an allowing default. Deterministic, no compositor.

use super::dialogs::{CONFIRM_CHOICE, GRANT_CHOICE, YOLO_CHOICE, YOLO_TEXT};
use crate::computer::{GLOBAL_CONFIRM_REASON, GLOBAL_GRANT_TEXT, GLOBAL_TARGET};

#[test]
fn the_grant_copy_names_the_linux_desktop_without_per_app_exclusion() {
    assert!(GLOBAL_GRANT_TEXT.contains("Linux desktop"), "{GLOBAL_GRANT_TEXT}");
    assert!(GLOBAL_GRANT_TEXT.contains("30 minutes"), "{GLOBAL_GRANT_TEXT}");
    assert!(GLOBAL_GRANT_TEXT.contains("no reliable per-app exclusion"), "{GLOBAL_GRANT_TEXT}");
    assert!(!GLOBAL_GRANT_TEXT.contains("Mac"), "{GLOBAL_GRANT_TEXT}");
}

#[test]
fn the_confirm_reason_names_no_reliable_exclusion() {
    assert!(GLOBAL_CONFIRM_REASON.contains("no reliable per-app exclusion"), "{GLOBAL_CONFIRM_REASON}");
    assert!(GLOBAL_TARGET.contains("Linux"), "{GLOBAL_TARGET}");
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
