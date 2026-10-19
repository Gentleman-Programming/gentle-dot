//! RED/GREEN checks for [`super::pointer`]: bounded virtual-pointer move,
//! click (left/right, count 1..=3), drag and scroll over a fake peer on an
//! isolated socket. No real compositor is touched: the fake below speaks just
//! enough wire protocol (`get_registry`, `bind`,
//! `create_virtual_pointer_with_output`, the pointer requests, `sync`) and
//! records every client request in order. Every wait carries the total
//! deadline and the cooperative cancel handle; there is no `roundtrip`
//! anywhere in these tests.
//!
//! What each test pins through the public boundary: exact request order for
//! move/click/drag/scroll (including per-click press/release pairs, button
//! evdev codes, axis values and the explicit destroy before the confirming
//! sync); selected-output normalized logical coordinates for negative-origin
//! and rotated outputs (never the union box, never clamped); validation
//! rejects (unknown output, outside point, bad count, oversized scroll,
//! missing protocol, v1 manager) sending zero bytes; cancel mid-drag
//! releasing the owned button before destroy; dead/silent peers staying
//! bounded and never reporting success.

use super::capabilities::{AdvertisedGlobal, CapabilitySnapshot, VIRTUAL_POINTER, WL_OUTPUT};
use super::geometry::OutputGeometry;
use super::outputs::Monitor;
use super::pointer::{
    click_pointer, deliver_drag_steps, drag_path, drag_pointer, move_pointer, scroll_pointer,
    DragStep, OutputPoint, PointerButton, PointerError, DRAG_STEPS,
};
use super::transport::{connection_from_stream, CancelHandle, TransportKind};
use std::cell::RefCell;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn advertised(name: u32, interface: &str, version: u32) -> AdvertisedGlobal {
    AdvertisedGlobal { name, interface: interface.to_owned(), version }
}

fn snapshot_with(outputs: &[(u32, u32)], vp_version: u32) -> CapabilitySnapshot {
    let mut globals = Vec::new();
    for (name, version) in outputs {
        globals.push(advertised(*name, WL_OUTPUT, *version));
    }
    globals.push(advertised(40, VIRTUAL_POINTER, vp_version));
    CapabilitySnapshot::negotiate(&globals)
}

fn monitor(
    registry_name: u32,
    x: i32,
    y: i32,
    logical_w: i32,
    logical_h: i32,
    scale: f64,
    transform: i32,
    buffer_w: i32,
    buffer_h: i32,
) -> Monitor {
    Monitor {
        registry_name,
        name: None,
        geometry: OutputGeometry::new(
            x, y, logical_w, logical_h, scale, transform, buffer_w, buffer_h,
        )
        .expect("test monitor geometry validates"),
        refresh_millihz: 60_000,
    }
}

fn plain_monitor(registry_name: u32) -> Monitor {
    monitor(registry_name, 0, 0, 1920, 1080, 1.0, 0, 1920, 1080)
}

// --- Minimal fake pointer peer (std only, no extra deps). ---
//
// Parses `wl_display.get_registry` / `sync` (opcodes 1/0 on object 1),
// `wl_registry.bind` (opcode 0), `create_virtual_pointer_with_output`
// (manager opcode 2) and the pointer requests (motion_absolute = 1, button
// = 2, axis = 3, frame = 4, destroy = 8) into an ordered observation log.
// Times are parsed but ignored (wall-clock `time` fields are never stable
// across runs); everything else is asserted exactly.

