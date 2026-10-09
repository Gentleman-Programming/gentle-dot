//! Native yes/no alerts owned by the app, never the webview, whose default button is the safe one
//! (L75 A2). Only a click on the allowing button allows: the refusing button, Return, Escape,
//! closing, aborting, an alert that cannot be shown, and any answer not recognized here refuse.
//!
//! macOS: an `NSAlert` run modally on the main thread, asked from a worker thread that waits for
//! the answer. The refusing button is added first (`NSAlertFirstButtonReturn`) with Return as its
//! key equivalent; the allowing button is second and has none, so no key allows. Only the second
//! button's response allows; `abortModal` (the approvals' stale-dialog dismissal) answers
//! `NSModalResponseAbort`, which refuses. The dialog plugin is not used there: with no parent window
//! rfd shows a `CFUserNotification` and reports cancels and failures as `Cancel`, which the plugin
//! turns into the second label of `OkCancelCustom` (T23c B1).
//!
//! Elsewhere (Linux): the dialog plugin with the allowing label in the OK slot and the refusing one
//! in the cancel slot, so every outcome rfd reports as `Cancel` (the refusing button, Escape,
//! closing, a dialog that failed) arrives as the refusing label. rfd's GTK dialog sets no default
//! response, so Return does not pick the allowing button either (not verified on a Linux desktop).

use tauri::AppHandle;
use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogResult};

/// The `NSAlert` response of the refusing button, added first (`NSAlertFirstButtonReturn`).
pub const REFUSE_RESPONSE: isize = 1000;
/// The `NSAlert` response of the allowing button, added second (`NSAlertSecondButtonReturn`).
pub const ALLOW_RESPONSE: isize = 1001;

/// The two buttons of a yes/no alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Choice {
    pub allow: &'static str,
    pub refuse: &'static str,
}

impl Choice {
    /// The `NSAlert` buttons in the order they are added: the first is the default (Return).
    pub fn alert_buttons(&self) -> [&'static str; 2] {
        [self.refuse, self.allow]
    }

    /// True only for the allowing button's response; `None` is an alert that never ran.
    pub fn allows_response(&self, response: Option<isize>) -> bool {
        self.allow != self.refuse && response == Some(ALLOW_RESPONSE)
    }

    /// The plugin's buttons (off macOS): the refusing label takes the cancel slot, where rfd puts
    /// Escape, closing, and failures.
    pub fn buttons(&self) -> MessageDialogButtons {
        MessageDialogButtons::OkCancelCustom(self.allow.into(), self.refuse.into())
    }

    /// True only when the plugin reports the allowing button itself.
    pub fn allowed(&self, result: &MessageDialogResult) -> bool {
        self.allow != self.refuse && matches!(result, MessageDialogResult::Custom(label) if label == self.allow)
    }
}

