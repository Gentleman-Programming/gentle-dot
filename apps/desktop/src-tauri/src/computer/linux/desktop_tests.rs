//! Adapter contract checks (T5 first slice, S1-S5): strict monitor
//! selection, the per-operation cancellation registry (including the Stop
//! hook race), the injected-backend capture/post fan-out, and the truthful
//! unsupported/unknown surface. Deterministic fakes only: socket pairs with
//! no protocol spoken, canned snapshots and JPEGs, no compositor, no input,
//! no startup.

use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use super::capabilities::{CapabilitySnapshot, NegotiatedGlobal};
use super::capture::{encode_frame_jpeg, CapturedFrame};
use super::desktop::{
    key_combo_string, parse_focused_output_name, select_focused, select_for_point,
    LinuxDesktop, OperationRegistry, PointerAction, Backend, FOCUSED_OUTPUT_REQUEST, OP_BUDGET,
};
use super::focus::FocusedWindow;
use super::geometry::OutputGeometry;
use super::normalize::{downscale_rgb_bilinear, normalize_bgra_to_rgb, normalized_target};
use super::outputs::Monitor;
use super::transport::{connection_from_stream, CancelHandle};
use crate::computer::coords::Point;
use crate::computer::{AppInfo, Desktop, FocusTarget, InputEvent, MouseButton};
use wayland_client::Connection;

/// A 32x24 output at the origin.
fn dp1() -> Monitor {
    Monitor {
        registry_name: 7,
        name: Some("DP-1".into()),
        geometry: OutputGeometry::new(0, 0, 32, 24, 1.0, 0, 32, 24).unwrap(),
        refresh_millihz: 60_000,
    }
}

/// A rotated output right of DP-1: logical 24x32, buffer 32x24, R90.
fn hdmi_r90() -> Monitor {
    Monitor {
        registry_name: 9,
        name: Some("HDMI-1".into()),
        geometry: OutputGeometry::new(32, 0, 24, 32, 1.0, 1, 32, 24).unwrap(),
        refresh_millihz: 60_000,
    }
}

/// Two overlapping outputs: globals x in 16..32 are inside both.
fn overlapping() -> Vec<Monitor> {
    vec![
        Monitor {
            registry_name: 11,
            name: Some("A".into()),
            geometry: OutputGeometry::new(0, 0, 32, 24, 1.0, 0, 32, 24).unwrap(),
            refresh_millihz: 60_000,
        },
        Monitor {
            registry_name: 12,
            name: Some("B".into()),
            geometry: OutputGeometry::new(16, 0, 32, 24, 1.0, 0, 32, 24).unwrap(),
            refresh_millihz: 60_000,
        },
    ]
}

/// Deterministic JPEG of buffer `width`x`height` with buffer quadrants TL
/// red, TR green, BL blue, BR white (quality 90, centers far from edges).
/// Only the raw-lie test uses this: the honest fake builds buffer BGRA and
/// runs the real fused processing path below.
fn test_jpeg(width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut rgb = vec![0u8; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let color = match (x < w / 2, y < h / 2) {
                (true, true) => [255, 0, 0],
                (false, true) => [0, 255, 0],
                (true, false) => [0, 0, 255],
                (false, false) => [255, 255, 255],
            };
            rgb[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&color);
        }
    }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .expect("test JPEG encodes");
    jpeg
}

fn near(a: &[u8], b: [u8; 3]) -> bool {
    a[0].abs_diff(b[0]) < 40 && a[1].abs_diff(b[1]) < 40 && a[2].abs_diff(b[2]) < 40
}

/// Buffer-orientation BGRA quadrants matching `test_jpeg`: TL red,
/// TR green, BL blue, BR white. The honest fake feeds this through the
/// real rotation/downscale/encode path, so the adapter tests exercise
/// true processing instead of a canned success.
fn test_bgra(width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut bgra = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let (r, g, b) = match (x < w / 2, y < h / 2) {
                (true, true) => (255, 0, 0),
                (false, true) => (0, 255, 0),
                (true, false) => (0, 0, 255),
                (false, false) => (255, 255, 255),
            };
            bgra[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[b, g, r, 255]);
        }
    }
    bgra
}

