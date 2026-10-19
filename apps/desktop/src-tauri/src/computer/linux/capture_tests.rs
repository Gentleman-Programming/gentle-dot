//! RED/GREEN checks for [`super::capture::capture_monitor`]: the public
//! capture boundary over a fake peer, plus the pure decoder rejects. No real
//! compositor is touched: the fake below speaks just enough wire protocol
//! (`get_registry`, `bind`, `capture_output`, `create_pool` with its SHM fd,
//! `create_buffer`, `copy`) and, on the success path, receives the pool fd,
//! writes known pixels into it, and answers `buffer`/`buffer_done` plus
//! `flags`/`ready`. Every wait carries the total deadline and the cooperative
//! cancel handle; there is no `roundtrip` anywhere in these tests.
//!
//! What each test pins through the public boundary: success with known
//! pixel colors, y-invert and stride padding; protocol destroys for every
//! owned object on success, refusal, timeout, cancel and post-copy failure
//! (parsed from the wire, never inferred from EOF); unsupported-format and
//! repeated-offer refusal; oversized-buffer refusal without allocation;
//! peer `failed`; disconnect; silent-peer timeout; cancellation during read,
//! decode and encode via the injected hook seam (not just a pre-set flag);
//! frame dimensions that disagree with the validated geometry; a fractional
//! ±1 slop buffer accepted against the actual hardware dims; unknown output
//! ids and missing protocols failing closed. Pure decoder/budget rejects are
//! covered too, but they do not stand in for the capture path.

use super::capabilities::{AdvertisedGlobal, CapabilitySnapshot, SCREENCOPY, WL_OUTPUT, WL_SHM};
use super::capture::{
    capture_monitor, capture_monitor_normalized, capture_monitor_normalized_with_hooks,
    capture_monitor_with_hooks, capture_monitor_with_limits, CaptureError,
    CaptureStage, EncodeLimits, JPEG_HEADER_SLACK_BYTES, MAX_AGGREGATE_BYTES, MAX_FRAME_PIXELS,
    MAX_JPEG_BYTES, MAX_SHM_BYTES,
};
use super::geometry::OutputGeometry;
use super::outputs::Monitor;
use super::pixels::{aggregate_len, capture_peak_bytes, decode_shm_to_bgra, FrameParams};
use super::transport::{connection_from_stream, CancelHandle, TransportKind};
use std::io::{Read, Write};
use std::os::unix::io::FromRawFd;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};
use wayland_client::protocol::wl_shm;

fn advertised(name: u32, interface: &str, version: u32) -> AdvertisedGlobal {
    AdvertisedGlobal { name, interface: interface.to_owned(), version }
}

fn snapshot() -> CapabilitySnapshot {
    CapabilitySnapshot::negotiate(&[
        advertised(1, WL_SHM, 1),
        advertised(7, WL_OUTPUT, 4),
        advertised(8, SCREENCOPY, 3),
    ])
}

fn monitor(registry_name: u32, width: i32, height: i32) -> Monitor {
    Monitor {
        registry_name,
        name: Some("Fake-1".to_owned()),
        geometry: OutputGeometry::new(0, 0, width, height, 1.0, 0, width, height)
            .expect("test geometry is valid"),
        refresh_millihz: 60_000,
    }
}

// --- Wire helpers (same layout as the transport/output fixtures). ---

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

fn ev_frame_buffer(frame: u32, format: u32, width: u32, height: u32, stride: u32) -> Vec<u8> {
    let mut p = Vec::new();
    wire_u32(&mut p, format);
    wire_u32(&mut p, width);
    wire_u32(&mut p, height);
    wire_u32(&mut p, stride);
    wire_message(frame, 0, &p)
}

fn ev_frame_flags(frame: u32, flags: u32) -> Vec<u8> {
    let mut p = Vec::new();
    wire_u32(&mut p, flags);
    wire_message(frame, 1, &p)
}

fn ev_frame_ready(frame: u32) -> Vec<u8> {
    let mut p = Vec::new();
    wire_u32(&mut p, 0);
    wire_u32(&mut p, 0);
    wire_u32(&mut p, 0);
    wire_message(frame, 2, &p)
}

fn ev_frame_failed(frame: u32) -> Vec<u8> {
    wire_message(frame, 3, &[])
}

fn ev_frame_done(frame: u32) -> Vec<u8> {
    wire_message(frame, 6, &[])
}

/// How the fake peer answers one capture.
struct FrameOffer {
    format: u32,
    width: u32,
    height: u32,
    stride: u32,
    y_invert: bool,
    /// Send `buffer_done` (v3 rule); without it a v3 client keeps waiting.
    send_done: bool,
    /// Send `failed` right after the description instead of completing.
    fail_early: bool,
    /// Send `failed` after the copy instead of `flags`/`ready`.
    fail_after_copy: bool,
    /// A second, mutated `buffer` event after the first (protocol violation
    /// the client must refuse, not last-wins).
    mutated_buffer: Option<(u32, u32, u32)>,
    /// Pixels the peer writes into the handed-off SHM fd
    /// (`stride * height` bytes, XRGB little-endian plus padding).
    pixels: Vec<u8>,
}

#[derive(Default)]
struct PeerObs {
    saw_pool: bool,
    saw_copy: bool,
    fds_taken: usize,
    frame_destroyed: bool,
    pool_destroyed: bool,
    buffer_destroyed: bool,
}

/// Client message parser shared by both fake peers. Records binds, the
/// capture exchange, and — the point of B2 — every protocol destroy by
/// opcode (`frame.destroy` = 1, `pool.destroy` = 1, `buffer.destroy` = 0).
#[derive(Default)]
struct PeerParse {
    registry: Option<u32>,
    manager: Option<u32>,
    shm: Option<u32>,
    frame: Option<u32>,
    pool: Option<u32>,
    buffer: Option<u32>,
    saw_pool: bool,
    saw_copy: bool,
    frame_destroyed: bool,
    pool_destroyed: bool,
    buffer_destroyed: bool,
}

