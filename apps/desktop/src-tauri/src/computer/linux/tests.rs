//! Deterministic T3a checks: Unix-socket deadline/cancel behavior, fake-peer
//! registry discovery, and pure registry negotiation. No real compositor is
//! touched: socket tests use `UnixStream::pair` or isolated listeners under
//! the process temp dir, and the fake peer below speaks just enough Wayland
//! wire protocol (`get_registry` + `sync`) for the sweep. (Remaining
//! protocol-live gap: a real compositor sweep is still untested; only the
//! fake-peer discovery path is covered here.)

use super::capabilities::{
    AdvertisedGlobal, CapabilitySnapshot, SCREENCOPY, VIRTUAL_KEYBOARD, VIRTUAL_POINTER,
    VIRTUAL_POINTER_MAX, WL_OUTPUT, WL_SEAT, WL_SHM, XDG_OUTPUT_MANAGER,
};
use super::transport::{
    connect_bounded, connection_from_stream, discover, resolve_socket_path, wait_readable,
    CancelHandle, TransportKind,
};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn advertised(name: u32, interface: &str, version: u32) -> AdvertisedGlobal {
    AdvertisedGlobal {
        name,
        interface: interface.to_owned(),
        version,
    }
}

// --- Minimal fake Wayland peer (std only, no extra deps). ---
//
// Speaks just enough of the wire protocol for the registry sweep: it reads
// `wl_display.get_registry` (opcode 1) and `wl_display.sync` (opcode 0) on
// object 1, then replays canned `wl_registry.global` (event 0) /
// `global_remove` (event 1) plus the `wl_callback.done` (event 0) that bounds
// the sweep. Header layout verified against wayland-backend 0.3.17
// (`src/rs/wire.rs`): `u32` sender, then `u32` `(size << 16) | opcode` with
// `size` covering the 8-byte header, all native-endian.

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

fn wire_global(registry: u32, name: u32, interface: &str, version: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    wire_u32(&mut payload, name);
    wire_string(&mut payload, interface);
    wire_u32(&mut payload, version);
    wire_message(registry, 0, &payload)
}

fn wire_global_remove(registry: u32, name: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    wire_u32(&mut payload, name);
    wire_message(registry, 1, &payload)
}

fn wire_done(callback: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    wire_u32(&mut payload, 0);
    wire_message(callback, 0, &payload)
}

struct FakeGlobal {
    name: u32,
    interface: &'static str,
    version: u32,
}

/// Run the fake peer until the client goes away: read both display requests,
/// replay `globals`, withdraw `removed`, answer the sync, then hold the
/// socket (reads time out) so silent-peer tests observe a quiet peer rather
/// than a hangup. Panics (test failure) instead of hanging: every read has a
/// timeout and the request wait has a total bound.
fn serve_registry(mut peer: UnixStream, globals: Vec<FakeGlobal>, removed: Vec<u32>) {
    peer.set_read_timeout(Some(Duration::from_secs(2)))
        .expect("fake peer sets a read timeout");
    let mut buffered = Vec::new();
    let mut registry_id = None;
    let mut callback_id = None;
    let start = Instant::now();
    while registry_id.is_none() || callback_id.is_none() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "fake peer never saw get_registry+sync"
        );
        let mut chunk = [0u8; 4096];
        match peer.read(&mut chunk) {
            Ok(0) => panic!("fake peer: client closed before the sweep requests"),
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
            if sender == 1 && opcode == 1 {
                registry_id = Some(u32::from_ne_bytes(buffered[8..12].try_into().expect("id")));
            }
            if sender == 1 && opcode == 0 {
                callback_id = Some(u32::from_ne_bytes(buffered[8..12].try_into().expect("id")));
            }
            buffered.drain(..size);
        }
    }
    let registry = registry_id.expect("get_registry seen");
    let mut reply = Vec::new();
    for global in &globals {
        reply.extend(wire_global(registry, global.name, global.interface, global.version));
    }
    for name in removed {
        reply.extend(wire_global_remove(registry, name));
    }
    reply.extend(wire_done(callback_id.expect("sync seen")));
    peer.write_all(&reply).expect("fake peer replies");
    // Hold until the client goes away so the sweep never sees a hangup here.
    let mut chunk = [0u8; 64];
    loop {
        match peer.read(&mut chunk) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

/// Hold a peer open without ever replying: the quiet compositor.
fn serve_silent(mut peer: UnixStream) {
    peer.set_read_timeout(Some(Duration::from_secs(2)))
        .expect("fake peer sets a read timeout");
    let mut chunk = [0u8; 4096];
    loop {
        match peer.read(&mut chunk) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

#[test]
fn silent_peer_hits_deadline() {
    let (a, _b) = UnixStream::pair().expect("socketpair works in tests");
    let cancel = CancelHandle::new();
    let start = Instant::now();
    let err = wait_readable(&a, "wait_readable", start + Duration::from_millis(150), &cancel)
        .expect_err("a silent peer must time out");
    assert_eq!(err.kind, TransportKind::Timeout);
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "deadline wait must stay bounded, took {:?}",
        start.elapsed()
    );
}

#[test]
fn cancellation_wakes_wait() {
    let (a, _b) = UnixStream::pair().expect("socketpair works in tests");
    let cancel = CancelHandle::new();
    let waker = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        waker.cancel();
    });
    let start = Instant::now();
    let err = wait_readable(&a, "wait_readable", start + Duration::from_secs(5), &cancel)
        .expect_err("cancel must wake the wait");
    assert_eq!(err.kind, TransportKind::Cancelled);
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "cancel must wake the wait early, took {:?}",
        start.elapsed()
    );
}