/// Injected backend: canned Niri gate, focused name, monitors and JPEGs;
/// fresh socket-pair connections per [`Backend::open`] (no protocol spoken,
/// peer ends held so nothing sees EOF); every call recorded for the
/// ownership/budget assertions. No compositor, no shell, no filesystem.
struct FakeBackend {
    niri: bool,
    focused: Mutex<Result<Option<String>, String>>,
    monitors: Vec<Monitor>,
    opens: AtomicUsize,
    peers: Mutex<Vec<UnixStream>>,
    deadlines: Mutex<Vec<Instant>>,
    pointer_calls: Mutex<Vec<(String, u32)>>,
    combos: Mutex<Vec<String>>,
    texts: Mutex<Vec<String>>,
    focused_window: Mutex<Result<Option<FocusedWindow>, String>>,
    focus_calls: Mutex<Vec<u64>>,
    focus_reply: Mutex<Result<(), String>>,
    /// Canned `list_apps` result. Defaults to the backend seam's truthful
    /// unsupported refusal, so an unconfigured fake stays unsupported.
    apps: Mutex<Result<Vec<AppInfo>, String>>,
    /// Canned `open_app` result, plus every name the adapter asked to open.
    open_reply: Mutex<Result<(), String>>,
    opened: Mutex<Vec<String>>,
    captures: AtomicUsize,
    /// When set, `capture` returns a raw-buffer JPEG instead of the fused
    /// normalized image: the adapter must refuse it (pins the fused-path
    /// requirement instead of trusting any backend).
    return_raw: bool,
    /// When set, `capture` signals entry then spins until cancel fires (the
    /// deterministic in-flight Stop-race test).
    block_capture: bool,
    entered: Mutex<Option<mpsc::Sender<()>>>,
}

impl FakeBackend {
    fn new(niri: bool, focused: Result<Option<String>, String>, monitors: Vec<Monitor>) -> Self {
        Self {
            niri,
            focused: Mutex::new(focused),
            monitors,
            opens: AtomicUsize::new(0),
            peers: Mutex::new(Vec::new()),
            deadlines: Mutex::new(Vec::new()),
            pointer_calls: Mutex::new(Vec::new()),
            combos: Mutex::new(Vec::new()),
            texts: Mutex::new(Vec::new()),
            focused_window: Mutex::new(Ok(None)),
            focus_calls: Mutex::new(Vec::new()),
            focus_reply: Mutex::new(Ok(())),
            apps: Mutex::new(Err("list_apps is unsupported by this backend: no running-app \
                 inventory source is configured (refusing instead of returning a faked empty list)"
                .to_owned())),
            open_reply: Mutex::new(Err("open_app is unsupported by this backend: no trusted \
                 launcher is configured (refusing instead of spawning a shell)"
                .to_owned())),
            opened: Mutex::new(Vec::new()),
            captures: AtomicUsize::new(0),
            return_raw: false,
            block_capture: false,
            entered: Mutex::new(None),
        }
    }

    fn snapshot(&self) -> CapabilitySnapshot {
        CapabilitySnapshot {
            shm: Some(NegotiatedGlobal { name: 1, advertised: 1, negotiated: 1 }),
            seat: Some(NegotiatedGlobal { name: 2, advertised: 7, negotiated: 7 }),
            outputs: self
                .monitors
                .iter()
                .map(|monitor| NegotiatedGlobal {
                    name: monitor.registry_name,
                    advertised: 4,
                    negotiated: 4,
                })
                .collect(),
            xdg_output_manager: Some(NegotiatedGlobal { name: 3, advertised: 3, negotiated: 3 }),
            virtual_pointer: Some(NegotiatedGlobal { name: 4, advertised: 2, negotiated: 2 }),
            virtual_keyboard: Some(NegotiatedGlobal { name: 5, advertised: 1, negotiated: 1 }),
            screencopy: Some(NegotiatedGlobal { name: 6, advertised: 3, negotiated: 3 }),
        }
    }
}

impl Backend for Arc<FakeBackend> {
    fn is_niri(&self) -> bool {
        self.niri
    }

    fn focused_output(&self) -> Result<Option<String>, String> {
        self.focused.lock().unwrap().clone()
    }

    fn open(&self) -> Result<Connection, String> {
        let (client, peer) =
            UnixStream::pair().map_err(|error| format!("test socketpair failed: {error}"))?;
        self.peers.lock().unwrap().push(peer);
        self.opens.fetch_add(1, Ordering::SeqCst);
        connection_from_stream(client).map_err(|error| error.to_string())
    }

    fn discover(
        &self,
        _conn: &Connection,
        deadline: Instant,
        _cancel: &CancelHandle,
    ) -> Result<CapabilitySnapshot, String> {
        self.deadlines.lock().unwrap().push(deadline);
        Ok(self.snapshot())
    }

