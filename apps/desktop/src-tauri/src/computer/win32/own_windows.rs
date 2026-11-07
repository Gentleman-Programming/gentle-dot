//! UI-thread own-window setup and capture-only suspension. T3 must wire this around
//! capture, AFTER the existing Working readiness acknowledgement, not around all input.
use std::{marker::PhantomData, rc::Rc, sync::{Arc, Mutex}};
use windows::Win32::{Foundation::RECT, System::Threading::GetCurrentThreadId, UI::WindowsAndMessaging::{
    GetClassNameW, GetClientRect, GetWindowRect, GetWindowLongW, GWL_STYLE, GWL_EXSTYLE,
    WS_POPUP, WS_VISIBLE, WS_CLIPSIBLINGS,
    WS_EX_NOACTIVATE, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
    GetWindowDisplayAffinity, GetWindowThreadProcessId, SetWindowDisplayAffinity,
    ShowWindow, SW_HIDE, SW_SHOWNA, WDA_EXCLUDEFROMCAPTURE}};
use super::{context::{error, hwnd}, identity};

#[derive(Default)]
struct State {
    windows: Vec<usize>,
    ui_thread: u32,
    active: bool,
    prepared: bool,
    fault: bool,
}

/// Owned integer metadata only. HWNDs and COM interfaces are never made Send/Sync.
/// Clones share registration and one capture-preparation transaction.
#[derive(Clone, Default)]
pub struct OwnWindows(Arc<Mutex<State>>);

fn ui_window(window: usize, thread: u32) -> Result<(), String> {
    if identity::window_pid(hwnd(window))? != std::process::id()
        || identity::root(hwnd(window))?.0 as usize != window
        || unsafe { GetWindowThreadProcessId(hwnd(window), None) } != thread {
        return Err("own top-level window must belong to this process and UI thread".into());
    }
    Ok(())
}

// Pinned framework infrastructure, not application surfaces. See the source provenance
// and trusted lifecycle limitation in docs/windows-computer-control.md.
const TAO_EVENT_CLASS: &str = "Tao Thread Event Target";
const SINGLE_INSTANCE_CLASS: &str = "dev.gentleman.gentle-dot-sic";

