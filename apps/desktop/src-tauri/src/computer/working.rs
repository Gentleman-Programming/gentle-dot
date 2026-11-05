//! The working rings (S1, S2, S5): while a screenshot or an action runs, Gentle Dot hides the
//! Dot and the panel and shows pink rings at the top of the controlled display instead.
//!
//! An operation starts only from a confirmed state: the overlay is ordered in and told to draw
//! (`computer://working`), the overlay acknowledges the rings it drew (`computer_working_ready`),
//! then the Dot and the panel are hidden on the main thread. Every wait is bounded. Finishing an
//! operation, or the end of the session (Stop, panic, timeout), clears the rings and shows again
//! exactly what the operation hid, without focusing it; an operation that ended is fenced out,
//! so a late acknowledgement or a queued hide does nothing. Nothing guarantees restoring after
//! the process aborts or while the main thread is blocked.

use serde::Serialize;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Sent to the overlay only: draw the rings for `operationId`, or stop drawing them.
pub const WORKING_EVENT: &str = "computer://working";
/// How long the overlay has to acknowledge the rings, and the main thread to hide the windows.
pub const READY_TIMEOUT: Duration = Duration::from_secs(2);
pub const UNAVAILABLE: &str =
    "Gentle Dot could not show that it is working, so nothing was done. Try again.";
pub const NOT_HIDDEN: &str = "Gentle Dot could not move its own windows out of the way, so nothing was done. Try again.";

/// The `computer://working` payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingEvent {
    pub active: bool,
    pub operation_id: u64,
}

/// One of the windows an operation hides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Dot,
    Panel,
}

const PARTS: [Part; 2] = [Part::Dot, Part::Panel];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Visibility {
    pub dot: bool,
    pub panel: bool,
}

impl Visibility {
    pub fn get(&self, part: Part) -> bool {
        match part {
            Part::Dot => self.dot,
            Part::Panel => self.panel,
        }
    }

    fn set(&mut self, part: Part, on: bool) {
        match part {
            Part::Dot => self.dot = on,
            Part::Panel => self.panel = on,
        }
    }
}

/// What to show again once an operation ends: what it hid and is still hidden, except a Dot
/// the user hid meanwhile ("Hide the rose"). A window the user opened again stays as it is.
pub fn to_restore(hidden: Visibility, now: Visibility, rose_hidden: bool) -> Visibility {
    Visibility { dot: hidden.dot && !now.dot && !rose_hidden, panel: hidden.panel && !now.panel }
}

/// The Dot and the panel. Main thread only.
pub trait Windows: Send + Sync {
    fn is_visible(&self, part: Part) -> bool;
    fn hide(&self, part: Part) -> Result<(), String>;
    fn hide_for_operation(&self, part: Part, _operation: u64) -> Result<(), String> {
        self.hide(part)
    }
    /// Orders the window in without focusing it or activating the app.
    fn show(&self, part: Part);
    /// Release call-owned state after all eligible windows have been shown, including state
    /// for windows the user chose to keep hidden. Main thread only.
    fn finish_restore(&self, _operation: u64) {}
    /// Dispatch failed: restore this call's capture affinities without showing its windows.
    /// May run off the main thread; failed native restores retain ownerless recovery values.
    fn abandon_restore(&self, _operation: u64) {}
    /// The user's "Hide the rose" choice, as it is now.
    fn rose_hidden(&self) -> bool;
}

/// The overlay's rings.
pub trait Rings: Send + Sync {
    /// Orders the overlay in over the controlled display, then tells it to draw the rings for
    /// `operation`. Returns once both happened, or why not; never waits unbounded.
    fn show(&self, operation: u64) -> Result<(), String>;
    /// Tells the overlay to stop drawing the rings for `operation`; never waits.
    fn end(&self, operation: u64);
}

pub type Task = Box<dyn FnOnce() + Send>;

pub trait MainThread: Send + Sync {
    /// Runs `task` on the main thread: queued in order, or at once when called there.
    fn run(&self, task: Task) -> Result<(), String>;
}

