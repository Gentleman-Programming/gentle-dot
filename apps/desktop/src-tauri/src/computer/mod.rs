//! Computer control (S24): a native helper inside the app that serves MCP on loopback so the
//! agent can see and drive the Mac. Every rule (session grant, blocklist, rate limit, risky
//! action confirmation, panic stop) lives here, outside the agent's reach.
//!
//! The rules are pure modules tested on every OS. `Desktop` is the seam to the real Mac
//! (`macos`), and `fake` records events for the tests. Off macOS the helper does not start.

pub mod app;
pub mod blocklist;
pub mod control;
pub mod coords;
pub mod encode;
pub mod glow;
#[cfg(test)]
mod fake;
pub mod keys;
#[cfg(target_os = "macos")]
mod macos;
pub mod mcp;
pub mod rate;
pub mod risk;
pub mod server;
pub mod session;
pub mod windows;
#[cfg(windows)]
pub(crate) mod win;
// The Windows desktop's pure parts, tested everywhere: UI Automation element mapping, which
// processes are apps, and what Windows posts for each input event. The Windows desktop backend
// widens each to `any(windows, test)` once it uses it.
#[cfg(any(windows, test))]
pub mod winaccess;
#[cfg(any(windows, test))]
pub mod winapps;
#[cfg(any(windows, test))]
pub mod winput;
pub mod working;

// Windows capture ordering, kept platform-independent so CI exercises the contract.
#[cfg(any(windows, test))]
mod capture_order {
    pub(super) fn capture<T>(flush: impl FnOnce() -> Result<(), String>, grab: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        flush()?;
        grab()
    }

    pub(super) fn hide<T>(exclude: impl FnOnce() -> Result<T, String>, hide: impl FnOnce()) -> Result<T, String> {
        let excluded = exclude();
        hide();
        excluded
    }

    pub(super) fn show(show: impl FnOnce(), restore: impl FnOnce()) {
        show();
        restore();
    }

    /// The process-lifetime handles recorded at window creation, as plain values.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(super) struct CallHandles {
        pub(super) dot: Option<usize>,
        pub(super) panel: Option<usize>,
    }

    impl CallHandles {
        pub(super) fn get(&self, part: super::working::Part) -> Option<usize> {
            match part {
                super::working::Part::Dot => self.dot,
                super::working::Part::Panel => self.panel,
            }
        }
    }

    /// Match only the process-lifetime handles recorded at window creation. No resolver or
    /// main-thread dispatch is permitted here: callers may hold the affinity lock on a worker.
    /// `handles` is a value answered by an exhaustive match, so a new part cannot go unmatched.
    pub(super) fn current_window(saved: &[(Option<u64>, (super::working::Part, u32))], hwnd: usize,
        handles: CallHandles) -> Option<usize> {
        saved.iter().position(|(_, (window, _))| handles.get(*window) == Some(hwnd))
    }

    /// End call ownership, retaining an ownerless recovery value if native restoration fails.
    /// Callers keep at most one entry per window and adopt it on a later hide.
    pub(super) fn release<T: Copy>(saved: &mut Vec<(Option<u64>, T)>, operation: u64, mut restore: impl FnMut(T) -> bool) {
        saved.retain_mut(|(owner, entry)| {
            if *owner != Some(operation) { return true; }
            *owner = None;
            !restore(*entry)
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::RefCell;

        #[test]
        fn matching_under_the_affinity_lock_never_dispatches_a_window_query() {
            let saved = std::sync::Mutex::new(vec![(Some(1), (super::super::working::Part::Dot, 7))]);
            let guard = saved.lock().unwrap();
            // The API accepts only recorded values, so querying Tauri is not possible here.
            let recorded = CallHandles { dot: Some(101), panel: Some(102) };
            assert_eq!(current_window(&guard, 101, recorded), Some(0));
            assert_eq!(current_window(&guard, 201, recorded), None);
            assert_eq!(current_window(&guard, 101, CallHandles { dot: None, panel: None }), None);
        }

        #[test]
        fn release_restores_original_values_and_leaves_no_stale_entry_for_the_next_call() {
            let mut saved = vec![(Some(10), (1, 7)), (Some(10), (2, 0)), (Some(11), (3, 9))];
            let mut restored = Vec::new();
            release(&mut saved, 10, |entry| { restored.push(entry); true });
            assert_eq!(restored, [(1, 7), (2, 0)]);
            assert_eq!(saved, [(Some(11), (3, 9))]);
            release(&mut saved, 11, |_| true);
            assert!(saved.is_empty());
            // The next hide can save a different current affinity for the same window.
            saved.push((Some(12), (1, 9)));
            release(&mut saved, 12, |entry| { restored.push(entry); true });
            assert_eq!(restored.last(), Some(&(1, 9)));
            assert!(saved.is_empty());
            // Native failure ends call ownership but must not discard the true original.
            saved.push((Some(12), (1, 9)));
            release(&mut saved, 12, |_| false);
            assert_eq!(saved, [(None, (1, 9))]);
            release(&mut saved, 12, |_| panic!("an old call cannot touch recovery state"));
            assert_eq!(saved, [(None, (1, 9))]);
        }

        #[test]
        fn capture_waits_even_without_new_exclusions() {
            let events = RefCell::new(Vec::new());
            capture(|| { events.borrow_mut().push("flush"); Ok(()) }, || { events.borrow_mut().push("grab"); Ok(()) }).unwrap();
            assert_eq!(*events.borrow(), ["flush", "grab"]);
        }

        #[test]
        fn failed_composition_never_grabs() {
            let result = capture(|| Err("composition failed".into()), || panic!("must not grab"));
            assert_eq!(result, Err::<(), _>("composition failed".into()));
        }

        #[test]
        fn exclusion_spans_hide_through_show() {
            let events = RefCell::new(Vec::new());
            let previous = hide(|| { events.borrow_mut().push("exclude"); Ok(7) }, || events.borrow_mut().push("hide")).unwrap();
            show(|| events.borrow_mut().push("show"), || { assert_eq!(previous, 7); events.borrow_mut().push("restore"); });
            assert_eq!(*events.borrow(), ["exclude", "hide", "show", "restore"]);
        }

        #[test]
        fn failed_exclusion_still_hides_and_remains_an_error() {
            let hidden = std::cell::Cell::new(false);
            let result = hide(|| Err::<(), _>("exclusion failed".into()), || hidden.set(true));
            assert!(hidden.get());
            assert_eq!(result, Err("exclusion failed".into()));
        }
    }
}

use blocklist::AppIdentity;
use coords::{Point, ScreenshotGeometry};
use keys::KeyCombo;
use risk::{AxElement, Focus};
use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
pub use macos::{request_permission, MacDesktop};


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
}

