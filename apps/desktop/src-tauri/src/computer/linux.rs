//! The Linux desktop backend, phase 1 (S24 Linux): capture-only screenshots through the
//! xdg-desktop-portal Screenshot interface, on Hyprland (odd/tasks/linux-screenshot-capture.md
//! S2–S4). Input stays refused; permissions mirror the portal's real grant. The pure parts
//! (portal response mapping, Hyprland monitor geometry) compile under `test` everywhere,
//! following the Windows backend's `any(windows, test)` convention (mod.rs:30-35).

use super::coords::{fit_long_edge, Point, ScreenshotGeometry, MAX_LONG_EDGE};
use super::encode::JPEG_QUALITY;
use super::blocklist::AppIdentity;
use super::risk::{AxElement, Focus};
use super::{AppInfo, Capture, InputEvent, Permissions};
use std::sync::Mutex;

/// How long to wait for the portal's permission dialog, matching the store's prompt timeout
/// (secure_store/linux.rs: the daemon's wait is longer).
const PROMPT_TIMEOUT_SECS: u64 = 120;

/// The Linux desktop backend, phase 1: captures only. Every input method is a refusal
/// (S4); permissions mirror the portal's grant (S3, T2).
/// What the portal answered to a Screenshot request
/// (org.freedesktop.portal.Request Response codes).
#[derive(Debug, PartialEq)]
pub(crate) enum PortalOutcome {
    /// The user approved; the portal returned a file URI for the image.
    Granted(String),
    /// The user refused the dialog (response code 1).
    Denied,
    /// The dialog was dismissed (response code 2).
    Cancelled,
}

/// Map a portal Request `Response (u, v)` to an outcome. Code 0 is granted and must carry
/// a `uri`; anything but 0/1/2 is a protocol error.
pub(crate) fn portal_outcome(response: u32, uri: Option<&str>) -> Result<PortalOutcome, String> {
    match (response, uri) {
        (0, Some(uri)) => Ok(PortalOutcome::Granted(uri.to_string())),
        (0, None) => Err("the Screenshot portal answered 0 without a uri".into()),
        (1, _) => Ok(PortalOutcome::Denied),
        (2, _) => Ok(PortalOutcome::Cancelled),
        (other, _) => Err(format!("unknown Screenshot portal response code {other}")),
    }
}

/// The focused Hyprland monitor, from `hyprctl monitors -j` output: its top-left corner in
/// global points and its width in logical points (the unit `ScreenshotGeometry::for_display`
/// expects; Hyprland reports monitor width/height after scale).
#[derive(Debug, PartialEq)]
pub(crate) struct MonitorGeometry {
    pub origin: Point,
    pub logical_width: f64,
}

/// Pick the focused monitor out of `hyprctl monitors -j` JSON. Errors when the JSON does
/// not parse or no monitor is focused.
pub(crate) fn focused_monitor(monitors_json: &str) -> Result<MonitorGeometry, String> {
    let monitors: serde_json::Value =
        serde_json::from_str(monitors_json).map_err(|error| format!("hyprctl monitors -j: {error}"))?;
    let monitors = monitors.as_array().ok_or("hyprctl monitors -j: expected an array")?;
    monitors
        .iter()
        .find(|monitor| monitor["focused"].as_bool() == Some(true))
        .map(|monitor| -> Result<MonitorGeometry, String> {
            let point = |name: &str| {
                monitor[name].as_f64().ok_or(format!("hyprctl monitor: missing {name}"))
            };
            Ok(MonitorGeometry {
                origin: Point { x: point("x")?, y: point("y")? },
                logical_width: point("width")?,
            })
        })
        .unwrap_or_else(|| Err("no focused Hyprland monitor".into()))
        .and_then(|geometry| {
            if geometry.logical_width > 0.0 {
                Ok(geometry)
            } else {
                Err("focused Hyprland monitor has a non-positive width".into())
            }
        })
}

