//! Windows application integration. Native provider and shared MCP policy stay separate.
//! Source only: owner compilation and Windows acceptance are still required.
#[path = "windows_app/capture.rs"]
mod capture;
#[path = "windows_app/dialogs.rs"]
mod dialogs;
#[path = "windows_app/overlay.rs"]
mod overlay;

use super::{AppMainThread, Computer, Overlay, OverlayRings, YoloMenuItem, STATE_EVENT};
use crate::computer::{self, control::Control, session::StateEvent,
    win32::{OwnWindows, WindowsDesktop}, working::{Windows, Working, READY_TIMEOUT},
    Clock, Desktop, SystemClock};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Clone, Copy)]
enum Kind { Dot, Panel, Glow }
struct Visibility {
    handles: Vec<(usize, Kind)>,
    dot: bool,
    panel: bool,
    deferred: [bool; 2],
    panel_revision: u64,
    panel_effects: Option<(u64, PromptStamp)>,
}

pub(super) struct Runtime {
    app: AppHandle,
    own: OwnWindows,
    control: Arc<Control>,
    working: Arc<Working>,
    windows: Arc<dyn Windows>,
    visibility: Mutex<Visibility>,
    initialized: AtomicBool,
    failed: AtomicBool,
    flight: AtomicBool,
    operation: AtomicU64,
    capturing: AtomicBool,
    grants: Arc<GrantFence>,
}

/// Windows-only commit fence for the unchanged Helper's dialog -> grant gap. An
/// accepted native prompt carries its ORIGINAL epoch, not the epoch after Stop.
#[derive(Clone, Copy, PartialEq, Eq)]
struct PromptStamp { epoch: u64, cancellation: u64 }
#[derive(Default)]
struct GrantFence {
    approved: Mutex<Option<PromptStamp>>,
    cancellation: AtomicU64,
}
impl GrantFence {
    fn stamp(&self, epoch: u64) -> PromptStamp {
        PromptStamp { epoch, cancellation: self.cancellation.load(Ordering::Acquire) }
    }
    fn current(&self, stamp: PromptStamp, epoch: u64) -> bool { stamp == self.stamp(epoch) }
    fn approve(&self, stamp: PromptStamp) -> bool {
        let Ok(mut approved) = self.approved.try_lock() else { return false };
        if stamp.cancellation != self.cancellation.load(Ordering::Acquire) { return false; }
        *approved = Some(stamp);
        true
    }
    fn valid(&self, epoch: u64) -> bool {
        self.approved.try_lock().ok().is_some_and(|approved| {
            approved.is_some_and(|stamp| self.current(stamp, epoch))
        })
    }
    fn clear(&self) { if let Ok(mut approved) = self.approved.try_lock() { *approved = None; } }
    fn cancel(&self) {
        // Control::end intentionally leaves an IDLE session's epoch unchanged. This
        // additional Windows prompt generation fences Stop/panic during its first grant.
        self.cancellation.fetch_add(1, Ordering::AcqRel);
        self.clear();
    }
}

/// Nonblocking ownership marker, NOT a held mutex across native/modal/UI callbacks.
struct Flight<'a>(&'a AtomicBool);
impl<'a> Flight<'a> {
    fn acquire(flag: &'a AtomicBool) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self(flag)).map_err(|_| "Windows operation or native prompt already in flight".into())
    }
}
impl Drop for Flight<'_> {
    fn drop(&mut self) { self.0.store(false, Ordering::Release); }
}

fn restorable(user_visible: bool, working: bool, rose_hidden: bool) -> bool {
    user_visible && !working && !rose_hidden
}

impl Runtime {
    fn available(&self) -> bool {
        self.initialized.load(Ordering::Acquire) && !self.failed.load(Ordering::Acquire)
    }

    fn require_operation(&self) -> Result<(), String> {
        if !self.available() || !self.control.is_active(SystemClock.now_ms()) {
            return Err("Windows computer control is unavailable or stopped".into());
        }
        Ok(())
    }

    fn require_epoch(&self, epoch: u64) -> Result<(), String> {
        self.require_operation()?;
        if self.control.epoch() != epoch { return Err("Windows computer session changed".into()); }
        Ok(())
    }

