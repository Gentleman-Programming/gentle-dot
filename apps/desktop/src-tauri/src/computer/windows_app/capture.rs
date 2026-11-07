//! The capture guard NEVER leaves the UI thread. Only owned ticket metadata crosses
//! threads; pixel acquisition and UIA observations remain on the MCP request worker.
use super::*;
use crate::computer::{AppInfo, Capture, InputEvent, KeyboardRecipient, Permissions, TypedError, blocklist::AppIdentity,
    coords::Point, risk::{AxElement, Focus}, win32::CapturePreparation};
use std::{cell::RefCell, sync::mpsc};

thread_local! {
    static PREPARATION: RefCell<Option<(u64, CapturePreparation)>> = const { RefCell::new(None) };
}
static NEXT_CAPTURE: AtomicU64 = AtomicU64::new(1);

fn matching_ticket(current: Option<u64>, id: u64, required: bool) -> Result<(), &'static str> {
    match current {
        Some(current) if current != id => Err("capture guard ticket mismatch"),
        None if required => Err("capture guard missing at completion"),
        _ => Ok(()),
    }
}

fn finish_on_ui(id: u64, runtime: &Runtime, required: bool) -> Result<(), String> {
    let guard = PREPARATION.with(|slot| {
        let mut slot = slot.try_borrow_mut().map_err(|_| "capture guard is reentrant")?;
        matching_ticket(slot.as_ref().map(|(id, _)| *id), id, required)?;
        Ok(slot.take().map(|(_, guard)| guard))
    }).map_err(str::to_string)?;
    // Neither a RefCell borrow nor a coordinator/registry lock spans restoration.
    // A cancelled ticket with no guard owns no suspension flag. In particular it
    // must not clear a newer preparation's flag during native/UI reentrancy.
    let Some(guard) = guard else { return Ok(()) };
    let restored = guard.finish();
    let effects = runtime.end_capture(restored.is_ok());
    let result = restored.and(effects);
    if result.is_err() { runtime.fail(); }
    result
}

struct Ticket {
    id: u64,
    runtime: Arc<Runtime>,
    cancelled: Arc<AtomicBool>,
    completed: bool,
}
impl Ticket {
    fn new(runtime: Arc<Runtime>) -> Self {
        Self { id: NEXT_CAPTURE.fetch_add(1, Ordering::Relaxed), runtime,
            cancelled: Arc::new(AtomicBool::new(false)), completed: false }
    }

    fn prepare(&self) -> Result<(), String> {
        let (reply, answer) = mpsc::channel();
        let rt = self.runtime.clone();
        let cancelled = self.cancelled.clone();
        let id = self.id;
        self.runtime.app.run_on_main_thread(move || {
            let result = (|| {
                if cancelled.load(Ordering::Acquire) { return Err("capture preparation cancelled".into()); }
                rt.require_operation()?;
                if !rt.working_operation() { return Err("Windows Working readiness is unavailable".into()); }
                let glow = rt.app.get_webview_window(super::super::GLOW_WINDOW)
                    .ok_or("Windows Working indicator missing")?;
                if !glow.is_visible().map_err(|_| "Windows Working visibility unavailable")? {
                    return Err("Windows Working indicator hidden before capture".into());
                }
                let empty = PREPARATION.with(|slot| slot.try_borrow().map(|slot| slot.is_none()).unwrap_or(false));
                if !empty || rt.capturing.swap(true, Ordering::AcqRel) {
                    return Err("Windows capture is already prepared".into());
                }
                let desired = rt.clone();
                // Policy is installed INSIDE preparation, BEFORE the first native hide.
                let preparation = rt.own.begin_capture_with_restore(move |handle, was_visible| desired.capture_desired(handle, was_visible));
                let guard = match preparation {
                    Ok(guard) => guard,
                    Err(error) => { let _ = rt.end_capture(false); return Err(error); }
                };
                if cancelled.load(Ordering::Acquire) || rt.require_operation().is_err() {
                    // Same UI thread; capture never began. Drop consults current intent.
                    drop(guard);
                    let _ = rt.end_capture(false);
                    return Err("Windows capture stopped before pixel acquisition".into());
                }
                let stored = PREPARATION.with(|slot| {
                    let mut slot = slot.try_borrow_mut().map_err(|_| "capture guard is reentrant")?;
                    *slot = Some((id, guard));
                    Ok::<(), String>(())
                });
                if stored.is_err() { let _ = rt.end_capture(false); }
                stored?;
                Ok(())
            })();
            if reply.send(result).is_err() {
                // Timed-out requester never starts pixel acquisition.
                if finish_on_ui(id, &rt, false).is_err() { rt.fail(); }
            }
        }).map_err(|_| "Windows capture UI preparation could not be queued")?;
        answer.recv_timeout(READY_TIMEOUT).map_err(|_| "Windows capture UI preparation timed out")?
    }

