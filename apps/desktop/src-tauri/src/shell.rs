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
    GateEffect, RestoreCompletion, joint_mover_from_signals, native_niri_mode, native_restore_planned,
    niri_socket_present, plan_gate_effects, plan_restore_completion, shared_route_wanted,
};
#[cfg(target_os = "linux")]
use gtk::prelude::{GtkWindowExt, WidgetExt};
#[cfg(target_os = "linux")]
use std::sync::atomic::AtomicU64;
use crate::niri::unit_state::NiriUnitSnapshot;
#[cfg(target_os = "linux")]
use crate::niri::unit_state::{
    NiriUnitState, UnitExecEffect, UnitExecOutcome, UnitTransition, UnitWake, UnitWindow, ack_unit_ready,
    cleanup_unit_dispatch, plan_unit_wake, run_unit_cover_exec, unit_ready_for, unit_snapshot_locked,
    unit_transition_commit, unit_window_for,
};
// Test-only unit-state helpers: the shell tests pin the activation/open
// handshake through the same cores production calls; normal builds use
// neither name, so this import stays test-scoped and warning-free.
#[cfg(test)]
use crate::niri::unit_state::{activate_shared_unit, publish_unit_open};
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

    /// Measured Niri work area (Linux only): the last successful covered
    /// calibration's working area (origin plus size, which already excludes the
    /// bar). Used ONLY to keep the visible pair inside the screen — an absent
    /// measurement never invents a position, it just leaves the anchor alone.
    #[cfg(target_os = "linux")]
    native_work_area: Mutex<Option<crate::niri::calibration::WorkAreaEstimate>>,
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

    /// Generation-owned restore intent (Linux only):
    /// `Some((generation, intent))` for the latest handoff. Published and
    /// read only under the gate domain (gate lock held across both), so the
    /// generation and its intent move atomically. Lock order is always gate then intent.
    #[cfg(target_os = "linux")]
    native_intent: Mutex<Option<(u64, RestoreIntent)>>,
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

    /// Pending hide intent (Linux only): `Some(job)` while a hide
    /// capture is still running on the pool. Generation-associated, never a
    /// bare boolean: toggle treats a fresh intent (equal to the live epoch)
    /// as logically hidden and routes Show; a stale intent is ignored
    /// automatically. Published with its generation in gate order; cleared
    /// only by its exact owner.
    #[cfg(target_os = "linux")]
    native_hide_job: Mutex<Option<u64>>,
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

#[cfg(target_os = "linux")]
fn plan_shared_startup(rose_hidden: bool) -> SharedStartup {
    let mode = unit_mode_for(false, rose_hidden, false);
    SharedStartup {
        size: crate::niri::unit_surface::mode_size(mode).unwrap_or((420, 640)),
        map: matches!(unit_window_for(false, rose_hidden, false), UnitWindow::KeepMapped),
    }
}

/// Snapshot from live Shell state (Linux only): the ONE Shell-typed reader
/// of the unit adapter; delegates to `unit_snapshot_locked`.
#[cfg(target_os = "linux")]
fn unit_snapshot_of(
    shell: &Shell,
    places_windows: bool,
    is_niri: bool,
    socket_present: bool,
) -> NiriUnitSnapshot {
    unit_snapshot_locked(
        &shell.native_gate,
        &shell.native_unit,
        &shell.native_epoch,
        &shell.native_expanded,
        &shell.rose_hidden,
        places_windows,
        is_niri,
        socket_present,
    )
}

/// Routes one command through the dormant shared-unit branch (Linux only):
/// commits under a fresh gate-owned generation, then queues the covered map
/// on the main thread (opacity 0 + focus off, show, input-arm — or unmap +
/// reset for hidden-rose close), and only after that succeeds emits
/// `dot://unit` at the new revision and signals the worker. A missing
/// window after commit, a failed queue, or a disconnected/absent worker
/// each run exact-owned gated cleanup (unmap + reset) and report Err — a
/// disconnected worker cancels instead of stranding the panel transparent.
/// Stale queued
/// callbacks run zero effects and emit/signal nothing; dispatch or effect
/// failures run exact-owned cleanup and report Err (never false success).
/// The independent dot window is never touched. Thin glue over the tested
/// core: all decisions and state effects live there. Live once setup
/// activates; the worker entry gates on `active` too, so legacy wakes never
/// run as shared and stale callbacks stay effect-free.
#[cfg(target_os = "linux")]
fn route_unit_transition(app: &AppHandle, kind: UnitTransition) -> Option<CommandResult<()>> {
    let shell = app.state::<Shell>();
    let sender = shell.native_restore.lock().unwrap().clone();
    let anchored = shell.native_compact.lock().unwrap().is_some();
    let places = shell.places_windows;
    let is_niri = platform::is_niri(&|key| std::env::var(key).ok());
    let socket = niri_socket_present();
    let snap = unit_transition_commit(
        &shell.native_gate,
        &shell.native_unit,
        &shell.native_epoch,
        &shell.native_expanded,
        &shell.rose_hidden,
        &shell.native_intent,
        places,
        is_niri,
        socket,
        anchored,
        kind,
    )?;
    let job = snap.revision;
    let mapping = unit_window_for(snap.open, snap.rose_hidden, snap.fullscreen);
    // S5 on the single surface: effective fullscreen hides the rose and its
    // visibility toggle; leaving fullscreen restores the toggle. Best-effort.
    if let Some(item) = app.try_state::<RoseMenuItem>() {
        let _ = item.0.set_enabled(!snap.fullscreen);
    }
    let panel = match window(app, PANEL) {
        Ok(panel) => panel,
        Err(error) => {
            // The commit already bumped and carried: clear exactly our own
            // install while still current, like a queue failure — the window
            // never existed, so no cover ran and nothing emits or signals.
            let shell = app.state::<Shell>();
            cleanup_unit_dispatch(&shell.native_gate, &shell.native_epoch, job);
            return Some(Err(error));
        }
    };
    // S24/S26 shared-boundary anchor capture: resolve the ACTUAL floating
    // compact spot BEFORE any cover/map effect below — the follow observer
    // deliberately ignores shared moves and the legacy mode hook is bypassed
    // on this route, so without this the worker would preserve a stale anchor
    // (e.g. a user drag) through managed mode and back. Covered, hidden,
    // tiled, transient, racing, or stale snapshots run zero wire and preserve;
    // an unavailable capture (no snapshot, no socket, faded budget) also
    // preserves — the job still proceeds, never a false success. No state
    // lock is held across the GTK snapshot or the socket IPC below.
    {
        let shell = app.state::<Shell>();
        let snap_epoch = shell.native_epoch.load(Ordering::SeqCst);
        let cover_state = snapshot_shared_cover(&panel, COLLAPSE_COVER_ACK);
        let pre_epoch = shell.native_epoch.load(Ordering::SeqCst);
        let (visible, uncovered) = match cover_state {
            Some((visible, opacity)) => (visible, visible && opacity >= GATED_OPACITY_SHOWN),
            None => (false, false),
        };
        if let Some(path) = std::env::var("NIRI_SOCKET").ok().filter(|path| !path.is_empty()) {
            let path = std::path::PathBuf::from(path);
            let mut request = |wire: &str, timeout: Duration| crate::niri::Client::new(&path, timeout).request(wire);
            capture_shared_transition_anchor(&shell, job, std::process::id(), visible, uncovered, snap_epoch, pre_epoch, &mut request);
        }
    }
    let (queue_panel, queue_app, queue_snap, queue_sender) = (panel.clone(), app.clone(), snap, sender);
    let queued = panel.run_on_main_thread(move || {
        // GTK handle BEFORE any state lock; the epoch/gate recheck runs
        // inside the executor under its own brief holds — no state lock is
        // held for any getter or action below. No socket IPC here either.
        let gtk = queue_panel.gtk_window().ok();
        let shell = queue_app.state::<Shell>();
        let mut ops = |effect: UnitExecEffect| -> CommandResult<()> {
            match effect {
                UnitExecEffect::CoverVisuals => {
                    if let Some(gtk_window) = gtk.as_ref() {
                        gtk_window.set_opacity(GATED_OPACITY_HIDDEN);
                        gtk_window.set_accept_focus(false);
                    }
                    Ok(())
                }
                UnitExecEffect::Map => queue_panel.show().map_err(err),
                UnitExecEffect::CoverInput => queue_panel.set_ignore_cursor_events(true).map_err(err),
                UnitExecEffect::Unmap => queue_panel.hide().map_err(err),
                UnitExecEffect::ResetVisuals => {
                    if let Some(gtk_window) = gtk.as_ref() {
                        gtk_window.set_opacity(GATED_OPACITY_SHOWN);
                        gtk_window.set_accept_focus(true);
                    }
                    queue_panel.set_ignore_cursor_events(false).map_err(err)
                }
            }
        };
        match run_unit_cover_exec(&mut ops, &shell.native_gate, &shell.native_epoch, job, mapping) {
            UnitExecOutcome::Applied => {
                // Logical truth first: the commit succeeded, so the frontend
                // learns the fresh snapshot even if the wake below fails.
                emit_unit_to_panel(&queue_app, &queue_snap);
                match plan_unit_wake(queue_sender.as_ref().map(signal_restore)) {
                    UnitWake::Proceed => {}
                    UnitWake::Cancel => {
                        // No consumer will ever reveal this cover: converge
                        // through exact-owned gated cancellation (unmap +
                        // reset) instead of stranding the panel transparent.
                        // Coalesced counts as success (a wake is pending).
                        eprintln!("gentle-dot: unit worker disconnected job={job}");
                        cancel_gated_panel(&queue_app, job, "unit worker disconnected");
                    }
                }
            }
            UnitExecOutcome::Stale => {
                // Superseded: zero effects ran, nothing to emit or signal.
            }
            UnitExecOutcome::Failed => {
                eprintln!("gentle-dot: unit cover failed job={job}");
            }
        }
    });
    if queued.is_err() {
        let shell = app.state::<Shell>();
        cleanup_unit_dispatch(&shell.native_gate, &shell.native_epoch, job);
        return Some(Err("gentle-dot: unit cover missed the main thread; hidden for retry".to_owned()));
    }
    Some(Ok(()))
}

