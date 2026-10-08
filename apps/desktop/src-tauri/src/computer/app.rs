//! The app side of computer control (L60): the `computer_*` commands, the `computer://state`
//! event, the panic shortcut, the timeout watcher, and the native dialogs. Off macOS the
//! commands answer "unavailable" and nothing starts. Yolo mode (S24.9) is switched only from
//! here (`computer_set_yolo` and the tray item), never from the MCP helper or the daemon.

use super::control::Control;
use super::server::Endpoint;
use super::session::{Reason, StateEvent};
use super::{Clock, PermissionKind, Permissions, SystemClock};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub const STATE_EVENT: &str = "computer://state";
/// ⌥⇧Esc ends the session from anywhere (S24.3).
pub const PANIC_SHORTCUT: &str = "Alt+Shift+Escape";
pub const GRANT_TEXT: &str = "Allow Gentle Dot to see and control this Mac for 30 minutes?";
pub const GRANT_BUTTONS: (&str, &str) = ("Allow", "Deny");
pub const CONFIRM_BUTTONS: (&str, &str) = ("Allow", "Cancel");
pub const YOLO_TEXT: &str = "Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you first, \
for up to 1 hour. Stop and ⌥⇧Esc still work.";
pub const YOLO_BUTTONS: (&str, &str) = ("Turn On", "Cancel");

/// The tray's "Yolo mode" item, kept in step with the state.
pub struct YoloMenuItem(pub tauri::menu::CheckMenuItem<tauri::Wry>);

pub struct Computer {
    control: Arc<Control>,
    endpoint: Option<Endpoint>,
    #[cfg(target_os = "macos")]
    desktop: Arc<dyn super::Desktop>,
}

/// Creates the session and, on macOS, starts the MCP helper and the timeout watcher.
pub fn start(app: &AppHandle) -> Computer {
    let events = app.clone();
    let control = Arc::new(Control::new(move |event: &StateEvent| {
        if let Err(error) = events.emit(STATE_EVENT, event) {
            eprintln!("gentle-dot: cannot report the computer-control state: {error}");
        }
        if let Some(item) = events.try_state::<YoloMenuItem>() {
            let _ = item.0.set_checked(event.yolo);
        }
    }));
    #[cfg(target_os = "macos")]
    {
        let desktop: Arc<dyn super::Desktop> = Arc::new(super::MacDesktop::default());
        let endpoint = start_helper(app, control.clone(), desktop.clone())
            .map_err(|error| eprintln!("gentle-dot: computer control is unavailable: {error}"))
            .ok();
        watch_timeout(control.clone());
        Computer { control, endpoint, desktop }
    }
    #[cfg(not(target_os = "macos"))]
    Computer { control, endpoint: None }
}

#[cfg(target_os = "macos")]
fn start_helper(
    app: &AppHandle,
    control: Arc<Control>,
    desktop: Arc<dyn super::Desktop>,
) -> std::io::Result<Endpoint> {
    let token = super::server::new_token();
    let helper = super::mcp::Helper::new(
        desktop,
        Arc::new(NativeDialogs { app: app.clone() }),
        Arc::new(SystemClock),
        control,
        token.clone(),
        std::process::id() as i32,
    );
    super::server::start(Arc::new(helper), token)
}

/// Reports the timeout when it happens, not only at the next tool call.
#[cfg(target_os = "macos")]
fn watch_timeout(control: Arc<Control>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        control.expire(SystemClock.now_ms());
    });
}

/// Ends the session (Stop button, tray item, panic shortcut). Queued actions are dropped.
pub fn stop(app: &AppHandle, reason: Reason) {
    if let Some(computer) = app.try_state::<Computer>() {
        computer.control.end(reason);
    }
}

#[tauri::command]
pub fn computer_endpoint(computer: State<'_, Computer>) -> Option<Endpoint> {
    computer.endpoint.clone()
}

#[tauri::command]
pub fn computer_permissions(computer: State<'_, Computer>) -> Permissions {
    #[cfg(target_os = "macos")]
    return computer.desktop.permissions();
    #[cfg(not(target_os = "macos"))]
    {
        let _ = computer;
        Permissions { accessibility: false, screen_recording: false, screenshots_supported: false }
    }
}

#[tauri::command]
pub fn computer_request_permission(kind: PermissionKind) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return super::request_permission(kind);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Err("Computer control is only available on macOS.".into())
    }
}

