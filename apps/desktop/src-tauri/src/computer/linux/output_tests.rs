//! RED/GREEN checks for [`super::outputs::collect`]: bounded `wl_output` plus
//! `zxdg_output_v1` monitor enumeration over a fake peer, feeding the validated
//! [`super::geometry::OutputGeometry`] API. No real compositor is touched: the
//! fake below speaks just enough wire protocol (`get_registry`, `bind`,
//! `get_xdg_output`, `sync`, plus the output event bursts that bound the
//! sweep). Every wait carries the total deadline and the cooperative cancel
//! handle; there is no unbounded roundtrip anywhere in these tests.
//!
//! What each test pins: two outputs with a negative origin and a fractional
//! scale the integer `wl_output.scale` must not mask; a rotated output whose
//! buffer is transposed exactly once; withdrawn globals failing as withdrawn;
//! missing protocols and incomplete metadata failing closed with the guilty
//! party named; silent peers hitting the deadline; cancellation waking the
//! sweep; and version semantics (`wl_output.done` only at v2+, `xdg done`
//! only below v3, v1 outputs completing through the `sync` barrier).

use super::capabilities::{AdvertisedGlobal, CapabilitySnapshot, XDG_OUTPUT_MANAGER, WL_OUTPUT};
use super::geometry::OutputGeometry;
use super::outputs::{collect, OutputsError};
use super::transport::{
    connection_from_stream, CancelHandle, TransportKind,
};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

fn advertised(name: u32, interface: &str, version: u32) -> AdvertisedGlobal {
    AdvertisedGlobal { name, interface: interface.to_owned(), version }
}

fn snapshot(outputs: &[(u32, u32)], manager_version: u32) -> CapabilitySnapshot {
    let mut globals = Vec::new();
    for (name, version) in outputs {
        globals.push(advertised(*name, WL_OUTPUT, *version));
    }
    globals.push(advertised(20, XDG_OUTPUT_MANAGER, manager_version));
    CapabilitySnapshot::negotiate(&globals)
}

// --- Minimal fake output peer (std only, no extra deps). ---
//
// Reads `wl_display.get_registry`, every `wl_registry.bind`, every
// `zxdg_output_manager_v1.get_xdg_output` and the `wl_display.sync` barrier
// on object 1, then replays canned output bursts to the recorded object ids.
// Opcodes follow the XML order: display `sync` = 0 / `get_registry` = 1,
// registry `bind` = 0, manager `get_xdg_output` = 1; `wl_output` geometry = 0,
// mode = 1, done = 2, scale = 3, name = 4; `zxdg_output_v1` position = 0,
// size = 1, done = 2, name = 3; registry global = 0 / remove = 1; callback
// done = 0. `bind` carries an untyped new-id, so its payload is name,
// interface string, version, id.

fn wire_u32(into: &mut Vec<u8>, value: u32) {
    into.extend_from_slice(&value.to_ne_bytes());
}

fn wire_string(into: &mut Vec<u8>, value: &str) {
    wire_u32(into, value.len() as u32 + 1);
    into.extend_from_slice(value.as_bytes());
    into.push(0);
    while !into.len().is_multiple_of(4) {
        into.push(0);
    }
}

fn wire_message(sender: u32, opcode: u16, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    wire_u32(&mut out, sender);
    wire_u32(&mut out, ((8 + payload.len()) as u32) << 16 | opcode as u32);
    out.extend_from_slice(payload);
    out
}

fn read_u32(buf: &[u8], off: &mut usize) -> u32 {
    let value = u32::from_ne_bytes(buf[*off..*off + 4].try_into().expect("u32"));
    *off += 4;
    value
}

fn read_string(buf: &[u8], off: &mut usize) -> String {
    let len = read_u32(buf, off) as usize;
    assert!(len >= 1, "wire string always carries its NUL");
    let text = std::str::from_utf8(&buf[*off..*off + len - 1]).expect("utf8").to_owned();
    *off += len.div_ceil(4) * 4;
    text
}

fn ev_geometry(id: u32, x: i32, y: i32, transform: i32) -> Vec<u8> {
    let mut p = Vec::new();
    wire_u32(&mut p, x as u32);
    wire_u32(&mut p, y as u32);
    wire_u32(&mut p, 0);
    wire_u32(&mut p, 0);
    wire_u32(&mut p, 0);
    wire_string(&mut p, "FakeMake");
    wire_string(&mut p, "FakeModel");
    wire_u32(&mut p, transform as u32);
    wire_message(id, 0, &p)
}

