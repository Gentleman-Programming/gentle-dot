//! What UI Automation reports about an element, in the Accessibility terms the risk check reads
//! (S24.4 on Windows). Plain mapping, tested on every OS; `win` reads the elements.
//!
//! A control type becomes the macOS role with the same meaning (a Button is `AXButton`, a
//! Hyperlink `AXLink`, an Edit `AXTextField`). The element's name is its title, its help text
//! its description, and its value pattern's value its value. A dialog's default button is the
//! one whose legacy accessible state says so (`STATE_SYSTEM_DEFAULT`).

use super::risk::AxElement;

pub const UIA_BUTTON: i32 = 50000;
pub const UIA_CHECK_BOX: i32 = 50002;
pub const UIA_COMBO_BOX: i32 = 50003;
pub const UIA_EDIT: i32 = 50004;
pub const UIA_HYPERLINK: i32 = 50005;
pub const UIA_LIST_ITEM: i32 = 50007;
pub const UIA_MENU_ITEM: i32 = 50011;
pub const UIA_RADIO_BUTTON: i32 = 50013;
pub const UIA_TAB_ITEM: i32 = 50019;
pub const UIA_TEXT: i32 = 50020;
pub const UIA_GROUP: i32 = 50026;
pub const UIA_DOCUMENT: i32 = 50030;
pub const UIA_SPLIT_BUTTON: i32 = 50031;
pub const UIA_WINDOW: i32 = 50032;
pub const UIA_PANE: i32 = 50033;

/// `STATE_SYSTEM_DEFAULT`: the button Return presses in its dialog.
pub const STATE_SYSTEM_DEFAULT: u32 = 0x100;

/// The Accessibility role for a UI Automation control type.
pub fn role(control_type: i32) -> &'static str {
    match control_type {
        UIA_BUTTON => "AXButton",
        UIA_SPLIT_BUTTON => "AXMenuButton",
        UIA_MENU_ITEM => "AXMenuItem",
        UIA_HYPERLINK => "AXLink",
        UIA_EDIT => "AXTextField",
        UIA_DOCUMENT => "AXTextArea",
        UIA_COMBO_BOX => "AXComboBox",
        UIA_CHECK_BOX => "AXCheckBox",
        UIA_RADIO_BUTTON => "AXRadioButton",
        UIA_TAB_ITEM => "AXTab",
        UIA_LIST_ITEM => "AXRow",
        UIA_TEXT => "AXStaticText",
        UIA_GROUP | UIA_PANE => "AXGroup",
        UIA_WINDOW => "AXWindow",
        _ => "AXUnknown",
    }
}

/// Whether a legacy accessible state marks the default button.
pub fn is_default(state: u32) -> bool {
    state & STATE_SYSTEM_DEFAULT != 0
}

/// An element from what UI Automation reports; blank strings count as absent.
pub fn element(control_type: i32, name: Option<String>, help: Option<String>, value: Option<String>) -> AxElement {
    let present = |text: Option<String>| text.filter(|t| !t.trim().is_empty());
    AxElement { role: role(control_type).into(), title: present(name), description: present(help), value: present(value) }
}

