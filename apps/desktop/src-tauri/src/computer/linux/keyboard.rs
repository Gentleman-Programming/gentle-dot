//! Bounded virtual-keyboard input over `zwp_virtual_keyboard_manager_v1`
//! (T4b, S1-S5): `type_text` and `press_combo` against a stock Wayland
//! compositor, reusing the transport's total deadline and cooperative
//! [`CancelHandle`].
//!
//! What this binds, and nothing more: one virtual-keyboard manager, one
//! `wl_seat` (the keyboard is created bound to it), and one anonymous
//! memfd carrying the uploaded XKB keymap text. No pointer globals, no
//! capture globals, no clipboard, no shell, no root/uinput helpers. There
//! is no production startup, no UI, and no live input beyond the tested
//! fake-peer path.
//!
//! Keymap upload (anonymous, NUL-terminated, `size` counting the NUL,
//! `format` 1 = `xkb_v1`, like the reference bridge): the text comes from
//! [`super::keymap`], a hand-rolled XKB keymap with no libxkbcommon and no
//! xkeysym. Unicode (accents, non-Latin, emoji) maps through the
//! `0x01000000 | codepoint` encoding bound at level 1, so taps never
//! synthesize Shift. Modifiers come from the Mac `KeyCombo` grammar
//! (`computer::keys::parse_combo`, adapted not changed): Linux Ctrl/Alt/
//! Shift map directly, Mac `cmd` drives Super, and `fn` has no Linux
//! equivalent so it fails closed before any input.
//!
//! Ownership: every operation consumes its [`Connection`] and closes it
//! on return (see below). A scope guard releases the keys this operation
//! pressed (base keys first, then modifiers in reverse press order) and
//! explicitly destroys the keyboard with one best-effort nonblocking flush
//! on every exit — success, error, cancel, deadline, or panic unwind.
//! Only keys this operation pressed are ever released, so the physical
//! user's state is untouched, and no held input survives across operations
//! (no fork, no pidfile, no shared caller state). Delivery is confirmed by
//! a bounded `wl_display.sync` barrier: a silent or dead peer yields
//! Timeout/Disconnected instead of a false success. Every wait and pause
//! is deadline/cancel bounded; the total deadline includes the pauses.
//!
//! Lifecycle: sharing one connection across operations would accumulate one
//! `wl_registry` per operation, and `wl_registry` — like `wl_shm` and
//! pre-v3 `wl_output` — has no destructor, so no Drop or release call could
//! ever free it. Consuming the connection makes that accumulation
//! unrepresentable by construction: destructor-less objects die with the
//! connection close, while every object that does have a destructor (the
//! keyboard, and the v5+ seat) is explicitly destroyed/released inline —
//! held releases, then keyboard destroy, then seat release — before the
//! confirming barrier on success and best-effort on every error path. The
//! fd closes with the dropped `Connection`, which is also the dead-fd
//! cleanup: no cache, no global map, no forgotten object.
//!
//! Honest limits: the `zwp_virtual_keyboard_manager_v1` protocol (version
//! 1) defines no destructor for the manager, so the manager — like the
//! sweep registry — has no release to send and dies with the connection
//! close; none is fabricated. Niri's `destroyed` handler only removes the
//! resource, so a dead peer may never receive the error-path releases and
//! whether a closed connection releases stuck keys server-side is
//! compositor-defined and unproven here. The client therefore always sends
//! release before destroy itself and never relies on server-side cleanup;
//! callers must treat post-failure device state as unknown. Do not destroy
//! shared caller keyboards or physical state: only this operation's device
//! is ever touched. Separate verification compiled six generated keymaps
//! with libxkbcommon 1.13.2. Parser acceptance is verified; delivery to a real
//! compositor is not.
//! By-value `Connection` alone does NOT enforce exclusivity because
//! `Connection` can be cloned: the production owner must open a fresh
//! connection per operation and never retain clones, exactly like the
//! pointer operations.