/// Turn the portal's `file://` URI into a local path, percent-decoded. Only `file://` with an
/// empty authority (what xdg-desktop-portal-hyprland returns) is accepted.
pub(crate) fn uri_to_path(uri: &str) -> Result<std::path::PathBuf, String> {
    let rest = uri
        .strip_prefix("file://")
        .ok_or_else(|| format!("the portal URI is not file://: {uri}"))?;
    if !rest.starts_with('/') {
        return Err(format!("the portal file URI has a non-local authority: {uri}"));
    }
    let bytes = percent_decode(rest)?;
    String::from_utf8(bytes)
        .map(std::path::PathBuf::from)
        .map_err(|_| "the portal file URI is not valid UTF-8".into())
}

/// Percent-decode a URI path: `%XX` becomes the byte, everything else stays literal.
/// A truncated or non-hex escape is an error rather than a silent mangling.
fn percent_decode(text: &str) -> Result<Vec<u8>, String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let hex = bytes.get(index + 1..index + 3).ok_or("truncated % escape in the portal URI")?;
        let hi = (hex[0] as char).to_digit(16).ok_or("invalid % escape in the portal URI")?;
        let lo = (hex[1] as char).to_digit(16).ok_or("invalid % escape in the portal URI")?;
        decoded.push((hi * 16 + lo) as u8);
        index += 3;
    }
    Ok(decoded)
}

/// The Linux desktop backend, phase 1: captures only. Every input method is a refusal
/// (S4); permissions mirror the portal's grant (S3).
pub(crate) struct LinuxDesktop {
    /// The portal's last Screenshot answer: `None` = not asked yet.
    grant: Mutex<Option<bool>>,
}

impl LinuxDesktop {
    pub(crate) fn new() -> Self {
        Self { grant: Mutex::new(None) }
    }

    /// Screenshot of the focused monitor: ask the portal, then decode, downscale to
    /// `MAX_LONG_EDGE`, and encode as the JPEG the model gets, with the geometry that maps
    /// its pixels back to global points (S2).
    pub(crate) fn capture(&self) -> Result<Capture, String> {
        let monitor = focused_monitor(&hyprctl_monitors()?)?;
        let outcome = self.portal_screenshot()?;
        *self.grant.lock().expect("portal grant state") = Some(matches!(outcome, PortalOutcome::Granted(_)));
        let uri = match outcome {
            PortalOutcome::Granted(uri) => uri,
            PortalOutcome::Denied => return Err("the portal permission dialog was refused".into()),
            PortalOutcome::Cancelled => return Err("the portal screenshot was cancelled".into()),
        };
        let path = uri_to_path(&uri)?;
        let bytes = std::fs::read(&path).map_err(|error| format!("cannot read the portal screenshot {path:?}: {error}"))?;
        let image = image::load_from_memory(&bytes).map_err(|error| format!("cannot decode the portal screenshot: {error}"))?;
        let (width, height) = fit_long_edge(image.width(), image.height(), MAX_LONG_EDGE);
        let resized = image.resize_exact(width, height, image::imageops::FilterType::Triangle).to_rgb8();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
            .encode(resized.as_raw(), width, height, image::ExtendedColorType::Rgb8)
            .map_err(|error| format!("cannot encode the screenshot: {error}"))?;
        Ok(Capture {
            data: jpeg,
            mime_type: "image/jpeg",
            geometry: ScreenshotGeometry::for_display(monitor.origin, monitor.logical_width, width, height),
        })
    }

