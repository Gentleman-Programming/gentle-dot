//! The app side of computer control (L60): the `computer_*` commands, the `computer://state`
//! event, the panic shortcut, the timeout watcher, and the native dialogs. Off macOS the
//! commands answer "unavailable" and nothing starts. Yolo mode (S24.9) is switched only from
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
#[cfg(target_os = "macos")]
use super::working::{MainThread, Rings, Task, Working, WorkingEvent, READY_TIMEOUT, WORKING_EVENT};
use super::{Clock, PermissionKind, Permissions, SystemClock};
use crate::alert::Choice;
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
/// Every computer-control dialog defaults to its refusing button (L75 A2).
pub const GRANT_CHOICE: Choice = Choice { allow: "Allow", refuse: "Deny" };
pub const CONFIRM_CHOICE: Choice = Choice { allow: "Allow", refuse: "Cancel" };
pub const YOLO_TEXT: &str = "Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you first, \
for up to 1 hour. Stop and ⌥⇧Esc still work.";
pub const YOLO_CHOICE: Choice = Choice { allow: "Turn On", refuse: "Cancel" };

/// The tray's "Yolo mode" item, kept in step with the state.
pub struct YoloMenuItem(pub tauri::menu::CheckMenuItem<tauri::Wry>);

pub struct Computer {
    control: Arc<Control>,
    endpoint: Option<Endpoint>,
    /// Which backend policy is in force on this build, so the panel names the
    /// control the user is actually granting (T5d).
    policy: super::BackendPolicy,
    #[cfg(target_os = "macos")]
    desktop: Arc<dyn super::Desktop>,
    #[cfg(target_os = "macos")]
    working: Arc<Working>,
    #[cfg(target_os = "linux")]
    desktop: Option<Arc<super::linux::desktop::LinuxDesktop<super::linux::backend::WaylandBackend>>>,
    #[cfg(target_os = "linux")]
    working: Arc<super::linux::working::LinuxWorking>,
}

/// What the panel needs to describe control truthfully on this build (T5d):
/// the platform, the policy in force, and the Stop fallback the user really
/// has. The web page never sees this; it comes from the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// `"macos"`, `"linux"` or `"other"`.
    pub os: &'static str,
    /// `"targeted"` (macOS per-app) or `"desktopGlobal"` (stock Wayland).
    pub policy: &'static str,
    /// Stop in the user's own notation: `⌥⇧Esc` on macOS, and on Linux the
    /// compositor-owned binding, which is the same string the managed Niri
    /// snippet writes.
    pub stop_shortcut: &'static str,
}

/// Pure mapping, so the copy is pinned by tests with no Mac and no compositor.
/// macOS keeps its notation and its per-app policy; every other platform has
/// no such shortcut, so it names the compositor-owned binding instead.
pub fn platform_info(os: &'static str, policy: super::BackendPolicy) -> PlatformInfo {
    PlatformInfo {
        os,
        policy: if policy == super::BackendPolicy::Targeted { "targeted" } else { "desktopGlobal" },
        stop_shortcut: if os == "macos" { "⌥⇧Esc" } else { crate::niri::kdl_binds::STOP_KEY },
    }
}

/// The build's own platform name, used with [`platform_info`].
fn current_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// What the overlay thread hears: the session started or ended, the agent acted, or a call
/// starts (answered once the rings were told to draw, or why not) or ends its working rings.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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
#[cfg(target_os = "macos")]
struct OverlayRings(std::sync::mpsc::Sender<Overlay>);

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
struct AppMainThread(AppHandle);

#[cfg(target_os = "macos")]
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

impl Computer {
    /// The helper's address and key for this launch, registered with the daemon over the app's
    /// channel (S24.7, L61); `None` when the helper did not start (off macOS, or gated out on Linux).
    pub fn endpoint(&self) -> Option<Endpoint> {
        self.endpoint.clone()
    }
}