fn wire_u32(into: &mut Vec<u8>, value: u32) {
    into.extend_from_slice(&value.to_ne_bytes());
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

#[derive(Debug, Clone, PartialEq)]
enum Observed {
    BindManager { version: u32 },
    BindOutput { name: u32, version: u32 },
    CreateWithOutput { seat: u32, output_name: u32 },
    MotionAbs { x: u32, y: u32, x_extent: u32, y_extent: u32 },
    Button { button: u32, state: u32 },
    Axis { axis: u32, value: i32 },
    Frame,
    Destroy,
    ManagerDestroy,
    OutputRelease,
    Sync,
}

const BTN_LEFT: u32 = 0x110;
const BTN_RIGHT: u32 = 0x111;
const PRESSED: u32 = 1;
const RELEASED: u32 = 0;
const AXIS_VERTICAL: u32 = 0;
const AXIS_HORIZONTAL: u32 = 1;

struct Peer {
    observed: Arc<Mutex<Vec<Observed>>>,
    bytes: Arc<AtomicUsize>,
    eof: Arc<AtomicBool>,
}

impl Peer {
    fn take(&self) -> Vec<Observed> {
        self.observed.lock().expect("peer log").clone()
    }
}

fn spawn_peer(silent: bool) -> (UnixStream, Peer, std::thread::JoinHandle<()>) {
    let (client, mut peer) = UnixStream::pair().expect("socketpair works in tests");
    let observed = Arc::new(Mutex::new(Vec::new()));
    let bytes = Arc::new(AtomicUsize::new(0));
    let eof = Arc::new(AtomicBool::new(false));
    let handle = Peer { observed: observed.clone(), bytes: bytes.clone(), eof: eof.clone() };
    let thread = std::thread::spawn(move || {
        peer.set_read_timeout(Some(Duration::from_secs(2))).expect("read timeout");
        let mut buffered = Vec::new();
        let mut registry_id = None;
        let mut manager_id = None;
        let mut output_ids: Vec<(u32, u32)> = Vec::new();
        let mut pointer_ids: Vec<u32> = Vec::new();
        let mut callback_id = None;
        let mut chunk = [0u8; 4096];
        loop {
            match peer.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    bytes.fetch_add(read, Ordering::SeqCst);
                    buffered.extend_from_slice(&chunk[..read]);
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.kind() == std::io::ErrorKind::TimedOut =>
                {
                    continue
                }
                Err(_) => break,
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
                let body = buffered[8..size].to_vec();
                buffered.drain(..size);
                let mut log = observed.lock().expect("peer log");
                if sender == 1 && opcode == 1 {
                    let mut off = 0;
                    registry_id = Some(read_u32(&body, &mut off));
                } else if sender == 1 && opcode == 0 {
                    let mut off = 0;
                    callback_id = Some(read_u32(&body, &mut off));
                    log.push(Observed::Sync);
                    drop(log);
                    if !silent {
                        let mut payload = Vec::new();
                        wire_u32(&mut payload, 0);
                        let reply = wire_message(callback_id.expect("sync id"), 0, &payload);
                        peer.write_all(&reply).expect("fake peer answers sync");
                    }
                    continue;
                } else if Some(sender) == registry_id && opcode == 0 {
                    let mut off = 0;
                    let name = read_u32(&body, &mut off);
                    let interface = read_string(&body, &mut off);
                    let version = read_u32(&body, &mut off);
                    let new_id = read_u32(&body, &mut off);
                    if interface == "zwlr_virtual_pointer_manager_v1" {
                        manager_id = Some(new_id);
                        log.push(Observed::BindManager { version });
                    } else if interface == "wl_output" {
                        output_ids.push((new_id, name));
                        log.push(Observed::BindOutput { name, version });
                    }
                } else if Some(sender) == manager_id && opcode == 2 {
                    let mut off = 0;
                    let seat = read_u32(&body, &mut off);
                    let output = read_u32(&body, &mut off);
                    let new_id = read_u32(&body, &mut off);
                    let name = output_ids
                        .iter()
                        .find(|(id, _)| *id == output)
                        .map(|(_, name)| *name)
                        .expect("create names a bound output");
                    pointer_ids.push(new_id);
                    log.push(Observed::CreateWithOutput { seat, output_name: name });
                } else if Some(sender) == manager_id && opcode == 1 {
                    // `zwlr_virtual_pointer_manager_v1.destroy` is the
                    // manager's only v1 destructor-adjacent request.
                    log.push(Observed::ManagerDestroy);
                } else if output_ids.iter().any(|(id, _)| *id == sender) && opcode == 0 {
                    // `wl_output`'s only request is `release` (since v3).
                    log.push(Observed::OutputRelease);
                } else if pointer_ids.contains(&sender) {
                    let mut off = 0;
                    match opcode {
                        1 => {
                            let _time = read_u32(&body, &mut off);
                            let x = read_u32(&body, &mut off);
                            let y = read_u32(&body, &mut off);
                            let xe = read_u32(&body, &mut off);
                            let ye = read_u32(&body, &mut off);
                            log.push(Observed::MotionAbs { x, y, x_extent: xe, y_extent: ye });
                        }
                        2 => {
                            let _time = read_u32(&body, &mut off);
                            let button = read_u32(&body, &mut off);
                            let state = read_u32(&body, &mut off);
                            log.push(Observed::Button { button, state });
                        }
                        3 => {
                            let _time = read_u32(&body, &mut off);
                            let axis = read_u32(&body, &mut off);
                            let value = read_u32(&body, &mut off) as i32;
                            log.push(Observed::Axis { axis, value });
                        }
                        4 => log.push(Observed::Frame),
                        8 => log.push(Observed::Destroy),
                        other => panic!("fake peer saw unknown pointer opcode {other}"),
                    }
                }
            }
        }
        eof.store(true, Ordering::SeqCst);
    });
    (client, handle, thread)
}