    /// Reads INTENT, never visibility deliberately changed by capture. No lock crosses
    /// Working/Control calls or native UI callbacks. Failed intent lookup never shows.
    fn desired(&self, handle: usize, working_hides: bool) -> Result<bool, String> {
        let (kind, user_visible) = {
            let state = self.visibility.try_lock().map_err(|_| "window intent unavailable")?;
            let kind = state.handles.iter().find(|(hwnd, _)| *hwnd == handle)
                .map(|(_, kind)| *kind).ok_or("window intent is unregistered")?;
            let visible = match kind { Kind::Dot => state.dot, Kind::Panel => state.panel, Kind::Glow => true };
            (kind, visible)
        };
        Ok(match kind {
            Kind::Glow => self.available() && self.control.is_active(SystemClock.now_ms()),
            // Capture separately limits eligibility to its snapshot or explicit
            // deferred requests; Working restoration still uses its own hide fence.
            Kind::Dot => restorable(user_visible, working_hides && self.working_operation(), self.windows.rose_hidden()),
            Kind::Panel => restorable(user_visible, working_hides && self.working_operation(), false),
        })
    }

    fn capture_desired(&self, handle: usize, was_visible: bool) -> Result<bool, String> {
        let deferred = {
            let state = self.visibility.try_lock().map_err(|_| "window intent unavailable")?;
            match state.handles.iter().find(|(hwnd, _)| *hwnd == handle).map(|(_, kind)| kind) {
                Some(Kind::Dot) => state.deferred[0],
                Some(Kind::Panel) => state.deferred[1],
                Some(Kind::Glow) => false,
                None => return Err("window intent is unregistered".into()),
            }
        };
        Ok((was_visible || deferred) && self.desired(handle, false)?)
    }

    fn panel_effects_current(&self, revision: u64, stamp: PromptStamp) -> Result<bool, String> {
        let current = {
            let state = self.visibility.try_lock().map_err(|_| "window intent unavailable")?;
            state.panel && state.panel_revision == revision
        };
        Ok(current && !self.capturing.load(Ordering::Acquire)
            && self.require_operation().is_ok() && self.grants.current(stamp, self.control.epoch()))
    }

    fn end_capture(&self, restored: bool) -> Result<(), String> {
        // UI thread only, AFTER guard restoration. Consume once before native callbacks.
        self.capturing.store(false, Ordering::Release);
        let result = (|| {
            let pending = {
                let mut state = self.visibility.try_lock().map_err(|_| "window intent unavailable")?;
                state.deferred = [false; 2];
                state.panel_effects.take()
            };
            let Some((revision, stamp)) = pending.filter(|_| restored) else { return Ok(()) };
            if !self.panel_effects_current(revision, stamp)? { return Ok(()); }
            let panel = self.app.get_webview_window("panel").ok_or("panel unavailable after capture")?;
            let handle = panel.hwnd().map_err(|_| "panel HWND unavailable")?.0 as usize;
            if !self.desired(handle, false)? || !panel.is_visible().map_err(|_| "panel visibility unavailable")? {
                return Ok(());
            }
            panel.set_focus().map_err(|_| "panel focus unavailable after capture")?;
            // Focus can reenter hide/Stop/a newer explicit request. Never emit stale effects.
            if self.panel_effects_current(revision, stamp)?
                && panel.is_visible().map_err(|_| "panel visibility unavailable")? {
                self.app.emit("dot://panel-shown", ()).map_err(|_| "panel notification failed")?;
            }
            Ok(())
        })();
        if result.is_err() { self.fail(); }
        result
    }

    fn working_operation(&self) -> bool {
        let operation = self.operation.load(Ordering::Acquire);
        operation != 0 && self.working.is_current(operation)
    }

    pub(super) fn stop(&self, reason: computer::session::Reason) {
        self.grants.cancel();
        self.control.end(reason);
        self.working.session_ended();
    }

    fn fail(&self) {
        self.failed.store(true, Ordering::Release);
        self.stop(computer::session::Reason::Stopped);
    }
}