/// Creates the session and, on macOS, starts the MCP helper, the timeout watcher, and the
/// glow overlay. `windows` are the Dot and the panel, hidden during each call (S1). Runs in the
/// app's setup, on the main thread.
pub fn start(app: &AppHandle, windows: Arc<dyn Windows>) -> Computer {
    let (overlay, marks) = std::sync::mpsc::channel::<Overlay>();
    #[cfg(target_os = "macos")]
    let working = Arc::new(Working::new(
        windows,
        Arc::new(OverlayRings(overlay.clone())),
        Arc::new(AppMainThread(app.clone())),
        READY_TIMEOUT,
    ));
    #[cfg(target_os = "macos")]
    let session_ended = {
        let working = working.clone();
        move || working.session_ended()
    };
    #[cfg(not(target_os = "macos"))]
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
        Computer { control, endpoint, desktop, working, policy: super::BackendPolicy::Targeted }
    }
    #[cfg(target_os = "linux")]
    {
        drop((overlay, marks));
        start_linux(app, control)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        drop((overlay, marks));
        Computer { control, endpoint: None, policy: super::BackendPolicy::Targeted }
    }
}

#[cfg(target_os = "macos")]
fn start_helper(
    app: &AppHandle,
    control: Arc<Control>,
    desktop: Arc<dyn super::Desktop>,
    glow: impl Fn(super::glow::Mark) + Send + Sync + 'static,
    working: Arc<Working>,
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

/// Whether the Linux helper may start (T5c, S3): the centralized Niri gate
/// plus a resolvable Wayland transport. Pure over `env`, so tests pin the
/// matrix without a compositor; production passes the live environment. The
/// backend needs `NIRI_SOCKET` for its focused-output query, so an exact
/// desktop token alone is not enough.
#[cfg(target_os = "linux")]
fn linux_available(env: &impl Fn(&str) -> Option<String>) -> bool {
    crate::platform::is_niri(env) && super::linux::backend::WaylandBackend::with_env(env).is_ok()
}

/// Linux startup (T5c, S1-S5): starts the in-process helper only when the
/// runtime gate holds (centralized `is_niri` plus a resolvable Wayland
/// transport). Otherwise `endpoint` stays `None` and the panel reports
/// control as unavailable, never a fake success. Reuses `server::start` plus
/// `mcp::Helper` with the DesktopGlobal policy; no second process and no
/// duplicate launch mechanism.
#[cfg(target_os = "linux")]
fn start_linux(app: &AppHandle, control: Arc<Control>) -> Computer {
    use super::linux::backend::WaylandBackend;
    use super::linux::desktop::LinuxDesktop;
    use super::linux::working::LinuxWorking;
    let working = Arc::new(LinuxWorking::new());
    let desktop: Option<Arc<LinuxDesktop<WaylandBackend>>> =
        linux_available(&|key| std::env::var(key).ok())
            .then(|| WaylandBackend::new().ok())
            .flatten()
            .map(|backend| Arc::new(LinuxDesktop::new(backend)));
    // Stop, panic, or the timeout ends here: the working operation ends and
    // one `cancel_all` interrupts the in-flight Wayland call, if any.
    {
        let working = working.clone();
        let desktop = desktop.clone();
        control.set_on_end(move || {
            working.session_ended();
            if let Some(desktop) = desktop.as_ref() {
                desktop.cancel_all();
            }
        });
    }
    let endpoint = desktop
        .as_ref()
        .and_then(|desktop| {
            start_helper_linux(app, control.clone(), desktop.clone(), working.clone())
                .map_err(|error| eprintln!("gentle-dot: computer control is unavailable: {error}"))
                .ok()
        });
    // Expiry ends the session as on macOS: the watcher reports it even with
    // no tool call in flight. It runs whether or not the helper started, so
    // a session can never outlive its timeout.
    watch_timeout_linux(control.clone());
    Computer { control, endpoint, desktop, working, policy: super::BackendPolicy::DesktopGlobal }
}

/// Starts the Linux helper: the same loopback `server::start` plus
/// `mcp::Helper` as macOS, with the DesktopGlobal policy, Linux dialogs,
/// and the ringless working preparation. The glow sink is a no-op — there is
/// no overlay off macOS, and none is fabricated.
#[cfg(target_os = "linux")]
fn start_helper_linux(
    app: &AppHandle,
    control: Arc<Control>,
    desktop: Arc<super::linux::desktop::LinuxDesktop<super::linux::backend::WaylandBackend>>,
    working: Arc<super::linux::working::LinuxWorking>,
) -> std::io::Result<Endpoint> {
    use super::BackendPolicy;
    use super::linux::dialogs::LinuxDialogs;
    let token = super::server::new_token();
    let desktop: Arc<dyn super::Desktop> = desktop;
    let working: Arc<dyn super::working::Preparation> = working;
    let helper = super::mcp::Helper::new(
        desktop,
        Arc::new(LinuxDialogs::new(app.clone())),
        Arc::new(SystemClock),
        control,
        token.clone(),
        std::process::id() as i32,
    )
    .with_glow(|_| {})
    .with_working(working)
    .with_policy(BackendPolicy::DesktopGlobal);
    super::server::start(Arc::new(helper), token)
}

/// Reports the timeout when it happens, not only at the next tool call (Linux).
#[cfg(target_os = "linux")]
fn watch_timeout_linux(control: Arc<Control>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        control.expire(SystemClock.now_ms());
    });
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

