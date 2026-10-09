//! Native yes/no alerts owned by the app (NSAlert through the dialog plugin on macOS), never the
//! webview, whose default button is the safe one (L75 A2). NSAlert makes the first button the
//! default (Return, highlighted, rightmost), so the refusing button goes first and only a click
//! on the allowing button allows. Escape, closing, or aborting the alert refuses too.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

/// The two buttons of a yes/no alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Choice {
    pub allow: &'static str,
    pub refuse: &'static str,
}

impl Choice {
    /// The buttons in the plugin's order: the first one is the alert's default.
    pub fn buttons(&self) -> MessageDialogButtons {
        MessageDialogButtons::OkCancelCustom(self.refuse.into(), self.allow.into())
    }

    /// True only when the allowing button was pressed.
    pub fn allowed(&self, result: &MessageDialogResult) -> bool {
        self.allow != self.refuse && matches!(result, MessageDialogResult::Custom(label) if label == self.allow)
    }
}

/// Shows the alert and waits for the answer. Blocks, so it never runs on the main thread.
pub fn ask(app: &AppHandle, title: &str, message: &str, choice: Choice) -> bool {
    let result = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(choice.buttons())
        .blocking_show_with_result();
    choice.allowed(&result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHOICE: Choice = Choice { allow: "Allow", refuse: "Cancel" };

    #[test]
    fn the_refusing_button_comes_first_so_it_is_the_default() {
        match CHOICE.buttons() {
            MessageDialogButtons::OkCancelCustom(first, second) => {
                assert_eq!(first, "Cancel");
                assert_eq!(second, "Allow");
            }
            other => panic!("unexpected buttons: {other:?}"),
        }
    }

    #[test]
    fn only_the_allowing_button_allows() {
        assert!(CHOICE.allowed(&MessageDialogResult::Custom("Allow".into())));
        assert!(!CHOICE.allowed(&MessageDialogResult::Custom("Cancel".into())));
        assert!(!CHOICE.allowed(&MessageDialogResult::Custom("allow".into())));
        // Return on the default button, Escape, a closed or aborted alert.
        assert!(!CHOICE.allowed(&MessageDialogResult::Ok));
        assert!(!CHOICE.allowed(&MessageDialogResult::Yes));
        assert!(!CHOICE.allowed(&MessageDialogResult::Cancel));
        assert!(!CHOICE.allowed(&MessageDialogResult::No));
    }

    #[test]
    fn identical_labels_never_allow() {
        let same = Choice { allow: "OK", refuse: "OK" };
        assert!(!same.allowed(&MessageDialogResult::Custom("OK".into())));
    }
}