impl PeerParse {
    fn consume(&mut self, buffered: &mut Vec<u8>) {
        while buffered.len() >= 8 {
            let sender = u32::from_ne_bytes(buffered[0..4].try_into().expect("header"));
            let word = u32::from_ne_bytes(buffered[4..8].try_into().expect("header"));
            let size = (word >> 16) as usize;
            let opcode = (word & 0xFFFF) as u16;
            assert!((8..=65536).contains(&size), "fake peer saw a bogus size");
            if buffered.len() < size {
                break;
            }
            let mut off = 8;
            if sender == 1 && opcode == 1 {
                self.registry = Some(read_u32(buffered, &mut off));
            } else if Some(sender) == self.registry && opcode == 0 {
                let _name = read_u32(buffered, &mut off);
                let interface = read_string(buffered, &mut off);
                let _version = read_u32(buffered, &mut off);
                let id = read_u32(buffered, &mut off);
                match interface.as_str() {
                    "zwlr_screencopy_manager_v1" => self.manager = Some(id),
                    "wl_shm" => self.shm = Some(id),
                    _ => {}
                }
            } else if Some(sender) == self.manager && opcode == 0 {
                self.frame = Some(read_u32(buffered, &mut off));
                let _overlay = read_u32(buffered, &mut off);
                let _output = read_u32(buffered, &mut off);
            } else if Some(sender) == self.shm && opcode == 0 {
                self.pool = Some(read_u32(buffered, &mut off));
                let _size = read_u32(buffered, &mut off);
                self.saw_pool = true;
            } else if Some(sender) == self.pool && opcode == 0 {
                self.buffer = Some(read_u32(buffered, &mut off));
                let _offset = read_u32(buffered, &mut off);
                let _w = read_u32(buffered, &mut off);
                let _h = read_u32(buffered, &mut off);
                let _stride = read_u32(buffered, &mut off);
                let _format = read_u32(buffered, &mut off);
            } else if Some(sender) == self.pool && opcode == 1 {
                self.pool_destroyed = true;
            } else if Some(sender) == self.frame && opcode == 0 {
                let _buffer = read_u32(buffered, &mut off);
                self.saw_copy = true;
            } else if Some(sender) == self.frame && opcode == 1 {
                self.frame_destroyed = true;
            } else if Some(sender) == self.buffer && opcode == 0 {
                self.buffer_destroyed = true;
            }
            buffered.drain(..size);
        }
    }

    fn obs(&self, fds_taken: usize) -> PeerObs {
        PeerObs {
            saw_pool: self.saw_pool,
            saw_copy: self.saw_copy,
            fds_taken,
            frame_destroyed: self.frame_destroyed,
            pool_destroyed: self.pool_destroyed,
            buffer_destroyed: self.buffer_destroyed,
        }
    }
}

/// Receive one datagram plus any passed fds (the `create_pool` SHM fd
/// arrives as `SCM_RIGHTS` ancillary data, not in the payload).
fn recv_with_fds(
    peer: &UnixStream,
    data: &mut Vec<u8>,
) -> (usize, Vec<std::os::unix::io::OwnedFd>) {
    use std::os::unix::io::{AsRawFd, FromRawFd};
    let mut chunk = [0u8; 8192];
    let mut control = [0u8; 1024];
    let mut iov = libc::iovec {
        iov_base: chunk.as_mut_ptr() as *mut libc::c_void,
        iov_len: chunk.len(),
    };
    let mut header: libc::msghdr = unsafe { std::mem::zeroed() };
    header.msg_iov = &mut iov;
    header.msg_iovlen = 1;
    header.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    header.msg_controllen = control.len();
    let got = unsafe { libc::recvmsg(peer.as_raw_fd(), &mut header, 0) };
    if got < 0 {
        let errno = std::io::Error::last_os_error();
        assert!(
            matches!(
                errno.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ),
            "fake peer recvmsg failed: {errno}"
        );
        return (0, Vec::new());
    }
    if got == 0 {
        return (0, Vec::new());
    }
    data.extend_from_slice(&chunk[..got as usize]);
    let mut fds = Vec::new();
    let mut cmsg = unsafe { libc::CMSG_FIRSTHDR(&header) };
    while !cmsg.is_null() {
        let (level, kind) = unsafe { ((*cmsg).cmsg_level, (*cmsg).cmsg_type) };
        if level == libc::SOL_SOCKET && kind == libc::SCM_RIGHTS {
            let prefix = unsafe { libc::CMSG_LEN(0) as usize };
            let total = unsafe { (*cmsg).cmsg_len as usize };
            let count = total.saturating_sub(prefix) / std::mem::size_of::<libc::c_int>();
            let base = unsafe { libc::CMSG_DATA(cmsg) as *const libc::c_int };
            for index in 0..count {
                let fd = unsafe { *base.add(index) };
                assert!(fd >= 0, "fake peer got a bogus fd");
                fds.push(unsafe { std::os::unix::io::OwnedFd::from_raw_fd(fd) });
            }
        }
        cmsg = unsafe { libc::CMSG_NXTHDR(&header, cmsg) };
    }
    (got as usize, fds)
}

fn send_all(peer: &UnixStream, reply: &[u8]) {
    use std::os::unix::io::AsRawFd;
    let mut at = 0;
    while at < reply.len() {
        let wrote = unsafe {
            libc::send(
                peer.as_raw_fd(),
                reply[at..].as_ptr() as *const libc::c_void,
                reply.len() - at,
                libc::MSG_NOSIGNAL,
            )
        };
        assert!(wrote > 0, "fake peer reply failed");
        at += wrote as usize;
    }
}