/// What the risk check gets for an element UI Automation does not report, or Gentle Dot's own
/// (its click-through glow) while another app owns the window there: an element that cannot be
/// read stands in for it and asks for a confirmation, so a risky action is never let through unseen.
pub fn unreadable() -> AxElement {
    AxElement {
        role: role(UIA_BUTTON).into(),
        title: Some("an element Gentle Dot cannot read; confirm to act on it".into()),
        description: None,
        value: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::risk::{assess, Act, Focus};

    fn named(control_type: i32, name: &str) -> AxElement {
        element(control_type, Some(name.into()), None, None)
    }

    #[test]
    fn pressable_controls_get_the_roles_a_click_can_press() {
        assert_eq!(role(UIA_BUTTON), "AXButton");
        assert_eq!(role(UIA_SPLIT_BUTTON), "AXMenuButton");
        assert_eq!(role(UIA_MENU_ITEM), "AXMenuItem");
        assert_eq!(role(UIA_HYPERLINK), "AXLink");
    }

    #[test]
    fn text_inputs_get_the_field_roles() {
        assert_eq!(role(UIA_EDIT), "AXTextField");
        assert_eq!(role(UIA_DOCUMENT), "AXTextArea");
        assert_eq!(role(UIA_COMBO_BOX), "AXComboBox");
    }

    #[test]
    fn other_controls_keep_roles_that_are_neither_pressable_nor_fields() {
        for (control_type, expected) in [
            (UIA_CHECK_BOX, "AXCheckBox"), (UIA_RADIO_BUTTON, "AXRadioButton"), (UIA_TAB_ITEM, "AXTab"),
            (UIA_LIST_ITEM, "AXRow"), (UIA_TEXT, "AXStaticText"), (UIA_GROUP, "AXGroup"), (UIA_PANE, "AXGroup"),
            (UIA_WINDOW, "AXWindow"), (12345, "AXUnknown"),
        ] {
            assert_eq!(role(control_type), expected, "{control_type}");
        }
    }

    #[test]
    fn blank_strings_are_absent_and_the_rest_is_kept_as_reported() {
        let e = element(UIA_BUTTON, Some(" Send ".into()), Some("  ".into()), Some(String::new()));
        assert_eq!(e, AxElement { role: "AXButton".into(), title: Some(" Send ".into()), description: None, value: None });
        let e = element(UIA_EDIT, None, Some("Type a message".into()), Some("hola".into()));
        assert_eq!((e.title, e.description.as_deref(), e.value.as_deref()), (None, Some("Type a message"), Some("hola")));
    }

    #[test]
    fn only_the_default_state_bit_marks_the_default_button() {
        assert!(is_default(STATE_SYSTEM_DEFAULT));
        assert!(is_default(STATE_SYSTEM_DEFAULT | 0x4 | 0x100000));
        assert!(!is_default(0));
        assert!(!is_default(0x4 | 0x100000));
    }

    #[test]
    fn clicking_a_windows_send_button_or_buy_link_needs_a_confirmation() {
        assert!(assess(Act::Click(&[named(UIA_BUTTON, "Send")]), None).is_some());
        assert!(assess(Act::Click(&[named(UIA_HYPERLINK, "Comprar ahora")]), None).is_some());
        // The words inside a button count, as on macOS: text under the pointer, then the button.
        let chain = [named(UIA_TEXT, "Delete"), element(UIA_BUTTON, None, None, None)];
        assert!(assess(Act::Click(&chain), None).is_some());
        assert!(assess(Act::Click(&[named(UIA_BUTTON, "Open")]), None).is_none());
        assert!(assess(Act::Click(&[named(UIA_CHECK_BOX, "Send me news")]), None).is_none(), "a check box is not pressed");
    }

    #[test]
    fn clicking_what_cannot_be_read_under_the_glow_needs_a_confirmation() {
        let reason = assess(Act::Click(&[unreadable()]), None).expect("a confirmation");
        assert!(reason.contains("Gentle Dot cannot read"), "{reason}");
        assert!(assess(Act::Drag(&[named(UIA_TEXT, "x")], &[unreadable()]), None).is_some());
    }

    #[test]
    fn return_in_a_windows_chat_box_or_on_a_default_button_needs_a_confirmation() {
        let chat = Focus { element: named(UIA_EDIT, "Message #general"), ..Focus::default() };
        assert!(assess(Act::Return(Some(&chat)), None).is_some());
        let default = Focus { element: named(UIA_BUTTON, "OK"), is_default_button: true, default_button: None };
        assert!(assess(Act::Return(Some(&default)), None).is_some());
        let note = Focus { element: named(UIA_DOCUMENT, "Untitled - Notepad"), ..Focus::default() };
        assert!(assess(Act::Return(Some(&note)), None).is_none());
    }
}