/// Publishes a unit transition to the panel window only (Linux only):
/// `dot://unit` carries the logical snapshot, never an anchor. Dormant: no
/// transition publishes yet; future publishers advance-then-publish (see
/// `publish_unit_open`) before emitting here, never `app.emit`.
/// Dormant: no transition publishes yet (callsite branches land next unit).
#[cfg(target_os = "linux")]
#[allow(dead_code)]
fn emit_unit_to_panel(app: &AppHandle, snapshot: &NiriUnitSnapshot) {
    if let Ok(panel) = window(app, PANEL) {
        let _ = panel.emit("dot://unit", snapshot);
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

/// Dormant shared-unit state getter: logical enable/open for the
/// future single Niri surface. PANEL-only capability, registered on all OS —
/// off-Niri (and off-Linux) it returns disabled with no anchor in the payload.
#[tauri::command]
fn niri_unit_state(app: AppHandle) -> NiriUnitSnapshot {
    #[cfg(target_os = "linux")]
    {
        let shell = app.state::<Shell>();
        let socket_present = niri_socket_present();
        return unit_snapshot_of(
            &shell,
            shell.places_windows,
            platform::is_niri(&|key| std::env::var(key).ok()),
            socket_present,
        );
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        NiriUnitSnapshot::disabled()
    }
}

/// PANEL-only render-ready handshake: the panel committed the shared wrapper DOM
/// for `revision` — never an anchor or position (untouched). Accepts ONLY the live
/// enabled revision; stale or disabled acks change nothing. Reports acceptance so the panel
/// can stop retrying; the reveal worker reads the stored generation via `unit_ready_for`.
/// Registered on all OS; off-Linux always refuses (no Linux locks exist there).
#[tauri::command]
fn niri_unit_ready(app: AppHandle, revision: u64) -> bool {
    #[cfg(target_os = "linux")]
    {
        let shell = app.state::<Shell>();
        let socket_present = niri_socket_present();
        return ack_unit_ready(
            &shell.native_gate,
            &shell.native_unit,
            &shell.native_epoch,
            shell.places_windows,
            platform::is_niri(&|key| std::env::var(key).ok()),
            socket_present,
            revision,
        );
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, revision);
        false
    }
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

/// Single-surface Niri builder (Linux only): ONE transparent panel sized to the
/// startup compact mode — never the separate DOT (no hidden dot consuming
/// workspace/selection). The panel URL serves the unit surface (dot://unit +
/// niri_unit_state drive it; no anchor bytes reach the UI). The startup map keeps
/// opacity 0 until the RoseOnly shape lands, then restores opacity 1 with no
/// focus and no emit; hidden rose stays parked unmapped. Errors propagate so a
/// failed window setup never activates.
/// Shared construction and activation must always use the same policy.
#[cfg(target_os = "linux")]
fn shared_surface_available() -> bool {
    // Native GTK/Niri probes verified stable-id compact/managed sizing.
    // Construction and activation share this policy; callers still require
    // Niri, its socket, and compositor-owned positioning.
    true
}

#[cfg(target_os = "linux")]
fn build_shared_windows(app: &AppHandle, rose_hidden: bool) -> tauri::Result<()> {
    use crate::niri::unit_surface::UnitMode;
    let startup = plan_shared_startup(rose_hidden);
    let panel = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App(platform::panel_url(Os::CURRENT).into()))
        .title(PANEL_TITLE)
        .inner_size(f64::from(startup.size.0), f64::from(startup.size.1))
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        // Native GTK/WebKit pins a non-resizable first map to 200x200.
        // Keep resizable from construction; min/max fix the compact size.
        .resizable(true)
        .min_inner_size(f64::from(startup.size.0), f64::from(startup.size.1))
        .max_inner_size(f64::from(startup.size.0), f64::from(startup.size.1))
        .skip_taskbar(true)
        .disable_drag_drop_handler()
        .visible(false)
        .build()?;
    if !startup.map {
        return Ok(());
    }
    if let Ok(gtk_window) = panel.gtk_window() {
        gtk_window.set_opacity(GATED_OPACITY_HIDDEN);
        // Rose-only startup never takes keyboard focus: the chat is closed, so
        // grabbing focus from whatever the user is typing in would be rude.
        gtk_window.set_accept_focus(false);
    }
    panel.show()?;
    // Pointer events must reach the rose, but only through its own input shape,
    // so reset the cursor proxy BEFORE applying the shape (that proxy overwrites
    // it), and only then reveal: no full-canvas frame is ever interactive.
    let _ = panel.set_ignore_cursor_events(false);
    if let Ok(gtk_window) = panel.gtk_window() {
        crate::niri::unit_surface::reapply_input_shape(&gtk_window, UnitMode::RoseOnly, false);
        gtk_window.set_opacity(GATED_OPACITY_SHOWN);
    }
    Ok(())
}

fn build_windows(
    app: &AppHandle,
    config: &DesktopConfig,
    places_windows: bool,
    rose_hidden: bool,
) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    if shared_surface_available() && native_niri_mode(
        places_windows,
        platform::is_niri(&|key| std::env::var(key).ok()),
        niri_socket_present(),
    ) {
        // Single shared surface: no DOT window at all on this path.
        return build_shared_windows(app, rose_hidden);
    }
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
            niri_unit_state,
            niri_unit_ready,
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
                native_intent: Mutex::new(None),
                native_unit: Mutex::new(NiriUnitState::dormant()),
                #[cfg(target_os = "linux")]
                native_mover: Mutex::new(None),
                #[cfg(target_os = "linux")]
                native_suppress_until: Mutex::new(None),
                #[cfg(target_os = "linux")]
                cover_cancelled: Mutex::new(None),
                native_hide_job: Mutex::new(None),
                #[cfg(target_os = "linux")]
                native_io: Mutex::new(()),
                native_work_area: Mutex::new(None),
                native_unit_cache: Mutex::new(None),
                shortcut: Mutex::new(None),
            });
            // State is registered: the worker's first state read is now safe.
            // Before any window, shortcut, or initial show can queue work.
            #[cfg(target_os = "linux")]
            let follow_planned = native_receiver.is_some();
            #[cfg(target_os = "linux")]
            if let Some(rx) = native_receiver {
                spawn_restore_worker(handle.clone(), rx);
            }
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

