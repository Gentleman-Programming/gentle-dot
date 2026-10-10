//! Tauri wiring: windows, commands, tray menu, global shortcut, Dot snapping,
//! hiding the rose, the full-screen panel, voice input, the shortcut chosen in Settings,
//! the daemon lifecycle (design §9), and the app's private channel to the daemon (S25.1–S25.3).

use crate::app_channel::{self, AppChannel, NO_CHANNEL, REGISTER_TIMEOUT};
use crate::approvals::{native::NativePrompt, ApprovalRequest, Approvals, Decision, APPROVAL_TIMEOUT};
use crate::computer::app as computer;
use crate::computer::server::Endpoint;
use crate::computer::session::Reason;
use crate::config::{self, ConnectionInfo, DesktopConfig, DEFAULT_SHORTCUT};
use crate::daemon::{self, Daemon, RestartOutcome};
use crate::geometry::{self, Rect};
use crate::platform::{self, LaunchRequest, Os, DOT_TITLE, PANEL_TITLE};
use crate::position::{self, DotPosition};
use crate::secure_store::{self, SecretStore};
use crate::shortcut;
use crate::status::{is_template, tray_status, TrayGlyph};
use crate::voice::app as voice;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
#[cfg(target_os = "macos")]
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const DOT: &str = "dot";
pub(crate) const PANEL: &str = "panel";
const TRAY: &str = "main";
/// The Dot window, in points: a 66 pt black disc with the rose, plus a 3 pt
/// ring for its shadow. About the screen area of the earlier 64 × 84 rose.
const DOT_SIZE: (f64, f64) = (72.0, 72.0);
const PANEL_SIZE: (f64, f64) = (420.0, 640.0);
/// All placement runs in points (see `geometry`), so margins never depend on a scale factor.
const EDGE_MARGIN: i32 = 12;
const PANEL_GAP: i32 = 8;
const DRAG_SETTLE: Duration = Duration::from_millis(300);
const DAEMON_START_TIMEOUT: Duration = Duration::from_secs(20);

struct Shell {
    config: DesktopConfig,
    daemon: Arc<Daemon>,
    snap: mpsc::Sender<()>,
    /// False on native Wayland, where the compositor places windows (Hyprland window rules).
    places_windows: bool,
    /// The user hid the Dot window (S26.1); saved in `desktop.json`.
    rose_hidden: AtomicBool,
    /// Where the panel was when it was last hidden, for placing it without the Dot.
    panel_spot: Mutex<Option<(i32, i32)>>,
    /// While the panel fills the screen (S26.2): its frame before, to restore.
    full_screen: Mutex<Option<Rect>>,
    /// The shortcut that toggles the panel now; `None` while none is bound (native Wayland).
    shortcut: Mutex<Option<String>>,
}

/// The tray's rose item, relabeled when the rose is hidden or shown.
struct RoseMenuItem(MenuItem<tauri::Wry>);

/// The tray's "Open" item, whose accelerator label follows the shortcut (S33.3).
struct OpenMenuItem(MenuItem<tauri::Wry>);

/// On native Wayland the desktop binds `gentle-dot --toggle` itself.
const DESKTOP_OWNS_SHORTCUTS: &str =
    "On this desktop, global shortcuts are set in the system keyboard settings: bind `gentle-dot --toggle` there.";

/// Where `show_panel` puts the panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Placement {
    /// Leave it where it is: full screen, or a compositor that places windows itself.
    Keep,
    BesideDot,
    /// The rose is hidden: the remembered spot or the default one on the current display.
    Alone,
}

/// Opening the panel never depends on the Dot window being visible.
fn panel_placement(places_windows: bool, full_screen: bool, rose_hidden: bool) -> Placement {
    if !places_windows || full_screen {
        Placement::Keep
    } else if rose_hidden {
        Placement::Alone
    } else {
        Placement::BesideDot
    }
}

fn rose_menu_label(hidden: bool) -> &'static str {
    if hidden {
        "Show the rose"
    } else {
        "Hide the rose"
    }
}

fn desktop_file(config: &DesktopConfig) -> PathBuf {
    config.data_dir.join("desktop.json")
}

type CommandResult<T = ()> = Result<T, String>;

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn window(app: &AppHandle, label: &str) -> CommandResult<WebviewWindow> {
    app.get_webview_window(label).ok_or_else(|| format!("window `{label}` is missing"))
}

fn read_connection_info(config: &DesktopConfig) -> CommandResult<ConnectionInfo> {
    let token = std::fs::read_to_string(config.data_dir.join("token")).map_err(|e| format!("cannot read token: {e}"))?;
    Ok(config::connection_info(config.port, token.trim()))
}