/// EOF probe: `recv` returning 0 may be a read timeout, so peek to tell a
/// real hangup apart without consuming data.
fn is_eof(peer: &UnixStream) -> bool {
    use std::os::unix::io::AsRawFd;
    let mut probe = [0u8; 1];
    unsafe {
        libc::recv(
            peer.as_raw_fd(),
            probe.as_mut_ptr() as *mut libc::c_void,
            1,
            libc::MSG_PEEK,
        ) == 0
    }
}

/// Serve one capture: parse every bind/request, hand the pool fd to the
/// pixel writer, and replay the canned frame. Returns once the client has
/// protocol-destroyed its objects (never on EOF alone): every destroy the
/// tests assert on was parsed from the wire. Panics (test failure) instead
/// of hanging: every read has a timeout and the whole exchange a bound.
fn serve_capture(peer: UnixStream, offer: FrameOffer) -> PeerObs {
    peer.set_read_timeout(Some(Duration::from_secs(2))).expect("read timeout");
    let mut parse = PeerParse::default();
    let mut buffered = Vec::new();
    let mut pool_fd: Option<std::os::unix::io::OwnedFd> = None;
    let mut fds_taken = 0;
    let mut described = false;
    let mut final_sent = false;
    let start = Instant::now();
    loop {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "fake peer timed out waiting for the capture exchange"
        );
        let (got, mut fds) = recv_with_fds(&peer, &mut buffered);
        fds_taken += fds.len();
        // The pool fd is the only fd the client ever passes.
        if !fds.is_empty() {
            assert!(pool_fd.is_none(), "fake peer takes exactly one SHM fd");
            pool_fd = Some(fds.remove(0));
            assert!(fds.is_empty(), "client passed an unexpected second fd");
        }
        parse.consume(&mut buffered);
        let mut reply = Vec::new();
        if let Some(frame) = parse.frame {
            if !described {
                described = true;
                reply.extend(ev_frame_buffer(frame, offer.format, offer.width, offer.height, offer.stride));
                if let Some((width, height, stride)) = offer.mutated_buffer {
                    // A second, different description: the protocol never
                    // sends two, and the client must refuse, not last-wins.
                    reply.extend(ev_frame_buffer(frame, offer.format, width, height, stride));
                }
                if offer.fail_early {
                    reply.extend(ev_frame_failed(frame));
                    final_sent = true;
                } else if offer.send_done {
                    reply.extend(ev_frame_done(frame));
                }
            } else if parse.saw_copy && !final_sent {
                final_sent = true;
                if offer.fail_after_copy {
                    reply.extend(ev_frame_failed(frame));
                } else {
                    if let Some(fd) = pool_fd.take() {
                        use std::os::unix::io::AsRawFd;
                        let dup = unsafe { libc::dup(fd.as_raw_fd()) };
                        assert!(dup >= 0, "fake peer dups the SHM fd");
                        let mut file =
                            unsafe { std::fs::File::from_raw_fd(dup) };
                        file.write_all(&offer.pixels).expect("fake peer writes pixels");
                    }
                    reply.extend(ev_frame_flags(frame, u32::from(offer.y_invert)));
                    reply.extend(ev_frame_ready(frame));
                }
            }
        }
        if !reply.is_empty() {
            send_all(&peer, &reply);
        }
        // Destroys prove cleanup: pre-copy paths end at the frame destroy,
        // post-copy paths when every owned object is destroyed.
        if parse.frame_destroyed && (parse.done_full() || !parse.saw_copy) {
            break;
        }
        if got == 0 && is_eof(&peer) {
            break;
        }
    }
    parse.obs(fds_taken)
}

impl PeerParse {
    fn done_full(&self) -> bool {
        self.frame_destroyed && self.pool_destroyed && self.buffer_destroyed
    }
}

/// Hold a quiet peer that records destroys: the silent compositor for
/// timeout/cancel tests. Returns once the frame destroy arrives or the
/// client goes away; destroys are parsed from the wire, never inferred.
fn serve_quiet(peer: UnixStream) -> PeerObs {
    peer.set_read_timeout(Some(Duration::from_secs(2))).expect("read timeout");
    let mut parse = PeerParse::default();
    let mut buffered = Vec::new();
    let start = Instant::now();
    loop {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "fake peer timed out waiting for a destroy"
        );
        let (got, fds) = recv_with_fds(&peer, &mut buffered);
        assert!(fds.is_empty(), "quiet peer takes no fds");
        parse.consume(&mut buffered);
        if parse.frame_destroyed {
            break;
        }
        if got == 0 && is_eof(&peer) {
            break;
        }
    }
    parse.obs(0)
}

fn xrgb(r: u8, g: u8, b: u8) -> [u8; 4] {
    [b, g, r, 0]
}

/// 16x16 frame, stride 72 (8 pad bytes per row), y-invert set: solid 8x8
/// quadrants so JPEG edge artifacts stay away from the sampled centers.
/// File top half is red/green, file bottom half blue/white, so the decoded
/// top half (y-invert flips rows) must be blue/white over red/green.
fn padded_y_inverted_pixels() -> Vec<u8> {
    let mut out = Vec::new();
    for row in 0..16 {
        for col in 0..16 {
            let top = row < 8;
            let left = col < 8;
            let (r, g, b) = match (top, left) {
                (true, true) => (255, 0, 0),
                (true, false) => (0, 255, 0),
                (false, true) => (0, 0, 255),
                (false, false) => (255, 255, 255),
            };
            out.extend(xrgb(r, g, b));
        }
        out.extend([0u8; 8]);
    }
    out
}

fn xrgb_format() -> u32 {
    wl_shm::Format::Xrgb8888 as u32
}

fn success_offer() -> FrameOffer {
    FrameOffer {
        format: xrgb_format(),
        width: 16,
        height: 16,
        stride: 72,
        y_invert: true,
        send_done: true,
        fail_early: false,
        fail_after_copy: false,
        mutated_buffer: None,
        pixels: padded_y_inverted_pixels(),
    }
}