/// Covered-collapse ack routing: the ONLY path from a
/// dispatched cover into the transition. Acked runs the float/size IPC plus
/// commit plus handoff with the cover confirmed; Timeout NEVER runs IPC — it
/// cancels the late cover through shared state, and the shared tail finish
/// (which sees outcome Err + nothing queued) owns cleanup while this surfaces
/// a bounded error with the mode untouched; Stale runs no IPC and reports the
/// live mode, and the same tail finish owns its cleanup. `transition` is
/// injectable so tests run this exact routing with fakes — no test-only copy.
#[cfg(target_os = "linux")]
fn route_covered_collapse(
    ack: CoverAck,
    job: u64,
    live_expanded: bool,
    mark: &Mutex<Option<u64>>,
    transition: &mut impl FnMut() -> CommandResult<bool>,
) -> CommandResult<bool> {
    match ack {
        CoverAck::Acked => {
            niri_trace!("mode cover acked job={job}");
            transition()
        }
        CoverAck::Timeout => {
            niri_trace!("mode cover ack timeout job={job}");
            // Cover NOT confirmed: fail closed BEFORE any float/size IPC.
            // The shared-state high-water mark (never a local flag) stops the
            // late cover from re-covering after cleanup, and can never recede
            // for an older overlapping timeout.
            cancel_cover_at(mark, job);
            Err("niri: cover acknowledgment timed out; mode unchanged".to_owned())
        }
        CoverAck::Stale => {
            niri_trace!("mode cover stale job={job}");
            Ok(live_expanded)
        }
    }
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

/// Queues a main-thread reset of the gate visuals (experimental, Linux only):
/// opacity 1 plus interactive again, only while `expected` is still the
/// current generation — a stale reset (a newer show owns the visuals) writes
/// nothing. Callers own the generation explicitly: expand unwinds the gate
/// its take orphaned, cover-timeout and failed-collapse unwind their own
/// possibly-applied cover, and collapse success never queues one (the reveal
/// owns visuals there). Same shared plan as the hide closure.
/// Fire-and-forget — queue errors mean shutdown.
#[cfg(target_os = "linux")]
fn queue_gate_reset(app: &AppHandle, panel: &WebviewWindow, expected: u64) {
    let (reset, reset_app) = (panel.clone(), app.clone());
    let _ = panel.run_on_main_thread(move || {
        let now = reset_app.state::<Shell>().native_epoch.load(Ordering::SeqCst);
        if !plan_gate_effects(now, expected, false).contains(&GateEffect::ResetVisuals) {
            return;
        }
        if let Ok(gtk_window) = reset.gtk_window() {
            gtk_window.set_opacity(GATED_OPACITY_SHOWN);
            gtk_window.set_accept_focus(true);
        }
        let _ = reset.set_ignore_cursor_events(false);
    });
}

/// Reveals a gated Niri show only after the worker confirms the settled
/// intended geometry (experimental, Linux only): opacity 1 plus focus plus
/// the panel-shown emit run on the main thread. The caller guarantees
/// settlement — this never runs for deadline expiry, unresolvable geometry,
/// or errors — and the gate contract still applies: current epoch plus held
/// gate only, so a stale hide stays hidden and never refocuses or emits.
/// GTK commit timing stays pixel-unverified.
#[cfg(target_os = "linux")]
fn reveal_gated_panel(app: &AppHandle, job: u64) {
    let shell = app.state::<Shell>();
    let current = shell.native_epoch.load(Ordering::SeqCst);
    // Take the gate only while still ours: a newer show overwrote it, a
    // hide/mode cleared it — both keep owning their own outcome.
    let ours = {
        let mut gate = shell.native_gate.lock().unwrap();
        if *gate == Some(job) {
            *gate = None;
            true
        } else {
            false
        }
    };
    if !settled_reveal_eligible(true, job, current, ours.then_some(job)) {
        niri_trace!("reveal skip job={job} current={current} ours={ours}");
        return;
    }
    let panel = match window(app, PANEL) {
        Ok(panel) => panel,
        Err(error) => {
            eprintln!("gentle-dot: gated reveal lost the panel: {error}");
            return;
        }
    };
    let (reveal, reveal_app) = (panel.clone(), app.clone());
    niri_trace!("reveal queue job={job} settled");
    if panel
        .run_on_main_thread(move || {
            // Final freshness on the main thread: a hide landing after the
            // worker take keeps the window hidden — never refocus or emit.
            // No native lock is held for any getter or action below.
            let now = reveal_app.state::<Shell>().native_epoch.load(Ordering::SeqCst);
            if !restore_job_fresh(job, now) {
                niri_trace!("reveal stale job={job} now={now}");
                return;
            }
            // A hidden window here means the gate map never landed (or ran
            // late): converge visible instead of stranding the show.
            if !reveal.is_visible().unwrap_or(false) {
                niri_trace!("reveal remap job={job}");
                if let Err(error) = reveal.show().map_err(err) {
                    eprintln!("gentle-dot: gated reveal show failed: {error}");
                    return;
                }
            }
            if let Ok(gtk_window) = reveal.gtk_window() {
                gtk_window.set_opacity(GATED_OPACITY_SHOWN);
                gtk_window.set_accept_focus(true);
            }
            let _ = reveal.set_ignore_cursor_events(false);
            if let Err(error) = reveal.set_focus().map_err(err) {
                eprintln!("gentle-dot: gated reveal focus failed: {error}");
            }
            if let Err(error) = reveal_app.emit("dot://panel-shown", ()).map_err(err) {
                eprintln!("gentle-dot: gated reveal emit failed: {error}");
            }
        })
        .is_err()
    {
        eprintln!("gentle-dot: gated reveal missed the main thread");
    }
}

/// Cancels a gated Niri show whose worker could not confirm the settled
/// intended geometry (experimental, Linux only): deadline expiry,
/// unresolvable geometry, wire errors, missing socket, or a disconnected
/// queue. Takes the gate only while still ours and fresh — stale lifecycles
/// keep owning their own outcome and are never touched — then unmaps plus
/// resets opacity/interaction on the main thread through the shared guarded
/// plan, with no focus and no panel-shown emit. The window therefore never
/// sticks at opacity 0 and never appears at the unconfirmed default anchor;
/// the gate is released so a later reopen can retry. Fire-and-forget: queue
/// errors mean shutdown.
#[cfg(target_os = "linux")]
fn cancel_gated_panel(app: &AppHandle, job: u64, reason: &str) {
    let shell = app.state::<Shell>();
    let current = shell.native_epoch.load(Ordering::SeqCst);
    let ours = {
        let mut gate = shell.native_gate.lock().unwrap();
        if *gate == Some(job) {
            *gate = None;
            true
        } else {
            false
        }
    };
    if !ours || !restore_job_fresh(job, current) {
        niri_trace!("cancel skip job={job} current={current} ours={ours} reason={reason}");
        return;
    }
    let panel = match window(app, PANEL) {
        Ok(panel) => panel,
        Err(error) => {
            eprintln!("gentle-dot: gated cancel lost the panel: {error}");
            return;
        }
    };
    niri_trace!("cancel queue job={job} reason={reason}");
    let (hidden, hidden_app) = (panel.clone(), app.clone());
    if panel
        .run_on_main_thread(move || {
            let now = hidden_app.state::<Shell>().native_epoch.load(Ordering::SeqCst);
            for effect in plan_gate_effects(now, job, true) {
                match effect {
                    GateEffect::Unmap => {
                        if let Err(error) = hidden.hide().map_err(err) {
                            eprintln!("gentle-dot: gated cancel hide failed: {error}");
                        }
                    }
                    GateEffect::ResetVisuals => {
                        if let Ok(gtk_window) = hidden.gtk_window() {
                            gtk_window.set_opacity(GATED_OPACITY_SHOWN);
                            gtk_window.set_accept_focus(true);
                        }
                        let _ = hidden.set_ignore_cursor_events(false);
                    }
                }
            }
        })
        .is_err()
    {
        eprintln!("gentle-dot: gated cancel missed the main thread");
    }
}

/// Spawns the single native restore worker: one thread per
/// app instance, woken through the coalesced capacity-1 handoff. The channel
/// is created before `manage` and this spawn runs only after it: the first
/// wait reads Shell state, which panics before registration. The receiver
/// disconnects when the exit handler takes the Shell sender, so this thread
/// then returns and drops its handle clone instead of keeping shutdown alive.
#[cfg(target_os = "linux")]
fn spawn_restore_worker(app: AppHandle, rx: mpsc::Receiver<()>) {    thread::spawn(move || {
        loop {
            let job = {
                let shell = app.state::<Shell>();
                restore_take(&rx, &shell.native_epoch)
            };
            let Some(job) = job else {
                niri_trace!("worker end reason=disconnected");
                return;
            };
            niri_trace!("worker begin job={job}");
            let outcome = run_restore_job(&app, job);
            niri_trace!("worker end job={job} ok={}", outcome.is_ok());
            if let Err(error) = outcome {
                eprintln!("gentle-dot: native panel restore failed: {error}");
            }
        }
    });
}

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

/// Injectable native ops behind the shared driver (Linux only): production
/// binds AppHandle/window/socket/state, tests bind scripted fakes — the driver
/// runs the same tested sequence either way. Every method runs outside state
/// locks; `&self` borrows compose inside the sequence closures.
#[cfg(target_os = "linux")]
trait SharedUnitOps {
    fn cover(&self) -> bool;
    fn resize(&self, size: (i32, i32)) -> bool;
    fn set_resizable(&self, resizable: bool) -> bool;
    fn hide(&self) -> bool;
    fn show(&self) -> bool;
    fn request(&self, wire: &str, timeout: Duration) -> std::io::Result<serde_json::Value>;
    fn render_ready(&self) -> bool;
    fn commit(&self, spot: Option<CompactSpot>);
    /// Last covered calibration for the live output, if any. Test doubles
    /// use the default (`None`: every transition probes, as before).
    fn cached(&self) -> Option<crate::niri::unit_restore::CachedCalibration> {
        None
    }
    /// Stores a fresh probe measurement. Only invoked on a revealed job;
    /// production additionally refuses stale generations under the gate.
    fn commit_cache(&self, _cache: crate::niri::unit_restore::CachedCalibration) {}
    /// Drops the stored calibration after a verified cache miss. Only
    /// invoked for jobs that set the miss flag; production refuses stale
    /// generations under the gate, so a superseded job never clears a newer
    /// entry. Test doubles use the default (no stored entry to drop).
    fn clear_cache(&self) {}
    fn reveal(&self, mode: crate::niri::unit_surface::UnitMode, open: bool);
    fn cancel(&self, reason: &'static str);
    fn managed_fullscreen(&self, pid: u32) -> bool;
}

/// Drives one shared job through injected ops (Linux only): the production
/// callsite and the adapter test share this exact path. Mapped-only:
/// the sequence never unmaps; a both-hidden close (open=false AND
/// rose_hidden=true) ends covered (commit, no reveal) while a close with
/// the rose wanted reveals the 72x72 rose; fullscreen runs the exact-id
/// tiling prologue first; otherwise the ordered socket sequence decides.
/// Revealed+open commits then reveals; Revealed+closed-with-rose commits
/// then reveals the rose; Revealed+both-hidden commits and stays covered;
/// Cancelled cancels exact-owned; Silent touches nothing.
#[cfg(target_os = "linux")]
fn drive_shared_unit_job(
    ops: &impl SharedUnitOps,
    pid: u32,
    anchor: Option<&CompactSpot>,
    mode: crate::niri::unit_restore::UnitRestoreMode,
    keep_mapped: bool,
    open: bool,
    rose_hidden: bool,
    gap: i32,
    margin: f64,
    budget: Duration,
    fresh: impl Fn() -> bool,
    steps: &mut Vec<&'static str>,
) -> SharedOutcome {
    use crate::niri::unit_restore::UnitRestoreMode as R;
    if !fresh() || !keep_mapped {
        return SharedOutcome::Silent;
    }
    if mode == R::Fullscreen {
        steps.push("managed");
        if !ops.managed_fullscreen(pid) {
            ops.cancel("unit tiling rejected");
            return SharedOutcome::Cancelled("unit tiling rejected");
        }
    }
    let cached = ops.cached();
    let mut cache_out = None;
    let mut cache_clear = false;
    let outcome = run_shared_unit_sequence_cached(pid, anchor, mode, rose_hidden, gap, margin, budget, fresh,
        &mut || ops.cover(), &mut || ops.set_resizable(true), &mut |size| ops.resize(size),
        &mut || ops.hide(), &mut || ops.show(),
        &mut |wire, timeout| ops.request(wire, timeout),
        &mut || ops.render_ready(), steps, cached, &mut cache_out, &mut cache_clear);
    match outcome {
        SharedOutcome::Revealed(remembered) => {
            ops.commit(remembered.clone());
            if let Some(cache) = cache_out {
                ops.commit_cache(cache);
            } else if cache_clear {
                // Miss without a refresh (the Outputs query failed): drop
                // the stale entry rather than keep it.
                ops.clear_cache();
            }
            // Corrected close: only both-hidden stays covered at opacity 0
            // (no reveal call); a close with the rose wanted reveals the
            // rose-only surface, opens reveal as before. The saved rose
            // preference is never flipped here.
            if shared_job_reveals(open, rose_hidden) {
                if let Some(surface) = shared_surface_mode(mode) { ops.reveal(surface, open); }
            }
            SharedOutcome::Revealed(remembered)
        }
        SharedOutcome::Silent => SharedOutcome::Silent,
        SharedOutcome::Cancelled(reason) => {
            if cache_clear {
                // A verified miss must never leave its stale entry behind
                // for the next job to reuse.
                ops.clear_cache();
            }
            ops.cancel(reason);
            SharedOutcome::Cancelled(reason)
        }
    }
}

/// Production native ops (Linux only): AppHandle-bound SharedUnitOps. Snapshots
/// resolve before construction; every method runs outside state locks.
/// Whether the shared surface may take keyboard focus: chat-open only.
/// Rose-only must never be focusable, so workspace-return focus memory lands
/// on the user's window; chat-open must be focusable so typing works at once.
#[cfg(target_os = "linux")]
fn shared_reveal_focusable(open: bool) -> bool {
    open
}

#[cfg(target_os = "linux")]
struct SharedNativeOps {
    app: AppHandle,
    panel: WebviewWindow,
    path: PathBuf,
    job: u64,
    surface: crate::niri::unit_surface::UnitMode,
}

#[cfg(target_os = "linux")]
impl SharedNativeOps {
    /// Apply the whole GTK size policy as one current-generation UI operation.
    /// A worker must not leave a late widget pin behind a newer managed mode.
    fn apply_size_policy(&self, size: Option<(i32,i32)>) -> bool {
        let (panel, app, job) = (self.panel.clone(),self.app.clone(),self.job);
        let (tx,rx) = std::sync::mpsc::channel();
        if self.panel.run_on_main_thread(move || {
            let shell = app.state::<Shell>();
            if !restore_job_fresh(job,shell.native_epoch.load(Ordering::SeqCst)) { return; }
            let Ok(gtk_window) = panel.gtk_window() else { return; };
            let logical = size.map(|(w,h)| LogicalSize::new(f64::from(w),f64::from(h)));
            let min = panel.set_min_size(logical).is_ok();
            let max = panel.set_max_size(logical).is_ok();
            let applied = if let Some((w,h)) = size {
                let ask = panel.set_size(LogicalSize::new(f64::from(w),f64::from(h))).is_ok();
                gtk_window.set_size_request(w,h);
                ask
            } else {
                let released = panel.set_resizable(true).is_ok();
                // Widget requests are independent of Tao's min/max fields.
                gtk_window.set_size_request(-1,-1);
                gtk_window.set_geometry_hints(None::<&gtk::Widget>,None,gtk::gdk::WindowHints::empty());
                released
            };
            gtk_window.queue_resize();
            if !(min && max && applied) { return; }
            gtk::glib::idle_add_once(move || {
                let shell = app.state::<Shell>();
                if restore_job_fresh(job,shell.native_epoch.load(Ordering::SeqCst)) {
                    let _ = tx.send(());
                }
            });
        }).is_err() { return false; }
        let shell = self.app.state::<Shell>();
        matches!(await_cover_ack(&rx,self.job,&shell.native_epoch,COLLAPSE_COVER_ACK),CoverAck::Acked)
    }
}

#[cfg(target_os = "linux")]
impl SharedUnitOps for SharedNativeOps {
    fn cover(&self) -> bool {
        let (ack_tx, ack_rx) = mpsc::channel();
        let (cover, cover_app, surface, job) = (self.panel.clone(), self.app.clone(), self.surface, self.job);
        let queued = self.panel.run_on_main_thread(move || {
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
                crate::niri::unit_surface::apply_input_shape(&gtk_window, surface, false, true);
            }
            let _ = cover.set_ignore_cursor_events(true);
            let _ = ack_tx.send(());
        });
        if queued.is_err() {
            eprintln!("gentle-dot: shared cover missed the main thread job={job}");
            return false;
        }
        let shell = self.app.state::<Shell>();
        matches!(await_cover_ack(&ack_rx, job, &shell.native_epoch, COLLAPSE_COVER_ACK), CoverAck::Acked)
    }
    fn resize(&self, size: (i32, i32)) -> bool {
        let result = self.apply_size_policy(Some(size));
        niri_trace!("shared resize {size:?} ack={result} job={}",self.job);
        result
    }
    fn set_resizable(&self, resizable: bool) -> bool {
        if !resizable { return self.panel.set_resizable(false).is_ok(); }
        let result = self.apply_size_policy(None);
        niri_trace!("shared release constraints ack={result} job={}",self.job);
        result
    }
    fn hide(&self) -> bool {
        let ok = self.panel.hide().is_ok();
        niri_trace!("shared hide ok={ok} job={}", self.job);
        ok
    }
    fn show(&self) -> bool {
        let ok = self.panel.show().is_ok();
        niri_trace!("shared show ok={ok} job={}", self.job);
        ok
    }
    fn request(&self, wire: &str, timeout: Duration) -> std::io::Result<serde_json::Value> {
        let shell = self.app.state::<Shell>();
        let _hold = shell.native_io.lock().unwrap();
        if !restore_job_fresh(self.job, shell.native_epoch.load(Ordering::SeqCst)) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "niri: restore superseded"));
        }
        crate::niri::Client::new(&self.path, timeout).request(wire)
    }
    fn render_ready(&self) -> bool {
        let shell = self.app.state::<Shell>();
        unit_ready_for(&shell.native_gate, &shell.native_unit, &shell.native_epoch, self.job)
    }
    fn commit(&self, spot: Option<CompactSpot>) {
        if let Some(spot) = spot {
            let shell = self.app.state::<Shell>();
            let _ = commit_compact_anchor(&shell.native_compact, &shell.native_gate, &shell.native_epoch, self.job, Some(spot));
        }
    }
    fn cached(&self) -> Option<crate::niri::unit_restore::CachedCalibration> {
        self.app.state::<Shell>().native_unit_cache.lock().unwrap().clone()
    }
    fn commit_cache(&self, cache: crate::niri::unit_restore::CachedCalibration) {
        // Gate-domain write like the anchor commit: a superseded or
        // cancelled job never stores its measurement.
        let shell = self.app.state::<Shell>();
        let _domain = shell.native_gate.lock().unwrap();
        if !restore_job_fresh(self.job, shell.native_epoch.load(Ordering::SeqCst)) {
            return;
        }
        *shell.native_unit_cache.lock().unwrap() = Some(cache);
    }
    fn clear_cache(&self) {
        // Gate-domain clear like the commit above: only the fresh job that
        // observed the mismatch may drop the entry it used.
        let shell = self.app.state::<Shell>();
        let _domain = shell.native_gate.lock().unwrap();
        if !restore_job_fresh(self.job, shell.native_epoch.load(Ordering::SeqCst)) {
            return;
        }
        *shell.native_unit_cache.lock().unwrap() = None;
    }
    fn reveal(&self, mode: crate::niri::unit_surface::UnitMode, open: bool) {
        // Keep GTK resizable; compact min/max pin the size without resetting
        // the WebKit content frame to GTK's non-resizable natural size.
        let (reveal, queue, app, job) = (self.panel.clone(), self.panel.clone(), self.app.clone(), self.job);
        niri_trace!("shared reveal queue job={job} open={open}");
        if queue.run_on_main_thread(move || {
            let shell = app.state::<Shell>();
            if !restore_job_fresh(job, shell.native_epoch.load(Ordering::SeqCst)) {
                return;
            }
            if !unit_ready_for(&shell.native_gate, &shell.native_unit, &shell.native_epoch, job) {
                return;
            }
            if !reveal.is_visible().unwrap_or(false) {
                if let Err(error) = reveal.show().map_err(err) {
                    eprintln!("gentle-dot: shared reveal show failed: {error}");
                    return;
                }
            }
            if let Ok(gtk_window) = reveal.gtk_window() {
                gtk_window.set_opacity(GATED_OPACITY_SHOWN);
                // Rose-only stays unfocusable so it can never steal focus;
                // chat-open becomes focusable so typing works immediately.
                gtk_window.set_accept_focus(shared_reveal_focusable(open));
            }
            let _ = reveal.set_ignore_cursor_events(false);
            if let Ok(gtk_window) = reveal.gtk_window() {
                crate::niri::unit_surface::reapply_input_shape(&gtk_window, mode, false);
            }
            if open {
                if let Err(error) = reveal.set_focus().map_err(err) {
                    eprintln!("gentle-dot: shared reveal focus failed: {error}");
                }
                if let Err(error) = app.emit("dot://panel-shown", ()).map_err(err) {
                    eprintln!("gentle-dot: shared reveal emit failed: {error}");
                }
            }
        }).is_err() {
            eprintln!("gentle-dot: shared reveal missed the main thread job={job}");
        }
    }
    fn cancel(&self, reason: &'static str) {
        cancel_gated_panel(&self.app, self.job, reason);
    }
    fn managed_fullscreen(&self, pid: u32) -> bool {
        if !self.set_resizable(true) {
            return false;
        }
        let query = |wire: &str| self.request(wire, NATIVE_RESTORE_PASS);
        let Ok(windows) = query(crate::niri::WINDOWS_REQUEST) else { return false };
        let Some(panel) = crate::niri::own_panel_window(&windows, pid) else { return false };
        if let Some(wire) = crate::niri::reconcile_action(&panel, true) {
            if !query(&wire).is_ok_and(|reply| crate::niri::is_handled(&reply)) { return false; }
        }
        let Ok(windows) = query(crate::niri::WINDOWS_REQUEST) else { return false };
        let Some(current) = crate::niri::own_panel_window(&windows, pid) else { return false };
        for wire in crate::niri::action_managed_geometry(current.id) {
            if !query(&wire).is_ok_and(|reply| crate::niri::is_handled(&reply)) { return false; }
        }
        true
    }
}