/// Poll the peer log until `wanted` holds (or panic after `timeout_ms`): the
/// deterministic seam for cancel/disconnect races, never a bare sleep.
fn wait_for(peer: &Peer, timeout_ms: u64, wanted: &dyn Fn(&[Observed]) -> bool) -> Vec<Observed> {
    let start = Instant::now();
    loop {
        let seen = peer.take();
        if wanted(&seen) {
            return seen;
        }
        assert!(
            start.elapsed() < Duration::from_millis(timeout_ms),
            "peer never showed the wanted events, got: {seen:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn wait_eof(peer: &Peer, timeout_ms: u64) {
    let start = Instant::now();
    while !peer.eof.load(Ordering::SeqCst) {
        assert!(
            start.elapsed() < Duration::from_millis(timeout_ms),
            "peer never saw EOF"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn contains(log: &[Observed], event: &Observed) -> bool {
    log.iter().any(|seen| seen == event)
}

#[test]
fn move_sends_absolute_frame_and_destroy_in_order() {
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    move_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        100.0,
        200.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("move against a live peer succeeds");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Sync));
    assert_eq!(
        seen,
        vec![
            Observed::BindManager { version: 2 },
            Observed::BindOutput { name: 7, version: 4 },
            Observed::CreateWithOutput { seat: 0, output_name: 7 },
            Observed::MotionAbs { x: 100, y: 200, x_extent: 1920, y_extent: 1080 },
            Observed::Frame,
            Observed::Destroy,
            Observed::ManagerDestroy,
            Observed::OutputRelease,
            Observed::Sync,
        ],
        "move order must be exact: no seat hint, output-bound create, then \
         pointer/manager/output teardown before the confirming sync"
    );
    // The operation consumes its connection: the peer must see EOF once the
    // call returns, proving no shared connection is left alive to
    // accumulate registries on.
    wait_eof(&peer, 2_000);
}

#[test]
fn click_left_twice_sends_two_press_release_pairs() {
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    click_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        50.0,
        60.0,
        PointerButton::Left,
        2,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("click against a live peer succeeds");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Destroy));
    assert_eq!(
        seen,
        vec![
            Observed::BindManager { version: 2 },
            Observed::BindOutput { name: 7, version: 4 },
            Observed::CreateWithOutput { seat: 0, output_name: 7 },
            Observed::MotionAbs { x: 50, y: 60, x_extent: 1920, y_extent: 1080 },
            Observed::Frame,
            Observed::Button { button: BTN_LEFT, state: PRESSED },
            Observed::Frame,
            Observed::Button { button: BTN_LEFT, state: RELEASED },
            Observed::Frame,
            Observed::Button { button: BTN_LEFT, state: PRESSED },
            Observed::Frame,
            Observed::Button { button: BTN_LEFT, state: RELEASED },
            Observed::Frame,
            Observed::Destroy,
            Observed::ManagerDestroy,
            Observed::OutputRelease,
            Observed::Sync,
        ]
    );
}

#[test]
fn click_right_once_uses_the_right_evdev_code() {
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    click_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        10.0,
        20.0,
        PointerButton::Right,
        1,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("right click succeeds");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Destroy));
    let presses: Vec<_> = seen
        .iter()
        .filter(|event| matches!(event, Observed::Button { state: PRESSED, .. }))
        .collect();
    assert_eq!(presses.len(), 1, "count 1 presses exactly once, got: {seen:?}");
    assert!(
        contains(&seen, &Observed::Button { button: BTN_RIGHT, state: PRESSED }),
        "right click uses 0x111, got: {seen:?}"
    );
    assert!(
        contains(&seen, &Observed::Button { button: BTN_RIGHT, state: RELEASED }),
        "every press is released, got: {seen:?}"
    );
}