#[test]
fn success_returns_known_colors_through_the_public_boundary() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| serve_capture(peer, success_offer()));
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let frame = capture_monitor(
        conn,
        &snapshot(),
        &monitor(7, 16, 16),
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect("fake-peer capture succeeds");
    assert_eq!((frame.buffer_width, frame.buffer_height), (16, 16));
    assert_eq!((frame.width, frame.height), (16, 16));
    assert_eq!(frame.monitor_name.as_deref(), Some("Fake-1"));
    assert_eq!(frame.geometry.buffer_width(), 16);
    // Known colors survive the public path (lossy JPEG: generous tolerance).
    let decoded = image::load_from_memory_with_format(&frame.jpeg, image::ImageFormat::Jpeg)
        .expect("capture returns JPEG bytes")
        .to_rgb8();
    assert_eq!(decoded.dimensions(), (16, 16));
    let near = |got: &[u8; 3], want: &[u8; 3]| {
        got.iter().zip(want).all(|(g, w)| g.abs_diff(*w) < 40)
    };
    // y-invert flips rows: decoded top half is the file's bottom half.
    // Quadrant centers stay clear of JPEG block edges.
    assert!(near(&decoded.get_pixel(4, 4).0, &[0, 0, 255]), "top-left is blue");
    assert!(near(&decoded.get_pixel(11, 4).0, &[255, 255, 255]), "top-right is white");
    assert!(near(&decoded.get_pixel(4, 11).0, &[255, 0, 0]), "bottom-left is red");
    assert!(near(&decoded.get_pixel(11, 11).0, &[0, 255, 0]), "bottom-right is green");
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(obs.saw_pool, "success allocates exactly one pool");
    assert!(obs.saw_copy, "success issues the copy");
    assert_eq!(obs.fds_taken, 1, "success hands off exactly one SHM fd");
    assert!(obs.frame_destroyed, "success destroys the frame on the wire");
    assert!(obs.pool_destroyed, "success destroys the pool on the wire");
    assert!(obs.buffer_destroyed, "success destroys the buffer on the wire");
}

#[test]
fn unsupported_format_is_refused_before_any_pool_exists() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: 0xDEAD_BEEF,
                width: 2,
                height: 2,
                stride: 8,
                y_invert: false,
                send_done: true,
                fail_early: false,
                fail_after_copy: false,
                mutated_buffer: None,
                pixels: vec![0u8; 16],
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let err = capture_monitor(
        conn,
        &snapshot(),
        &monitor(7, 2, 2),
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("an unknown format must be refused");
    assert!(
        matches!(err, CaptureError::UnsupportedBuffer { .. }),
        "wrong refusal: {err}"
    );
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(!obs.saw_pool, "refusal must not allocate a pool");
    assert!(!obs.saw_copy, "refusal must not issue a copy");
    assert!(obs.frame_destroyed, "refusal still destroys the frame on the wire");
    assert!(!obs.pool_destroyed, "no pool exists to destroy");
    assert!(!obs.buffer_destroyed, "no buffer exists to destroy");
}

#[test]
fn repeated_buffer_offer_fails_truthful() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: xrgb_format(),
                width: 16,
                height: 16,
                stride: 64,
                y_invert: false,
                send_done: true,
                fail_early: false,
                fail_after_copy: false,
                mutated_buffer: Some((8, 8, 32)),
                pixels: vec![0u8; 1024],
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let err = capture_monitor(
        conn,
        &snapshot(),
        &monitor(7, 16, 16),
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("a second buffer description must fail, not last-wins");
    assert!(
        matches!(err, CaptureError::UnsupportedBuffer { .. }),
        "wrong refusal: {err}"
    );
    assert!(err.to_string().contains("buffer"), "names the repeat: {err}");
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(!obs.saw_pool, "repeat refusal must not allocate a pool");
    assert!(obs.frame_destroyed, "repeat refusal still destroys the frame on the wire");
}

#[test]
fn oversized_buffer_is_refused_without_allocation() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: xrgb_format(),
                // Small enough to fit the fake peer's arithmetic, large
                // enough to blow past the memory cap and the 2x2 geometry.
                width: 40_000,
                height: 40_000,
                stride: 160_000,
                y_invert: false,
                send_done: true,
                fail_early: false,
                fail_after_copy: false,
                mutated_buffer: None,
                pixels: Vec::new(),
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let err = capture_monitor(
        conn,
        &snapshot(),
        &monitor(7, 2, 2),
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("a gigapixel burst must be refused");
    // Geometry disagrees first here (40kx40k vs 2x2): either refusal proves
    // no allocation happened; the pure oversize path is pinned below.
    assert!(
        matches!(
            err,
            CaptureError::DimensionMismatch { .. } | CaptureError::Oversized { .. }
        ),
        "wrong refusal: {err}"
    );
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(!obs.saw_pool, "refusal must not allocate a pool");
}