use std::os::fd::FromRawFd;
use std::os::unix::io::{AsFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use wayland_client::protocol::{wl_callback, wl_registry, wl_seat};
use wayland_client::{Connection, Dispatch, EventQueue, QueueHandle};
use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::{
    zwp_virtual_keyboard_manager_v1, zwp_virtual_keyboard_v1,
};

use super::capabilities::{CapabilityError, CapabilitySnapshot, NegotiatedGlobal, VIRTUAL_KEYBOARD, WL_SEAT};
use super::keymap::{self, GeneratedKeymap, KeymapError};
use super::transport::{
    check_wait, flush_with_retry, read_ready_op, wait_readable, CancelHandle, TransportError,
};

/// Key states the virtual keyboard reuses from `wl_keyboard`.
const KEY_RELEASED: u32 = 0;
const KEY_PRESSED: u32 = 1;
/// XKB keymap format: 1 = `xkb_v1` text.
const XKB_V1: u32 = 1;
/// Longest text one `type_text` call types. Past this the caller splits;
/// every char is two requests, so an unbounded string could otherwise hold
/// the deadline hostage.
pub const MAX_TYPE_CHARS: usize = 1024;
/// Settle pause between the modifier-press phase and the base-key tap of a
/// combo: the compositor sees the chord held, and a cancel landing here
/// releases the held modifiers instead of racing the tap.
const COMBO_SETTLE_MS: u64 = 8;

/// What went wrong performing keyboard input. Validation failures fire
/// before any Wayland request is sent; every variant names the guilty
/// party and never guesses a compositor.
#[derive(Debug, Clone)]
pub enum KeyboardError {
    /// The socket wait failed (timeout, cancel, disconnect, I/O).
    Transport(TransportError),
    /// The compositor does not advertise a required global.
    MissingProtocol(CapabilityError),
    /// Key mapping or keymap generation failed (unsupported key, over a
    /// cap); the invalid input is named, never sent.
    Keymap(KeymapError),
    /// The combo fails the Mac `KeyCombo` grammar (message included).
    InvalidCombo(String),
    /// A modifier with no Linux mapping (Mac `fn`).
    UnsupportedModifier(&'static str),
    /// `type_text` refuses empty strings: nothing to type, nothing sent.
    EmptyText,
    /// Text past [`MAX_TYPE_CHARS`].
    TextTooLong { chars: usize },
}

impl std::fmt::Display for KeyboardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => write!(f, "{error}"),
            Self::MissingProtocol(error) => write!(f, "{error}"),
            Self::Keymap(error) => write!(f, "{error}"),
            Self::InvalidCombo(detail) => write!(f, "invalid key combo: {detail}"),
            Self::UnsupportedModifier(name) => write!(
                f,
                "`{name}` has no Linux mapping (Mac fn key), refusing instead of guessing"
            ),
            Self::EmptyText => write!(f, "nothing to type (empty text)"),
            Self::TextTooLong { chars } => write!(
                f,
                "text too long for one operation ({chars} chars > {MAX_TYPE_CHARS})"
            ),
        }
    }
}

impl std::error::Error for KeyboardError {}

impl From<TransportError> for KeyboardError {
    fn from(error: TransportError) -> Self {
        Self::Transport(error)
    }
}

impl From<CapabilityError> for KeyboardError {
    fn from(error: CapabilityError) -> Self {
        Self::MissingProtocol(error)
    }
}

impl From<KeymapError> for KeyboardError {
    fn from(error: KeymapError) -> Self {
        Self::Keymap(error)
    }
}

/// Type `text` as individual press/release pairs, in order. Unicode
/// (accents, non-Latin, emoji) types through level-1 keysyms, never with
/// Shift synthesis. Consumes `conn` and closes it before returning (see
/// the module lifecycle note).
pub fn type_text(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    text: &str,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<(), KeyboardError> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Err(KeyboardError::EmptyText);
    }
    if chars.len() > MAX_TYPE_CHARS {
        return Err(KeyboardError::TextTooLong { chars: chars.len() });
    }
    // Map every char before any request: one invalid char fails the whole
    // operation with nothing sent. Repeated chars reuse one placement.
    let mut distinct = Vec::new();
    let mut slots = Vec::with_capacity(chars.len());
    for &ch in &chars {
        let keysym = keymap::keysym_for_char(ch)?;
        let slot = match distinct.iter().position(|&known| known == keysym) {
            Some(index) => index,
            None => {
                distinct.push(keysym);
                distinct.len() - 1
            }
        };
        slots.push(slot);
    }
    let keymap = keymap::generate_keymap(&distinct)?;
    let resolved = resolve(snapshot)?;
    run(conn, &resolved, &keymap, deadline, cancel, |scope| {
        for &slot in &slots {
            check_wait("keyboard", deadline, cancel)?;
            let code = keymap.placements[slot].evdev_code;
            scope.press(code);
            scope.release_held();
        }
        Ok(())
    })
}

