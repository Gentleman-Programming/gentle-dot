//! Windows native Desktop seam ONLY. No helper startup, session/grant authority,
//! permission dialogs, Working readiness, endpoint advertising or UI integration.
mod capture;
mod context;
mod identity;
mod input;
mod own_windows;
mod uia;

pub use capture::{display_rect_at, pointer_location};
pub use context::PixelRect;
pub use own_windows::{CapturePreparation, OwnWindows};
pub use uia::focused_frame;

use std::{cell::RefCell, sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex},
    thread::{self, ThreadId}, time::{Duration, Instant}};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsIconic, SetForegroundWindow,
    ShowWindowAsync, SW_RESTORE};
use context::{hwnd, point, Dpi};
use uia::{Automation, FocusFacts, PointFacts};
use super::{blocklist::AppIdentity, coords::Point, risk::{self, AxElement, Focus},
    AppInfo, Capture, Desktop, InputEvent, KeyboardRecipient, Permissions, TypedError};

fn needs_default_facts(event: &InputEvent, focus: &Focus) -> bool {
    let pressable = matches!(focus.element.role.as_str(),
        "AXButton" | "AXMenuButton" | "AXMenuItem" | "AXMenuBarItem" | "AXLink");
    match event {
        InputEvent::Key(key) => key.is_return() || (key.is_space() && pressable),
        InputEvent::Text(text) => text.contains('\n') || (text.contains(' ') && pressable),
        _ => false,
    }
}

fn field_text(event: &InputEvent, focus: &Focus) -> bool {
    matches!(event, InputEvent::Text(text) if !text.chars().any(char::is_control))
        && matches!(focus.element.role.as_str(), "AXTextField" | "AXTextArea" | "AXComboBox")
}

// Query and admission must use the same metadata scope. Keep conservative full
// facts for complex keys/control text/non-fields; ordinary field text cannot
// activate a default and must not enumerate unrelated window buttons each chunk.
fn needs_full_focus_metadata(event: &InputEvent, focus: &Focus) -> bool {
    !field_text(event, focus)
}

/// A single event-aware decision supplies fixed, privacy-safe refusal reasons.
/// Geometry is presentation, never keyboard identity. Complex keys/control text
/// retain conservative metadata checks so confirmed activation cannot change labels.
fn admit_keyboard(expected: &FocusFacts, fresh: &FocusFacts, event: &InputEvent) -> Result<(), &'static str> {
    if expected.window != fresh.window { return Err("window"); }
    if expected.app != fresh.app { return Err("application"); }
    if !matches!((&expected.runtime_id, &fresh.runtime_id),
        (Some(a), Some(b)) if uia::valid_runtime_id(a) && uia::valid_runtime_id(b) && a == b) {
        return Err("element_identity");
    }
    if expected.focus.element.role != fresh.focus.element.role { return Err("element_role"); }
    if needs_default_facts(event, &fresh.focus) && (!expected.default_known || !fresh.default_known) {
        let failed = if !fresh.default_known { &fresh.default_failure } else { &expected.default_failure };
        return Err(failed.map_or("default_unknown", |cause| cause.reason()));
    }
    if expected.focus.is_default_button != fresh.focus.is_default_button { return Err("focused_default"); }
    if needs_full_focus_metadata(event, &fresh.focus) {
        if expected.focus.element.title != fresh.focus.element.title { return Err("element_title"); }
        if expected.focus.element.description != fresh.focus.element.description { return Err("element_description"); }
        if expected.focus.element.value != fresh.focus.element.value { return Err("element_value"); }
        if expected.default_known != fresh.default_known { return Err("default_known"); }
        if expected.focus.default_button != fresh.focus.default_button { return Err("default_button"); }
    }
    // Reuse the helper's classifier, including newline/Space and focused-default
    // semantics. Compare the complete reason, not just whether an action is risky:
    // a confirmation for one activation must not authorize a different one.
    let action_risk = |focus| risk::assess(match event {
        InputEvent::Key(key) if key.is_return() => risk::Act::Return(Some(focus)),
        InputEvent::Key(key) if key.is_space() => risk::Act::Space(Some(focus)),
        InputEvent::Text(text) => risk::Act::Type(text, Some(focus)),
        _ => risk::Act::Other,
    }, None);
    if action_risk(&expected.focus) != action_risk(&fresh.focus) { return Err("action_risk"); }
    Ok(())
}