/// Shows the alert and waits for the answer. Blocks, so it never runs on the main thread (there it
/// refuses at once).
pub fn ask(app: &AppHandle, title: &str, message: &str, choice: Choice) -> bool {
    #[cfg(target_os = "macos")]
    return macos::ask(app, title, message, choice);
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
        let result = app
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(choice.buttons())
            .blocking_show_with_result();
        choice.allowed(&result)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::Choice;
    use objc2_app_kit::{NSAlert, NSAlertStyle, NSApplication};
    use objc2_foundation::{MainThreadMarker, NSString};
    use tauri::AppHandle;

    pub fn ask(app: &AppHandle, title: &str, message: &str, choice: Choice) -> bool {
        if MainThreadMarker::new().is_some() {
            eprintln!("gentle-dot: a confirmation was asked on the main thread, so it was refused");
            return false;
        }
        let (answer, answered) = std::sync::mpsc::channel();
        let (title, message) = (title.to_owned(), message.to_owned());
        let scheduled = app.run_on_main_thread(move || {
            let response = MainThreadMarker::new().map(|mtm| run(mtm, &title, &message, choice));
            let _ = answer.send(response);
        });
        if scheduled.is_err() {
            return false;
        }
        // The task dropped without running (the app is quitting) reads as no answer.
        choice.allows_response(answered.recv().ok().flatten())
    }

    fn run(mtm: MainThreadMarker, title: &str, message: &str, choice: Choice) -> isize {
        let alert = NSAlert::new(mtm);
        alert.setAlertStyle(NSAlertStyle::Warning);
        alert.setMessageText(&NSString::from_str(title));
        alert.setInformativeText(&NSString::from_str(message));
        let [refuse, allow] = choice.alert_buttons();
        alert.addButtonWithTitle(&NSString::from_str(refuse)).setKeyEquivalent(&NSString::from_str("\r"));
        alert.addButtonWithTitle(&NSString::from_str(allow)).setKeyEquivalent(&NSString::from_str(""));
        // Gentle Dot is an accessory app; without this the alert can open behind the front app.
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        alert.runModal()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHOICE: Choice = Choice { allow: "Allow", refuse: "Cancel" };

    #[test]
    fn only_the_allowing_buttons_response_allows_an_alert() {
        assert!(CHOICE.allows_response(Some(ALLOW_RESPONSE)));
        // The refusing button (also Return), an aborted alert (a stale one dismissed after the
        // timeout), a stopped or cancelled modal session, an OK nobody can press, a button that
        // does not exist, and an alert that never ran: every one refuses.
        for response in [Some(REFUSE_RESPONSE), Some(-1001), Some(-1000), Some(0), Some(1), Some(1002), Some(-1), None] {
            assert!(!CHOICE.allows_response(response), "{response:?}");
        }
        let same = Choice { allow: "OK", refuse: "OK" };
        assert!(!same.allows_response(Some(ALLOW_RESPONSE)));
    }

    #[test]
    fn the_refusing_button_is_added_first_so_it_is_the_default() {
        assert_eq!(CHOICE.alert_buttons(), ["Cancel", "Allow"]);
        assert_eq!((REFUSE_RESPONSE, ALLOW_RESPONSE), (1000, 1001));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(REFUSE_RESPONSE, objc2_app_kit::NSAlertFirstButtonReturn);
            assert_eq!(ALLOW_RESPONSE, objc2_app_kit::NSAlertSecondButtonReturn);
            assert_eq!(objc2_app_kit::NSModalResponseAbort, -1001);
        }
    }

    /// What tauri-plugin-dialog 2.8.1 returns for `OkCancelCustom(ok, cancel)` (desktop.rs:227-252):
    /// rfd's `Ok` becomes `Custom(ok)`, rfd's `Cancel` (Cancel, Escape, closing, a dialog that failed)
    /// becomes `Custom(cancel)`, anything else passes through.
    fn plugin_result(rfd_ok: Option<bool>, buttons: &MessageDialogButtons) -> MessageDialogResult {
        match (rfd_ok, buttons) {
            (Some(true), MessageDialogButtons::OkCancelCustom(ok, _)) => MessageDialogResult::Custom(ok.clone()),
            (Some(false), MessageDialogButtons::OkCancelCustom(_, cancel)) => MessageDialogResult::Custom(cancel.clone()),
            (Some(true), _) => MessageDialogResult::Ok,
            _ => MessageDialogResult::Cancel,
        }
    }

    #[test]
    fn with_the_plugin_cancelling_closing_or_failing_refuses() {
        let buttons = CHOICE.buttons();
        assert!(matches!(&buttons, MessageDialogButtons::OkCancelCustom(ok, cancel) if ok == "Allow" && cancel == "Cancel"));
        // Only the allowing button.
        assert!(CHOICE.allowed(&plugin_result(Some(true), &buttons)));
        // The refusing button, Escape, closing, and failures all arrive as rfd's Cancel.
        assert!(!CHOICE.allowed(&plugin_result(Some(false), &buttons)));
        for result in [
            MessageDialogResult::Ok,
            MessageDialogResult::Cancel,
            MessageDialogResult::Yes,
            MessageDialogResult::No,
            MessageDialogResult::Custom("allow".into()),
            MessageDialogResult::Custom("Cancel".into()),
            MessageDialogResult::Custom(String::new()),
        ] {
            assert!(!CHOICE.allowed(&result), "{result:?}");
        }
    }

    #[test]
    fn identical_labels_never_allow() {
        let same = Choice { allow: "OK", refuse: "OK" };
        assert!(!same.allowed(&MessageDialogResult::Custom("OK".into())));
    }
}
