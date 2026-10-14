//! Tauri wiring: windows, commands, tray menu, global shortcut, Dot snapping,
//! hiding the rose, the full-screen panel, voice input, the shortcut chosen in Settings,
//! the daemon lifecycle (design §9), and the app's private channel to the daemon (S25.1–S25.3).

use crate::app_channel::{self, AppChannel, NO_CHANNEL, REGISTER_TIMEOUT};
use crate::approvals::{native::NativePrompt, ApprovalRequest, Approvals, Decision, APPROVAL_TIMEOUT};
use crate::computer::app as computer;
use crate::computer::server::Endpoint;
use crate::computer::session::Reason;
use crate::computer::working::{self, Part};
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
#[cfg(target_os = "linux")]
use crate::niri::CompactSpot;
use crate::niri::gate::niri_trace;
use crate::niri::unit::*;
#[cfg(target_os = "linux")]
use crate::niri::gate::*;
// Slice-4a reorganization: these were shell-private helpers in the source
// snapshot and now live in `niri/route_gate.rs`; imported, never redefined.
#[cfg(target_os = "linux")]
use crate::niri::route_gate::{
    joint_mover_from_signals, native_restore_planned, niri_socket_present, shared_route_wanted,
};
#[cfg(target_os = "linux")]
use gtk::prelude::{GtkWindowExt, WidgetExt};
#[cfg(target_os = "linux")]
use std::sync::atomic::AtomicU64;
#[cfg(target_os = "linux")]
use crate::niri::unit_state::NiriUnitState;
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
use tauri_plugin_autostart::ManagerExt as _;
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
/// Sent to the Dot and the panel each time the assistant this app may use starts answering (at
/// launch or after Restart assistant): a window that was refused, or whose `connection_info` gave up
/// first, asks again and connects without a reopen (S35.2).
const ASSISTANT_READY: &str = "dot://assistant-ready";

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
    /// Niri-native expanded state (Linux only): tiling is expanded,
    /// floating is compact. Separate from `full_screen`/`panel_spot`, which
    /// the native branch never reads or writes.
    #[cfg(target_os = "linux")]
    native_expanded: Mutex<bool>,
    /// Remembered Niri compact spot (Linux only): in-session only.
    #[cfg(target_os = "linux")]
    native_compact: Mutex<Option<CompactSpot>>,
    /// Cached covered calibration (Linux only): the last successful
    /// probe's work area plus observed client offset, valid only under its
    /// output layout key. A transition reuses it with zero probe moves
    /// while the live output key still matches; any key change re-measures.
    #[cfg(target_os = "linux")]
    pub(crate) native_unit_cache: Mutex<Option<crate::niri::unit_restore::CachedCalibration>>,
    /// Restore generation (Linux only): hide/show/mode bump it and the
    /// worker drops older jobs. Atomic, so no lock ordering is needed.
    #[cfg(target_os = "linux")]
    native_epoch: AtomicU64,
    /// Handoff to the single restore worker (Linux only): capacity-1
    /// signal plus the generation above. Taken on exit so the worker drops
    /// its handle clone at shutdown instead of lingering.
    #[cfg(target_os = "linux")]
    native_restore: Mutex<Option<mpsc::SyncSender<()>>>,
    /// First-visible-frame gate (experimental, Niri compact only, Linux
    /// only): `Some(job)` while a gated show is mapped at opacity 0 awaiting
    /// the worker's settled reveal. Epoch-bound alongside `native_epoch`:
    /// hide/mode bumps stale it, a newer show overwrites it. No new thread;
    /// the existing worker's completion reveals. The window itself stays
    /// really mapped (`hide()` still unmaps, `is_visible` still works), so no
    /// persistent logical-visibility latch is needed — only this short gate.
    #[cfg(target_os = "linux")]
    pub(crate) native_gate: Mutex<Option<u64>>,
    /// Dormant shared-unit logical state (Linux only): explicit
    /// activation plus logical chat-open. The PANEL anchor stays
    /// `native_compact` — this adapter owns NO position. Initial FALSE.
    #[cfg(target_os = "linux")]
    native_unit: Mutex<NiriUnitState>,
    /// Joint unit (Niri only, additive): the SOLE anchor writers are the
    /// EventStream follow (user move, via `native_mover`) and the explicit
    /// hide/expand capture. The worker NEVER rewrites the anchor from its
    /// own joint moves — that is the anti-ping-pong by construction.
    /// `native_mover` carries who moved (Dot/Panel) from follow to worker;
    /// `native_suppress_until` mutes follow echoes of our own joint pass.
    #[cfg(target_os = "linux")]
    native_mover: Mutex<Option<crate::niri::Mover>>,
    #[cfg(target_os = "linux")]
    native_suppress_until: Mutex<Option<std::time::Instant>>,
    /// Cancelled collapse cover (Linux only): `Some(job)` once a
    /// cover acknowledgment times out, so the late cover closure can never
    /// re-apply opacity 0 after cleanup. Shared state, never a local flag;
    /// job-scoped, so no clearing is needed (generations never repeat).
    #[cfg(target_os = "linux")]
    cover_cancelled: Mutex<Option<u64>>,
    /// Composed Niri I/O ownership (Linux only): serializes MODE +
    /// RESTORE worker query/action/verify traffic. Raw clients open a fresh
    /// socket per request and cannot serialize transactions; this mutex does.
    /// Strict root of the domain: brief state reads may nest under it, but
    /// state locks never nest over it — and it is never held across sleeps,
    /// getters, waits, or queued-and-waited UI callbacks. Hide/show capture
    /// stays synchronous outside it, as do reveal/cancel
    /// deliveries after the worker returns.
    /// (Hide capture runs on the blocking pool under it; shows settle
    /// through the worker instead — there is no show capture.)
    #[cfg(target_os = "linux")]
    native_io: Mutex<()>,
    /// The shortcut that toggles the panel now; `None` while none is bound (native Wayland).
    shortcut: Mutex<Option<String>>,
}

/// The Dot and the panel as computer control hides them during a call (S1, S5): never through
/// `hide_panel` or `show_panel`, so the remembered spot, the full-screen frame, the rose choice,
/// and the keyboard focus stay as they were. Main thread only.
struct ShellWindows(AppHandle);

impl ShellWindows {
    fn get(&self, part: Part) -> Option<WebviewWindow> {
        self.0.get_webview_window(match part {
            Part::Dot => DOT,
            Part::Panel => PANEL,
        })
    }
}

impl working::Windows for ShellWindows {
    fn is_visible(&self, part: Part) -> bool {
        self.get(part).and_then(|window| window.is_visible().ok()).unwrap_or(false)
    }

    fn hide(&self, part: Part) -> Result<(), String> {
        self.get(part).ok_or_else(|| format!("window {part:?} is missing"))?.hide().map_err(err)
    }

