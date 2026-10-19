//! RED/GREEN checks for [`super::keyboard`]: bounded virtual-keyboard
//! type/press over a fake peer on an isolated socket, with the keymap fd
//! received over `SCM_RIGHTS`, read back, and validated. No real compositor
//! is touched. The fake below speaks just enough wire protocol
//! (`get_registry`, `bind`, `create_virtual_keyboard`, `keymap`/`key`/
//! `destroy`, seat `release`, `sync`) and records every client request in
//! order, including ancillary fd delivery. Every wait carries the total
//! deadline and the cooperative cancel handle; there is no `roundtrip`
//! anywhere in these tests.
//!
//! What each test pins through the public boundary: exact modifier/key
//! press-release sequences and evdev codes for type and combo (Mac `cmd`
//! drives Super, `fn` is refused); keymap `format` 1, `size` equal to the
//! received bytes, NUL-terminated, with valid XKB symbol spellings for
//! accents/non-Latin/emoji; Unicode mapped through level-1 keysyms (no
//! Shift synthesis); combo/text validation and limits sending zero bytes;
//! cancel mid-text and mid-combo releasing held keys/modifiers before the
//! keyboard destroy; timeout/dead peers staying bounded and never reporting
//! success. XKB validity here is structural (the peer checks the received
//! text); nothing compiles the keymap with libxkbcommon.

use super::capabilities::{AdvertisedGlobal, CapabilitySnapshot, VIRTUAL_KEYBOARD, WL_SEAT};
use super::keyboard::{press_combo, type_text, KeyboardError};
use super::transport::{connection_from_stream, CancelHandle, TransportKind};
use std::io::Read;
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn advertised(name: u32, interface: &str, version: u32) -> AdvertisedGlobal {
    AdvertisedGlobal { name, interface: interface.to_owned(), version }
}

fn snapshot_with(seat_version: u32) -> CapabilitySnapshot {
    CapabilitySnapshot::negotiate(&[
        advertised(50, WL_SEAT, seat_version),
        advertised(60, VIRTUAL_KEYBOARD, 1),
    ])
}

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
    BindSeat { name: u32, version: u32 },
    CreateKeyboard { seat_name: u32 },
    Keymap { format: u32, size: u32 },
    KeymapContent(Vec<u8>),
    Key { key: u32, state: u32 },
    KeyboardDestroy,
    SeatRelease,
    Sync,
}

const PRESSED: u32 = 1;
const RELEASED: u32 = 0;
// Evdev codes from the fixed keycode layout (XKB keycode - 8): the four
// modifiers sit at keycodes 9..12, caller keysyms from 13 on.
const EVDEV_CTRL: u32 = 1;
const EVDEV_SHIFT: u32 = 2;
const EVDEV_ALT: u32 = 3;
const EVDEV_SUPER: u32 = 4;
const EVDEV_FIRST_KEY: u32 = 5;

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

struct PeerOpts {
    silent_sync: bool,
    cancel_on_first_press: Option<CancelHandle>,
}