pub(super) fn start(app: &AppHandle, windows: Arc<dyn Windows>) -> Computer {
    let (sender, messages) = std::sync::mpsc::channel::<Overlay>();
    let working = Arc::new(Working::new(windows.clone(), Arc::new(OverlayRings(sender.clone())),
        Arc::new(AppMainThread(app.clone())), READY_TIMEOUT));
    let events = app.clone();
    let session = sender.clone();
    let ended = working.clone();
    let grants = Arc::new(GrantFence::default());
    let notifications = grants.clone();
    let control = Arc::new_cyclic(|weak: &std::sync::Weak<Control>| {
        let weak = weak.clone();
        Control::new(move |event: &StateEvent| {
            if event.active {
                let Some(control) = weak.upgrade() else { return };
                if !notifications.valid(control.epoch()) {
                    // Notify runs OUTSIDE Control's session lock. Reject a stale grant
                    // synchronously before Helper can proceed; recursive event is inactive.
                    control.end(computer::session::Reason::Stopped);
                    return;
                }
            } else { notifications.clear(); }
            let _ = events.emit(STATE_EVENT, event);
            if let Some(item) = events.try_state::<YoloMenuItem>() { let _ = item.0.set_checked(event.yolo); }
            let _ = session.send(Overlay::Session(event.active));
            if !event.active { ended.session_ended(); }
        })
    });
    let runtime = Arc::new(Runtime {
        app: app.clone(), own: OwnWindows::new(), control: control.clone(), working: working.clone(), windows,
        visibility: Mutex::new(Visibility { handles: Vec::new(), dot: false, panel: false, deferred: [false; 2], panel_revision: 0, panel_effects: None }),
        initialized: AtomicBool::new(false), failed: AtomicBool::new(false),
        flight: AtomicBool::new(false), operation: AtomicU64::new(0),
        capturing: AtomicBool::new(false), grants,
    });
    let native = Arc::new(WindowsDesktop::new(runtime.own.clone()));
    let desktop: Arc<dyn Desktop> = Arc::new(capture::AppDesktop { native, runtime: runtime.clone() });
    // Constructing an endpoint does not authorize anything: availability remains false
    // until setup has built all windows, registered them and bound the panic shortcut.
    let endpoint = overlay::build(app).and_then(|window| {
        overlay::run(runtime.clone(), window, messages)?;
        let token = computer::server::new_token();
        let marks = sender.clone();
        let helper = computer::mcp::Helper::new(desktop.clone(), Arc::new(dialogs::NativeDialogs(runtime.clone())),
            Arc::new(SystemClock), control.clone(), token.clone(), std::process::id() as i32)
            .with_glow(move |mark| { let _ = marks.send(Overlay::Mark(mark)); })
            .with_working(working.clone());
        computer::server::start(Arc::new(helper), token).map_err(|_| "Windows computer helper could not start".into())
    }).map_err(|error: String| {
        runtime.fail();
        eprintln!("gentle-dot: Windows computer control is unavailable: {error}");
    }).ok();
    super::watch_timeout(control.clone());
    Computer { control, endpoint, desktop, working, windows: runtime }
}

/// Setup/UI thread only, AFTER Dot and panel creation. Failure keeps native authority
/// unavailable, even though the owner-bound random loopback endpoint may already exist.
pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let computer = app.try_state::<Computer>().ok_or("computer control not initialized")?;
    let runtime = &computer.windows;
    if runtime.failed.load(Ordering::Acquire) { return Err("Windows computer setup failed".into()); }
    let mut handles = Vec::new();
    let mut dot = false;
    let mut panel = false;
    for (label, kind) in [("dot", Kind::Dot), ("panel", Kind::Panel), (super::GLOW_WINDOW, Kind::Glow)] {
        let window = app.get_webview_window(label).ok_or("computer-control window missing")?;
        let handle = window.hwnd().map_err(|_| "computer-control HWND unavailable")?.0 as usize;
        let visible = window.is_visible().map_err(|_| "initial visibility unavailable")?;
        match kind { Kind::Dot => dot = visible, Kind::Panel => panel = visible, Kind::Glow => {} }
        handles.push((handle, kind));
    }
    runtime.own.register(&handles.iter().map(|(handle, _)| *handle).collect::<Vec<_>>())?;
    *runtime.visibility.try_lock().map_err(|_| "window intent unavailable")? = Visibility { handles, dot, panel, deferred: [false; 2], panel_revision: 0, panel_effects: None };
    let panic_runtime = runtime.clone();
    app.global_shortcut().on_shortcut(super::PANIC_SHORTCUT, move |_, _, event| {
        if event.state() == ShortcutState::Pressed { panic_runtime.stop(computer::session::Reason::Panic); }
    }).map_err(|_| "Alt+Shift+Escape is unavailable; Windows computer control remains disabled")?;
    super::set_panic_shortcut_registered(true);
    runtime.initialized.store(true, Ordering::Release);
    Ok(())
}