// This adapter only admits UIA focus in the foreground application's own root.
// Bind upstream's recipient guard to the original assessed facts, not a new query.
fn recipient_matches_focus(recipient: &KeyboardRecipient, facts: &FocusFacts) -> bool {
    recipient.front_pid == facts.app.pid
        && recipient.focused_pid.is_none_or(|pid| pid == facts.app.pid)
}

const OBSERVATION_LIFETIME: Duration = Duration::from_secs(30);
static NEXT_DESKTOP_ID: AtomicU64 = AtomicU64::new(1);
thread_local! {
    // The existing server creates a thread per request. Facts die with that thread,
    // rather than accumulating a permanent worker cache in the shared Desktop.
    static OBSERVATIONS: RefCell<Vec<(u64, Observations)>> = const { RefCell::new(Vec::new()) };
}

#[derive(Clone, PartialEq, Eq)]
struct Owner { at: (i32, i32), window: usize, app: AppIdentity }
#[derive(Clone)]
struct Timed<T> { value: T, at: Instant }
impl<T> Timed<T> {
    fn new(value: T) -> Self { Self { value, at: Instant::now() } }
    fn recent(&self) -> bool { self.at.elapsed() <= OBSERVATION_LIFETIME }
}
#[derive(Clone)]
struct Observations {
    thread: ThreadId,
    owners: Vec<Timed<Owner>>,
    points: Vec<Timed<PointFacts>>,
    focus: Option<Timed<FocusFacts>>,
}
impl Observations {
    fn recheck_focused_owner(&mut self, result: &Result<FocusFacts, String>) {
        // A shared recipient recheck must not overwrite the element/default metadata
        // assessed before confirmation. Failure still invalidates the prior facts.
        if result.is_err() { self.focus = None; }
    }
    fn new(thread: ThreadId) -> Self { Self { thread, owners: Vec::new(), points: Vec::new(), focus: None } }
    fn owner(&self, at: Point) -> Result<&Owner, String> {
        let at = point(at)?;
        self.owners.iter().rev().find(|o| o.recent() && o.value.at == (at.x, at.y))
            .map(|o| &o.value).ok_or_else(|| "pointer owner observation unavailable or expired; retry through helper guards".into())
    }
    fn point(&self, at: Point) -> Result<&PointFacts, String> {
        let at = point(at)?;
        self.points.iter().rev().find(|o| o.recent() && o.value.at == (at.x, at.y))
            .map(|o| &o.value).ok_or_else(|| "accessibility observation unavailable or expired; retry through helper guards".into())
    }
}

/// Threadsafe owned metadata only. Native calls make their own current-thread DPI/COM
/// contexts. This is NOT an alternate public input authority: T3 must put it behind
/// the existing MCP/session/grant/normal-Yolo/Stop path before exposing any capability.
pub struct WindowsDesktop {
    own: OwnWindows,
    inflight: Mutex<()>,
    observation_id: u64,
    unhealthy: AtomicBool,
}
impl WindowsDesktop {
    pub fn new(own: OwnWindows) -> Self {
        Self { own, inflight: Mutex::new(()), observation_id: NEXT_DESKTOP_ID.fetch_add(1, Ordering::Relaxed),
            unhealthy: AtomicBool::new(false) }
    }

    fn remember(&self, update: impl FnOnce(&mut Observations)) {
        OBSERVATIONS.with(|all| {
            let Ok(mut all) = all.try_borrow_mut() else { return };
            if let Some((_, record)) = all.iter_mut().find(|(id, _)| *id == self.observation_id) { update(record); }
            else {
                // Only relevant to a caller constructing many adapters on one thread.
                // Eviction removes facts (refusal), never grants an unknown target.
                if all.len() == 8 { all.remove(0); }
                let mut record = Observations::new(thread::current().id());
                update(&mut record);
                all.push((self.observation_id, record));
            }
        });
    }

    fn observed(&self) -> Result<Observations, String> {
        OBSERVATIONS.with(|all| {
            let all = all.try_borrow().map_err(|_| "native observations busy")?;
            all.iter().find(|(id, o)| *id == self.observation_id && o.thread == thread::current().id())
                .map(|(_, o)| o.clone()).ok_or_else(|| "native preflight observations missing on this helper thread".into())
        })
    }

