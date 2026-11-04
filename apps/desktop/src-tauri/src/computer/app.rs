//! The app side of computer control (L60): the `computer_*` commands, the `computer://state`
//! event, the panic shortcut, the timeout watcher, and the native dialogs. Off macOS and Windows
//! the commands answer "unavailable" and nothing starts. Yolo mode (S24.9) is switched only from
//! here (`computer_set_yolo` and the tray item), never from the MCP helper or the daemon.
//!
//! The glow (S28): a click-through overlay window (`glow`) is ordered in while a session is
//! active and out when it ends. The helper's marks reach it through a channel, so the helper
//! never waits on the overlay; a thread of its own looks up the display (and, for keys, the
//! focused element), moves the overlay over that display, and emits `computer://glow`.
//!
//! The working rings (S1, S2, S5): the same thread covers the display under the pointer, orders
//! the overlay in, and emits `computer://working` for each prepared call; the overlay answers
//! with `computer_working_ready`, and the end of the call or of the session clears the rings.

use super::control::Control;
use super::server::Endpoint;
use super::session::{Reason, StateEvent};
use super::working::Windows;
#[cfg(any(target_os = "macos", windows))]
use super::working::{MainThread, Rings, Task, Working, WorkingEvent, READY_TIMEOUT, WORKING_EVENT};
use super::{Clock, PermissionKind, Permissions, SystemClock};
use crate::alert::Choice;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub const STATE_EVENT: &str = "computer://state";
/// Where the agent just acted, sent to the overlay only (S28).
pub const GLOW_EVENT: &str = "computer://glow";
pub const GLOW_WINDOW: &str = "glow";
pub const GLOW_TITLE: &str = "Gentle Dot Glow";
/// ⌥⇧Esc ends the session from anywhere (S24.3).
pub const PANIC_SHORTCUT: &str = "Alt+Shift+Escape";
#[cfg(not(windows))]
pub const GRANT_TEXT: &str = "Allow Gentle Dot to see and control this Mac for 30 minutes?";
#[cfg(windows)]
pub const GRANT_TEXT: &str = "Allow Gentle Dot to see and control this PC for 30 minutes?";
/// Every computer-control dialog defaults to its refusing button (L75 A2).
pub const GRANT_CHOICE: Choice = Choice { allow: "Allow", refuse: "Deny" };
pub const CONFIRM_CHOICE: Choice = Choice { allow: "Allow", refuse: "Cancel" };
#[cfg(not(windows))]
pub const YOLO_TEXT: &str = "Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you first, \
for up to 1 hour. Stop and ⌥⇧Esc still work.";
#[cfg(windows)]
pub const YOLO_TEXT: &str = "Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you first, \
for up to 1 hour. Stop and Alt+Shift+Esc still work.";
pub const YOLO_CHOICE: Choice = Choice { allow: "Turn On", refuse: "Cancel" };
/// The yolo dialog when the panic shortcut is not registered: it promises only what works.
pub const YOLO_TEXT_WITHOUT_PANIC: &str = "Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you \
first, for up to 1 hour. Stop still works.";
/// Told once at launch when the panic shortcut cannot be registered.
#[cfg(not(windows))]
pub const PANIC_UNAVAILABLE_TEXT: &str = "⌥⇧Esc cannot stop computer control: another app or macOS already uses it. \
Use Stop in the panel or the menu bar instead.";
#[cfg(windows)]
pub const PANIC_UNAVAILABLE_TEXT: &str = "Alt+Shift+Esc cannot stop computer control: another app or Windows already uses \
it. Use Stop in the panel or the tray menu instead.";

/// Whether the panic shortcut was registered at launch.
static PANIC_SHORTCUT_REGISTERED: AtomicBool = AtomicBool::new(false);

/// Records whether the panic shortcut was registered, so the yolo dialog only promises it when it works.
pub fn set_panic_shortcut_registered(registered: bool) {
    PANIC_SHORTCUT_REGISTERED.store(registered, Ordering::SeqCst);
}

/// Whether the panic shortcut was registered at launch; false off macOS and Windows.
pub fn panic_shortcut_registered() -> bool {
    PANIC_SHORTCUT_REGISTERED.load(Ordering::SeqCst)
}

/// The yolo dialog's text, naming the panic shortcut only when it is registered.
pub fn yolo_text(panic_registered: bool) -> &'static str {
    if panic_registered {
        YOLO_TEXT
    } else {
        YOLO_TEXT_WITHOUT_PANIC
    }
}

