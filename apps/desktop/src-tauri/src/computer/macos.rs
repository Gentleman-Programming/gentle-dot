//! The real Mac behind `Desktop`: ScreenCaptureKit screenshots (macOS 14+), Quartz events,
//! the Accessibility API, and NSWorkspace. Nothing here decides policy; `mcp` does.

use super::blocklist::AppIdentity;
use super::coords::{fit_long_edge, Point, ScreenshotGeometry, MAX_LONG_EDGE};
use super::encode::{bgra_to_jpeg, JPEG_QUALITY};
use super::keys::KeyCombo;
use super::risk::{AxElement, Focus};
use super::{AppInfo, Capture, Desktop, InputEvent, MouseButton, PermissionKind, Permissions};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::{available, AnyThread};
use objc2_app_kit::{NSApplicationActivationOptions, NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace};
use objc2_application_services::{AXError, AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXUIElement};
use objc2_core_foundation::{CFBoolean, CFDictionary, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    kCGNullWindowID, kCGWindowAlpha, kCGWindowBounds, kCGWindowOwnerName, kCGWindowOwnerPID, CGDataProvider, CGDirectDisplayID, CGError, CGEvent, CGEventField, CGEventFlags,
    CGEventTapLocation, CGEventType, CGGetDisplaysWithPoint, CGImage, CGMouseButton,
    CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess, CGScrollEventUnit, CGWindowListCopyWindowInfo,
    CGWindowListOption,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSString};
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow,
};
use std::ptr::NonNull;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
/// Pause between the events of one action, so apps see distinct presses.
const EVENT_GAP: Duration = Duration::from_millis(15);
const DRAG_STEPS: u32 = 12;
/// How many ancestors of the element under a point are read (text inside a button).
const AX_ANCESTORS: usize = 4;
/// `kCVPixelFormatType_32BGRA`.
const PIXEL_FORMAT_BGRA: u32 = u32::from_be_bytes(*b"BGRA");

/// Values crossing from a ScreenCaptureKit completion handler to the waiting thread.
/// The objects are immutable snapshots, used by one thread at a time.
struct Handoff<T>(T);
unsafe impl<T> Send for Handoff<T> {}

pub struct MacDesktop {
    own_pid: i32,
}

impl Default for MacDesktop {
    fn default() -> Self {
        MacDesktop { own_pid: std::process::id() as i32 }
    }
}

fn identity(app: &NSRunningApplication) -> AppIdentity {
    AppIdentity {
        pid: app.processIdentifier(),
        bundle_id: app.bundleIdentifier().map(|b| b.to_string()),
        name: app.localizedName().map(|n| n.to_string()).unwrap_or_default(),
    }
}

fn post_event(event: Option<CFRetained<CGEvent>>) -> Result<(), String> {
    let event = event.ok_or("macOS could not create the input event")?;
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    thread::sleep(EVENT_GAP);
    Ok(())
}

fn mouse(kind: CGEventType, at: Point, button: CGMouseButton) -> Option<CFRetained<CGEvent>> {
    CGEvent::new_mouse_event(None, kind, CGPoint { x: at.x, y: at.y }, button)
}

/// The held modifiers of a combo: their key codes (`kVK_Command`, ...) and flags.
fn modifiers(combo: &KeyCombo) -> Vec<(u16, CGEventFlags)> {
    let m = combo.modifiers;
    [
        (m.cmd, 55, CGEventFlags::MaskCommand),
        (m.shift, 56, CGEventFlags::MaskShift),
        (m.alt, 58, CGEventFlags::MaskAlternate),
        (m.ctrl, 59, CGEventFlags::MaskControl),
        (m.fn_key, 63, CGEventFlags::MaskSecondaryFn),
    ]
    .into_iter()
    .filter(|(on, ..)| *on)
    .map(|(_, code, flag)| (code, flag))
    .collect()
}

fn key_event(code: u16, down: bool, flags: CGEventFlags) -> Result<(), String> {
    let event = CGEvent::new_keyboard_event(None, code, down);
    if let Some(event) = &event {
        CGEvent::set_flags(Some(event), flags);
    }
    post_event(event)
}