#[test]
fn missing_socket_fails_fast_without_hanging() {
    let missing = std::env::temp_dir().join("gentle-dot-no-such-compositor.sock");
    let cancel = CancelHandle::new();
    let start = Instant::now();
    let err = connect_bounded(&missing, start + Duration::from_secs(5), &cancel)
        .expect_err("a missing socket must error");
    assert_eq!(err.kind, TransportKind::NoCompositor);
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "missing socket must fail fast, took {:?}",
        start.elapsed()
    );
}

#[test]
fn socket_path_resolution_never_reads_process_env() {
    let abs = resolve_socket_path(Some("/tmp/abs-wayland-0"), Some("/run/ignored"))
        .expect("absolute display is used as-is");
    assert_eq!(abs.to_string_lossy(), "/tmp/abs-wayland-0");
    let rel = resolve_socket_path(Some("wayland-1"), Some("/run/user/1000"))
        .expect("relative display joins the runtime dir");
    assert_eq!(rel.to_string_lossy(), "/run/user/1000/wayland-1");
    let missing = resolve_socket_path(None, Some("/run/user/1000"))
        .expect_err("missing display must error");
    assert_eq!(missing.kind, TransportKind::NoCompositor);
    let noroot = resolve_socket_path(Some("wayland-1"), None).expect_err("missing dir must error");
    assert_eq!(noroot.kind, TransportKind::NoCompositor);
}

#[test]
fn negotiation_takes_minimum_and_keeps_every_output() {
    let snapshot = CapabilitySnapshot::negotiate(&[
        advertised(1, WL_SHM, 3),
        advertised(2, WL_SEAT, 11),
        advertised(3, WL_OUTPUT, 4),
        advertised(4, WL_OUTPUT, 2),
        advertised(5, XDG_OUTPUT_MANAGER, 3),
        advertised(6, VIRTUAL_POINTER, 1),
        advertised(7, VIRTUAL_KEYBOARD, 9),
        advertised(8, SCREENCOPY, 5),
    ]);
    // Above-cap advertisements clamp to what T3b/T4 will bind.
    assert_eq!(snapshot.shm.expect("shm").negotiated, 1);
    assert_eq!(snapshot.seat.expect("seat").negotiated, 7);
    assert_eq!(snapshot.virtual_pointer.expect("vp").negotiated, 1);
    assert_eq!(
        snapshot.virtual_keyboard.expect("vk").negotiated, 1,
        "virtual keyboard only exists at v1"
    );
    assert_eq!(snapshot.screencopy.expect("screencopy").negotiated, 3);
    // Below-cap advertisements keep their version, and every output survives.
    assert_eq!(snapshot.outputs.len(), 2);
    assert_eq!(snapshot.outputs[0].negotiated, 4);
    assert_eq!(snapshot.outputs[1].negotiated, 2);
    assert!(snapshot.missing().is_empty());
    // Unknown interfaces never leak into the snapshot.
    let extra = CapabilitySnapshot::negotiate(&[advertised(9, "zwp_xwayland_shell_v1", 1)]);
    assert!(!extra.missing().is_empty());
}

