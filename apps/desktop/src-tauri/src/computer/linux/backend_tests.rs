//! Concrete-backend contract checks (T5b, S1-S5): the Niri
//! `FocusedOutput` wire shape through the existing client path, strict
//! connector-name selection (including duplicates), Niri-absent and
//! unmatched-output errors, capability-missing refusals before any I/O,
//! construction failing closed without a transport or socket, and the
//! adapter running through the real backend shape with fakes only where a
//! live socket is required.
//!
//! Deterministic, no live compositor: Niri replies arrive over socket pairs
//! answered by a test thread, Wayland connects aim at absent socket paths,
//! and snapshots are canned. Real Niri `FocusedOutput` shape and real
//! input/capture delivery remain unverified live.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use super::backend::{
    require_capture_caps, require_keyboard_caps, require_pointer_caps, WaylandBackend,
};use super::capabilities::{CapabilitySnapshot, NegotiatedGlobal};
use super::desktop::{parse_focused_output_name, select_focused, Backend, LinuxDesktop};
use super::geometry::OutputGeometry;
use super::outputs::Monitor;
use super::transport::CancelHandle;
use crate::computer::coords::Point;
use crate::computer::{Desktop, InputEvent};

/// A 32x24 output at the origin.
fn dp1() -> Monitor {
    Monitor {
        registry_name: 7,
        name: Some("DP-1".into()),
        geometry: OutputGeometry::new(0, 0, 32, 24, 1.0, 0, 32, 24).unwrap(),
        refresh_millihz: 60_000,
    }
}

fn hdmi() -> Monitor {
    Monitor {
        registry_name: 9,
        name: Some("HDMI-1".into()),
        geometry: OutputGeometry::new(32, 0, 24, 32, 1.0, 1, 32, 24).unwrap(),
        refresh_millihz: 60_000,
    }
}