#[test]
fn click_count_outside_one_to_three_rejects_before_any_input() {
    for count in [0, 4] {
        let (client, peer, _thread) = spawn_peer(false);
        let conn = connection_from_stream(client).expect("client wraps the pair");
        let err = click_pointer(
            conn,
            &snapshot_with(&[(7, 4)], 2),
            &plain_monitor(7),
            10.0,
            20.0,
            PointerButton::Left,
            count,
            Instant::now() + Duration::from_secs(5),
            &CancelHandle::new(),
        )
        .expect_err("count outside 1..=3 must fail");
        assert!(
            matches!(err, PointerError::InvalidCount { count: got } if got == count),
            "got: {err}"
        );
        wait_eof(&peer, 2_000);
        assert_eq!(peer.bytes.load(Ordering::SeqCst), 0, "no request may precede validation");
        assert!(peer.take().is_empty(), "no event may precede validation");
    }
}

#[test]
fn negative_origin_maps_to_output_local_coordinates() {
    // Output left of the reference point: global (-100, 200) is local
    // (1820, 100). A union-box clamp would send (0, 200) with global
    // extents; the output-bound device must send output-local values.
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    move_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &monitor(7, -1920, 100, 1920, 1080, 1.0, 0, 1920, 1080),
        -100.0,
        200.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("move inside a negative-origin output succeeds");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Destroy));
    assert!(
        contains(
            &seen,
            &Observed::MotionAbs { x: 1820, y: 100, x_extent: 1920, y_extent: 1080 }
        ),
        "negative origins map to output-local coords, got: {seen:?}"
    );
    assert!(
        contains(&seen, &Observed::CreateWithOutput { seat: 0, output_name: 7 }),
        "the device stays bound to the selected output, got: {seen:?}"
    );
}

#[test]
fn rotated_output_uses_logical_extents() {
    // 1920x1080 buffer turned 90 degrees: logical 1080x1920 at (1920, 0).
    // The normalized frame is the logical size; rotation is the
    // compositor's job, applied exactly once server-side.
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    move_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &monitor(7, 1920, 0, 1080, 1920, 1.0, 1, 1920, 1080),
        1920.0 + 540.0,
        960.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("move inside a rotated output succeeds");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Destroy));
    assert!(
        contains(
            &seen,
            &Observed::MotionAbs { x: 540, y: 960, x_extent: 1080, y_extent: 1920 }
        ),
        "rotated outputs map through logical extents, got: {seen:?}"
    );
}

#[test]
fn point_in_the_gap_rejects_before_any_input() {
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let err = move_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        2000.0,
        100.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect_err("a point outside the selected output must fail");
    assert!(
        matches!(err, PointerError::OutsideOutput { .. }),
        "gaps are refused, never clamped, got: {err}"
    );
    wait_eof(&peer, 2_000);
    assert_eq!(peer.bytes.load(Ordering::SeqCst), 0, "no request may precede validation");
    assert!(peer.take().is_empty(), "no event may precede validation");
}

#[test]
fn unknown_output_rejects_before_any_input() {
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let err = move_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(99),
        100.0,
        100.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect_err("an unadvertised output id must fail");
    assert!(
        matches!(err, PointerError::UnknownOutput { registry_name: 99 }),
        "got: {err}"
    );
    wait_eof(&peer, 2_000);
    assert_eq!(peer.bytes.load(Ordering::SeqCst), 0, "no request may precede validation");
    assert!(peer.take().is_empty(), "no event may precede validation");
}

#[test]
fn missing_virtual_pointer_protocol_fails_closed() {
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let snapshot =
        CapabilitySnapshot::negotiate(&[advertised(7, WL_OUTPUT, 4)]);
    let err = move_pointer(
        conn,
        &snapshot,
        &plain_monitor(7),
        100.0,
        100.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect_err("a compositor without the manager must fail");
    assert!(
        matches!(err, PointerError::MissingProtocol(_)),
        "got: {err}"
    );
    assert!(err.to_string().contains("zwlr_virtual_pointer_manager_v1"), "got: {err}");
    for compositor in ["niri", "sway", "gnome", "KDE"] {
        assert!(!err.to_string().contains(compositor), "no compositor guesses: {err}");
    }
    wait_eof(&peer, 2_000);
    assert_eq!(peer.bytes.load(Ordering::SeqCst), 0, "no request may precede validation");
}

#[test]
fn version_one_manager_refuses_output_bound_truthfully() {
    // v1 has no create_virtual_pointer_with_output: failing closed beats
    // guessing an unmapped global coordinate space.
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let err = move_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 1),
        &plain_monitor(7),
        100.0,
        100.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect_err("a v1 manager must fail, never fall back");
    assert!(
        matches!(err, PointerError::UnsupportedOutputBound { advertised: 1 }),
        "got: {err}"
    );
    assert!(err.to_string().contains("version 2"), "got: {err}");
    wait_eof(&peer, 2_000);
    assert_eq!(peer.bytes.load(Ordering::SeqCst), 0, "no request may precede validation");
    assert!(peer.take().is_empty(), "no event may precede validation");
}

