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
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
mod macos;
pub mod mcp;
pub mod rate;
pub mod risk;
pub mod server;
pub mod session;
pub mod windows;
pub mod working;

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

/// The `computer_permissions` reply (L60), plus `screenshotsSupported` (false before macOS 14,
/// where ScreenCaptureKit cannot take screenshots).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub accessibility: bool,
    pub screen_recording: bool,
    pub screenshots_supported: bool,
}

/// Which macOS permission the user is asked for (`computer_request_permission {kind}`, L60).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionKind {
    Accessibility,
    ScreenRecording,
}

/// An explicit keyboard-focus target (S4, S5): the compositor window that holds the
/// keyboard focus, which is a different fact from the app that owns it. Two windows of
/// one process are different targets, so a dialog restores and an action verifies by
/// `window_id`, never by pid alone. On Linux the pid comes straight from the Niri
/// `FocusedWindow` reply (`Window.pid`), and is used only to exclude Gentle Dot's own
/// window; a missing pid fails closed for keyboard input instead of guessing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FocusTarget {
    /// Compositor window id; the target's identity.
    pub window_id: u64,
    /// Owning process when the compositor reports it. Never the target identity.
    pub pid: Option<i32>,
    /// Window title, for messages only.
    pub title: Option<String>,
    /// App id, for messages only; never matched as a substring to exclude an app.
    pub app_id: Option<String>,
}

/// The Mac, as the helper sees it.
pub trait Desktop: Send + Sync {
    fn permissions(&self) -> Permissions;
    /// A screenshot of the display under the pointer, downscaled to `coords::MAX_LONG_EDGE`.
    fn capture(&self) -> Result<Capture, String>;
    fn post(&self, event: &InputEvent) -> Result<(), String>;
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
    /// The window holding the keyboard focus right now, when this platform can name one.
    /// `Ok(None)` means "cannot tell", never "no window is focused"; `Err` is a truthful
    /// query failure. The default is `Ok(None)`, so macOS keeps its pid-based frontmost
    /// path unchanged.
    fn focused_window(&self) -> Result<Option<FocusTarget>, String> {
        Ok(None)
    }
    /// Focuses the exact window named by `target` again after a dialog took the focus.
    /// Must fail when that cannot be done (window gone, no reply); never a pid or
    /// first-window fallback. The default fails closed, and macOS never calls it.
    fn focus_window(&self, target: &FocusTarget) -> Result<(), String> {
        let _ = target;
        Err("This platform cannot focus a window by identity, so nothing was posted.".into())
    }
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

/// Which desktop a `mcp::Helper` drives (T2, S3-S5). This is an explicit backend
/// policy, never a fabricated app identity: the Mac path keeps resolving a per-app
/// target, while stock Wayland (Niri first) has no Accessibility equivalent, so the
/// whole desktop is the only truthful target and per-app blocking is unavailable.
/// The Linux backend (`linux::backend` + `linux::desktop`) drives `DesktopGlobal`
/// in production behind the app's start gate; fake-backend tests still pin the
/// policy through the Helper MCP interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BackendPolicy {
    /// macOS: every pointer/key action resolves and checks its per-app target (default).
    #[default]
    Targeted,
    /// Linux/Wayland: pointer input goes to the point and keyboard input to the window that
    /// held the focus when the action started (window id, never app pid), with no reliable
    /// per-app exclusion. Sessions, Stop, rate limits, and detected-risk approval still apply.
    DesktopGlobal,
}

/// The truthful target named in global-mode confirmations and results.
pub const GLOBAL_TARGET: &str = "the Linux desktop";

/// Grant copy for the Linux consent UI (T5c): desktop-global, 30 minutes, no
/// per-app exclusion promised. Asked by `linux::dialogs` before a session starts.
pub const GLOBAL_GRANT_TEXT: &str = "Allow Gentle Dot to see and control this Linux desktop for 30 minutes? \
There is no reliable per-app exclusion: every visible app can receive input.";

/// Yolo copy for the Linux consent UI: the same promise as the app-layer text, but
/// the Stop fallback is the binding this desktop really has. The Mac notation is
/// meaningless here, so it must never reach this string.
pub const GLOBAL_YOLO_TEXT: &str = "Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you first, \
for up to 1 hour. Stop and Alt+Shift+Escape still work.";

impl BackendPolicy {
    /// One line for logs and the pending consent UI, naming what the user authorizes.
    pub fn describe(&self) -> &'static str {
        match self {
            BackendPolicy::Targeted => "application-targeted control",
            BackendPolicy::DesktopGlobal => "desktop-global control without reliable per-app exclusion",
        }
    }
}

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