/// Press a `mod+mod+key` combo from the Mac `KeyCombo` grammar
/// (`computer::keys::parse_combo`, e.g. `cmd+shift+t`): modifiers press in
/// canonical order (Ctrl, Shift, Alt, Super), the base key taps, and
/// everything releases in reverse. Mac `cmd` drives Super; `fn` fails
/// closed. Consumes `conn` and closes it before returning (see the module
/// lifecycle note).
pub fn press_combo(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    combo: &str,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<(), KeyboardError> {
    let parsed =
        super::super::keys::parse_combo(combo).map_err(KeyboardError::InvalidCombo)?;
    if parsed.modifiers.fn_key {
        return Err(KeyboardError::UnsupportedModifier("fn"));
    }
    // Canonical press order (the grammar carries no order): Ctrl, Shift,
    // Alt, Super. Mac `cmd`/`command` arrive as the cmd flag already.
    let mut modifiers = Vec::new();
    if parsed.modifiers.ctrl {
        modifiers.push("ctrl");
    }
    if parsed.modifiers.shift {
        modifiers.push("shift");
    }
    if parsed.modifiers.alt {
        modifiers.push("alt");
    }
    if parsed.modifiers.cmd {
        modifiers.push("cmd");
    }
    let mut keysyms = Vec::with_capacity(modifiers.len() + 1);
    for token in &modifiers {
        keysyms.push(modifier_keysym(token));
    }
    keysyms.push(keymap::keysym_for_key_name(parsed.key)?);
    let keymap = keymap::generate_keymap(&keysyms)?;
    let resolved = resolve(snapshot)?;
    run(conn, &resolved, &keymap, deadline, cancel, |scope| {
        for token in &modifiers {
            scope.press(modifier_code(&keymap, token));
        }
        // The presses reach the peer before the settle even if the next
        // check fails, so a cancelled combo always has presses to release.
        flush_with_retry(scope.conn, "keyboard", deadline, cancel)?;
        bounded_pause(deadline, cancel, COMBO_SETTLE_MS)?;
        let base = keymap.placements[modifiers.len()].evdev_code;
        scope.press(base);
        scope.release_held();
        scope.release_held_all();
        Ok(())
    })
}

/// Keysym for a canonical modifier token (`press_combo` only passes the
/// four it recognizes).
fn modifier_keysym(token: &str) -> u32 {
    match token {
        "ctrl" => 0xFFE3, // Control_L
        "shift" => 0xFFE1, // Shift_L
        "alt" => 0xFFE9,  // Alt_L
        _ => 0xFFEB,      // Super_L (cmd/command/meta/super)
    }
}

/// Evdev code for a canonical modifier token within this keymap.
fn modifier_code(keymap: &GeneratedKeymap, token: &str) -> u32 {
    match token {
        "ctrl" => keymap.ctrl_code,
        "shift" => keymap.shift_code,
        "alt" => keymap.alt_code,
        _ => keymap.super_code,
    }
}

/// Capability handles for one operation: the manager plus the seat the
/// keyboard is created on. Both are bound before any input; a missing
/// global fails with its interface name, never a compositor guess.
struct Resolved {
    manager: NegotiatedGlobal,
    seat: NegotiatedGlobal,
}

/// Bind nothing until every handle checks out: unknown text, bad combos,
/// unsupported modifiers and missing protocols all fail before any
/// Wayland request is sent.
fn resolve(snapshot: &CapabilitySnapshot) -> Result<Resolved, KeyboardError> {
    let manager = snapshot.require(VIRTUAL_KEYBOARD)?;
    let seat = snapshot.require(WL_SEAT)?;
    Ok(Resolved { manager, seat })
}

/// Millisecond timestamp for the event `time` fields (wall clock, like the
/// reference bridge; only ordering within one device matters).
fn now_ms() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u32)
        .unwrap_or(0)
}

/// Sleep `millis` within the total deadline: check before and after so a
/// fired cancel or an elapsed deadline never sleeps through unnoticed.
fn bounded_pause(
    deadline: Instant,
    cancel: &CancelHandle,
    millis: u64,
) -> Result<(), TransportError> {
    check_wait("keyboard", deadline, cancel)?;
    std::thread::sleep(Duration::from_millis(millis));
    check_wait("keyboard", deadline, cancel)
}