#[test]
fn drag_holds_moves_and_releases_in_order() {
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    drag_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        100.0,
        100.0,
        200.0,
        150.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("drag against a live peer succeeds");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Destroy));
    let motions: Vec<(u32, u32)> = seen
        .iter()
        .filter_map(|event| match event {
            Observed::MotionAbs { x, y, .. } => Some((*x, *y)),
            _ => None,
        })
        .collect();
    assert!(motions.len() >= 3, "drag interpolates between endpoints, got: {seen:?}");
    assert_eq!(motions.first(), Some(&(100, 100)), "drag starts at from, got: {seen:?}");
    assert_eq!(motions.last(), Some(&(200, 150)), "drag ends exactly at to, got: {seen:?}");
    for motion in &seen {
        if let Observed::MotionAbs { x_extent, y_extent, .. } = motion {
            assert_eq!((*x_extent, *y_extent), (1920, 1080), "every motion shares the output extents");
        }
    }
    let pos = |event: &Observed| seen.iter().position(|seen| seen == event).expect("event present");
    let press = pos(&Observed::Button { button: BTN_LEFT, state: PRESSED });
    let release = pos(&Observed::Button { button: BTN_LEFT, state: RELEASED });
    let destroy = pos(&Observed::Destroy);
    let first_motion = seen.iter().position(|event| matches!(event, Observed::MotionAbs { .. })).expect("motion");
    let last_motion = seen.iter().rposition(|event| matches!(event, Observed::MotionAbs { .. })).expect("motion");
    assert!(first_motion < press, "press follows the move to from, got: {seen:?}");
    assert!(press < last_motion, "motion happens while held, got: {seen:?}");
    assert!(last_motion < release, "release follows the move to to, got: {seen:?}");
    assert!(release < destroy, "release precedes destroy, got: {seen:?}");
    let manager_destroy = pos(&Observed::ManagerDestroy);
    let output_release = pos(&Observed::OutputRelease);
    let sync = pos(&Observed::Sync);
    assert!(destroy < manager_destroy, "manager teardown follows the device, got: {seen:?}");
    assert!(manager_destroy < output_release, "output release follows the manager, got: {seen:?}");
    assert!(output_release < sync, "teardown precedes the confirming sync, got: {seen:?}");
    assert_eq!(
        seen.iter().filter(|event| matches!(event, Observed::Button { .. })).count(),
        2,
        "exactly one press and one release, got: {seen:?}"
    );
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DragEffect {
    Check,
    Motion { x: u32, y: u32 },
    Flush,
    Pause,
}

fn drag_endpoints() -> (OutputPoint, OutputPoint) {
    (
        OutputPoint { x: 100, y: 100, x_extent: 1920, y_extent: 1080 },
        OutputPoint { x: 200, y: 150, x_extent: 1920, y_extent: 1080 },
    )
}

#[test]
fn drag_path_yields_exactly_the_interpolated_steps_ending_at_to() {
    let (from, to) = drag_endpoints();
    let path = drag_path(from, to);
    assert_eq!(path.len(), DRAG_STEPS as usize, "one point per drag step");
    assert_eq!(path.last(), Some(&to), "the path ends exactly at to");
    assert!(
        path.iter().all(|point| {
            point.x >= from.x && point.x <= to.x && point.y >= from.y && point.y <= to.y
        }),
        "every step stays between from and to, got: {path:?}"
    );
}