    fn query_point(&self, at: Point) -> Result<PointFacts, String> {
        let _dpi = Dpi::enter()?;
        identity::normal_desktop()?;
        capture::display_rect_at(at)?; // rejects physical monitor gaps
        Automation::new()?.point(at)
    }

    fn query_focus(&self) -> Result<FocusFacts, String> {
        let _dpi = Dpi::enter()?;
        identity::normal_desktop()?;
        Automation::new()?.focused()
    }

    fn owner_now(at: Point) -> Result<Owner, String> {
        let window = identity::window_at(at)?;
        let at = point(at)?;
        Ok(Owner { at: (at.x, at.y), window: window.0 as usize, app: identity::identity(window)? })
    }

    fn verify_owner(observed: &Observations, at: Point, fresh: &PointFacts) -> Result<(), String> {
        let expected = observed.owner(at)?;
        if expected.window != fresh.window || expected.app != fresh.app {
            return Err("pointer executable owner changed after helper policy checks".into());
        }
        Ok(())
    }

    fn running_windows(&self) -> Result<Vec<(usize, AppIdentity)>, String> {
        identity::normal_desktop()?;
        let mut apps = Vec::new();
        for window in identity::windows()? {
            if identity::visible(window) {
                // Inaccessible/protected apps are not advertised as controllable apps.
                if let Ok(app) = identity::identity(hwnd(window)) { apps.push((window, app)); }
            }
        }
        Ok(apps)
    }

    fn wait_activation(
        mut ready: impl FnMut() -> Result<bool, String>, timeout: Duration, failure: &str,
    ) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        loop {
            if ready()? { return Ok(()); }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() { return Err(failure.into()); }
            thread::sleep(left.min(Duration::from_millis(20)));
        }
    }

    fn activate_window(window: usize, expected: &AppIdentity, restore_minimized: bool) -> Result<(), String> {
        let verify = || -> Result<(), String> {
            identity::normal_desktop()?;
            if identity::identity(hwnd(window))? != *expected {
                return Err("application identity changed before activation".into());
            }
            Ok(())
        };
        verify()?;
        // SW_RESTORE itself requests activation. Send ONE native action, never a
        // later SetForegroundWindow after restoration (Stop may arrive meanwhile).
        let restoring = restore_minimized && unsafe { IsIconic(hwnd(window)) }.as_bool();
        if restoring {
            verify()?;
            if !unsafe { ShowWindowAsync(hwnd(window), SW_RESTORE) }.as_bool() {
                return Err("Windows declined window restoration".into());
            }
        } else if !unsafe { SetForegroundWindow(hwnd(window)) }.as_bool() {
            return Err("Windows declined foreground activation; no focus-lock workaround was attempted".into());
        }
        // Cross-thread activation completes asynchronously. NULL is a documented
        // transition, not permission: only this same verified HWND can succeed.
        Self::wait_activation(|| {
            verify()?;
            let foreground = unsafe { GetForegroundWindow() };
            if foreground.0.is_null() { return Ok(false); }
            if identity::root(foreground)?.0 as usize != window
                || unsafe { IsIconic(hwnd(window)) }.as_bool() { return Ok(false); }
            verify()?;
            Ok(true)
        }, Duration::from_millis(1000), if restoring {
            "application did not restore from minimized state and become foreground"
        } else { "application did not become foreground" })
    }
}

impl Desktop for WindowsDesktop {
    fn permissions(&self) -> Permissions {
        // Availability probes only. Windows has no macOS TCC grants: these fields do
        // NOT grant a session and do not prove that a future capture/SendInput succeeds.
        let normal = identity::normal_desktop().is_ok();
        let configured = self.own.configured() && !self.unhealthy.load(Ordering::Acquire);
        let supported = capture::composition_available();
        Permissions { accessibility: normal && configured && self.query_focus().is_ok(),
            screen_recording: normal && configured && supported, screenshots_supported: supported,
            screenshots_unsupported: super::win::capture_exclusion_reason() }
    }