/// Shell user intent, recorded before ordinary show/hide requests. Working and capture
/// must NOT overwrite it with their temporary native visibility changes.
/// UI-thread caller: false means defer native show AND focus until capture finishes.
/// Hides remain immediate; only explicit Dot/panel shows gain restore eligibility.
pub fn user_visibility(app: &AppHandle, label: &str, visible: bool, explicit: bool) -> bool {
    // Missing bookkeeping state cannot own a capture suspension; preserve ordinary UI.
    let Some(computer) = app.try_state::<Computer>() else { return true };
    let suspended = computer.windows.capturing.load(Ordering::Acquire);
    let stamp = computer.windows.grants.stamp(computer.control.epoch());
    let updated = if let Ok(mut state) = computer.windows.visibility.try_lock() {
        let index = match label {
            "dot" => { state.dot = visible; 0 },
            "panel" => { state.panel = visible; 1 },
            _ => return false,
        };
        state.deferred[index] = visible && suspended;
        if index == 1 && explicit {
            state.panel_revision = state.panel_revision.wrapping_add(1);
            state.panel_effects = (visible && suspended).then(||
                (state.panel_revision, stamp));
        }
        true
    } else { false };
    // Drop even a poisoned try_lock's error/guard before any notification/native UI.
    if !updated { computer.windows.fail(); }
    updated && !suspended
}

fn temporary_panel_target(label: &str, pid: u32, current_pid: u32, owner: u32, current: u32) -> bool {
    label == "panel" && pid != 0 && pid == current_pid && owner != 0 && owner == current
}

/// Working-only suspension, not user intent. Keep the framework's visible bit intact:
/// the matching restoration uses native SW_SHOWNA and cannot reset Tauri's cached bit.
/// The caller and live panel HWND must share the owning UI thread and process.
pub fn hide_panel_temporarily(window: &tauri::WebviewWindow) -> Result<(), String> {
    let _change = computer::win::WindowChange::begin();
    use windows::Win32::{System::Threading::GetCurrentThreadId,
        UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindowVisible, ShowWindow, SW_HIDE}};
    let hwnd = windows::Win32::Foundation::HWND(
        window.hwnd().map_err(|_| "window HWND unavailable")?.0 as *mut std::ffi::c_void);
    let mut pid = 0;
    // SAFETY: read-only metadata; failure/foreign ownership cannot pass the predicate.
    let owner = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let current = unsafe { GetCurrentThreadId() };
    if !temporary_panel_target(window.label(), pid, std::process::id(), owner, current) {
        return Err("temporary panel target unavailable".into());
    }
    // SAFETY: validated live own panel on its owner thread. No lock or activation.
    // ShowWindow returns the previous visibility, not an operation-success Boolean.
    let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
    if unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return Err("temporary panel hide was not retained".into());
    }
    Ok(())
}

pub fn show_without_focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    let _change = computer::win::WindowChange::begin();
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNA};
    // UI-thread caller; HWND remains local and is not sent between threads.
    let hwnd = windows::Win32::Foundation::HWND(
        window.hwnd().map_err(|_| "window HWND unavailable")?.0 as *mut std::ffi::c_void);
    // SAFETY: called only on the owning UI thread with this live Tauri window.
    let _ = unsafe { ShowWindow(hwnd, SW_SHOWNA) };
    if !window.is_visible().map_err(|_| "window visibility unavailable")? {
        return Err("window could not be shown without activation".into());
    }
    Ok(())
}