/// Serves the daemon's requests on the app channel: native approvals (S25.3), connector secrets
/// from the secure store (S25.5), and registering the computer helper with a daemon this app just
/// spawned (S24.7, L61).
struct ChannelService {
    approvals: Approvals,
    computer: Option<Endpoint>,
    secrets: Box<dyn SecretStore>,
}

impl app_channel::Handler for ChannelService {
    fn approve(&self, request: &ApprovalRequest) -> bool {
        self.approvals.confirm(request) == Decision::Approved
    }

    fn secrets(&self) -> Option<&dyn SecretStore> {
        Some(self.secrets.as_ref())
    }

    fn opened(&self, channel: &Arc<AppChannel>) {
        let Some(endpoint) = self.computer.clone() else {
            return;
        };
        let channel = channel.clone();
        thread::spawn(move || {
            let params = serde_json::json!({ "url": endpoint.url, "token": endpoint.token });
            if let Err(error) = channel.request("computer_register", params, REGISTER_TIMEOUT) {
                eprintln!("gentle-dot: computer control was not registered with the assistant: {error}");
            }
        });
    }
}

/// A connector change from the panel (S25.2), sent over the app's channel on behalf of the panel's
/// window (`client_id`, from its `ready`), so its sign-in steps reach that window. Waits for the
/// daemon, which may first confirm a widening change in a native dialog.
#[tauri::command]
async fn connector_command(app: AppHandle, client_id: String, message: serde_json::Value) -> CommandResult {
    let daemon = app.state::<Shell>().daemon.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let channel = daemon.channel().ok_or_else(|| NO_CHANNEL.to_string())?;
        channel.command(&client_id, message)
    })
    .await
    .map_err(err)?
}