/// What the MCP helper needs around each call that captures or acts (S1, S5).
pub trait Preparation: Send + Sync {
    /// Returns once the rings show and the Dot and panel are out of the way, or why not (then
    /// nothing stays hidden). The operation must be passed to `finish`.
    fn begin(&self) -> Result<u64, String>;
    /// Clears the rings and shows again what `operation` hid; does nothing once it ended.
    fn finish(&self, operation: u64);
}

/// No rings and nothing hidden: the helper without an overlay, as in most tests.
pub struct NoPreparation;

impl Preparation for NoPreparation {
    fn begin(&self) -> Result<u64, String> {
        Ok(0)
    }

    fn finish(&self, _operation: u64) {}
}

#[derive(Default)]
struct State {
    last: u64,
    current: Option<Op>,
    /// Each part belongs to its latest successful hide, never to a delayed older restore.
    hidden: Vec<(Part, u64)>,
}

struct Op {
    id: u64,
    /// The overlay acknowledged the rings.
    ready: bool,
    /// The main thread hid the windows, or why it could not.
    hid: Option<Result<(), String>>,
}

/// Why a wait in `begin` gave up.
enum Gave {
    Ended,
    TimedOut,
}

struct Inner {
    windows: Arc<dyn Windows>,
    rings: Arc<dyn Rings>,
    main: Arc<dyn MainThread>,
    timeout: Duration,
    state: Mutex<State>,
    changed: Condvar,
}

pub struct Working(Arc<Inner>);

impl Working {
    pub fn new(windows: Arc<dyn Windows>, rings: Arc<dyn Rings>, main: Arc<dyn MainThread>, timeout: Duration) -> Self {
        Working(Arc::new(Inner {
            windows,
            rings,
            main,
            timeout,
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
        }))
    }

    /// Whether `operation` is the one running now (the overlay drops a late start).
    pub fn is_current(&self, operation: u64) -> bool {
        self.0.lock().current.as_ref().is_some_and(|op| op.id == operation)
    }

    /// The overlay drew the rings for `operation`. False when it is not the one running now.
    pub fn ready(&self, operation: u64) -> bool {
        let mut state = self.0.lock();
        let Some(op) = state.current.as_mut().filter(|op| op.id == operation) else {
            return false;
        };
        op.ready = true;
        self.0.changed.notify_all();
        true
    }

    /// `computer_working_ready` from the window labeled `window`: only the overlay may say so.
    pub fn acknowledge(&self, window: &str, operation: u64) -> Result<bool, String> {
        if window != super::app::GLOW_WINDOW {
            return Err("Only the computer-control overlay reports the working rings.".into());
        }
        Ok(self.ready(operation))
    }

    /// The session ended (Stop, panic, timeout): the running operation ends at once.
    pub fn session_ended(&self) {
        let running = self.0.lock().current.as_ref().map(|op| op.id);
        if let Some(operation) = running {
            self.finish(operation);
        }
    }

    /// Waits until `done` holds for `operation`, it ended, or the time is up.
    fn wait(&self, operation: u64, done: impl Fn(&Op) -> bool) -> Result<(), Gave> {
        let deadline = Instant::now() + self.0.timeout;
        let mut state = self.0.lock();
        loop {
            match state.current.as_ref().filter(|op| op.id == operation) {
                None => return Err(Gave::Ended),
                Some(op) if done(op) => return Ok(()),
                Some(_) => {}
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(Gave::TimedOut);
            }
            state = self.0.changed.wait_timeout(state, left).unwrap_or_else(|p| p.into_inner()).0;
        }
    }