fn click(at: Point, button: MouseButton, count: u8) -> Result<(), String> {
    let (down, up, cg_button) = match button {
        MouseButton::Left => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left),
        MouseButton::Right => (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right),
    };
    post_event(mouse(CGEventType::MouseMoved, at, CGMouseButton::Left))?;
    for state in 1..=i64::from(count) {
        for kind in [down, up] {
            let event = mouse(kind, at, cg_button);
            if let Some(event) = &event {
                CGEvent::set_integer_value_field(Some(event), CGEventField::MouseEventClickState, state);
            }
            post_event(event)?;
        }
    }
    Ok(())
}

fn drag(from: Point, to: Point) -> Result<(), String> {
    post_event(mouse(CGEventType::MouseMoved, from, CGMouseButton::Left))?;
    post_event(mouse(CGEventType::LeftMouseDown, from, CGMouseButton::Left))?;
    for step in 1..=DRAG_STEPS {
        let t = f64::from(step) / f64::from(DRAG_STEPS);
        let at = Point { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
        post_event(mouse(CGEventType::LeftMouseDragged, at, CGMouseButton::Left))?;
    }
    post_event(mouse(CGEventType::LeftMouseUp, to, CGMouseButton::Left))
}

fn scroll(at: Point, dx: i32, dy: i32) -> Result<(), String> {
    post_event(mouse(CGEventType::MouseMoved, at, CGMouseButton::Left))?;
    // Positive wheel values scroll up and left; the tool's dy > 0 scrolls down.
    post_event(CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Pixel, 2, -dy, -dx, 0))
}

/// Presses the modifiers, then the key, then releases them in reverse, like a person does.
fn key(combo: &KeyCombo) -> Result<(), String> {
    let held = modifiers(combo);
    let mut flags = CGEventFlags::empty();
    for (code, flag) in &held {
        flags |= *flag;
        key_event(*code, true, flags)?;
    }
    key_event(combo.code, true, flags)?;
    key_event(combo.code, false, flags)?;
    for (code, flag) in held.iter().rev() {
        flags &= !*flag;
        key_event(*code, false, flags)?;
    }
    Ok(())
}

fn text(chunk: &str) -> Result<(), String> {
    let units: Vec<u16> = chunk.encode_utf16().collect();
    for down in [true, false] {
        let event = CGEvent::new_keyboard_event(None, 0, down);
        if let Some(event) = &event {
            CGEvent::set_flags(Some(event), CGEventFlags::empty());
            // SAFETY: `units` outlives the call and holds `units.len()` UTF-16 units.
            unsafe { CGEvent::keyboard_set_unicode_string(Some(event), units.len() as _, units.as_ptr()) };
        }
        post_event(event)?;
    }
    Ok(())
}

fn pointer_location() -> Point {
    let event = CGEvent::new(None);
    let at = CGEvent::location(event.as_deref());
    Point { x: at.x, y: at.y }
}

fn display_at(at: Point) -> Option<CGDirectDisplayID> {
    let mut display: CGDirectDisplayID = 0;
    let mut count = 0u32;
    // SAFETY: both out-pointers are valid for one display.
    let error = unsafe { CGGetDisplaysWithPoint(CGPoint { x: at.x, y: at.y }, 1, &mut display, &mut count) };
    (error == CGError::Success && count == 1).then_some(display)
}

fn shareable_content() -> Result<Retained<SCShareableContent>, String> {
    let (tx, rx) = mpsc::channel();
    let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        // SAFETY: ScreenCaptureKit passes valid (or null) objects to the handler.
        let content = unsafe { Retained::retain(content) };
        let error = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
        let _ = tx.send(Handoff(content.ok_or_else(|| error.unwrap_or_else(|| "no shareable content".into()))));
    });
    // SAFETY: the handler matches the documented signature.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
    let Handoff(content) = rx.recv_timeout(CAPTURE_TIMEOUT).map_err(|_| "the screen capture timed out")?;
    content.map_err(|e| format!("cannot list the screen content: {e}"))
}