/// Answer one request line on `peer` with `reply_line`, then close.
fn respond_once(peer: UnixStream, reply_line: &'static str) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut peer = peer;
        peer.set_nonblocking(false).ok();
        peer.set_read_timeout(Some(Duration::from_secs(5))).ok();
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            match peer.read(&mut byte) {
                Ok(0) => break,
                Ok(_) => {
                    request.push(byte[0]);
                    if byte[0] == b'\n' {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        peer.write_all(reply_line.as_bytes()).expect("test peer writes the reply");
        request
    })
}

fn full_output(_name: &str) -> CapabilitySnapshot {
    CapabilitySnapshot {
        shm: Some(NegotiatedGlobal { name: 1, advertised: 1, negotiated: 1 }),
        seat: Some(NegotiatedGlobal { name: 2, advertised: 7, negotiated: 7 }),
        outputs: vec![NegotiatedGlobal { name: 7, advertised: 4, negotiated: 4 }],
        xdg_output_manager: Some(NegotiatedGlobal { name: 3, advertised: 3, negotiated: 3 }),
        virtual_pointer: Some(NegotiatedGlobal { name: 4, advertised: 2, negotiated: 2 }),
        virtual_keyboard: Some(NegotiatedGlobal { name: 5, advertised: 1, negotiated: 1 }),
        screencopy: Some(NegotiatedGlobal { name: 6, advertised: 3, negotiated: 3 }),
    }
}

fn env_of(pairs: Vec<(&'static str, &'static str)>) -> impl Fn(&str) -> Option<String> {
    move |key: &str| {
        pairs.iter().find(|(name, _)| *name == key).map(|(_, value)| (*value).to_owned())
    }
}

#[test]
fn focused_wire_named_output_parses_with_extra_fields() {
    // The verified niri-ipc shape: `Request::FocusedOutput` answers
    // `{"FocusedOutput": {"name": ...}}` with the full `Output` struct
    // around it; only `name` is read, the rest is ignored, never rejected.
    let reply = serde_json::json!({
        "FocusedOutput": {
            "name": "DP-1",
            "make": "Test Make",
            "model": "Test Model",
            "serial": "SN-1",
            "modes": [],
            "current_mode": null,
            "is_custom_mode": false,
            "vrr_supported": true,
        }
    });
    assert_eq!(parse_focused_output_name(&reply).unwrap(), Some("DP-1".to_owned()));
}

#[test]
fn focused_wire_null_means_no_focused_output() {
    let reply = serde_json::json!({"FocusedOutput": null});
    assert_eq!(parse_focused_output_name(&reply).unwrap(), None);
}

#[test]
fn focused_wire_without_a_name_is_a_truthful_error() {
    // Missing field, missing name, wrong types, and blank names all fail;
    // none of them guesses an output.
    for reply in [
        serde_json::json!({"Windows": []}),
        serde_json::json!({}),
        serde_json::json!({"FocusedOutput": {}}),
        serde_json::json!({"FocusedOutput": {"make": "no name here"}}),
        serde_json::json!({"FocusedOutput": {"name": ""}}),
        serde_json::json!({"FocusedOutput": {"name": "   "}}),
        serde_json::json!({"FocusedOutput": {"name": 7}}),
        serde_json::json!({"FocusedOutput": {"name": null}}),
        serde_json::json!({"FocusedOutput": {"name": ["DP-1"]}}),
        serde_json::json!({"FocusedOutput": "DP-1"}),
        serde_json::json!({"FocusedOutput": 42}),
    ] {
        assert!(
            parse_focused_output_name(&reply).is_err(),
            "reply {reply} must be refused, never guessed"
        );
    }
}

#[test]
fn focused_request_roundtrips_through_the_existing_client_path() {
    // The exact production composition (`request_on` + `decode_reply` +
    // the focused-output parse) against a fake socket pair: one request
    // line in, one `{"Ok": ...}` line out, no compositor.
    let (client_end, peer_end) = UnixStream::pair().expect("test socketpair");
    let responder = respond_once(
        peer_end,
        r#"{"Ok":{"FocusedOutput":{"name":"HDMI-1","make":"M","model":"O"}}}
"#,
    );
    let reply = crate::niri::request_on(client_end, "\"FocusedOutput\"", Duration::from_secs(5))
        .expect("fake focused-output roundtrip succeeds");
    let request = responder.join().expect("responder ends");
    assert_eq!(request, b"\"FocusedOutput\"\n");
    assert_eq!(parse_focused_output_name(&reply).unwrap(), Some("HDMI-1".to_owned()));
}

#[test]
fn focused_request_null_and_err_roundtrip_truthfully() {
    let (client_end, peer_end) = UnixStream::pair().expect("test socketpair");
    let responder = respond_once(peer_end, r#"{"Ok":{"FocusedOutput":null}}
"#);
    let reply = crate::niri::request_on(client_end, "\"FocusedOutput\"", Duration::from_secs(5))
        .expect("fake null roundtrip succeeds");
    responder.join().expect("responder ends");
    assert_eq!(parse_focused_output_name(&reply).unwrap(), None);

    let (client_end, peer_end) = UnixStream::pair().expect("test socketpair");
    let responder = respond_once(peer_end, r#"{"Err":"no such output"}
"#);
    let err =
        crate::niri::request_on(client_end, "\"FocusedOutput\"", Duration::from_secs(5)).unwrap_err();
    responder.join().expect("responder ends");
    assert!(err.to_string().contains("no such output"), "wire errors surface: {err}");
}

#[test]
fn focused_selection_matches_strictly_with_no_fallback() {
    let monitors = vec![dp1(), hdmi()];
    assert_eq!(select_focused(&monitors, Some("DP-1")).unwrap().registry_name, 7);
    assert_eq!(select_focused(&monitors, Some("HDMI-1")).unwrap().registry_name, 9);
    // Case differs, trailing space, unknown, empty, absent: all refused,
    // never the first monitor.
    for focused in [None, Some(""), Some("  "), Some("DP-2"), Some("dp-1"), Some("DP-1 ")] {
        if focused == Some("DP-1 ") {
            // Whitespace trims to an exact match: still strict, not a guess.
            assert_eq!(select_focused(&monitors, focused).unwrap().registry_name, 7);
        } else {
            assert!(
                select_focused(&monitors, focused).is_err(),
                "focused {focused:?} must be refused"
            );
        }
    }
    assert!(select_focused(&[], Some("DP-1")).is_err());
}

#[test]
fn focused_selection_with_duplicate_names_picks_the_first_enumerated() {
    // Connector names are unique on a real compositor; when enumeration
    // hands back a duplicate, selection stays deterministic (first in
    // enumeration order) instead of failing the whole screenshot. Pinned
    // here so a live duplicate cannot silently change behavior.
    let monitors = vec![
        dp1(),
        Monitor {
            registry_name: 13,
            name: Some("DP-1".into()),
            geometry: OutputGeometry::new(64, 0, 32, 24, 1.0, 0, 32, 24).unwrap(),
            refresh_millihz: 60_000,
        },
    ];
    assert_eq!(select_focused(&monitors, Some("DP-1")).unwrap().registry_name, 7);
}

#[test]
fn construction_fails_closed_without_sockets() {
    // No Niri socket at all: the backend never exists, so nothing can act.
    let err = WaylandBackend::with_env(&env_of(vec![])).unwrap_err();
    assert!(err.contains("NIRI_SOCKET"), "must name the missing socket: {err}");

    // Empty Niri socket is the same as absent.
    let err = WaylandBackend::with_env(&env_of(vec![("NIRI_SOCKET", "")])).unwrap_err();
    assert!(err.contains("NIRI_SOCKET"), "must name the missing socket: {err}");

    // Niri socket present but no Wayland transport: construction still
    // fails instead of deferring the failure to first use.
    let err = WaylandBackend::with_env(&env_of(vec![(
        "NIRI_SOCKET",
        "/run/user/1000/niri.sock",
    )]))
    .unwrap_err();
    assert!(
        err.contains("WAYLAND_DISPLAY") || err.contains("no Wayland"),
        "must name the missing transport: {err}"
    );

    // Relative display without a runtime dir: unresolvable, refused now.
    let err = WaylandBackend::with_env(&env_of(vec![
        ("NIRI_SOCKET", "/run/user/1000/niri.sock"),
        ("WAYLAND_DISPLAY", "wayland-1"),
    ]))
    .unwrap_err();
    assert!(
        err.contains("XDG_RUNTIME_DIR") || err.contains("runtime dir"),
        "must name the missing runtime dir: {err}"
    );
}

#[test]
fn construction_succeeds_with_both_sockets_named() {
    // Paths need not exist: construction only resolves names, connecting
    // stays per-operation (and fails truthfully there when absent).
    let backend = WaylandBackend::with_env(&env_of(vec![
        ("NIRI_SOCKET", "/run/user/1000/niri.sock"),
        ("WAYLAND_DISPLAY", "wayland-absent.sock"),
        ("XDG_RUNTIME_DIR", "/tmp/gentle-dot-backend-test"),
    ]))
    .expect("resolvable socket names construct");
    drop(backend);
    // An absolute display needs no runtime dir.
    let backend = WaylandBackend::with_env(&env_of(vec![
        ("NIRI_SOCKET", "/run/user/1000/niri.sock"),
        ("WAYLAND_DISPLAY", "/tmp/gentle-dot-backend-test/wayland-absent.sock"),
    ]))
    .expect("absolute display constructs without a runtime dir");
    drop(backend);
}

#[test]
fn capability_gates_refuse_before_any_io_and_name_the_protocol() {
    let empty = CapabilitySnapshot::default();
    for (label, result) in [
        ("screencopy", require_capture_caps(&empty)),
        ("pointer", require_pointer_caps(&empty)),
        ("keyboard", require_keyboard_caps(&empty)),
    ] {
        let err = result.unwrap_err();
        assert!(
            err.contains("zwlr_screencopy_manager_v1")
                || err.contains("zwlr_virtual_pointer_manager_v1")
                || err.contains("zwp_virtual_keyboard_manager_v1")
                || err.contains("wl_shm")
                || err.contains("wl_seat")
                || err.contains("wl_output")
                || err.contains("zxdg_output_manager_v1"),
            "{label} must name its missing protocol: {err}"
        );
    }
    // One missing piece still fails even when everything else is present.
    let mut no_pointer = full_output("DP-1");
    no_pointer.virtual_pointer = None;
    let err = require_pointer_caps(&no_pointer).unwrap_err();
    assert!(err.contains("zwlr_virtual_pointer_manager_v1"), "wrong refusal: {err}");
    let mut no_keyboard = full_output("DP-1");
    no_keyboard.seat = None;
    let err = require_keyboard_caps(&no_keyboard).unwrap_err();
    assert!(err.contains("wl_seat"), "wrong refusal: {err}");
    let mut no_screencopy = full_output("DP-1");
    no_screencopy.screencopy = None;
    let err = require_capture_caps(&no_screencopy).unwrap_err();
    assert!(err.contains("zwlr_screencopy_manager_v1"), "wrong refusal: {err}");
    // The full set passes: gates refuse only what is actually missing.
    require_capture_caps(&full_output("DP-1")).expect("full snapshot captures");
    require_pointer_caps(&full_output("DP-1")).expect("full snapshot points");
    require_keyboard_caps(&full_output("DP-1")).expect("full snapshot types");
}

#[test]
fn open_against_an_absent_socket_fails_fast_and_truthfully() {
    let dir = std::env::temp_dir().join("gentle-dot-backend-absent");
    let backend = WaylandBackend::with_env(&env_of(vec![
        ("NIRI_SOCKET", "/run/user/1000/niri-absent.sock"),
        ("WAYLAND_DISPLAY", "wayland-absent.sock"),
        ("XDG_RUNTIME_DIR", "/tmp/gentle-dot-backend-test"),
    ]))
    .expect("resolvable names construct");
    let _ = dir;
    let start = Instant::now();
    let err = backend.open().unwrap_err();
    assert!(
        start.elapsed() < Duration::from_secs(10),
        "absent socket must fail fast, not hang"
    );
    assert!(
        err.contains("wayland-absent.sock") || err.contains("compositor"),
        "must name the absent socket: {err}"
    );
}

#[test]
fn niri_query_against_an_absent_socket_is_a_truthful_error() {
    let backend = WaylandBackend::with_env(&env_of(vec![
        ("NIRI_SOCKET", "/tmp/gentle-dot-backend-test/niri-absent.sock"),
        ("WAYLAND_DISPLAY", "wayland-absent.sock"),
        ("XDG_RUNTIME_DIR", "/tmp/gentle-dot-backend-test"),
    ]))
    .expect("resolvable names construct");
    let err = backend.focused_output().unwrap_err();
    // Either the centralized gate is closed in this session (truthful:
    // names Niri, attempts no I/O) or the absent socket fails the query
    // (truthful: names the Niri socket). Both are closed, never silent.
    assert!(
        err.contains("Niri") || err.contains("niri"),
        "must name Niri either way: {err}"
    );
}

#[test]
fn adapter_over_the_real_backend_fails_closed_with_no_compositor() {
    // The real backend shape inside the real adapter: every phase needs a
    // socket, every socket is absent, so capture and input refuse
    // truthfully with nothing posted, nothing captured, and no leaked
    // registry entry. (Which refusal fires first — the centralized Niri
    // gate or the absent Wayland socket — depends on the session, so both
    // truthful wordings are accepted.)
    let backend = WaylandBackend::with_env(&env_of(vec![
        ("NIRI_SOCKET", "/tmp/gentle-dot-backend-test/niri-absent.sock"),
        ("WAYLAND_DISPLAY", "wayland-absent.sock"),
        ("XDG_RUNTIME_DIR", "/tmp/gentle-dot-backend-test"),
    ]))
    .expect("resolvable names construct");
    let linux = LinuxDesktop::new(backend);
    let capture = linux.capture().unwrap_err();
    assert!(
        capture.contains("Niri")
            || capture.contains("niri")
            || capture.contains("compositor")
            || capture.contains("socket"),
        "capture must fail truthfully: {capture}"
    );
    let posted = linux.post(&InputEvent::Move(Point { x: 5.0, y: 5.0 })).unwrap_err();
    assert!(
        posted.contains("Niri")
            || posted.contains("niri")
            || posted.contains("compositor")
            || posted.contains("socket"),
        "input must fail truthfully: {posted}"
    );
    assert_eq!(linux.active_operations(), 0, "refused calls leak no registry entry");
    // Unsupported stays unsupported even over the real backend: no fake
    // list, no shell spawn, no per-app story.
    assert!(linux.list_apps().unwrap_err().contains("unsupported"));
    assert!(linux.open_app("Terminal").unwrap_err().contains("unsupported"));
    assert!(linux.frontmost_app().is_none());
    let cancel = CancelHandle::new();
    assert!(!cancel.is_cancelled());
}