    fn collect(
        &self,
        _conn: Connection,
        _snapshot: &CapabilitySnapshot,
        deadline: Instant,
        _cancel: &CancelHandle,
    ) -> Result<Vec<Monitor>, String> {
        self.deadlines.lock().unwrap().push(deadline);
        Ok(self.monitors.clone())
    }

    fn capture(
        &self,
        _conn: Connection,
        _snapshot: &CapabilitySnapshot,
        monitor: &Monitor,
        deadline: Instant,
        cancel: &CancelHandle,
    ) -> Result<CapturedFrame, String> {
        self.deadlines.lock().unwrap().push(deadline);
        self.captures.fetch_add(1, Ordering::SeqCst);
        if self.block_capture {
            if let Some(tx) = self.entered.lock().unwrap().take() {
                let _ = tx.send(());
            }
            while !cancel.is_cancelled() {
                std::thread::yield_now();
            }
            return Err("capture interrupted after cancel (stop-race test)".to_owned());
        }
        let (bw, bh) = (monitor.geometry.buffer_width(), monitor.geometry.buffer_height());
        if self.return_raw {
            // A lying backend: raw buffer bytes at buffer dims. The
            // adapter must refuse these instead of mis-mapping them.
            return Ok(CapturedFrame {
                jpeg: test_jpeg(bw, bh),
                width: bw,
                height: bh,
                buffer_width: bw,
                buffer_height: bh,
                geometry: monitor.geometry,
                monitor_name: monitor.name.clone(),
            });
        }
        // The honest fake: buffer-orientation BGRA through the real
        // fused rotation/downscale/capped-encode path.
        let bgra = test_bgra(bw, bh);
        let (upright, uw, uh) = normalize_bgra_to_rgb(&bgra, bw, bh, &monitor.geometry, deadline, cancel)
            .map_err(|error| format!("fake fused normalize failed: {error}"))?;
        let (tw, th, _) = normalized_target(&monitor.geometry);
        let rgb = downscale_rgb_bilinear(&upright, uw, uh, tw, th, deadline, cancel, None)
            .map_err(|error| format!("fake fused downscale failed: {error}"))?;
        let jpeg = encode_frame_jpeg(&rgb, tw, th, deadline, cancel)
            .map_err(|error| format!("fake fused encode failed: {error}"))?;
        Ok(CapturedFrame {
            jpeg,
            width: tw,
            height: th,
            buffer_width: bw,
            buffer_height: bh,
            geometry: monitor.geometry,
            monitor_name: monitor.name.clone(),
        })
    }

    fn pointer(
        &self,
        action: PointerAction,
        _conn: Connection,
        _snapshot: &CapabilitySnapshot,
        monitor: &Monitor,
        deadline: Instant,
        _cancel: &CancelHandle,
    ) -> Result<(), String> {
        self.deadlines.lock().unwrap().push(deadline);
        self.pointer_calls.lock().unwrap().push((format!("{action:?}"), monitor.registry_name));
        Ok(())
    }

    fn press_combo(
        &self,
        combo: &str,
        _conn: Connection,
        _snapshot: &CapabilitySnapshot,
        deadline: Instant,
        _cancel: &CancelHandle,
    ) -> Result<(), String> {
        self.deadlines.lock().unwrap().push(deadline);
        self.combos.lock().unwrap().push(combo.to_owned());
        Ok(())
    }

    fn type_text(
        &self,
        text: &str,
        _conn: Connection,
        _snapshot: &CapabilitySnapshot,
        deadline: Instant,
        _cancel: &CancelHandle,
    ) -> Result<(), String> {
        self.deadlines.lock().unwrap().push(deadline);
        self.texts.lock().unwrap().push(text.to_owned());
        Ok(())
    }

    fn focused_window(&self) -> Result<Option<FocusedWindow>, String> {
        self.focused_window.lock().unwrap().clone()
    }

    fn focus_window(&self, id: u64) -> Result<(), String> {
        self.focus_calls.lock().unwrap().push(id);
        self.focus_reply.lock().unwrap().clone()
    }

    fn list_apps(&self, deadline: Instant, _cancel: &CancelHandle) -> Result<Vec<AppInfo>, String> {
        self.deadlines.lock().unwrap().push(deadline);
        self.apps.lock().unwrap().clone()
    }