    /// Ends `operation` after a failed step of `begin`, with `error`.
    fn abandon(&self, operation: u64, error: &str) -> String {
        self.finish(operation);
        error.to_string()
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// On the main thread: hides the visible windows for `operation`, unless it already ended.
    fn hide(&self, operation: u64) {
        let mut state = self.lock();
        if !state.current.as_ref().is_some_and(|op| op.id == operation) {
            return;
        }
        let mut outcome = Ok(());
        for part in PARTS {
            // A previous restore may still be queued. Inherit its hidden windows too,
            // so it cannot show them during this call even without a user reopen.
            if !self.windows.is_visible(part) && !state.hidden.iter().any(|&(saved, _)| saved == part) {
                continue;
            }
            if let Err(error) = self.windows.hide_for_operation(part, operation) {
                outcome = Err(error);
                break;
            }
            state.hidden.retain(|(saved, _)| *saved != part);
            state.hidden.push((part, operation));
        }
        if let Some(op) = state.current.as_mut() {
            op.hid = Some(outcome);
        }
        self.changed.notify_all();
    }

    /// On the main thread: shows again what operations hid, as the user left things meanwhile.
    /// The state lock stays held while showing; that is safe only because nothing `Windows`
    /// does here re-enters `Working` or waits for another thread that takes this lock.
    fn restore(&self, operation: u64) {
        let mut state = self.lock();
        let mut hidden = Visibility::default();
        state.hidden.retain(|&(part, owner)| {
            if owner != operation { return true; }
            hidden.set(part, true);
            false
        });
        let now = Visibility { dot: self.windows.is_visible(Part::Dot), panel: self.windows.is_visible(Part::Panel) };
        let show = to_restore(hidden, now, self.windows.rose_hidden());
        for part in PARTS.into_iter().filter(|part| show.get(*part)) {
            self.windows.show(part);
        }
        self.windows.finish_restore(operation);
    }
}

impl Preparation for Working {
    fn begin(&self) -> Result<u64, String> {
        // Calls are serialized; one still running here was left behind, and ends now.
        self.session_ended();
        let operation = {
            let mut state = self.0.lock();
            state.last += 1;
            state.current = Some(Op { id: state.last, ready: false, hid: None });
            state.last
        };
        if let Err(error) = self.0.rings.show(operation) {
            eprintln!("gentle-dot: cannot show the working rings: {error}");
            return Err(self.abandon(operation, UNAVAILABLE));
        }
        if self.wait(operation, |op| op.ready).is_err() {
            return Err(self.abandon(operation, UNAVAILABLE));
        }
        let inner = self.0.clone();
        if let Err(error) = self.0.main.run(Box::new(move || inner.hide(operation))) {
            eprintln!("gentle-dot: cannot hide the Dot and the panel: {error}");
            return Err(self.abandon(operation, NOT_HIDDEN));
        }
        if let Err(gave) = self.wait(operation, |op| op.hid.is_some()) {
            let error = match gave {
                Gave::Ended => UNAVAILABLE,
                Gave::TimedOut => NOT_HIDDEN,
            };
            return Err(self.abandon(operation, error));
        }
        let hid = self.0.lock().current.as_ref().filter(|op| op.id == operation).and_then(|op| op.hid.clone());
        match hid {
            Some(Ok(())) => Ok(operation),
            Some(Err(error)) => {
                eprintln!("gentle-dot: cannot hide the Dot and the panel: {error}");
                Err(self.abandon(operation, NOT_HIDDEN))
            }
            None => Err(self.abandon(operation, UNAVAILABLE)),
        }
    }

    fn finish(&self, operation: u64) {
        {
            let mut state = self.0.lock();
            if !state.current.as_ref().is_some_and(|op| op.id == operation) {
                return;
            }
            state.current = None;
        }
        // No lock held from here: on the main thread, `run` runs the task at once.
        self.0.changed.notify_all();
        self.0.rings.end(operation);
        let inner = self.0.clone();
        if let Err(error) = self.0.main.run(Box::new(move || inner.restore(operation))) {
            // Showing must stay on the main thread, but affinity restoration need not.
            // End only this call's ownership; preserve recovery values on native failure.
            let mut state = self.0.lock();
            state.hidden.retain(|&(_, owner)| owner != operation);
            self.0.windows.abandon_restore(operation);
            eprintln!("gentle-dot: cannot show the Dot and the panel again: {error}");
        }
    }
}

/// End the current drawing only when the session ends.
pub fn session_clears(drawing: &mut Option<u64>, active: bool) -> Option<u64> {
    if active { None } else { drawing.take() }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_end_of_the_session_clears_the_rings_being_drawn() {
        let mut drawing = Some(7);
        assert_eq!(super::session_clears(&mut drawing, true), None);
        assert_eq!(drawing, Some(7));
        assert_eq!(super::session_clears(&mut drawing, false), Some(7));
        assert_eq!(drawing, None);
        assert_eq!(super::session_clears(&mut drawing, false), None);
    }

    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Weak;
    use std::time::Instant;

    type Log = Arc<Mutex<Vec<String>>>;
    type Hook = Box<dyn Fn(u64) + Send + Sync>;

    const SHORT: Duration = Duration::from_millis(100);

    struct FakeWindows {
        log: Log,
        visible: Mutex<Visibility>,
        rose_hidden: AtomicBool,
        fails: Mutex<Option<Part>>,
        call_affinities: Mutex<Vec<(Option<u64>, (Part, u32))>>,
        affinities: Mutex<[u32; 2]>,
        handles: Mutex<[Option<usize>; 2]>,
        unrelated_affinity: Mutex<u32>,
        restore_fails: AtomicBool,
        restored: Mutex<Vec<(Part, u32, bool)>>,
    }

    fn name(part: Part) -> &'static str {
        match part {
            Part::Dot => "dot",
            Part::Panel => "panel",
        }
    }