#[test]
fn deliver_drag_steps_runs_check_motion_flush_pause_for_every_step() {
    let (from, to) = drag_endpoints();
    let path = drag_path(from, to);
    let log: Rc<RefCell<Vec<DragEffect>>> = Rc::new(RefCell::new(Vec::new()));
    let mut step = DragStep {
        check: || {
            log.borrow_mut().push(DragEffect::Check);
            Ok(())
        },
        motion: |point: &OutputPoint| {
            log.borrow_mut().push(DragEffect::Motion { x: point.x, y: point.y });
            Ok(())
        },
        flush: || {
            log.borrow_mut().push(DragEffect::Flush);
            Ok(())
        },
        pause: || {
            log.borrow_mut().push(DragEffect::Pause);
            Ok(())
        },
    };
    deliver_drag_steps(&path, &mut step).expect("every injected effect succeeds");

    let mut expected = Vec::new();
    for point in &path {
        expected.push(DragEffect::Check);
        expected.push(DragEffect::Motion { x: point.x, y: point.y });
        expected.push(DragEffect::Flush);
        expected.push(DragEffect::Pause);
    }
    let effects = log.borrow().clone();
    assert_eq!(effects, expected, "cadence is check, motion, flush, pause per step");
    assert_eq!(
        effects.iter().filter(|effect| matches!(effect, DragEffect::Motion { .. })).count(),
        DRAG_STEPS as usize,
        "one motion per drag step"
    );
    let last_motion = effects.iter().rev().find_map(|effect| match effect {
        DragEffect::Motion { x, y } => Some((*x, *y)),
        _ => None,
    });
    assert_eq!(last_motion, Some((to.x, to.y)), "the last motion is exactly to");
}

#[test]
fn a_failing_check_aborts_the_step_before_motion_and_flush() {
    let (from, to) = drag_endpoints();
    let path = drag_path(from, to);
    let log: Rc<RefCell<Vec<DragEffect>>> = Rc::new(RefCell::new(Vec::new()));
    let mut step = DragStep {
        check: || {
            log.borrow_mut().push(DragEffect::Check);
            Err(PointerError::NonFiniteCoordinate)
        },
        motion: |point: &OutputPoint| {
            log.borrow_mut().push(DragEffect::Motion { x: point.x, y: point.y });
            Ok(())
        },
        flush: || {
            log.borrow_mut().push(DragEffect::Flush);
            Ok(())
        },
        pause: || {
            log.borrow_mut().push(DragEffect::Pause);
            Ok(())
        },
    };
    let err = deliver_drag_steps(&path, &mut step).expect_err("a check error aborts delivery");
    assert!(matches!(err, PointerError::NonFiniteCoordinate), "got: {err}");
    let effects = log.borrow().clone();
    assert_eq!(
        effects,
        vec![DragEffect::Check],
        "no motion, flush or pause follows a failing check"
    );
}

#[test]
fn scroll_sends_signed_axis_ticks_with_frames() {
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    scroll_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        300.0,
        400.0,
        2.0,
        -1.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("scroll against a live peer succeeds");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Destroy));
    assert_eq!(
        seen,
        vec![
            Observed::BindManager { version: 2 },
            Observed::BindOutput { name: 7, version: 4 },
            Observed::CreateWithOutput { seat: 0, output_name: 7 },
            Observed::MotionAbs { x: 300, y: 400, x_extent: 1920, y_extent: 1080 },
            Observed::Frame,
            // Negative dy scrolls up; positive dx scrolls right (15 units/notch).
            Observed::Axis { axis: AXIS_VERTICAL, value: -15 * 256 },
            Observed::Frame,
            Observed::Axis { axis: AXIS_HORIZONTAL, value: 15 * 256 },
            Observed::Frame,
            Observed::Axis { axis: AXIS_HORIZONTAL, value: 15 * 256 },
            Observed::Frame,
            Observed::Destroy,
            Observed::ManagerDestroy,
            Observed::OutputRelease,
            Observed::Sync,
        ]
    );
}

#[test]
fn oversized_and_nonfinite_scroll_reject_before_any_input() {
    // Fresh peer and connection per vector: operations consume their
    // connections, and each reject must send nothing on its own wire.
    for (dx, dy) in [(1000.0, 0.0), (f64::NAN, 1.0), (1.0, f64::INFINITY)] {
        let (client, peer, _thread) = spawn_peer(false);
        let conn = connection_from_stream(client).expect("client wraps the pair");
        let err = scroll_pointer(
            conn,
            &snapshot_with(&[(7, 4)], 2),
            &plain_monitor(7),
            300.0,
            400.0,
            dx,
            dy,
            Instant::now() + Duration::from_secs(5),
            &CancelHandle::new(),
        )
        .expect_err("refused scroll vectors must fail");
        assert!(
            matches!(err, PointerError::InvalidScroll { .. } | PointerError::NonFiniteCoordinate),
            "got: {err}"
        );
        wait_eof(&peer, 2_000);
        assert_eq!(peer.bytes.load(Ordering::SeqCst), 0, "no request may precede validation");
        assert!(peer.take().is_empty(), "no event may precede validation");
    }
}