    fn open_app(&self, name: &str, deadline: Instant, _cancel: &CancelHandle) -> Result<(), String> {
        self.deadlines.lock().unwrap().push(deadline);
        self.opened.lock().unwrap().push(name.to_owned());
        self.open_reply.lock().unwrap().clone()
    }
}

fn desktop(
    niri: bool,
    focused: Result<Option<String>, String>,
    monitors: Vec<Monitor>,
) -> (LinuxDesktop<Arc<FakeBackend>>, Arc<FakeBackend>) {
    let backend = Arc::new(FakeBackend::new(niri, focused, monitors));
    (LinuxDesktop::new(backend.clone()), backend)
}

#[test]
fn focused_output_request_names_the_niri_focused_output_wire() {
    // `Request::FocusedOutput` serializes to this JSON string (niri-ipc):
    // the adapter reuses the existing Client path, not a new IPC dialect.
    assert_eq!(FOCUSED_OUTPUT_REQUEST, "\"FocusedOutput\"");
}

#[test]
fn focused_output_replies_parse_truthfully() {
    let named = serde_json::json!({"FocusedOutput": {"name": "HDMI-1"}});
    assert_eq!(
        parse_focused_output_name(&named).unwrap(),
        Some("HDMI-1".to_owned())
    );
    let none = serde_json::json!({"FocusedOutput": null});
    assert_eq!(parse_focused_output_name(&none).unwrap(), None);
    assert!(parse_focused_output_name(&serde_json::json!({"Windows": []})).is_err());
    assert!(parse_focused_output_name(&serde_json::json!({"FocusedOutput": {}})).is_err());
    assert!(parse_focused_output_name(&serde_json::json!({"FocusedOutput": {"name": ""}})).is_err());
    assert!(
        parse_focused_output_name(&serde_json::json!({"FocusedOutput": {"name": "  "}})).is_err()
    );
}

#[test]
fn focused_selection_is_exact_with_no_fallback() {
    let monitors = vec![dp1(), hdmi_r90()];
    // Exact match, either output.
    assert_eq!(select_focused(&monitors, Some("DP-1")).unwrap().registry_name, 7);
    assert_eq!(select_focused(&monitors, Some("HDMI-1")).unwrap().registry_name, 9);
    // Missing, absent, empty, and unknown names fail; the first monitor is
    // never picked as a fallback.
    for focused in [None, Some(""), Some("  "), Some("DP-2"), Some("dp-1")] {
        assert!(
            select_focused(&monitors, focused).is_err(),
            "focused {focused:?} must be refused"
        );
    }
    assert!(select_focused(&[], Some("DP-1")).is_err());
}

#[test]
fn point_selection_refuses_gaps_overlaps_and_non_finite() {
    let monitors = vec![dp1(), hdmi_r90()];
    assert_eq!(select_for_point(&monitors, 5.0, 5.0).unwrap().registry_name, 7);
    assert_eq!(select_for_point(&monitors, 40.0, 5.0).unwrap().registry_name, 9);
    // Half-open edges belong to the neighbor, never both.
    assert_eq!(select_for_point(&monitors, 32.0, 5.0).unwrap().registry_name, 9);
    // The gap right of both outputs is refused, never clamped in.
    assert!(select_for_point(&monitors, 60.0, 5.0).is_err());
    assert!(select_for_point(&monitors, -1.0, 5.0).is_err());
    // Overlapping layouts are ambiguous: refused instead of picked.
    let overlap = overlapping();
    assert!(select_for_point(&overlap, 20.0, 5.0).is_err());
    // ... while the non-overlapping parts still resolve.
    assert_eq!(select_for_point(&overlap, 5.0, 5.0).unwrap().registry_name, 11);
    assert_eq!(select_for_point(&overlap, 40.0, 5.0).unwrap().registry_name, 12);
    for (x, y) in [(f64::NAN, 5.0), (5.0, f64::INFINITY), (f64::NAN, f64::NAN)] {
        assert!(select_for_point(&monitors, x, y).is_err());
    }
}

#[test]
fn key_combos_render_in_mac_convention_without_parser_changes() {
    let combo = |text: &str| crate::computer::keys::parse_combo(text).unwrap();
    assert_eq!(key_combo_string(&combo("cmd+shift+t")), "cmd+shift+t");
    assert_eq!(key_combo_string(&combo("ctrl+alt+delete")), "ctrl+alt+delete");
    assert_eq!(key_combo_string(&combo("return")), "return");
    assert_eq!(key_combo_string(&combo("fn+f1")), "fn+f1");
    // The grammar still parses what the adapter formats (roundtrip).
    assert_eq!(crate::computer::keys::parse_combo("cmd+shift+t").unwrap(), combo("cmd+shift+t"));
}