    /// Ask org.freedesktop.portal.Screenshot for a monitor screenshot and wait for the
    /// Request's Response signal, synchronously (the trait is blocking `&self`). Connects per
    /// call, like the store does.
    fn portal_screenshot(&self) -> Result<PortalOutcome, String> {
        use dbus::arg::{PropMap, RefArg, Variant};
        use dbus::blocking::Connection;
        use std::collections::HashMap;
        use std::time::{Duration, Instant};

        let connection = Connection::new_session()
            .map_err(|error| format!("cannot reach the D-Bus session bus: {error}"))?;
        let portal = connection.with_proxy(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            Duration::from_secs(PROMPT_TIMEOUT_SECS),
        );
        let mut options = PropMap::new();
        options.insert("handle_token".into(), Variant(Box::new("gentle_dot".to_string())));
        options.insert("interactive".into(), Variant(Box::new(false)));
        let (request,): (dbus::Path<'static>,) = portal
            .method_call("org.freedesktop.portal.Screenshot", "Screenshot", ("", options))
            .map_err(|error| format!("the Screenshot portal refused the request: {error}"))?;

        let (sender, receiver) = std::sync::mpsc::channel::<(u32, HashMap<String, Variant<Box<dyn RefArg>>>)>();
        let rule = dbus::message::MatchRule::new()
            .with_interface("org.freedesktop.portal.Request")
            .with_member("Response")
            .with_path(request.clone());
        connection
            .add_match(rule, move |(response, results): (u32, PropMap), _connection: &Connection, _message: &dbus::Message| {
                sender.send((response, results)).is_ok()
            })
            .map_err(|error| format!("cannot listen for the portal's answer: {error}"))?;

        let deadline = Instant::now() + Duration::from_secs(PROMPT_TIMEOUT_SECS);
        loop {
            if Instant::now() >= deadline {
                return Err(format!("the Screenshot portal did not answer within {PROMPT_TIMEOUT_SECS}s"));
            }
            if !connection
                .process(Duration::from_millis(250))
                .map_err(|error| format!("the D-Bus session bus failed: {error}"))?
            {
                continue;
            }
            if let Ok((response, results)) = receiver.try_recv() {
                let uri = results.get("uri").and_then(|variant| variant.as_str().map(str::to_string));
                return portal_outcome(response, uri.as_deref());
            }
        }
    }
}

/// `hyprctl monitors -j` output, from the environment the app already runs in.
fn hyprctl_monitors() -> Result<String, String> {
    let output = std::process::Command::new("hyprctl")
        .args(["monitors", "-j"])
        .output()
        .map_err(|error| format!("cannot run hyprctl: {error}"))?;
    if !output.status.success() {
        return Err(format!("hyprctl monitors -j failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    String::from_utf8(output.stdout).map_err(|_| "hyprctl monitors -j printed invalid UTF-8".into())
}

/// The permission set the capture-only Linux backend reports (S3). `grant` is the portal's
/// last Screenshot answer: `None` = not asked yet (Hyprland's portal has no pre-grant state
/// to query; it prompts per request), `Some(true)` = the dialog was approved,
/// `Some(false)` = refused or cancelled. Accessibility is always false: this backend never
/// injects input (S4), so acting tools are refused before they run.
pub(crate) fn permissions_with(grant: Option<bool>) -> Permissions {
    let granted = grant.unwrap_or(true); // not asked yet: the portal prompts per request
    Permissions {
        accessibility: false,
        screen_recording: granted,
        screenshots_supported: granted,
        screenshots_unsupported: None,
    }
}

impl super::Desktop for LinuxDesktop {
    fn permissions(&self) -> Permissions {
        permissions_with(*self.grant.lock().expect("portal grant state"))
    }

    fn capture(&self) -> Result<Capture, String> {
        Self::capture(self)
    }

    fn post(&self, _event: &InputEvent) -> Result<(), String> {
        Err("this Linux backend only captures screenshots; it cannot move the pointer or press keys".into())
    }

    fn list_apps(&self) -> Result<Vec<AppInfo>, String> {
        Err("listing apps is not available on this Linux backend".into())
    }

    fn open_app(&self, _name: &str) -> Result<(), String> {
        Err("opening apps is not available on this Linux backend".into())
    }

    fn element_at(&self, _at: Point) -> Vec<AxElement> {
        Vec::new()
    }

    fn focused_element(&self) -> Option<Focus> {
        None
    }

    fn frontmost_app(&self) -> Option<AppIdentity> {
        None
    }

    fn focused_app(&self) -> Option<AppIdentity> {
        None
    }

    fn window_owner_at(&self, _at: Point) -> Option<AppIdentity> {
        None
    }

    fn activate(&self, _pid: i32) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portal_response_zero_with_uri_is_granted() {
        assert_eq!(
            portal_outcome(0, Some("file:///tmp/shot.png")),
            Ok(PortalOutcome::Granted("file:///tmp/shot.png".into()))
        );
    }

    #[test]
    fn portal_response_zero_without_uri_is_a_protocol_error() {
        assert!(portal_outcome(0, None).is_err());
    }

    #[test]
    fn portal_response_one_is_denied_and_two_cancelled() {
        assert_eq!(portal_outcome(1, None), Ok(PortalOutcome::Denied));
        assert_eq!(portal_outcome(2, None), Ok(PortalOutcome::Cancelled));
    }

    #[test]
    fn portal_response_unknown_code_is_a_protocol_error() {
        assert!(portal_outcome(3, Some("file:///x.png")).is_err());
    }

    #[test]
    fn uri_to_path_decodes_plain_and_percent_encoded_paths() {
        assert_eq!(uri_to_path("file:///tmp/shot.png"), Ok(std::path::PathBuf::from("/tmp/shot.png")));
        assert_eq!(
            uri_to_path("file:///tmp/My%20Pics/shot%2Epng"),
            Ok(std::path::PathBuf::from("/tmp/My Pics/shot.png"))
        );
    }

    #[test]
    fn uri_to_path_rejects_other_schemes_and_hosts() {
        assert!(uri_to_path("https://example.com/shot.png").is_err());
        assert!(uri_to_path("file://other-host/tmp/shot.png").is_err());
        assert!(uri_to_path("/tmp/shot.png").is_err());
    }

    #[test]
    fn uri_to_path_rejects_broken_escapes() {
        assert!(uri_to_path("file:///tmp/%ZZ.png").is_err());
    }

    #[test]
    fn permissions_reflect_the_portal_grant() {
        let granted = permissions_with(Some(true));
        assert!(!granted.accessibility);
        assert!(granted.screen_recording);
        assert!(granted.screenshots_supported);
        assert_eq!(granted.screenshots_unsupported, None);
    }

    #[test]
    fn permissions_before_the_first_request_allow_trying_the_portal() {
        let waiting = permissions_with(None);
        assert!(waiting.screenshots_supported);
        assert!(waiting.screen_recording);
        assert!(!waiting.accessibility);
    }

    #[test]
    fn permissions_after_a_refusal_offer_screenshots_no_more() {
        let refused = permissions_with(Some(false));
        assert!(!refused.screenshots_supported);
        assert!(!refused.screen_recording);
    }

    const MONITORS: &str = r#"[
        {"id":0,"name":"DP-1","width":2560,"height":1440,"x":0,"y":0,"scale":1.0,"focused":true},
        {"id":1,"name":"HDMI-A-1","width":1920,"height":1080,"x":2560,"y":0,"scale":1.0,"focused":false}
    ]"#;

    #[test]
    fn focused_monitor_picks_the_focused_one_with_its_origin() {
        assert_eq!(
            focused_monitor(MONITORS),
            Ok(MonitorGeometry { origin: Point { x: 0.0, y: 0.0 }, logical_width: 2560.0 })
        );
    }

    #[test]
    fn focused_monitor_errors_when_none_is_focused() {
        let none = r#"[{"id":0,"name":"DP-1","width":2560,"height":1440,"x":0,"y":0,"scale":1.0,"focused":false}]"#;
        assert!(focused_monitor(none).is_err());
    }

    #[test]
    fn focused_monitor_errors_on_broken_json() {
        assert!(focused_monitor("not json").is_err());
    }
}