/// One input the helper posts. Points are global, in points.
#[derive(Debug, Clone, PartialEq)]
pub enum InputEvent {
    Move(Point),
    Click { at: Point, button: MouseButton, count: u8 },
    Drag { from: Point, to: Point },
    /// `dy > 0` scrolls down and `dx > 0` scrolls right, in pixels.
    Scroll { at: Point, dx: i32, dy: i32 },
    Key(KeyCombo),
    /// A chunk of text without newlines (newlines are sent as Return).
    Text(String),
}

/// An encoded screenshot of the display under the pointer, Gentle Dot's windows excluded.
#[derive(Debug, Clone)]
pub struct Capture {
    pub data: Vec<u8>,
    pub mime_type: &'static str,
    pub geometry: ScreenshotGeometry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub bundle_id: Option<String>,
    pub active: bool,
}

/// The permissions in the `computer_permissions` answer (L60), plus `screenshotsSupported`: false before macOS 14,
/// where ScreenCaptureKit cannot take screenshots, and before Windows 10 version 2004, which
/// cannot leave Gentle Dot's windows out of them. `screenshotsUnsupported` says why, only when
/// they are unsupported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub accessibility: bool,
    pub screen_recording: bool,
    pub screenshots_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshots_unsupported: Option<ScreenshotsUnsupported>,
}

/// Why screenshots are unsupported. Either way there are none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenshotsUnsupported {
    /// Before macOS 14, or before Windows 10 version 2004.
    TooOld,
    /// Windows' build number could not be read, so it is not trusted to be recent enough.
    UnknownVersion,
}

/// Which macOS permission the user is asked for (`computer_request_permission {kind}`, L60).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionKind {
    Accessibility,
    ScreenRecording,
}

/// Why typing stopped when the app receiving the keys changed, once part of the text was sent and
/// before any of it was (shared by the helper and the Windows backend).
pub const KEYS_CHANGED_WHILE_TYPING: &str = "The app receiving the keys changed while typing, so the rest was not sent.";
pub const KEYS_CHANGED_BEFORE_TYPING: &str = "The app receiving the keys changed before typing, so nothing was sent.";

/// Why a typed post (`Desktop::post_typed`) did not go through. All but `Failed` are refusals
/// before anything of that post was sent; only the helper knows how much of the text went out
/// before it, so it words them (`message`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypedError {
    /// The windows in front no longer belong to the approved recipient.
    RecipientChanged,
    /// The system did not say which window is in front.
    FrontUnknown,
    /// The window in front has no keyboard focus, so where the keys would go is not the approved
    /// recipient's field.
    NoFocus,
    /// Windows reported modifiers down before the post pressed any keys of its own: the user's,
    /// or one a failed post could not release.
    HeldModifiers(Vec<&'static str>),
    /// Posting failed; part of the post may have been sent.
    Failed(String),
}