#[test]
fn registry_removes_only_its_own_guard() {
    let registry = OperationRegistry::default();
    let first = registry.register();
    let second = registry.register();
    assert_eq!(registry.active_count(), 2);
    registry.cancel_all();
    assert!(first.handle.is_cancelled() && second.handle.is_cancelled());
    drop(first);
    // Only the dropped guard's entry leaves; the concurrent call keeps its
    // (already cancelled) handle and stays registered.
    assert_eq!(registry.active_count(), 1);
    assert!(second.handle.is_cancelled());
    drop(second);
    assert_eq!(registry.active_count(), 0);
    // Cancelling with nothing in flight is a silent no-op (the Stop race
    // after every guard already dropped).
    registry.cancel_all();
    assert_eq!(registry.active_count(), 0);
}

#[test]
fn concurrent_registrations_cancel_and_clean_up() {
    let registry = Arc::new(OperationRegistry::default());
    let (tx, rx) = mpsc::channel::<()>();
    let mut threads = Vec::new();
    for _ in 0..2 {
        let (registry, tx) = (registry.clone(), tx.clone());
        threads.push(std::thread::spawn(move || {
            let guard = registry.register();
            tx.send(()).unwrap();
            while !guard.handle.is_cancelled() {
                std::thread::yield_now();
            }
            // Guard drops here, removing exactly its own entry.
        }));
    }
    // Both calls are in flight before the Stop hook fires.
    rx.recv().unwrap();
    rx.recv().unwrap();
    assert_eq!(registry.active_count(), 2);
    registry.cancel_all();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(registry.active_count(), 0);
}

#[test]
fn permissions_never_claim_ax_or_screen_recording() {
    // Stock Wayland has no Accessibility and no Screen Recording concept:
    // Linux permissions must never claim either, on Niri or off it.
    for niri in [true, false] {
        let (linux, _) = desktop(niri, Ok(Some("DP-1".into())), vec![dp1()]);
        let permissions = linux.permissions();
        assert!(!permissions.accessibility, "no AX concept on Linux (niri={niri})");
        assert!(!permissions.screen_recording, "no Screen Recording concept on Linux (niri={niri})");
    }
}

#[test]
fn off_niri_everything_refuses_before_any_io() {
    let (linux, backend) = desktop(false, Ok(Some("DP-1".into())), vec![dp1()]);
    assert!(!linux.permissions().accessibility);
    assert!(!linux.permissions().screen_recording);
    assert!(!linux.permissions().screenshots_supported);
    let capture = linux.capture().unwrap_err();
    assert!(capture.contains("Niri"), "wrong refusal: {capture}");
    let posted = linux.post(&InputEvent::Move(Point { x: 5.0, y: 5.0 })).unwrap_err();
    assert!(posted.contains("Niri"), "wrong refusal: {posted}");
    assert_eq!(backend.opens.load(Ordering::SeqCst), 0, "gate must precede any Wayland I/O");
    assert_eq!(linux.active_operations(), 0);
}

#[test]
fn on_niri_permissions_advertise_the_protocol_model() {
    let (linux, _) = desktop(true, Ok(Some("DP-1".into())), vec![dp1()]);
    let permissions = linux.permissions();
    assert!(!permissions.accessibility && !permissions.screen_recording);
    assert!(permissions.screenshots_supported);
}