    fn capture(&self) -> Result<Capture, String> {
        let _inflight = self.inflight.try_lock().map_err(|_| "native operation already in flight or poisoned")?;
        let _dpi = Dpi::enter()?;
        identity::normal_desktop()?;
        let before = Automation::new()?.focused_target()?;
        let image = capture::capture(&self.own)?;
        let after = Automation::new()?.focused_target()?;
        if before != after { return Err("focus changed during capture; screenshot discarded".into()); }
        Ok(image)
    }

    fn post(&self, event: &InputEvent) -> Result<(), String> {
        let _inflight = self.inflight.try_lock().map_err(|_| "native operation already in flight or poisoned")?;
        if self.unhealthy.load(Ordering::Acquire) { return Err("native input disabled after incomplete cleanup".into()); }
        let _dpi = Dpi::enter()?;
        identity::normal_desktop()?;
        self.own.input_ready()?;
        let plan = input::plan(event, capture::virtual_rect()?)?;
        let observed = self.observed()?;
        let automation = Automation::new()?;
        let front = identity::foreground()?;
        let mut final_owners = Vec::new();
        match event {
            InputEvent::Move(at) | InputEvent::Scroll { at, .. } | InputEvent::Click { at, .. } => {
                // Pointer input still needs the protected-focus preflight. Keyboard's
                // full fresh query below already performs this ownership validation.
                let _focus_target = automation.focused_target()?;
                capture::display_rect_at(*at)?;
                let fresh = automation.point(*at)?;
                Self::verify_owner(&observed, *at, &fresh)?;
                if matches!(event, InputEvent::Click { .. }) && observed.point(*at)? != &fresh {
                    return Err("click accessibility facts changed after risk assessment".into());
                }
                final_owners.push((*at, fresh));
            }
            InputEvent::Drag { from, to } => {
                let _focus_target = automation.focused_target()?;
                let first = automation.point(*from)?;
                let last = automation.point(*to)?;
                Self::verify_owner(&observed, *from, &first)?;
                Self::verify_owner(&observed, *to, &last)?;
                if observed.point(*from)? != &first || observed.point(*to)? != &last || first.app != last.app {
                    return Err("drag facts changed or cross-application drag is unsupported".into());
                }
                for at in input::drag_points(*from, *to) {
                    capture::display_rect_at(at)?;
                    let along = automation.point(at)?;
                    if along.app != first.app { return Err("drag path crosses another application's window".into()); }
                }
                final_owners.push((*from, first));
                final_owners.push((*to, last));
            }
            InputEvent::Key(_) | InputEvent::Text(_) => {
                let fresh = automation.focused_for_input(event)?;
                let expected = observed.focus.as_ref().filter(|f| f.recent())
                    .ok_or("focused accessibility observation missing or expired")?;
                admit_keyboard(&expected.value, &fresh, event).map_err(|reason|
                    format!("focused input admission refused (reason={reason})"))?;
            }
        }
        // Final cheap native ownership checks immediately before injection. There is no
        // OS transaction freezing another app's UI: this narrows but cannot eliminate
        // races with human focus changes or a provider changing after the query.
        identity::normal_desktop()?;
        self.own.input_ready()?;
        if identity::foreground()? != front { return Err("foreground changed before input".into()); }
        for (at, facts) in final_owners {
            let owner = Self::owner_now(at)?;
            if owner.window != facts.window || owner.app != facts.app { return Err("pointer owner changed before input".into()); }
        }
        input::send(&plan, &self.unhealthy)
    }

    fn post_typed(&self, event: &InputEvent, recipient: &KeyboardRecipient) -> Result<(), TypedError> {
        let observed = self.observed().map_err(TypedError::Failed)?;
        let focus = observed.focus.as_ref().filter(|f| f.recent()).ok_or(TypedError::NoFocus)?;
        if !recipient_matches_focus(recipient, &focus.value) {
            return Err(TypedError::RecipientChanged);
        }
        // post revalidates the exact HWND/app/runtime id/risk facts and final native
        // ownership before SendInput; do not weaken it to the upstream PID-only test.
        self.post(event).map_err(TypedError::Failed)
    }

    fn list_apps(&self) -> Result<Vec<AppInfo>, String> {
        let foreground = identity::foreground().ok();
        let mut apps: Vec<AppInfo> = Vec::new();
        for (window, id) in self.running_windows()? {
            let active = foreground.is_some_and(|front| front.0 as usize == window);
            if let Some(existing) = apps.iter_mut().find(|app| app.bundle_id == id.bundle_id) { existing.active |= active; }
            else { apps.push(AppInfo { name: id.name, bundle_id: id.bundle_id, active }); }
        }
        apps.sort_by(|a, b| a.bundle_id.cmp(&b.bundle_id));
        Ok(apps)
    }

