//! Linux working preparation (T5c, S1-S5): no overlay exists off macOS,
//! so calls must not fail because no rings can draw. This preparation
//! reports ready at once and never blocks a call, while the session-end
//! path still runs. It fabricates no visual overlay and hides no windows:
//! `begin` hands out an operation id, `finish` clears it, and
//! `session_ended` (Stop, panic, timeout) ends the running operation at
//! once so a late `finish` cannot revive it.

use super::super::working::Preparation;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// No rings and nothing hidden: every call is ready at once.
#[derive(Debug, Default)]
pub struct LinuxWorking {
    next: AtomicU64,
    current: Mutex<Option<u64>>,
}

impl LinuxWorking {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether `operation` is the one running now.
    pub fn is_current(&self, operation: u64) -> bool {
        lock(&self.current).is_some_and(|current| current == operation)
    }

    /// The session ended (Stop, panic, timeout): the running operation ends
    /// at once, exactly like the overlay path clears its rings.
    pub fn session_ended(&self) {
        *lock(&self.current) = None;
    }
}

impl Preparation for LinuxWorking {
    fn begin(&self) -> Result<u64, String> {
        // One call still running here was left behind, and ends now so a
        // stale operation never shadows the new one.
        self.session_ended();
        let operation = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        *lock(&self.current) = Some(operation);
        Ok(operation)
    }

    fn finish(&self, operation: u64) {
        let mut current = lock(&self.current);
        if *current == Some(operation) {
            *current = None;
        }
    }
}
