//! Tauri wiring: windows, commands, tray menu, global shortcut, Dot snapping,
//! and the daemon lifecycle (design §9).

use crate::computer::app as computer;
use crate::computer::session::Reason;
use crate::config::{self, ConnectionInfo, DesktopConfig, DEFAULT_SHORTCUT};
use crate::daemon::{Daemon, RestartOutcome};
use crate::geometry::{self, Rect};
use crate::platform::{self, LaunchRequest, Os, DOT_TITLE, PANEL_TITLE};
use crate::position::{self, DotPosition};
use crate::status::{is_template, tray_status, TrayGlyph};
use std::sync::{mpsc, Arc};
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
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const DOT: &str = "dot";
const PANEL: &str = "panel";
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

/// Waits until the daemon answers `/health`, then returns its URLs and token.
#[tauri::command]
async fn connection_info(app: AppHandle) -> CommandResult<ConnectionInfo> {
    let shell = app.state::<Shell>();
    let (config, daemon) = (shell.config.clone(), shell.daemon.clone());
    tauri::async_runtime::spawn_blocking(move || {
        if !daemon.wait_healthy(DAEMON_START_TIMEOUT) {
            return Err(format!("the assistant is not answering on port {}", config.port));
        }
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
    window(&app, PANEL)?.hide().map_err(err)
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

/// Keeps the Dot at exactly `DOT_SIZE` points, in case macOS or a monitor change resized it.
fn keep_dot_size(dot: &WebviewWindow, current: Rect) -> CommandResult {
    if (current.width, current.height) == (DOT_SIZE.0 as i32, DOT_SIZE.1 as i32) {
        return Ok(());
    }
    dot.set_size(LogicalSize::new(DOT_SIZE.0, DOT_SIZE.1)).map_err(err)
}

fn place_panel_next_to_dot(app: &AppHandle) -> CommandResult {
    if !app.state::<Shell>().places_windows {
        return Ok(());
    }
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
    place_panel_next_to_dot(app)?;
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
    position::save(&shell.config.data_dir.join("desktop.json"), DotPosition { x, y }).map_err(err)?;
    if window(app, PANEL)?.is_visible().unwrap_or(false) {
        place_panel_next_to_dot(app)?;
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

fn build_windows(app: &AppHandle, config: &DesktopConfig, places_windows: bool) -> tauri::Result<()> {
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
        .visible(false);
    #[cfg(target_os = "macos")]
    let panel = panel
        .effects(EffectsBuilder::new().effect(Effect::HudWindow).state(EffectState::Active).radius(20.0).build());
    panel.build()?;

    if !places_windows {
        // Native Wayland ignores positions; Hyprland window rules place and pin the Dot.
        dot.show()?;
        return Ok(());
    }

    // Restore the saved position (re-snapped in case the monitors changed), or
    // default to the right edge of the primary monitor, vertically centered.
    // Everything is in points: before it is shown, the window may sit on a
    // monitor with another scale factor than the one it is moved to.
    let monitors = monitor_rects(&dot).unwrap_or_default();
    let size = (DOT_SIZE.0 as i32, DOT_SIZE.1 as i32);
    let primary = app.primary_monitor()?.as_ref().map(work_area);
    let saved = position::load(&config.data_dir.join("desktop.json")).map(|p| (p.x, p.y));
    if let Some((x, y)) = geometry::initial_dot_position(saved, size, &monitors, primary, EDGE_MARGIN) {
        dot.set_position(LogicalPosition::new(f64::from(x), f64::from(y)))?;
    }
    // Set the size again once the window is in place, so it is exactly DOT_SIZE points there.
    dot.set_size(LogicalSize::new(DOT_SIZE.0, DOT_SIZE.1))?;
    dot.show()?;
    Ok(())
}

/// Whether the conversations list is on, read like the daemon reads it (`GENTLE_DOT_CONVERSATIONS=1`).
fn conversations_on(value: Option<&str>) -> bool {
    value == Some("1")
}

/// The tray menu, top to bottom (`-` is a separator). "New conversation" only exists with the
/// conversations list on; in the single continuous chat there is nothing new to start.
/// "Stop computer control" and "Yolo mode" exist where computer control does (macOS, S24.3, S24.9).
fn tray_menu_ids(conversations: bool, computer_control: bool) -> Vec<&'static str> {
    let mut ids = vec!["open"];
    if conversations {
        ids.push("new");
    }
    ids.push("browser");
    if computer_control {
        ids.extend(["computer-stop", "computer-yolo"]);
    }
    ids.extend(["-", "restart", "autostart", "-", "quit"]);
    ids
}

fn build_tray(app: &AppHandle, config: &DesktopConfig) -> tauri::Result<TrayIcon> {
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    // The accelerator is only a label here; an unparsable one must not break the menu.
    let open = MenuItem::with_id(app, "open", "Open", true, Some(config.shortcut.as_str()))
        .or_else(|_| MenuItem::with_id(app, "open", "Open", true, None::<&str>))?;
    let menu = Menu::new(app)?;
    let conversations = conversations_on(std::env::var("GENTLE_DOT_CONVERSATIONS").ok().as_deref());
    for id in tray_menu_ids(conversations, cfg!(target_os = "macos")) {
        match id {
            "open" => menu.append(&open)?,
            "new" => menu.append(&MenuItem::with_id(app, "new", "New conversation", true, None::<&str>)?)?,
            "browser" => menu.append(&MenuItem::with_id(app, "browser", "Open in browser", true, None::<&str>)?)?,
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
    let daemon = app.state::<Shell>().daemon.clone();
    thread::spawn(move || match daemon.restart(DAEMON_START_TIMEOUT) {
        RestartOutcome::Restarted => {}
        RestartOutcome::External => show_message(
            &app,
            MessageDialogKind::Info,
            "The assistant was started outside Gentle Dot, so it cannot be restarted from here. Restart it where it was started.",
        ),
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

fn register_shortcut(app: &AppHandle, shortcut: &str) {
    let handler = |app: &AppHandle, _: &_, event: tauri_plugin_global_shortcut::ShortcutEvent| {
        if event.state() == ShortcutState::Pressed {
            if let Err(error) = toggle_panel(app.clone()) {
                eprintln!("gentle-dot: cannot toggle the panel: {error}");
            }
        }
    };
    if let Err(error) = app.global_shortcut().on_shortcut(shortcut, handler) {
        eprintln!("gentle-dot: shortcut `{shortcut}` is unavailable ({error}); using {DEFAULT_SHORTCUT}");
        if shortcut != DEFAULT_SHORTCUT {
            let _ = app.global_shortcut().on_shortcut(DEFAULT_SHORTCUT, handler);
        }
    }
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
            computer::computer_endpoint,
            computer::computer_permissions,
            computer::computer_request_permission,
            computer::computer_stop,
            computer::computer_status,
            computer::computer_set_yolo
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();

            let daemon = Arc::new(Daemon::new(config.port, config.data_dir.clone()));
            let starter = daemon.clone();
            thread::spawn(move || {
                if let Err(error) = starter.ensure_running(DAEMON_START_TIMEOUT) {
                    eprintln!("gentle-dot: {error}");
                }
            });
            app.manage(Shell { config: config.clone(), daemon, snap: spawn_snapper(handle.clone()), places_windows });
            app.manage(computer::start(&handle));
            #[cfg(target_os = "macos")]
            register_panic_shortcut(&handle);

            build_windows(&handle, &config, places_windows)?;
            build_tray(&handle, &config)?;
            if places_windows {
                register_shortcut(&handle, &config.shortcut);
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
            vec!["open", "browser", "-", "restart", "autostart", "-", "quit"]
        );
    }

    #[test]
    fn tray_shows_new_conversation_with_the_conversations_list() {
        assert_eq!(
            tray_menu_ids(true, false),
            vec!["open", "new", "browser", "-", "restart", "autostart", "-", "quit"]
        );
    }

    #[test]
    fn tray_offers_stop_computer_control_where_it_exists() {
        assert_eq!(
            tray_menu_ids(false, true),
            vec!["open", "browser", "computer-stop", "computer-yolo", "-", "restart", "autostart", "-", "quit"]
        );
    }

    #[test]
    fn conversations_flag_reads_like_the_daemon() {
        assert!(conversations_on(Some("1")));
        assert!(!conversations_on(None));
        assert!(!conversations_on(Some("0")));
        assert!(!conversations_on(Some("true")));
    }
}