#[test]
fn oversize_past_matching_geometry_is_still_refused() {
    // Geometry agrees (40000x40000 at scale 1) so only the memory cap stops
    // the allocation: 6.4 GB over a 128 MiB cap.
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: xrgb_format(),
                width: 40_000,
                height: 40_000,
                stride: 160_000,
                y_invert: false,
                send_done: true,
                fail_early: false,
                fail_after_copy: false,
                mutated_buffer: None,
                pixels: Vec::new(),
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let huge = monitor(7, 40_000, 40_000);
    let err = capture_monitor(
        conn,
        &snapshot(),
        &huge,
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("a 6.4 GB burst must be refused");
    assert!(matches!(err, CaptureError::Oversized { .. }), "wrong refusal: {err}");
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(!obs.saw_pool, "oversize must not allocate a pool");
    const { assert!(MAX_SHM_BYTES < 160_000usize * 40_000) };
}

#[test]
fn peer_failed_is_a_named_failure() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: xrgb_format(),
                width: 2,
                height: 2,
                stride: 8,
                y_invert: false,
                send_done: true,
                fail_early: true,
                fail_after_copy: false,
                mutated_buffer: None,
                pixels: Vec::new(),
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let err = capture_monitor(
        conn,
        &snapshot(),
        &monitor(7, 2, 2),
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("peer failed must surface");
    assert!(matches!(err, CaptureError::Failed { registry_name: 7 }), "wrong error: {err}");
    assert!(err.to_string().contains('7'), "error names the output: {err}");
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(!obs.saw_pool, "failure must not allocate a pool");
}

#[test]
fn destroys_observed_on_post_copy_failure() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: xrgb_format(),
                width: 2,
                height: 2,
                stride: 8,
                y_invert: false,
                send_done: true,
                fail_early: false,
                fail_after_copy: true,
                mutated_buffer: None,
                pixels: Vec::new(),
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let err = capture_monitor(
        conn,
        &snapshot(),
        &monitor(7, 2, 2),
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("a post-copy failed must surface");
    assert!(matches!(err, CaptureError::Failed { registry_name: 7 }), "wrong error: {err}");
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(obs.saw_pool && obs.saw_copy, "copy happened before the failure");
    assert!(obs.frame_destroyed, "failure destroys the frame on the wire");
    assert!(obs.pool_destroyed, "failure destroys the pool on the wire");
    assert!(obs.buffer_destroyed, "failure destroys the buffer on the wire");
}

#[test]
fn mismatched_dimensions_never_silently_remap() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: xrgb_format(),
                width: 4,
                height: 4,
                stride: 16,
                y_invert: false,
                send_done: true,
                fail_early: false,
                fail_after_copy: false,
                mutated_buffer: None,
                pixels: vec![0u8; 64],
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let err = capture_monitor(
        conn,
        &snapshot(),
        &monitor(7, 2, 2),
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("a 4x4 frame for a 2x2 output must fail");
    assert!(
        matches!(err, CaptureError::DimensionMismatch { .. }),
        "wrong error: {err}"
    );
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(!obs.saw_pool, "mismatch must not allocate a pool");
}

#[test]
fn fractional_slop_buffer_is_accepted() {
    // 3x3 logical at scale 1.5 rounds to a 5x5 nominal buffer, but the
    // fractional tolerance accepts the actual 4x4 hardware buffer: the
    // capture must compare against that actual buffer, not the nominal size.
    let geometry = OutputGeometry::new(0, 0, 3, 3, 1.5, 0, 4, 4).expect("slop accepted");
    assert_eq!(geometry.buffer_width(), 4);
    assert_eq!(geometry.buffer_height(), 4);
    assert_eq!(geometry.expected_buffer_dimensions(), (5, 5));
    let slop_monitor = Monitor {
        registry_name: 7,
        name: Some("Fake-1".to_owned()),
        geometry,
        refresh_millihz: 60_000,
    };
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: xrgb_format(),
                width: 4,
                height: 4,
                stride: 16,
                y_invert: false,
                send_done: true,
                fail_early: false,
                fail_after_copy: false,
                mutated_buffer: None,
                pixels: vec![0x10u8; 64],
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let frame = capture_monitor(
        conn,
        &snapshot(),
        &slop_monitor,
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect("the accepted slop buffer must capture");
    assert_eq!((frame.buffer_width, frame.buffer_height), (4, 4));
    assert_eq!(frame.geometry, geometry);
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(obs.frame_destroyed && obs.pool_destroyed && obs.buffer_destroyed);
}

#[test]
fn cancel_during_read_returns_cancelled() {
    // 256x256 reads in four 64 KiB chunks; the hook fires the cancel on the
    // first chunk, so the second chunk's bound check must observe it.
    let pixels = vec![0x20u8; 256 * 1024];
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: xrgb_format(),
                width: 256,
                height: 256,
                stride: 1024,
                y_invert: false,
                send_done: true,
                fail_early: false,
                fail_after_copy: false,
                mutated_buffer: None,
                pixels,
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let waker = cancel.clone();
    let hook = move |stage: CaptureStage, _progress: u64| {
        if stage == CaptureStage::ReadFile {
            waker.cancel();
        }
    };
    let err = capture_monitor_with_hooks(
        conn,
        &snapshot(),
        &monitor(7, 256, 256),
        Instant::now() + Duration::from_secs(5),
        &cancel,
        Some(&hook),
    )
    .expect_err("mid-read cancel must surface");
    assert!(
        matches!(&err, CaptureError::Transport(t) if t.kind == TransportKind::Cancelled),
        "wrong error: {err}"
    );
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(obs.saw_copy, "the copy completed; the cancel lands mid-read");
    assert!(obs.frame_destroyed, "mid-read cancel still destroys the frame");
}

#[test]
fn cancel_during_decode_returns_cancelled() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| serve_capture(peer, success_offer()));
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let waker = cancel.clone();
    let hook = move |stage: CaptureStage, _progress: u64| {
        if stage == CaptureStage::DecodeRows {
            waker.cancel();
        }
    };
    let err = capture_monitor_with_hooks(
        conn,
        &snapshot(),
        &monitor(7, 16, 16),
        Instant::now() + Duration::from_secs(5),
        &cancel,
        Some(&hook),
    )
    .expect_err("mid-decode cancel must surface");
    assert!(
        matches!(&err, CaptureError::Transport(t) if t.kind == TransportKind::Cancelled),
        "wrong error: {err}"
    );
    let _ = peer_thread.join().expect("peer thread ends");
}