/// Working restoration respects a subsequent user hide as well as Hide the rose.
pub fn restore_shell_window(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let computer = app.try_state::<Computer>().ok_or("computer control unavailable")?;
    let hwnd = window.hwnd().map_err(|_| "window HWND unavailable")?.0 as usize;
    if computer.windows.desired(hwnd, true)? {
        if computer.windows.capturing.load(Ordering::Acquire) {
            // Working may end during capture. Preserve this eligible restoration,
            // but never show over the live guard or reopen Working-hidden defaults.
            user_visibility(app, window.label(), true, false);
        } else { show_without_focus(window)?; }
    }
    Ok(())
}

pub(super) fn set_yolo(app: &AppHandle, enabled: bool) -> Result<StateEvent, String> {
    let computer = app.try_state::<Computer>().ok_or("Computer control is not ready.")?;
    if enabled && !computer.windows.available() { return Err("Windows computer control is unavailable.".into()); }
    let stamp = computer.windows.grants.stamp(computer.control.epoch());
    let event = computer.control.set_yolo(enabled, SystemClock.now_ms(), &dialogs::NativeDialogs(computer.windows.clone()));
    if enabled && !computer.windows.grants.current(stamp, computer.control.epoch()) {
        // The unchanged shared setter has no atomic prompt commit. Never leave a late
        // Windows confirmation on after Stop/panic; disabling does not ask again.
        return Ok(computer.control.set_yolo(false, SystemClock.now_ms(), &dialogs::NativeDialogs(computer.windows.clone())));
    }
    Ok(event)
}

// AUTHORED_UNEXECUTED: pure coordinator rules, not helper/native runtime proof.
#[cfg(test)]
mod tests {
    use super::*;
    // Pure ownership predicate only; this does not execute native window visibility.
    #[test]
    fn temporary_panel_target_rejects_other_windows_processes_and_threads() {
        assert!(temporary_panel_target("panel", 7, 7, 9, 9));
        for (label, pid, current_pid, owner, current) in [
            ("dot", 7, 7, 9, 9), ("glow", 7, 7, 9, 9), ("", 7, 7, 9, 9),
            ("panel", 0, 0, 9, 9), ("panel", 7, 8, 9, 9),
            ("panel", 7, 7, 0, 0), ("panel", 7, 7, 9, 8),
        ] {
            assert!(!temporary_panel_target(label, pid, current_pid, owner, current));
        }
    }
    #[test]
    fn stop_during_an_idle_grant_invalidates_the_prompt_even_without_a_session_epoch_change() {
        let control = Control::new(|_| {});
        let grants = GrantFence::default();
        let stamp = grants.stamp(control.epoch());
        grants.cancel();
        control.end(computer::session::Reason::Stopped);
        assert_eq!(control.epoch(), stamp.epoch); // shared legacy idle behavior preserved
        assert!(!grants.current(stamp, control.epoch()));
        assert!(!grants.approve(stamp));
        assert!(!grants.valid(control.epoch()));
    }
    #[test]
    fn late_grant_commit_after_stop_cannot_reuse_an_accepted_prompt() {
        let grants = GrantFence::default();
        assert!(grants.approve(grants.stamp(4)));
        assert!(grants.valid(4));
        grants.cancel();
        assert!(!grants.valid(4));
        assert!(!grants.valid(5));
        assert!(grants.approve(grants.stamp(5)));
        assert!(grants.valid(5));
        assert!(!grants.valid(4));
        grants.clear();
        assert!(!grants.valid(5));
    }
    #[test]
    fn user_hides_and_active_working_override_old_visible_snapshots() {
        assert!(restorable(true, false, false));
        assert!(!restorable(false, false, false)); // panel explicitly hidden meanwhile
        assert!(!restorable(true, true, false)); // Working still hides Dot/panel
        assert!(!restorable(true, false, true)); // current Hide the rose choice
    }
    #[test]
    fn capture_input_and_native_prompts_have_nonblocking_exclusive_ownership() {
        let flag = AtomicBool::new(false);
        let first = Flight::acquire(&flag).unwrap();
        assert!(Flight::acquire(&flag).is_err());
        drop(first);
        assert!(Flight::acquire(&flag).is_ok());
    }
}