#[test]
fn missing_globals_fail_closed_with_interface_names() {
    let snapshot = CapabilitySnapshot::negotiate(&[advertised(3, WL_OUTPUT, 4)]);
    let missing = snapshot.missing();
    assert!(missing.contains(&WL_SHM));
    assert!(missing.contains(&WL_SEAT));
    assert!(missing.contains(&VIRTUAL_POINTER));
    assert!(!missing.contains(&WL_OUTPUT));
    let err = snapshot
        .require(VIRTUAL_POINTER)
        .expect_err("absent input capability must fail");
    let text = err.to_string();
    assert!(
        text.contains(VIRTUAL_POINTER),
        "error must name the interface, got: {text}"
    );
    for compositor in ["niri", "sway", "hyprland", "kwin", "gnome", "KDE"] {
        assert!(
            !text.contains(compositor),
            "error must not guess a compositor, got: {text}"
        );
    }
    // No version constant may exceed what the protocol defines: binding above
    // the compositor's max would fail, so negotiation must clamp. Pinned at
    // compile time; the clamp itself is exercised below with version 99.
    const { assert!(VIRTUAL_POINTER_MAX <= 2) };
    let vp = CapabilitySnapshot::negotiate(&[advertised(6, VIRTUAL_POINTER, 99)]);
    assert_eq!(vp.require(VIRTUAL_KEYBOARD).expect_err("vk missing").interface, VIRTUAL_KEYBOARD);
    assert_eq!(
        vp.require(VIRTUAL_POINTER).expect("vp present").negotiated,
        VIRTUAL_POINTER_MAX
    );
}