#[test]
fn capture_uses_the_focused_output_and_normalizes_upright() {
    let (linux, backend) =
        desktop(true, Ok(Some("HDMI-1".into())), vec![dp1(), hdmi_r90()]);
    let capture = linux.capture().expect("focused capture succeeds");
    assert_eq!(capture.mime_type, "image/jpeg");
    // R90 buffer 32x24 normalizes to the upright 24x32 (far below the long
    // edge, so no downscale): rotation happened exactly once.
    assert_eq!((capture.geometry.image_width, capture.geometry.image_height), (24, 32));
    assert_eq!((capture.geometry.origin.x, capture.geometry.origin.y), (32.0, 0.0));
    assert!((capture.geometry.scale - 1.0).abs() < 1e-9);
    let image = image::load_from_memory(&capture.data).unwrap().to_rgb8();
    assert_eq!(image.dimensions(), (24, 32));
    // Buffer BL (blue) shows at upright TL; buffer TL (red) at upright TR.
    assert!(near(&image.get_pixel(1, 1).0, [0, 0, 255]), "upright TL is buffer BL blue");
    assert!(near(&image.get_pixel(22, 1).0, [255, 0, 0]), "upright TR is buffer TL red");
    // Three fresh connections (discover, collect, capture); each phase
    // shares the one per-operation deadline within the total budget.
    assert_eq!(backend.opens.load(Ordering::SeqCst), 3);
    assert_eq!(backend.captures.load(Ordering::SeqCst), 1);
    assert_eq!(linux.active_operations(), 0, "guard must unregister on success");
    let deadlines = backend.deadlines.lock().unwrap();
    assert_eq!(deadlines.len(), 3);
    assert!(deadlines.windows(2).all(|pair| pair[0] == pair[1]), "one deadline per operation");
    let start = Instant::now();
    for deadline in deadlines.iter() {
        assert!(*deadline <= start + OP_BUDGET + Duration::from_secs(1));
        assert!(*deadline > start - OP_BUDGET);
    }
}

#[test]
fn capture_without_a_focused_match_touches_no_capture() {
    for focused in [Ok(None), Ok(Some("DP-2".into())), Err("niri socket gone".into())] {
        let (linux, backend) = desktop(true, focused, vec![dp1(), hdmi_r90()]);
        let err = linux.capture().unwrap_err();
        assert!(
            err.contains("no focused output")
                || err.contains("matches no enumerated")
                || err.contains("niri socket gone"),
            "wrong refusal: {err}"
        );
        assert_eq!(backend.captures.load(Ordering::SeqCst), 0, "no capture on refused selection");
        assert_eq!(linux.active_operations(), 0, "guard must unregister on error");
    }
}

#[test]
fn pointer_selects_by_point_and_rejects_gaps() {
    let (linux, backend) = desktop(true, Ok(Some("DP-1".into())), vec![dp1(), hdmi_r90()]);
    linux.post(&InputEvent::Move(Point { x: 5.0, y: 5.0 })).unwrap();
    linux
        .post(&InputEvent::Click { at: Point { x: 40.0, y: 5.0 }, button: MouseButton::Left, count: 2 })
        .unwrap();
    linux
        .post(&InputEvent::Scroll { at: Point { x: 5.0, y: 5.0 }, dx: 0, dy: -3 })
        .unwrap();
    let calls = backend.pointer_calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    assert!(calls[0].0.contains("Move") && calls[0].1 == 7);
    assert!(calls[1].0.contains("Click") && calls[1].1 == 9);
    assert!(calls[2].0.contains("Scroll") && calls[2].1 == 7);
    drop(calls);
    // The gap is refused before any input; nothing was recorded for it.
    let err = linux.post(&InputEvent::Move(Point { x: 60.0, y: 5.0 })).unwrap_err();
    assert!(err.contains("no enumerated output"), "wrong refusal: {err}");
    assert_eq!(backend.pointer_calls.lock().unwrap().len(), 3);
    assert_eq!(linux.active_operations(), 0);
}

#[test]
fn drag_needs_both_endpoints_on_one_output() {
    let (linux, backend) = desktop(true, Ok(Some("DP-1".into())), vec![dp1(), hdmi_r90()]);
    linux
        .post(&InputEvent::Drag {
            from: Point { x: 5.0, y: 5.0 },
            to: Point { x: 10.0, y: 10.0 },
        })
        .unwrap();
    assert_eq!(backend.pointer_calls.lock().unwrap().len(), 1);
    let err = linux
        .post(&InputEvent::Drag {
            from: Point { x: 5.0, y: 5.0 },
            to: Point { x: 40.0, y: 5.0 },
        })
        .unwrap_err();
    assert!(err.contains("must share one output"), "wrong refusal: {err}");
    assert_eq!(backend.pointer_calls.lock().unwrap().len(), 1, "refused drag posts nothing");
}

#[test]
fn key_and_text_map_through_the_native_keyboard_api() {
    let (linux, backend) = desktop(true, Ok(Some("DP-1".into())), vec![dp1()]);
    let combo = crate::computer::keys::parse_combo("cmd+shift+t").unwrap();
    linux.post(&InputEvent::Key(combo)).unwrap();
    linux.post(&InputEvent::Text("hi".into())).unwrap();
    assert_eq!(backend.combos.lock().unwrap().as_slice(), ["cmd+shift+t"]);
    assert_eq!(backend.texts.lock().unwrap().as_slice(), ["hi"]);
    // Keyboard binds a seat, not an output: two fresh connections per call
    // (discover plus the operation), no monitor selection involved.
    assert_eq!(backend.opens.load(Ordering::SeqCst), 4);
    assert_eq!(linux.active_operations(), 0);
}

