//! The app side of computer control (L60): the `computer_*` commands, the `computer://state`
//! event, the panic shortcut, the timeout watcher, and the native dialogs. Off macOS the
//! commands answer "unavailable" and nothing starts. Yolo mode (S24.9) is switched only from
//! here (`computer_set_yolo` and the tray item), never from the MCP helper or the daemon.
//!
//! The glow (S28): a click-through overlay window (`glow`) is ordered in while a session is
//! active and out when it ends. The helper's marks reach it through a channel, so the helper
//! never waits on the overlay; a thread of its own looks up the display (and, for keys, the
//! focused element), moves the overlay over that display, and emits `computer://glow`.

use super::control::Control;
use super::server::Endpoint;
use super::session::{Reason, StateEvent};
use super::{Clock, PermissionKind, Permissions, SystemClock};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub const STATE_EVENT: &str = "computer://state";
/// Where the agent just acted, sent to the overlay only (S28).
pub const GLOW_EVENT: &str = "computer://glow";
pub const GLOW_WINDOW: &str = "glow";
pub const GLOW_TITLE: &str = "Gentle Dot Glow";
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

/// What the overlay thread hears: the session started or ended, or the agent acted.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum Overlay {
    Session(bool),
    Mark(super::glow::Mark),
}

/// Creates the session and, on macOS, starts the MCP helper, the timeout watcher, and the
/// glow overlay. Runs in the app's setup, on the main thread.
pub fn start(app: &AppHandle) -> Computer {
    let (overlay, marks) = std::sync::mpsc::channel::<Overlay>();
    let events = app.clone();
    let session = overlay.clone();
    let control = Arc::new(Control::new(move |event: &StateEvent| {
        if let Err(error) = events.emit(STATE_EVENT, event) {
            eprintln!("gentle-dot: cannot report the computer-control state: {error}");
        }
        if let Some(item) = events.try_state::<YoloMenuItem>() {
            let _ = item.0.set_checked(event.yolo);
        }
        let _ = session.send(Overlay::Session(event.active));
    }));
    #[cfg(target_os = "macos")]
    {
        let number = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let desktop: Arc<dyn super::Desktop> = Arc::new(super::MacDesktop::new(number.clone()));
        let glow = move |mark| {
            let _ = overlay.send(Overlay::Mark(mark));
        };
        let endpoint = start_helper(app, control.clone(), desktop.clone(), glow)
            .map_err(|error| eprintln!("gentle-dot: computer control is unavailable: {error}"))
            .ok();
        watch_timeout(control.clone());
        match build_overlay(app, &number) {
            Ok(window) => run_overlay(app.clone(), window, number, control.clone(), marks),
            Err(error) => eprintln!("gentle-dot: the computer-control glow is unavailable: {error}"),
        }
        Computer { control, endpoint, desktop }
    }
    #[cfg(not(target_os = "macos"))]
    {
        drop((overlay, marks));
        Computer { control, endpoint: None }
    }
}

#[cfg(target_os = "macos")]
fn start_helper(
    app: &AppHandle,
    control: Arc<Control>,
    desktop: Arc<dyn super::Desktop>,
    glow: impl Fn(super::glow::Mark) + Send + Sync + 'static,
) -> std::io::Result<Endpoint> {
    let token = super::server::new_token();
    let helper = super::mcp::Helper::new(
        desktop,
        Arc::new(NativeDialogs { app: app.clone() }),
        Arc::new(SystemClock),
        control,
        token.clone(),
        std::process::id() as i32,
    )
    .with_glow(glow);
    super::server::start(Arc::new(helper), token)
}

/// The overlay's NSWindow, used on the main thread only (the window lives as long as the app).
#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct NsWindow(usize);

/// The click-through overlay (S28): transparent, undecorated, never focusable, on every Space,
/// above menus, ignoring the mouse, and hidden until a session starts. Its window number lets
/// the helper skip it when it resolves which app owns a point.
#[cfg(target_os = "macos")]
fn build_overlay(
    app: &AppHandle,
    number: &std::sync::atomic::AtomicU32,
) -> tauri::Result<(tauri::WebviewWindow, NsWindow)> {
    let url = tauri::WebviewUrl::App("index.html?surface=glow".into());
    let window = tauri::WebviewWindowBuilder::new(app, GLOW_WINDOW, url)
        .title(GLOW_TITLE)
        .inner_size(1.0, 1.0)
        .position(0.0, 0.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .shadow(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()?;
    window.set_ignore_cursor_events(true)?;
    let ns_window = window.ns_window()?;
    // SAFETY: setup runs on the main thread, and `ns_window` is the live window just built.
    number.store(unsafe { super::macos::prepare_overlay(ns_window) }, std::sync::atomic::Ordering::SeqCst);
    Ok((window, NsWindow(ns_window as usize)))
}

/// Orders the overlay in or out on the main thread and records its window number.
#[cfg(target_os = "macos")]
fn order_overlay(app: &AppHandle, ns_window: NsWindow, number: &Arc<std::sync::atomic::AtomicU32>, visible: bool) {
    let number = number.clone();
    let ordered = app.run_on_main_thread(move || {
        // SAFETY: on the main thread, with the overlay's live NSWindow.
        let n = unsafe { super::macos::order_overlay(ns_window.0 as *mut std::ffi::c_void, visible) };
        if n != 0 {
            number.store(n, std::sync::atomic::Ordering::SeqCst);
        }
    });
    if let Err(error) = ordered {
        eprintln!("gentle-dot: cannot show or hide the glow: {error}");
    }
}

/// The overlay's own thread: follows the session and draws each mark while it lasts.
#[cfg(target_os = "macos")]
fn run_overlay(
    app: AppHandle,
    (window, ns_window): (tauri::WebviewWindow, NsWindow),
    number: Arc<std::sync::atomic::AtomicU32>,
    control: Arc<Control>,
    marks: std::sync::mpsc::Receiver<Overlay>,
) {
    use tauri::{LogicalPosition, LogicalSize};
    let spawned = std::thread::Builder::new().name("computer-glow".into()).spawn(move || {
        let (mut shown, mut covering) = (false, None);
        for message in marks {
            match message {
                Overlay::Session(active) => {
                    if active != shown {
                        order_overlay(&app, ns_window, &number, active);
                        shown = active;
                    }
                }
                Overlay::Mark(mark) => {
                    // A mark that arrives after Stop or panic is dropped.
                    if !control.is_active(SystemClock.now_ms()) {
                        continue;
                    }
                    let placed =
                        super::glow::place(mark, super::macos::display_frame_at, super::macos::focused_frame);
                    let Some((display, event)) = placed else { continue };
                    if covering != Some(display) {
                        let _ = window.set_position(LogicalPosition::new(display.x, display.y));
                        let _ = window.set_size(LogicalSize::new(display.width, display.height));
                        covering = Some(display);
                    }
                    if !shown {
                        order_overlay(&app, ns_window, &number, true);
                        shown = true;
                    }
                    if let Err(error) = app.emit_to(GLOW_WINDOW, GLOW_EVENT, event) {
                        eprintln!("gentle-dot: cannot draw the glow: {error}");
                    }
                }
            }
        }
    });
    if let Err(error) = spawned {
        eprintln!("gentle-dot: the computer-control glow is unavailable: {error}");
    }
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