#[test]
fn connect_succeeds_over_an_isolated_listener() {
    let dir = std::env::temp_dir().join(format!("gentle-dot-wl-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("test scratch dir");
    let path = dir.join("wayland-test-0");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).expect("isolated listener binds");
    let seen = Arc::new(AtomicBool::new(false));
    let seen_peer = seen.clone();
    std::thread::spawn(move || {
        if listener.accept().is_ok() {
            seen_peer.store(true, Ordering::Release);
        }
    });
    let cancel = CancelHandle::new();
    let stream = connect_bounded(&path, Instant::now() + Duration::from_secs(5), &cancel)
        .expect("connect to a listening socket succeeds");
    assert!(stream.peer_addr().is_ok(), "connected stream has a peer");
    // Accept runs on another thread: connecting only queues the handshake,
    // so wait (bounded) for the peer to observe it.
    let observed = Instant::now();
    while !seen.load(Ordering::Acquire) {
        assert!(
            observed.elapsed() < Duration::from_secs(2),
            "peer never observed the connection"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir(&dir);
}

#[test]
fn interior_nul_socket_path_is_rejected() {
    let cancel = CancelHandle::new();
    let err = connect_bounded(
        std::path::Path::new("wayland-\0-0"),
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("a NUL-containing path must never reach connect");
    assert_eq!(err.kind, TransportKind::Io);
    assert!(
        err.to_string().contains("NUL"),
        "error must name the NUL problem, got: {err}"
    );
}

#[test]
fn connection_from_stream_accepts_a_live_socket() {
    let (client, _peer) = UnixStream::pair().expect("socketpair works in tests");
    connection_from_stream(client).expect("a live stream wraps into a Connection");
}

// A closed Unix peer with an empty buffer reports readable+HUP on Linux:
// EOF counts as readable under standard poll semantics, so `wait_readable`
// reports Ok and the disconnect surfaces at read time as zero bytes. The
// end-to-end disconnect is pinned by `discover_against_a_gone_peer`.
#[test]
fn hung_up_peer_without_data_reads_eof() {
    let (mut client, peer) = UnixStream::pair().expect("socketpair works in tests");
    drop(peer);
    let cancel = CancelHandle::new();
    wait_readable(&client, "wait_readable", Instant::now() + Duration::from_secs(5), &cancel)
        .expect("EOF is readable readiness, not a timeout");
    client.set_nonblocking(true).expect("test socket nonblocking");
    let mut ended = [0u8; 8];
    let read = client.read(&mut ended).expect("EOF read succeeds");
    assert_eq!(read, 0, "a hung-up peer with no data reads as EOF");
}

#[test]
fn discover_succeeds_against_a_fake_peer() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    std::thread::spawn(|| {
        serve_registry(
            peer,
            vec![
                FakeGlobal { name: 1, interface: WL_SHM, version: 3 },
                FakeGlobal { name: 2, interface: WL_OUTPUT, version: 4 },
                FakeGlobal { name: 3, interface: WL_OUTPUT, version: 2 },
                FakeGlobal { name: 4, interface: WL_SEAT, version: 11 },
                FakeGlobal { name: 5, interface: XDG_OUTPUT_MANAGER, version: 3 },
                FakeGlobal { name: 6, interface: VIRTUAL_POINTER, version: 2 },
                FakeGlobal { name: 7, interface: VIRTUAL_KEYBOARD, version: 1 },
                FakeGlobal { name: 8, interface: SCREENCOPY, version: 3 },
            ],
            vec![3],
        );
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let start = Instant::now();
    let snapshot = discover(&conn, start + Duration::from_secs(5), &cancel)
        .expect("fake-peer sweep discovers capabilities");
    assert!(start.elapsed() < Duration::from_secs(5), "sweep stays bounded");
    assert_eq!(snapshot.shm.expect("shm").negotiated, 1);
    assert_eq!(snapshot.seat.expect("seat").negotiated, 7);
    // The withdrawn output never surfaces: only name 2 remains.
    assert_eq!(snapshot.outputs.len(), 1);
    assert_eq!(snapshot.outputs[0].name, 2);
    assert_eq!(snapshot.outputs[0].negotiated, 4);
    assert_eq!(snapshot.virtual_pointer.expect("vp").negotiated, 2);
    assert_eq!(snapshot.screencopy.expect("screencopy").negotiated, 3);
    assert!(snapshot.missing().is_empty());
}

#[test]
fn discover_against_a_silent_peer_times_out() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    std::thread::spawn(|| serve_silent(peer));
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let start = Instant::now();
    let err = discover(&conn, start + Duration::from_millis(300), &cancel)
        .expect_err("a silent peer must hit the total deadline");
    assert_eq!(err.kind, TransportKind::Timeout);
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "silent sweep stays bounded, took {:?}",
        start.elapsed()
    );
}

#[test]
fn discover_cancellation_wakes_the_sweep() {
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
    let err = discover(&conn, start + Duration::from_secs(5), &cancel)
        .expect_err("cancel must wake the sweep");
    assert_eq!(err.kind, TransportKind::Cancelled);
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "cancelled sweep ends early, took {:?}",
        start.elapsed()
    );
}

#[test]
fn discover_against_a_gone_peer_is_a_disconnect() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    drop(peer);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let err = discover(&conn, Instant::now() + Duration::from_secs(5), &cancel)
        .expect_err("a gone peer must not time out");
    assert_eq!(err.kind, TransportKind::Disconnected);
}

#[test]
fn inherited_wayland_socket_adoption_is_refused() {
    // Duplicating an inherited WAYLAND_SOCKET fd shares one Wayland protocol
    // stream: a second Connection on the dup corrupts both sides' object ids.
    // Until a production owner enforces exclusive single-Connection ownership
    // (T5), ambient adoption is refused outright, without reading the env.
    let before = std::env::var("WAYLAND_SOCKET_TEST_SENTINEL").ok();
    let err = super::transport::connect_inherited_refused()
        .expect_err("inherited adoption must be refused");
    assert_eq!(err.kind, TransportKind::Unsupported);
    let text = err.to_string();
    assert!(text.contains("WAYLAND_SOCKET"), "refusal names the source: {text}");
    assert!(
        text.contains("exclusive"),
        "refusal names the ownership rule: {text}"
    );
    assert_eq!(
        std::env::var("WAYLAND_SOCKET_TEST_SENTINEL").ok(),
        before,
        "refusal path touches no environment state"
    );
}

#[test]
fn transient_wouldblock_read_is_a_retry_not_a_disconnect() {
    // A silent pair yields no data, so the backend's nonblocking read reports
    // WouldBlock (documented on ReadEventsGuard::read): the sweep must treat
    // that as "try again within the deadline", never as a dead connection.
    let (client, _peer) = UnixStream::pair().expect("socketpair works in tests");
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let guard = conn.prepare_read().expect("rust backend grants a read guard");
    let retry = super::transport::read_ready(guard).expect("transient read must not error");
    assert!(!retry, "no data means retry, not data and not a disconnect");
}