#[test]
fn cancel_all_reaches_an_in_flight_capture() {
    let backend = Arc::new(FakeBackend {
        niri: true,
        focused: Mutex::new(Ok(Some("DP-1".into()))),
        monitors: vec![dp1()],
        opens: AtomicUsize::new(0),
        peers: Mutex::new(Vec::new()),
        deadlines: Mutex::new(Vec::new()),
        pointer_calls: Mutex::new(Vec::new()),
        combos: Mutex::new(Vec::new()),
        texts: Mutex::new(Vec::new()),
        focused_window: Mutex::new(Ok(None)),
        focus_calls: Mutex::new(Vec::new()),
        focus_reply: Mutex::new(Ok(())),
        apps: Mutex::new(Err("list_apps is unsupported by this backend: no running-app \
             inventory source is configured (refusing instead of returning a faked empty list)"
            .to_owned())),
        open_reply: Mutex::new(Err("open_app is unsupported by this backend: no trusted \
             launcher is configured (refusing instead of spawning a shell)"
            .to_owned())),
        opened: Mutex::new(Vec::new()),
        captures: AtomicUsize::new(0),
        return_raw: false,
        block_capture: true,
        entered: Mutex::new(None),
    });
    let (tx, rx) = mpsc::channel::<()>();
    *backend.entered.lock().unwrap() = Some(tx);
    let linux = Arc::new(LinuxDesktop::new(backend.clone()));
    let worker = linux.clone();
    let thread = std::thread::spawn(move || worker.capture());
    // The capture is inside the backend before the Stop hook fires.
    rx.recv().expect("capture signals entry");
    assert_eq!(backend.captures.load(Ordering::SeqCst), 1);
    linux.cancel_all();
    let err = thread.join().expect("capture thread ends").unwrap_err();
    assert!(
        err.contains("cancelled") || err.contains("interrupt"),
        "in-flight capture must observe cancel_all, got: {err}"
    );
    assert_eq!(linux.active_operations(), 0, "guard must unregister after cancel");
}

#[test]
fn raw_buffer_backends_are_refused() {
    // A backend returning raw buffer bytes (buffer dims, unrotated) is
    // refused: the adapter requires the fused normalized path and never
    // mis-maps a raw buffer as if it were upright.
    let backend = Arc::new(FakeBackend {
        niri: true,
        focused: Mutex::new(Ok(Some("HDMI-1".into()))),
        monitors: vec![dp1(), hdmi_r90()],
        opens: AtomicUsize::new(0),
        peers: Mutex::new(Vec::new()),
        deadlines: Mutex::new(Vec::new()),
        pointer_calls: Mutex::new(Vec::new()),
        combos: Mutex::new(Vec::new()),
        texts: Mutex::new(Vec::new()),
        focused_window: Mutex::new(Ok(None)),
        focus_calls: Mutex::new(Vec::new()),
        focus_reply: Mutex::new(Ok(())),
        apps: Mutex::new(Err("list_apps is unsupported by this backend: no running-app \
             inventory source is configured (refusing instead of returning a faked empty list)"
            .to_owned())),
        open_reply: Mutex::new(Err("open_app is unsupported by this backend: no trusted \
             launcher is configured (refusing instead of spawning a shell)"
            .to_owned())),
        opened: Mutex::new(Vec::new()),
        captures: AtomicUsize::new(0),
        return_raw: true,
        block_capture: false,
        entered: Mutex::new(None),
    });
    let linux = LinuxDesktop::new(backend);
    let err = linux.capture().unwrap_err();
    assert!(
        err.contains("fused") || err.contains("normalized"),
        "adapter must demand the fused path, got: {err}"
    );
    assert_eq!(linux.active_operations(), 0);
}