fn known_infrastructure_class(name: &str) -> bool {
    name == TAO_EVENT_CLASS || name == SINGLE_INSTANCE_CLASS
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct InfrastructureSample {
    class: String,
    outer: [i32; 4],
    client: [i32; 4],
    style: u32,
    extended: u32,
}

fn zero_extent(rect: [i32; 4]) -> bool {
    // Equality avoids subtraction overflow and rejects inverted or one-zero-axis rects.
    rect[0] == rect[2] && rect[1] == rect[3]
}

fn valid_outer(rect: [i32; 4]) -> bool {
    rect[0] <= rect[2] && rect[1] <= rect[3]
        && (rect[0] == rect[2]) == (rect[1] == rect[3])
}

fn infrastructure_styles(style: u32, extended: u32) -> bool {
    // Only the pinned non-activating layered helper profile, not arbitrary popups.
    // Windows may add CLIPSIBLINGS; no other ordinary/extended style is accepted.
    style & !WS_CLIPSIBLINGS.0 == (WS_POPUP | WS_VISIBLE).0
        && extended == (WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT).0
}

fn infrastructure_pair(first: &InfrastructureSample, second: &InfrastructureSample) -> bool {
    first == second && known_infrastructure_class(&first.class)
        && zero_extent(first.client) && valid_outer(first.outer)
        && infrastructure_styles(first.style, first.extended)
}

fn complete_class(buffer: &[u16], length: i32) -> Option<String> {
    let length = usize::try_from(length).ok()?;
    if buffer.len() < 2 { return None; }
    if length == 0 || length >= buffer.len() - 1 { return None; }
    if buffer[length] != 0 || buffer[..length].contains(&0) { return None; }
    String::from_utf16(&buffer[..length]).ok()
}

fn infrastructure_sample(window: usize, thread: u32) -> Option<InfrastructureSample> {
    // Validate against the REGISTERING UI thread, never the capture worker's thread.
    ui_window(window, thread).ok()?;
    let mut class = [u16::MAX; 256];
    // SAFETY: read-only metadata on a revalidated live HWND, bounded UTF-16 output.
    let length = unsafe { GetClassNameW(hwnd(window), &mut class) };
    let class = complete_class(&class, length)?;
    if !known_infrastructure_class(&class) { return None; }
    let (mut outer, mut client) = (RECT::default(), RECT::default());
    // SAFETY: read-only queries with valid output pointers. Failure never means empty.
    unsafe { GetWindowRect(hwnd(window), &mut outer) }.ok()?;
    unsafe { GetClientRect(hwnd(window), &mut client) }.ok()?;
    // SAFETY: read-only 32-bit style queries on the same validated own HWND.
    // A zero/failed query cannot match the required nonzero helper style profile.
    let style = unsafe { GetWindowLongW(hwnd(window), GWL_STYLE) } as u32;
    let extended = unsafe { GetWindowLongW(hwnd(window), GWL_EXSTYLE) } as u32;
    ui_window(window, thread).ok()?;
    Some(InfrastructureSample { class,
        outer: [outer.left, outer.top, outer.right, outer.bottom],
        client: [client.left, client.top, client.right, client.bottom], style, extended })
}

fn capture_infrastructure(window: usize, thread: u32) -> bool {
    let Some(first) = infrastructure_sample(window, thread) else { return false };
    let Some(second) = infrastructure_sample(window, thread) else { return false };
    // Two samples are NOT an atomic GUI freeze. Trust only the pinned framework
    // helper lifecycle, rechecking at EVERY existing compositor/pixel-readback fence.
    infrastructure_pair(&first, &second)
}

impl OwnWindows {
    pub fn new() -> Self { Self::default() }

    /// UI thread only. Replace the full live Dot/panel/glow top-level HWND list.
    /// New/recreated own windows require registration again. No startup is performed.
    pub fn register(&self, windows: &[usize]) -> Result<(), String> {
        if windows.is_empty() || windows.len() > 16 { return Err("register 1 to 16 own windows".into()); }
        let thread = unsafe { GetCurrentThreadId() };
        let mut unique = windows.to_vec();
        unique.sort_unstable();
        unique.dedup();
        if unique.len() != windows.len() { return Err("duplicate own window registration".into()); }
        for window in &unique {
            ui_window(*window, thread)?;
            // SAFETY: live own-process top-level HWND, executing on its owner thread.
            // Affinity is defense in depth. Readback is NOT proof of true exclusion on
            // old Windows; capture also requires invisibility + compositor synchronization.
            unsafe { SetWindowDisplayAffinity(hwnd(*window), WDA_EXCLUDEFROMCAPTURE) }
                .map_err(|e| error("own-window capture affinity", e))?;
            let mut affinity = 0;
            unsafe { GetWindowDisplayAffinity(hwnd(*window), &mut affinity) }
                .map_err(|e| error("own-window affinity query", e))?;
            if affinity != WDA_EXCLUDEFROMCAPTURE.0 { return Err("own-window affinity was not retained".into()); }
        }
        let mut state = self.0.try_lock().map_err(|_| "own-window state busy or poisoned")?;
        if state.active { return Err("cannot replace windows during capture preparation".into()); }
        *state = State { windows: unique, ui_thread: thread, ..Default::default() };
        Ok(())
    }

    pub(super) fn configured(&self) -> bool {
        let snapshot = self.0.try_lock().ok().and_then(|s| {
            (!s.windows.is_empty() && !s.fault).then(|| (s.windows.clone(), s.ui_thread))
        });
        snapshot.is_some_and(|(windows, thread)| windows.iter().all(|window| {
            if ui_window(*window, thread).is_err() { return false; }
            let mut affinity = 0;
            unsafe { GetWindowDisplayAffinity(hwnd(*window), &mut affinity) }.is_ok()
                && affinity == WDA_EXCLUDEFROMCAPTURE.0
        }))
    }

    pub(super) fn input_ready(&self) -> Result<(), String> {
        {
            let state = self.0.try_lock().map_err(|_| "own-window state busy or poisoned")?;
            if state.windows.is_empty() || state.fault || state.active {
                return Err("own windows unavailable or capture-only suspension still active".into());
            }
        }
        if !self.configured() { return Err("own-window registration is no longer live".into()); }
        Ok(())
    }

    /// UI thread only. Hides ONLY registered own windows which were visible. Does not
    /// disable glow globally or replace Working readiness. Keep guard alive until the
    /// worker's capture has returned, then call finish on the UI thread before input.
    pub fn begin_capture(&self) -> Result<CapturePreparation, String> {
        self.prepare(None)
    }

    /// UI-thread integration variant. Install BEFORE any hide, so even a failure inside
    /// preparation consults current desired visibility on Drop. The callback must not
    /// infer intent from capture-hidden native visibility. Lookup failure hides/refuses
    /// restoration and faults this registry; it never falls back to stale showing.
    pub fn begin_capture_with_restore(
        &self,
        desired: impl Fn(usize, bool) -> Result<bool, String> + 'static,
    ) -> Result<CapturePreparation, String> {
        self.prepare(Some(Box::new(desired)))
    }

    fn prepare(&self, desired: Option<DesiredVisibility>) -> Result<CapturePreparation, String> {
        let thread = unsafe { GetCurrentThreadId() };
        let windows = {
            let mut state = self.0.try_lock().map_err(|_| "own-window state busy or poisoned")?;
            if state.active || state.fault || state.windows.is_empty() || state.ui_thread != thread {
                return Err("capture preparation requires registered windows on their UI thread".into());
            }
            for window in &state.windows { ui_window(*window, thread)?; }
            state.active = true;
            state.windows.clone()
        };
        let restore = windows.into_iter().map(|window| (window, identity::visible(window)))
            .filter(|(_, visible)| *visible || desired.is_some()).collect();
        let guard = CapturePreparation { registry: self.clone(), restore, thread,
            desired, apply: restore_window, finished: false, _thread: PhantomData };
        for &(window, was_visible) in &guard.restore {
            if was_visible || guard.desired.is_some() {
                // Initially hidden entries are candidates only for explicit deferred
                // intent. Never infer a show request from registration or Working.
                if !was_visible { continue; }
                // SAFETY: owned, live, same-thread top-level window checked above.
                // Return value is PREVIOUS visibility, not success; inspect visibility.
                let _ = unsafe { ShowWindow(hwnd(window), SW_HIDE) };
                if identity::visible(window) { return Err("own window could not be hidden for capture".into()); }
            }
        }
        {
            let mut state = self.0.try_lock().map_err(|_| "own-window state busy or poisoned")?;
            state.prepared = true;
        }
        self.verify_capture_hidden()?;
        Ok(guard)
    }

    /// Called before/after pixel readback. Refuse an unknown newly visible own window,
    /// rather than claiming registration of Dot/panel/glow covers every future HWND.
    pub(super) fn verify_capture_hidden(&self) -> Result<(), String> {
        let (windows, thread) = {
            let state = self.0.try_lock().map_err(|_| "own-window state busy or poisoned")?;
            if !state.active || !state.prepared || state.fault { return Err("capture-only own-window preparation is required".into()); }
            (state.windows.clone(), state.ui_thread)
        };
        for &window in &windows {
            ui_window(window, thread)?;
            if identity::visible(window) { return Err("registered own window became visible during capture".into()); }
        }
        for window in identity::windows()? {
            if identity::visible(window) && identity::window_pid(hwnd(window))? == std::process::id() {
                if !windows.contains(&window) && capture_infrastructure(window, thread) { continue; }
                // Bounded metadata only, after own-PID filtering; never window content.
                let owner_thread = unsafe { GetWindowThreadProcessId(hwnd(window), None) };
                return Err(format!("visible own window prevents capture exclusion: hwnd=0x{window:x}, thread={owner_thread}, registered={}", windows.contains(&window)));
            }
        }
        Ok(())
    }
}

type DesiredVisibility = Box<dyn Fn(usize, bool) -> Result<bool, String>>;

fn restore_window(window: usize, thread: u32, visible: bool) -> Result<(), String> {
    ui_window(window, thread)?;
    // SAFETY: revalidated same-thread own top-level window. Never activates it.
    let _ = unsafe { ShowWindow(hwnd(window), if visible { SW_SHOWNA } else { SW_HIDE }) };
    if identity::visible(window) != visible {
        return Err("own-window desired visibility was not retained".into());
    }
    Ok(())
}

/// !Send/!Sync: restoration must execute on the registering UI thread. No HWND is
/// retained as a native lifetime guarantee; every use revalidates liveness and own PID.
pub struct CapturePreparation {
    registry: OwnWindows,
    restore: Vec<(usize, bool)>,
    desired: Option<DesiredVisibility>,
    // Private native boundary also permits policy/lifecycle unit tests without HWNDs.
    apply: fn(usize, u32, bool) -> Result<(), String>,
    thread: u32,
    finished: bool,
    _thread: PhantomData<Rc<()>>,
}
impl CapturePreparation {
    pub fn finish(mut self) -> Result<(), String> {
        let result = self.restore_windows();
        self.finished = true;
        result
    }

    fn restore_windows(&mut self) -> Result<(), String> {
        let mut failed = false;
        // Disable capture before making a window visible. No lock crosses a native UI
        // call, and no mutex wait can deadlock a worker against this UI thread.
        if let Ok(mut state) = self.registry.0.try_lock() {
            state.prepared = false;
        } else { failed = true; }
        let mut applied = Vec::new();
        for (window, was_visible) in self.restore.iter().rev() {
            // No registry/coordinator lock crosses the policy or a native UI callback.
            let result = (|| {
                let Some(desired) = self.desired.as_ref() else {
                    // Compatibility: legacy begin_capture restores its snapshot.
                    return (self.apply)(*window, self.thread, true);
                };
                let visible = desired(*window, *was_visible)?;
                (self.apply)(*window, self.thread, visible)?;
                // Native showing can reenter UI callbacks (including Stop). Reconcile
                // once against NEW intent; repeated instability hides/faults, not loops.
                let now = desired(*window, *was_visible)?;
                if now != visible {
                    (self.apply)(*window, self.thread, now)?;
                    if desired(*window, *was_visible)? != now { return Err("window intent changed during restoration".into()); }
                }
                applied.push((*window, *was_visible, now));
                Ok(())
            })();
            if result.is_err() {
                failed = true;
                if self.desired.is_some() { let _ = (self.apply)(*window, self.thread, false); }
            }
        }
        // Another window's native restoration may reenter and change an earlier
        // window's intent. Detect cross-window instability too; never retry showing.
        if let Some(desired) = self.desired.as_ref() {
            failed |= applied.iter().any(|(window, was_visible, visible)|
                desired(*window, *was_visible).ok() != Some(*visible));
            if failed {
                for (window, _) in &self.restore { let _ = (self.apply)(*window, self.thread, false); }
            }
        }
        if let Ok(mut state) = self.registry.0.try_lock() {
            state.active = false;
            state.fault |= failed;
        } else { failed = true; }
        if failed { Err("own-window restoration incomplete; native adapter must remain unavailable".into()) }
        else { Ok(()) }
    }
}
impl Drop for CapturePreparation {
    fn drop(&mut self) {
        if !self.finished { let _ = self.restore_windows(); }
    }
}

// AUTHORED_UNEXECUTED: policy/guard lifecycle only, not native HWND behavior.
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    thread_local! {
        static INTENT: Cell<bool> = const { Cell::new(true) };
        static APPLIED: RefCell<Vec<bool>> = const { RefCell::new(Vec::new()) };
    }

    fn guard(desired: Option<DesiredVisibility>, expect_show: bool) -> CapturePreparation {
        fn hidden(_: usize, _: u32, show: bool) -> Result<(), String> {
            if show { Err("stale showing".into()) } else { Ok(()) }
        }
        fn shown(_: usize, _: u32, show: bool) -> Result<(), String> {
            if show { Ok(()) } else { Err("legacy restoration lost".into()) }
        }
        let registry = OwnWindows::new();
        *registry.0.lock().unwrap() = State { active: true, prepared: true, ..Default::default() };
        CapturePreparation { registry, restore: vec![(1, true)], desired,
            apply: if expect_show { shown } else { hidden }, thread: 0,
            finished: false, _thread: PhantomData }
    }

    // AUTHORED_UNEXECUTED: pure classification/decoding, not native HWND validation.
    #[test]
    fn infrastructure_requires_exact_stable_empty_client_helper_profile() {
        for class in [TAO_EVENT_CLASS, SINGLE_INSTANCE_CLASS] {
            let sample = InfrastructureSample { class: class.into(), outer: [0; 4], client: [0; 4],
                style: 0x94000000, extended: 0x080800a0 };
            let mut observed = sample.clone();
            observed.outer = [0, 0, 16, 16];
            assert!(infrastructure_pair(&observed, &observed));
            for (style, extended) in [(0, sample.extended), (sample.style, 0),
                (sample.style | 0x00c00000, sample.extended),
                (sample.style, sample.extended | 0x00000008)] {
                let mut unexpected = observed.clone();
                unexpected.style = style;
                unexpected.extended = extended;
                assert!(!infrastructure_pair(&unexpected, &unexpected));
                assert!(!infrastructure_pair(&observed, &unexpected));
            }
            assert!(infrastructure_pair(&sample, &sample));
            for rect in [[0, 0, 1, 0], [0, 0, 0, 1], [0, 0, -1, 0], [0, 0, 0, -1]] {
                let mut changed = sample.clone();
                changed.outer = rect;
                assert!(!infrastructure_pair(&changed, &changed));
                changed = sample.clone();
                changed.client = rect;
                assert!(!infrastructure_pair(&changed, &changed));
            }
            let mut moved = sample.clone();
            moved.outer = [1; 4];
            assert!(!infrastructure_pair(&sample, &moved));
            let mut changed_class = sample.clone();
            changed_class.class = "Tauri Window".into();
            assert!(!infrastructure_pair(&changed_class, &changed_class));
            changed_class.class = "Unknown".into();
            assert!(!infrastructure_pair(&changed_class, &changed_class));
            changed_class.class = if class == TAO_EVENT_CLASS { SINGLE_INSTANCE_CLASS } else { TAO_EVENT_CLASS }.into();
            assert!(!infrastructure_pair(&sample, &changed_class));
        }
    }

    #[test]
    fn class_decoding_rejects_failed_truncated_unterminated_and_invalid_utf16() {
        assert_eq!(complete_class(&[65, 0, 65535], 1), Some("A".into()));
        for length in [-1, 0, 2, 3, 255] {
            assert_eq!(complete_class(&[65, 0, 65535], length), None);
        }
        assert_eq!(complete_class(&[], 1), None);
        assert_eq!(complete_class(&[65, 66, 65535], 1), None);
        assert_eq!(complete_class(&[0, 0, 65535], 1), None);
        assert_eq!(complete_class(&[0xd800, 0, 65535], 1), None);
    }

    #[test]
    fn explicit_finish_consults_current_intent_not_the_preparation_snapshot() {
        let desired = Rc::new(Cell::new(true));
        let current = desired.clone();
        let capture = guard(Some(Box::new(move |_, _| Ok(current.get()))), false);
        let registry = capture.registry.clone();
        desired.set(false); // Stop/user hide after preparation
        capture.finish().unwrap();
        let state = registry.0.lock().unwrap();
        assert!(!state.active && !state.prepared && !state.fault);
    }

    #[test]
    fn explicit_reopen_after_preparation_is_not_lost() {
        let desired = Rc::new(Cell::new(false));
        let current = desired.clone();
        let capture = guard(Some(Box::new(move |_, _| Ok(current.get()))), true);
        desired.set(true); // explicit user reopen, not an observation of hidden HWNDs
        capture.finish().unwrap();
    }

    #[test]
    fn initially_hidden_window_requires_explicit_deferred_show_not_just_registration() {
        for requested in [false, true] {
            let pending = Rc::new(Cell::new(false));
            let current = pending.clone();
            let mut capture = guard(Some(Box::new(move |_, was_visible|
                Ok(was_visible || current.get()))), requested);
            capture.restore[0].1 = false;
            pending.set(requested);
            capture.finish().unwrap();
        }
    }

    #[test]
    fn deferred_show_then_user_hide_does_not_resurrect_initially_hidden_window() {
        let pending = Rc::new(Cell::new(true));
        let current = pending.clone();
        let mut capture = guard(Some(Box::new(move |_, was_visible|
            Ok(was_visible || current.get()))), false);
        capture.restore[0].1 = false;
        pending.set(false);
        capture.finish().unwrap();
    }

    #[test]
    fn preparation_error_drop_uses_current_policy_before_guard_can_be_returned() {
        let desired = Rc::new(Cell::new(true));
        let current = desired.clone();
        let capture = guard(Some(Box::new(move |_, _| Ok(current.get()))), false);
        let registry = capture.registry.clone();
        let fail_during_preparation = move || -> Result<CapturePreparation, String> {
            let _capture = capture;
            desired.set(false);
            Err("preparation failed before returning guard".into())
        };
        assert!(fail_during_preparation().is_err());
        let state = registry.0.lock().unwrap();
        assert!(!state.active && !state.prepared && !state.fault);
    }

    #[test]
    fn failed_desired_lookup_never_shows_and_faults_on_finish_and_drop() {
        for explicit in [true, false] {
            let capture = guard(Some(Box::new(|_, _| Err("intent unavailable".into()))), false);
            let registry = capture.registry.clone();
            if explicit { assert!(capture.finish().is_err()); } else { drop(capture); }
            let state = registry.0.lock().unwrap();
            assert!(state.fault && !state.active && !state.prepared);
        }
    }

    #[test]
    fn reentrant_stop_during_show_is_reconciled_before_completion() {
        fn apply(_: usize, _: u32, show: bool) -> Result<(), String> {
            APPLIED.with(|values| values.borrow_mut().push(show));
            if show { INTENT.with(|intent| intent.set(false)); }
            Ok(())
        }
        INTENT.with(|intent| intent.set(true));
        APPLIED.with(|values| values.borrow_mut().clear());
        let mut capture = guard(Some(Box::new(|_, _| Ok(INTENT.with(Cell::get)))), true);
        capture.apply = apply;
        capture.finish().unwrap();
        APPLIED.with(|values| assert_eq!(*values.borrow(), vec![true, false]));
    }

    #[test]
    fn legacy_finish_and_drop_still_restore_previously_visible_windows() {
        for explicit in [true, false] {
            let capture = guard(None, true);
            let registry = capture.registry.clone();
            if explicit { capture.finish().unwrap(); } else { drop(capture); }
            assert!(!registry.0.lock().unwrap().fault);
        }
    }
}