/// Waits until the daemon this app launched answers `/health`, then returns its URLs and token.
/// A daemon it did not launch is never used (S35.2): the answer is then the reason and its exit.
#[tauri::command]
async fn connection_info(app: AppHandle) -> CommandResult<ConnectionInfo> {
    let shell = app.state::<Shell>();
    let (config, daemon) = (shell.config.clone(), shell.daemon.clone());
    tauri::async_runtime::spawn_blocking(move || {
        daemon.wait_ready(DAEMON_START_TIMEOUT)?;
        read_connection_info(&config)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn toggle_panel(app: AppHandle) -> CommandResult {
    if window(&app, PANEL)?.is_visible().map_err(err)? {
        hide_panel(app)
    } else {
        show_panel(&app)
    }
}

#[tauri::command]
fn hide_panel(app: AppHandle) -> CommandResult {
    let panel = window(&app, PANEL)?;
    let shell = app.state::<Shell>();
    if shell.full_screen.lock().unwrap().is_none() {
        if let Ok(rect) = rect_of(&panel) {
            *shell.panel_spot.lock().unwrap() = Some((rect.x, rect.y));
        }
    }
    panel.hide().map_err(err)
}

#[tauri::command]
fn rose_hidden(app: AppHandle) -> bool {
    rose_hidden_state(&app)
}

/// Hides or shows the Dot window and remembers the choice. Returns whether it is hidden.
#[tauri::command]
fn set_rose_hidden(app: AppHandle, hidden: bool) -> CommandResult<bool> {
    let shell = app.state::<Shell>();
    position::save_rose_hidden(&desktop_file(&shell.config), hidden).map_err(err)?;
    shell.rose_hidden.store(hidden, Ordering::SeqCst);
    let dot = window(&app, DOT)?;
    if hidden {
        dot.hide().map_err(err)?;
    } else {
        dot.show().map_err(err)?;
    }
    if let Some(item) = app.try_state::<RoseMenuItem>() {
        item.0.set_text(rose_menu_label(hidden)).map_err(err)?;
    }
    app.emit("dot://rose", serde_json::json!({ "hidden": hidden })).map_err(err)?;
    Ok(hidden)
}

/// Fills the work area of the panel's display, or returns to the frame before (S26.2).
/// It stays an accessory window, never a separate macOS fullscreen Space. Returns the new state.
#[tauri::command]
fn set_panel_fullscreen(app: AppHandle, on: bool) -> CommandResult<bool> {
    let panel = window(&app, PANEL)?;
    let shell = app.state::<Shell>();
    let mut full_screen = shell.full_screen.lock().unwrap();
    let monitors = monitor_rects(&panel)?;
    match (on, *full_screen) {
        (true, None) => {
            let before = rect_of(&panel)?;
            let Some(area) = geometry::full_screen_rect(before, &monitors) else {
                return Ok(false);
            };
            // GTK keeps a non-resizable window at its content size.
            #[cfg(target_os = "linux")]
            panel.set_resizable(true).map_err(err)?;
            set_frame(&panel, area)?;
            *full_screen = Some(before);
        }
        (false, Some(before)) => {
            set_frame(&panel, geometry::restore_rect(before, &monitors, EDGE_MARGIN))?;
            *full_screen = None;
        }
        _ => {}
    }
    Ok(full_screen.is_some())
}

/// Result of `shortcut_get`: the shortcut that opens the panel and the default one.
#[derive(serde::Serialize)]
struct ShortcutInfo {
    shortcut: String,
    default: String,
}

/// Result of `shortcut_set`: the shortcut as saved.
#[derive(serde::Serialize)]
struct ShortcutChoice {
    shortcut: String,
}

#[tauri::command]
fn shortcut_get(app: AppHandle) -> ShortcutInfo {
    let shell = app.state::<Shell>();
    let current = shell.shortcut.lock().unwrap().clone().unwrap_or_else(|| shell.config.shortcut.clone());
    ShortcutInfo {
        shortcut: shortcut::normalize(&current).unwrap_or(current),
        default: DEFAULT_SHORTCUT.to_string(),
    }
}

/// Binds, saves, and shows a new panel shortcut at once (S33.3), or says why it cannot.
#[tauri::command]
async fn shortcut_set(app: AppHandle, shortcut: String) -> CommandResult<ShortcutChoice> {
    tauri::async_runtime::spawn_blocking(move || {
        let shell = app.state::<Shell>();
        if !shell.places_windows {
            return Err(DESKTOP_OWNS_SHORTCUTS.to_string());
        }
        let mut current = shell.shortcut.lock().unwrap();
        let host = ShortcutHost { app: &app, config_file: shell.config.data_dir.join("config.json") };
        let saved = shortcut::apply(&host, current.as_deref(), &shortcut)?;
        *current = Some(saved.clone());
        Ok(ShortcutChoice { shortcut: saved })
    })
    .await
    .map_err(err)?
}

struct ShortcutHost<'a> {
    app: &'a AppHandle,
    config_file: PathBuf,
}

impl shortcut::Host for ShortcutHost<'_> {
    fn bind_toggle(&self, shortcut: &str) -> Result<(), String> {
        self.app.global_shortcut().on_shortcut(shortcut, toggle_on_press).map_err(err)
    }

    fn unbind(&self, shortcut: &str) {
        if let Err(error) = self.app.global_shortcut().unregister(shortcut) {
            eprintln!("gentle-dot: cannot release shortcut `{shortcut}`: {error}");
        }
    }

    fn save(&self, shortcut: &str) -> Result<(), String> {
        config::save_shortcut(&self.config_file, shortcut)
    }

    fn label_tray(&self, shortcut: &str) {
        label_tray_open(self.app, shortcut);
    }
}

/// The accelerator is only a label; one the menu cannot show is left off.
fn label_tray_open(app: &AppHandle, shortcut: &str) {
    if let Some(item) = app.try_state::<OpenMenuItem>() {
        if item.0.set_accelerator(Some(shortcut)).is_err() {
            let _ = item.0.set_accelerator(None::<&str>);
        }
    }
}

#[tauri::command]
fn set_dot_state(app: AppHandle, state: String) -> CommandResult {
    let status = tray_status(&state).ok_or_else(|| format!("unknown state `{state}`"))?;
    let tray = app.tray_by_id(TRAY).ok_or("tray icon is missing")?;
    tray.set_tooltip(Some(&status.tooltip)).map_err(err)?;
    tray.set_icon(Some(Image::from_bytes(status.glyph.image(Os::CURRENT)).map_err(err)?)).map_err(err)?;
    tray.set_icon_as_template(is_template(Os::CURRENT)).map_err(err)
}

/// The window frame in points. Tao reports it in pixels of the window's current scale factor.
fn rect_of(window: &WebviewWindow) -> CommandResult<Rect> {
    let position = window.outer_position().map_err(err)?;
    let size = window.outer_size().map_err(err)?;
    let scale = window.scale_factor().map_err(err)?;
    Ok(geometry::to_points((position.x, position.y), (size.width, size.height), scale))
}

/// Work area (without menu bar and Dock) of a monitor in points, using that monitor's own scale factor.
fn work_area(monitor: &tauri::Monitor) -> Rect {
    let area = monitor.work_area();
    geometry::to_points(
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        monitor.scale_factor(),
    )
}

fn monitor_rects(window: &WebviewWindow) -> CommandResult<Vec<Rect>> {
    Ok(window.available_monitors().map_err(err)?.iter().map(work_area).collect())
}

fn move_to(window: &WebviewWindow, (x, y): (i32, i32)) -> CommandResult {
    window.set_position(LogicalPosition::new(f64::from(x), f64::from(y))).map_err(err)
}

fn set_frame(window: &WebviewWindow, rect: Rect) -> CommandResult {
    window.set_size(LogicalSize::new(f64::from(rect.width), f64::from(rect.height))).map_err(err)?;
    move_to(window, (rect.x, rect.y))
}

/// The work area under the pointer, or the primary one. Tao reports the pointer in pixels of the
/// primary monitor's scale factor.
fn current_monitor(app: &AppHandle, monitors: &[Rect]) -> CommandResult<Option<Rect>> {
    let primary = app.primary_monitor().map_err(err)?;
    let scale = primary.as_ref().map_or(1.0, |m| m.scale_factor());
    let points = |value: f64| (value / scale).round() as i32;
    let pointer = app.cursor_position().ok().map(|p| Rect::new(points(p.x), points(p.y), 0, 0));
    Ok(pointer.and_then(|p| geometry::monitor_for(p, monitors)).or_else(|| primary.as_ref().map(work_area)))
}

/// Keeps the Dot at exactly `DOT_SIZE` points, in case macOS or a monitor change resized it.
fn keep_dot_size(dot: &WebviewWindow, current: Rect) -> CommandResult {
    if (current.width, current.height) == (DOT_SIZE.0 as i32, DOT_SIZE.1 as i32) {
        return Ok(());
    }
    dot.set_size(LogicalSize::new(DOT_SIZE.0, DOT_SIZE.1)).map_err(err)
}

fn place_panel(app: &AppHandle) -> CommandResult {
    let shell = app.state::<Shell>();
    let full_screen = shell.full_screen.lock().unwrap().is_some();
    match panel_placement(shell.places_windows, full_screen, shell.rose_hidden.load(Ordering::SeqCst)) {
        Placement::Keep => Ok(()),
        Placement::BesideDot => place_panel_next_to_dot(app),
        Placement::Alone => place_panel_alone(app),
    }
}

fn place_panel_alone(app: &AppHandle) -> CommandResult {
    let panel = window(app, PANEL)?;
    let Some(current) = current_monitor(app, &monitor_rects(&panel)?)? else {
        return Ok(());
    };
    let remembered = *app.state::<Shell>().panel_spot.lock().unwrap();
    let size = (PANEL_SIZE.0 as i32, PANEL_SIZE.1 as i32);
    move_to(&panel, geometry::place_panel_alone(remembered, size, current, EDGE_MARGIN))
}

fn place_panel_next_to_dot(app: &AppHandle) -> CommandResult {
    let (dot, panel) = (window(app, DOT)?, window(app, PANEL)?);
    let mut dot_rect = rect_of(&dot)?;
    (dot_rect.width, dot_rect.height) = (DOT_SIZE.0 as i32, DOT_SIZE.1 as i32);
    let Some(monitor) = geometry::monitor_for(dot_rect, &monitor_rects(&dot)?) else {
        return Ok(());
    };
    // Both windows have fixed sizes. On Linux a panel that was never shown reports 0 × 0.
    let size = (PANEL_SIZE.0 as i32, PANEL_SIZE.1 as i32);
    let position = geometry::place_panel(dot_rect, size, monitor, PANEL_GAP, EDGE_MARGIN);
    move_to(&panel, position)
}

fn show_panel(app: &AppHandle) -> CommandResult {
    place_panel(app)?;
    let panel = window(app, PANEL)?;
    panel.show().map_err(err)?;
    panel.set_focus().map_err(err)?;
    app.emit("dot://panel-shown", ()).map_err(err)
}

/// Snaps the Dot to the nearest edge and persists the position.
fn snap_dot(app: &AppHandle) -> CommandResult {
    let dot = window(app, DOT)?;
    let mut current = rect_of(&dot)?;
    keep_dot_size(&dot, current)?;
    (current.width, current.height) = (DOT_SIZE.0 as i32, DOT_SIZE.1 as i32);
    let (x, y) = geometry::snap_to_edge(current, &monitor_rects(&dot)?, EDGE_MARGIN);
    if (x, y) != (current.x, current.y) {
        move_to(&dot, (x, y))?;
    }
    let shell = app.state::<Shell>();
    position::save(&desktop_file(&shell.config), DotPosition { x, y }).map_err(err)?;
    if window(app, PANEL)?.is_visible().unwrap_or(false) {
        place_panel(app)?;
    }
    Ok(())
}

/// Runs `snap_dot` once the Dot has stopped moving for `DRAG_SETTLE`.
fn spawn_snapper(app: AppHandle) -> mpsc::Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    thread::spawn(move || {
        while rx.recv().is_ok() {
            loop {
                match rx.recv_timeout(DRAG_SETTLE) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            if let Err(error) = snap_dot(&app) {
                eprintln!("gentle-dot: cannot snap the Dot: {error}");
            }
        }
    });
    tx
}

fn build_windows(
    app: &AppHandle,
    config: &DesktopConfig,
    places_windows: bool,
    rose_hidden: bool,
) -> tauri::Result<()> {
    let dot = WebviewWindowBuilder::new(app, DOT, WebviewUrl::App("index.html?surface=dot".into()))
        .title(DOT_TITLE)
        .inner_size(DOT_SIZE.0, DOT_SIZE.1)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .shadow(false)
        .visible(false);
    #[cfg(target_os = "macos")]
    let dot = dot.accept_first_mouse(true);
    // GTK sizes a non-resizable window to its content (200 × 200 in an X11 test), so on Linux
    // the Dot stays resizable and equal minimum and maximum sizes pin it at DOT_SIZE.
    #[cfg(target_os = "linux")]
    let dot = dot.resizable(true).min_inner_size(DOT_SIZE.0, DOT_SIZE.1).max_inner_size(DOT_SIZE.0, DOT_SIZE.1);
    let dot = dot.build()?;
    // Linux has no window effects; the panel URL tells the UI to paint an opaque background.
    let panel = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App(platform::panel_url(Os::CURRENT).into()))
        .title(PANEL_TITLE)
        .inner_size(PANEL_SIZE.0, PANEL_SIZE.1)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        // Lets the chat receive HTML5 drops of attachments (S31); Tauri's own handler would take them.
        .disable_drag_drop_handler()
        .visible(false);
    #[cfg(target_os = "macos")]
    let panel = panel
        .effects(EffectsBuilder::new().effect(Effect::HudWindow).state(EffectState::Active).radius(20.0).build());
    panel.build()?;

    if !places_windows {
        // Native Wayland ignores positions; Hyprland window rules place and pin the Dot.
        if !rose_hidden {
            dot.show()?;
        }
        return Ok(());
    }

    // Restore the saved position (re-snapped in case the monitors changed), or
    // default to the right edge of the primary monitor, vertically centered.
    // Everything is in points: before it is shown, the window may sit on a
    // monitor with another scale factor than the one it is moved to.
    let monitors = monitor_rects(&dot).unwrap_or_default();
    let size = (DOT_SIZE.0 as i32, DOT_SIZE.1 as i32);
    let primary = app.primary_monitor()?.as_ref().map(work_area);
    let saved = position::load(&desktop_file(config)).map(|p| (p.x, p.y));
    if let Some((x, y)) = geometry::initial_dot_position(saved, size, &monitors, primary, EDGE_MARGIN) {
        dot.set_position(LogicalPosition::new(f64::from(x), f64::from(y)))?;
    }
    // Set the size again once the window is in place, so it is exactly DOT_SIZE points there.
    dot.set_size(LogicalSize::new(DOT_SIZE.0, DOT_SIZE.1))?;
    // A hidden rose stays placed, ready for "Show the rose".
    if !rose_hidden {
        dot.show()?;
    }
    Ok(())
}