    fn finish(mut self) -> Result<(), String> {
        self.completed = true;
        let (reply, answer) = mpsc::channel();
        let rt = self.runtime.clone();
        let id = self.id;
        if self.runtime.app.run_on_main_thread(move || {
            let result = finish_on_ui(id, &rt, true);
            if result.is_err() { rt.fail(); }
            let _ = reply.send(result);
        }).is_err() {
            self.runtime.fail();
            return Err("Windows capture restoration could not be queued; control disabled".into());
        }
        match answer.recv_timeout(READY_TIMEOUT) {
            Ok(result) => result,
            Err(_) => {
                // Keep the UI-owned guard alive until that queued restoration executes.
                // Disable all later native actions rather than guessing restoration worked.
                self.runtime.fail();
                Err("Windows capture restoration timed out; control disabled".into())
            }
        }
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if self.completed { return; }
        self.cancelled.store(true, Ordering::Release);
        let rt = self.runtime.clone();
        let id = self.id;
        // On preparation error/timeout or capture unwind, acquisition has not started
        // or has already unwound. Never finish a guard while its capture is still running.
        if self.runtime.app.run_on_main_thread(move || {
            if finish_on_ui(id, &rt, false).is_err() { rt.fail(); }
        }).is_err() { self.runtime.fail(); }
    }
}

// Injected seam for forwarding only; the caller must hold the app-owned fences.
fn post_native(desktop: &dyn Desktop, event: &InputEvent, recipient: Option<&KeyboardRecipient>) -> Result<(), TypedError> {
    match recipient {
        Some(recipient) => desktop.post_typed(event, recipient),
        None => desktop.post(event).map_err(TypedError::Failed),
    }
}

pub(super) struct AppDesktop {
    pub(super) native: Arc<WindowsDesktop>,
    pub(super) runtime: Arc<Runtime>,
}
impl AppDesktop {
    // Both pointer posts and recipient-bound keyboard posts pass the same app-owned
    // Working/epoch/visibility fences, on the same request worker.
    fn guarded_post(&self, event: &InputEvent, recipient: Option<&KeyboardRecipient>) -> Result<(), TypedError> {
        let _flight = Flight::acquire(&self.runtime.flight).map_err(TypedError::Failed)?;
        let ready = (|| -> Result<(), String> {
            let epoch = self.runtime.control.epoch();
            self.runtime.require_epoch(epoch)?;
            if !self.runtime.working_operation() || self.runtime.capturing.load(Ordering::Acquire) {
                return Err("Windows Working indicator is not ready for input".into());
            }
            let glow = self.runtime.app.get_webview_window(super::super::GLOW_WINDOW)
                .ok_or("Windows Working indicator is missing")?;
            if !glow.is_visible().map_err(|_| "Windows Working visibility unavailable")? {
                return Err("Windows Working indicator is hidden".into());
            }
            self.runtime.require_epoch(epoch)
        })();
        ready.map_err(TypedError::Failed)?;
        // No cancellation token exists inside native posting: a bounded already-
        // inserted batch may finish. All native target/UIA/cleanup checks remain.
        post_native(self.native.as_ref(), event, recipient)
    }
}