    fn open_app(&self, name: &str) -> Result<(), String> {
        let _inflight = self.inflight.try_lock().map_err(|_| "native operation already in flight or poisoned")?;
        if name.is_empty() || name.len() > 131072 { return Err("invalid application identifier length".into()); }
        let name = name.trim().to_lowercase();
        let matches: Vec<_> = self.running_windows()?.into_iter().filter(|(_, app)|
            app.name == name || app.bundle_id.as_deref() == Some(name.as_str())).collect();
        let Some((window, app)) = matches.first() else {
            return Err("application is not in the verified running-app list; cold launch is unsupported".into());
        };
        if matches.iter().any(|(_, other)| other.bundle_id != app.bundle_id) {
            return Err("ambiguous application name; use its listed win32 executable identifier".into());
        }
        Self::activate_window(*window, app, true)
    }

    fn element_at(&self, at: Point) -> Vec<AxElement> {
        let result = self.query_point(at);
        let key = point(at).ok().map(|p| (p.x, p.y));
        self.remember(|o| {
            o.points.retain(|p| Some(p.value.at) != key);
            if let Ok(facts) = &result {
                if o.points.len() == 16 { o.points.remove(0); }
                o.points.push(Timed::new(facts.clone()));
            }
        });
        result.map(|facts| facts.chain).unwrap_or_default()
    }

    fn focused_element(&self) -> Option<Focus> {
        let result = self.query_focus();
        self.remember(|o| o.focus = result.as_ref().ok().map(|facts| Timed::new(facts.clone())));
        result.ok().map(|facts| facts.focus)
    }

    fn frontmost_app(&self) -> Option<AppIdentity> {
        let _dpi = Dpi::enter().ok()?;
        identity::normal_desktop().ok()?;
        identity::identity(identity::foreground().ok()?).ok()
    }

    fn focused_app(&self) -> Option<AppIdentity> {
        // Failure must invalidate cached focus too: the trait's Option cannot carry
        // UIA errors, but post never treats that absence as permission to inject.
        let result = self.query_focus();
        self.remember(|o| o.recheck_focused_owner(&result));
        result.ok().map(|facts| facts.app)
    }

    fn window_owner_at(&self, at: Point) -> Option<AppIdentity> {
        let result = (|| {
            let _dpi = Dpi::enter()?;
            identity::normal_desktop()?;
            Self::owner_now(at)
        })();
        let key = point(at).ok().map(|p| (p.x, p.y));
        self.remember(|o| {
            o.owners.retain(|p| Some(p.value.at) != key);
            o.points.retain(|p| Some(p.value.at) != key);
            if let Ok(owner) = &result {
                if o.owners.len() == 16 { o.owners.remove(0); }
                o.owners.push(Timed::new(owner.clone()));
            }
        });
        result.ok().map(|owner| owner.app)
    }