fn capture_image(filter: &SCContentFilter, config: &SCStreamConfiguration) -> Result<CFRetained<CGImage>, String> {
    let (tx, rx) = mpsc::channel();
    let handler = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        // SAFETY: the image is valid for the handler's duration; retaining keeps it alive.
        let image = NonNull::new(image).map(|image| unsafe { CFRetained::retain(image) });
        let error = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
        let _ = tx.send(Handoff(image.ok_or_else(|| error.unwrap_or_else(|| "no image".into()))));
    });
    // SAFETY: the handler matches the documented signature.
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(filter, config, Some(&handler))
    };
    let Handoff(image) = rx.recv_timeout(CAPTURE_TIMEOUT).map_err(|_| "the screenshot timed out")?;
    image.map_err(|e| format!("cannot take the screenshot: {e}"))
}

fn jpeg_of(image: &CGImage) -> Result<(Vec<u8>, u32, u32), String> {
    let (width, height) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
    if CGImage::bits_per_pixel(Some(image)) != 32 {
        return Err("unexpected screenshot pixel format".into());
    }
    let data = CGImage::data_provider(Some(image)).and_then(|p| CGDataProvider::data(Some(&p)));
    let bytes = data.ok_or("cannot read the screenshot pixels")?.to_vec();
    let jpeg = bgra_to_jpeg(&bytes, width as u32, height as u32, CGImage::bytes_per_row(Some(image)), JPEG_QUALITY)?;
    Ok((jpeg, width as u32, height as u32))
}

fn ax_string(element: &AXUIElement, attribute: &str) -> Option<String> {
    let value = ax_value(element, attribute)?;
    value.downcast_ref::<CFString>().map(|s| s.to_string()).filter(|s| !s.trim().is_empty())
}

fn ax_value(element: &AXUIElement, attribute: &str) -> Option<CFRetained<CFType>> {
    let attribute = CFString::from_str(attribute);
    let mut value: *const CFType = std::ptr::null();
    // SAFETY: `value` is a valid out-pointer; on success it holds a +1 reference.
    let error = unsafe { element.copy_attribute_value(&attribute, NonNull::from(&mut value)) };
    if error != AXError::Success {
        return None;
    }
    NonNull::new(value.cast_mut()).map(|value| unsafe { CFRetained::from_raw(value) })
}

fn ax_element(element: &AXUIElement, attribute: &str) -> Option<CFRetained<AXUIElement>> {
    ax_value(element, attribute)?.downcast::<AXUIElement>().ok()
}

fn describe(element: &AXUIElement) -> AxElement {
    AxElement {
        role: ax_string(element, "AXRole").unwrap_or_default(),
        title: ax_string(element, "AXTitle"),
        description: ax_string(element, "AXDescription"),
        value: ax_string(element, "AXValue"),
    }
}

fn system_wide() -> CFRetained<AXUIElement> {
    // SAFETY: plain constructor.
    let element = unsafe { AXUIElement::new_system_wide() };
    // A hung app must not stall the helper.
    unsafe { element.set_messaging_timeout(0.5) };
    element
}

type WindowInfo = NSDictionary<NSString, objc2::runtime::AnyObject>;