/// Production shared job (Linux only): resolves SINGLE PANEL outside state
/// locks, snapshots logical state in sequential brief holds, drives the shared
/// sequence through native ops, and maps the outcome. Legacy paths untouched.
#[cfg(target_os = "linux")]
fn run_shared_unit_job(app: &AppHandle, job: u64) -> CommandResult {
    let shell = app.state::<Shell>();
    let panel = window(app, PANEL).map_err(|error| { cancel_gated_panel(app, job, "unit panel missing"); error })?;
    let open = shell.native_unit.lock().unwrap().open;
    let rose_hidden = shell.rose_hidden.load(Ordering::SeqCst);
    let expanded = *shell.native_expanded.lock().unwrap();
    let anchor = shell.native_compact.lock().unwrap().clone();
    let mode = shared_restore_mode(open, rose_hidden, expanded);
    let keep_mapped = matches!(unit_window_for(open, rose_hidden, expanded), UnitWindow::KeepMapped);
    let socket = std::env::var("NIRI_SOCKET").ok().filter(|path| !path.is_empty());
    let Some(path) = socket else {
        cancel_gated_panel(app, job, "unit socket missing");
        return Err("niri: shared unit socket missing; hidden for retry".to_owned());
    };
    let ops = SharedNativeOps {
        app: app.clone(),
        panel,
        path: PathBuf::from(path),
        job,
        surface: shared_surface_mode(mode).unwrap_or(crate::niri::unit_surface::UnitMode::Pair),
    };
    let mut steps: Vec<&'static str> = Vec::new();
    let fresh = || restore_job_fresh(job, app.state::<Shell>().native_epoch.load(Ordering::SeqCst));
    let outcome = drive_shared_unit_job(&ops, std::process::id(), anchor.as_ref(), mode,
        keep_mapped, open, rose_hidden, PANEL_GAP, f64::from(EDGE_MARGIN), NATIVE_RESTORE_JOB, fresh, &mut steps);
    niri_trace!("shared unit job={job} steps={steps:?} outcome={outcome:?}");
    match outcome {
        SharedOutcome::Revealed(_) | SharedOutcome::Silent => Ok(()),
        SharedOutcome::Cancelled(reason) => Err(format!("niri: shared unit {reason}; hidden for retry")),
    }
}

