//! The session shared by the MCP server and the app (Stop button, tray item, panic shortcut,
//! timeout watcher). Every transition is reported to `notify` (the `computer://state` event).

use super::session::{Reason, Session, StateEvent};
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
}