impl TypedError {
    /// The error for the agent, given whether earlier posts of the same action already sent part
    /// of it.
    pub fn message(&self, sent: bool) -> String {
        match (self, sent) {
            (TypedError::RecipientChanged, false) => KEYS_CHANGED_BEFORE_TYPING.into(),
            (TypedError::RecipientChanged, true) => KEYS_CHANGED_WHILE_TYPING.into(),
            (TypedError::FrontUnknown, false) => "Cannot tell which window is in front, so nothing was sent.".into(),
            (TypedError::FrontUnknown, true) => "Cannot tell which window is in front, so the rest was not sent.".into(),
            (TypedError::NoFocus, false) => "The window in front has no keyboard focus, so nothing was sent.".into(),
            (TypedError::NoFocus, true) => "The window in front has no keyboard focus, so the rest was not sent.".into(),
            (TypedError::HeldModifiers(keys), sent) => {
                let unsent = if sent { "the rest was not sent" } else { "nothing was sent" };
                match keys.as_slice() {
                    [key] => format!(
                        "{key} is pressed, so {unsent}. Release {key}, or press and release it once if no one is holding it, and try again."
                    ),
                    [rest @ .., last] => format!(
                        "{} and {last} are pressed, so {unsent}. Release them, or press and release each once if no one is holding them, and try again.",
                        rest.join(", ")
                    ),
                    [] => format!("A modifier is pressed, so {unsent}."),
                }
            }
            (TypedError::Failed(error), _) => error.clone(),
        }
    }
}

/// Why keys are not sent to an app that runs as administrator (Windows drops them silently).
pub fn runs_as_administrator(name: &str) -> String {
    format!("{name} runs as administrator, so Gentle Dot cannot send it keys.")
}

/// The approved front app and any distinct process receiving its keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyboardRecipient {
    pub front_pid: i32,
    pub focused_pid: Option<i32>,
}

/// The Mac, as the helper sees it.
pub trait Desktop: Send + Sync {
    /// Why keyboard input must not go to `app` on this platform (an elevated app on Windows, which
    /// silently drops input from Gentle Dot), or none.
    fn keyboard_refusal(&self, _app: &AppIdentity) -> Option<String> {
        None
    }
    fn permissions(&self) -> Permissions;
    /// A screenshot of the display under the pointer, downscaled to `coords::MAX_LONG_EDGE`.
    fn capture(&self) -> Result<Capture, String>;
    fn post(&self, event: &InputEvent) -> Result<(), String>;
    /// Posts a type chunk or Return bound to the recipient approved by the shared guard.
    /// Platforms with targeted input checks can validate it immediately before sending.
    fn post_typed(&self, event: &InputEvent, _recipient: &KeyboardRecipient) -> Result<(), TypedError> {
        self.post(event).map_err(TypedError::Failed)
    }
    fn list_apps(&self) -> Result<Vec<AppInfo>, String>;
    /// Opens (or activates) an app by name or bundle id.
    fn open_app(&self, name: &str) -> Result<(), String>;
    /// The Accessibility element at a point, then its ancestors; empty when unknown.
    fn element_at(&self, at: Point) -> Vec<AxElement>;
    fn focused_element(&self) -> Option<Focus>;
    fn frontmost_app(&self) -> Option<AppIdentity>;
    /// The app owning the focused Accessibility element, which can differ from the frontmost
    /// app (a non-activating panel such as a password manager's quick access).
    fn focused_app(&self) -> Option<AppIdentity>;
    /// The app owning the topmost window under a point.
    fn window_owner_at(&self, at: Point) -> Option<AppIdentity>;
    /// Brings an app back to the front (after a dialog took the focus).
    fn activate(&self, pid: i32);
}

/// Native dialogs owned by the app, never the webview (S24.3, S24.4).
pub trait Dialogs: Send + Sync {
    /// "Allow Gentle Dot to see and control this Mac for 30 minutes?" (Allow / Deny).
    fn ask_grant(&self) -> bool;
    /// A per-action confirmation showing the action and its target.
    fn confirm(&self, message: &str) -> bool;
    /// "Turn on yolo mode? ..." (Turn On / Cancel), S24.9.
    fn ask_yolo(&self) -> bool;
}

pub trait Clock: Send + Sync {
    /// Unix epoch milliseconds.
    fn now_ms(&self) -> u64;
    fn sleep_ms(&self, ms: u64);
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or_default()
    }

    fn sleep_ms(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}