    impl FakeWindows {
        fn restore_affinity(&self, part: Part, previous: u32) -> bool {
            if self.restore_fails.load(Ordering::SeqCst) { return false; }
            self.affinities.lock().unwrap()[part as usize] = previous;
            self.restored.lock().unwrap().push((part, previous, self.is_visible(part)));
            true
        }
    }

    impl FakeWindows {
        fn handles(&self) -> super::super::capture_order::CallHandles {
            let [dot, panel] = *self.handles.lock().unwrap();
            super::super::capture_order::CallHandles { dot, panel }
        }

        fn restore_unrelated_capture(&self, hwnd: usize, previous: u32) {
            let mut saved = self.call_affinities.lock().unwrap();
            if let Some(index) = super::super::capture_order::current_window(&saved, hwnd, self.handles()) {
                saved[index].1.1 = previous;
                return;
            }
            *self.unrelated_affinity.lock().unwrap() = previous;
        }
    }

    impl Windows for FakeWindows {
        fn is_visible(&self, part: Part) -> bool {
            self.visible.lock().unwrap().get(part)
        }

        fn hide(&self, part: Part) -> Result<(), String> {
            if *self.fails.lock().unwrap() == Some(part) {
                return Err(format!("cannot hide the {}", name(part)));
            }
            self.visible.lock().unwrap().set(part, false);
            self.log.lock().unwrap().push(format!("hide {}", name(part)));
            Ok(())
        }

        fn hide_for_operation(&self, part: Part, operation: u64) -> Result<(), String> {
            self.hide(part)?;
            let mut saved = self.call_affinities.lock().unwrap();
            let previous = saved.iter().find(|(_, (window, _))| *window == part)
                .map(|(_, (_, previous))| *previous)
                .unwrap_or(self.affinities.lock().unwrap()[part as usize]);
            self.affinities.lock().unwrap()[part as usize] = 0x11;
            saved.retain(|&(_, (window, _))| window != part);
            saved.push((Some(operation), (part, previous)));
            Ok(())
        }

        fn show(&self, part: Part) {
            self.visible.lock().unwrap().set(part, true);
            self.log.lock().unwrap().push(format!("show {}", name(part)));
            self.call_affinities.lock().unwrap().retain(|&(_, (window, previous))| {
                window != part || !self.restore_affinity(window, previous)
            });
        }

        fn finish_restore(&self, operation: u64) {
            let mut saved = self.call_affinities.lock().unwrap();
            super::super::capture_order::release(&mut saved, operation,
                |(part, previous)| self.restore_affinity(part, previous));
        }

        fn abandon_restore(&self, operation: u64) {
            self.finish_restore(operation);
        }

        fn rose_hidden(&self) -> bool {
            self.rose_hidden.load(Ordering::SeqCst)
        }
    }

    struct FakeRings {
        log: Log,
        fails: AtomicBool,
        /// What the overlay does once told to draw (by default, acknowledge it).
        on_show: Mutex<Option<Hook>>,
    }

