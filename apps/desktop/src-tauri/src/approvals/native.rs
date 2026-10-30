//! The real approval dialog: an alert shown by the app (an `NSAlert` on macOS, as computer control
//! does, S24.3), "Decline" as the default button.

use super::{ApprovalDialog, Prompt, APPROVAL_CHOICE};
use crate::alert::OpenDialog;
use tauri::AppHandle;

pub struct NativePrompt {
    app: AppHandle,
    /// The approval dialog on screen (Windows), so a timed-out one can be refused.
    open: OpenDialog,
}

impl NativePrompt {
    pub fn new(app: AppHandle) -> Self {
        NativePrompt { app, open: OpenDialog::default() }
    }
}

impl Prompt for NativePrompt {
    fn ask(&self, dialog: &ApprovalDialog) -> bool {
        crate::alert::ask_tracked(&self.app, &dialog.title, &dialog.message, APPROVAL_CHOICE, Some(&self.open), dialog.deadline)
    }

    /// macOS: aborts the modal alert on screen. `-[NSApplication abortModal]` is the one modal
    /// call meant for other threads; the aborted alert answers `NSModalResponseAbort`, which
    /// `alert` reads as Decline. The approvals gate
    /// guarantees no other approval dialog is up, but a computer-control dialog stacked on top
    /// would be aborted instead, which also refuses (fail closed). Windows: presses the approval
    /// dialog's own refusing button; a dialog not yet up then refuses itself at its deadline
    /// (`ApprovalDialog::deadline`). Elsewhere the stale dialog stays until the user answers, and
    /// that answer is ignored.
    fn dismiss(&self) {
        self.open.refuse();
        #[cfg(target_os = "macos")]
        {
            use objc2::runtime::AnyObject;
            use objc2::{class, msg_send};
            // SAFETY: `sharedApplication` exists once the app runs (this is only called after a
            // dialog was shown) and `abortModal` is documented as callable from any thread.
            unsafe {
                let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                if !app.is_null() {
                    let _: () = msg_send![app, abortModal];
                }
            }
        }
    }
}