/// Write the NUL-terminated keymap text to an anonymous memfd and hand the
/// fd back. No path, no fallback file: callers and tests never touch the
/// filesystem for keymaps.
fn keymap_memfd(text: &str) -> Result<OwnedFd, KeyboardError> {
    let mut bytes = text.as_bytes().to_vec();
    bytes.push(0);
    // SAFETY: memfd_create with a valid NUL-terminated name; the fd is
    // owned immediately so every early return closes it.
    let raw = unsafe {
        libc::memfd_create(c"gentle-dot-keymap".as_ptr(), libc::MFD_CLOEXEC)
    };
    if raw < 0 {
        return Err(KeyboardError::Transport(TransportError {
            kind: super::transport::TransportKind::Io,
            op: "keyboard",
            detail: format!("cannot create the keymap memfd: {}", std::io::Error::last_os_error()),
        }));
    }
    // SAFETY: fresh owned fd from memfd_create.
    let file = unsafe { OwnedFd::from_raw_fd(raw) };
    use std::io::{Seek, Write};
    let mut file = std::fs::File::from(file);
    file.write_all(&bytes).map_err(|error| {
        KeyboardError::Transport(TransportError {
            kind: super::transport::TransportKind::Io,
            op: "keyboard",
            detail: format!("cannot write the keymap memfd: {error}"),
        })
    })?;
    // Rewind: a compositor that reads (instead of mmap-ing) the fd must
    // see the whole text from the start, not an end-of-file offset.
    file.rewind().map_err(|error| {
        KeyboardError::Transport(TransportError {
            kind: super::transport::TransportKind::Io,
            op: "keyboard",
            detail: format!("cannot rewind the keymap memfd: {error}"),
        })
    })?;
    Ok(file.into())
}

/// Owned device for one operation: the virtual keyboard plus every key
/// this operation currently holds (press order). The guard releases all
/// held keys (reverse press order, base keys before modifiers by
/// construction) and explicitly destroys the device with one best-effort
/// nonblocking flush on every exit; only keys this operation pressed are
/// ever released.
struct KeyboardScope<'a> {
    conn: &'a Connection,
    keyboard: Option<zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1>,
    held: Vec<u32>,
}

impl<'a> KeyboardScope<'a> {
    fn new(conn: &'a Connection, keyboard: zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1) -> Self {
        Self { conn, keyboard: Some(keyboard), held: Vec::new() }
    }

    /// Key press, remembered for the guard.
    fn press(&mut self, code: u32) {
        if let Some(keyboard) = self.keyboard.as_ref() {
            keyboard.key(now_ms(), code, KEY_PRESSED);
        }
        self.held.push(code);
    }

    /// Release the most recently held key (one tap's other half).
    fn release_held(&mut self) {
        if let Some(code) = self.held.pop() {
            if let Some(keyboard) = self.keyboard.as_ref() {
                keyboard.key(now_ms(), code, KEY_RELEASED);
            }
        }
    }

    /// Release everything still held, in reverse press order.
    fn release_held_all(&mut self) {
        while !self.held.is_empty() {
            self.release_held();
        }
    }

    /// Explicit keyboard destroy. A dropped proxy alone never sends the
    /// protocol destructor, so without this the compositor would keep the
    /// device object alive for as long as it keeps the connection — and
    /// whether it would also keep stuck keys is compositor-defined and
    /// unproven, which is why release always precedes destroy here.
    fn destroy_now(&mut self) {
        if let Some(keyboard) = self.keyboard.take() {
            keyboard.destroy();
        }
    }
}

impl Drop for KeyboardScope<'_> {
    fn drop(&mut self) {
        // Releases before destroy on the same device, then one best-effort
        // nonblocking flush. Drop cannot fail, so the original result is
        // never swallowed; on a dead connection the requests may never
        // arrive, and no server-side cleanup is relied upon (see the module
        // lifecycle note).
        self.release_held_all();
        self.destroy_now();
        let _ = self.conn.flush();
    }
}