#[test]
fn cancel_during_encode_returns_cancelled() {
    // The hook ignores the pre-encode call (progress 0) and fires only once
    // the encoder has started writing: the abort must come from the
    // cancellable writer mid-encode, not from the pre-stage check.
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| serve_capture(peer, success_offer()));
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let waker = cancel.clone();
    let hook = move |stage: CaptureStage, progress: u64| {
        if stage == CaptureStage::EncodeJpeg && progress > 0 {
            waker.cancel();
        }
    };
    let err = capture_monitor_with_hooks(
        conn,
        &snapshot(),
        &monitor(7, 16, 16),
        Instant::now() + Duration::from_secs(5),
        &cancel,
        Some(&hook),
    )
    .expect_err("mid-encode cancel must surface");
    assert!(
        matches!(&err, CaptureError::Transport(t) if t.kind == TransportKind::Cancelled),
        "wrong error: {err}"
    );
    let _ = peer_thread.join().expect("peer thread ends");
}

#[test]
fn silent_peer_hits_the_deadline() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| serve_quiet(peer));
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let start = Instant::now();
    let err = capture_monitor(
        conn,
        &snapshot(),
        &monitor(7, 2, 2),
        start + Duration::from_millis(300),
        &cancel,
    )
    .expect_err("a silent peer must hit the deadline");
    assert!(
        matches!(&err, CaptureError::Transport(t) if t.kind == TransportKind::Timeout),
        "wrong error: {err}"
    );
    assert!(start.elapsed() < Duration::from_secs(3), "deadline stays bounded");
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(obs.frame_destroyed, "even a timed-out wait destroys the frame");
    assert!(!obs.saw_pool, "timeout happens before any pool exists");
}

#[test]
fn cancellation_wakes_the_capture() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| serve_quiet(peer));
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let waker = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        waker.cancel();
    });
    let start = Instant::now();
    let err = capture_monitor(
        conn,
        &snapshot(),
        &monitor(7, 2, 2),
        start + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("cancel must wake the capture");
    assert!(
        matches!(&err, CaptureError::Transport(t) if t.kind == TransportKind::Cancelled),
        "wrong error: {err}"
    );
    assert!(start.elapsed() < Duration::from_secs(2), "cancel wakes early");
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(obs.frame_destroyed, "even a cancelled wait destroys the frame");
}

#[test]
fn gone_peer_is_a_disconnect() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    drop(peer);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let err = capture_monitor(
        conn,
        &snapshot(),
        &monitor(7, 2, 2),
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("a gone peer must not time out");
    assert!(
        matches!(&err, CaptureError::Transport(t) if t.kind == TransportKind::Disconnected),
        "wrong error: {err}"
    );
}

#[test]
fn unknown_output_and_missing_protocols_fail_closed() {
    // Each operation consumes its own connection, so each reject gets a
    // fresh one here.
    let cancel = CancelHandle::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    let (client, _peer) = UnixStream::pair().expect("socketpair works in tests");
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let err = capture_monitor(conn, &snapshot(), &monitor(99, 2, 2), deadline, &cancel)
        .expect_err("an unadvertised id must fail");
    assert!(
        matches!(err, CaptureError::UnknownOutput { registry_name: 99 }),
        "wrong error: {err}"
    );
    let bare = CapabilitySnapshot::negotiate(&[advertised(1, WL_SHM, 1), advertised(7, WL_OUTPUT, 4)]);
    let (client, _peer) = UnixStream::pair().expect("socketpair works in tests");
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let err = capture_monitor(conn, &bare, &monitor(7, 2, 2), deadline, &cancel)
        .expect_err("a missing manager must fail");
    assert!(
        matches!(err, CaptureError::MissingProtocol(_)),
        "wrong error: {err}"
    );
    assert!(err.to_string().contains("zwlr_screencopy_manager_v1"), "names it: {err}");
}

#[test]
fn decoder_rejects_unknown_format_and_short_files() {
    let cancel = CancelHandle::new();
    let params = FrameParams {
        format: wl_shm::Format::Xrgb8888,
        width: 1,
        height: 1,
        stride: 4,
    };
    assert!(
        decode_shm_to_bgra(&[0u8; 3], params, false, &cancel, None).is_err(),
        "short file fails"
    );
    // Unknown wire codes never become a `Format`; the refusal below pins the
    // message shape the capture maps to `UnsupportedBuffer`.
    let params = FrameParams {
        format: wl_shm::Format::C8,
        width: 1,
        height: 1,
        stride: 4,
    };
    let err = decode_shm_to_bgra(&[0u8; 4], params, false, &cancel, None)
        .expect_err("C8 is undecodable");
    assert!(err.to_string().contains("C8"), "names the format: {err}");
}

#[test]
fn aggregate_cap_covers_decoded_and_encoder_buffers() {
    let small = FrameParams {
        format: wl_shm::Format::Xrgb8888,
        width: 16,
        height: 16,
        stride: 72,
    };
    let shm = 72usize * 16;
    // SHM file + BGRA rows + encoder-internal RGB copy, all accounted.
    assert_eq!(
        aggregate_len(shm, small).expect("small fits"),
        shm as u64 + 16 * 16 * 4 + 16 * 16 * 3
    );
    let huge = FrameParams {
        format: wl_shm::Format::Xrgb8888,
        width: 7000,
        height: 7000,
        stride: 28_000,
    };
    let total = aggregate_len(28_000usize * 7000, huge).expect("arithmetic holds");
    assert!(total > MAX_AGGREGATE_BYTES, "49M pixels exceed the aggregate cap");
    assert!(
        (7000u64 * 7000) > MAX_FRAME_PIXELS,
        "49M pixels exceed the pixel cap"
    );
    const { assert!(MAX_SHM_BYTES < 160_000usize * 40_000) };
}