#[test]
fn scroll_accepts_120_ticks_and_refuses_121_with_a_split_hint() {
    // The raised Linux per-operation cap: 120 axis ticks are queued and sent.
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    scroll_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        300.0,
        400.0,
        0.0,
        120.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("120 axis ticks is exactly the raised per-operation cap");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Destroy));
    assert_eq!(
        seen.iter().filter(|event| matches!(event, Observed::Axis { .. })).count(),
        120,
        "a vertical scroll of 120 sends 120 vertical ticks, got: {seen:?}"
    );
    wait_eof(&peer, 2_000);

    // One tick past the cap stays refused before any input, and the refusal tells the
    // caller to split the scroll instead of guessing a smaller number.
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let err = scroll_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        300.0,
        400.0,
        0.0,
        121.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect_err("121 axis ticks must stay refused");
    assert!(matches!(err, PointerError::InvalidScroll { .. }), "got: {err}");
    let text = err.to_string();
    assert!(text.contains("120"), "the refusal names the cap: {text}");
    assert!(text.contains("split"), "the refusal tells the caller to split the scroll: {text}");
    wait_eof(&peer, 2_000);
    assert_eq!(peer.bytes.load(Ordering::SeqCst), 0, "no request may precede validation");
    assert!(peer.take().is_empty(), "no event may precede validation");
}

#[test]
fn a_cancelled_scroll_stops_before_any_tick_and_never_claims_success() {
    // A Stop that arrives before the ticks are queued must end the scroll through the error
    // path (its teardown still reaches the peer), not after queueing the whole burst.
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    cancel.cancel();
    let err = scroll_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        300.0,
        400.0,
        0.0,
        120.0,
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("a cancelled scroll must not report success");
    assert!(
        matches!(&err, PointerError::Transport(error) if error.kind == TransportKind::Cancelled),
        "got: {err}"
    );
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Destroy));
    assert_eq!(
        seen.iter().filter(|event| matches!(event, Observed::Axis { .. })).count(),
        0,
        "no tick may be queued before the Stop is honored, got: {seen:?}"
    );
}

#[test]
fn cancel_mid_drag_releases_the_owned_button_before_destroy() {
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let waker = cancel.clone();
    let result = std::thread::scope(|scope| {
        // The operation owns its connection, so it moves into the worker:
        // reuse across operations is unrepresentable by construction.
        let worker = scope.spawn(move || {
            drag_pointer(
                conn,
                &snapshot_with(&[(7, 4)], 2),
                &plain_monitor(7),
                100.0,
                100.0,
                900.0,
                800.0,
                Instant::now() + Duration::from_secs(5),
                &cancel,
            )
        });
        // Cancel once the press is on the wire: deterministic, no bare sleep.
        wait_for(&peer, 5_000, &|log| {
            contains(log, &Observed::Button { button: BTN_LEFT, state: PRESSED })
        });
        waker.cancel();
        worker.join().expect("drag thread joins")
    });
    let err = result.expect_err("a cancelled drag must not report success");
    assert!(
        matches!(&err, PointerError::Transport(error) if error.kind == TransportKind::Cancelled),
        "got: {err}"
    );
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::OutputRelease));
    let pos = |event: &Observed| seen.iter().position(|seen| seen == event).expect("event present");
    let press = pos(&Observed::Button { button: BTN_LEFT, state: PRESSED });
    let release = pos(&Observed::Button { button: BTN_LEFT, state: RELEASED });
    let destroy = pos(&Observed::Destroy);
    let manager_destroy = pos(&Observed::ManagerDestroy);
    let output_release = pos(&Observed::OutputRelease);
    assert!(press < release, "the owned press is released, got: {seen:?}");
    assert!(release < destroy, "release precedes destroy, got: {seen:?}");
    assert!(
        destroy < manager_destroy && manager_destroy < output_release,
        "teardown follows the device even when cancelled, got: {seen:?}"
    );
    assert!(
        !contains(&seen, &Observed::Sync),
        "no confirming sync is ever sent on the cancel path, got: {seen:?}"
    );
    assert_eq!(
        seen.iter().filter(|event| matches!(event, Observed::Button { .. })).count(),
        2,
        "exactly one press and one release even when cancelled, got: {seen:?}"
    );
}