/// A window-list key (a `CFString` constant) as the bridged `NSString`.
fn info_key(key: &'static CFString) -> &'static NSString {
    // SAFETY: CFString is toll-free bridged to NSString.
    unsafe { &*(key as *const CFString).cast::<NSString>() }
}

/// `{X, Y, Width, Height}` of a window-list entry, in global points.
fn window_bounds(entry: &WindowInfo) -> Option<CGRect> {
    // SAFETY: extern constants provided by CoreGraphics.
    let bounds = entry.objectForKey(info_key(unsafe { kCGWindowBounds }))?;
    let bounds = bounds.downcast::<NSDictionary>().ok()?;
    let number = |key: &str| -> Option<f64> {
        let value = bounds.objectForKey(&NSString::from_str(key))?;
        Some(value.downcast::<NSNumber>().ok()?.doubleValue())
    };
    let origin = CGPoint::new(number("X")?, number("Y")?);
    Some(CGRect::new(origin, CGSize::new(number("Width")?, number("Height")?)))
}

impl Desktop for MacDesktop {
    fn permissions(&self) -> Permissions {
        Permissions {
            // SAFETY: plain queries.
            accessibility: unsafe { AXIsProcessTrusted() },
            screen_recording: CGPreflightScreenCaptureAccess(),
            screenshots_supported: available!(macos = 14.0),
        }
    }

    fn capture(&self) -> Result<Capture, String> {
        if !available!(macos = 14.0) {
            return Err("screenshots need macOS 14 or later".into());
        }
        let display_id = display_at(pointer_location()).ok_or("no display under the pointer")?;
        let content = shareable_content()?;
        // SAFETY: reading properties of the snapshot.
        let display = unsafe { content.displays() }
            .iter()
            .find(|d| unsafe { d.displayID() } == display_id)
            .ok_or("the display under the pointer cannot be captured")?;
        let own: Vec<Retained<SCWindow>> = unsafe { content.windows() }
            .iter()
            .filter(|w| unsafe { w.owningApplication() }.is_some_and(|app| unsafe { app.processID() } == self.own_pid))
            .collect();
        let excluded = NSArray::from_retained_slice(&own);
        let frame = unsafe { display.frame() };
        let (width, height) = fit_long_edge(frame.size.width as u32, frame.size.height as u32, MAX_LONG_EDGE);
        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &excluded)
        };
        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setWidth(width as usize);
            config.setHeight(height as usize);
            config.setPixelFormat(PIXEL_FORMAT_BGRA);
            config.setShowsCursor(true);
        }
        let image = capture_image(&filter, &config)?;
        let (data, image_width, image_height) = jpeg_of(&image)?;
        let origin = Point { x: frame.origin.x, y: frame.origin.y };
        let geometry = ScreenshotGeometry::for_display(origin, frame.size.width, image_width, image_height);
        Ok(Capture { data, mime_type: "image/jpeg", geometry })
    }

    fn post(&self, event: &InputEvent) -> Result<(), String> {
        match event {
            InputEvent::Move(at) => post_event(mouse(CGEventType::MouseMoved, *at, CGMouseButton::Left)),
            InputEvent::Click { at, button, count } => click(*at, *button, *count),
            InputEvent::Drag { from, to } => drag(*from, *to),
            InputEvent::Scroll { at, dx, dy } => scroll(*at, *dx, *dy),
            InputEvent::Key(combo) => key(combo),
            InputEvent::Text(chunk) => text(chunk),
        }
    }

    fn list_apps(&self) -> Result<Vec<AppInfo>, String> {
        let apps = NSWorkspace::sharedWorkspace().runningApplications();
        Ok(apps
            .iter()
            .filter(|app| app.activationPolicy() == NSApplicationActivationPolicy::Regular)
            .map(|app| {
                let id = identity(&app);
                AppInfo { name: id.name, bundle_id: id.bundle_id, active: app.isActive() }
            })
            .collect())
    }

    fn open_app(&self, name: &str) -> Result<(), String> {
        // A bundle id has dots and no spaces; anything else is an app name.
        let by_bundle = name.contains('.') && !name.contains(' ') && !name.ends_with(".app");
        let output = std::process::Command::new("/usr/bin/open")
            .arg(if by_bundle { "-b" } else { "-a" })
            .arg(name)
            .output()
            .map_err(|e| format!("cannot run `open`: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!("cannot open `{name}`: {}", String::from_utf8_lossy(&output.stderr).trim()))
        }
    }

    fn element_at(&self, at: Point) -> Vec<AxElement> {
        let mut found: *const AXUIElement = std::ptr::null();
        // SAFETY: `found` is a valid out-pointer; on success it holds a +1 reference.
        let out = NonNull::from(&mut found);
        let error = unsafe { system_wide().copy_element_at_position(at.x as f32, at.y as f32, out) };
        let Some(found) = NonNull::new(found.cast_mut()).filter(|_| error == AXError::Success) else {
            return Vec::new();
        };
        let mut element = unsafe { CFRetained::from_raw(found) };
        let mut chain = vec![describe(&element)];
        while chain.len() <= AX_ANCESTORS {
            let Some(parent) = ax_element(&element, "AXParent") else { break };
            chain.push(describe(&parent));
            element = parent;
        }
        chain
    }

    fn focused_element(&self) -> Option<Focus> {
        let focused = ax_element(&system_wide(), "AXFocusedUIElement")?;
        let default = ax_element(&focused, "AXWindow").and_then(|window| ax_element(&window, "AXDefaultButton"));
        let is_default_button = default.as_ref().is_some_and(|d| **d == *focused);
        Some(Focus { element: describe(&focused), is_default_button, default_button: default.as_deref().map(describe) })
    }

    fn frontmost_app(&self) -> Option<AppIdentity> {
        NSWorkspace::sharedWorkspace().frontmostApplication().map(|app| identity(&app))
    }

    fn window_owner_at(&self, at: Point) -> Option<AppIdentity> {
        let options = CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
        let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID)?;
        // SAFETY: CFArray of CFDictionary is toll-free bridged to NSArray of NSDictionary.
        let list: &NSArray<WindowInfo> = unsafe { &*(CFRetained::as_ptr(&list).as_ptr() as *const _) };
        // SAFETY: extern constants provided by CoreGraphics.
        let (alpha_key, pid_key, name_key) =
            unsafe { (info_key(kCGWindowAlpha), info_key(kCGWindowOwnerPID), info_key(kCGWindowOwnerName)) };
        let point = CGPoint { x: at.x, y: at.y };
        // Front to back: the first visible window containing the point owns it.
        let entry = list.iter().find(|entry| {
            let alpha = entry
                .objectForKey(alpha_key)
                .and_then(|a| a.downcast::<NSNumber>().ok())
                .map_or(1.0, |a| a.doubleValue());
            let bounds = window_bounds(entry);
            alpha > 0.0
                && bounds.is_some_and(|b| {
                    point.x >= b.origin.x
                        && point.y >= b.origin.y
                        && point.x < b.origin.x + b.size.width
                        && point.y < b.origin.y + b.size.height
                })
        })?;
        let pid = entry.objectForKey(pid_key)?.downcast::<NSNumber>().ok()?.intValue();
        match NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
            Some(app) => Some(identity(&app)),
            None => {
                let name = entry
                    .objectForKey(name_key)
                    .and_then(|n| n.downcast::<NSString>().ok())
                    .map(|n| n.to_string())
                    .unwrap_or_default();
                Some(AppIdentity { pid, bundle_id: None, name })
            }
        }
    }

    fn activate(&self, pid: i32) {
        if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
            app.activateWithOptions(NSApplicationActivationOptions::empty());
        }
    }
}

