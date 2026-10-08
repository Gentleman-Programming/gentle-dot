//! The computer-control session (S24.3): idle until the user allows it, then granted until
//! `ends_at`, ended by the Stop button, the tray item, the panic shortcut, or the timeout.
//! Every end bumps `epoch`, so actions queued under an earlier epoch are dropped.
//!
//! Yolo mode (S24.9) lives here too, in memory only: while it lasts, risky actions skip their
//! confirmation. It has its own switch and its own hour; Stop and panic end the session, not it.

use serde::Serialize;

pub const SESSION_MS: u64 = 30 * 60 * 1000;
pub const YOLO_MS: u64 = 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Granted,
    Stopped,
    Panic,
    Timeout,
}

/// The `computer://state` event and the `computer_status` reply (L60), plus `yolo` and
/// `yoloEndsAt` (S24.9). Times are Unix epoch milliseconds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    pub yolo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yolo_ends_at: Option<u64>,
}

#[derive(Debug, Default)]
pub struct Session {
    ends_at: Option<u64>,
    epoch: u64,
    yolo_ends_at: Option<u64>,
}

impl Session {
    pub fn is_active(&self, now_ms: u64) -> bool {
        self.ends_at.is_some_and(|end| now_ms < end)
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Whether yolo mode is on at `now_ms`.
    pub fn yolo(&self, now_ms: u64) -> bool {
        self.yolo_ends_at.is_some_and(|end| now_ms < end)
    }

    pub fn status(&self, now_ms: u64) -> StateEvent {
        let active = self.is_active(now_ms);
        let yolo = self.yolo(now_ms);
        StateEvent {
            active,
            ends_at: self.ends_at.filter(|_| active),
            reason: None,
            yolo,
            yolo_ends_at: self.yolo_ends_at.filter(|_| yolo),
        }
    }

    /// The status as an event for `reason`, sent at a transition (the clock has not moved).
    fn event(&self, reason: Option<Reason>) -> StateEvent {
        StateEvent {
            active: self.ends_at.is_some(),
            ends_at: self.ends_at,
            reason,
            yolo: self.yolo_ends_at.is_some(),
            yolo_ends_at: self.yolo_ends_at,
        }
    }

    /// Starts (or restarts) a session of `SESSION_MS`.
    pub fn grant(&mut self, now_ms: u64) -> StateEvent {
        self.ends_at = Some(now_ms + SESSION_MS);
        self.event(Some(Reason::Granted))
    }

    /// Ends the session for `reason`. `None` when there was none to end.
    pub fn end(&mut self, reason: Reason) -> Option<StateEvent> {
        self.ends_at.take()?;
        self.epoch += 1;
        Some(self.event(Some(reason)))
    }

    /// Turns yolo mode on for `YOLO_MS`, or off.
    pub fn set_yolo(&mut self, on: bool, now_ms: u64) -> StateEvent {
        self.yolo_ends_at = on.then_some(now_ms + YOLO_MS);
        self.status(now_ms)
    }

    /// Ends the session with `Timeout`, and yolo mode, once `now_ms` reaches their end; one
    /// event for both.
    pub fn expire(&mut self, now_ms: u64) -> Option<StateEvent> {
        let yolo_over = self.yolo_ends_at.is_some_and(|end| now_ms >= end);
        if yolo_over {
            self.yolo_ends_at = None;
        }
        if self.ends_at.is_some_and(|end| now_ms >= end) {
            self.end(Reason::Timeout)
        } else {
            yolo_over.then(|| self.event(None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_700_000_000_000;

    #[test]
    fn a_new_session_is_idle() {
        let session = Session::default();
        assert!(!session.is_active(NOW));
        assert_eq!(session.status(NOW), StateEvent { active: false, ends_at: None, reason: None, ..StateEvent::default() });
    }

    #[test]
    fn granting_starts_thirty_minutes() {
        let mut session = Session::default();
        let event = session.grant(NOW);
        assert_eq!(event, StateEvent { active: true, ends_at: Some(NOW + SESSION_MS), reason: Some(Reason::Granted), ..StateEvent::default() });
        assert!(session.is_active(NOW + SESSION_MS - 1));
        assert_eq!(session.status(NOW + 5).ends_at, Some(NOW + SESSION_MS));
    }

    #[test]
    fn stop_and_panic_end_the_session_and_bump_the_epoch() {
        for reason in [Reason::Stopped, Reason::Panic] {
            let mut session = Session::default();
            session.grant(NOW);
            let epoch = session.epoch();
            assert_eq!(session.end(reason), Some(StateEvent { active: false, ends_at: None, reason: Some(reason), ..StateEvent::default() }));
            assert!(!session.is_active(NOW));
            assert_eq!(session.epoch(), epoch + 1);
        }
    }

    #[test]
    fn ending_an_idle_session_reports_nothing() {
        let mut session = Session::default();
        assert_eq!(session.end(Reason::Stopped), None);
        assert_eq!(session.epoch(), 0);
    }

    #[test]
    fn the_session_times_out_at_its_end() {
        let mut session = Session::default();
        session.grant(NOW);
        assert_eq!(session.expire(NOW + SESSION_MS - 1), None);
        assert!(!session.is_active(NOW + SESSION_MS));
        assert_eq!(
            session.expire(NOW + SESSION_MS),
            Some(StateEvent { active: false, ends_at: None, reason: Some(Reason::Timeout), ..StateEvent::default() })
        );
        assert_eq!(session.epoch(), 1);
        assert_eq!(session.expire(NOW + SESSION_MS + 1), None);
    }

    #[test]
    fn the_event_serializes_like_the_l60_contract() {
        let mut session = Session::default();
        let granted = serde_json::to_value(session.grant(NOW)).unwrap();
        assert_eq!(granted, serde_json::json!({"active": true, "endsAt": NOW + SESSION_MS, "reason": "granted", "yolo": false}));
        let panic = serde_json::to_value(session.end(Reason::Panic).unwrap()).unwrap();
        assert_eq!(panic, serde_json::json!({"active": false, "reason": "panic", "yolo": false}));
        assert_eq!(serde_json::to_value(session.status(NOW)).unwrap(), serde_json::json!({"active": false, "yolo": false}));
    }

    // --- Yolo mode (S24.9) ---

    #[test]
    fn yolo_is_off_until_turned_on_then_lasts_an_hour() {
        let mut session = Session::default();
        assert!(!session.yolo(NOW));
        let on = session.set_yolo(true, NOW);
        assert_eq!(on, StateEvent { yolo: true, yolo_ends_at: Some(NOW + YOLO_MS), ..StateEvent::default() });
        assert!(session.yolo(NOW + YOLO_MS - 1));
        assert_eq!(
            serde_json::to_value(session.status(NOW)).unwrap(),
            serde_json::json!({"active": false, "yolo": true, "yoloEndsAt": NOW + YOLO_MS})
        );
        assert_eq!(session.set_yolo(false, NOW + 5), StateEvent::default());
        assert!(!session.yolo(NOW + 5));
    }

    #[test]
    fn yolo_turns_itself_off_after_an_hour_and_reports_it() {
        let mut session = Session::default();
        session.set_yolo(true, NOW);
        assert_eq!(session.expire(NOW + YOLO_MS - 1), None);
        assert!(!session.yolo(NOW + YOLO_MS));
        assert_eq!(session.expire(NOW + YOLO_MS), Some(StateEvent::default()));
        assert_eq!(session.expire(NOW + YOLO_MS + 1), None);
        // A session timeout and a yolo expiry at the same check are one event.
        session.set_yolo(true, NOW);
        session.grant(NOW + YOLO_MS - SESSION_MS);
        let both = session.expire(NOW + YOLO_MS).unwrap();
        assert_eq!((both.active, both.reason, both.yolo), (false, Some(Reason::Timeout), false));
    }

    #[test]
    fn stop_and_panic_end_the_session_but_leave_yolo_to_its_switch() {
        let mut session = Session::default();
        session.set_yolo(true, NOW);
        session.grant(NOW);
        let ended = session.end(Reason::Panic).unwrap();
        assert!(ended.yolo && session.yolo(NOW));
    }
}
