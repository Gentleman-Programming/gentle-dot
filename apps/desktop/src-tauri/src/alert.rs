//! Native yes/no alerts owned by the app, never the webview, whose default button is the safe one
//! (L75 A2). Refusing is the default: the refusing button, Return, Escape, closing, aborting, an
//! alert that cannot be shown, and any answer not recognized here refuse. Allowing takes choosing
//! the allowing button on purpose: a click, or where the platform lets the keyboard reach a button
//! (Windows, below), moving the focus to it first.
//!
//! macOS: an `NSAlert` run modally on the main thread, asked from a worker thread that waits for
//! the answer. The refusing button is added first (`NSAlertFirstButtonReturn`) with Return as its
//! key equivalent; the allowing button is second and has none, so no key allows. Only the second
//! button's response allows; `abortModal` (the approvals' stale-dialog dismissal) answers
//! `NSModalResponseAbort`, which refuses. The dialog plugin is not used there: with no parent window
//! rfd shows a `CFUserNotification` and reports cancels and failures as `Cancel`, which the plugin
//! turns into the second label of `OkCancelCustom` (T23c B1).
//!
//! Windows: a task dialog whose default button is the refusing one, so Return right after it opens
//! refuses; Escape and closing answer `IDCANCEL`, and only the allowing button's own id allows. The
//! keyboard can still choose the allowing button on purpose: moving the focus to it (Tab or the
//! arrow keys) and pressing Return or Space allows, as a click does, so the dialog works without a
//! mouse. The dialog plugin is
//! not used there: rfd's task dialog makes its first button (the OK slot, the allowing label) the
//! default, so Return would allow. It asks to be raised above the app being controlled when it
//! opens. Another thread can ask an `OpenDialog` to refuse its dialog (an approval that timed out,
//! as `abortModal` does on macOS): the dialog's own timer presses its refusing button, on its own
//! thread, so no other thread ever touches its window. A dialog given a deadline refuses itself
//! the same way once it passes, even when it opened after the timeout.
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

/// The Windows task dialog's button ids: the refusing one is the default.
pub const TASK_REFUSE_ID: i32 = 2000;
pub const TASK_ALLOW_ID: i32 = 2001;

