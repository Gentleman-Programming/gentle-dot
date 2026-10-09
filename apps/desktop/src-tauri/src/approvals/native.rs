//! The real approval dialog: an alert shown by the app (NSAlert through the dialog plugin on
//! macOS, as computer control does, S24.3), "Decline" as the default button.

use super::{ApprovalDialog, Prompt, APPROVAL_CHOICE};
use tauri::AppHandle;

pub struct NativePrompt {
    app: AppHandle,
}

impl NativePrompt {
    pub fn new(app: AppHandle) -> Self {
        NativePrompt { app }
    }
}

impl Prompt for NativePrompt {
    fn ask(&self, dialog: &ApprovalDialog) -> bool {
        crate::alert::ask(&self.app, &dialog.title, &dialog.message, APPROVAL_CHOICE)
    }

    /// macOS: aborts the modal alert on screen. `-[NSApplication abortModal]` is the one modal
    /// call meant for other threads; the aborted alert reads as Decline. The approvals gate
    /// guarantees no other approval dialog is up, but a computer-control dialog stacked on top
    /// would be aborted instead, which also refuses (fail closed). Elsewhere the stale dialog
    /// stays until the user answers, and that answer is ignored.
    fn dismiss(&self) {
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