#[cfg(target_os = "linux")]
fn run_restore_job(app: &AppHandle, job: u64) -> CommandResult {
    let shell = app.state::<Shell>();
    // Early shared route: explicit activation AND Niri, before old two-window
    // logic. Dormant while `active` is FALSE, so legacy paths stay identical.
    #[cfg(target_os = "linux")]
    {
        let active = shell.native_unit.lock().unwrap().active;
        let socket_present = niri_socket_present();
        if shared_route_wanted(active, shell.places_windows, platform::is_niri(&|key| std::env::var(key).ok()), socket_present) {
            return run_shared_unit_job(app, job);
        }
    }
    // Single injected toolkit effect (seam): the expanded-branch
    // constraint release; everything else in the pass is state or socket.
    let mut set_resizable_panel = |resizable: bool| {
        window(app, PANEL).and_then(|panel| panel.set_resizable(resizable).map_err(err))
    };
    let socket = std::env::var("NIRI_SOCKET").ok();
    let inner = run_restore_job_inner(&shell, job, &mut set_resizable_panel, socket.as_deref());
    // Freshness and gate ownership for the `Ok(false)` arm; `Ok(true)` reveals
    // and `Err` always attempts the guarded cancel (which no-ops when stale).
    let (fresh_now, ours) = match &inner {
        Ok(false) => {
            let shell = app.state::<Shell>();
            let current = shell.native_epoch.load(Ordering::SeqCst);
            let ours = *shell.native_gate.lock().unwrap() == Some(job);
            (restore_job_fresh(job, current), ours)
        }
        _ => (false, false),
    };
    let owns_fresh_gate = fresh_now && ours;
    // D1/D2: no unconditional stranded recovery — a fresh unsettled job with
    // no gate of its own is an ordinary gateless follower and routes Silent
    // below (Ok, no hide), never hide/error. Owned-gate failures still
    // cancel through the guarded path; stale callbacks plan no effects.
    match plan_restore_completion(&inner, owns_fresh_gate) {
        RestoreCompletion::Reveal => {
            reveal_gated_panel(app, job);
            Ok(())
        }
        RestoreCompletion::Cancel => match inner {
            // Unsettled but not an error: hide only while this job still owns
            // a fresh gate (a gated show awaiting settle); stale and ungated
            // jobs stay silent so later reopens can retry.
            Ok(false) => {
                cancel_gated_panel(app, job, "spot unconfirmed");
                Err("niri: panel spot unconfirmed; hidden for retry".to_owned())
            }
            Err(error) => {
                cancel_gated_panel(app, job, &error);
                Err(error)
            }
            Ok(true) => unreachable!("Reveal routes separately"),
        },
        RestoreCompletion::Silent => Ok(()),
    }
}