fn ev_mode(id: u32, current: bool, w: i32, h: i32, refresh: i32) -> Vec<u8> {
    let mut p = Vec::new();
    wire_u32(&mut p, if current { 1 } else { 0 });
    wire_u32(&mut p, w as u32);
    wire_u32(&mut p, h as u32);
    wire_u32(&mut p, refresh as u32);
    wire_message(id, 1, &p)
}

fn ev_done(id: u32) -> Vec<u8> {
    wire_message(id, 2, &[])
}

fn ev_scale(id: u32, factor: i32) -> Vec<u8> {
    let mut p = Vec::new();
    wire_u32(&mut p, factor as u32);
    wire_message(id, 3, &p)
}

fn ev_wl_name(id: u32, name: &str) -> Vec<u8> {
    let mut p = Vec::new();
    wire_string(&mut p, name);
    wire_message(id, 4, &p)
}

fn ev_xdg_pos(id: u32, x: i32, y: i32) -> Vec<u8> {
    let mut p = Vec::new();
    wire_u32(&mut p, x as u32);
    wire_u32(&mut p, y as u32);
    wire_message(id, 0, &p)
}

fn ev_xdg_size(id: u32, w: i32, h: i32) -> Vec<u8> {
    let mut p = Vec::new();
    wire_u32(&mut p, w as u32);
    wire_u32(&mut p, h as u32);
    wire_message(id, 1, &p)
}

fn ev_xdg_done(id: u32) -> Vec<u8> {
    wire_message(id, 2, &[])
}

fn ev_xdg_name(id: u32, name: &str) -> Vec<u8> {
    let mut p = Vec::new();
    wire_string(&mut p, name);
    wire_message(id, 3, &p)
}

fn ev_remove(registry: u32, name: u32) -> Vec<u8> {
    let mut p = Vec::new();
    wire_u32(&mut p, name);
    wire_message(registry, 1, &p)
}

struct FakeOutput {
    registry_name: u32,
    x: i32,
    y: i32,
    transform: i32,
    scale_factor: i32,
    /// `None` means no current mode is ever advertised (incomplete metadata).
    current_mode: Option<(i32, i32, i32)>,
    send_wl_done: bool,
    logical_pos: Option<(i32, i32)>,
    logical_size: Option<(i32, i32)>,
    /// Only meaningful below xdg-output v3, where `done` is still live.
    send_xdg_done: bool,
    name_wl: Option<&'static str>,
    name_xdg: Option<&'static str>,
}