/// The tray's "Yolo mode" item, kept in step with the state.
pub struct YoloMenuItem(pub tauri::menu::CheckMenuItem<tauri::Wry>);

pub struct Computer {
    control: Arc<Control>,
    endpoint: Option<Endpoint>,
    #[cfg(any(target_os = "macos", windows))]
    desktop: Arc<dyn super::Desktop>,
    #[cfg(any(target_os = "macos", windows))]
    working: Arc<Working>,
}

/// What the overlay thread hears: the session started or ended, the agent acted, or a call
/// starts (answered once the rings were told to draw, or why not) or ends its working rings.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
enum Overlay {
    Session(bool),
    Mark(super::glow::Mark),
    Working { operation: u64, reply: std::sync::mpsc::Sender<Result<(), String>> },
    WorkingEnd(u64),
}

/// How long the overlay thread waits for the main thread to order the overlay in.
#[cfg(target_os = "macos")]
const OVERLAY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

/// The overlay's working rings, through the overlay thread.
#[cfg(any(target_os = "macos", windows))]
struct OverlayRings(std::sync::mpsc::Sender<Overlay>);

#[cfg(any(target_os = "macos", windows))]
impl Rings for OverlayRings {
    fn show(&self, operation: u64) -> Result<(), String> {
        let (reply, answer) = std::sync::mpsc::channel();
        self.0.send(Overlay::Working { operation, reply }).map_err(|_| "the glow is unavailable".to_string())?;
        answer.recv_timeout(READY_TIMEOUT).map_err(|_| "the glow did not answer in time".to_string())?
    }

    fn end(&self, operation: u64) {
        let _ = self.0.send(Overlay::WorkingEnd(operation));
    }
}

#[cfg(any(target_os = "macos", windows))]
struct AppMainThread(AppHandle);

#[cfg(any(target_os = "macos", windows))]
impl MainThread for AppMainThread {
    fn run(&self, task: Task) -> Result<(), String> {
        self.0.run_on_main_thread(task).map_err(|error| error.to_string())
    }
}

/// Orders one of the app's windows in without making it key or activating the app: the Dot and
/// the panel once a computer-control call ends (S5). Main thread only.
#[cfg(target_os = "macos")]
pub fn show_without_focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    let ns_window = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: on the main thread (the caller's contract), with the window's live NSWindow.
    unsafe { super::macos::order_window(ns_window, true) };
    Ok(())
}

#[cfg(windows)]
pub fn show_without_focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    super::win::show_without_activating(window.hwnd().map_err(|e| e.to_string())?.0);
    Ok(())
}

/// A window of Gentle Dot is shown or hidden through tao (the panel, the Dot) while the returned
/// change lives: a computer-control capture overlapping it is not returned.
#[cfg(windows)]
pub(crate) fn window_change() -> super::win::WindowChange {
    super::win::WindowChange::begin()
}

#[cfg(windows)]
pub fn set_shown(window: &tauri::WebviewWindow, shown: bool) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
    if shown { super::win::show_window(hwnd); } else { super::win::hide_window(hwnd); }
    Ok(())
}

impl Computer {
    /// The helper's address and key for this launch, registered with the daemon over the app's
    /// channel (S24.7, L61); `None` off macOS and Windows or when the helper did not start.
    pub fn endpoint(&self) -> Option<Endpoint> {
        self.endpoint.clone()
    }
}

