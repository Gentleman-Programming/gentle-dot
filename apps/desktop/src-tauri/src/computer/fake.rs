//! Test doubles: a Mac that records events, scripted dialogs, and a clock that sleeps instantly.

use super::blocklist::AppIdentity;
use super::coords::{Point, ScreenshotGeometry};
use super::risk::{AxElement, Focus};
use super::{AppInfo, Capture, Clock, Desktop, Dialogs, InputEvent, Permissions};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

pub fn app(pid: i32, bundle: &str, name: &str) -> AppIdentity {
    AppIdentity { pid, bundle_id: Some(bundle.into()), name: name.into() }
}

type OwnerAt = Box<dyn Fn(Point) -> Option<AppIdentity> + Send + Sync>;

pub struct FakeDesktop {
    pub events: Mutex<Vec<InputEvent>>,
    pub permissions: Mutex<Permissions>,
    pub frontmost: Mutex<Option<AppIdentity>>,
    pub focused_app: Mutex<Option<AppIdentity>>,
    pub owner_at: Mutex<OwnerAt>,
    pub elements: Mutex<Vec<AxElement>>,
    pub focus: Mutex<Option<Focus>>,
    pub opened: Mutex<Vec<String>>,
    pub activated: Mutex<Vec<i32>>,
    pub captures: AtomicUsize,
    /// A 2560 × 1600 pt display at the origin, captured at 1280 × 800 (scale 0.5).
    pub geometry: ScreenshotGeometry,
}

impl Default for FakeDesktop {
    fn default() -> Self {
        let safari = app(200, "com.apple.Safari", "Safari");
        let owner = safari.clone();
        FakeDesktop {
            events: Mutex::new(Vec::new()),
            permissions: Mutex::new(Permissions { accessibility: true, screen_recording: true, screenshots_supported: true }),
            frontmost: Mutex::new(Some(safari)),
            focused_app: Mutex::new(None),
            owner_at: Mutex::new(Box::new(move |_| Some(owner.clone()))),
            elements: Mutex::new(Vec::new()),
            focus: Mutex::new(None),
            opened: Mutex::new(Vec::new()),
            activated: Mutex::new(Vec::new()),
            captures: AtomicUsize::new(0),
            geometry: ScreenshotGeometry::for_display(Point { x: 0.0, y: 0.0 }, 2560.0, 1280, 800),
        }
    }
}

impl FakeDesktop {
    pub fn events(&self) -> Vec<InputEvent> {
        self.events.lock().unwrap().clone()
    }
}

impl Desktop for FakeDesktop {
    fn permissions(&self) -> Permissions {
        *self.permissions.lock().unwrap()
    }

    fn capture(&self) -> Result<Capture, String> {
        self.captures.fetch_add(1, Ordering::SeqCst);
        Ok(Capture { data: b"jpeg".to_vec(), mime_type: "image/jpeg", geometry: self.geometry })
    }

    fn post(&self, event: &InputEvent) -> Result<(), String> {
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }

    fn list_apps(&self) -> Result<Vec<AppInfo>, String> {
        Ok(vec![
            AppInfo { name: "Safari".into(), bundle_id: Some("com.apple.Safari".into()), active: true },
            AppInfo { name: "Mail".into(), bundle_id: Some("com.apple.mail".into()), active: false },
        ])
    }

    fn open_app(&self, name: &str) -> Result<(), String> {
        self.opened.lock().unwrap().push(name.into());
        Ok(())
    }

    fn element_at(&self, _at: Point) -> Vec<AxElement> {
        self.elements.lock().unwrap().clone()
    }

    fn focused_element(&self) -> Option<Focus> {
        self.focus.lock().unwrap().clone()
    }

    fn frontmost_app(&self) -> Option<AppIdentity> {
        self.frontmost.lock().unwrap().clone()
    }

    fn focused_app(&self) -> Option<AppIdentity> {
        self.focused_app.lock().unwrap().clone()
    }

    fn window_owner_at(&self, at: Point) -> Option<AppIdentity> {
        (self.owner_at.lock().unwrap())(at)
    }

    fn activate(&self, pid: i32) {
        self.activated.lock().unwrap().push(pid);
    }
}

type Hook = Box<dyn Fn() + Send + Sync>;

/// Answers dialogs with fixed choices and records what was asked.
pub struct FakeDialogs {
    pub allow: Mutex<bool>,
    pub confirm: Mutex<bool>,
    pub grants: AtomicUsize,
    pub confirmations: Mutex<Vec<String>>,
    pub yolo: Mutex<bool>,
    pub yolo_asks: AtomicUsize,
    /// Runs while a dialog is open (for example, to move the focus to Gentle Dot).
    pub during: Mutex<Option<Hook>>,
}

impl FakeDialogs {
    pub fn new(allow: bool, confirm: bool) -> Self {
        FakeDialogs {
            allow: Mutex::new(allow),
            confirm: Mutex::new(confirm),
            grants: AtomicUsize::new(0),
            confirmations: Mutex::new(Vec::new()),
            yolo: Mutex::new(true),
            yolo_asks: AtomicUsize::new(0),
            during: Mutex::new(None),
        }
    }

    fn run_hook(&self) {
        if let Some(hook) = self.during.lock().unwrap().as_ref() {
            hook();
        }
    }
}

impl Dialogs for FakeDialogs {
    fn ask_grant(&self) -> bool {
        self.grants.fetch_add(1, Ordering::SeqCst);
        self.run_hook();
        *self.allow.lock().unwrap()
    }

    fn confirm(&self, message: &str) -> bool {
        self.confirmations.lock().unwrap().push(message.into());
        self.run_hook();
        *self.confirm.lock().unwrap()
    }

    fn ask_yolo(&self) -> bool {
        self.yolo_asks.fetch_add(1, Ordering::SeqCst);
        *self.yolo.lock().unwrap()
    }
}

/// Starts at a fixed time; `sleep_ms` advances it and runs `on_sleep`.
pub struct FakeClock {
    pub now: AtomicU64,
    pub on_sleep: Mutex<Option<Hook>>,
}

impl FakeClock {
    pub fn new(now: u64) -> Self {
        FakeClock { now: AtomicU64::new(now), on_sleep: Mutex::new(None) }
    }

    pub fn advance(&self, ms: u64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }

    fn sleep_ms(&self, ms: u64) {
        self.advance(ms);
        if let Some(hook) = self.on_sleep.lock().unwrap().as_ref() {
            hook();
        }
    }
}
