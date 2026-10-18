//! Linux working checks (T5c, S1-S5): ready at once, never blocking,
//! fenced finishes, and a session end that still runs. Deterministic, no
//! overlay, no windows, no compositor.

use super::working::LinuxWorking;
use crate::computer::working::Preparation;

#[test]
fn begin_is_ready_at_once_and_never_blocks() {
    let working = LinuxWorking::new();
    let first = working.begin().expect("no overlay must never fail a call");
    let second = working.begin().expect("no overlay must never fail a call");
    assert_ne!(first, second, "operations need distinct ids");
    assert!(working.is_current(second));
    assert!(!working.is_current(first), "a newer begin ends the older one");
}

#[test]
fn finish_clears_only_its_own_operation() {
    let working = LinuxWorking::new();
    let first = working.begin().unwrap();
    working.finish(first + 100);
    assert!(working.is_current(first), "a late finish for another id revives nothing");
    working.finish(first);
    assert!(!working.is_current(first));
    // A second finish is a silent no-op.
    working.finish(first);
}

#[test]
fn session_ended_clears_the_running_operation_and_still_runs() {
    let working = LinuxWorking::new();
    let operation = working.begin().unwrap();
    working.session_ended();
    assert!(!working.is_current(operation));
    // The call's own finish comes later and does nothing more.
    working.finish(operation);
    // New calls still start after a session end.
    let next = working.begin().unwrap();
    assert!(working.is_current(next));
    // Ending an idle session is a silent no-op.
    working.session_ended();
    working.session_ended();
}