/// Inner restore body: `Ok(true)` only for a confirmed
/// settled intended geometry (beside-rose done, remembered-spot done,
/// hidden default-anchor settled, expanded done); `Ok(false)` where there is
/// nothing to settle (stale cancel, missing socket); `Err` for deadline
/// expiry, unresolvable geometry, and wire failures. The move arm sends once,
/// then loops back to verify the settled IPC position before completing; only
/// transient null positions retry, never invalid sizes or wrong outputs.
/// Compact jobs require generation-owned intent and a remembered anchor.
/// Equal compositor frames never establish the base; explicit bootstrap and
/// collapse fail until base calibration is implemented. Missing windows
/// (mv347ejs leg 3) retry bounded by time AND by the pass cap, secret-free,
/// and a stale deadline never unmaps a newer show (guarded cancel no-ops).
/// The socket path is injected: production resolves the env once
/// in run_restore_job above; tests pass an explicit path, so no test mutates
/// the process environment. The production loop is still the body tests call.
#[cfg(target_os = "linux")]
fn run_restore_job_inner(shell: &Shell, job: u64, set_resizable_panel: &mut impl FnMut(bool) -> CommandResult<()>, socket: Option<&str>) -> CommandResult<bool> {
    use std::path::PathBuf;
    use std::time::Instant;
    let start = Instant::now();
    let fresh = || restore_job_fresh(job, shell.native_epoch.load(Ordering::SeqCst));
    let remaining = || NATIVE_RESTORE_JOB.saturating_sub(start.elapsed());
    let pass = || remaining().min(NATIVE_RESTORE_PASS);
    let Some(socket) = socket.filter(|path| !path.is_empty()) else {
        niri_trace!("worker job={job} end reason=no-socket");
        return Ok(false);
    };
    let path = PathBuf::from(socket);
    let pid = std::process::id();
    let request =
        |wire: &str, timeout: Duration| crate::niri::Client::new(&path, timeout).request(wire);
    let desired = *shell.native_expanded.lock().unwrap();
    let mut needs_base = false;
    let mut preserve_calibration_anchor = false;
    if !desired {
        let Some(intent) = resolve_job_intent(
            job, &shell.native_epoch, &shell.native_gate, &shell.native_intent,
        ) else {
            return if fresh() {
                Err("niri: restore intent unavailable; hidden for retry".to_owned())
            } else {
                Ok(false)
            };
        };
        match intent {
            RestoreIntent::PreserveCompact => {
                if shell.native_compact.lock().unwrap().is_none() {
                    return Err("niri: compact anchor unavailable; hidden for retry".to_owned());
                }
                // A remembered point is not a measured work area. Without bounds
                // a beside-rose target can be clamped by Niri and never settle.
                // Probe only under our cover and preserve the session anchor.
                if *shell.native_gate.lock().unwrap() == Some(job)
                    && shell.native_work_area.lock().unwrap().is_none()
                {
                    needs_base = true;
                    preserve_calibration_anchor = true;
                }
            }
            RestoreIntent::BootstrapBase | RestoreIntent::CollapseToBase => {
                if *shell.native_gate.lock().unwrap() != Some(job) {
                    return Err("niri: base calibration requires owned cover; hidden for retry".to_owned());
                }
                needs_base = true;
            }
        }
    }
    // Per-job snapshot alongside `desired`: a visible rose recomputes the
    // beside target from the fresh IPC dot anchor on every pass and never
    // reads the session-remembered spot; a hidden rose restores it below.
    let beside = !desired && !shell.rose_hidden.load(Ordering::SeqCst);
    niri_trace!("worker job={job} start desired={desired} beside={beside}");
    let mut passes: usize = 0;
    let mut moved = false;
    // Missing-window bound (mv347ejs leg 3): consecutive misses end the job
    // by time AND by pass count, never an infinite spin.
    let mut missing_streak: usize = 0;
    // Settle confirmation (experimental gate): the move wire sends once per
    // job; afterwards passes only re-query, never re-move, until the IPC
    // position reads settled or the deadline clips the wait.
    loop {
        let pass_no = passes;
        passes += 1;
        if !fresh() {
            niri_trace!("worker job={job} end reason=cancel pass={pass_no} desired={desired}");
            return Ok(false);
        }
        if remaining().is_zero() {
            niri_trace!("worker job={job} end reason=deadline pass={pass_no} desired={desired}");
            return Err("niri: restore deadline exceeded; hidden for retry".to_owned());
        }
        // I/O ownership: this pass holds native_io across its
        // queries, planning, and actions — mode wire and worker wire
        // serialize instead of interleaving mid-transaction. Dropped before
        // every sleep, getter wait, and callback delivery below (returns
        // auto-drop); never native_expanded, whose job-start snapshot is
        // re-validated here against a committed-but-not-handed-off flip.
        let _io = shell.native_io.lock().unwrap();
        if !fresh() || *shell.native_expanded.lock().unwrap() != desired {
            niri_trace!("worker job={job} end reason=cancel pass={pass_no} desired={desired}");
            return Ok(false);
        }
        // Fresh resolve every pass; missing windows and query errors retry
        // mapping readiness within budget, worker-thread sleeps only.
        let windows = match request(crate::niri::WINDOWS_REQUEST, pass()) {
            Ok(windows) => windows,
            Err(error) => {
                if pass_no < NIRI_TRACE_PASS_CAP {
                    niri_trace!("worker job={job} pass={pass_no} query=windows err={} desired={desired}", error.kind());
                }
                drop(_io);
                thread::sleep(clipped_poll(remaining()));
                continue;
            }
        };
        let Some(panel) = crate::niri::own_panel_window(&windows, pid) else {
            // Missing-window (mv347ejs leg 3): bounded retry by time AND by
            // pass count (secret-free counter, never window JSON/titles).
            // A racing hide already bumped the epoch, so the next loop top
            // exits stale-silent before any unmap; the guarded cancel below
            // no-ops when stale, so a deadline here can never unmap a newer
            // show nor open any dialog — hide+reset only, no focus/emit.
            missing_streak += 1;
            if pass_no < NIRI_TRACE_PASS_CAP {
                niri_trace!("worker job={job} pass={pass_no} reason=missing-window desired={desired} streak={missing_streak}");
            }
            if !crate::niri::missing_window_should_retry(start.elapsed(), NATIVE_RESTORE_JOB, missing_streak) {
                niri_trace!("worker job={job} end reason=missing-window-giveup pass={pass_no} streak={missing_streak}");
                return Err("niri: restore deadline exceeded; hidden for retry".to_owned());
            }
            drop(_io);
            thread::sleep(clipped_poll(remaining()));
            continue;
        };
        missing_streak = 0;
        if pass_no < NIRI_TRACE_PASS_CAP {
            let reconcile = if crate::niri::reconcile_action(&panel, desired).is_some() { "some" } else { "none" };
            niri_trace!("worker job={job} pass={pass_no} {} reconcile={reconcile}", format_trace_panel(panel.id, panel.floating, panel.pos, panel.size, None, None, None));
        }
        if desired {
            // A remapped widget starts with initial fixed constraints again:
            // release before any expanded action or Niri clamps small like the
            // first expand. Nonwaiting proxy, safe on this thread.
            set_resizable_panel(true)?;
        }
        if let Some(action) = crate::niri::reconcile_action(&panel, desired) {
            // Freshness under the pass I/O hold: a take landing
            // mid-wire is caught here before acting.
            if !fresh() {
                niri_trace!("worker job={job} end reason=cancel pass={pass_no}");
                return Ok(false);
            }
            match request(&action, pass()) {
                Ok(reply) => {
                    let handled = crate::niri::is_handled(&reply);
                    niri_trace!("worker job={job} pass={pass_no} action=reconcile handled={handled}");
                    if !handled {
                        return Err("niri: unexpected action response".to_owned());
                    }
                }
                Err(error) => {
                    niri_trace!("worker job={job} pass={pass_no} action=reconcile err={}", error.kind());
                    return Err(error.to_string());
                }
            }
            if !desired {
                continue; // refloated: re-query positions after configure below.
            }
        }
        if desired {
            // Managed geometry for the freshly resolved window: tiling alone
            // keeps small sizes on clamped remaps, and already-tiled remaps
            // need it too. Same pass budget, no deadline reset.
            let windows = match request(crate::niri::WINDOWS_REQUEST, pass()) {
                Ok(windows) => windows,
                Err(error) => {
                    if pass_no < NIRI_TRACE_PASS_CAP {
                        niri_trace!("worker job={job} pass={pass_no} query=windows-geometry err={}", error.kind());
                    }
                    drop(_io);
                    thread::sleep(clipped_poll(remaining()));
                    continue;
                }
            };
            let Some(current) = crate::niri::own_panel_window(&windows, pid) else {
                if pass_no < NIRI_TRACE_PASS_CAP {
                    niri_trace!("worker job={job} pass={pass_no} reason=missing-window-geometry");
                }
                drop(_io);
                thread::sleep(clipped_poll(remaining()));
                continue;
            };
            for wire in crate::niri::action_managed_geometry(current.id) {
                // Freshness under the pass I/O hold: a take landing
                // mid-wire is caught here before acting.
                if !fresh() {
                    niri_trace!("worker job={job} end reason=cancel pass={pass_no}");
                    return Ok(false);
                }
                match request(&wire, pass()) {
                    Ok(reply) => {
                        let handled = crate::niri::is_handled(&reply);
                        niri_trace!("worker job={job} pass={pass_no} action=geometry id={} handled={handled}", current.id);
                        if !handled {
                            return Err("niri: unexpected action response".to_owned());
                        }
                    }
                    Err(error) => {
                        niri_trace!("worker job={job} pass={pass_no} action=geometry id={} err={}", current.id, error.kind());
                        return Err(error.to_string());
                    }
                }
            }
            niri_trace!("worker job={job} end reason=restore-done pass={pass_no} mode=expanded");
            return Ok(true);
        }
        if needs_base {
            // Wait for compact configure: unmapped/expanded-size geometry
            // cannot establish a compact work-area anchor.
            if panel.pos.is_none() || panel.size != (PANEL_SIZE.0 as i32, PANEL_SIZE.1 as i32) {
                drop(_io);
                thread::sleep(clipped_poll(remaining()));
                continue;
            }
            let mut calibration_request = |wire: &str, timeout| request(wire, timeout);
            let base = crate::niri::base::calibrate(
                pid, beside, PANEL_GAP, f64::from(EDGE_MARGIN), remaining(), fresh,
                &mut calibration_request,
            ).map_err(err)?;
            let Some((base, work)) = base else { return Ok(false) };
            {
                // State commit is gate-owned, after all probe I/O. No state
                // lock spans a socket call or a GTK/getter wait.
                let gate = shell.native_gate.lock().unwrap();
                if !fresh() || *gate != Some(job) {
                    return Ok(false);
                }
                if !preserve_calibration_anchor {
                    *shell.native_compact.lock().unwrap() = Some(base);
                }
                *shell.native_work_area.lock().unwrap() = Some(work);
                *shell.native_mover.lock().unwrap() = None;
            }
            needs_base = false;
            // Probe positions invalidate this pass's Windows snapshot.
            // Resolve again before planning the final panel/rose pair.
            continue;
        }
        if beside {
            // JOINT unit (estructural): UN SOLO DATO = ancla panel
            // (`native_compact`, sesión); la rosa deriva beside-panel
            // (derecha-centrada, PANEL_GAP). Cada pass calcula AMBOS
            // destinos desde el ancla y mueve ambas ventanas en la misma
            // pasada (hasta dos AdjustFixed exact-id, un solo hold del lock
            // de modo, misma época) — nada de perseguir. La dirección sale
            // del ancla + quién movió el usuario (`native_mover`,
            // EventStream), nunca de prioridad fija al dot (traza b). Un
            // remapeo (rosa al centro exacto 1244, ventana ausente) es
            // transitorio: reintento acotado, nunca fallo one-shot (a, c).
            // Los movimientos propios NUNCA reescriben el ancla: solo el
            // mover del usuario o la captura explícita hide/expand la
            // escriben — anti-ping-pong por construcción. Reveal gateado
            // solo tras settle verificado.
            let dot = match crate::niri::own_dot_window(&windows, pid) {
                Some(dot) => dot,
                None => {
                    if pass_no < NIRI_TRACE_PASS_CAP {
                        niri_trace!("worker job={job} pass={pass_no} reason=missing-dot-remap-retry");
                    }
                    drop(_io);
                    thread::sleep(clipped_poll(remaining()));
                    continue;
                }
            };
            let workspaces = match request(crate::niri::WORKSPACES_REQUEST, pass()) {
                Ok(workspaces) => workspaces,
                Err(error) => {
                    if pass_no < NIRI_TRACE_PASS_CAP {
                        niri_trace!("worker job={job} pass={pass_no} query=workspaces err={}", error.kind());
                    }
                    drop(_io);
                    thread::sleep(clipped_poll(remaining()));
                    continue;
                }
            };
            let output = crate::niri::workspace_output(&workspaces, panel.workspace);
            let dot_output = crate::niri::workspace_output(&workspaces, dot.workspace);
            // El ancla SOLO cambia por movimiento del usuario (mover fijado
            // por el follow) o queda; establecer desde el panel cuando aún
            // no hay ancla (el panel manda, la rosa se une — nunca al revés).
            // Rosa-dir fix: el mover se retiene para filtrar la pasada (la
            // rosa nunca se mueve en un wake-Dot) y un mover irresoluble con
            // geometría fresca NUNCA cae al ancla vieja: reintento acotado
            // dentro del presupuesto (el panel jamás va a un destino
            // anterior al movimiento que disparó el wake; el deadline cierra
            // con retry en reapertura).
            let mover = shell.native_mover.lock().unwrap().take();
            if let Some(m) = mover {
                match crate::niri::anchor_from_mover(
                    m,
                    &dot,
                    dot_output.as_deref(),
                    &panel,
                    output.as_deref(),
                    PANEL_GAP,
                ) {
                    Some(fresh_anchor) => {
                        // Synchronized commit: a mover taken
                        // before a collapse reset must not resurrect an anchor
                        // after it. Refusal exits stale — a superseded job
                        // never acts on newer state.
                        if commit_compact_anchor(
                            &shell.native_compact,
                            &shell.native_gate,
                            &shell.native_epoch,
                            job,
                            Some(fresh_anchor),
                        ) {
                            niri_trace!("worker job={job} pass={pass_no} anchor=user-{m:?}");
                        } else {
                            niri_trace!("worker job={job} end reason=cancel pass={pass_no}");
                            return Ok(false);
                        }
                    }
                    None => {
                        // Put-back under the same gate→mover domain:
                        // the mover carries no epoch and the follow overwrites
                        // it constantly, so a superseded job drops it instead
                        // of resurrecting it over a newer lifecycle.
                        let _ = restore_mover_if_fresh(
                            &shell.native_mover,
                            &shell.native_gate,
                            &shell.native_epoch,
                            job,
                            m,
                        );
                        if pass_no < NIRI_TRACE_PASS_CAP {
                            niri_trace!("worker job={job} pass={pass_no} reason=mover-anchor-retry");
                        }
                        drop(_io);
                        thread::sleep(clipped_poll(remaining()));
                        continue;
                    }
                }
            }
            let saved = shell.native_compact.lock().unwrap().clone();
            let Some(saved) = saved else {
                return if fresh() {
                    Err("niri: compact anchor unavailable; hidden for retry".to_owned())
                } else {
                    Ok(false)
                };
            };
            // S7: the plan targets the clamped anchor so the whole pair stays on
            // screen; the remembered anchor itself is never rewritten here.
            let area = *shell.native_work_area.lock().unwrap();
            let anchor = clamp_anchor_to_work_area(area, saved, beside);
            if pass_no < NIRI_TRACE_PASS_CAP {
                niri_trace!("worker job={job} pass={pass_no} joint anchor=({},{}) area={area:?} panel_pos={:?} dot_pos={:?} dot_size={:?} panel_output={output:?} dot_output={dot_output:?}", anchor.x, anchor.y, panel.pos, dot.pos, dot.size);
            }
            let joint = crate::niri::joint_moves_for_mover(
                mover,
                crate::niri::plan_joint_moves(&anchor, &dot, dot_output.as_deref(), &panel, output.as_deref(), PANEL_GAP),
            );
            match joint {
                crate::niri::JointMove::Settled => {
                    niri_trace!("worker job={job} end reason=joint-settled pass={pass_no} {}", format_trace_panel(panel.id, panel.floating, panel.pos, panel.size, output.as_deref(), Some((0, 0)), None));
                    return Ok(true);
                }
                crate::niri::JointMove::Moves { panel: panel_move, rose: rose_move } => {
                    if moved {
                        if pass_no < NIRI_TRACE_PASS_CAP {
                            niri_trace!("worker job={job} pass={pass_no} reason=await-settle");
                        }
                        drop(_io);
                        thread::sleep(clipped_poll(remaining()));
                        continue;
                    }
                    // Freshness under the pass I/O hold: a take
                    // landing mid-wire is caught here before acting.
                    if !fresh() {
                        niri_trace!("worker job={job} end reason=cancel pass={pass_no}");
                        return Ok(false);
                    }
                    for (id, dx, dy) in [panel_move, rose_move].into_iter().flatten() {
                        match request(&crate::niri::action_move_floating(id, dx, dy), pass()) {
                            Ok(reply) => {
                                let handled = crate::niri::is_handled(&reply);
                                niri_trace!("worker job={job} pass={pass_no} action=joint id={id} handled={handled}");
                                if !handled {
                                    return Err("niri: unexpected action response".to_owned());
                                }
                            }
                            Err(error) => {
                                niri_trace!("worker job={job} pass={pass_no} action=joint id={id} err={}", error.kind());
                                return Err(error.to_string());
                            }
                        }
                    }
                    moved = true;
                    *shell.native_suppress_until.lock().unwrap() =
                        Some(std::time::Instant::now() + crate::niri::FOLLOW_DEBOUNCE * 2);
                    niri_trace!("worker job={job} pass={pass_no} action=joint-sent");
                    continue;
                }
                crate::niri::JointMove::Wait if panel.pos.is_none() || dot.pos.is_none() => {
                    // Null positions must never plan or act: release, sleep,
                    // and re-query the full pass before touching anything —
                    // follow anchor updates don't bump the epoch, so a
                    // freshness check alone cannot catch stale geometry.
                    if pass_no < NIRI_TRACE_PASS_CAP {
                        niri_trace!("worker job={job} pass={pass_no} reason=null-pos-retry");
                    }
                    drop(_io);
                    thread::sleep(clipped_poll(remaining()));
                    continue;
                }
                crate::niri::JointMove::Wait => {
                    niri_trace!("worker job={job} end reason=settled-elsewhere pass={pass_no}");
                    return Err("niri: joint geometry unresolvable; hidden for retry".to_owned());
                }
            }
        }
        let saved = shell.native_compact.lock().unwrap().clone();
        let Some(saved) = saved else {
            return if fresh() {
                Err("niri: compact anchor unavailable; hidden for retry".to_owned())
            } else {
                Ok(false)
            };
        };
        let area = *shell.native_work_area.lock().unwrap();
        let saved = clamp_anchor_to_work_area(area, saved, !shell.rose_hidden.load(Ordering::SeqCst));
        let workspaces = match request(crate::niri::WORKSPACES_REQUEST, pass()) {
            Ok(workspaces) => workspaces,
            Err(error) => {
                if pass_no < NIRI_TRACE_PASS_CAP {
                    niri_trace!("worker job={job} pass={pass_no} query=workspaces err={}", error.kind());
                }
                drop(_io);
                thread::sleep(clipped_poll(remaining()));
                continue;
            }
        };
        let output = crate::niri::workspace_output(&workspaces, panel.workspace);
        match plan_compact_restore(Some(&saved), &panel, output.as_deref()) {
            Some((_, 0, 0)) => {
                niri_trace!("worker job={job} end reason=restore-done pass={pass_no} {}", format_trace_panel(panel.id, panel.floating, panel.pos, panel.size, output.as_deref(), Some((0, 0)), None));
                return Ok(true); // settled home: no move needed.
            }
            Some((id, dx, dy)) => {
                if moved {
                    // The move is accepted (`Handled`): an animation may still
                    // be in flight, so re-query without re-moving. Never
                    // assume the wire effect landed; the deadline above clips.
                    if pass_no < NIRI_TRACE_PASS_CAP {
                        niri_trace!("worker job={job} pass={pass_no} reason=await-settle");
                    }
                    drop(_io);
                    thread::sleep(clipped_poll(remaining()));
                    continue;
                }
                if pass_no < NIRI_TRACE_PASS_CAP {
                    niri_trace!("worker job={job} pass={pass_no} {}", format_trace_panel(id, panel.floating, panel.pos, panel.size, output.as_deref(), Some((dx, dy)), None));
                }
                if !fresh() {
                    niri_trace!("worker job={job} end reason=cancel pass={pass_no}");
                    return Ok(false);
                }
                match request(&crate::niri::action_move_floating(id, dx, dy), pass()) {
                    Ok(reply) => {
                        let handled = crate::niri::is_handled(&reply);
                        niri_trace!("worker job={job} pass={pass_no} action=move handled={handled}");
                        if !handled {
                            return Err("niri: unexpected action response".to_owned());
                        }
                    }
                    Err(error) => {
                        niri_trace!("worker job={job} pass={pass_no} action=move err={}", error.kind());
                        return Err(error.to_string());
                    }
                }
                // `Handled` only accepts the move: loop back and verify the
                // settled IPC position before the reveal may run.
                moved = true;
                niri_trace!("worker job={job} pass={pass_no} action=move-sent");
                continue;
            }
            // Settled elsewhere: fail closed. Transient nulls retry above.
            None if panel.pos.is_none() => {
                if pass_no < NIRI_TRACE_PASS_CAP {
                    niri_trace!("worker job={job} pass={pass_no} reason=null-pos-retry");
                }
                drop(_io);
                thread::sleep(clipped_poll(remaining()))
            }
            None => {
                niri_trace!("worker job={job} end reason=settled-elsewhere pass={pass_no}");
                return Err("niri: compact geometry unresolvable; hidden for retry".to_owned());
            }
        }
    }
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