/// Creates the session and, on macOS and Windows, starts the MCP helper, the timeout watcher, and the
/// glow overlay. `windows` are the Dot and the panel, hidden during each call (S1). Runs in the
/// app's setup, on the main thread.
pub fn start(app: &AppHandle, windows: Arc<dyn Windows>) -> Computer {
    let (overlay, marks) = std::sync::mpsc::channel::<Overlay>();
    #[cfg(any(target_os = "macos", windows))]
    let working = Arc::new(Working::new(
        windows,
        Arc::new(OverlayRings(overlay.clone())),
        Arc::new(AppMainThread(app.clone())),
        READY_TIMEOUT,
    ));
    #[cfg(any(target_os = "macos", windows))]
    let session_ended = {
        let working = working.clone();
        move || working.session_ended()
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let session_ended = {
        drop(windows);
        || {}
    };
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
        // Stop, panic, or the timeout: the call under way gives the Dot and the panel back now.
        if !event.active {
            session_ended();
        }
    }));
    #[cfg(target_os = "macos")]
    {
        let number = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let desktop: Arc<dyn super::Desktop> = Arc::new(super::MacDesktop::new(number.clone()));
        let glow = move |mark| {
            let _ = overlay.send(Overlay::Mark(mark));
        };
        let endpoint = start_helper(app, control.clone(), desktop.clone(), glow, working.clone())
            .map_err(|error| eprintln!("gentle-dot: computer control is unavailable: {error}"))
            .ok();
        watch_timeout(control.clone());
        // Without the overlay, `marks` is dropped: no rings can show, so every call that
        // captures or acts fails before doing anything (S5).
        match build_overlay(app, &number) {
            Ok(window) => run_overlay(app.clone(), window, number, control.clone(), working.clone(), marks),
            Err(error) => eprintln!("gentle-dot: the computer-control glow is unavailable: {error}"),
        }
        Computer { control, endpoint, desktop, working }
    }
    #[cfg(windows)]
    {
        let desktop: Arc<dyn super::Desktop> = Arc::new(super::win::WinDesktop);
        let glow = move |mark| { let _ = overlay.send(Overlay::Mark(mark)); };
        let endpoint = start_helper(app, control.clone(), desktop.clone(), glow, working.clone())
            .map_err(|error| eprintln!("gentle-dot: computer control is unavailable: {error}")).ok();
        watch_timeout(control.clone());
        match build_glow(app) {
            Ok(window) => run_glow(app.clone(), window, control.clone(), working.clone(), marks),
            Err(error) => eprintln!("gentle-dot: the computer-control glow is unavailable: {error}"),
        }
        Computer { control, endpoint, desktop, working }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        drop((overlay, marks));
        Computer { control, endpoint: None }
    }
}