#[cfg(target_os = "macos")]
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
                    if let Some(operation) = drawing.take().filter(|_| !active) {
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
    #[cfg(target_os = "linux")]
    {
        use super::Desktop as _;
        computer
            .desktop
            .as_ref()
            .map(|desktop| desktop.permissions())
            .unwrap_or(Permissions { accessibility: false, screen_recording: false, screenshots_supported: false })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = computer;
        Permissions { accessibility: false, screen_recording: false, screenshots_supported: false }
    }
}

#[tauri::command]
pub fn computer_request_permission(kind: PermissionKind) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return super::request_permission(kind);
    #[cfg(target_os = "linux")]
    {
        let _ = kind;
        Err("Computer control on Linux needs no Accessibility or Screen Recording permission: control is \
allowed per session, and capture or input failures report per call."
            .into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
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
    #[cfg(target_os = "macos")]
    return computer.working.acknowledge(window.label(), operation_id);
    #[cfg(target_os = "linux")]
    {
        // No overlay exists off macOS, so there is no window to refuse: answer
        // whether the operation is still the one running, and draw nothing.
        let _ = window;
        Ok(computer.working.is_current(operation_id))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (window, computer, operation_id);
        Err("Computer control is only available on macOS.".into())
    }
}

/// Turns yolo mode on after the native confirmation, or off. Blocks on the dialog, so it runs
/// off the main thread; the tray item calls it from a thread of its own.
pub fn set_yolo(app: &AppHandle, enabled: bool) -> Result<StateEvent, String> {
    let computer = app.try_state::<Computer>().ok_or("Computer control is not ready.")?;
    #[cfg(target_os = "macos")]
    return Ok(computer.control.set_yolo(enabled, SystemClock.now_ms(), &NativeDialogs { app: app.clone() }));
    #[cfg(target_os = "linux")]
    return Ok(computer.control.set_yolo(
        enabled,
        SystemClock.now_ms(),
        &super::linux::dialogs::LinuxDialogs::new(app.clone()),
    ));
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
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

/// The platform, the policy and the Stop shortcut the panel must describe
/// truthfully (T5d): Linux reports `desktopGlobal` and the compositor-owned
/// Stop binding, macOS keeps `targeted` and `⌥⇧Esc`.
#[tauri::command]
pub fn computer_platform(computer: State<'_, Computer>) -> PlatformInfo {
    platform_info(current_os(), computer.policy)
}

/// Dialogs shown by the app itself (an `NSAlert`, see `alert`), never the webview.
#[cfg(target_os = "macos")]
struct NativeDialogs {
    app: AppHandle,
}

#[cfg(target_os = "macos")]
impl NativeDialogs {
    fn ask(&self, message: &str, choice: Choice) -> bool {
        crate::alert::ask(&self.app, "Gentle Dot", message, choice)
    }
}

#[cfg(target_os = "macos")]
impl super::Dialogs for NativeDialogs {
    fn ask_grant(&self) -> bool {
        self.ask(GRANT_TEXT, GRANT_CHOICE)
    }

    fn confirm(&self, message: &str) -> bool {
        self.ask(message, CONFIRM_CHOICE)
    }

    fn ask_yolo(&self) -> bool {
        self.ask(YOLO_TEXT, YOLO_CHOICE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grant_dialog_asks_exactly_what_the_spec_says() {
        assert_eq!(GRANT_TEXT, "Allow Gentle Dot to see and control this Mac for 30 minutes?");
        assert_eq!(GRANT_CHOICE, Choice { allow: "Allow", refuse: "Deny" });
    }

    #[test]
    fn the_yolo_dialog_says_what_it_skips_and_for_how_long() {
        assert_eq!(
            YOLO_TEXT,
            "Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you first, \
for up to 1 hour. Stop and ⌥⇧Esc still work."
        );
        assert_eq!(YOLO_CHOICE, Choice { allow: "Turn On", refuse: "Cancel" });
    }

    #[test]
    fn every_computer_dialog_defaults_to_its_refusing_button() {
        for choice in [GRANT_CHOICE, CONFIRM_CHOICE, YOLO_CHOICE] {
            assert_eq!(choice.alert_buttons(), [choice.refuse, choice.allow]);
            assert!(!choice.allows_response(Some(crate::alert::REFUSE_RESPONSE)));
            assert!(!choice.allows_response(None));
        }
    }

    #[test]
    fn the_panel_names_the_control_this_build_actually_offers() {
        assert_eq!(
            platform_info("macos", crate::computer::BackendPolicy::Targeted),
            PlatformInfo { os: "macos", policy: "targeted", stop_shortcut: "⌥⇧Esc" }
        );
        // Linux has no ⌥⇧Esc: the compositor owns the shortcut, so the panel
        // names the same binding the managed snippet writes.
        let linux = platform_info("linux", crate::computer::BackendPolicy::DesktopGlobal);
        assert_eq!(linux.os, "linux");
        assert_eq!(linux.policy, "desktopGlobal");
        assert_eq!(linux.stop_shortcut, crate::niri::kdl_binds::STOP_KEY);
        // The panel reads these exact keys.
        assert_eq!(
            serde_json::to_value(linux).unwrap(),
            serde_json::json!({
                "os": "linux",
                "policy": "desktopGlobal",
                "stopShortcut": "Alt+Shift+Escape"
            })
        );
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

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_start_gate_needs_niri_and_a_resolvable_transport() {
        fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
            move |key| pairs.iter().find(|(name, _)| *name == key).map(|(_, value)| value.to_string())
        }
        // Niri socket plus an absolute display: the helper may start.
        assert!(linux_available(&env_of(&[
            ("NIRI_SOCKET", "/run/user/1000/niri.sock"),
            ("WAYLAND_DISPLAY", "/tmp/gentle-dot-test-wayland-0"),
        ])));
        // No Niri at all: gated out, so zero helper starts.
        assert!(!linux_available(&env_of(&[
            ("WAYLAND_DISPLAY", "/tmp/gentle-dot-test-wayland-0"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
        ])));
        // Niri without a transport: gated out.
        assert!(!linux_available(&env_of(&[("NIRI_SOCKET", "/run/user/1000/niri.sock")])));
        // An exact desktop token without a socket is not enough: the backend
        // needs NIRI_SOCKET for its focused-output query.
        assert!(!linux_available(&env_of(&[
            ("XDG_CURRENT_DESKTOP", "niri"),
            ("WAYLAND_DISPLAY", "/tmp/gentle-dot-test-wayland-0"),
        ])));
        // An empty socket is no socket.
        assert!(!linux_available(&env_of(&[
            ("NIRI_SOCKET", ""),
            ("WAYLAND_DISPLAY", "/tmp/gentle-dot-test-wayland-0"),
        ])));
    }
}