/// A request to refuse the dialog on screen (Windows), set from another thread and acted on by
/// the dialog's own timer. Elsewhere it holds nothing: no other platform refuses a dialog this way.
#[derive(Default)]
pub struct OpenDialog(#[cfg(windows)] std::sync::atomic::AtomicBool);

impl OpenDialog {
    /// Asks the dialog on screen, if one is, to refuse (Windows; elsewhere nothing). Its next
    /// timer tick, within about 200 ms, presses its refusing button, and the dialog answers as
    /// refused.
    pub fn refuse(&self) {
        #[cfg(windows)]
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Whether a dialog's timer should press its refusing button now: a refusal was asked for, or
/// its deadline has passed.
pub fn refuse_due(requested: bool, deadline: Option<std::time::Instant>, now: std::time::Instant) -> bool {
    requested || deadline.is_some_and(|deadline| now >= deadline)
}

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

    /// True only for the allowing button's id (Windows); `None` is a dialog that never ran.
    pub fn allows_task_button(&self, button: Option<i32>) -> bool {
        self.allow != self.refuse && button == Some(TASK_ALLOW_ID)
    }

    /// The plugin's buttons (Linux): the refusing label takes the cancel slot, where rfd puts
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
    ask_tracked(app, title, message, choice, None, None)
}

/// `ask`, letting `open` refuse the dialog from another thread (`OpenDialog::refuse`), and refusing
/// it by itself once `deadline` passes (Windows).
pub fn ask_tracked(
    app: &AppHandle,
    title: &str,
    message: &str,
    choice: Choice,
    open: Option<&OpenDialog>,
    deadline: Option<std::time::Instant>,
) -> bool {
    #[cfg(target_os = "macos")]
    {
        let _ = (open, deadline);
        return macos::ask(app, title, message, choice);
    }
    #[cfg(windows)]
    {
        let _ = app;
        windows::ask(title, message, choice, open, deadline)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (open, deadline);
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

#[cfg(windows)]
mod windows {
    use super::{refuse_due, Choice, OpenDialog, TASK_ALLOW_ID, TASK_REFUSE_ID};
    use std::sync::atomic::Ordering;
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;
    use windows_sys::core::HRESULT;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows_sys::Win32::UI::Controls::{
        TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
        TDF_CALLBACK_TIMER, TDF_SIZE_TO_CONTENT, TDM_CLICK_BUTTON, TDN_CREATED, TDN_TIMER,
        TD_WARNING_ICON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        PostMessageW, SetForegroundWindow, SetWindowDisplayAffinity, SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, WDA_EXCLUDEFROMCAPTURE,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// What the callback is given: where a refusal is asked for, and when to refuse by itself.
    struct Watch<'a> {
        open: Option<&'a OpenDialog>,
        deadline: Option<std::time::Instant>,
    }

    /// Called only from the dialog's own callback, where `hwnd` is its live window.
    fn press_refuse(hwnd: HWND) {
        // SAFETY: a plain message to the dialog's live window.
        if unsafe { PostMessageW(hwnd, TDM_CLICK_BUTTON as u32, TASK_REFUSE_ID as WPARAM, 0) } == 0 {
            eprintln!("gentle-dot: a dialog could not be refused: {}", std::io::Error::last_os_error());
        }
    }

    /// Asks for the dialog to be raised above the app being controlled, which holds the
    /// foreground, and presses its refusing button when a refusal was asked for or its deadline
    /// passed (the timer ticks about every 200 ms). Everything here runs on the dialog's thread,
    /// during a notification, while its window is alive.
    unsafe extern "system" fn on_event(hwnd: HWND, notification: u32, _: WPARAM, _: LPARAM, data: isize) -> HRESULT {
        // SAFETY: `data` is the `Watch` borrowed by `ask`, alive for the whole dialog.
        let watch = unsafe { &*(data as *const Watch) };
        if notification == TDN_TIMER as u32 {
            let requested = watch.open.is_some_and(|open| open.0.load(Ordering::SeqCst));
            if refuse_due(requested, watch.deadline, std::time::Instant::now()) {
                press_refuse(hwnd);
            }
        }
        if notification == TDN_CREATED as u32 {
            // SAFETY: `hwnd` is the dialog's live window during the notification.
            unsafe {
                SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                SetForegroundWindow(hwnd);
                // Like Gentle Dot's other windows, kept out of computer-control screenshots.
                if SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) == 0 {
                    eprintln!("gentle-dot: a dialog may show in computer-control screenshots");
                }
            }
        }
        0
    }

    pub fn ask(
        title: &str,
        message: &str,
        choice: Choice,
        open: Option<&OpenDialog>,
        deadline: Option<std::time::Instant>,
    ) -> bool {
        // A refusal asked for an earlier dialog is not this one's. One asked for while this dialog
        // was still opening is only lost when the approval already timed out, and then its
        // deadline has passed, so the first tick refuses.
        if let Some(open) = open {
            open.0.store(false, Ordering::SeqCst);
        }
        let watch = Watch { open, deadline };
        let (title, message) = (wide(title), wide(message));
        let (allow, refuse) = (wide(choice.allow), wide(choice.refuse));
        let buttons = [
            TASKDIALOG_BUTTON { nButtonID: TASK_ALLOW_ID, pszButtonText: allow.as_ptr() },
            TASKDIALOG_BUTTON { nButtonID: TASK_REFUSE_ID, pszButtonText: refuse.as_ptr() },
        ];
        // SAFETY: every pointer in the config outlives the modal call that reads it.
        unsafe {
            let mut config: TASKDIALOGCONFIG = zeroed();
            config.cbSize = size_of::<TASKDIALOGCONFIG>() as u32;
            config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT;
            if deadline.is_some() || open.is_some() {
                config.dwFlags |= TDF_CALLBACK_TIMER;
            }
            config.pszWindowTitle = title.as_ptr();
            config.pszContent = message.as_ptr();
            config.Anonymous1.pszMainIcon = TD_WARNING_ICON;
            config.cButtons = buttons.len() as u32;
            config.pButtons = buttons.as_ptr();
            config.nDefaultButton = TASK_REFUSE_ID;
            config.pfCallback = Some(on_event);
            config.lpCallbackData = &watch as *const Watch as isize;
            let mut pressed = 0i32;
            let shown = TaskDialogIndirect(&config, &mut pressed, null_mut(), null_mut());
            choice.allows_task_button((shown >= 0).then_some(pressed))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHOICE: Choice = Choice { allow: "Allow", refuse: "Cancel" };

    // A task dialog needs the common controls v6 that the app's manifest declares; the test
    // executable has none (it would not even start), so refusing a dialog on screen is checked
    // in the app itself.

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
    fn a_dialogs_timer_refuses_when_asked_or_once_its_deadline_passes() {
        let now = std::time::Instant::now();
        let second = std::time::Duration::from_secs(1);
        assert!(!refuse_due(false, None, now));
        assert!(!refuse_due(false, Some(now + second), now));
        assert!(refuse_due(false, Some(now), now));
        assert!(refuse_due(false, Some(now - second), now));
        assert!(refuse_due(true, None, now));
        assert!(refuse_due(true, Some(now + second), now));
    }

    #[test]
    fn on_windows_only_the_allowing_task_buttons_id_allows() {
        assert!(CHOICE.allows_task_button(Some(TASK_ALLOW_ID)));
        // The refusing (default) button, Escape or closing (IDCANCEL), OK and the other common
        // buttons nobody can press, an unknown id, and a dialog that failed to show all refuse.
        for button in [Some(TASK_REFUSE_ID), Some(2), Some(1), Some(6), Some(7), Some(0), Some(-1), Some(2002), None] {
            assert!(!CHOICE.allows_task_button(button), "{button:?}");
        }
        let same = Choice { allow: "OK", refuse: "OK" };
        assert!(!same.allows_task_button(Some(TASK_ALLOW_ID)));
        assert_ne!(TASK_ALLOW_ID, TASK_REFUSE_ID);
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
