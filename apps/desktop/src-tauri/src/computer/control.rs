//! The session shared by the MCP server and the app (Stop button, tray item, panic shortcut,
//! timeout watcher). Every transition is reported to `notify` (the `computer://state` event).
//! Yolo mode (S24.9) is switched only here, from the app's command or tray item, never from MCP.

use super::session::{Reason, Session, StateEvent};
use super::Dialogs;
use std::sync::{Arc, Mutex};

type Notify = Box<dyn Fn(&StateEvent) + Send + Sync>;
type EndHook = Arc<dyn Fn() + Send + Sync>;

pub struct Control {
    session: Mutex<Session>,
    notify: Notify,
    on_end: Mutex<Option<EndHook>>,
}

impl Control {
    pub fn new(notify: impl Fn(&StateEvent) + Send + Sync + 'static) -> Self {
        Control { session: Mutex::new(Session::default()), notify: Box::new(notify), on_end: Mutex::new(None) }
    }

    /// Runs `hook` once whenever the session ends (Stop, panic, timeout, or
    /// expiry). Linux wires `cancel_all` plus the working end here so an
    /// in-flight call is interrupted; macOS never sets it, so its behavior
    /// is unchanged.
    pub fn set_on_end(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.on_end.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::new(hook));
    }

    fn ended(&self) {
        if let Some(hook) = self.on_end.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() {
            hook();
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Session) -> T) -> T {
        f(&mut self.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
    }

    fn report(&self, event: Option<StateEvent>) {
        if let Some(event) = event {
            (self.notify)(&event);
        }
    }

    pub fn status(&self, now_ms: u64) -> StateEvent {
        self.with(|s| s.status(now_ms))
    }

    pub fn is_active(&self, now_ms: u64) -> bool {
        self.with(|s| s.is_active(now_ms))
    }

    pub fn epoch(&self) -> u64 {
        self.with(|s| s.epoch())
    }

    pub fn grant(&self, now_ms: u64) {
        let event = self.with(|s| s.grant(now_ms));
        self.report(Some(event));
    }

    /// Starts a session only when the session epoch is still `expected`, under the one session
    /// mutex so the compare and the grant cannot be split by a concurrent end. A Stop or panic
    /// while the consent dialog was open moved the epoch, so the pending grant is stale and is
    /// refused: the caller reports STOPPED and no session becomes active. Reports outside the
    /// lock, as [`grant`](Self::grant) does.
    pub fn grant_if_epoch(&self, expected: u64, now_ms: u64) -> bool {
        let granted = self.with(|s| (s.epoch() == expected).then(|| s.grant(now_ms)));
        match granted {
            Some(event) => {
                self.report(Some(event));
                true
            }
            None => false,
        }
    }

    pub fn end(&self, reason: Reason) {
        let event = self.with(|s| s.end(reason));
        let ended = event.as_ref().is_some_and(|event| !event.active);
        self.report(event);
        if ended {
            self.ended();
        }
    }

    pub fn expire(&self, now_ms: u64) {
        let event = self.with(|s| s.expire(now_ms));
        let ended = event.as_ref().is_some_and(|event| !event.active);
        self.report(event);
        if ended {
            self.ended();
        }
    }

    pub fn yolo(&self, now_ms: u64) -> bool {
        self.with(|s| s.yolo(now_ms))
    }

    /// Turns yolo mode on after the user confirms it natively, or off without asking. A stale
    /// *enable* is refused: the confirmation commits only while the epoch it was asked under
    /// still holds, so a panic during the yolo dialog cannot be overridden. A disable or a
    /// declined request (`on == false`) always commits under the same mutex, so a Stop racing it
    /// can never discard the revocation and leave yolo on. A committed result is reported as
    /// before; a refused stale enable reports nothing because the state change it would describe
    /// (the panic ending the session and yolo) already reported itself.
    pub fn set_yolo(&self, enabled: bool, now_ms: u64, dialogs: &dyn Dialogs) -> StateEvent {
        let expected = self.epoch();
        let on = enabled && dialogs.ask_yolo();
        let committed = self.with(|s| (!on || s.epoch() == expected).then(|| s.set_yolo(on, now_ms)));
        match committed {
            Some(event) => {
                self.report(Some(event.clone()));
                event
            }
            None => self.status(now_ms),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::fake::FakeDialogs;
    use super::super::session::{StateEvent, YOLO_MS};
    use super::*;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};

    const NOW: u64 = 1_700_000_000_000;

    fn control() -> (Control, Arc<Mutex<Vec<StateEvent>>>) {
        let states = Arc::new(Mutex::new(Vec::new()));
        let sink = states.clone();
        (Control::new(move |event| sink.lock().unwrap().push(event.clone())), states)
    }

    #[test]
    fn turning_yolo_on_asks_the_user_and_reports_it() {
        let (control, states) = control();
        let dialogs = FakeDialogs::new(true, true);
        control.set_yolo(true, NOW, &dialogs);
        assert_eq!(dialogs.yolo_asks.load(Ordering::SeqCst), 1);
        assert!(control.yolo(NOW));
        let on = StateEvent { yolo: true, yolo_ends_at: Some(NOW + YOLO_MS), ..StateEvent::default() };
        assert_eq!(*states.lock().unwrap(), vec![on.clone()]);
        assert_eq!(control.status(NOW), on);
    }

    #[test]
    fn a_declined_yolo_stays_off_and_the_switch_is_told_so() {
        let (control, states) = control();
        let dialogs = FakeDialogs::new(true, true);
        *dialogs.yolo.lock().unwrap() = false;
        control.set_yolo(true, NOW, &dialogs);
        assert!(!control.yolo(NOW));
        assert_eq!(*states.lock().unwrap(), vec![StateEvent::default()]);
    }

    #[test]
    fn turning_yolo_off_never_asks() {
        let (control, states) = control();
        let dialogs = FakeDialogs::new(true, true);
        control.set_yolo(true, NOW, &dialogs);
        control.set_yolo(false, NOW + 1, &dialogs);
        assert_eq!(dialogs.yolo_asks.load(Ordering::SeqCst), 1);
        assert!(!control.yolo(NOW + 1));
        assert_eq!(states.lock().unwrap().last(), Some(&StateEvent::default()));
    }

    #[test]
    fn panic_turns_yolo_off_with_or_without_a_session() {
        let (control, states) = control();
        let dialogs = FakeDialogs::new(true, true);
        control.set_yolo(true, NOW, &dialogs);
        control.grant(NOW);
        control.end(Reason::Panic);
        assert!(!control.yolo(NOW));
        let last = states.lock().unwrap().last().cloned().unwrap();
        assert!(!last.active && !last.yolo, "{last:?}");

        control.set_yolo(true, NOW, &dialogs);
        control.end(Reason::Panic);
        assert!(!control.yolo(NOW));
        assert!(!states.lock().unwrap().last().unwrap().yolo);
    }

    #[test]
    fn session_end_runs_the_hook_once_and_expiry_ends_it_too() {
        use super::super::session::SESSION_MS;
        use std::sync::atomic::AtomicUsize;
        let (control, _states) = control();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        control.set_on_end(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        // No session yet: ending runs nothing.
        control.end(Reason::Stopped);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        // Stop ends the session and runs the hook exactly once ...
        control.grant(NOW);
        control.end(Reason::Stopped);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // ... and ending the now-idle session runs nothing more.
        control.end(Reason::Stopped);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Expiry ends the session the timeout watcher reports, hook and all.
        control.grant(NOW);
        control.expire(NOW + SESSION_MS);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(!control.is_active(NOW + SESSION_MS));
    }

    #[test]
    fn stop_ends_the_session_but_leaves_yolo_on() {
        let (control, _states) = control();
        control.set_yolo(true, NOW, &FakeDialogs::new(true, true));
        control.grant(NOW);
        control.end(Reason::Stopped);
        assert!(control.yolo(NOW));
    }

    #[test]
    fn yolo_expiry_turns_it_off_and_reports_it() {
        let (control, states) = control();
        control.set_yolo(true, NOW, &FakeDialogs::new(true, true));
        control.expire(NOW + YOLO_MS - 1);
        assert_eq!(states.lock().unwrap().len(), 1);
        control.expire(NOW + YOLO_MS);
        assert!(!control.yolo(NOW + YOLO_MS));
        assert_eq!(states.lock().unwrap().last(), Some(&StateEvent::default()));
    }

    #[test]
    fn a_stale_expected_epoch_cannot_grant_after_an_idle_stop() {
        let (control, _states) = control();
        let epoch = control.epoch();
        // An idle Stop reports nothing but still invalidates any pending consent.
        control.end(Reason::Stopped);
        assert!(!control.is_active(NOW));
        assert!(!control.grant_if_epoch(epoch, NOW), "the stale epoch must not grant");
        assert!(!control.is_active(NOW), "a stale grant leaves the session inactive");
        // The current epoch can still grant.
        assert!(control.grant_if_epoch(control.epoch(), NOW));
        assert!(control.is_active(NOW));
    }

    #[test]
    fn a_panic_during_the_yolo_dialog_is_not_overridden() {
        let states: Arc<Mutex<Vec<StateEvent>>> = Arc::default();
        let sink = states.clone();
        let control = Arc::new(Control::new(move |event| sink.lock().unwrap().push(event.clone())));
        control.grant(NOW);
        let dialogs = FakeDialogs::new(true, true);
        let hook_control = control.clone();
        *dialogs.during.lock().unwrap() = Some(Box::new(move || hook_control.end(Reason::Panic)));
        // The user asks to turn yolo on; the emergency panic fires while the answer is pending.
        control.set_yolo(true, NOW, &dialogs);
        assert!(!control.yolo(NOW), "a stale authorization must not re-enable yolo");
        assert!(!control.is_active(NOW));
    }

    #[test]
    fn a_stale_declined_enable_still_turns_yolo_off() {
        // A requested disable/decline must never be discarded because the epoch moved. This uses
        // the same commit condition as the real "off" path (which asks no dialog): the outcome
        // depends only on `on`, not on how the interleaving happened.
        let states: Arc<Mutex<Vec<StateEvent>>> = Arc::default();
        let sink = states.clone();
        let control = Arc::new(Control::new(move |event| sink.lock().unwrap().push(event.clone())));
        let dialogs = FakeDialogs::new(true, true);
        control.set_yolo(true, NOW, &dialogs);
        assert!(control.yolo(NOW), "yolo starts on");
        control.grant(NOW);
        // The user asks to enable yolo again; the answer is declined, and a non-panic Stop lands
        // while it is pending. Stop leaves prior yolo on but moves the epoch.
        *dialogs.yolo.lock().unwrap() = false;
        let hook_control = control.clone();
        *dialogs.during.lock().unwrap() = Some(Box::new(move || hook_control.end(Reason::Stopped)));
        control.set_yolo(true, NOW, &dialogs);
        // The declined request still commits: yolo ends off, and the stale Stop granted nothing.
        assert!(!control.yolo(NOW), "a declined enable must never be discarded");
        assert!(!control.is_active(NOW), "the Stop must not be followed by a new grant");
    }
}
