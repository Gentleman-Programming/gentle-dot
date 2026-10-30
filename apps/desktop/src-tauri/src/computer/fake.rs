//! Test doubles: a Mac that records events, scripted dialogs, and a clock that sleeps instantly.

use super::blocklist::AppIdentity;
use super::coords::{Point, ScreenshotGeometry};
use super::risk::{AxElement, Focus};
use super::{AppInfo, Capture, Clock, Desktop, Dialogs, InputEvent, KeyboardRecipient, Permissions};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

pub fn app(pid: i32, bundle: &str, name: &str) -> AppIdentity {
    AppIdentity { pid, bundle_id: Some(bundle.into()), name: name.into() }
}

type OwnerAt = Box<dyn Fn(Point) -> Option<AppIdentity> + Send + Sync>;

pub struct FakeDesktop {
    pub events: Mutex<Vec<InputEvent>>,
    pub typed_posts: Mutex<Vec<(InputEvent, KeyboardRecipient)>>,
    pub permissions: Mutex<Permissions>,
    pub frontmost: Mutex<Option<AppIdentity>>,
    pub focused_app: Mutex<Option<AppIdentity>>,
    /// Changes the foreground app after this many recorded posts; disabled by default.
    pub front_after_posts: Mutex<Option<(usize, AppIdentity)>>,
    /// What comes to the front while the next capture is taken (once).
    pub front_during_capture: Mutex<Option<AppIdentity>>,
    pub focused_after_posts: Mutex<Option<(usize, AppIdentity)>>,
    /// One-shot hook after the initial keyboard guard, before input is posted.
    pub during_focused_element: Mutex<Option<Hook>>,
    /// Refuse the Nth post before recording it.
    pub fail_post: Mutex<Option<(usize, String)>>,
    pub owner_at: Mutex<OwnerAt>,
    pub elements: Mutex<Vec<AxElement>>,
    pub focus: Mutex<Option<Focus>>,
    pub opened: Mutex<Vec<String>>,
    pub activated: Mutex<Vec<i32>>,
    /// What `activate` brings to the front, when it succeeds (by default it only records the pid).
    pub activates_to: Mutex<Option<AppIdentity>>,
    /// How many activations it takes before `activates_to` is in front (Windows and macOS hand
    /// the focus over a moment later).
    pub activations_needed: Mutex<usize>,
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
            typed_posts: Mutex::new(Vec::new()),
            permissions: Mutex::new(Permissions { accessibility: true, screen_recording: true, screenshots_supported: true }),
            frontmost: Mutex::new(Some(safari)),
            focused_app: Mutex::new(None),
            front_after_posts: Mutex::new(None),
            front_during_capture: Mutex::new(None),
            focused_after_posts: Mutex::new(None),
            during_focused_element: Mutex::new(None),
            fail_post: Mutex::new(None),
            owner_at: Mutex::new(Box::new(move |_| Some(owner.clone()))),
            elements: Mutex::new(Vec::new()),
            focus: Mutex::new(None),
            opened: Mutex::new(Vec::new()),
            activated: Mutex::new(Vec::new()),
            activates_to: Mutex::new(None),
            activations_needed: Mutex::new(1),
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
        if let Some(app) = self.front_during_capture.lock().unwrap().take() {
            *self.frontmost.lock().unwrap() = Some(app);
        }
        Ok(Capture { data: b"jpeg".to_vec(), mime_type: "image/jpeg", geometry: self.geometry })
    }

    fn post(&self, event: &InputEvent) -> Result<(), String> {
        let count = {
            let mut events = self.events.lock().unwrap();
            if let Some((post, error)) = self.fail_post.lock().unwrap().as_ref() {
                if events.len() + 1 == *post {
                    return Err(error.clone());
                }
            }
            events.push(event.clone());
            events.len()
        };
        if let Some((posts, app)) = self.front_after_posts.lock().unwrap().as_ref() {
            if count == *posts {
                *self.frontmost.lock().unwrap() = Some(app.clone());
            }
        }
        if let Some((posts, app)) = self.focused_after_posts.lock().unwrap().as_ref() {
            if count == *posts {
                *self.focused_app.lock().unwrap() = Some(app.clone());
            }
        }
        Ok(())
    }

    fn post_typed(&self, event: &InputEvent, recipient: &KeyboardRecipient) -> Result<(), String> {
        self.typed_posts.lock().unwrap().push((event.clone(), *recipient));
        self.post(event)
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
        let during = self.during_focused_element.lock().unwrap().take();
        if let Some(during) = during {
            during();
        }
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
        let count = {
            let mut activated = self.activated.lock().unwrap();
            activated.push(pid);
            activated.len()
        };
        if count < *self.activations_needed.lock().unwrap() {
            return;
        }
        if let Some(app) = self.activates_to.lock().unwrap().clone() {
            *self.frontmost.lock().unwrap() = Some(app);
        }
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