/// Bind the manager plus the seat, create the seat-bound keyboard, upload
/// the keymap, run `act`, then tear everything explicitly destructible
/// down and confirm every request (teardown included) through a bounded
/// `wl_display.sync` barrier. The error path tears down best-effort before
/// returning, so held keys release and the keyboard and seat are destroyed
/// even on error, cancel or deadline paths. Requires an exclusive
/// operation connection: the caller must not retain a `Connection` clone.
/// Consumption closes it on return only under that contract, freeing the
/// destructor-less registry (and the manager, which has no destructor)
/// server-side.
fn run(
    conn: Connection,
    resolved: &Resolved,
    keymap: &GeneratedKeymap,
    deadline: Instant,
    cancel: &CancelHandle,
    act: impl FnOnce(&mut KeyboardScope<'_>) -> Result<(), KeyboardError>,
) -> Result<(), KeyboardError> {
    let mut queue = conn.new_event_queue::<KeyboardDispatch>();
    let qh = queue.handle();
    let registry = conn.display().get_registry(&qh, ());
    let manager: zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1 =
        registry.bind(resolved.manager.name, resolved.manager.negotiated, &qh, ());
    let seat: wl_seat::WlSeat =
        registry.bind(resolved.seat.name, resolved.seat.negotiated, &qh, ());
    let keyboard = manager.create_virtual_keyboard(&seat, &qh, ());
    // The keymap fd must outlive the flush that carries it; the backend
    // duplicates it at queue time, but holding it through the barrier is
    // one line and removes any doubt.
    let keymap_fd = keymap_memfd(&keymap.text)?;
    let size = keymap.text.len() as u32 + 1;
    keyboard.keymap(XKB_V1, keymap_fd.as_fd(), size);
    let mut scope = KeyboardScope::new(&conn, keyboard);
    if let Err(error) = act(&mut scope) {
        teardown(&mut scope, &seat, resolved.seat.negotiated);
        drop(keymap_fd);
        let _ = conn.flush();
        return Err(error);
    }
    // The normal exit holds nothing (taps release inline, combos release
    // before return) and tears down before the barrier, so success means
    // the compositor saw everything including the teardown.
    teardown(&mut scope, &seat, resolved.seat.negotiated);
    drop(keymap_fd);
    let arrived = Arc::new(AtomicBool::new(false));
    let _callback = conn.display().sync(&qh, SyncDone(arrived.clone()));
    flush_with_retry(&conn, "keyboard", deadline, cancel)?;
    let mut state = KeyboardDispatch;
    await_delivery(&mut queue, &mut state, &arrived, &conn, deadline, cancel)?;
    Ok(())
}

/// Explicit per-operation teardown, in dependency order: held key releases
/// (reverse press order), the keyboard destroy, then the seat release.
/// `wl_seat.release` exists only since version 5, so below that no release
/// is fabricated: the connection close frees the seat server-side. The
/// manager has no destructor in v1 at all and likewise dies with the
/// close; none is fabricated either.
fn teardown(
    scope: &mut KeyboardScope<'_>,
    seat: &wl_seat::WlSeat,
    seat_version: u32,
) {
    scope.release_held_all();
    scope.destroy_now();
    if seat_version >= 5 {
        seat.release();
    }
}

/// Wait for the confirming barrier within the total deadline: dispatch until
/// the callback fires, reading only when the socket is readable. A silent
/// peer yields Timeout, a closed one Disconnected — never a false success.
fn await_delivery(
    queue: &mut EventQueue<KeyboardDispatch>,
    state: &mut KeyboardDispatch,
    arrived: &Arc<AtomicBool>,
    conn: &Connection,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<(), TransportError> {
    let backend = conn.backend();
    loop {
        check_wait("keyboard", deadline, cancel)?;
        queue.dispatch_pending(state).map_err(|error| TransportError {
            kind: super::transport::TransportKind::Disconnected,
            op: "keyboard",
            detail: format!("cannot dispatch compositor events: {error}"),
        })?;
        if arrived.load(Ordering::Acquire) {
            return Ok(());
        }
        match queue.prepare_read() {
            Some(guard) => {
                wait_readable(backend.poll_fd(), "keyboard", deadline, cancel)?;
                if !read_ready_op(guard, "keyboard")? {
                    continue;
                }
            }
            // Defensive: the pure-Rust backend always grants a guard; sleep
            // instead of hot-spinning, bounds still hold at loop top.
            None => std::thread::sleep(Duration::from_millis(1)),
        }
    }
}

/// Queue state for one operation: the registry burst needs no collection
/// (binds use the snapshot), only the confirming barrier does.
struct KeyboardDispatch;

impl Dispatch<wl_registry::WlRegistry, ()> for KeyboardDispatch {
    fn event(
        _state: &mut Self,
        _registry: &wl_registry::WlRegistry,
        _event: wl_registry::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        // Advertisements outside this operation's snapshot stay ignored.
    }
}

struct SyncDone(Arc<AtomicBool>);

impl Dispatch<wl_callback::WlCallback, SyncDone> for KeyboardDispatch {
    fn event(
        _state: &mut Self,
        _callback: &wl_callback::WlCallback,
        _event: wl_callback::Event,
        data: &SyncDone,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        // Every request sent before the barrier has been processed.
        data.0.store(true, Ordering::Release);
    }
}

wayland_client::delegate_noop!(KeyboardDispatch: ignore zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1);
wayland_client::delegate_noop!(KeyboardDispatch: ignore zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1);
wayland_client::delegate_noop!(KeyboardDispatch: ignore wl_seat::WlSeat);