#[test]
fn dead_peer_is_a_bounded_disconnect_never_a_success() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    drop(peer);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let start = Instant::now();
    let err = move_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        100.0,
        200.0,
        start + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect_err("a dead peer must not report success");
    assert_eq!(err_kind(&err), Some(TransportKind::Disconnected), "got: {err}");
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "disconnect stays bounded, took {:?}",
        start.elapsed()
    );
}

#[test]
fn silent_peer_hits_the_deadline_never_a_success() {
    let (client, _peer, _thread) = spawn_peer(true);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let start = Instant::now();
    let err = move_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        100.0,
        200.0,
        start + Duration::from_millis(300),
        &CancelHandle::new(),
    )
    .expect_err("a silent peer must not report success");
    assert_eq!(err_kind(&err), Some(TransportKind::Timeout), "got: {err}");
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "silent peer stays bounded, took {:?}",
        start.elapsed()
    );
}

#[test]
fn old_output_version_skips_release_but_still_succeeds() {
    // `wl_output.release` exists only since version 3: below that the
    // output proxy has no destructor to send, so the operation destroys
    // the device and manager and lets the connection close free the rest.
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    move_pointer(
        conn,
        &snapshot_with(&[(7, 2)], 2),
        &plain_monitor(7),
        100.0,
        200.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("move against a v2 output succeeds without release");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Sync));
    assert_eq!(
        seen,
        vec![
            Observed::BindManager { version: 2 },
            Observed::BindOutput { name: 7, version: 2 },
            Observed::CreateWithOutput { seat: 0, output_name: 7 },
            Observed::MotionAbs { x: 100, y: 200, x_extent: 1920, y_extent: 1080 },
            Observed::Frame,
            Observed::Destroy,
            Observed::ManagerDestroy,
            Observed::Sync,
        ],
        "no release exists below v3, so none is fabricated, got: {seen:?}"
    );
}

#[test]
fn timeout_mid_drag_queues_release_before_destroy() {
    // A silent peer with a deadline inside the drag steps: the press is
    // already flushed, the steps hit the deadline, and the error path must
    // still queue release before destroy. Unlike the old silent move, this
    // drag holds a button when the deadline lands.
    let (client, peer, _thread) = spawn_peer(true);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let start = Instant::now();
    let err = drag_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        100.0,
        100.0,
        900.0,
        800.0,
        start + Duration::from_millis(40),
        &CancelHandle::new(),
    )
    .expect_err("a silent peer mid-drag must not report success");
    assert_eq!(err_kind(&err), Some(TransportKind::Timeout), "got: {err}");
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "stays bounded, took {:?}",
        start.elapsed()
    );
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Destroy));
    let pos = |event: &Observed| seen.iter().position(|seen| seen == event).expect("event present");
    let press = pos(&Observed::Button { button: BTN_LEFT, state: PRESSED });
    let release = pos(&Observed::Button { button: BTN_LEFT, state: RELEASED });
    let destroy = pos(&Observed::Destroy);
    assert!(press < release, "the owned press is released, got: {seen:?}");
    assert!(release < destroy, "release precedes destroy, got: {seen:?}");
    assert!(
        !contains(&seen, &Observed::Sync),
        "no confirming sync is ever sent on the timeout path, got: {seen:?}"
    );
}

#[test]
fn nonfinite_move_rejects_before_any_input() {
    let (client, peer, _thread) = spawn_peer(false);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let err = move_pointer(
        conn,
        &snapshot_with(&[(7, 4)], 2),
        &plain_monitor(7),
        f64::NAN,
        200.0,
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect_err("a NaN coordinate must fail");
    assert!(
        matches!(err, PointerError::NonFiniteCoordinate),
        "got: {err}"
    );
    wait_eof(&peer, 2_000);
    assert_eq!(peer.bytes.load(Ordering::SeqCst), 0, "no request may precede validation");
    assert!(peer.take().is_empty(), "no event may precede validation");
}

fn err_kind(error: &PointerError) -> Option<TransportKind> {
    match error {
        PointerError::Transport(error) => Some(error.kind),
        _ => None,
    }
}