#[test]
fn focused_window_maps_the_backend_reply_to_the_adapter_target() {
    let (linux, backend) = desktop(true, Ok(Some("DP-1".into())), vec![dp1()]);
    *backend.focused_window.lock().unwrap() = Ok(Some(FocusedWindow {
        id: 17,
        pid: Some(991),
        title: Some("Editor".into()),
        app_id: Some("org.gnome.TextEditor".into()),
    }));
    let target = linux.focused_window().unwrap().expect("the focused window maps through");
    assert_eq!(target.window_id, 17);
    assert_eq!(target.pid, Some(991));
    assert_eq!(target.title.as_deref(), Some("Editor"));
    assert_eq!(linux.active_operations(), 0, "guard must unregister");
    // `None` is "cannot tell", not an error: the caller decides to fail closed.
    *backend.focused_window.lock().unwrap() = Ok(None);
    assert!(linux.focused_window().unwrap().is_none());
    // A query failure surfaces truthfully instead of turning into "no window".
    *backend.focused_window.lock().unwrap() = Err("niri socket gone".into());
    assert!(linux.focused_window().unwrap_err().contains("niri socket gone"));
}

#[test]
fn focus_restore_targets_the_exact_window_id() {
    let (linux, backend) = desktop(true, Ok(Some("DP-1".into())), vec![dp1()]);
    let target = FocusTarget { window_id: 17, pid: Some(991), title: None, app_id: None };
    linux.focus_window(&target).unwrap();
    assert_eq!(*backend.focus_calls.lock().unwrap(), vec![17]);
    assert_eq!(linux.active_operations(), 0);
    // A backend refusal surfaces truthfully, never a silent success.
    *backend.focus_reply.lock().unwrap() = Err("no such window".into());
    let err = linux.focus_window(&target).unwrap_err();
    assert!(err.contains("no such window"), "{err}");
}

#[test]
fn focus_queries_refuse_off_niri_before_any_io() {
    let (linux, backend) = desktop(false, Ok(Some("DP-1".into())), vec![dp1()]);
    assert!(linux.focused_window().unwrap_err().contains("Niri"));
    let target = FocusTarget { window_id: 17, pid: None, title: None, app_id: None };
    assert!(linux.focus_window(&target).unwrap_err().contains("Niri"));
    assert_eq!(backend.opens.load(Ordering::SeqCst), 0, "gate must precede any Wayland I/O");
}

#[test]
fn unsupported_and_unknown_surfaces_stay_truthful() {
    let (linux, _) = desktop(true, Ok(Some("DP-1".into())), vec![dp1()]);
    // A backend that configures neither capability still refuses, and never
    // fakes an empty list or a shell spawn.
    assert!(linux.list_apps().unwrap_err().contains("unsupported"));
    assert!(!linux.list_apps().unwrap_err().contains("[]"));
    assert!(linux.open_app("Terminal").unwrap_err().contains("unsupported"));
    assert!(linux.element_at(Point { x: 1.0, y: 1.0 }).is_empty());
    assert!(linux.focused_element().is_none());
    assert!(linux.frontmost_app().is_none());
    assert!(linux.focused_app().is_none());
    assert!(linux.window_owner_at(Point { x: 1.0, y: 1.0 }).is_none());
    // No Linux activation yet: a silent no-op, never a fake success story.
    linux.activate(1234);
}

#[test]
fn list_and_open_app_fan_out_to_the_injected_backend() {
    let (linux, backend) = desktop(true, Ok(Some("DP-1".into())), vec![dp1()]);
    let apps = vec![AppInfo {
        name: "org.gnome.TextEditor".into(),
        bundle_id: None,
        active: true,
    }];
    *backend.apps.lock().unwrap() = Ok(apps.clone());
    assert_eq!(linux.list_apps().unwrap(), apps);
    assert_eq!(linux.active_operations(), 0, "the fan-out unregisters");

    *backend.open_reply.lock().unwrap() = Ok(());
    linux.open_app("org.gnome.TextEditor").unwrap();
    assert_eq!(*backend.opened.lock().unwrap(), vec!["org.gnome.TextEditor".to_owned()]);
    assert_eq!(linux.active_operations(), 0);

    // A backend refusal surfaces truthfully, never a silent success.
    *backend.open_reply.lock().unwrap() = Err("no installed desktop entry matches `Nope`".into());
    assert!(linux.open_app("Nope").unwrap_err().contains("no installed desktop entry"));

    // Off Niri the adapter gate refuses before the backend is asked at all.
    let (off_niri, off_backend) = desktop(false, Ok(None), vec![dp1()]);
    assert!(off_niri.list_apps().unwrap_err().contains("Niri"));
    assert!(off_niri.open_app("Terminal").unwrap_err().contains("Niri"));
    assert!(off_backend.opened.lock().unwrap().is_empty());
}