impl Desktop for AppDesktop {
    fn permissions(&self) -> Permissions {
        if !self.runtime.available() {
            return Permissions { accessibility: false, screen_recording: false, screenshots_supported: false,
                screenshots_unsupported: None };
        }
        self.native.permissions()
    }
    fn capture(&self) -> Result<Capture, String> {
        let _flight = Flight::acquire(&self.runtime.flight)?;
        self.runtime.require_operation()?;
        let epoch = self.runtime.control.epoch();
        let ticket = Ticket::new(self.runtime.clone());
        ticket.prepare()?;
        // Runs on this SAME helper worker: do not move native observations/COM objects
        // to the UI thread or finish/drop its guard before acquisition returns.
        let result = self.runtime.require_epoch(epoch).and_then(|()| self.native.capture());
        ticket.finish()?;
        self.runtime.require_epoch(epoch)?;
        result
    }
    fn post(&self, event: &InputEvent) -> Result<(), String> {
        self.guarded_post(event, None).map_err(|error| error.message(false))
    }
    fn post_typed(&self, event: &InputEvent, recipient: &KeyboardRecipient) -> Result<(), TypedError> {
        self.guarded_post(event, Some(recipient))
    }
    fn list_apps(&self) -> Result<Vec<AppInfo>, String> { self.native.list_apps() }
    fn open_app(&self, name: &str) -> Result<(), String> {
        let _flight = Flight::acquire(&self.runtime.flight)?;
        let epoch = self.runtime.control.epoch();
        self.runtime.require_epoch(epoch)?;
        if !self.runtime.working_operation() || self.runtime.capturing.load(Ordering::Acquire) {
            return Err("Windows Working indicator is not ready".into());
        }
        let glow = self.runtime.app.get_webview_window(super::super::GLOW_WINDOW)
            .ok_or("Windows Working indicator missing")?;
        if !glow.is_visible().map_err(|_| "Windows Working visibility unavailable")? {
            return Err("Windows Working indicator hidden".into());
        }
        self.runtime.require_epoch(epoch)?;
        self.native.open_app(name)
    }
    // Delegation stays on the request thread: unknown observations remain refusals,
    // never empty-chain permission shortcuts. No core policy is replaced here.
    fn element_at(&self, at: Point) -> Vec<AxElement> { self.native.element_at(at) }
    fn focused_element(&self) -> Option<Focus> { self.native.focused_element() }
    fn frontmost_app(&self) -> Option<AppIdentity> { self.native.frontmost_app() }
    fn focused_app(&self) -> Option<AppIdentity> { self.native.focused_app() }
    fn window_owner_at(&self, at: Point) -> Option<AppIdentity> { self.native.window_owner_at(at) }
    fn activate(&self, pid: i32) {
        if let Ok(_flight) = Flight::acquire(&self.runtime.flight) {
            if self.runtime.require_operation().is_ok() && !self.runtime.capturing.load(Ordering::Acquire) {
                self.native.activate(pid);
            }
        }
    }
}

// AUTHORED_UNEXECUTED: ticket matching only, not UI scheduling/capture execution.
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keyboard_forwarding_keeps_the_recipient_and_refusal() {
        let desktop = crate::computer::fake::FakeDesktop::default();
        let recipient = KeyboardRecipient { front_pid: 42, focused_pid: None };
        let event = InputEvent::Text("fixture".into());
        assert_eq!(post_native(&desktop, &event, Some(&recipient)), Ok(()));
        assert_eq!(*desktop.typed_posts.lock().unwrap(), vec![(event.clone(), recipient)]);
        *desktop.refuse_typed_at.lock().unwrap() = Some((2, TypedError::RecipientChanged));
        assert_eq!(post_native(&desktop, &event, Some(&recipient)), Err(TypedError::RecipientChanged));
        assert_eq!(desktop.events().len(), 1);
    }
    #[test]
    fn ordinary_pointer_forwarding_keeps_the_existing_post_path() {
        let desktop = crate::computer::fake::FakeDesktop::default();
        let event = InputEvent::Move(Point { x: 10.0, y: 20.0 });
        assert_eq!(post_native(&desktop, &event, None), Ok(()));
        assert_eq!(desktop.events(), vec![event]);
        assert!(desktop.typed_posts.lock().unwrap().is_empty());
    }
    #[test]
    fn stale_cleanup_cannot_take_another_capture_guard() {
        assert!(matching_ticket(Some(8), 7, false).is_err());
        assert!(matching_ticket(Some(8), 7, true).is_err());
        assert!(matching_ticket(Some(8), 8, true).is_ok());
    }
    #[test]
    fn successful_capture_requires_its_guard_but_cancelled_preparation_may_have_none() {
        assert!(matching_ticket(None, 7, true).is_err());
        assert!(matching_ticket(None, 7, false).is_ok());
    }
}