    fn show(&self, part: Part) {
        let Some(window) = self.get(part) else { return };
        #[cfg(target_os = "macos")]
        let shown = computer::show_without_focus(&window);
        #[cfg(not(target_os = "macos"))]
        let shown = window.show().map_err(err);
        if let Err(error) = shown {
            eprintln!("gentle-dot: cannot show the {part:?} again: {error}");
        }
    }

    fn rose_hidden(&self) -> bool {
        self.0.try_state::<Shell>().is_some_and(|shell| shell.rose_hidden.load(Ordering::SeqCst))
    }
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

/// Whether the current panel frame may be remembered as the user-moved spot.
/// Only a mapped frame counts: nonzero size plus shown state. The origin is
/// never checked, so a genuine (0, 0) is kept while a never-shown startup
/// rect (0x0, hidden) is rejected. Fullscreen frames and native-Wayland
/// coordinates (the compositor owns placement there) are never authoritative.
fn panel_capture_valid(
    places_windows: bool,
    full_screen: bool,
    width: i32,
    height: i32,
    visible: bool,
) -> bool {
    places_windows && !full_screen && visible && width > 0 && height > 0
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

pub(crate) type CommandResult<T = ()> = Result<T, String>;

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
/// Replacing an earlier app's daemon can take longer than this waits (up to 17 s before the spawn);
/// the windows then connect on [`ASSISTANT_READY`].
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
    let autostart = autostart_checked(app);
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

/// Initial "Launch at login" checkbox state. On Linux this is the truthful
/// check (task 5): a candidate entry counts only with a resolving `Exec`, so
/// a stale file never shows checked. Fail-closed: without a home directory
/// there is nothing verifiable, so unchecked plus a log line.
fn autostart_checked(app: &AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        // D5: the Niri side runs only on Niri. Niri never runs XDG
        // Autostart, so there checked needs BOTH the valid desktop entry
        // AND the managed Niri block; elsewhere only the XDG entry counts
        // and Niri config is never read. Opt-in on both: nothing enables.
        let niri_session = platform::is_niri(&|key| std::env::var(key).ok());
        match (crate::autostart::autostart_dir(), crate::autostart::config_dir()) {
            (Some(dir), Some(config)) if niri_session => {
                // Dual state (task 6): a half state logs which side is
                // missing and reads unchecked.
                let include = crate::autostart::niri_include_file(&config);
                let niri = crate::autostart::read_niri_include(&include);
                let state = crate::autostart::login_state(&dir, &crate::autostart::path_dirs(), niri.as_deref());
                if !state.enabled() && (state.xdg || state.niri) {
                    eprintln!(
                        "gentle-dot: launch at login is only half set up (missing {}); showing unchecked",
                        state.missing().join(" and ")
                    );
                }
                crate::autostart::checked_for(state, true)
            }
            (Some(dir), _) => {
                // Non-Niri Linux keeps the XDG entry/plugin behavior: the
                // Niri include is neither read nor required here.
                crate::autostart::checked_for(crate::autostart::xdg_state(&dir, &crate::autostart::path_dirs()), false)
            }
            _ => {
                eprintln!("gentle-dot: cannot read login autostart state: no home directory");
                false
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Fail-closed with a log line: a failed re-read is never silently
        // absorbed into an unchecked box.
        match app.autolaunch().is_enabled() {
            Ok(enabled) => enabled,
            Err(error) => {
                eprintln!("gentle-dot: cannot read login autostart state: {error}");
                false
            }
        }
    }
}

fn toggle_autostart(app: &AppHandle, menu: &Menu<tauri::Wry>) -> CommandResult {
    // Linux (task 5): toggle against the truthful state, converge to the
    // single stable entry, and verify the flip landed. The checkbox never
    // silently absorbs an error: a failed refresh is a command error with
    // the box untouched, surfaced by the existing error dialog.
    #[cfg(target_os = "linux")]
    {
        // Dual toggle (task 6) gated by D5: the XDG entry alone never
        // launches on Niri, so there enable writes it AND the managed
        // `spawn-at-startup` block in the Niri include, and disable removes
        // both. Other Linux toggles the XDG entry/plugin path alone and
        // never creates or touches Niri config. Nothing here runs except
        // through this explicit toggle: no startup, setup, or import path
        // touches either backend.
        let dir = crate::autostart::autostart_dir()
            .ok_or_else(|| "cannot toggle launch at login: no home directory".to_string())?;
        let niri_session = platform::is_niri(&|key| std::env::var(key).ok());
        let include = if niri_session {
            Some(crate::autostart::niri_include_file(
                &crate::autostart::config_dir()
                    .ok_or_else(|| "cannot toggle launch at login: no home directory".to_string())?,
            ))
        } else {
            None
        };
        let path_dirs = crate::autostart::path_dirs();
        let state = match &include {
            Some(file) => {
                let niri = crate::autostart::read_niri_include(file);
                crate::autostart::login_state(&dir, &path_dirs, niri.as_deref())
            }
            None => crate::autostart::xdg_state(&dir, &path_dirs),
        };
        let enabled = crate::autostart::checked_for(state, niri_session);
        let autolaunch = app.autolaunch();
        if enabled {
            autolaunch.disable().map_err(err)?;
            crate::autostart::remove_other_entries(&dir, None).map_err(err)?;
            if let Some(file) = &include {
                crate::autostart::remove_niri_block(file).map_err(err)?;
            }
        } else {
            // The entry's Exec is the running binary: refuse to register a
            // path that does not resolve, instead of writing a stale entry.
            let exe = std::env::current_exe().map_err(err)?;
            if !exe.is_absolute() || !exe.exists() {
                return Err("cannot enable launch at login: the app path does not resolve".to_string());
            }
            autolaunch.enable().map_err(err)?;
            let entries = crate::autostart::entry_files(&dir);
            crate::autostart::remove_other_entries(&dir, Some(&entries[0])).map_err(err)?;
            if let Some(file) = &include {
                crate::autostart::ensure_niri_block(file, &exe).map_err(err)?;
            }
        }
        let fresh = match &include {
            Some(file) => {
                let fresh_niri = crate::autostart::read_niri_include(file);
                crate::autostart::login_state(&dir, &crate::autostart::path_dirs(), fresh_niri.as_deref())
            }
            None => crate::autostart::xdg_state(&dir, &crate::autostart::path_dirs()),
        };
        if crate::autostart::checked_for(fresh, niri_session) == enabled {
            let mut message =
                "launch at login did not change: the autostart entry was not updated".to_string();
            if niri_session && !fresh.missing().is_empty() {
                message.push_str(&format!(" (missing {})", fresh.missing().join(" and ")));
            }
            return Err(message);
        }
        if let Some(item) = menu.get("autostart").and_then(|item| item.as_check_menuitem().cloned()) {
            item.set_checked(crate::autostart::checked_for(fresh, niri_session)).map_err(err)?;
        }
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        let autolaunch = app.autolaunch();
        if autolaunch.is_enabled().map_err(err)? {
            autolaunch.disable().map_err(err)?;
        } else {
            autolaunch.enable().map_err(err)?;
        }
        // Truthful refresh here too: a failed re-read is an error for the
        // existing dialog, never a silent unchecked box.
        let fresh = autolaunch.is_enabled().map_err(err)?;
        if let Some(item) = menu.get("autostart").and_then(|item| item.as_check_menuitem().cloned()) {
            item.set_checked(fresh).map_err(err)?;
        }
        Ok(())
    }
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
        .plugin({
            // Login autostart (task 5): on Linux the entry identity is pinned
            // to the stable binary name instead of the plugin default
            // `package_info().name` (the productName "Gentle Dot"), so
            // enables land on one `gentle-dot.desktop` with an absolute
            // `Exec`. Other platforms keep the previous default identity.
            #[cfg(target_os = "linux")]
            let autostart_plugin =
                tauri_plugin_autostart::Builder::new().app_name(crate::autostart::STABLE_APP_NAME);
            #[cfg(not(target_os = "linux"))]
            let autostart_plugin = tauri_plugin_autostart::Builder::new();
            autostart_plugin.build()
        })
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
            computer::computer_working_ready,
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
            let computer = computer::start(&handle, Arc::new(ShellWindows(handle.clone())));
            let service = ChannelService {
                approvals: Approvals::new(Arc::new(NativePrompt::new(handle.clone())), APPROVAL_TIMEOUT),
                computer: computer.endpoint(),
                secrets: secure_store::connector_store(),
            };
            app.manage(computer);
            let runtime_dir = daemon::runtime_dir(|key| std::env::var(key).ok(), app.path().resource_dir().ok());
            let announcer = handle.clone();
            let daemon = Arc::new(
                Daemon::new(config.port, config.data_dir.clone(), runtime_dir)
                    .with_channel(Arc::new(service))
                    .on_ready(Arc::new(move || {
                        if let Err(error) = announcer.emit(ASSISTANT_READY, ()) {
                            eprintln!("gentle-dot: cannot tell the windows the assistant is ready: {error}");
                        }
                    })),
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
            #[cfg(target_os = "linux")]
            let (native_restore, native_receiver): (Option<mpsc::SyncSender<()>>, Option<mpsc::Receiver<()>>) =
                if native_restore_planned(
                    places_windows,
                    platform::is_niri(&|key| std::env::var(key).ok()),
                ) {
                    // Channel only: the worker thread starts after `manage`
                    // below, so its first state read cannot panic and no
                    // pre-registration wake is lost (capacity-1 + epoch).
                    let (tx, rx) = mpsc::sync_channel::<()>(1);
                    (Some(tx), Some(rx))
                } else {
                    (None, None)
                };
            app.manage(Shell {
                config: config.clone(),
                daemon,
                snap: spawn_snapper(handle.clone()),
                places_windows,
                rose_hidden: AtomicBool::new(rose_hidden),
                panel_spot: Mutex::new(None),
                full_screen: Mutex::new(None),
                #[cfg(target_os = "linux")]
                native_expanded: Mutex::new(false),
                #[cfg(target_os = "linux")]
                native_compact: Mutex::new(None),
                #[cfg(target_os = "linux")]
                native_epoch: AtomicU64::new(0),
                #[cfg(target_os = "linux")]
                native_restore: Mutex::new(native_restore),
                #[cfg(target_os = "linux")]
                native_gate: Mutex::new(None),
                native_unit: Mutex::new(NiriUnitState::dormant()),
                #[cfg(target_os = "linux")]
                native_mover: Mutex::new(None),
                #[cfg(target_os = "linux")]
                native_suppress_until: Mutex::new(None),
                #[cfg(target_os = "linux")]
                cover_cancelled: Mutex::new(None),
                #[cfg(target_os = "linux")]
                native_io: Mutex::new(()),
                native_unit_cache: Mutex::new(None),
                shortcut: Mutex::new(None),
            });
            #[cfg(target_os = "linux")]
            let follow_planned = native_receiver.is_some();
            // Native follow shares the restore worker as its single writer:
            // the subscriber only wakes it after a debounced owned-dot
            // signal and exits with the restore channel on shutdown.
            #[cfg(target_os = "linux")]
            if follow_planned {
                spawn_follow_worker(handle.clone());
            }
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
                // Disconnect the restore worker: its wait then ends instead of
                // lingering on its handle clone past shutdown.
                #[cfg(target_os = "linux")]
                let _restore_taken = app.state::<Shell>().native_restore.lock().unwrap().take();
            }
        });
}

/// Queues the collapse cover on the main thread and returns its ack channel.
/// The guard is epoch-only — no gate is published
/// yet, since the restore handoff runs after the transition — so a stale
/// job plans nothing and still acks, and the waiter never hangs. Opacity 0
/// covers the already-mapped collapsing window, so `ignore(true)` never
/// touches the pre-realize abort arm: the show-before-ignore crash fix is
/// untouched.
#[cfg(target_os = "linux")]
fn dispatch_collapse_cover(app: &AppHandle, panel: &WebviewWindow, job: u64) -> mpsc::Receiver<()> {
    let (ack_tx, ack_rx) = mpsc::channel();
    let (cover, cover_app) = (panel.clone(), app.clone());
    let _ = panel.run_on_main_thread(move || {
        let done = || {
            let _ = ack_tx.send(());
        };
        let shell = cover_app.state::<Shell>();
        let cancelled = *shell.cover_cancelled.lock().unwrap();
        if !cover_apply_allowed(job, shell.native_epoch.load(Ordering::SeqCst), cancelled) {
            done();
            return;
        }
        if let Ok(gtk_window) = cover.gtk_window() {
            gtk_window.set_opacity(GATED_OPACITY_HIDDEN);
            gtk_window.set_accept_focus(false);
        }
        let _ = cover.set_ignore_cursor_events(true);
        done();
    });
    ack_rx
}

/// Production finish: thin wrapper reading live state.
/// The (generation, gate) snapshot is coherent: every publisher bumps under
/// the gate lock, so loading the epoch INSIDE the same hold admits no
/// publish between the two reads. Brief hold, never across waits.
#[cfg(target_os = "linux")]
fn finish_collapse_cover(
    app: &AppHandle,
    cover_dispatched: bool,
    job: u64,
    outcome_err: bool,
    handoff_queued: bool,
) {
    let shell = app.state::<Shell>();
    let (current, held) = {
        let held = shell.native_gate.lock().unwrap();
        (shell.native_epoch.load(Ordering::SeqCst), *held)
    };
    finish_collapse_cover_with(
        cover_dispatched,
        job,
        outcome_err,
        handoff_queued,
        current,
        held,
        &mut |cleanup| apply_cover_cleanup(app, job, cleanup),
    );
}

/// Applies a planned cover cleanup: queues the
/// dedicated delivery below, which re-evaluates visual ownership at
/// execution and releases only our own stale gate in the same hold — a newer
/// show's gate stays covered until its own settle→reveal. Thin production
/// applier: no state lock held here, never across the Tauri getter or the
/// main-thread queue.
#[cfg(target_os = "linux")]
fn apply_cover_cleanup(app: &AppHandle, job: u64, cleanup: CoverCleanup) {
    niri_trace!("cover cleanup apply job={job} plan={cleanup:?}");
    if let Ok(panel) = window(app, PANEL) {
        queue_cover_cleanup(app, &panel, job);
    }
}

/// Dedicated cover-cleanup delivery: the queued GTK
/// callback re-evaluates visual ownership AT EXECUTION under one brief gate
/// hold — atomic w.r.t. gate publication, since every publisher takes the
/// same lock. Lock audit: `gtk_window()` is a
/// BLOCKING wry window getter, so the handle is fetched BEFORE the hold and
/// only synchronous GTK setters plus the nonblocking cursor proxy run under
/// it; the hold takes no other lock, runs no socket IPC, and queues nothing
/// further, so no cycle, wait, or callback reentry exists. No focus/emit /
/// show and no unmap: opacity plus input reset on the existing mapped cover
/// only. A queued successful handoff never reaches this path (the planner
/// yields None there), and generic show/hide reset semantics
/// (`queue_gate_reset`, `cancel_gated_panel`, reveal) are untouched.
#[cfg(target_os = "linux")]
fn queue_cover_cleanup(app: &AppHandle, panel: &WebviewWindow, job: u64) {
    let (reset, reset_app) = (panel.clone(), app.clone());
    let _ = panel.run_on_main_thread(move || {
        // Blocking Tauri getter FIRST: `gtk_window()` round-trips
        // the wry runtime and must never run under the gate hold, where it
        // would stall every gate publisher.
        let handle = reset.gtk_window().ok();
        let shell = reset_app.state::<Shell>();
        run_cover_cleanup_locked(job, &shell.native_epoch, &shell.native_gate, &mut || {
            if let Some(gtk_window) = handle.as_ref() {
                gtk_window.set_opacity(GATED_OPACITY_SHOWN);
                gtk_window.set_accept_focus(true);
            }
            let _ = reset.set_ignore_cursor_events(false);
        });
    });
}

/// Captures the compact anchor before a mode change:
/// the ACTUAL production seam behind set_panel_niri_mode — always resolves the
/// ACTUAL floating spot subject to visible/epoch freshness under native_io,
/// never to the recorded mode flag. capture_compact_spot already returns None
/// for tiled/missing/ambiguous panels (exact pid+title, no focus fallback), so
/// no extra query runs; hidden or stale snapshots run zero wire. Merges and
/// fresh-commits exactly like the hide hook; tiled, hidden, missing, or failed
/// captures preserve the current anchor (bounded failure policy: no inferred
/// mode, no reveal). No AppHandle: state plus an injected request closure, so
/// tests drive the real wire sequence through this same body.
#[cfg(target_os = "linux")]
fn capture_mode_anchor(
    shell: &Shell,
    job: u64,
    pid: u32,
    visible: bool,
    snap_epoch: u64,
    pre_take_epoch: u64,
    request: &mut impl FnMut(&str, Duration) -> std::io::Result<serde_json::Value>,
) {
    // Hidden panels skip IPC fail-closed (a hidden native window must not
    // overwrite compact memory); mode effects below keep existing behavior.
    let mut capture_mark = "skipped";
    // Capture runs under I/O ownership: a superseded op
    // skips its wire entirely, and capture never interleaves a worker
    // pass mid-transaction. Stale still merges to the current anchor
    // below, whose commit refuses anyway.
    let fresh = native_io_sequenced(&shell.native_io, &shell.native_epoch, job, || {
        decide_native_capture(visible, snap_epoch, pre_take_epoch, || {
            match crate::niri::capture_compact_spot(pid, &mut *request) {
                Ok(found) => {
                    capture_mark = if found.is_some() { "some" } else { "none" };
                    found
                }
                Err(error) => {
                    capture_mark = "err";
                    niri_trace!("mode capture wire err={} job={job}", error.kind());
                    None
                }
            }
        })
    })
    .flatten();
    // Synchronized commit: the value merges lock-free, but
    // the generation recheck plus the write share the compact lock, so a
    // superseded op never overwrites a newer anchor.
    let current_anchor = shell.native_compact.lock().unwrap().clone();
    let remembered = merge_compact_spot(current_anchor, fresh);
    let remembered_mark = if remembered.is_some() { "some" } else { "none" };
    if commit_compact_anchor(&shell.native_compact, &shell.native_gate, &shell.native_epoch, job, remembered) {
        niri_trace!("mode capture job={job} capture={capture_mark} remembered={remembered_mark}");
    } else {
        niri_trace!("mode capture drop stale job={job} capture={capture_mark}");
    }
}

/// Size-classed shared spot: resolves the ACTUAL own
/// floating panel from immutable wire geometry — exact pid+title, never a
/// focused-window fallback. Pair (500x640) and panel-only (420x640) read the
/// client top-left; rose-only (72x72) translates the rose origin back to the
/// panel anchor; tiled, missing, ambiguous, null-position, non-finite,
/// unknown-output, or unrecognized-size panels yield `Ok(None)` so the caller
/// preserves its remembered spot. The output query runs only for recognized
/// compact sizes. Aggregate budget mirrors `capture_compact_spot`.
#[cfg(target_os = "linux")]
fn capture_shared_spot(
    pid: u32,
    remembered: Option<&CompactSpot>,
    request: &mut impl FnMut(&str, Duration) -> std::io::Result<serde_json::Value>,
) -> std::io::Result<Option<CompactSpot>> {
    use crate::niri::unit_restore::{PAIR_WINDOW, PANEL_WINDOW, ROSE_WINDOW};
    let start = std::time::Instant::now();
    let windows =
        request(crate::niri::WINDOWS_REQUEST, crate::niri::NATIVE_MODE_BUDGET.saturating_sub(start.elapsed()))?;
    let Some(panel) = crate::niri::own_panel_window(&windows, pid) else {
        return Ok(None);
    };
    if !panel.floating {
        return Ok(None);
    }
    if panel.size != PANEL_WINDOW && panel.size != PAIR_WINDOW && panel.size != ROSE_WINDOW {
        return Ok(None);
    }
    let workspaces = request(
        crate::niri::WORKSPACES_REQUEST,
        crate::niri::NATIVE_MODE_BUDGET.saturating_sub(start.elapsed()),
    )?;
    let Some(output) =
        crate::niri::workspace_output(&workspaces, panel.workspace).filter(|name| !name.is_empty())
    else {
        return Ok(None);
    };
    if panel.size == ROSE_WINDOW {
        let Some(rose) = panel.pos else {
            return Ok(None);
        };
        // Config-independent guard: the translated panel anchor
        // is refused while this process has completed no commanded
        // placement, or when it echoes the remembered one — so a fresh-map
        // rose at the window-rule base can never seed a bogus anchor
        // (observed job1 2036,-228). No output geometry is consulted.
        let candidate = crate::niri::unit_restore::capture_from_rose_surface(&output, rose);
        if candidate.as_ref().is_some_and(|spot| shared_capture_is_transient(remembered, spot)) {
            niri_trace!("shared capture reject transient rose pos={rose:?}");
            return Ok(None);
        }
        return Ok(candidate);
    }
    // Same guard for pair/panel sizes: the translated candidate is refused
    // under the same placement-state rule — never by coordinate matching.
    let candidate = crate::niri::compact_spot(&panel, Some(output));
    if candidate.as_ref().is_some_and(|spot| shared_capture_is_transient(remembered, spot)) {
        if let Some((x, y)) = panel.pos {
            niri_trace!("shared capture reject transient panel pos=({x},{y})");
        }
        return Ok(None);
    }
    Ok(candidate)
}

/// Shared-boundary anchor capture: the ACTUAL
/// production seam behind the shared route — resolves the current visible
/// floating compact spot BEFORE any cover/resize/mode effect, from immutable
/// wire geometry under I/O ownership, never from the recorded expanded flag
/// (the stored mode already flips before the worker tiles). `uncovered` must
/// come from a fresh main-thread visibility/opacity snapshot: toolkit-visible
/// stays true under opacity 0, so covered/transient windows run zero wire.
/// Epochs must agree (no concurrent bump across the snapshot); the
/// merge+commit refuses stale jobs, so tiled, hidden, failed, racing, or
/// superseded captures preserve the remembered anchor. Updates ONLY
/// `native_compact`. No AppHandle: state plus an injected request closure, so
/// tests drive the real wire sequence through this same body.
#[cfg(target_os = "linux")]
fn capture_shared_transition_anchor(
    shell: &Shell,
    job: u64,
    pid: u32,
    visible: bool,
    uncovered: bool,
    snap_epoch: u64,
    pre_take_epoch: u64,
    request: &mut impl FnMut(&str, Duration) -> std::io::Result<serde_json::Value>,
) {
    let fresh = native_io_sequenced(&shell.native_io, &shell.native_epoch, job, || {
        if !visible || !uncovered || snap_epoch != pre_take_epoch {
            niri_trace!("shared capture skip visible={visible} uncovered={uncovered} job={job}");
            return None;
        }
        let remembered_anchor = shell.native_compact.lock().unwrap().clone();
        match capture_shared_spot(pid, remembered_anchor.as_ref(), request) {
            Ok(found) => {
                niri_trace!(
                    "shared capture wire job={job} found={}",
                    if found.is_some() { "some" } else { "none" },
                );
                found
            }
            Err(error) => {
                niri_trace!("shared capture wire err={} job={job}", error.kind());
                None
            }
        }
    })
    .flatten();
    let remembered =
        merge_compact_spot(shell.native_compact.lock().unwrap().clone(), fresh);
    if commit_compact_anchor(&shell.native_compact, &shell.native_gate, &shell.native_epoch, job, remembered.clone()) {
        niri_trace!(
            "shared capture job={job} remembered={}",
            if remembered.is_some() { "some" } else { "none" },
        );
    } else {
        niri_trace!("shared capture drop stale job={job}");
    }
}

/// Fresh main-thread cover snapshot: reads toolkit
/// visibility plus the GTK opacity gate in ONE main-thread closure with no
/// state lock held, awaited bounded. Opacity 0 (covered) still reports
/// toolkit-visible, so callers must consult opacity, not visibility alone.
/// `None` on queue failure or timeout — callers preserve, never infer. The
/// caller must hold no state lock: the closure itself takes brief ones, and
/// awaiting it while holding one would deadlock a sync GTK-main command.
#[cfg(target_os = "linux")]
fn snapshot_shared_cover(panel: &WebviewWindow, budget: Duration) -> Option<(bool, f64)> {
    let (tx, rx) = mpsc::channel();
    let queried = panel.clone();
    if panel
        .run_on_main_thread(move || {
            let visible = queried.is_visible().unwrap_or(false);
            let opacity = queried.gtk_window().map(|window| window.opacity()).unwrap_or(GATED_OPACITY_SHOWN);
            let _ = tx.send((visible, opacity));
        })
        .is_err()
    {
        return None;
    }
    rx.recv_timeout(budget).ok()
}

#[cfg(target_os = "linux")]
fn clamp_anchor_to_work_area(
    area: Option<crate::niri::calibration::WorkAreaEstimate>,
    anchor: CompactSpot,
    rose_visible: bool,
) -> CompactSpot {
    use crate::niri::calibration::{clamp_unit_inside, pair_size};
    let Some(area) = area else {
        return anchor;
    };
    let panel = (f64::from(PANEL_SIZE.0 as i32), f64::from(PANEL_SIZE.1 as i32));
    let rose = rose_visible.then_some((f64::from(DOT_SIZE.0 as i32), f64::from(DOT_SIZE.1 as i32)));
    let unit = pair_size(panel, rose, f64::from(PANEL_GAP));
    match clamp_unit_inside(area, unit, (anchor.x, anchor.y), f64::from(EDGE_MARGIN)) {
        // Only the PLANNED target moves; the remembered anchor keeps its value,
        // so a later drag back inside the screen needs no repair.
        Some((x, y)) => CompactSpot { output: anchor.output, x, y },
        None => anchor,
    }
}

/// Idle poll quantum for the native follow subscription (Linux only): a
/// quiet tick re-checks shutdown without spinning.
#[cfg(target_os = "linux")]
const FOLLOW_IDLE_POLL: Duration = Duration::from_secs(1);
/// One-shot budget for the follow connect and dot-id resolve (Linux only).
#[cfg(target_os = "linux")]
const FOLLOW_CONNECT_BUDGET: Duration = Duration::from_millis(250);
/// Reconnect backoff bounds (Linux only): 500 ms doubling to a 5 s cap, so a
/// dead compositor never hot-spins; shutdown exits instead of retrying.
#[cfg(target_os = "linux")]
const FOLLOW_RECONNECT_BASE: Duration = Duration::from_millis(500);
#[cfg(target_os = "linux")]
const FOLLOW_RECONNECT_CAP: Duration = Duration::from_secs(5);

/// Spawns the native follow subscriber (Linux only): one thread per app
/// instance alongside the restore worker, alive exactly while the restore
/// channel exists. It NEVER moves windows itself — the restore worker stays
/// the single writer — it only wakes that worker after a debounced owned-dot
/// signal. No output-extent clamp is applied: no `Outputs` geometry is
/// verified against Niri 26.04 in this tree, so the same-output guard inside
/// the shared `plan_beside_rose` is the only bound — explicitly deferred,
/// never faked with GTK coordinates.
#[cfg(target_os = "linux")]
fn spawn_follow_worker(app: AppHandle) {
    thread::spawn(move || follow_loop(&app));
}

/// Native follow loop (Linux only): subscribes to the compositor event
/// stream on a dedicated connection (Niri stops reading requests on it, so
/// one-shot queries keep their own), tracks BOTH owned ids from exact
/// pid+title signals (rose AND panel), and after `FOLLOW_DEBOUNCE` of quiet
/// on either side wakes the single restore worker — whose unit path
/// re-resolves fresh dot/panel geometry and moves exactly one side with the
/// exact-id AdjustFixed `plan_unit_move` (dot-priority) + settle-verify, with
/// reveal skipping when no gate is held. Both event forms arm the debounce
/// (live drags arrive as `WindowOpenedOrChanged`); other pids/titles never
/// arm. Anti-feedback is local: a wake for one side suppresses the other
/// side's echoes for 2× quiet (the worker's own move), so follow never
/// chases itself, while genuine later drags still arm after the window.
#[cfg(target_os = "linux")]
fn follow_loop(app: &AppHandle) {
    use std::path::PathBuf;
    use std::time::Instant;
    let pid = std::process::id();
    let mut failures: u32 = 0;
    'outer: loop {
        // Shutdown bound: the Exit handler takes the restore sender, so a
        // missing sender ends this thread instead of retrying forever.
        if app.state::<Shell>().native_restore.lock().unwrap().is_none() {
            niri_trace!("follow end reason=shutdown");
            return;
        }
        let socket = std::env::var("NIRI_SOCKET").ok().filter(|path| !path.is_empty());
        let Some(socket) = socket else {
            if !follow_backoff(app, &mut failures) {
                return;
            }
            continue;
        };
        let path = PathBuf::from(socket);
        // Resolve both owned ids from fresh compositor geometry (exact
        // pid+title each, never a guess); stream signals refresh them below.
        let mut dot_id = follow_resolve_dot(&path, pid);
        let mut panel_id = follow_resolve_panel(&path, pid);
        let mut stream = match crate::niri::EventStream::connect(&path, FOLLOW_CONNECT_BUDGET) {
            Ok(stream) => {
                failures = 0;
                stream
            }
            Err(error) => {
                niri_trace!("follow connect err={} failures={failures}", error.kind());
                if !follow_backoff(app, &mut failures) {
                    return;
                }
                continue;
            }
        };
        niri_trace!("follow subscribed");
        let mut pending_dot: Option<Instant> = None;
        let mut pending_panel: Option<Instant> = None;
        // Last observed layer-surface set for environment-change cache
        // invalidation: re-seeded per connection, never polled.
        let mut last_layers: Option<Vec<crate::niri::unit_restore::LayerIdentity>> = None;
        // Local anti-feedback: a wake for one side mutes the other's echoes
        // (the worker's own AdjustFixed) for 2× quiet. Genuine later drags
        // re-arm after the window; no shared state, no worker coupling.
        let mut ignore_dot_until: Option<Instant> = None;
        let mut ignore_panel_until: Option<Instant> = None;
        // Shared-route workspace follow: our window's workspace, the last
        // full workspace list (normalized `{"Workspaces": [...]}`), and
        // the one in-flight follow target. Task-local only: no Shell field,
        // no lock, seeded from the stream's upfront state, never polled.
        let mut follow_workspaces: Option<serde_json::Value> = None;
        let mut follow_own_workspace: Option<u64> = None;
        let mut follow_in_flight: Option<u64> = None;
        loop {
            if app.state::<Shell>().native_restore.lock().unwrap().is_none() {
                niri_trace!("follow end reason=shutdown");
                return;
            }
            let now = Instant::now();
            let wait = crate::niri::follow_wait(pending_dot, now, FOLLOW_IDLE_POLL)
                .min(crate::niri::follow_wait(pending_panel, now, FOLLOW_IDLE_POLL));
            match stream.next_line(wait) {
                Err(error) => {
                    niri_trace!("follow stream err={} failures={failures}", error.kind());
                    if !follow_backoff(app, &mut failures) {
                        return;
                    }
                    continue 'outer;
                }
                Ok(None) => {
                    // Quiet tick: el lado que debe fija el MOVER (quién movió
                    // el usuario) y despierta al único worker para una pasada
                    // CONJUNTA desde el ancla. Ambas supresiones (local + la
                    // compartida de nuestros propios moves) mutean los ecos.
                    let now = Instant::now();
                    let dot_due = pending_dot.is_some_and(|last| crate::niri::debounce_due(last, now));
                    let panel_due = pending_panel.is_some_and(|last| crate::niri::debounce_due(last, now));
                    if dot_due || panel_due {
                        // Shared single surface: the compositor moves the one
                        // window natively — no mover write, no worker wake, no
                        // echo corrections. Legacy joint follow stays below.
                        let shell = app.state::<Shell>();
                        if shared_route_wanted(
                            shell.native_unit.lock().unwrap().active,
                            shell.places_windows,
                            platform::is_niri(&|key| std::env::var(key).ok()),
                            niri_socket_present(),
                        ) {
                            pending_dot = None;
                            pending_panel = None;
                            continue;
                        }
                        let dot_at = pending_dot;
                        let panel_at = pending_panel;
                        pending_dot = None;
                        pending_panel = None;
                        let quiet2 = Some(now + crate::niri::FOLLOW_DEBOUNCE * 2);
                        ignore_dot_until = quiet2;
                        ignore_panel_until = quiet2;
                        // A covered job's probe positions are owned effects,
                        // never user drags: its mover must not be overwritten
                        // by the panel origin or the proportion probe.
                        let covered = app.state::<Shell>().native_gate.lock().unwrap().is_some();
                        if !covered {
                            if let Some(mover) = joint_mover_from_signals(dot_due, panel_due, dot_at, panel_at) {
                                *app.state::<Shell>().native_mover.lock().unwrap() = Some(mover);
                            }
                        }
                        if !follow_wake_panel(app) {
                            niri_trace!("follow end reason=worker-gone");
                            return;
                        }
                    }
                }
                Ok(Some(line)) => {
                    let event: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(event) => event,
                        Err(_) => continue,
                    };
                    let now = Instant::now();
                    // Environment-change invalidation: a layer-set
                    // change or config reload may move the work area while
                    // our window stays legal, so drop the cached calibration
                    // here (gate-domain, live-worker-guarded); the next
                    // transition re-probes once and re-fills the entry.
                    // Shared-route only: legacy/non-Niri paths stay untouched.
                    {
                        let shell = app.state::<Shell>();
                        if shared_route_wanted(
                            shell.native_unit.lock().unwrap().active,
                            shell.places_windows,
                            platform::is_niri(&|key| std::env::var(key).ok()),
                            niri_socket_present(),
                        ) {
                            let live = || app.state::<Shell>().native_restore.lock().unwrap().is_some();
                            note_environment_event(&shell.native_gate, &shell.native_unit_cache, &event, &mut last_layers, &live);
                        }
                    }
                    // Shared-route workspace follow: the owned single surface
                    // follows the active workspace of its own output via one
                    // explicit move (Niri 26.04 has no sticky window). Same
                    // output, so the per-output calibration cache stays valid
                    // and is never invalidated here; the remembered anchor,
                    // the mover, and the pipeline generations stay untouched.
                    // Seeding runs on EVERY event outside the shared gate, so
                    // the owned id, own workspace, and workspaces list are
                    // current by the time the gate opens; only the DECISION
                    // and the MOVE stay inside it.
                    {
                        // Live owned id only (exact pid+title, never a guess).
                        if let Some((id, _)) = crate::niri::panel_opened_signal(&event, pid, PANEL_TITLE) {
                            panel_id = Some(id);
                        }
                        if let Some(closed) = crate::niri::window_closed_id(&event) {
                            if panel_id == Some(closed) {
                                panel_id = None;
                                follow_own_workspace = None;
                                follow_in_flight = None;
                            }
                        }
                        if let Some(id) = panel_id {
                            if let Some(workspace) = crate::niri::window_workspace_in_event(&event, id) {
                                follow_own_workspace = workspace;
                                if follow_in_flight.is_some() && follow_own_workspace == follow_in_flight {
                                    follow_in_flight = None;
                                }
                            }
                        }
                        if let Some(list) = event
                            .get("WorkspacesChanged")
                            .and_then(|inner| inner.get("workspaces"))
                            .cloned()
                        {
                            follow_workspaces = Some(serde_json::json!({"Workspaces": list}));
                            if follow_in_flight.is_some() && follow_own_workspace == follow_in_flight {
                                follow_in_flight = None;
                            }
                        }
                        if let Some(activated) = crate::niri::workspace_activated_id(&event) {
                            if let Some(cached) = follow_workspaces.as_mut() {
                                let output = crate::niri::workspace_output(cached, Some(activated));
                                if let (Some(output), Some(list)) =
                                    (output, cached.get_mut("Workspaces").and_then(|v| v.as_array_mut()))
                                {
                                    for entry in list.iter_mut() {
                                        let same_output =
                                            entry.get("output").and_then(serde_json::Value::as_str) == Some(output.as_str());
                                        let is_new = entry.get("id").and_then(serde_json::Value::as_u64) == Some(activated);
                                        if same_output {
                                            if let Some(fields) = entry.as_object_mut() {
                                                fields.insert("is_active".to_owned(), serde_json::Value::Bool(is_new));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        // Bounded re-resolve: the connect-time resolve races
                        // window creation, so when the owned id is still
                        // unknown on an activation, try the same exact-id
                        // lookup once — one attempt per activation, no
                        // polling, no loop.
                        if panel_id.is_none() && crate::niri::workspace_activated_id(&event).is_some() {
                            panel_id = follow_resolve_panel(&path, pid);
                        }
                    }
                    {
                        let shell = app.state::<Shell>();
                        let shared = shared_route_wanted(
                            shell.native_unit.lock().unwrap().active,
                            shell.places_windows,
                            platform::is_niri(&|key| std::env::var(key).ok()),
                            niri_socket_present(),
                        );
                        drop(shell);
                        // Activations only: one decision per activation, never
                        // per unrelated event — and a skip always traces its
                        // missing input, so silence is impossible.
                        if shared && crate::niri::workspace_activated_id(&event).is_some() {
                            let active_on_output = follow_workspaces.as_ref().and_then(|workspaces| {
                                let output = crate::niri::workspace_output(workspaces, follow_own_workspace)?;
                                crate::niri::active_workspace_on_output(workspaces, &output)
                            });
                            if let Some(target) = crate::niri::follow_workspace_target(
                                follow_own_workspace,
                                active_on_output,
                                panel_id.is_some(),
                                follow_in_flight,
                            ) {
                                let id = panel_id.expect("owned id checked by the predicate");
                                let wire = crate::niri::action_move_to_workspace(id, target);
                                follow_in_flight = Some(target);
                                match crate::niri::Client::new(&path, FOLLOW_CONNECT_BUDGET).request(&wire) {
                                    Ok(reply) if crate::niri::is_handled(&reply) => {
                                        niri_trace!("follow workspace move id={id} target={target}");
                                    }
                                    Ok(reply) => {
                                        eprintln!("gentle-dot: follow workspace move rejected target={target} reply={reply}");
                                    }
                                    Err(error) => {
                                        eprintln!("gentle-dot: follow workspace move failed target={target}: {error}");
                                    }
                                }
                            } else if let Some(reason) = crate::niri::follow_skip_reason(
                                follow_own_workspace,
                                active_on_output,
                                panel_id.is_some(),
                                follow_in_flight,
                            ) {
                                niri_trace!("follow workspace skip reason={reason} own={follow_own_workspace:?} active={active_on_output:?} owned={} in_flight={follow_in_flight:?}", panel_id.is_some());
                            }
                        }
                    }
                    // Remap/discovery carries pid+title per side: refresh the
                    // tracked id, and arm only on a real position — a null
                    // layout is transient drag state, never an anchor — and
                    // never while muted (local quiet OR our own joint pass).
                    let shared = *app.state::<Shell>().native_suppress_until.lock().unwrap();
                    let dot_muted = crate::niri::suppress_active(now, ignore_dot_until)
                        || crate::niri::suppress_active(now, shared);
                    let panel_muted = crate::niri::suppress_active(now, ignore_panel_until)
                        || crate::niri::suppress_active(now, shared);
                    if let Some((id, pos)) = crate::niri::dot_opened_signal(&event, pid, DOT_TITLE) {
                        dot_id = Some(id);
                        if pos.is_some() && !dot_muted {
                            pending_dot = Some(now);
                        }
                        continue;
                    }
                    if let Some((id, pos)) = crate::niri::panel_opened_signal(&event, pid, PANEL_TITLE) {
                        panel_id = Some(id);
                        if pos.is_some() && !panel_muted {
                            pending_panel = Some(now);
                        }
                        continue;
                    }
                    if let Some(id) = crate::niri::window_closed_id(&event) {
                        if dot_id == Some(id) {
                            dot_id = None;
                            pending_dot = None;
                        }
                        if panel_id == Some(id) {
                            panel_id = None;
                            pending_panel = None;
                        }
                        continue;
                    }
                    if let Some(id) = dot_id {
                        if !dot_muted {
                            match crate::niri::dot_layout_signal(&event, id) {
                                Some(Some(_)) => pending_dot = Some(now),
                                // Null layout or other windows: transient or
                                // cross-side — never arm, never anchor.
                                Some(None) | None => {}
                            }
                        }
                    }
                    if let Some(id) = panel_id {
                        if !panel_muted {
                            match crate::niri::panel_layout_signal(&event, id) {
                                Some(Some(_)) => pending_panel = Some(now),
                                Some(None) | None => {}
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Resolves the owned dot id from fresh compositor geometry (Linux only):
/// exact pid+rose-title, `None` when missing or ambiguous — never a guess.
#[cfg(target_os = "linux")]
fn follow_resolve_dot(path: &std::path::Path, pid: u32) -> Option<u64> {
    let windows = crate::niri::Client::new(path, FOLLOW_CONNECT_BUDGET)
        .request(crate::niri::WINDOWS_REQUEST)
        .ok()?;
    crate::niri::own_dot_window(&windows, pid).map(|dot| dot.id)
}

/// Resolves the owned panel id from fresh compositor geometry (UNIDAD bidir,
/// Linux only): exact pid+panel-title, `None` when missing or ambiguous.
#[cfg(target_os = "linux")]
fn follow_resolve_panel(path: &std::path::Path, pid: u32) -> Option<u64> {
    let windows = crate::niri::Client::new(path, FOLLOW_CONNECT_BUDGET)
        .request(crate::niri::WINDOWS_REQUEST)
        .ok()?;
    crate::niri::own_panel_window(&windows, pid).map(|panel| panel.id)
}

/// Capped reconnect backoff (Linux only): 500 ms doubling to a 5 s cap, so a
/// dead compositor never hot-spins. Returns false when the restore channel is
/// gone (shutdown or worker exit): the caller ends the thread instead of
/// retrying — no runaway retries.
#[cfg(target_os = "linux")]
fn follow_backoff(app: &AppHandle, failures: &mut u32) -> bool {
    if app.state::<Shell>().native_restore.lock().unwrap().is_none() {
        return false;
    }
    let shift = (*failures).min(4);
    let delay = (FOLLOW_RECONNECT_BASE * (1 << shift)).min(FOLLOW_RECONNECT_CAP);
    *failures = failures.saturating_add(1);
    thread::sleep(delay);
    app.state::<Shell>().native_restore.lock().unwrap().is_some()
}

/// Debounced follow wake (Linux only): snapshots visibility with no native
/// lock held, then filters (hide/expanded/hidden/fullscreen win) and
/// signals the single restore worker WITHOUT bumping the generation — no new
/// gated job, no reveal: the worker's unit path moves exactly one side to the
/// fresh geometry with the exact-id AdjustFixed plan and verifies settle;
/// compact panel to the fresh dot anchor with the exact-id AdjustFixed plan
/// and verifies settle; its reveal skips without a gate. Returns false only
/// when the worker is gone (caller exits); a full channel just coalesces,
/// since the worker always re-resolves fresh geometry.
#[cfg(target_os = "linux")]
fn follow_wake_panel(app: &AppHandle) -> bool {
    let shell = app.state::<Shell>();
    // Blocking getter first, no native lock held; missing windows read hidden.
    let visible = window(app, PANEL).and_then(|panel| panel.is_visible().map_err(err)).unwrap_or(false);
    let rose_hidden = shell.rose_hidden.load(Ordering::SeqCst);
    let expanded = *shell.native_expanded.lock().unwrap();
    let fullscreen = shell.full_screen.lock().unwrap().is_some();
    if !crate::niri::follow_wake_eligible(rose_hidden, expanded, visible, fullscreen) {
        niri_trace!("follow wake skip rose_hidden={rose_hidden} expanded={expanded} visible={visible} fullscreen={fullscreen}");
        return true;
    }
    let tx = shell.native_restore.lock().unwrap().as_ref().cloned();
    match tx {
        None => false,
        Some(tx) => match tx.try_send(()) {
            Ok(()) => {
                niri_trace!("follow wake sent");
                true
            }
            Err(mpsc::TrySendError::Full(_)) => {
                niri_trace!("follow wake coalesced");
                true
            }
            Err(mpsc::TrySendError::Disconnected(_)) => false,
        },
    }
}

/// User-drag anchor commit (Linux only): the observed drag spot lands under
/// gate/epoch, separately from restore (which only returns its preserved
/// `remembered`). Thin over `commit_compact_anchor` (same gate domain).
#[cfg(target_os = "linux")]
#[allow(dead_code)]
fn commit_dragged_anchor(
    compact: &Mutex<Option<CompactSpot>>,
    gate: &Mutex<Option<u64>>,
    epoch: &AtomicU64,
    job: u64,
    observed: Option<CompactSpot>,
) -> bool {
    commit_compact_anchor(compact, gate, epoch, job, observed)
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
    fn only_the_glow_overlay_may_acknowledge_the_working_rings() {
        let build = include_str!("../build.rs");
        assert!(build.contains("\"computer_working_ready\","), "computer_working_ready is missing from build.rs");
        let capabilities: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let windows: Vec<&serde_json::Value> = capabilities["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["permissions"].as_array().unwrap().iter().any(|p| p == "allow-computer-working-ready"))
            .flat_map(|c| c["windows"].as_array().unwrap())
            .collect();
        assert_eq!(windows, [computer::GLOW_WINDOW]);
    }

    #[test]
    fn the_windows_listen_for_the_assistant_ready_event() {
        let desktop = include_str!("../../../../packages/ui/src/desktop.ts");
        let app = include_str!("../../../../packages/ui/src/App.tsx");
        let quoted = format!("\"{ASSISTANT_READY}\"");
        assert!(desktop.contains(&quoted), "desktop.ts does not accept {quoted}");
        assert!(app.contains(&format!("onDesktopEvent({quoted}")), "App.tsx does not listen for {quoted}");
    }

    #[test]
    fn conversations_flag_reads_like_the_daemon() {
        assert!(conversations_on(Some("1")));
        assert!(!conversations_on(None));
        assert!(!conversations_on(Some("0")));
        assert!(!conversations_on(Some("true")));
    }
}

// Behavior-neutral extraction unit niri-shell-capture (C/F/T): the file
// module below holds only this unit's tests. It cannot reuse the `tests`
// name while the base inline module above keeps the pre-existing suite
// (its source versions need later-unit signatures), so it is declared
// under a unit name until the follow-up units merge the modules.
#[cfg(test)]
#[path = "shell/tests.rs"]
mod shell_capture_tests;