/// Serve one enumeration: parse every bind, then replay the canned bursts.
/// Panics (test failure) instead of hanging: every read has a timeout and the
/// request wait has a total bound.
fn serve_outputs(mut peer: UnixStream, outputs: Vec<FakeOutput>, removed: Vec<u32>) {
    peer.set_read_timeout(Some(Duration::from_secs(2))).expect("read timeout");
    let mut buffered = Vec::new();
    let mut registry_id = None;
    let mut manager_id = None;
    let mut callback_id = None;
    // Bound object id -> registry global name, for `wl_output` binds.
    let mut bound_outputs: Vec<(u32, u32)> = Vec::new();
    // xdg-output object id -> bound `wl_output` id.
    let mut xdg_outputs: Vec<(u32, u32)> = Vec::new();
    let start = Instant::now();
    while callback_id.is_none() {
        assert!(start.elapsed() < Duration::from_secs(5), "fake peer never saw sync");
        let mut chunk = [0u8; 4096];
        match peer.read(&mut chunk) {
            Ok(0) => panic!("fake peer: client closed before the output requests"),
            Ok(read) => buffered.extend_from_slice(&chunk[..read]),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue
            }
            Err(error) => panic!("fake peer read failed: {error}"),
        }
        while buffered.len() >= 8 {
            let sender = u32::from_ne_bytes(buffered[0..4].try_into().expect("header"));
            let word = u32::from_ne_bytes(buffered[4..8].try_into().expect("header"));
            let size = (word >> 16) as usize;
            let opcode = (word & 0xFFFF) as u16;
            assert!((8..=65536).contains(&size), "fake peer saw a bogus size");
            if buffered.len() < size {
                break;
            }
            let mut payload = buffered[8..size].to_vec();
            buffered.drain(..size);
            if sender == 1 && opcode == 1 {
                let mut off = 0;
                registry_id = Some(read_u32(&payload, &mut off));
            } else if sender == 1 && opcode == 0 {
                let mut off = 0;
                callback_id = Some(read_u32(&payload, &mut off));
            } else if Some(sender) == registry_id && opcode == 0 {
                let mut off = 0;
                let name = read_u32(&payload, &mut off);
                let interface = read_string(&payload, &mut off);
                let _version = read_u32(&payload, &mut off);
                let new_id = read_u32(&payload, &mut off);
                if interface == "wl_output" {
                    bound_outputs.push((new_id, name));
                } else if interface == "zxdg_output_manager_v1" {
                    manager_id = Some(new_id);
                }
            } else if Some(sender) == manager_id && opcode == 1 {
                let mut off = 0;
                let new_id = read_u32(&payload, &mut off);
                let output_id = read_u32(&payload, &mut off);
                xdg_outputs.push((new_id, output_id));
            }
            let _ = &mut payload;
        }
    }
    let by_registry = |name: u32| {
        bound_outputs.iter().find(|(_, n)| *n == name).map(|(id, _)| *id)
    };
    let xdg_for = |output_id: u32| {
        xdg_outputs.iter().find(|(_, o)| *o == output_id).map(|(id, _)| *id)
    };
    let mut reply = Vec::new();
    for out in &outputs {
        let Some(id) = by_registry(out.registry_name) else {
            panic!("client never bound output {}", out.registry_name);
        };
        reply.extend(ev_geometry(id, out.x, out.y, out.transform));
        if let Some((w, h, refresh)) = out.current_mode {
            reply.extend(ev_mode(id, true, w, h, refresh));
        }
        reply.extend(ev_scale(id, out.scale_factor));
        if let Some(name) = out.name_wl {
            reply.extend(ev_wl_name(id, name));
        }
        if out.send_wl_done {
            reply.extend(ev_done(id));
        }
        if let Some(xdg) = xdg_for(id) {
            if let Some((x, y)) = out.logical_pos {
                reply.extend(ev_xdg_pos(xdg, x, y));
            }
            if let Some((w, h)) = out.logical_size {
                reply.extend(ev_xdg_size(xdg, w, h));
            }
            if let Some(name) = out.name_xdg {
                reply.extend(ev_xdg_name(xdg, name));
            }
            if out.send_xdg_done {
                reply.extend(ev_xdg_done(xdg));
            }
        }
    }
    let registry = registry_id.expect("get_registry seen");
    for name in removed {
        reply.extend(ev_remove(registry, name));
    }
    // The `sync` barrier always answers last: by the time the client
    // dispatches it, every burst above has been dispatched too.
    let mut done_payload = Vec::new();
    wire_u32(&mut done_payload, 0);
    reply.extend(wire_message(callback_id.expect("sync seen"), 0, &done_payload));
    peer.write_all(&reply).expect("fake peer replies");
    let mut chunk = [0u8; 64];
    loop {
        match peer.read(&mut chunk) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

fn serve_silent(mut peer: UnixStream) {
    peer.set_read_timeout(Some(Duration::from_secs(2))).expect("read timeout");
    let mut chunk = [0u8; 4096];
    loop {
        match peer.read(&mut chunk) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

fn collect_against(
    outputs: Vec<FakeOutput>,
    removed: Vec<u32>,
    advertised_outputs: &[(u32, u32)],
    manager_version: u32,
    deadline_ms: u64,
) -> Result<Vec<super::outputs::Monitor>, OutputsError> {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    std::thread::spawn(|| serve_outputs(peer, outputs, removed));
    let conn = connection_from_stream(client).expect("client wraps the pair");
    collect(
        conn,
        &snapshot(advertised_outputs, manager_version),
        Instant::now() + Duration::from_millis(deadline_ms),
        &CancelHandle::new(),
    )
}

#[test]
fn two_outputs_keep_negative_origin_and_fractional_scale() {
    let monitors = collect_against(
        vec![
            FakeOutput {
                registry_name: 10,
                x: 0,
                y: 0,
                transform: 0,
                // Lies at 2x while mode/logical say 1.5x: the derived ratio wins.
                scale_factor: 2,
                current_mode: Some((3840, 2160, 60_000)),
                send_wl_done: true,
                logical_pos: Some((0, 0)),
                logical_size: Some((2560, 1440)),
                send_xdg_done: false,
                name_wl: Some("DP-1"),
                name_xdg: None,
            },
            FakeOutput {
                registry_name: 11,
                x: 0,
                y: 0,
                transform: 0,
                scale_factor: 1,
                current_mode: Some((1920, 1080, 144_000)),
                send_wl_done: true,
                logical_pos: Some((-1920, 100)),
                logical_size: Some((1920, 1080)),
                send_xdg_done: false,
                name_wl: None,
                name_xdg: Some("HDMI-1"),
            },
        ],
        vec![],
        &[(10, 4), (11, 4)],
        3,
        5_000,
    )
    .expect("two complete outputs enumerate");
    assert_eq!(monitors.len(), 2);
    // Advertisement order is enumeration order; identities are never invented.
    assert_eq!(monitors[0].registry_name, 10);
    assert_eq!(monitors[0].name.as_deref(), Some("DP-1"));
    assert_eq!(monitors[1].registry_name, 11);
    assert_eq!(monitors[1].name.as_deref(), Some("HDMI-1"));
    let first = &monitors[0].geometry;
    assert_eq!((first.x(), first.y()), (0, 0));
    assert_eq!((first.logical_width(), first.logical_height()), (2560, 1440));
    assert_eq!((first.buffer_width(), first.buffer_height()), (3840, 2160));
    // The integer scale lied: the actual per-axis ratio is authoritative.
    let (rx, ry) = first.effective_scale();
    assert!((rx - 1.5).abs() < 1e-9 && (ry - 1.5).abs() < 1e-9, "ratios {rx} {ry}");
    assert!((first.scale() - 1.5).abs() < 1e-9, "nominal {}", first.scale());
    assert_eq!(monitors[0].refresh_millihz, 60_000);
    // Negative origins survive; the deprecated wl_output x/y stay ignored.
    let second = &monitors[1].geometry;
    assert_eq!((second.x(), second.y()), (-1920, 100));
    assert_eq!((second.buffer_width(), second.buffer_height()), (1920, 1080));
    assert_eq!(monitors[1].refresh_millihz, 144_000);
}

#[test]
fn rotated_output_maps_through_the_validated_geometry() {
    let monitors = collect_against(
        vec![FakeOutput {
            registry_name: 10,
            x: 1920,
            y: 0,
            transform: 1,
            scale_factor: 1,
            current_mode: Some((1920, 1080, 60_000)),
            send_wl_done: true,
            logical_pos: Some((1920, 0)),
            logical_size: Some((1080, 1920)),
            send_xdg_done: false,
            // No names anywhere: the collector reports None, never a label.
            name_wl: None,
            name_xdg: None,
        }],
        vec![],
        &[(10, 4)],
        3,
        5_000,
    )
    .expect("rotated output enumerates");
    assert_eq!(monitors.len(), 1);
    assert_eq!(monitors[0].name, None);
    let g = &monitors[0].geometry;
    // Logical extents already account for rotation; the buffer does not.
    assert_eq!((g.logical_width(), g.logical_height()), (1080, 1920));
    assert_eq!((g.buffer_width(), g.buffer_height()), (1920, 1080));
    assert_eq!(g.expected_buffer_dimensions(), (1920, 1080));
    // Buffer center lands on the logical center through the inverse exactly once.
    let center = g.buffer_to_global(960.0, 540.0).expect("center maps");
    assert_eq!((center.x, center.y), (1920.0 + 539.5, 960.5));
    assert!(g.contains_global(center.x, center.y));
}

#[test]
fn withdrawn_output_fails_as_withdrawn() {
    let err = collect_against(
        vec![FakeOutput {
            registry_name: 10,
            x: 0,
            y: 0,
            transform: 0,
            scale_factor: 1,
            current_mode: Some((1920, 1080, 60_000)),
            send_wl_done: true,
            logical_pos: Some((0, 0)),
            logical_size: Some((1920, 1080)),
            send_xdg_done: false,
            name_wl: Some("DP-1"),
            name_xdg: None,
        }],
        vec![10],
        &[(10, 4)],
        3,
        5_000,
    )
    .expect_err("a withdrawn output must fail, never silently drop");
    assert!(
        matches!(err, OutputsError::Withdrawn { registry_name: 10 }),
        "got: {err}"
    );
    assert!(err.to_string().contains("10"), "error names the output, got: {err}");
}

#[test]
fn missing_protocols_fail_closed_before_any_io() {
    // No outputs advertised at all: no peer needed, fails before binding.
    let (client, _peer) = UnixStream::pair().expect("socketpair works in tests");
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let empty = CapabilitySnapshot::negotiate(&[advertised(20, XDG_OUTPUT_MANAGER, 3)]);
    let err = collect(
        conn,
        &empty,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect_err("no wl_output must fail closed");
    assert!(matches!(err, OutputsError::MissingProtocol(_)), "got: {err}");
    assert!(err.to_string().contains("wl_output"), "got: {err}");
    // Outputs but no xdg-output manager: logical geometry is unavailable.
    // Fresh connection per reject: operations consume their connections.
    let (client, _peer) = UnixStream::pair().expect("socketpair works in tests");
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let no_manager = CapabilitySnapshot::negotiate(&[advertised(10, WL_OUTPUT, 4)]);
    let err = collect(
        conn,
        &no_manager,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect_err("no xdg manager must fail closed");
    assert!(matches!(err, OutputsError::MissingProtocol(_)), "got: {err}");
    assert!(err.to_string().contains("zxdg_output_manager_v1"), "got: {err}");
    for compositor in ["niri", "sway", "gnome", "KDE"] {
        assert!(!err.to_string().contains(compositor), "no compositor guesses: {err}");
    }
}

#[test]
fn incomplete_metadata_names_the_output_and_the_gap() {
    // Logical size never sent (xdg v2, where `done` still bounds the burst):
    // the sync barrier fires with the output half-described.
    let err = collect_against(
        vec![FakeOutput {
            registry_name: 11,
            x: 0,
            y: 0,
            transform: 0,
            scale_factor: 1,
            current_mode: Some((1920, 1080, 60_000)),
            send_wl_done: true,
            logical_pos: Some((0, 0)),
            logical_size: None,
            send_xdg_done: true,
            name_wl: None,
            name_xdg: None,
        }],
        vec![],
        &[(11, 4)],
        2,
        5_000,
    )
    .expect_err("missing logical size must fail");
    assert!(matches!(err, OutputsError::Incomplete { registry_name: 11, .. }), "got: {err}");
    assert!(err.to_string().contains("11"), "got: {err}");
    // No current mode (only wl geometry + logical): likewise incomplete.
    let err = collect_against(
        vec![FakeOutput {
            registry_name: 12,
            x: 0,
            y: 0,
            transform: 0,
            scale_factor: 1,
            current_mode: None,
            send_wl_done: true,
            logical_pos: Some((0, 0)),
            logical_size: Some((1920, 1080)),
            send_xdg_done: false,
            name_wl: None,
            name_xdg: None,
        }],
        vec![],
        &[(12, 4)],
        3,
        5_000,
    )
    .expect_err("missing current mode must fail");
    assert!(matches!(err, OutputsError::Incomplete { registry_name: 12, .. }), "got: {err}");
}

#[test]
fn v1_output_completes_without_done_events() {
    // wl_output v1 never sends done/scale: geometry plus the current mode,
    // with the sync barrier as the bound, is the complete description.
    let monitors = collect_against(
        vec![FakeOutput {
            registry_name: 10,
            x: 0,
            y: 0,
            transform: 0,
            scale_factor: 1,
            current_mode: Some((1280, 800, 60_000)),
            send_wl_done: false,
            logical_pos: Some((0, 0)),
            logical_size: Some((1280, 800)),
            send_xdg_done: false,
            name_wl: None,
            name_xdg: None,
        }],
        vec![],
        &[(10, 1)],
        3,
        5_000,
    )
    .expect("v1 output completes through the sync barrier");
    assert_eq!(monitors.len(), 1);
    let g: &OutputGeometry = &monitors[0].geometry;
    assert_eq!((g.logical_width(), g.logical_height()), (1280, 800));
    assert_eq!((g.buffer_width(), g.buffer_height()), (1280, 800));
}

#[test]
fn silent_peer_hits_the_total_deadline() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    std::thread::spawn(|| serve_silent(peer));
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let start = Instant::now();
    let err = collect(
        conn,
        &snapshot(&[(10, 4)], 3),
        start + Duration::from_millis(300),
        &CancelHandle::new(),
    )
    .expect_err("a silent peer must hit the deadline");
    assert!(
        matches!(&err, OutputsError::Transport(e) if e.kind == TransportKind::Timeout),
        "got: {err}"
    );
    assert!(start.elapsed() < Duration::from_secs(3), "stays bounded");
}

#[test]
fn cancellation_wakes_the_collection() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    std::thread::spawn(|| serve_silent(peer));
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let waker = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        waker.cancel();
    });
    let start = Instant::now();
    let err = collect(
        conn,
        &snapshot(&[(10, 4)], 3),
        start + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("cancel must wake the sweep");
    assert!(
        matches!(&err, OutputsError::Transport(e) if e.kind == TransportKind::Cancelled),
        "got: {err}"
    );
    assert!(start.elapsed() < Duration::from_secs(2), "wakes early");
}