#[cfg(any(target_os = "macos", windows))]
fn start_helper(
    app: &AppHandle,
    control: Arc<Control>,
    desktop: Arc<dyn super::Desktop>,
    glow: impl Fn(super::glow::Mark) + Send + Sync + 'static,
    working: Arc<dyn super::working::Preparation>,
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
    .with_glow(glow)
    .with_working(working);
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

/// Orders the overlay in or out on the main thread and records its window number. The receiver
/// hears once that happened.
#[cfg(target_os = "macos")]
fn order_overlay(
    app: &AppHandle,
    ns_window: NsWindow,
    number: &Arc<std::sync::atomic::AtomicU32>,
    visible: bool,
) -> Result<std::sync::mpsc::Receiver<()>, String> {
    let number = number.clone();
    let (done, ordered) = std::sync::mpsc::channel();
    let queued = app.run_on_main_thread(move || {
        // SAFETY: on the main thread, with the overlay's live NSWindow.
        let n = unsafe { super::macos::order_overlay(ns_window.0 as *mut std::ffi::c_void, visible) };
        if n != 0 {
            number.store(n, std::sync::atomic::Ordering::SeqCst);
        }
        let _ = done.send(());
    });
    queued.map(|()| ordered).map_err(|error| {
        eprintln!("gentle-dot: cannot show or hide the glow: {error}");
        error.to_string()
    })
}

/// Moves the overlay over `display` unless it already covers it.
#[cfg(target_os = "macos")]
fn cover(window: &tauri::WebviewWindow, covering: &mut Option<super::glow::Frame>, display: super::glow::Frame) {
    use tauri::{LogicalPosition, LogicalSize};
    if *covering != Some(display) {
        let _ = window.set_position(LogicalPosition::new(display.x, display.y));
        let _ = window.set_size(LogicalSize::new(display.width, display.height));
        *covering = Some(display);
    }
}

#[cfg(any(target_os = "macos", windows))]
fn emit_working(app: &AppHandle, operation: u64, active: bool) -> Result<(), String> {
    let event = WorkingEvent { active, operation_id: operation };
    app.emit_to(GLOW_WINDOW, WORKING_EVENT, event).map_err(|error| error.to_string())
}

/// The overlay's own thread: follows the session, draws each mark while it lasts, and shows the
/// working rings of the call under way (`drawing`).
#[cfg(target_os = "macos")]
fn run_overlay(
    app: AppHandle,
    (window, ns_window): (tauri::WebviewWindow, NsWindow),
    number: Arc<std::sync::atomic::AtomicU32>,
    control: Arc<Control>,
    working: Arc<Working>,
    marks: std::sync::mpsc::Receiver<Overlay>,
) {
    let spawned = std::thread::Builder::new().name("computer-glow".into()).spawn(move || {
        let (mut shown, mut covering, mut drawing) = (false, None, None);
        for message in marks {
            match message {
                Overlay::Session(active) => {
                    if active != shown {
                        let _ = order_overlay(&app, ns_window, &number, active);
                        shown = active;
                    }
                    if let Some(operation) = super::working::session_clears(&mut drawing, active) {
                        let _ = emit_working(&app, operation, false);
                    }
                }
                Overlay::Working { operation, reply } => {
                    // A start that arrives after its call or the session ended draws nothing.
                    let outcome = if !control.is_active(SystemClock.now_ms()) || !working.is_current(operation) {
                        Err("the call already ended".to_string())
                    } else {
                        let at = super::macos::pointer_location();
                        match super::macos::display_frame_at(at) {
                            None => Err("no display under the pointer".to_string()),
                            Some(display) => {
                                cover(&window, &mut covering, display);
                                let ordered = order_overlay(&app, ns_window, &number, true);
                                shown = true;
                                // The rings are drawn only once the overlay is in front.
                                ordered
                                    .and_then(|done| {
                                        done.recv_timeout(OVERLAY_TIMEOUT)
                                            .map_err(|_| "the glow did not show in time".to_string())
                                    })
                                    .and_then(|()| {
                                        drawing = Some(operation);
                                        emit_working(&app, operation, true)
                                    })
                            }
                        }
                    };
                    let _ = reply.send(outcome);
                }
                Overlay::WorkingEnd(operation) => {
                    if drawing == Some(operation) {
                        drawing = None;
                        let _ = emit_working(&app, operation, false);
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
                    cover(&window, &mut covering, display);
                    if !shown {
                        let _ = order_overlay(&app, ns_window, &number, true);
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

/// A click-through, non-activating overlay excluded from capture.
#[cfg(windows)]
fn build_glow(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let window = tauri::WebviewWindowBuilder::new(app, GLOW_WINDOW, tauri::WebviewUrl::App("index.html?surface=glow".into()))
        .title(GLOW_TITLE).inner_size(1.0, 1.0).position(0.0, 0.0).transparent(true)
        .decorations(false).always_on_top(true).resizable(false).skip_taskbar(true)
        .shadow(false).focused(false).focusable(false).visible(false).build().map_err(|error| error.to_string())?;
    window.set_ignore_cursor_events(true).map_err(|error| error.to_string())?;
    if let Err(error) = super::win::prepare_overlay(window.hwnd().map_err(|error| error.to_string())?.0) {
        let _ = window.close();
        return Err(error);
    }
    Ok(window)
}

#[cfg(windows)]
fn run_glow(app: AppHandle, window: tauri::WebviewWindow, control: Arc<Control>, working: Arc<Working>, marks: std::sync::mpsc::Receiver<Overlay>) {
    let Ok(hwnd) = window.hwnd() else {
        eprintln!("gentle-dot: the computer-control glow is unavailable: no window handle");
        return;
    };
    let hwnd = hwnd.0 as usize;
    let spawned = std::thread::Builder::new().name("computer-glow".into()).spawn(move || {
        let window = hwnd as *mut std::ffi::c_void;
        let (mut shown, mut covering, mut drawing) = (false, None, None);
        for message in marks {
            match message {
                Overlay::Session(active) => {
                    if active != shown { super::win::show_overlay(window, active); shown = active; }
                    if let Some(operation) = super::working::session_clears(&mut drawing, active) {
                        let _ = emit_working(&app, operation, false);
                    }
                }
                Overlay::Working { operation, reply } => {
                    let outcome = if !control.is_active(SystemClock.now_ms()) || !working.is_current(operation) {
                        Err("the call already ended".to_string())
                    } else {
                        match super::win::pointer_location().and_then(super::win::display_frame_at) {
                            None => Err("no display under the pointer".to_string()),
                            Some(display) => {
                                if covering != Some(display) { super::win::cover(window, display); covering = Some(display); }
                                super::win::show_overlay(window, true);
                                shown = true;
                                drawing = Some(operation);
                                emit_working(&app, operation, true)
                            }
                        }
                    };
                    let _ = reply.send(outcome);
                }
                Overlay::WorkingEnd(operation) => {
                    if drawing == Some(operation) { drawing = None; let _ = emit_working(&app, operation, false); }
                }
                Overlay::Mark(mark) => {
                    if !control.is_active(SystemClock.now_ms()) { continue; }
                    let placed = super::glow::place(mark, super::win::display_frame_at, super::win::focused_frame);
                    let Some((display, event)) = placed else { continue };
                    if covering != Some(display) { super::win::cover(window, display); covering = Some(display); }
                    if !shown { super::win::show_overlay(window, true); shown = true; }
                    let event = super::glow::in_css_pixels(event, super::win::display_scale(display));
                    if let Err(error) = app.emit_to(GLOW_WINDOW, GLOW_EVENT, event) {
                        eprintln!("gentle-dot: cannot draw the glow: {error}");
                    }
                }
            }
        }
    });
    if let Err(error) = spawned { eprintln!("gentle-dot: the computer-control glow is unavailable: {error}"); }
}

/// Reports the timeout when it happens, not only at the next tool call.
#[cfg(any(target_os = "macos", windows))]
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
pub fn computer_permissions(computer: State<'_, Computer>) -> PermissionsAnswer {
    #[cfg(any(target_os = "macos", windows))]
    let permissions = computer.desktop.permissions();
    #[cfg(not(any(target_os = "macos", windows)))]
    let permissions = {
        let _ = computer;
        Permissions { accessibility: false, screen_recording: false, screenshots_supported: false, screenshots_unsupported: None }
    };
    PermissionsAnswer { permissions, panic_shortcut: panic_shortcut_registered() }
}

/// The `computer_permissions` answer: the permissions, plus `panicShortcut`, so Connectors names
/// the panic shortcut only when it works.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsAnswer {
    #[serde(flatten)]
    pub permissions: Permissions,
    pub panic_shortcut: bool,
}

#[tauri::command]
pub fn computer_request_permission(kind: PermissionKind) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return super::request_permission(kind);
    #[cfg(windows)]
    { let _ = kind; Ok(()) }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = kind;
        Err("Computer control is only available on macOS.".into())
    }
}

#[tauri::command]
pub fn computer_stop(app: AppHandle) {
    stop(&app, Reason::Stopped);
}

/// The overlay drew the working rings for `operation_id` (S5): true when that is the call under
/// way, false when it already ended. Any window but the overlay is refused.
#[tauri::command]
pub fn computer_working_ready(
    window: tauri::WebviewWindow,
    computer: State<'_, Computer>,
    operation_id: u64,
) -> Result<bool, String> {
    #[cfg(any(target_os = "macos", windows))]
    return computer.working.acknowledge(window.label(), operation_id);
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (window, computer, operation_id);
        Err("Computer control is only available on macOS.".into())
    }
}

/// Turns yolo mode on after the native confirmation, or off. Blocks on the dialog, so it runs
/// off the main thread; the tray item calls it from a thread of its own.
pub fn set_yolo(app: &AppHandle, enabled: bool) -> Result<StateEvent, String> {
    let computer = app.try_state::<Computer>().ok_or("Computer control is not ready.")?;
    #[cfg(any(target_os = "macos", windows))]
    return Ok(computer.control.set_yolo(enabled, SystemClock.now_ms(), &NativeDialogs { app: app.clone() }));
    #[cfg(not(any(target_os = "macos", windows)))]
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

/// Dialogs shown by the app itself (an `NSAlert`, see `alert`), never the webview.
#[cfg(any(target_os = "macos", windows))]
struct NativeDialogs {
    app: AppHandle,
}

#[cfg(any(target_os = "macos", windows))]
impl NativeDialogs {
    fn ask(&self, message: &str, choice: Choice) -> bool {
        crate::alert::ask(&self.app, "Gentle Dot", message, choice)
    }
}

#[cfg(any(target_os = "macos", windows))]
impl super::Dialogs for NativeDialogs {
    fn ask_grant(&self) -> bool {
        self.ask(GRANT_TEXT, GRANT_CHOICE)
    }

    fn confirm(&self, message: &str) -> bool {
        self.ask(message, CONFIRM_CHOICE)
    }

    fn ask_yolo(&self) -> bool {
        self.ask(yolo_text(panic_shortcut_registered()), YOLO_CHOICE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(windows))]
    fn the_grant_dialog_asks_exactly_what_the_spec_says() {
        assert_eq!(GRANT_TEXT, "Allow Gentle Dot to see and control this Mac for 30 minutes?");
        assert_eq!(GRANT_CHOICE, Choice { allow: "Allow", refuse: "Deny" });
    }

    #[test]
    #[cfg(not(windows))]
    fn the_yolo_dialog_says_what_it_skips_and_for_how_long() {
        assert_eq!(
            YOLO_TEXT,
            "Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you first, \
for up to 1 hour. Stop and ⌥⇧Esc still work."
        );
        assert_eq!(YOLO_CHOICE, Choice { allow: "Turn On", refuse: "Cancel" });
    }

    #[test]
    #[cfg(windows)]
    fn windows_dialogs_name_the_pc_and_panic_shortcut() {
        assert_eq!(GRANT_TEXT, "Allow Gentle Dot to see and control this PC for 30 minutes?");
        assert_eq!(GRANT_CHOICE, Choice { allow: "Allow", refuse: "Deny" });
        assert_eq!(YOLO_TEXT, "Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you first, \
for up to 1 hour. Stop and Alt+Shift+Esc still work.");
        assert_eq!(YOLO_CHOICE, Choice { allow: "Turn On", refuse: "Cancel" });
    }

    #[test]
    fn the_yolo_dialog_promises_the_panic_shortcut_only_when_it_is_registered() {
        assert_eq!(yolo_text(true), YOLO_TEXT);
        assert_eq!(
            yolo_text(false),
            "Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you first, \
for up to 1 hour. Stop still works."
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn a_missing_panic_shortcut_is_explained_once_on_the_mac() {
        assert_eq!(
            PANIC_UNAVAILABLE_TEXT,
            "⌥⇧Esc cannot stop computer control: another app or macOS already uses it. \
Use Stop in the panel or the menu bar instead."
        );
    }

    #[test]
    #[cfg(windows)]
    fn a_missing_panic_shortcut_is_explained_once_on_windows() {
        assert_eq!(
            PANIC_UNAVAILABLE_TEXT,
            "Alt+Shift+Esc cannot stop computer control: another app or Windows already uses it. \
Use Stop in the panel or the tray menu instead."
        );
    }

    #[test]
    fn every_computer_dialog_defaults_to_its_refusing_button() {
        for choice in [GRANT_CHOICE, CONFIRM_CHOICE, YOLO_CHOICE] {
            assert_eq!(choice.alert_buttons(), [choice.refuse, choice.allow]);
            assert!(!choice.allows_response(Some(crate::alert::REFUSE_RESPONSE)));
            assert!(!choice.allows_response(None));
            assert!(!choice.allows_task_button(Some(crate::alert::TASK_REFUSE_ID)));
            assert!(!choice.allows_task_button(None));
            assert!(choice.allows_task_button(Some(crate::alert::TASK_ALLOW_ID)));
        }
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
        let value = serde_json::to_value(Permissions {
            accessibility: true,
            screen_recording: false,
            screenshots_supported: true,
            screenshots_unsupported: None,
        })
        .unwrap();
        assert_eq!(value, serde_json::json!({"accessibility": true, "screenRecording": false, "screenshotsSupported": true}));
    }

    #[test]
    fn the_permissions_answer_says_whether_the_panic_shortcut_is_registered() {
        let permissions = Permissions { accessibility: true, screen_recording: false, screenshots_supported: true, screenshots_unsupported: None };
        let value = serde_json::to_value(PermissionsAnswer { permissions, panic_shortcut: false }).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"accessibility": true, "screenRecording": false, "screenshotsSupported": true, "panicShortcut": false})
        );
        set_panic_shortcut_registered(true);
        assert!(panic_shortcut_registered());
        set_panic_shortcut_registered(false);
        assert!(!panic_shortcut_registered());
    }

    /// Why screenshots are unsupported rides next to the bool, which stays as it was for every consumer.
    #[test]
    fn unsupported_screenshots_say_why() {
        let unsupported = |reason| Permissions {
            accessibility: true,
            screen_recording: true,
            screenshots_supported: false,
            screenshots_unsupported: Some(reason),
        };
        assert_eq!(
            serde_json::to_value(unsupported(super::super::ScreenshotsUnsupported::TooOld)).unwrap(),
            serde_json::json!({"accessibility": true, "screenRecording": true, "screenshotsSupported": false, "screenshotsUnsupported": "tooOld"})
        );
        assert_eq!(
            serde_json::to_value(unsupported(super::super::ScreenshotsUnsupported::UnknownVersion)).unwrap(),
            serde_json::json!({"accessibility": true, "screenRecording": true, "screenshotsSupported": false, "screenshotsUnsupported": "unknownVersion"})
        );
    }
}