    impl Rings for FakeRings {
        fn show(&self, operation: u64) -> Result<(), String> {
            if self.fails.load(Ordering::SeqCst) {
                return Err("the overlay is unavailable".into());
            }
            self.log.lock().unwrap().push(format!("rings on {operation}"));
            if let Some(hook) = self.on_show.lock().unwrap().as_ref() {
                hook(operation);
            }
            Ok(())
        }

        fn end(&self, operation: u64) {
            self.log.lock().unwrap().push(format!("rings off {operation}"));
        }
    }

    /// Runs tasks at once, or queues them until `drain` when `deferred` (then `after_queue` runs
    /// once, after the first task is queued).
    struct FakeMain {
        deferred: AtomicBool,
        fails: AtomicBool,
        queue: Mutex<Vec<Task>>,
        after_queue: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    }

    impl MainThread for FakeMain {
        fn run(&self, task: Task) -> Result<(), String> {
            if self.fails.load(Ordering::SeqCst) {
                return Err("dispatch failed".into());
            }
            if !self.deferred.load(Ordering::SeqCst) {
                task();
                return Ok(());
            }
            self.queue.lock().unwrap().push(task);
            let hook = self.after_queue.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
            Ok(())
        }
    }

    impl FakeMain {
        fn drain(&self) {
            let tasks: Vec<Task> = std::mem::take(&mut *self.queue.lock().unwrap());
            for task in tasks {
                task();
            }
        }
    }

    struct Rig {
        working: Arc<Working>,
        windows: Arc<FakeWindows>,
        rings: Arc<FakeRings>,
        main: Arc<FakeMain>,
        log: Log,
    }

    fn rig_with(visible: Visibility, timeout: Duration) -> Rig {
        let log: Log = Arc::default();
        let windows = Arc::new(FakeWindows {
            log: log.clone(),
            visible: Mutex::new(visible),
            rose_hidden: AtomicBool::new(!visible.dot),
            fails: Mutex::new(None),
            call_affinities: Mutex::new(Vec::new()),
            affinities: Mutex::new([1, 0]),
            handles: Mutex::new([Some(101), Some(102)]),
            unrelated_affinity: Mutex::new(0x11),
            restore_fails: AtomicBool::new(false),
            restored: Mutex::new(Vec::new()),
        });
        let rings = Arc::new(FakeRings { log: log.clone(), fails: AtomicBool::new(false), on_show: Mutex::new(None) });
        let main =
            Arc::new(FakeMain { deferred: AtomicBool::new(false), fails: AtomicBool::new(false), queue: Mutex::new(Vec::new()), after_queue: Mutex::new(None) });
        let working = Arc::new(Working::new(windows.clone(), rings.clone(), main.clone(), timeout));
        let rig = Rig { working, windows, rings, main, log };
        rig.on_show(|working, operation| {
            working.ready(operation);
        });
        rig
    }

    fn rig() -> Rig {
        rig_with(Visibility { dot: true, panel: true }, SHORT)
    }

    impl Rig {
        /// What the overlay does once told to draw the rings.
        fn on_show(&self, hook: impl Fn(&Working, u64) + Send + Sync + 'static) {
            let working: Weak<Working> = Arc::downgrade(&self.working);
            *self.rings.on_show.lock().unwrap() = Some(Box::new(move |operation| {
                if let Some(working) = working.upgrade() {
                    hook(&working, operation);
                }
            }));
        }

        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }

