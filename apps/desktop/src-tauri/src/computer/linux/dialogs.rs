//! Linux native dialogs (T5c, S1-S5): desktop-global consent through the
//! app-owned GTK alert, never the webview. Grant, per-action confirm,
//! and Yolo ask use the exact policy copy (`GLOBAL_GRANT_TEXT`,
//! `CONFIRM_CHOICE`, `YOLO_TEXT`/`YOLO_CHOICE`); every dialog defaults to
//! its refusing button, exactly like the macOS path. The alert marshals to
//! the main thread, so helpers call this from MCP worker threads and
//! Yolo from `spawn_blocking`, never from the main thread.

use super::super::{Dialogs, GLOBAL_GRANT_TEXT};
use crate::alert::Choice;
use tauri::AppHandle;

/// Grant/confirm/Yolo choices, shared with the app layer so Linux and macOS
/// default to the same refusing button.
pub use crate::computer::app::{CONFIRM_CHOICE, GRANT_CHOICE, YOLO_CHOICE};
/// The Yolo copy this platform's dialog asks with: the Linux Stop binding, never
/// the Mac notation the app-layer text carries.
pub use crate::computer::GLOBAL_YOLO_TEXT as YOLO_TEXT;

/// Dialogs shown by the app itself on Linux (native GTK, see `alert`),
/// never the webview.
pub struct LinuxDialogs {
    app: AppHandle,
}

impl LinuxDialogs {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn ask(&self, message: &str, choice: Choice) -> bool {
        crate::alert::ask(&self.app, "Gentle Dot", message, choice)
    }
}

impl Dialogs for LinuxDialogs {
    fn ask_grant(&self) -> bool {
        self.ask(GLOBAL_GRANT_TEXT, GRANT_CHOICE)
    }

    fn confirm(&self, message: &str) -> bool {
        self.ask(message, CONFIRM_CHOICE)
    }

    fn ask_yolo(&self) -> bool {
        self.ask(YOLO_TEXT, YOLO_CHOICE)
    }
}