#[test]
fn deadline_during_encode_returns_timeout() {
    // The deadline must survive the wire exchange (localhost, milliseconds)
    // but expire while the encoder runs: the hook sleeps once past it, so
    // the next writer check observes the expiry deterministically instead
    // of racing the clock.
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| serve_capture(peer, success_offer()));
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let slept = std::sync::atomic::AtomicBool::new(false);
    let hook = move |stage: CaptureStage, _progress: u64| {
        if stage == CaptureStage::EncodeJpeg
            && !slept.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            std::thread::sleep(Duration::from_millis(500));
        }
    };
    let start = Instant::now();
    let err = capture_monitor_with_hooks(
        conn,
        &snapshot(),
        &monitor(7, 16, 16),
        start + Duration::from_millis(200),
        &cancel,
        Some(&hook),
    )
    .expect_err("an encode that outlives the deadline must time out, not return pixels");
    assert!(
        matches!(&err, CaptureError::Transport(t) if t.kind == TransportKind::Timeout),
        "wrong error: {err}"
    );
    assert!(start.elapsed() < Duration::from_secs(5), "encode timeout stays bounded");
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(obs.saw_copy, "the copy completed; the deadline lands mid-encode");
    assert!(obs.frame_destroyed, "mid-encode timeout still destroys the frame");
    assert!(obs.pool_destroyed, "mid-encode timeout still destroys the pool");
    assert!(obs.buffer_destroyed, "mid-encode timeout still destroys the buffer");
}

#[test]
fn cancel_on_final_write_returns_cancelled() {
    // Learn the exact encoded length first: cancelling only once the writer
    // has produced that many bytes lands on/after the final write, so the
    // abort must come from the post-encode check discarding the finished
    // JPEG, not from a mid-stream failure.
    let full = {
        let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
        let peer_thread = std::thread::spawn(|| serve_capture(peer, success_offer()));
        let conn = connection_from_stream(client).expect("client wraps the pair");
        let cancel = CancelHandle::new();
        let frame = capture_monitor(
            conn,
            &snapshot(),
            &monitor(7, 16, 16),
            Instant::now() + Duration::from_secs(5),
            &cancel,
        )
        .expect("baseline capture succeeds");
        let len = frame.jpeg.len() as u64;
        peer_thread.join().expect("peer thread ends");
        assert!(len > 0, "baseline encodes a non-empty JPEG");
        len
    };
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| serve_capture(peer, success_offer()));
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let waker = cancel.clone();
    let hook = move |stage: CaptureStage, progress: u64| {
        if stage == CaptureStage::EncodeJpeg && progress >= full {
            waker.cancel();
        }
    };
    let err = capture_monitor_with_hooks(
        conn,
        &snapshot(),
        &monitor(7, 16, 16),
        Instant::now() + Duration::from_secs(5),
        &cancel,
        Some(&hook),
    )
    .expect_err("a cancel on the final write must discard the finished frame");
    assert!(
        matches!(&err, CaptureError::Transport(t) if t.kind == TransportKind::Cancelled),
        "wrong error: {err}"
    );
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(obs.saw_copy, "the copy completed; the cancel lands on the final write");
    assert!(obs.frame_destroyed, "final-write cancel still destroys the frame");
    assert!(obs.pool_destroyed, "final-write cancel still destroys the pool");
    assert!(obs.buffer_destroyed, "final-write cancel still destroys the buffer");
}

#[test]
fn encoded_cap_refusal_is_oversized() {
    // A 16-byte encoded cap refuses a real 16x16 frame through the injected
    // limits, without allocating anything near the production cap.
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| serve_capture(peer, success_offer()));
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let limits = EncodeLimits { jpeg_cap: Some(16) };
    let err = capture_monitor_with_limits(
        conn,
        &snapshot(),
        &monitor(7, 16, 16),
        Instant::now() + Duration::from_secs(5),
        &cancel,
        None,
        &limits,
    )
    .expect_err("a 16-byte encoded cap must refuse a real frame");
    assert!(
        matches!(&err, CaptureError::Oversized { limit: 16, .. }),
        "wrong error: {err}"
    );
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(obs.saw_copy, "the copy completed; the cap lands mid-encode");
    assert!(obs.frame_destroyed, "cap refusal still destroys the frame");
    assert!(obs.pool_destroyed, "cap refusal still destroys the pool");
    assert!(obs.buffer_destroyed, "cap refusal still destroys the buffer");
}

#[test]
fn peak_accounting_covers_memfd_readback_and_capped_jpeg() {
    // An 8K XRGB frame (stride = width * 4, so SHM == BGRA bytes): the
    // decode phase (memfd + read-back + BGRA) is the peak and must fit the
    // aggregate cap with headroom; the per-frame JPEG budget covers headers
    // plus the raw frame. Constants pin the derivation, not just the outcome.
    assert_eq!(MAX_JPEG_BYTES, JPEG_HEADER_SLACK_BYTES + 4 * MAX_FRAME_PIXELS);
    let params = FrameParams {
        format: wl_shm::Format::Xrgb8888,
        width: 7680,
        height: 4320,
        stride: 7680 * 4,
    };
    let shm = 7680usize * 4 * 4320;
    let px = 7680u64 * 4320;
    let jpeg_cap = JPEG_HEADER_SLACK_BYTES + 4 * px;
    let peak = capture_peak_bytes(shm, params, jpeg_cap).expect("8K arithmetic holds");
    assert_eq!(peak, 2 * shm as u64 + 4 * px, "decode phase is the 8K peak");
    assert!(peak <= MAX_AGGREGATE_BYTES, "8K still fits the aggregate cap");
    assert!(capture_peak_bytes(shm, params, u64::MAX).is_err(), "uncapped budget overflows instead of wrapping");
}

/// XRGB quadrant pixels for a `width`x`height` buffer (both even):
/// TL red, TR green, BL blue, BR white, no stride padding.
fn quad_pixels(width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut out = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let (r, g, b) = match (x < w / 2, y < h / 2) {
                (true, true) => (255, 0, 0),
                (false, true) => (0, 255, 0),
                (true, false) => (0, 0, 255),
                (false, false) => (255, 255, 255),
            };
            // XRGB little-endian: memory order B, G, R, X.
            out.extend([b, g, r, 255]);
        }
    }
    out
}