        fn visible(&self) -> Visibility {
            *self.windows.visible.lock().unwrap()
        }
    }

    const BOTH: Visibility = Visibility { dot: true, panel: true };

    #[test]
    fn an_operation_shows_the_rings_hides_the_windows_and_puts_them_back() {
        let rig = rig();
        let operation = rig.working.begin().unwrap();
        assert_eq!(rig.log(), ["rings on 1", "hide dot", "hide panel"]);
        assert_eq!(rig.visible(), Visibility::default());
        rig.working.finish(operation);
        assert_eq!(rig.log(), ["rings on 1", "hide dot", "hide panel", "rings off 1", "show dot", "show panel"]);
        assert_eq!(rig.visible(), BOTH);
    }

    #[test]
    fn only_what_was_visible_is_hidden_and_shown_again() {
        // The user hid the rose and the panel is open.
        let rig = rig_with(Visibility { dot: false, panel: true }, SHORT);
        let operation = rig.working.begin().unwrap();
        rig.working.finish(operation);
        assert_eq!(rig.log(), ["rings on 1", "hide panel", "rings off 1", "show panel"]);
        // Nothing open: nothing hidden, nothing shown, the rings still come and go.
        let rig = rig_with(Visibility::default(), SHORT);
        let operation = rig.working.begin().unwrap();
        rig.working.finish(operation);
        assert_eq!(rig.log(), ["rings on 1", "rings off 1"]);
    }

    #[test]
    fn delayed_restore_cannot_touch_a_later_calls_windows_or_affinities() {
        for reopen in [false, true] {
            let rig = rig();
            let a = rig.working.begin().unwrap();
            rig.main.deferred.store(true, Ordering::SeqCst);
            rig.working.finish(a);
            rig.main.deferred.store(false, Ordering::SeqCst);
            // B owns either inherited hides or windows the user reopened meanwhile.
            if reopen { *rig.windows.visible.lock().unwrap() = BOTH; }
            let b = rig.working.begin().unwrap();
            rig.main.drain();
            assert_eq!(rig.visible(), Visibility::default(), "A must not show B's windows");
            assert_eq!(*rig.windows.call_affinities.lock().unwrap(), [(Some(b), (Part::Dot, 1)), (Some(b), (Part::Panel, 0))],
                "A must not release B's affinities");
            rig.working.finish(b);
            assert_eq!(rig.visible(), BOTH);
            assert!(rig.windows.call_affinities.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn unrecorded_handle_does_not_intercept_an_unrelated_windows_capture_restore() {
        let rig = rig();
        let operation = rig.working.begin().unwrap();
        rig.main.fails.store(true, Ordering::SeqCst);
        rig.windows.restore_fails.store(true, Ordering::SeqCst);
        rig.working.finish(operation);
        // Dot/panel handles live for the process. An unrelated (possibly recycled) handle
        // outside that recorded pair must be restored natively, not handed to their records.
        rig.windows.restore_unrelated_capture(201, 7);
        assert_eq!(*rig.windows.unrelated_affinity.lock().unwrap(), 7);
    }

    #[test]
    fn failed_dispatch_restores_native_affinity_values_while_hidden() {
        let rig = rig();
        let operation = rig.working.begin().unwrap();
        assert_eq!(*rig.windows.affinities.lock().unwrap(), [0x11, 0x11]);
        rig.main.fails.store(true, Ordering::SeqCst);
        rig.working.finish(operation);
        assert_eq!(*rig.windows.affinities.lock().unwrap(), [1, 0]);
        assert_eq!(*rig.windows.restored.lock().unwrap(), [(Part::Dot, 1, false), (Part::Panel, 0, false)]);
    }

    #[test]
    fn failed_native_restore_keeps_the_original_for_next_show_or_hide() {
        for show_first in [true, false] {
            let rig = rig();
            let operation = rig.working.begin().unwrap();
            rig.main.fails.store(true, Ordering::SeqCst);
            rig.windows.restore_fails.store(true, Ordering::SeqCst);
            rig.working.finish(operation);
            assert_eq!(*rig.windows.affinities.lock().unwrap(), [0x11, 0x11]);
            assert_eq!(*rig.windows.call_affinities.lock().unwrap(), [(None, (Part::Dot, 1)), (None, (Part::Panel, 0))]);
            rig.windows.restore_fails.store(false, Ordering::SeqCst);
            if show_first {
                rig.windows.show(Part::Dot);
                rig.windows.show(Part::Panel);
                assert_eq!(*rig.windows.affinities.lock().unwrap(), [1, 0]);
                assert_eq!(*rig.windows.restored.lock().unwrap(), [(Part::Dot, 1, true), (Part::Panel, 0, true)]);
            }
            // Also exercise a new hide before any successful show: adopt the saved original.
            rig.windows.hide_for_operation(Part::Dot, operation + 1).unwrap();
            rig.windows.hide_for_operation(Part::Panel, operation + 1).unwrap();
            rig.windows.finish_restore(operation + 1);
            assert_eq!(*rig.windows.affinities.lock().unwrap(), [1, 0]);
            assert!(rig.windows.call_affinities.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn failed_restore_dispatch_releases_call_affinities_without_showing() {
        let rig = rig();
        let operation = rig.working.begin().unwrap();
        rig.main.fails.store(true, Ordering::SeqCst);
        rig.working.finish(operation);
        assert_eq!(rig.visible(), Visibility::default());
        assert!(rig.windows.call_affinities.lock().unwrap().is_empty(), "failed dispatch must release ownership");
    }

    #[test]
    fn restore_releases_call_affinities_even_when_the_user_hid_the_rose() {
        let rig = rig();
        let operation = rig.working.begin().unwrap();
        assert_eq!(*rig.windows.call_affinities.lock().unwrap(), [(Some(operation), (Part::Dot, 1)), (Some(operation), (Part::Panel, 0))]);
        rig.windows.rose_hidden.store(true, Ordering::SeqCst);
        rig.working.finish(operation);
        assert_eq!(rig.visible(), Visibility { dot: false, panel: true });
        assert!(rig.windows.call_affinities.lock().unwrap().is_empty(),
            "the hidden Dot's affinity must be restored and released when its call ends");
    }

    #[test]
    fn restoring_keeps_what_the_user_changed_meanwhile() {
        let hidden = BOTH;
        // "Hide the rose" during the call keeps the Dot hidden; a reopened panel is left alone.
        assert_eq!(to_restore(hidden, Visibility::default(), true), Visibility { dot: false, panel: true });
        assert_eq!(to_restore(hidden, Visibility { dot: false, panel: true }, false), Visibility { dot: true, panel: false });
        assert_eq!(to_restore(hidden, Visibility::default(), false), BOTH);
        // What the operation did not hide is never shown.
        assert_eq!(to_restore(Visibility::default(), Visibility::default(), false), Visibility::default());

        let rig = rig();
        let operation = rig.working.begin().unwrap();
        rig.windows.rose_hidden.store(true, Ordering::SeqCst);
        rig.windows.visible.lock().unwrap().panel = true;
        rig.working.finish(operation);
        assert_eq!(rig.log(), ["rings on 1", "hide dot", "hide panel", "rings off 1"]);
        assert_eq!(rig.visible(), Visibility { dot: false, panel: true });
        assert!(rig.windows.call_affinities.lock().unwrap().is_empty());
    }

    #[test]
    fn without_an_acknowledgement_nothing_is_hidden_and_the_wait_is_bounded() {
        let rig = rig();
        rig.on_show(|_, _| {});
        let started = Instant::now();
        assert_eq!(rig.working.begin(), Err(UNAVAILABLE.to_string()));
        let waited = started.elapsed();
        assert!(waited >= SHORT && waited < Duration::from_secs(2), "{waited:?}");
        assert_eq!(rig.log(), ["rings on 1", "rings off 1"]);
        assert_eq!(rig.visible(), BOTH);
        // A late acknowledgement revives nothing.
        assert!(!rig.working.ready(1));
        assert_eq!(rig.log(), ["rings on 1", "rings off 1"]);
    }

    #[test]
    fn an_acknowledgement_must_name_the_running_operation() {
        let rig = rig();
        assert!(!rig.working.ready(1), "nothing runs yet");
        rig.on_show(|working, operation| {
            working.ready(operation + 1);
            working.ready(operation - 1);
        });
        assert_eq!(rig.working.begin(), Err(UNAVAILABLE.to_string()));
        assert_eq!(rig.visible(), BOTH);
        assert!(!rig.working.is_current(1));
    }

    #[test]
    fn only_the_glow_window_acknowledges() {
        let rig = rig();
        let answers: Arc<Mutex<Vec<Result<bool, String>>>> = Arc::default();
        let seen = answers.clone();
        rig.on_show(move |working, operation| {
            let mut seen = seen.lock().unwrap();
            seen.push(working.acknowledge("panel", operation));
            seen.push(working.acknowledge("dot", operation));
            seen.push(working.acknowledge("glow", operation + 7));
            seen.push(working.acknowledge("glow", operation));
        });
        let operation = rig.working.begin().unwrap();
        let answers = answers.lock().unwrap().clone();
        assert!(answers[0].is_err() && answers[1].is_err(), "{answers:?}");
        assert_eq!(answers[2..], [Ok(false), Ok(true)]);
        rig.working.finish(operation);
        assert_eq!(rig.working.acknowledge("glow", operation), Ok(false));
    }

    #[test]
    fn a_rings_failure_hides_nothing_and_does_not_wait() {
        let rig = rig_with(BOTH, Duration::from_secs(5));
        rig.rings.fails.store(true, Ordering::SeqCst);
        let started = Instant::now();
        assert_eq!(rig.working.begin(), Err(UNAVAILABLE.to_string()));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(rig.log().iter().all(|line| !line.starts_with("hide")), "{:?}", rig.log());
        assert_eq!(rig.visible(), BOTH);
        assert!(!rig.working.is_current(1));
    }

    #[test]
    fn a_hide_failure_puts_back_what_was_hidden_and_fails() {
        let rig = rig();
        *rig.windows.fails.lock().unwrap() = Some(Part::Panel);
        assert_eq!(rig.working.begin(), Err(NOT_HIDDEN.to_string()));
        assert_eq!(rig.log(), ["rings on 1", "hide dot", "rings off 1", "show dot"]);
        assert_eq!(rig.visible(), BOTH);
    }

    #[test]
    fn a_session_end_while_waiting_for_the_rings_fails_at_once() {
        let rig = rig_with(BOTH, Duration::from_secs(5));
        rig.on_show(|working, _| working.session_ended());
        let started = Instant::now();
        assert!(rig.working.begin().is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(rig.log(), ["rings on 1", "rings off 1"]);
        assert_eq!(rig.visible(), BOTH);
    }

    #[test]
    fn a_stop_before_the_queued_hide_runs_hides_nothing() {
        let rig = rig_with(BOTH, Duration::from_secs(5));
        rig.main.deferred.store(true, Ordering::SeqCst);
        let working = Arc::downgrade(&rig.working);
        *rig.main.after_queue.lock().unwrap() = Some(Box::new(move || {
            if let Some(working) = working.upgrade() {
                working.session_ended();
            }
        }));
        assert!(rig.working.begin().is_err());
        rig.main.drain();
        assert_eq!(rig.log(), ["rings on 1", "rings off 1"]);
        assert_eq!(rig.visible(), BOTH);
    }

    #[test]
    fn a_session_end_during_an_operation_puts_everything_back_at_once() {
        let rig = rig();
        let operation = rig.working.begin().unwrap();
        rig.working.session_ended();
        assert_eq!(rig.visible(), BOTH);
        assert!(!rig.working.is_current(operation));
        // The call's own finish comes later and does nothing more.
        rig.working.finish(operation);
        assert_eq!(rig.log(), ["rings on 1", "hide dot", "hide panel", "rings off 1", "show dot", "show panel"]);
    }

    #[test]
    fn a_late_finish_leaves_a_newer_operation_alone() {
        let rig = rig();
        let first = rig.working.begin().unwrap();
        rig.working.finish(first);
        let second = rig.working.begin().unwrap();
        assert_eq!(second, first + 1);
        rig.working.finish(first);
        assert!(rig.working.is_current(second));
        assert_eq!(rig.visible(), Visibility::default());
        rig.working.finish(second);
        assert_eq!(rig.visible(), BOTH);
        assert_eq!(rig.log().iter().filter(|line| line.starts_with("rings off")).count(), 2);
    }

    #[test]
    fn the_working_event_names_its_operation() {
        let event = WorkingEvent { active: true, operation_id: 3 };
        assert_eq!(serde_json::to_value(event).unwrap(), serde_json::json!({"active": true, "operationId": 3}));
        assert_eq!(WORKING_EVENT, "computer://working");
    }
}