    fn activate(&self, pid: i32) {
        let Ok(_inflight) = self.inflight.try_lock() else { return };
        if let Ok(apps) = self.running_windows() {
            if let Some((window, id)) = apps.iter().find(|(_, id)| id.pid == pid) {
                // Trait cannot return errors: refusal is silent, never reported success.
                let _ = Self::activate_window(*window, id, false);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_recipient_must_match_the_assessed_focus() {
        let facts = typing_focus();
        let recipient = KeyboardRecipient { front_pid: facts.app.pid, focused_pid: None };
        assert!(recipient_matches_focus(&recipient, &facts));
        assert!(!recipient_matches_focus(&KeyboardRecipient { front_pid: 99, ..recipient }, &facts));
        assert!(!recipient_matches_focus(&KeyboardRecipient { focused_pid: Some(99), ..recipient }, &facts));
    }

    #[test]
    fn recipient_recheck_cannot_replace_risk_assessment_facts() {
        let facts = typing_focus();
        let mut observation = Observations::new(thread::current().id());
        observation.focus = Some(Timed::new(facts.clone()));
        let mut changed = facts.clone();
        changed.runtime_id = Some(vec![99]);
        changed.focus.element.title = Some("Pay".into());
        observation.recheck_focused_owner(&Ok(changed));
        assert_eq!(observation.focus.as_ref().unwrap().value, facts);
        observation.recheck_focused_owner(&Err("focus unavailable".into()));
        assert!(observation.focus.is_none());
    }

    // AUTHORED_UNEXECUTED: pure completion probes, not Win32 or native input proof.
    #[test]
    fn activation_wait_accepts_completion_and_preserves_probe_errors() {
        assert!(WindowsDesktop::wait_activation(|| Ok(true), Duration::ZERO, "timeout").is_ok());
        let mut calls = 0;
        let error = WindowsDesktop::wait_activation(|| {
            calls += 1;
            Err("target identity unavailable".into())
        }, Duration::from_secs(1), "timeout").unwrap_err();
        assert_eq!(error, "target identity unavailable");
        assert_eq!(calls, 1);
    }
    #[test]
    fn activation_wait_tolerates_pending_observations_but_never_promotes_timeout() {
        let mut calls = 0;
        assert!(WindowsDesktop::wait_activation(|| {
            calls += 1;
            Ok(calls == 2)
        }, Duration::from_secs(1), "timeout").is_ok());
        assert_eq!(calls, 2);
        assert_eq!(WindowsDesktop::wait_activation(|| Ok(false), Duration::ZERO, "timeout"),
            Err("timeout".into()));
    }

    // Pure policy regressions; authored here, execution requires a Windows Rust runner.
    fn typing_focus() -> FocusFacts {
        FocusFacts { window: 1,
            app: AppIdentity { pid: 42, bundle_id: Some("win32:chrome.exe".into()), name: "chrome".into() },
            focus: Focus { element: AxElement { role: "AXTextField".into(),
                title: Some("Address and search bar".into()), ..Default::default() }, ..Default::default() },
            default_known: true, default_failure: None, frame: Some(PixelRect { x: 10, y: 20, width: 600, height: 30 }),
            runtime_id: Some(vec![42, 1]) }
    }

    fn key(name: &str) -> InputEvent {
        InputEvent::Key(super::super::keys::parse_combo(name).unwrap())
    }

    fn keyboard_events() -> Vec<InputEvent> {
        vec![key("return"), key("space"), key("ctrl+return"), key("shift+space"), key("a"),
            key("ctrl+a"), InputEvent::Text("hello world".into()), InputEvent::Text("a\nb".into()),
            InputEvent::Text("\r".into()), InputEvent::Text("\t".into()), InputEvent::Text("\u{001b}".into())]
    }

    #[test]
    fn metadata_scope_matches_admission_for_text_fields_and_activation() {
        let mut facts = typing_focus();
        for event in keyboard_events() {
            assert_eq!(needs_full_focus_metadata(&event, &facts.focus),
                !field_text(&event, &facts.focus));
        }
        assert!(!needs_full_focus_metadata(&InputEvent::Text("perro en la luna".into()), &facts.focus));
        assert!(needs_full_focus_metadata(&key("return"), &facts.focus));
        assert!(needs_full_focus_metadata(&key("ctrl+l"), &facts.focus));
        facts.focus.element.role = "AXButton".into();
        assert!(needs_full_focus_metadata(&InputEvent::Text("hello".into()), &facts.focus));
    }

    #[test]
    fn printable_field_text_accepts_moving_renamed_fields_and_unrelated_defaults() {
        for role in ["AXTextField", "AXTextArea", "AXComboBox"] {
            let mut before = typing_focus();
            before.focus.element.role = role.into();
            let mut after = before.clone();
            after.frame = None;
            after.focus.element.title = Some("Message: private-title".into());
            after.focus.element.description = Some("private-help".into());
            after.focus.element.value = Some("private-value".into());
            after.default_known = false;
            after.focus.default_button = Some(AxElement { role: "AXButton".into(),
                title: Some("Pay".into()), ..Default::default() });
            for text in ["https://www.google.c", "om", "dog on the moon"] {
                assert_eq!(admit_keyboard(&before, &after, &InputEvent::Text(text.into())), Ok(()));
                assert_eq!(risk::assess(risk::Act::Type(text, Some(&after.focus)), None), None);
            }
            assert!(risk::assess(risk::Act::Type("hello", Some(&after.focus)), Some("buy")).is_some());
        }
    }

    #[test]
    fn every_keyboard_event_requires_the_same_native_app_role_and_opaque_identity() {
        let before = typing_focus();
        let cases: [(fn(&mut FocusFacts), &str); 8] = [
            (|f| f.window += 1, "window"),
            (|f| f.app.pid += 1, "application"),
            (|f| f.app.bundle_id = None, "application"),
            (|f| f.app.name = "other".into(), "application"),
            (|f| f.runtime_id = Some(vec![42, 2]), "element_identity"),
            (|f| f.runtime_id = None, "element_identity"),
            (|f| f.focus.element.role = "AXButton".into(), "element_role"),
            (|f| f.focus.is_default_button = true, "focused_default"),
        ];
        for (change, reason) in cases {
            let mut after = before.clone();
            change(&mut after);
            for event in keyboard_events() {
                assert_eq!(admit_keyboard(&before, &after, &event), Err(reason));
            }
        }
    }

    #[test]
    fn missing_or_invalid_identity_has_no_geometry_fallback_for_any_keyboard_event() {
        for id in [None, Some(vec![]), Some(vec![0; 65])] {
            let mut invalid = typing_focus();
            invalid.runtime_id = id;
            for event in keyboard_events() {
                assert_eq!(admit_keyboard(&invalid, &invalid, &event), Err("element_identity"));
                let valid = typing_focus();
                assert_eq!(admit_keyboard(&valid, &invalid, &event), Err("element_identity"));
                assert_eq!(admit_keyboard(&invalid, &valid, &event), Err("element_identity"));
            }
        }
        for id in [vec![0], vec![-2; 64]] { // opaque values, not interpreted as PID/format
            let mut before = typing_focus();
            before.runtime_id = Some(id);
            let mut after = before.clone();
            after.frame = None;
            for event in keyboard_events() {
                assert_eq!(admit_keyboard(&before, &after, &event), Ok(()));
            }
        }
    }

    #[test]
    fn activation_control_text_and_nonfields_preserve_all_risk_metadata() {
        let before = typing_focus();
        let changes: [(fn(&mut FocusFacts), &str); 5] = [
            (|f| f.focus.element.title = Some("Send".into()), "element_title"),
            (|f| f.focus.element.description = Some("Message".into()), "element_description"),
            (|f| f.focus.element.value = Some("Buy".into()), "element_value"),
            (|f| f.default_known = false, "default_known"),
            (|f| f.focus.default_button = Some(AxElement { role: "AXButton".into(),
                title: Some("Pay".into()), ..Default::default() }), "default_button"),
        ];
        for role in ["AXTextField", "AXButton", "AXLink", "AXGroup"] {
            let mut before = before.clone();
            before.focus.element.role = role.into();
            for event in keyboard_events() {
                if field_text(&event, &before.focus) { continue; }
                for (change, reason) in changes {
                    let mut after = before.clone();
                    change(&mut after);
                    let reason = if reason == "default_known" && needs_default_facts(&event, &after.focus) {
                        "default_unknown"
                    } else { reason };
                    assert_eq!(admit_keyboard(&before, &after, &event), Err(reason));
                }
            }
        }
    }

    #[test]
    fn unknown_default_reports_the_failed_snapshot_cause_without_labels() {
        let known = typing_focus();
        for cause in [uia::DefaultFailure::Query, uia::DefaultFailure::Candidates,
            uia::DefaultFailure::Legacy, uia::DefaultFailure::Ancestry,
            uia::DefaultFailure::Ambiguous, uia::DefaultFailure::Budget] {
            let mut failed = known.clone();
            failed.default_known = false;
            failed.default_failure = Some(cause);
            assert_eq!(admit_keyboard(&known, &failed, &key("return")), Err(cause.reason()));
            assert_eq!(admit_keyboard(&failed, &known, &key("return")), Err(cause.reason()));
            // Unrelated failure must not block literal URL text in the same field.
            let event = InputEvent::Text("https://www.google.com/search?q=perro+en+la+luna&udm=2".into());
            assert_eq!(admit_keyboard(&known, &failed, &event), Ok(()));
        }
    }

    #[test]
    fn return_and_newline_refuse_unknown_defaults_in_either_snapshot() {
        let known = typing_focus();
        let mut unknown = known.clone();
        unknown.default_known = false;
        for event in [key("return"), key("ctrl+return"), InputEvent::Text("hello\n".into())] {
            assert_eq!(admit_keyboard(&known, &unknown, &event), Err("default_unknown"));
            assert_eq!(admit_keyboard(&unknown, &known, &event), Err("default_unknown"));
            assert_eq!(admit_keyboard(&unknown, &unknown, &event), Err("default_unknown"));
        }
        for role in ["AXButton", "AXLink"] {
            let mut unknown = unknown.clone();
            unknown.focus.element.role = role.into();
            for event in [key("space"), key("shift+space"), InputEvent::Text(" ".into())] {
                assert_eq!(admit_keyboard(&unknown, &unknown, &event), Err("default_unknown"));
            }
        }
    }

    #[test]
    fn printable_field_space_cannot_change_a_confirmed_focused_default_activation() {
        let mut before = typing_focus();
        before.focus.is_default_button = true;
        before.focus.element.title = Some("Send".into());
        let mut after = before.clone();
        after.focus.element.title = Some("Pay".into());
        assert_eq!(admit_keyboard(&before, &after, &InputEvent::Text(" ".into())), Err("action_risk"));
        assert_eq!(admit_keyboard(&before, &before, &InputEvent::Text(" ".into())), Ok(()));
    }

    #[test]
    fn confirmed_risky_activation_cannot_switch_to_another_risky_label() {
        for role in ["AXButton", "AXTextField"] {
            let mut before = typing_focus();
            before.focus.element.role = role.into();
            before.focus.element.title = Some("Send message".into());
            before.focus.default_button = Some(AxElement { role: "AXButton".into(),
                title: Some("Pay".into()), ..Default::default() });
            for event in [key("return"), key("space"), InputEvent::Text(" \n".into())] {
                assert_eq!(admit_keyboard(&before, &before, &event), Ok(()));
                let mut after = before.clone();
                after.focus.element.title = Some("Delete message".into());
                assert_eq!(admit_keyboard(&before, &after, &event), Err("element_title"));
                after = before.clone();
                after.focus.default_button.as_mut().unwrap().title = Some("Buy".into());
                assert_eq!(admit_keyboard(&before, &after, &event), Err("default_button"));
            }
        }
    }

    #[test]
    fn frame_and_title_change_reports_only_the_event_relevant_fixed_reason() {
        let before = typing_focus();
        let mut after = before.clone();
        after.frame = None;
        after.focus.element.title = Some("private-title".into());
        assert_eq!(admit_keyboard(&before, &after, &InputEvent::Text("hello".into())), Ok(()));
        assert_eq!(admit_keyboard(&before, &after, &key("return")), Err("element_title"));
        let reason = admit_keyboard(&before, &after, &key("return")).unwrap_err();
        let error = format!("focused input admission refused (reason={reason})");
        assert_eq!(error, "focused input admission refused (reason=element_title)");
        assert!(!error.contains("private-"));
    }

    #[test]
    fn missing_observations_are_not_permission() {
        let observations = Observations::new(thread::current().id());
        assert!(observations.owner(Point { x: 0.0, y: 0.0 }).is_err());
        assert!(observations.point(Point { x: 0.0, y: 0.0 }).is_err());
    }
    #[test]
    fn missing_default_facts_cannot_bypass_return_or_button_space_risk() {
        let button = Focus { element: AxElement { role: "AXButton".into(), ..Default::default() }, ..Default::default() };
        let field = Focus { element: AxElement { role: "AXTextField".into(), ..Default::default() }, ..Default::default() };
        let enter = InputEvent::Key(super::super::keys::parse_combo("return").unwrap());
        let space = InputEvent::Key(super::super::keys::parse_combo("space").unwrap());
        assert!(needs_default_facts(&enter, &field));
        assert!(needs_default_facts(&space, &button));
        assert!(needs_default_facts(&InputEvent::Text(" ".into()), &button));
        assert!(!needs_default_facts(&space, &field));
    }
    #[test]
    fn adapter_is_send_sync_without_native_handle_laundering() {
        fn check<T: Send + Sync>() {}
        check::<WindowsDesktop>();
        check::<OwnWindows>();
    }
}