#[tauri::command]
pub fn computer_stop(app: AppHandle) {
    stop(&app, Reason::Stopped);
}

/// Turns yolo mode on after the native confirmation, or off. Blocks on the dialog, so it runs
/// off the main thread; the tray item calls it from a thread of its own.
pub fn set_yolo(app: &AppHandle, enabled: bool) -> Result<StateEvent, String> {
    let computer = app.try_state::<Computer>().ok_or("Computer control is not ready.")?;
    #[cfg(target_os = "macos")]
    return Ok(computer.control.set_yolo(enabled, SystemClock.now_ms(), &NativeDialogs { app: app.clone() }));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (computer, enabled);
        Err("Computer control is only available on macOS.".into())
    }
}

/// The tray item: the opposite of the current state.
pub fn toggle_yolo(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let on = app.try_state::<Computer>().is_some_and(|c| c.control.yolo(SystemClock.now_ms()));
        if let Err(error) = set_yolo(&app, !on) {
            eprintln!("gentle-dot: cannot switch yolo mode: {error}");
        }
    });
}

#[tauri::command]
pub async fn computer_set_yolo(app: AppHandle, enabled: bool) -> Result<StateEvent, String> {
    tauri::async_runtime::spawn_blocking(move || set_yolo(&app, enabled)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn computer_status(computer: State<'_, Computer>) -> StateEvent {
    computer.control.status(SystemClock.now_ms())
}

/// Dialogs shown by the app itself (NSAlert through the dialog plugin), never the webview.
#[cfg(target_os = "macos")]
struct NativeDialogs {
    app: AppHandle,
}

#[cfg(target_os = "macos")]
impl NativeDialogs {
    fn ask(&self, message: &str, (allow, refuse): (&str, &str)) -> bool {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        self.app
            .dialog()
            .message(message)
            .title("Gentle Dot")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(allow.into(), refuse.into()))
            .blocking_show()
    }
}

#[cfg(target_os = "macos")]
impl super::Dialogs for NativeDialogs {
    fn ask_grant(&self) -> bool {
        self.ask(GRANT_TEXT, GRANT_BUTTONS)
    }

    fn confirm(&self, message: &str) -> bool {
        self.ask(message, CONFIRM_BUTTONS)
    }

    fn ask_yolo(&self) -> bool {
        self.ask(YOLO_TEXT, YOLO_BUTTONS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grant_dialog_asks_exactly_what_the_spec_says() {
        assert_eq!(GRANT_TEXT, "Allow Gentle Dot to see and control this Mac for 30 minutes?");
        assert_eq!(GRANT_BUTTONS, ("Allow", "Deny"));
    }

    #[test]
    fn the_yolo_dialog_says_what_it_skips_and_for_how_long() {
        assert_eq!(
            YOLO_TEXT,
            "Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you first, \
for up to 1 hour. Stop and ⌥⇧Esc still work."
        );
        assert_eq!(YOLO_BUTTONS, ("Turn On", "Cancel"));
    }

    #[test]
    fn the_panic_shortcut_is_option_shift_escape() {
        let shortcut: tauri_plugin_global_shortcut::Shortcut = PANIC_SHORTCUT.parse().unwrap();
        let expected = tauri_plugin_global_shortcut::Shortcut::new(
            Some(tauri_plugin_global_shortcut::Modifiers::ALT | tauri_plugin_global_shortcut::Modifiers::SHIFT),
            tauri_plugin_global_shortcut::Code::Escape,
        );
        assert_eq!(shortcut, expected);
    }

    #[test]
    fn permission_kinds_read_the_l60_names() {
        let kind: PermissionKind = serde_json::from_str("\"screenRecording\"").unwrap();
        assert_eq!(kind, PermissionKind::ScreenRecording);
        let kind: PermissionKind = serde_json::from_str("\"accessibility\"").unwrap();
        assert_eq!(kind, PermissionKind::Accessibility);
    }

    #[test]
    fn permissions_serialize_with_the_l60_field_names() {
        let value = serde_json::to_value(Permissions { accessibility: true, screen_recording: false, screenshots_supported: true }).unwrap();
        assert_eq!(value, serde_json::json!({"accessibility": true, "screenRecording": false, "screenshotsSupported": true}));
    }
}