fn r90_monitor() -> Monitor {
    Monitor {
        registry_name: 7,
        name: Some("Fake-1".to_owned()),
        geometry: OutputGeometry::new(0, 0, 24, 32, 1.0, 1, 32, 24)
            .expect("rotated test geometry is valid"),
        refresh_millihz: 60_000,
    }
}

fn near(a: &[u8; 3], b: &[u8; 3]) -> bool {
    a.iter().zip(b).all(|(g, w)| g.abs_diff(*w) < 40)
}

#[test]
fn normalized_capture_rotates_upright_through_the_wire() {
    // R90 monitor, 32x24 buffer: the fused tail returns the 24x32 upright
    // image through the real protocol path — rotation happens exactly once
    // between the SHM bytes and the single JPEG encode.
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: xrgb_format(),
                width: 32,
                height: 24,
                stride: 128,
                y_invert: false,
                send_done: true,
                fail_early: false,
                fail_after_copy: false,
                mutated_buffer: None,
                pixels: quad_pixels(32, 24),
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let frame = capture_monitor_normalized(conn, &snapshot(), &r90_monitor(), Instant::now() + Duration::from_secs(5), &cancel)
        .expect("fake-peer normalized capture succeeds");
    assert_eq!((frame.buffer_width, frame.buffer_height), (32, 24));
    assert_eq!((frame.width, frame.height), (24, 32), "fused dims are the upright target");
    let decoded = image::load_from_memory_with_format(&frame.jpeg, image::ImageFormat::Jpeg)
        .expect("normalized capture returns JPEG bytes")
        .to_rgb8();
    assert_eq!(decoded.dimensions(), (24, 32));
    // Buffer BL (blue) shows at upright TL; buffer TL (red) at upright TR.
    assert!(near(&decoded.get_pixel(1, 1).0, &[0, 0, 255]), "upright TL is buffer BL blue");
    assert!(near(&decoded.get_pixel(22, 1).0, &[255, 0, 0]), "upright TR is buffer TL red");
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(obs.saw_pool && obs.saw_copy, "fused path allocates and copies like the raw path");
    assert!(obs.frame_destroyed, "fused success destroys the frame on the wire");
    assert!(obs.pool_destroyed, "fused success destroys the pool on the wire");
    assert!(obs.buffer_destroyed, "fused success destroys the buffer on the wire");
}

#[test]
fn normalized_capture_downscales_to_the_long_edge_through_the_wire() {
    // 1920x1080 buffer at scale 1: the fused tail returns 1280x720 through
    // the real protocol path, with the same destroy discipline.
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: xrgb_format(),
                width: 1920,
                height: 1080,
                stride: 1920 * 4,
                y_invert: false,
                send_done: true,
                fail_early: false,
                fail_after_copy: false,
                mutated_buffer: None,
                pixels: quad_pixels(1920, 1080),
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let monitor = monitor(7, 1920, 1080);
    let frame = capture_monitor_normalized(conn, &snapshot(), &monitor, Instant::now() + Duration::from_secs(30), &cancel)
        .expect("fake-peer normalized capture succeeds");
    assert_eq!((frame.buffer_width, frame.buffer_height), (1920, 1080));
    assert_eq!((frame.width, frame.height), (1280, 720));
    let decoded = image::load_from_memory_with_format(&frame.jpeg, image::ImageFormat::Jpeg)
        .expect("normalized capture returns JPEG bytes")
        .to_rgb8();
    assert_eq!(decoded.dimensions(), (1280, 720));
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(obs.frame_destroyed && obs.pool_destroyed && obs.buffer_destroyed);
}

#[test]
fn normalized_capture_refuses_dimension_mismatch_before_any_pool() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: xrgb_format(),
                width: 16,
                height: 16,
                stride: 64,
                y_invert: false,
                send_done: true,
                fail_early: false,
                fail_after_copy: false,
                mutated_buffer: None,
                pixels: quad_pixels(16, 16),
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let err = capture_monitor_normalized(conn, &snapshot(), &r90_monitor(), Instant::now() + Duration::from_secs(5), &cancel)
        .expect_err("a 16x16 offer for a 32x24 buffer must be refused");
    assert!(matches!(err, CaptureError::DimensionMismatch { .. }), "wrong refusal: {err}");
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(!obs.saw_pool, "refusal must not allocate a pool");
    assert!(obs.frame_destroyed, "refusal still destroys the frame on the wire");
}

#[test]
fn normalized_capture_cancels_mid_downscale_with_destroys() {
    // The hook fires per downscale row: cancelling there stops the fused
    // tail mid-stage (not just pre-set), and the protocol objects still go
    // through the scope guard.
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let peer_thread = std::thread::spawn(|| {
        serve_capture(
            peer,
            FrameOffer {
                format: xrgb_format(),
                width: 32,
                height: 24,
                stride: 128,
                y_invert: false,
                send_done: true,
                fail_early: false,
                fail_after_copy: false,
                mutated_buffer: None,
                pixels: quad_pixels(32, 24),
            },
        )
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let cancel = CancelHandle::new();
    let handle = cancel.clone();
    let hook = move |stage: CaptureStage, _progress: u64| {
        if stage == CaptureStage::DownscaleRows {
            handle.cancel();
        }
    };
    let err = capture_monitor_normalized_with_hooks(
        conn,
        &snapshot(),
        &r90_monitor(),
        Instant::now() + Duration::from_secs(5),
        &cancel,
        Some(&hook),
    )
    .expect_err("cancelling mid-downscale must stop the capture");
    assert!(
        matches!(err, CaptureError::Transport(_)),
        "cancel surfaces as a transport stop, got: {err}"
    );
    let obs = peer_thread.join().expect("peer thread ends");
    assert!(obs.frame_destroyed, "cancel still destroys the frame on the wire");
    assert!(obs.pool_destroyed, "cancel still destroys the pool on the wire");
    assert!(obs.buffer_destroyed, "cancel still destroys the buffer on the wire");
}