fn spawn_peer(opts: PeerOpts) -> (UnixStream, Peer, std::thread::JoinHandle<()>) {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    let observed = Arc::new(Mutex::new(Vec::new()));
    let bytes = Arc::new(AtomicUsize::new(0));
    let eof = Arc::new(AtomicBool::new(false));
    let handle = Peer { observed: observed.clone(), bytes: bytes.clone(), eof: eof.clone() };
    let cancel = opts.cancel_on_first_press;
    let silent_sync = opts.silent_sync;
    let thread = std::thread::spawn(move || {
        peer.set_read_timeout(Some(Duration::from_secs(2))).expect("read timeout");
        let raw = peer.as_raw_fd();
        let mut buffered = Vec::new();
        let mut fd_queue: Vec<OwnedFd> = Vec::new();
        let mut registry_id = None;
        let mut manager_id = None;
        let mut seat_ids: Vec<(u32, u32)> = Vec::new();
        let mut keyboard_ids: Vec<u32> = Vec::new();
        let mut callback_id = None;
        let mut cancelled_once = false;
        let mut data = vec![0u8; 65536];
        // Room for a small burst of SCM_RIGHTS control messages.
        let mut control = vec![0u8; 512];
        loop {
            // recvmsg (not read): the keymap fd travels as ancillary data,
            // and a plain read would discard it. Data and control stay in
            // arrival order, so each keymap request pops the next fd.
            let received = unsafe {
                let mut iov = libc::iovec {
                    iov_base: data.as_mut_ptr() as *mut libc::c_void,
                    iov_len: data.len(),
                };
                let mut header: libc::msghdr = std::mem::zeroed();
                header.msg_iov = &mut iov;
                header.msg_iovlen = 1;
                header.msg_control = control.as_mut_ptr() as *mut libc::c_void;
                header.msg_controllen = control.len();
                let got = libc::recvmsg(raw, &mut header, 0);
                if got > 0 {
                    let mut cmsg = libc::CMSG_FIRSTHDR(&header);
                    while !cmsg.is_null() {
                        if (*cmsg).cmsg_level == libc::SOL_SOCKET
                            && (*cmsg).cmsg_type == libc::SCM_RIGHTS
                        {
                            let payload = (*cmsg).cmsg_len as usize
                                - libc::CMSG_LEN(0) as usize;
                            let count = payload / std::mem::size_of::<libc::c_int>();
                            let fds = libc::CMSG_DATA(cmsg) as *const libc::c_int;
                            for i in 0..count {
                                fd_queue.push(OwnedFd::from_raw_fd(*fds.add(i)));
                            }
                        }
                        cmsg = libc::CMSG_NXTHDR(&header, cmsg);
                    }
                }
                got
            };
            if received == 0 {
                break;
            }
            if received < 0 {
                let errno = std::io::Error::last_os_error();
                if errno.kind() == std::io::ErrorKind::WouldBlock
                    || errno.kind() == std::io::ErrorKind::TimedOut
                {
                    continue;
                }
                break;
            }
            let received = received as usize;
            bytes.fetch_add(received, Ordering::SeqCst);
            buffered.extend_from_slice(&data[..received]);
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
                    if !silent_sync {
                        let mut payload = Vec::new();
                        wire_u32(&mut payload, 0);
                        let reply = wire_message(callback_id.expect("sync id"), 0, &payload);
                        use std::io::Write;
                        (&peer).write_all(&reply).expect("fake peer answers sync");
                    }
                    continue;
                } else if Some(sender) == registry_id && opcode == 0 {
                    let mut off = 0;
                    let name = read_u32(&body, &mut off);
                    let interface = read_string(&body, &mut off);
                    let version = read_u32(&body, &mut off);
                    let new_id = read_u32(&body, &mut off);
                    if interface == "zwp_virtual_keyboard_manager_v1" {
                        manager_id = Some(new_id);
                        log.push(Observed::BindManager { version });
                    } else if interface == "wl_seat" {
                        seat_ids.push((new_id, name));
                        log.push(Observed::BindSeat { name, version });
                    }
                } else if Some(sender) == manager_id && opcode == 0 {
                    let mut off = 0;
                    let seat = read_u32(&body, &mut off);
                    let new_id = read_u32(&body, &mut off);
                    let name = seat_ids
                        .iter()
                        .find(|(id, _)| *id == seat)
                        .map(|(_, name)| *name)
                        .expect("create names a bound seat");
                    keyboard_ids.push(new_id);
                    log.push(Observed::CreateKeyboard { seat_name: name });
                } else if seat_ids.iter().any(|(id, _)| *id == sender) && opcode == 3 {
                    // `wl_seat.release` (since v5); below that none is sent.
                    log.push(Observed::SeatRelease);
                } else if keyboard_ids.contains(&sender) {
                    let mut off = 0;
                    match opcode {
                        0 => {
                            let format = read_u32(&body, &mut off);
                            let size = read_u32(&body, &mut off);
                            log.push(Observed::Keymap { format, size });
                            let fd = fd_queue.pop().expect("keymap carries exactly one fd");
                            drop(log);
                            // The memfd reads back immediately: it is
                            // anonymous memory, never a repo or /tmp path.
                            // Seek to the start first: the sender may leave
                            // the offset at end-of-file, and a plain read
                            // from there would see nothing.
                            unsafe {
                                assert_eq!(
                                    libc::lseek(
                                        std::os::unix::io::AsRawFd::as_raw_fd(&fd),
                                        0,
                                        libc::SEEK_SET
                                    ),
                                    0,
                                    "keymap fd seeks"
                                );
                            }
                            let mut content = Vec::new();
                            std::fs::File::from(fd)
                                .read_to_end(&mut content)
                                .expect("keymap fd reads");
                            observed
                                .lock()
                                .expect("peer log")
                                .push(Observed::KeymapContent(content));
                        }
                        1 => {
                            let _time = read_u32(&body, &mut off);
                            let key = read_u32(&body, &mut off);
                            let state = read_u32(&body, &mut off);
                            log.push(Observed::Key { key, state });
                            if state == PRESSED && !cancelled_once {
                                cancelled_once = true;
                                if let Some(cancel) = cancel.as_ref() {
                                    cancel.cancel();
                                }
                            }
                        }
                        3 => log.push(Observed::KeyboardDestroy),
                        other => panic!("fake peer saw unknown keyboard opcode {other}"),
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
        assert!(start.elapsed() < Duration::from_millis(timeout_ms), "peer never saw EOF");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn contains(log: &[Observed], event: &Observed) -> bool {
    log.iter().any(|seen| seen == event)
}

fn live_peer() -> (UnixStream, Peer, std::thread::JoinHandle<()>) {
    spawn_peer(PeerOpts { silent_sync: false, cancel_on_first_press: None })
}

fn keymap_content(log: &[Observed]) -> Vec<u8> {
    log.iter()
        .find_map(|event| match event {
            Observed::KeymapContent(content) => Some(content.clone()),
            _ => None,
        })
        .expect("peer must have received the keymap fd")
}

fn without_content(log: &[Observed]) -> Vec<Observed> {
    log.iter().filter(|event| !matches!(event, Observed::KeymapContent(_))).cloned().collect()
}

#[test]
fn type_ascii_sends_exact_press_release_pairs_with_valid_keymap_fd() {
    let (client, peer, _thread) = live_peer();
    let conn = connection_from_stream(client).expect("client wraps the pair");
    type_text(
        conn,
        &snapshot_with(7),
        "hi",
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("typing against a live peer succeeds");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Sync));
    // The keymap fd content is asserted separately; the order below pins
    // every wire event around it.
    assert_eq!(
        without_content(&seen),
        vec![
            Observed::BindManager { version: 1 },
            Observed::BindSeat { name: 50, version: 7 },
            Observed::CreateKeyboard { seat_name: 50 },
            Observed::Keymap {
                format: 1,
                size: keymap_content(&seen).len() as u32,
            },
            Observed::Key { key: EVDEV_FIRST_KEY, state: PRESSED },
            Observed::Key { key: EVDEV_FIRST_KEY, state: RELEASED },
            Observed::Key { key: EVDEV_FIRST_KEY + 1, state: PRESSED },
            Observed::Key { key: EVDEV_FIRST_KEY + 1, state: RELEASED },
            Observed::KeyboardDestroy,
            Observed::SeatRelease,
            Observed::Sync,
        ],
        "type order must be exact: manager/seat bind, seat-bound create, \
         keymap upload, press/release pairs, keyboard destroy, seat release, sync"
    );
    let content = keymap_content(&seen);
    assert_eq!(content.last(), Some(&0), "keymap is NUL-terminated");
    let text = std::str::from_utf8(&content[..content.len() - 1]).expect("keymap is UTF-8");
    assert!(text.starts_with("xkb_keymap {"), "got: {text}");
    assert!(text.contains("[ h, h ]"), "h bound at level 1, got: {text}");
    assert!(text.contains("[ i, i ]"), "i bound at level 1, got: {text}");
    assert!(text.contains("modifier_map Control"), "got: {text}");
    // The operation consumes its connection: the peer must see EOF once the
    // call returns, proving no shared connection is left alive.
    wait_eof(&peer, 2_000);
}

#[test]
fn unicode_text_maps_accents_and_emoji_without_shift_synthesis() {
    let (client, peer, _thread) = live_peer();
    let conn = connection_from_stream(client).expect("client wraps the pair");
    type_text(
        conn,
        &snapshot_with(7),
        "héllo😀好",
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("unicode typing against a live peer succeeds");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Sync));
    let presses: Vec<u32> = seen
        .iter()
        .filter_map(|event| match event {
            Observed::Key { key, state: PRESSED } => Some(*key),
            _ => None,
        })
        .collect();
    let releases: Vec<u32> = seen
        .iter()
        .filter_map(|event| match event {
            Observed::Key { key, state: RELEASED } => Some(*key),
            _ => None,
        })
        .collect();
    // Seven chars (h, e-acute, l, l, o, emoji, CJK): seven pairs, each
    // press released, and no Shift synthesis anywhere (every keysym sits
    // at level 1 of its own key).
    assert_eq!(presses.len(), 7, "one press per char, got: {seen:?}");
    assert_eq!(releases.len(), 7, "every press released, got: {seen:?}");
    let mut sorted_presses = presses.clone();
    sorted_presses.sort_unstable();
    let mut sorted_releases = releases;
    sorted_releases.sort_unstable();
    assert_eq!(sorted_presses, sorted_releases, "press/release pair up, got: {seen:?}");
    assert!(
        !presses.contains(&EVDEV_SHIFT),
        "unicode never synthesizes Shift, got: {seen:?}"
    );
    let content = keymap_content(&seen);
    let text = std::str::from_utf8(&content[..content.len() - 1]).expect("keymap is UTF-8");
    assert!(text.contains("U00E9"), "e-acute via U escape, got: {text}");
    assert!(text.contains("U1F600"), "emoji via U escape, got: {text}");
    assert!(text.contains("U597D"), "CJK via U escape, got: {text}");
    wait_eof(&peer, 2_000);
}

#[test]
fn press_combo_sends_modifiers_base_and_reverse_releases() {
    let (client, peer, _thread) = live_peer();
    let conn = connection_from_stream(client).expect("client wraps the pair");
    press_combo(
        conn,
        &snapshot_with(7),
        "ctrl+shift+t",
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("combo against a live peer succeeds");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Sync));
    assert_eq!(
        without_content(&seen),
        vec![
            Observed::BindManager { version: 1 },
            Observed::BindSeat { name: 50, version: 7 },
            Observed::CreateKeyboard { seat_name: 50 },
            Observed::Keymap {
                format: 1,
                size: keymap_content(&seen).len() as u32,
            },
            Observed::Key { key: EVDEV_CTRL, state: PRESSED },
            Observed::Key { key: EVDEV_SHIFT, state: PRESSED },
            // The base key follows the two modifiers in the keymap, so it
            // lands two codes past the first caller key.
            Observed::Key { key: EVDEV_FIRST_KEY + 2, state: PRESSED },
            Observed::Key { key: EVDEV_FIRST_KEY + 2, state: RELEASED },
            Observed::Key { key: EVDEV_SHIFT, state: RELEASED },
            Observed::Key { key: EVDEV_CTRL, state: RELEASED },
            Observed::KeyboardDestroy,
            Observed::SeatRelease,
            Observed::Sync,
        ],
        "combo order must be exact: canonical modifier press order, base \
         tap, reverse releases, then keyboard destroy before the sync"
    );
    let content = keymap_content(&seen);
    let text = std::str::from_utf8(&content[..content.len() - 1]).expect("keymap is UTF-8");
    assert!(text.contains("Control_L") && text.contains("Shift_L"), "got: {text}");
    wait_eof(&peer, 2_000);
}

#[test]
fn mac_cmd_drives_super() {
    let (client, peer, _thread) = live_peer();
    let conn = connection_from_stream(client).expect("client wraps the pair");
    press_combo(
        conn,
        &snapshot_with(7),
        "cmd+a",
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("cmd combo succeeds");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Sync));
    assert!(
        contains(&seen, &Observed::Key { key: EVDEV_SUPER, state: PRESSED }),
        "Mac cmd maps to Super, got: {seen:?}"
    );
    assert!(
        contains(&seen, &Observed::Key { key: EVDEV_SUPER, state: RELEASED }),
        "Super is released, got: {seen:?}"
    );
    assert!(
        !seen.iter().any(|event| matches!(event, Observed::Key { key: EVDEV_CTRL, .. })),
        "no Ctrl leaks into a cmd combo, got: {seen:?}"
    );
}

#[test]
fn invalid_combos_reject_before_any_input() {
    for combo in ["", "cmd+", "cmd", "hyper+a", "cmd++a", "cmd+f13", "fn+a"] {
        let (client, peer, _thread) = live_peer();
        let conn = connection_from_stream(client).expect("client wraps the pair");
        let err = press_combo(
            conn,
            &snapshot_with(7),
            combo,
            Instant::now() + Duration::from_secs(5),
            &CancelHandle::new(),
        )
        .expect_err("invalid combo must fail");
        assert!(
            matches!(
                err,
                KeyboardError::InvalidCombo(_) | KeyboardError::UnsupportedModifier(_)
            ),
            "{combo:?} got: {err}"
        );
        wait_eof(&peer, 2_000);
        assert_eq!(peer.bytes.load(Ordering::SeqCst), 0, "no request may precede validation");
        assert!(peer.take().is_empty(), "no event may precede validation");
    }
}

#[test]
fn missing_protocol_or_seat_fails_closed() {
    // No virtual keyboard advertised: truthful interface error, no bytes.
    let (client, peer, _thread) = live_peer();
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let snapshot = CapabilitySnapshot::negotiate(&[advertised(50, WL_SEAT, 7)]);
    let err = type_text(
        conn,
        &snapshot,
        "hi",
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect_err("a compositor without the manager must fail");
    assert!(matches!(err, KeyboardError::MissingProtocol(_)), "got: {err}");
    assert!(err.to_string().contains("zwp_virtual_keyboard_manager_v1"), "got: {err}");
    assert!(!err.to_string().contains("niri"), "no compositor guesses: {err}");
    wait_eof(&peer, 2_000);
    assert_eq!(peer.bytes.load(Ordering::SeqCst), 0, "no request may precede validation");
    // No seat advertised: the keyboard cannot be created without one.
    let (client, peer, _thread) = live_peer();
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let snapshot = CapabilitySnapshot::negotiate(&[advertised(60, VIRTUAL_KEYBOARD, 1)]);
    let err = press_combo(
        conn,
        &snapshot,
        "ctrl+t",
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect_err("a compositor without a seat must fail");
    assert!(matches!(err, KeyboardError::MissingProtocol(_)), "got: {err}");
    assert!(err.to_string().contains("wl_seat"), "got: {err}");
    wait_eof(&peer, 2_000);
    assert_eq!(peer.bytes.load(Ordering::SeqCst), 0, "no request may precede validation");
}

#[test]
fn text_limits_reject_before_any_input() {
    let long: String = "a".repeat(2000);
    let mut many_distinct = String::new();
    for scalar in 0x4E00u32..0x4E00u32 + 300 {
        many_distinct.push(char::from_u32(scalar).expect("CJK scalar"));
    }
    for text in [String::new(), "a\0b".to_owned(), long, many_distinct] {
        let (client, peer, _thread) = live_peer();
        let conn = connection_from_stream(client).expect("client wraps the pair");
        let err = type_text(
            conn,
            &snapshot_with(7),
            &text,
            Instant::now() + Duration::from_secs(5),
            &CancelHandle::new(),
        )
        .expect_err("limited text must fail");
        assert!(
            matches!(
                err,
                KeyboardError::EmptyText
                    | KeyboardError::TextTooLong { .. }
                    | KeyboardError::Keymap(_)
            ),
            "got: {err}"
        );
        wait_eof(&peer, 2_000);
        assert_eq!(peer.bytes.load(Ordering::SeqCst), 0, "no request may precede validation");
        assert!(peer.take().is_empty(), "no event may precede validation");
    }
}

#[test]
fn cancel_mid_text_never_reports_success_and_pairs_every_press() {
    let cancel = CancelHandle::new();
    let (client, peer, _thread) = spawn_peer(PeerOpts {
        silent_sync: true,
        cancel_on_first_press: Some(cancel.clone()),
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let err = type_text(
        conn,
        &snapshot_with(7),
        "hello world, this is a cancelled line",
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("a cancelled type must not report success");
    assert!(
        matches!(&err, KeyboardError::Transport(error) if error.kind == TransportKind::Cancelled),
        "got: {err}"
    );
    // The sync barrier is withheld, so the client can only fail here: pair
    // up whatever presses reached the peer and confirm teardown order. The
    // sync request bytes may already be flushed when the cancel lands at
    // the barrier, so only the unanswered barrier (no false success) is
    // pinned here; the combo test below pins the no-sync-bytes path.
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::KeyboardDestroy));
    let presses: Vec<u32> = seen
        .iter()
        .filter_map(|event| match event {
            Observed::Key { key, state: PRESSED } => Some(*key),
            _ => None,
        })
        .collect();
    let mut releases: Vec<u32> = seen
        .iter()
        .filter_map(|event| match event {
            Observed::Key { key, state: RELEASED } => Some(*key),
            _ => None,
        })
        .collect();
    let mut sorted = presses.clone();
    sorted.sort_unstable();
    releases.sort_unstable();
    assert_eq!(sorted, releases, "every pressed key is released, got: {seen:?}");
    let pos = |event: &Observed| seen.iter().position(|seen| seen == event).expect("event present");
    assert!(
        pos(&Observed::KeyboardDestroy) < pos(&Observed::SeatRelease),
        "seat release follows the keyboard destroy, got: {seen:?}"
    );
    wait_eof(&peer, 2_000);
}

#[test]
fn cancel_during_combo_settle_releases_modifiers_before_destroy() {
    let cancel = CancelHandle::new();
    let (client, peer, _thread) = spawn_peer(PeerOpts {
        silent_sync: true,
        cancel_on_first_press: Some(cancel.clone()),
    });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let err = press_combo(
        conn,
        &snapshot_with(7),
        "ctrl+alt+t",
        Instant::now() + Duration::from_secs(5),
        &cancel,
    )
    .expect_err("a cancelled combo must not report success");
    assert!(
        matches!(&err, KeyboardError::Transport(error) if error.kind == TransportKind::Cancelled),
        "got: {err}"
    );
    // The modifiers were flushed before the settle pause, so the cancel
    // lands while they are held: releases must precede the destroy.
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::KeyboardDestroy));
    let pos = |event: &Observed| seen.iter().position(|seen| seen == event).expect("event present");
    let press_ctrl = pos(&Observed::Key { key: EVDEV_CTRL, state: PRESSED });
    let release_alt = pos(&Observed::Key { key: EVDEV_ALT, state: RELEASED });
    let release_ctrl = pos(&Observed::Key { key: EVDEV_CTRL, state: RELEASED });
    let destroy = pos(&Observed::KeyboardDestroy);
    assert!(press_ctrl < release_alt, "held modifiers are released, got: {seen:?}");
    assert!(release_alt < release_ctrl, "releases run in reverse, got: {seen:?}");
    assert!(release_ctrl < destroy, "releases precede destroy, got: {seen:?}");
    assert!(
        !seen.iter().any(|event| matches!(event, Observed::Key { key: EVDEV_FIRST_KEY, .. })),
        "the base key is never touched on the cancel path, got: {seen:?}"
    );
    assert!(!contains(&seen, &Observed::Sync), "no confirming sync on cancel, got: {seen:?}");
    wait_eof(&peer, 2_000);
}

#[test]
fn dead_peer_is_a_bounded_disconnect_never_a_success() {
    let (client, peer) = UnixStream::pair().expect("socketpair works in tests");
    drop(peer);
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let start = Instant::now();
    let err = type_text(
        conn,
        &snapshot_with(7),
        "hi",
        start + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect_err("a dead peer must not report success");
    assert_eq!(err_kind(&err), Some(TransportKind::Disconnected), "got: {err}");
    assert!(start.elapsed() < Duration::from_secs(3), "disconnect stays bounded, took {:?}", start.elapsed());
}

#[test]
fn silent_peer_hits_the_deadline_never_a_success() {
    let (client, _peer, _thread) = spawn_peer(PeerOpts { silent_sync: true, cancel_on_first_press: None });
    let conn = connection_from_stream(client).expect("client wraps the pair");
    let start = Instant::now();
    let err = type_text(
        conn,
        &snapshot_with(7),
        "hi",
        start + Duration::from_millis(300),
        &CancelHandle::new(),
    )
    .expect_err("a silent peer must not report success");
    assert_eq!(err_kind(&err), Some(TransportKind::Timeout), "got: {err}");
    assert!(start.elapsed() < Duration::from_secs(3), "silent peer stays bounded, took {:?}", start.elapsed());
}

#[test]
fn old_seat_version_skips_release_but_still_succeeds() {
    // `wl_seat.release` exists only since version 5: below that no release
    // is fabricated; the connection close frees the seat server-side.
    let (client, peer, _thread) = live_peer();
    let conn = connection_from_stream(client).expect("client wraps the pair");
    press_combo(
        conn,
        &snapshot_with(4),
        "ctrl+t",
        Instant::now() + Duration::from_secs(5),
        &CancelHandle::new(),
    )
    .expect("combo against a v4 seat succeeds without release");
    let seen = wait_for(&peer, 5_000, &|log| contains(log, &Observed::Sync));
    assert!(
        !contains(&seen, &Observed::SeatRelease),
        "no release exists below v5, so none is fabricated, got: {seen:?}"
    );
    assert!(contains(&seen, &Observed::KeyboardDestroy), "got: {seen:?}");
    wait_eof(&peer, 2_000);
}

fn err_kind(error: &KeyboardError) -> Option<TransportKind> {
    match error {
        KeyboardError::Transport(error) => Some(error.kind),
        _ => None,
    }
}
