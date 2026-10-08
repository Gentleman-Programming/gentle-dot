//! The computer-control session (S24.3): idle until the user allows it, then granted until
//! `ends_at`, ended by the Stop button, the tray item, the panic shortcut, or the timeout.
//! Every end bumps `epoch`, so actions queued under an earlier epoch are dropped.

use serde::Serialize;

pub const SESSION_MS: u64 = 30 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Granted,
    Stopped,
    Panic,
    Timeout,
}

/// The `computer://state` event and the `computer_status` reply (L60). `ends_at` is in
/// Unix epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
}

#[derive(Debug, Default)]
pub struct Session {
    ends_at: Option<u64>,
    epoch: u64,
}

impl Session {
    pub fn is_active(&self, now_ms: u64) -> bool {
        self.ends_at.is_some_and(|end| now_ms < end)
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn status(&self, now_ms: u64) -> StateEvent {
        let active = self.is_active(now_ms);
        StateEvent { active, ends_at: self.ends_at.filter(|_| active), reason: None }
    }

    /// Starts (or restarts) a session of `SESSION_MS`.
    pub fn grant(&mut self, now_ms: u64) -> StateEvent {
        let ends_at = now_ms + SESSION_MS;
        self.ends_at = Some(ends_at);
        StateEvent { active: true, ends_at: Some(ends_at), reason: Some(Reason::Granted) }
    }

    /// Ends the session for `reason`. `None` when there was none to end.
    pub fn end(&mut self, reason: Reason) -> Option<StateEvent> {
        self.ends_at.take()?;
        self.epoch += 1;
        Some(StateEvent { active: false, ends_at: None, reason: Some(reason) })
    }

    /// Ends the session with `Timeout` once `now_ms` reaches its end.
    pub fn expire(&mut self, now_ms: u64) -> Option<StateEvent> {
        if self.ends_at.is_some_and(|end| now_ms >= end) {
            self.end(Reason::Timeout)
        } else {
            None
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
        assert_eq!(session.status(NOW), StateEvent { active: false, ends_at: None, reason: None });
    }

    #[test]
    fn granting_starts_thirty_minutes() {
        let mut session = Session::default();
        let event = session.grant(NOW);
        assert_eq!(event, StateEvent { active: true, ends_at: Some(NOW + SESSION_MS), reason: Some(Reason::Granted) });
        assert!(session.is_active(NOW + SESSION_MS - 1));
        assert_eq!(session.status(NOW + 5).ends_at, Some(NOW + SESSION_MS));
    }

    #[test]
    fn stop_and_panic_end_the_session_and_bump_the_epoch() {
        for reason in [Reason::Stopped, Reason::Panic] {
            let mut session = Session::default();
            session.grant(NOW);
            let epoch = session.epoch();
            assert_eq!(session.end(reason), Some(StateEvent { active: false, ends_at: None, reason: Some(reason) }));
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
            Some(StateEvent { active: false, ends_at: None, reason: Some(Reason::Timeout) })
        );
        assert_eq!(session.epoch(), 1);
        assert_eq!(session.expire(NOW + SESSION_MS + 1), None);
    }

    #[test]
    fn the_event_serializes_like_the_l60_contract() {
        let mut session = Session::default();
        let granted = serde_json::to_value(session.grant(NOW)).unwrap();
        assert_eq!(granted, serde_json::json!({"active": true, "endsAt": NOW + SESSION_MS, "reason": "granted"}));
        let panic = serde_json::to_value(session.end(Reason::Panic).unwrap()).unwrap();
        assert_eq!(panic, serde_json::json!({"active": false, "reason": "panic"}));
        assert_eq!(serde_json::to_value(session.status(NOW)).unwrap(), serde_json::json!({"active": false}));
    }
}