/// Whether the conversations list is on, read like the daemon reads it (`GENTLE_DOT_CONVERSATIONS=1`).
fn conversations_on(value: Option<&str>) -> bool {
    value == Some("1")
}

/// The tray menu, top to bottom (`-` is a separator). "New conversation" only exists with the
/// conversations list on; in the single continuous chat there is nothing new to start.
/// "Stop computer control" and "Yolo mode" exist where computer control does (macOS, S24.3, S24.9).
/// "rose" hides or shows the floating Dot (S26.1).
fn tray_menu_ids(conversations: bool, computer_control: bool) -> Vec<&'static str> {
    let mut ids = vec!["open"];
    if conversations {
        ids.push("new");
    }
    ids.extend(["browser", "rose"]);
    if computer_control {
        ids.extend(["computer-stop", "computer-yolo"]);
    }
    ids.extend(["-", "restart", "autostart", "-", "quit"]);
    ids
}

fn build_tray(app: &AppHandle, config: &DesktopConfig, rose_hidden: bool) -> tauri::Result<TrayIcon> {
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    // The accelerator is only a label here; an unparsable one must not break the menu.
    let open = MenuItem::with_id(app, "open", "Open", true, Some(config.shortcut.as_str()))
        .or_else(|_| MenuItem::with_id(app, "open", "Open", true, None::<&str>))?;
    app.manage(OpenMenuItem(open.clone()));
    let menu = Menu::new(app)?;
    let conversations = conversations_on(std::env::var("GENTLE_DOT_CONVERSATIONS").ok().as_deref());
    for id in tray_menu_ids(conversations, cfg!(target_os = "macos")) {
        match id {
            "open" => menu.append(&open)?,
            "new" => menu.append(&MenuItem::with_id(app, "new", "New conversation", true, None::<&str>)?)?,
            "browser" => menu.append(&MenuItem::with_id(app, "browser", "Open in browser", true, None::<&str>)?)?,
            "rose" => {
                let item = MenuItem::with_id(app, "rose", rose_menu_label(rose_hidden), true, None::<&str>)?;
                menu.append(&item)?;
                app.manage(RoseMenuItem(item));
            }
            "computer-stop" => menu.append(&MenuItem::with_id(
                app,
                "computer-stop",
                "Stop computer control",
                true,
                None::<&str>,
            )?)?,
            "computer-yolo" => {
                // Off at launch: yolo mode never outlives the app (S24.9).
                let item = CheckMenuItem::with_id(app, "computer-yolo", "Yolo mode", true, false, None::<&str>)?;
                menu.append(&item)?;
                app.manage(computer::YoloMenuItem(item));
            }
            "restart" => {
                menu.append(&MenuItem::with_id(app, "restart", "Restart assistant", true, None::<&str>)?)?;
            }
            "autostart" => menu.append(&CheckMenuItem::with_id(
                app,
                "autostart",
                "Launch at login",
                true,
                autostart,
                None::<&str>,
            )?)?,
            "quit" => menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?,
            _ => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    TrayIconBuilder::with_id(TRAY)
        .icon(Image::from_bytes(TrayGlyph::Unavailable.image(Os::CURRENT))?)
        .icon_as_template(is_template(Os::CURRENT))
        .tooltip("Gentle Dot")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            let result = match event.id().as_ref() {
                "open" => show_panel(app),
                "new" => show_panel(app).and_then(|()| app.emit("dot://new-conversation", ()).map_err(err)),
                "browser" => open_in_browser(app),
                "rose" => set_rose_hidden(app.clone(), !rose_hidden_state(app)).map(|_| ()),
                "computer-stop" => {
                    computer::stop(app, Reason::Stopped);
                    Ok(())
                }
                "computer-yolo" => {
                    computer::toggle_yolo(app);
                    Ok(())
                }
                "restart" => {
                    restart_daemon(app.clone());
                    Ok(())
                }
                "autostart" => toggle_autostart(app, &menu),
                "quit" => {
                    app.exit(0);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(error) = result {
                show_message(app, MessageDialogKind::Error, &error);
            }
        })
        .build(app)
}

fn rose_hidden_state(app: &AppHandle) -> bool {
    app.state::<Shell>().rose_hidden.load(Ordering::SeqCst)
}

fn show_message(app: &AppHandle, kind: MessageDialogKind, text: &str) {
    app.dialog().message(text).title("Gentle Dot").kind(kind).show(|_| {});
}

fn open_in_browser(app: &AppHandle) -> CommandResult {
    let info = read_connection_info(&app.state::<Shell>().config)?;
    app.opener().open_url(info.web_url, None::<&str>).map_err(err)
}

fn toggle_autostart(app: &AppHandle, menu: &Menu<tauri::Wry>) -> CommandResult {
    let autolaunch = app.autolaunch();
    if autolaunch.is_enabled().map_err(err)? {
        autolaunch.disable().map_err(err)?;
    } else {
        autolaunch.enable().map_err(err)?;
    }
    if let Some(item) = menu.get("autostart").and_then(|item| item.as_check_menuitem().cloned()) {
        item.set_checked(autolaunch.is_enabled().unwrap_or(false)).map_err(err)?;
    }
    Ok(())
}

fn restart_daemon(app: AppHandle) {
    let (daemon, port) = (app.state::<Shell>().daemon.clone(), app.state::<Shell>().config.port);
    thread::spawn(move || match daemon.restart(DAEMON_START_TIMEOUT) {
        RestartOutcome::Restarted => {}
        RestartOutcome::External => {
            show_message(&app, MessageDialogKind::Warning, &daemon::foreign_daemon_message(port))
        }
        RestartOutcome::Failed(error) => {
            show_message(&app, MessageDialogKind::Error, &format!("The assistant could not restart: {error}"))
        }
    });
}

/// ⌥⇧Esc ends computer control from anywhere, even while another app is in front.
#[cfg(target_os = "macos")]
fn register_panic_shortcut(app: &AppHandle) {
    let handler = |app: &AppHandle, _: &_, event: tauri_plugin_global_shortcut::ShortcutEvent| {
        if event.state() == ShortcutState::Pressed {
            computer::stop(app, Reason::Panic);
        }
    };
    if let Err(error) = app.global_shortcut().on_shortcut(computer::PANIC_SHORTCUT, handler) {
        eprintln!("gentle-dot: the computer-control panic shortcut is unavailable: {error}");
    }
}

/// What the panel shortcut does, at launch and after a change in Settings.
fn toggle_on_press(app: &AppHandle, _: &Shortcut, event: ShortcutEvent) {
    if event.state() == ShortcutState::Pressed {
        if let Err(error) = toggle_panel(app.clone()) {
            eprintln!("gentle-dot: cannot toggle the panel: {error}");
        }
    }
}

/// Binds the configured shortcut, or the default one when it is unavailable. Returns the bound one.
fn register_shortcut(app: &AppHandle, shortcut: &str) -> Option<String> {
    match app.global_shortcut().on_shortcut(shortcut, toggle_on_press) {
        Ok(()) => return Some(shortcut.to_string()),
        Err(error) => eprintln!("gentle-dot: shortcut `{shortcut}` is unavailable ({error}); using {DEFAULT_SHORTCUT}"),
    }
    if shortcut != DEFAULT_SHORTCUT && app.global_shortcut().on_shortcut(DEFAULT_SHORTCUT, toggle_on_press).is_ok() {
        return Some(DEFAULT_SHORTCUT.to_string());
    }
    None
}

/// A launch of `gentle-dot` (usually `--toggle` from a desktop shortcut) reaches the running app.
fn handle_launch(app: &AppHandle, args: &[String]) {
    let result = match platform::launch_request(args) {
        LaunchRequest::Toggle => toggle_panel(app.clone()),
        LaunchRequest::Show => show_panel(app),
    };
    if let Err(error) = result {
        eprintln!("gentle-dot: cannot show the panel: {error}");
    }
}

pub fn run() {
    // GNOME on Wayland: run under XWayland so the Dot can place itself, stay on top, and snap.
    // This must happen before GTK starts.
    #[cfg(target_os = "linux")]
    if let Some(backend) = platform::forced_gdk_backend(|key| std::env::var(key).ok()) {
        std::env::set_var("GDK_BACKEND", backend);
    }
    let places_windows = !platform::compositor_places_windows(|key| std::env::var(key).ok());
    let config = config::load_config();
    tauri::Builder::default()
        // First, so a second launch forwards its arguments and exits before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| handle_launch(app, &args)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            connection_info,
            toggle_panel,
            hide_panel,
            set_dot_state,
            rose_hidden,
            set_rose_hidden,
            set_panel_fullscreen,
            shortcut_get,
            shortcut_set,
            connector_command,
            computer::computer_endpoint,
            computer::computer_permissions,
            computer::computer_request_permission,
            computer::computer_stop,
            computer::computer_status,
            computer::computer_set_yolo,
            voice::voice_status,
            voice::voice_start,
            voice::voice_stop,
            voice::voice_cancel,
            voice::voice_model_status,
            voice::voice_model_download,
            voice::voice_model_cancel,
            voice::voice_model_remove
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();

            // Computer control first: a daemon this app spawns gets the helper over its channel.
            let computer = computer::start(&handle);
            let service = ChannelService {
                approvals: Approvals::new(Arc::new(NativePrompt::new(handle.clone())), APPROVAL_TIMEOUT),
                computer: computer.endpoint(),
                secrets: secure_store::connector_store(),
            };
            app.manage(computer);
            let runtime_dir = daemon::runtime_dir(|key| std::env::var(key).ok(), app.path().resource_dir().ok());
            let daemon = Arc::new(
                Daemon::new(config.port, config.data_dir.clone(), runtime_dir).with_channel(Arc::new(service)),
            );
            let (starter, notifier) = (daemon.clone(), handle.clone());
            thread::spawn(move || {
                if let Err(error) = starter.ensure_running(DAEMON_START_TIMEOUT) {
                    eprintln!("gentle-dot: {error}");
                    // Another daemon holds the port (S35.2): say so, with the way out, instead of using it.
                    if starter.refusal().is_some() {
                        show_message(&notifier, MessageDialogKind::Warning, &error);
                    }
                }
            });
            let rose_hidden = position::load_rose_hidden(&desktop_file(&config));
            app.manage(Shell {
                config: config.clone(),
                daemon,
                snap: spawn_snapper(handle.clone()),
                places_windows,
                rose_hidden: AtomicBool::new(rose_hidden),
                panel_spot: Mutex::new(None),
                full_screen: Mutex::new(None),
                shortcut: Mutex::new(None),
            });
            let (voice_input, voice_model) = voice::start(&handle);
            app.manage(voice_input);
            app.manage(voice_model);
            #[cfg(target_os = "macos")]
            register_panic_shortcut(&handle);

            build_windows(&handle, &config, places_windows, rose_hidden)?;
            build_tray(&handle, &config, rose_hidden)?;
            if places_windows {
                let bound = register_shortcut(&handle, &config.shortcut);
                if let Some(bound) = &bound {
                    label_tray_open(&handle, bound);
                }
                *app.state::<Shell>().shortcut.lock().unwrap() = bound;
                let snap = app.state::<Shell>().snap.clone();
                window(&handle, DOT)?.on_window_event(move |event| {
                    // A move, or a new monitor scale, re-snaps the Dot and restores its size.
                    if let WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. } = event {
                        let _ = snap.send(());
                    }
                });
            } else {
                eprintln!(
                    "gentle-dot: native Wayland: the desktop places the windows and owns shortcuts; bind `gentle-dot --toggle` (docs/linux-testing.md)"
                );
            }
            // Started by the shortcut while not running: open the panel right away.
            let args: Vec<String> = std::env::args().collect();
            if platform::launch_request(&args) == LaunchRequest::Toggle {
                handle_launch(&handle, &args);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Gentle Dot")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<Shell>().daemon.stop();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_hides_new_conversation_in_the_single_chat() {
        assert_eq!(
            tray_menu_ids(false, false),
            vec!["open", "browser", "rose", "-", "restart", "autostart", "-", "quit"]
        );
    }

    #[test]
    fn tray_shows_new_conversation_with_the_conversations_list() {
        assert_eq!(
            tray_menu_ids(true, false),
            vec!["open", "new", "browser", "rose", "-", "restart", "autostart", "-", "quit"]
        );
    }

    #[test]
    fn tray_offers_stop_computer_control_where_it_exists() {
        assert_eq!(
            tray_menu_ids(false, true),
            vec!["open", "browser", "rose", "computer-stop", "computer-yolo", "-", "restart", "autostart", "-", "quit"]
        );
    }

    #[test]
    fn the_rose_item_offers_the_opposite_of_its_state() {
        assert_eq!(rose_menu_label(false), "Hide the rose");
        assert_eq!(rose_menu_label(true), "Show the rose");
    }

    #[test]
    fn shortcut_and_tray_open_place_the_panel_without_the_rose_when_it_is_hidden() {
        // `toggle_panel` (the shortcut) and the tray's Open both go through `show_panel`.
        assert_eq!(panel_placement(true, false, false), Placement::BesideDot);
        assert_eq!(panel_placement(true, false, true), Placement::Alone);
        // Full screen keeps its frame; native Wayland leaves placement to the compositor.
        assert_eq!(panel_placement(true, true, true), Placement::Keep);
        assert_eq!(panel_placement(true, true, false), Placement::Keep);
        assert_eq!(panel_placement(false, false, true), Placement::Keep);
    }

    #[test]
    fn the_shortcut_and_connector_commands_are_registered_and_granted_to_the_panel_only() {
        let build = include_str!("../build.rs");
        let capabilities: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        for command in ["shortcut_get", "shortcut_set", "connector_command"] {
            assert!(build.contains(&format!("\"{command}\",")), "{command} is missing from build.rs");
            let permission = format!("allow-{}", command.replace('_', "-"));
            let windows: Vec<&serde_json::Value> = capabilities["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c["permissions"].as_array().unwrap().iter().any(|p| p == permission.as_str()))
                .flat_map(|c| c["windows"].as_array().unwrap())
                .collect();
            assert_eq!(windows, ["panel"], "{permission}");
        }
    }

    #[test]
    fn conversations_flag_reads_like_the_daemon() {
        assert!(conversations_on(Some("1")));
        assert!(!conversations_on(None));
        assert!(!conversations_on(Some("0")));
        assert!(!conversations_on(Some("true")));
    }
}
