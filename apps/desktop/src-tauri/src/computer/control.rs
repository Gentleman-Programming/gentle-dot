//! The session shared by the MCP server and the app (Stop button, tray item, panic shortcut,
//! timeout watcher). Every transition is reported to `notify` (the `computer://state` event).
//! Yolo mode (S24.9) is switched only here, from the app's command or tray item, never from MCP.

use super::session::{Reason, Session, StateEvent};
use super::Dialogs;
use std::sync::Mutex;

type Notify = Box<dyn Fn(&StateEvent) + Send + Sync>;

pub struct Control {
    session: Mutex<Session>,
    notify: Notify,
}

impl Control {
    pub fn new(notify: impl Fn(&StateEvent) + Send + Sync + 'static) -> Self {
        Control { session: Mutex::new(Session::default()), notify: Box::new(notify) }
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

    pub fn end(&self, reason: Reason) {
        let event = self.with(|s| s.end(reason));
        self.report(event);
    }

    pub fn expire(&self, now_ms: u64) {
        let event = self.with(|s| s.expire(now_ms));
        self.report(event);
    }

    pub fn yolo(&self, now_ms: u64) -> bool {
        self.with(|s| s.yolo(now_ms))
    }

    /// Turns yolo mode on after the user confirms it natively, or off without asking. The
    /// result is always reported, so a switch that flipped before the answer flips back.
    pub fn set_yolo(&self, enabled: bool, now_ms: u64, dialogs: &dyn Dialogs) -> StateEvent {
        let on = enabled && dialogs.ask_yolo();
        let event = self.with(|s| s.set_yolo(on, now_ms));
        self.report(Some(event.clone()));
        event
    }
}

#[cfg(test)]
mod tests {
    use super::super::fake::FakeDialogs;
    use super::super::session::{StateEvent, YOLO_MS};
    use super::*;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

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
}