/// Shows the system prompt for `kind` (macOS shows it once per app) and opens its pane in System Settings.
pub fn request_permission(kind: PermissionKind) -> Result<(), String> {
    match kind {
        PermissionKind::Accessibility => {
            // SAFETY: the extern static is a valid CFString provided by HIServices.
            let key: &CFString = unsafe { objc2_application_services::kAXTrustedCheckOptionPrompt };
            let options = CFDictionary::<CFString, CFBoolean>::from_slices(&[key], &[CFBoolean::new(true)]);
            // SAFETY: `options` is a valid dictionary with the documented key.
            unsafe { AXIsProcessTrustedWithOptions(Some(options.as_opaque())) };
        }
        PermissionKind::ScreenRecording => {
            CGRequestScreenCaptureAccess();
        }
    }
    open_privacy_pane(kind)
}

/// Opens the Privacy & Security pane for `kind` in System Settings.
pub fn open_privacy_pane(kind: PermissionKind) -> Result<(), String> {
    let pane = match kind {
        PermissionKind::Accessibility => "Privacy_Accessibility",
        PermissionKind::ScreenRecording => "Privacy_ScreenCapture",
    };
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");
    let status = std::process::Command::new("/usr/bin/open").arg(url).status().map_err(|e| e.to_string())?;
    status.success().then_some(()).ok_or_else(|| "cannot open System Settings".into())
}
