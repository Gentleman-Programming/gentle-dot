//! The Linux pointer and keyboard, phase 2 (odd/tasks/linux-input-control.md S2): what Gentle Dot
//! posts to Hyprland through `zwlr_virtual_pointer_v1` and `zwp_virtual_keyboard_v1`, as a plain
//! plan per input event so the plan is tested on every OS, plus the thin Wayland connection that
//! turns each plan into requests.
//!
//! The plans mirror `winput`'s Windows steps (same drag interpolation, same wheel notch
//! conversion, same modifier order) but in each protocol's own units: absolute motion in pixels
//! over the whole virtual screen, axis values where 120 is one wheel notch, and evdev keycodes
//! resolved against the keymap the keyboard uploads. The connection itself is exercised live on
//! Hyprland only: it degrades to a descriptive error, which surfaces through `Desktop::post`.

use super::coords::Point;
use super::keys::KeyCombo;
use super::winput::{DRAG_STEPS, PIXELS_PER_NOTCH, WHEEL_DELTA};
use super::{InputEvent, MouseButton};

/// One request a `zwlr_virtual_pointer_v1` sends, in the order the plan sends them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum PointerAction {
    /// `motion_absolute`: a position in pixels over the virtual screen's pixel extents.
    Move { x: i32, y: i32 },
    Button { button: MouseButton, down: bool },
    /// `axis`: 120 units are one notch, the unit `wl_pointer`'s discrete values use. A positive
    /// vertical value scrolls down and a positive horizontal one scrolls right.
    Axis { horizontal: bool, value: f64 },
}

/// The bounding box of every monitor in global points, plus the pixel scale that turns a point
/// into the absolute space `motion_absolute` works in. `motion_absolute` takes a fraction of that
/// box (`x / x_extent`), and the compositor lays its monitors out in points, so the scale only
/// sets how finely the box is divided: one scale for the whole box lands every point exactly
/// where the points say, mixed monitor scales included.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct VirtualScreen {
    /// The top-left corner of the box, in global points.
    pub origin: Point,
    pub width_pt: f64,
    pub height_pt: f64,
    /// The largest monitor scale, so points become pixels.
    pub pixels_per_point: f64,
}

impl VirtualScreen {
    /// The `x_extent`/`y_extent` of `motion_absolute`: the box in pixels, never zero.
    pub(crate) fn pixel_size(&self) -> (u32, u32) {
        let pixels = |points: f64| -> u32 {
            let pixels = (points * self.pixels_per_point).round();
            if pixels.is_finite() && pixels >= 1.0 { pixels as u32 } else { 1 }
        };
        (pixels(self.width_pt), pixels(self.height_pt))
    }

    /// The absolute move to `at`, clamped to the box: `motion_absolute` accepts 0..=extent.
    pub(crate) fn move_to(&self, at: Point) -> PointerAction {
        let (width, height) = self.pixel_size();
        let axis = |value: f64, origin: f64, extent: u32| -> i32 {
            let pixels = ((value - origin) * self.pixels_per_point).round();
            if pixels.is_finite() { pixels.clamp(0.0, f64::from(extent)) as i32 } else { 0 }
        };
        PointerAction::Move { x: axis(at.x, self.origin.x, width), y: axis(at.y, self.origin.y, height) }
    }
}

/// The virtual screen from `hyprctl monitors -j` JSON: `x`/`y` and `width`/`height` are the
/// monitor's logical box in global points (Hyprland reports them after scale), and `scale` is
/// its pixels per point.
pub(crate) fn virtual_screen(monitors_json: &str) -> Result<VirtualScreen, String> {
    let monitors: serde_json::Value =
        serde_json::from_str(monitors_json).map_err(|error| format!("hyprctl monitors -j: {error}"))?;
    let monitors = monitors.as_array().ok_or("hyprctl monitors -j: expected an array")?;
    // The box over every monitor: its top-left corner and its far corner, in global points.
    let mut bounds: Option<(Point, Point)> = None;
    let mut pixels_per_point: f64 = 1.0;
    for monitor in monitors {
        let number = |name: &str| monitor[name].as_f64().ok_or(format!("hyprctl monitor: missing {name}"));
        let (x, y, width, height) = (number("x")?, number("y")?, number("width")?, number("height")?);
        let top_left = Point { x, y };
        let bottom_right = Point { x: x + width, y: y + height };
        bounds = Some(match bounds {
            None => (top_left, bottom_right),
            Some((corner, far)) => (
                Point { x: corner.x.min(top_left.x), y: corner.y.min(top_left.y) },
                Point { x: far.x.max(bottom_right.x), y: far.y.max(bottom_right.y) },
            ),
        });
        // A monitor without a scale is one point per pixel; the widest scale wins, since one
        // extent serves the whole screen.
        let scale = monitor["scale"].as_f64().unwrap_or(1.0);
        if scale.is_finite() && scale > pixels_per_point {
            pixels_per_point = scale;
        }
    }
    let (corner, far) = bounds.ok_or("hyprctl monitors -j: no monitors")?;
    if far.x <= corner.x || far.y <= corner.y {
        return Err("hyprctl monitors -j: the monitors cover no area".into());
    }
    Ok(VirtualScreen {
        origin: corner,
        width_pt: far.x - corner.x,
        height_pt: far.y - corner.y,
        pixels_per_point,
    })
}

/// The requests that post `event`, in order. Keys and text are refused (T2).
pub(crate) fn pointer_plan(event: &InputEvent, screen: &VirtualScreen) -> Result<Vec<PointerAction>, String> {
    let mut actions = Vec::new();
    match event {
        InputEvent::Move(at) => actions.push(screen.move_to(*at)),
        InputEvent::Click { at, button, count } => {
            actions.push(screen.move_to(*at));
            for _ in 0..*count {
                actions.push(PointerAction::Button { button: *button, down: true });
                actions.push(PointerAction::Button { button: *button, down: false });
            }
        }
        // A drag is the button down at the start, `DRAG_STEPS` even moves, and the button up at
        // the end, as on the other platforms.
        InputEvent::Drag { from, to } => {
            actions.push(screen.move_to(*from));
            actions.push(PointerAction::Button { button: MouseButton::Left, down: true });
            for step in 1..=DRAG_STEPS {
                let t = f64::from(step) / f64::from(DRAG_STEPS);
                actions.push(screen.move_to(Point { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }));
            }
            actions.push(PointerAction::Button { button: MouseButton::Left, down: false });
        }
        InputEvent::Scroll { at, dx, dy } => {
            actions.push(screen.move_to(*at));
            actions.extend(axis(false, *dy));
            actions.extend(axis(true, *dx));
        }
        InputEvent::Key(_) | InputEvent::Text(_) => {
            return Err("keys and text are not pointer actions: the virtual keyboard posts them (keyboard_plan)".into())
        }
    }
    Ok(actions)
}

/// The axis request for `pixels` of scroll, or none for 0. The conversion is `winput`'s wheel:
/// `WHEEL_DELTA` per notch of `PIXELS_PER_NOTCH` pixels, and a scroll of a few pixels still turns
/// the wheel once. The tool's `dy > 0` scrolls down, which is a positive vertical axis value.
fn axis(horizontal: bool, pixels: i32) -> Option<PointerAction> {
    if pixels == 0 {
        return None;
    }
    let notches = f64::from(pixels) * f64::from(WHEEL_DELTA) / f64::from(PIXELS_PER_NOTCH);
    let magnitude = (notches.abs().round() as i32).max(1);
    let value = if notches < 0.0 { -magnitude } else { magnitude };
    Some(PointerAction::Axis { horizontal, value: f64::from(value) })
}

/// Execute `actions` through the session's virtual pointer, on the one device this app keeps
/// (`InputCache`). The protocol keeps no state between posts (an absolute move carries the whole
/// position), so the kept device serves every post. Compiled on every OS so the backend's `post`
/// stays whole; only Linux can connect.
pub(crate) fn execute(actions: &[PointerAction], screen: &VirtualScreen) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        session_input().pointer(actions, screen, wayland::Device::open)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (actions, screen);
        Err("virtual pointer input is Linux only".into())
    }
}

/// XKB keycodes are evdev's plus eight, the offset the X server and Wayland inherited from X11:
/// the keymap declares every key at `evdev + 8`, and the `key` request carries the evdev number a
/// kernel keyboard reports, which is what wlroots' virtual keyboard expects back.
pub(crate) const XKB_KEYCODE_OFFSET: u32 = 8;

/// The modifier masks the uploaded keymap gives its modifier keys, in XKB's order: Shift is bit 0,
/// Control bit 2 and Alt (Mod1) bit 3 (checked against libxkbcommon for this keymap). The plan
/// reports exactly the masks of the keys it holds down, so the compositor and the focused window
/// see Ctrl+A as Ctrl+A.
pub(crate) const MOD_SHIFT: u32 = 1 << 0;
pub(crate) const MOD_CONTROL: u32 = 1 << 2;
pub(crate) const MOD_ALT: u32 = 1 << 3;

/// The modifier keys the plan presses, from linux/input-event-codes.h.
const EVDEV_CONTROL: u32 = 29;
const EVDEV_SHIFT: u32 = 42;
const EVDEV_ALT: u32 = 56;

/// A key of the built-in US layout: its evdev keycode, and the keysym name and character of its
/// unshifted and shifted levels. The keymap text takes the names and typing takes the characters.
struct LayoutKey {
    evdev: u32,
    unshifted: (&'static str, char),
    shifted: (&'static str, char),
}

const fn layout(evdev: u32, unshifted: (&'static str, char), shifted: (&'static str, char)) -> LayoutKey {
    LayoutKey { evdev, unshifted, shifted }
}

/// Every printable key of the built-in US layout, by evdev keycode. The keymap the keyboard
/// uploads is generated from this table, so the keycodes typing picks and the keysyms the
/// compositor resolves cannot drift apart.
const LAYOUT: &[LayoutKey] = &[
    layout(41, ("grave", '`'), ("asciitilde", '~')),
    layout(2, ("1", '1'), ("exclam", '!')),
    layout(3, ("2", '2'), ("at", '@')),
    layout(4, ("3", '3'), ("numbersign", '#')),
    layout(5, ("4", '4'), ("dollar", '$')),
    layout(6, ("5", '5'), ("percent", '%')),
    layout(7, ("6", '6'), ("asciicircum", '^')),
    layout(8, ("7", '7'), ("ampersand", '&')),
    layout(9, ("8", '8'), ("asterisk", '*')),
    layout(10, ("9", '9'), ("parenleft", '(')),
    layout(11, ("0", '0'), ("parenright", ')')),
    layout(12, ("minus", '-'), ("underscore", '_')),
    layout(13, ("equal", '='), ("plus", '+')),
    layout(16, ("q", 'q'), ("Q", 'Q')),
    layout(17, ("w", 'w'), ("W", 'W')),
    layout(18, ("e", 'e'), ("E", 'E')),
    layout(19, ("r", 'r'), ("R", 'R')),
    layout(20, ("t", 't'), ("T", 'T')),
    layout(21, ("y", 'y'), ("Y", 'Y')),
    layout(22, ("u", 'u'), ("U", 'U')),
    layout(23, ("i", 'i'), ("I", 'I')),
    layout(24, ("o", 'o'), ("O", 'O')),
    layout(25, ("p", 'p'), ("P", 'P')),
    layout(26, ("bracketleft", '['), ("braceleft", '{')),
    layout(27, ("bracketright", ']'), ("braceright", '}')),
    layout(30, ("a", 'a'), ("A", 'A')),
    layout(31, ("s", 's'), ("S", 'S')),
    layout(32, ("d", 'd'), ("D", 'D')),
    layout(33, ("f", 'f'), ("F", 'F')),
    layout(34, ("g", 'g'), ("G", 'G')),
    layout(35, ("h", 'h'), ("H", 'H')),
    layout(36, ("j", 'j'), ("J", 'J')),
    layout(37, ("k", 'k'), ("K", 'K')),
    layout(38, ("l", 'l'), ("L", 'L')),
    layout(39, ("semicolon", ';'), ("colon", ':')),
    layout(40, ("apostrophe", '\''), ("quotedbl", '"')),
    layout(44, ("z", 'z'), ("Z", 'Z')),
    layout(45, ("x", 'x'), ("X", 'X')),
    layout(46, ("c", 'c'), ("C", 'C')),
    layout(47, ("v", 'v'), ("V", 'V')),
    layout(48, ("b", 'b'), ("B", 'B')),
    layout(49, ("n", 'n'), ("N", 'N')),
    layout(50, ("m", 'm'), ("M", 'M')),
    layout(51, ("comma", ','), ("less", '<')),
    layout(52, ("period", '.'), ("greater", '>')),
    layout(53, ("slash", '/'), ("question", '?')),
    layout(43, ("backslash", '\\'), ("bar", '|')),
    layout(57, ("space", ' '), ("space", ' ')),
];

/// The keys `keys` names that are not characters of the layout: the keysym the keymap declares for
/// them and their evdev keycode. `delete` is the key macOS calls delete, Backspace.
const NAMED: &[(&str, u32, &str)] = &[
    ("return", 28, "Return"),
    ("tab", 15, "Tab"),
    ("delete", 14, "BackSpace"),
    ("escape", 1, "Escape"),
    ("forwarddelete", 111, "Delete"),
    ("home", 102, "Home"),
    ("end", 107, "End"),
    ("pageup", 104, "Prior"),
    ("pagedown", 109, "Next"),
    ("left", 105, "Left"),
    ("right", 106, "Right"),
    ("up", 103, "Up"),
    ("down", 108, "Down"),
    ("f1", 59, "F1"),
    ("f2", 60, "F2"),
    ("f3", 61, "F3"),
    ("f4", 62, "F4"),
    ("f5", 63, "F5"),
    ("f6", 64, "F6"),
    ("f7", 65, "F7"),
    ("f8", 66, "F8"),
    ("f9", 67, "F9"),
    ("f10", 68, "F10"),
    ("f11", 87, "F11"),
    ("f12", 88, "F12"),
];

/// The evdev keycode of a key name `keys` parses, or none for a name the built-in US layout has no
/// key for (the caller names it in the error).
pub(crate) fn key_evdev(name: &str) -> Option<u32> {
    if let Some((_, evdev, _)) = NAMED.iter().find(|(known, _, _)| *known == name) {
        return Some(*evdev);
    }
    // A layout key is named by the character it types (`a`), or, for the key whose keysym is a
    // word, by that keysym (`space`).
    let mut chars = name.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => LAYOUT.iter().find(|key| key.unshifted.1 == c).map(|key| key.evdev),
        _ => LAYOUT.iter().find(|key| key.unshifted.0 == name).map(|key| key.evdev),
    }
}

/// The evdev keycode that types `c` on the built-in US layout and whether it needs Shift held, or
/// none when the layout cannot produce the character.
pub(crate) fn char_key(c: char) -> Option<(u32, bool)> {
    // A tab is the Tab key, not a layout character; chunks split newlines out before posting.
    if c == '\t' {
        return key_evdev("tab").map(|evdev| (evdev, false));
    }
    LAYOUT.iter().find_map(|key| {
        if key.unshifted.1 == c {
            Some((key.evdev, false))
        } else if key.shifted.1 == c {
            Some((key.evdev, true))
        } else {
            None
        }
    })
}

/// The characters of `chunk` the built-in US layout cannot type, each once, in the order they
/// appear, so the error can name all of them.
fn untypeable(chunk: &str) -> Vec<char> {
    let mut missing = Vec::new();
    for c in chunk.chars() {
        if char_key(c).is_none() && !missing.contains(&c) {
            missing.push(c);
        }
    }
    missing
}

/// Why typing stopped: the keymap cannot produce these characters, and skipping them silently
/// would tell the app something other than what was asked for.
fn untypeable_error(missing: &[char]) -> String {
    let quoted: Vec<String> = missing.iter().map(|c| format!("`{}`", c.escape_debug())).collect();
    let (last, rest) = quoted.split_last().expect("the error names at least one character");
    let names = if rest.is_empty() { last.clone() } else { format!("{} and {last}", rest.join(", ")) };
    let pronoun = if quoted.len() == 1 { "it" } else { "them" };
    format!(
        "cannot type {names}: the Linux virtual keyboard uploads a built-in US keymap, which cannot \
         produce {pronoun}, so nothing was sent"
    )
}

/// The keymap every device uploads before its first key event (`zwp_virtual_keyboard_v1.keymap`,
/// format XKB_V1): the built-in US layout above at its XKB keycodes, with the system's standard
/// types and compatibility rules, so the modifier keys set the real Control/Shift/Mod1 masks and
/// both levels of every printable key work. The user's own layout is not read yet (T2's
/// limitation, odd/tasks/linux-input-control.md T4).
pub(crate) fn default_keymap() -> String {
    let mut keycodes = String::new();
    let mut symbols = String::new();
    let mut declare = |evdev: u32, levels: &[&str]| {
        keycodes.push_str(&format!("    <K{evdev}> = {};\n", evdev + XKB_KEYCODE_OFFSET));
        let kind = if levels.len() == 1 { "ONE_LEVEL" } else { "TWO_LEVEL" };
        symbols.push_str(&format!(
            "    key <K{evdev}> {{ type[Group1]=\"{kind}\", symbols[Group1] = [ {} ] }};\n",
            levels.join(", ")
        ));
    };
    for key in LAYOUT {
        declare(key.evdev, &[key.unshifted.0, key.shifted.0]);
    }
    for (_, evdev, keysym) in NAMED {
        declare(*evdev, &[keysym]);
    }
    let modifiers = [
        ("Control_L", EVDEV_CONTROL, "Control"),
        ("Shift_L", EVDEV_SHIFT, "Shift"),
        ("Alt_L", EVDEV_ALT, "Mod1"),
    ];
    for (keysym, evdev, _) in modifiers {
        declare(evdev, &[keysym]);
    }
    let modifier_maps: String =
        modifiers.iter().map(|(_, evdev, mask)| format!("    modifier_map {mask} {{ <K{evdev}> }};\n")).collect();
    format!(
        "xkb_keymap {{\n  xkb_keycodes \"gentle-dot\" {{\n    minimum = 8;\n    maximum = 255;\n{keycodes}  }};\n  \
         xkb_types \"gentle-dot\" {{ include \"complete\" }};\n  \
         xkb_compatibility \"gentle-dot\" {{ include \"complete\" }};\n  \
         xkb_symbols \"gentle-dot\" {{\n{symbols}{modifier_maps}  }};\n}};\n"
    )
}

/// One request a `zwp_virtual_keyboard_v1` sends, in the order the plan sends them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyboardAction {
    /// `modifiers`: every XKB modifier mask the plan holds down, the way `wl_keyboard.modifiers`
    /// reports it. Zero releases them all.
    Modifiers { depressed: u32 },
    /// `key`: an evdev keycode and whether it goes down. 1 is pressed and 0 released.
    Key { evdev: u32, down: bool },
}

/// What one keyboard post sends: the keymap the device uploads before any key event, and the
/// requests that post the event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KeyboardPlan {
    pub keymap: String,
    pub actions: Vec<KeyboardAction>,
}

/// The modifier keys `combo` holds with the masks they set, in the order the other platforms press
/// them: cmd's Ctrl, then Shift, Alt, and Ctrl again when it is not cmd's. `fn` has no Linux key.
fn held_modifiers(combo: &KeyCombo) -> Result<Vec<(u32, u32)>, String> {
    let m = combo.modifiers;
    if m.fn_key {
        return Err(format!("`fn` has no Linux key, so `{}` cannot be pressed", combo.key));
    }
    Ok([
        (m.cmd, (EVDEV_CONTROL, MOD_CONTROL)),
        (m.shift, (EVDEV_SHIFT, MOD_SHIFT)),
        (m.alt, (EVDEV_ALT, MOD_ALT)),
        (m.ctrl && !m.cmd, (EVDEV_CONTROL, MOD_CONTROL)),
    ]
    .into_iter()
    .filter_map(|(on, key)| on.then_some(key))
    .collect())
}

/// The requests that post a key or a chunk of text, in order, with the keymap they need. Keys and
/// text are the only events here: the pointer plan posts the rest.
pub(crate) fn keyboard_plan(event: &InputEvent) -> Result<KeyboardPlan, String> {
    let mut actions = Vec::new();
    match event {
        InputEvent::Key(combo) => {
            let held = held_modifiers(combo)?;
            let evdev = key_evdev(combo.key)
                .ok_or_else(|| format!("`{}` has no Linux key, so nothing was sent", combo.key))?;
            let depressed = held.iter().map(|(_, mask)| *mask).sum::<u32>();
            // The other platforms hold the modifiers around the key; the modifier state goes out
            // before anything the compositor resolves with it, and comes back to zero at the end
            // so no modifier outlives the post.
            actions.extend(held.iter().map(|(evdev, _)| KeyboardAction::Key { evdev: *evdev, down: true }));
            if depressed != 0 {
                actions.push(KeyboardAction::Modifiers { depressed });
            }
            actions.push(KeyboardAction::Key { evdev, down: true });
            actions.push(KeyboardAction::Key { evdev, down: false });
            actions.extend(held.iter().rev().map(|(evdev, _)| KeyboardAction::Key { evdev: *evdev, down: false }));
            if depressed != 0 {
                actions.push(KeyboardAction::Modifiers { depressed: 0 });
            }
        }
        InputEvent::Text(chunk) => {
            let missing = untypeable(chunk);
            if !missing.is_empty() {
                return Err(untypeable_error(&missing));
            }
            // Shift is held across a run of characters that need it, and only toggled when the
            // next character needs the other level, so a capitalised word is one Shift press.
            let mut shift = false;
            for c in chunk.chars() {
                let (evdev, needs_shift) = char_key(c).ok_or_else(|| untypeable_error(&[c]))?;
                if needs_shift != shift {
                    actions.push(KeyboardAction::Key { evdev: EVDEV_SHIFT, down: needs_shift });
                    actions.push(KeyboardAction::Modifiers { depressed: if needs_shift { MOD_SHIFT } else { 0 } });
                    shift = needs_shift;
                }
                actions.push(KeyboardAction::Key { evdev, down: true });
                actions.push(KeyboardAction::Key { evdev, down: false });
            }
            if shift {
                actions.push(KeyboardAction::Key { evdev: EVDEV_SHIFT, down: false });
                actions.push(KeyboardAction::Modifiers { depressed: 0 });
            }
        }
        other => return Err(format!("{other:?} is not a keyboard event: the pointer plan posts it")),
    }
    Ok(KeyboardPlan { keymap: default_keymap(), actions })
}

/// What a virtual keyboard device accepts. `wayland` implements it for the real
/// `zwp_virtual_keyboard_v1`; the tests record the requests instead of sending them.
pub(crate) trait KeyboardSink {
    /// `keymap`: the XKB description this device resolves the keycodes below against. The protocol
    /// refuses key events before it, so a device is always handed it before its first key.
    fn upload_keymap(&mut self, keymap: &str) -> Result<(), String>;
    /// Hands the uploaded keymap to the compositor and reads its replies, so the compositor has
    /// applied the keymap before the first key event arrives. Hyprland 0.56.2 (live-verified)
    /// silently drops key events that arrive in the same batch of messages as their keymap, and
    /// wtype, which types fine there, roundtrips between the two for exactly this reason. A fake
    /// sink has no compositor to settle with, so it does nothing.
    fn settle(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn key(&mut self, evdev: u32, down: bool) -> Result<(), String>;
    fn modifiers(&mut self, depressed: u32) -> Result<(), String>;
    /// Makes the queued requests reach the compositor.
    fn flush(&mut self) -> Result<(), String>;
}

/// The plan's key and modifier requests, in order, and the flush that makes them reach the
/// compositor.
fn send_actions_and_flush(plan: &KeyboardPlan, sink: &mut impl KeyboardSink) -> Result<(), String> {
    send_actions(plan, sink)?;
    sink.flush()
}

/// What one virtual input device accepts besides keys: the pointer requests of a pointer post
/// (`super::execute`). The virtual pointer and the virtual keyboard live on the same Wayland
/// connection, so they are the same device here.
pub(crate) trait InputDevice: KeyboardSink {
    /// The `zwlr_virtual_pointer_v1` requests of `actions`, in order, in `screen`'s pixel space.
    fn send_pointer(&self, actions: &[PointerAction], screen: &VirtualScreen) -> Result<(), String>;
}

/// The one virtual input device this app keeps for its whole session, the way wtype keeps its
/// device until the process exits.
///
/// Every post used to create its own connection, virtual pointer and virtual keyboard and destroy
/// them milliseconds after the flush. Hyprland 0.56.2 (live-verified, odd/tasks/linux-input-control.md
/// L7) then dropped the events of those destroyed-at-once devices: the text of "ab" arrived but
/// the Return posted right after it never did, the last post of a run lost its keys, one run
/// delivered nothing, another delivered seconds late, and a pointer move was swallowed too. One
/// device, opened lazily by the first post and reused by every later one, delivered every pointer
/// move and every key post in tens of milliseconds (five consecutive live runs, 3 runs of 3 posts
/// in the bisect, and a 3s idle gap).
///
/// Nothing is torn down while the app is running, so a post that fails drops the device instead
/// (destroying both virtual devices, which releases anything they could have left held, held
/// modifier keys and mouse buttons included) and the next post opens a fresh one: the compositor
/// may have restarted, and a device is cheap.
pub(crate) struct InputCache<D: InputDevice> {
    /// None until the first input post, and again after a failed post.
    device: Option<D>,
    /// Whether the kept device already has the keymap its first key post uploads. Reset with the
    /// device, since a fresh keyboard starts with no keymap at all.
    keyboard_ready: bool,
}

impl<D: InputDevice> InputCache<D> {
    pub(crate) const fn new() -> Self {
        Self { device: None, keyboard_ready: false }
    }

    /// Send a pointer post through the kept device, opening it with `open` when there is none.
    pub(crate) fn pointer(
        &mut self,
        actions: &[PointerAction],
        screen: &VirtualScreen,
        open: impl FnOnce() -> Result<D, String>,
    ) -> Result<(), String> {
        let device = self.open(open)?;
        match device.send_pointer(actions, screen) {
            Ok(()) => Ok(()),
            // Dropping the device destroys it, so the next post starts from a known state.
            Err(error) => {
                self.reset();
                Err(error)
            }
        }
    }

    /// Send a key post through the kept device, opening it with `open` when there is none. The
    /// keymap goes out once per device, before its first key event and settled before the first
    /// key arrives; every later post sends only its keys on the device it already has.
    pub(crate) fn keys(
        &mut self,
        plan: &KeyboardPlan,
        open: impl FnOnce() -> Result<D, String>,
    ) -> Result<(), String> {
        let ready = self.keyboard_ready;
        let device = self.open(open)?;
        let result = (|| {
            if !ready {
                device.upload_keymap(&plan.keymap)?;
                device.settle()?;
            }
            send_actions_and_flush(plan, device)
        })();
        match result {
            Ok(()) => {
                self.keyboard_ready = true;
                Ok(())
            }
            Err(error) => {
                self.reset();
                Err(error)
            }
        }
    }

    /// The kept device, opened by `open` when there is none and freshly marked as having no keymap.
    fn open(&mut self, open: impl FnOnce() -> Result<D, String>) -> Result<&mut D, String> {
        if self.device.is_none() {
            self.device = Some(open()?);
            self.keyboard_ready = false;
        }
        Ok(self.device.as_mut().expect("just opened"))
    }

    fn reset(&mut self) {
        self.device = None;
        self.keyboard_ready = false;
    }
}

/// The plan's key and modifier requests, in order, after whatever keymap setup the sender did.
fn send_actions(plan: &KeyboardPlan, sink: &mut impl KeyboardSink) -> Result<(), String> {
    for action in &plan.actions {
        match *action {
            KeyboardAction::Key { evdev, down } => sink.key(evdev, down)?,
            KeyboardAction::Modifiers { depressed } => sink.modifiers(depressed)?,
        }
    }
    Ok(())
}

/// The `wl_seat` version the virtual keyboard binds: wtype's cap, 7. Nothing the keyboard uses
/// came after version 7 (versions 8 and 9 only add pointer and touch capabilities and their
/// shapes), and Hyprland 0.56.2 delivers the same keys with either version (live-verified,
/// odd/tasks/linux-input-control.md L7), so the keyboard asks for no more than wtype does.
pub(crate) const WL_SEAT_VERSION: u32 = 7;

/// The `wl_seat` versions the keyboard accepts: 1 up to `WL_SEAT_VERSION`. Version 1 is the
/// oldest the `create_virtual_keyboard` request needs.
pub(crate) fn seat_versions() -> std::ops::RangeInclusive<u32> {
    1..=WL_SEAT_VERSION
}

/// Execute `plan` through the session's one virtual input device (`InputCache`). Compiled on every
/// OS so the backend's `post` stays whole; only Linux can connect.
pub(crate) fn execute_keyboard(plan: &KeyboardPlan) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        session_input().keys(plan, wayland::Device::open)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = plan;
        Err("virtual keyboard input is Linux only".into())
    }
}

/// The session's one virtual input device, both the pointer and the keyboard: pointer posts and
/// key posts share it, and it lives as long as the process. A poisoned lock is recovered, since
/// the state behind it is one `Option` and a flag.
#[cfg(target_os = "linux")]
fn session_input() -> std::sync::MutexGuard<'static, InputCache<wayland::Device>> {
    static INPUT: std::sync::Mutex<InputCache<wayland::Device>> =
        std::sync::Mutex::new(InputCache::new());
    INPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether this session can create virtual input devices, given the value of `WAYLAND_DISPLAY`
/// (injected, so the rule is testable with no compositor) and a probe of the session compositor.
///
/// The rule (odd/tasks/linux-input-control.md S4): the Linux accessibility answer mirrors "this
/// session can create virtual input devices for the compositor", not a system permission nobody
/// can grant. On a wlroots compositor that is always possible; a compositor without
/// `zwlr_virtual_pointer_manager_v1` (GNOME, KDE) needs the RemoteDesktop portal instead (S3), so
/// input is not available there and the answer is false. Nothing is loosened by it: the shared
/// gates (session grant, working rings, blocklist, risk check) stay exactly as they are, and this
/// only says whether acting on the screen can work at all.
pub(crate) fn virtual_input_supported(
    wayland_display: Option<&std::ffi::OsStr>,
    probe: impl FnOnce() -> Result<(), String>,
) -> bool {
    // `Device::open` refuses before touching a display when the session is not Wayland, so the
    // probe is never asked: nothing is connected and nothing is cached.
    wayland_display.is_some() && probe().is_ok()
}

/// `virtual_input_supported` for the session the app runs in: the environment's `WAYLAND_DISPLAY`
/// and, only when it is set, the compositor probe. The probe connects once; callers cache the
/// answer (`LinuxDesktop::accessibility`), so a tool call never pays for it twice.
pub(crate) fn probe_virtual_input() -> bool {
    virtual_input_supported(std::env::var_os("WAYLAND_DISPLAY").as_deref(), probe_compositor)
}

/// The compositor probe itself, which only Linux has a display for.
fn probe_compositor() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        wayland::probe()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("virtual input is Linux only".into())
    }
}

/// Why the compositor cannot take virtual input: `what` names the action in the error the caller
/// sees ("move the pointer" or "press keys"). Pure, so the wording is pinned on every OS; the
/// capability probe and `connect` both word the missing protocol this way.
fn no_pointer_manager(what: &str) -> String {
    format!("cannot {what}: the compositor has no zwlr_virtual_pointer_manager_v1 (Hyprland and other wlroots compositors have it; GNOME and KDE do not, so they would need the RemoteDesktop portal, odd/tasks/linux-input-control.md S3)")
}

/// The Wayland side: connecting to the session compositor, binding the virtual pointer and
/// keyboard managers and turning each plan into requests. The pointer device stays per-post; the
/// keyboard device is kept alive across posts (`super::KeyboardCache`). It has no pure part and is
/// exercised live on Hyprland only (odd/tasks/linux-input-control.md S5, T4); everything it must
/// get right lives in the plans above, which the tests cover on every OS.
#[cfg(target_os = "linux")]
mod wayland {
    use super::{
        no_pointer_manager, seat_versions, InputDevice, KeyboardSink, MouseButton, PointerAction, VirtualScreen,
    };
    use std::io::{Seek, SeekFrom, Write};
    use std::os::fd::{AsFd, FromRawFd, OwnedFd};
    use std::sync::OnceLock;
    use std::time::Instant;
    use wayland_client::{
        globals::{registry_queue_init, GlobalList, GlobalListContents},
        protocol::{wl_pointer, wl_registry, wl_seat},
        Connection, Dispatch, EventQueue, Proxy, QueueHandle,
    };
    use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::{
        zwp_virtual_keyboard_manager_v1::{Event as KeyboardManagerEvent, ZwpVirtualKeyboardManagerV1},
        zwp_virtual_keyboard_v1::{Event as KeyboardEvent, ZwpVirtualKeyboardV1},
    };
    use wayland_protocols_wlr::virtual_pointer::v1::client::{
        zwlr_virtual_pointer_manager_v1::{Event as ManagerEvent, ZwlrVirtualPointerManagerV1},
        zwlr_virtual_pointer_v1::{Event as PointerEvent, ZwlrVirtualPointerV1},
    };

    /// The two buttons `MouseButton` has, from linux/input-event-codes.h.
    const BTN_LEFT: u32 = 0x110;
    const BTN_RIGHT: u32 = 0x111;

    /// The one keymap format the protocol defines (`keymap_format`, XKB_V1).
    const KEYMAP_FORMAT_XKB_V1: u32 = 1;

    /// What the dispatch glue needs. Neither wlr interface sends events, the keyboard only reports
    /// its keymap to the seat and errors, and the registry only needs the shape: nothing is
    /// dispatched, since a post is a flush of requests and never reads the socket.
    struct State;

    impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
        fn event(_: &mut Self, _: &wl_registry::WlRegistry, _: wl_registry::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
    }

    impl Dispatch<wl_seat::WlSeat, ()> for State {
        fn event(_: &mut Self, _: &wl_seat::WlSeat, _: wl_seat::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
    }

    impl Dispatch<ZwlrVirtualPointerManagerV1, ()> for State {
        fn event(_: &mut Self, _: &ZwlrVirtualPointerManagerV1, _: ManagerEvent, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
    }

    impl Dispatch<ZwlrVirtualPointerV1, ()> for State {
        fn event(_: &mut Self, _: &ZwlrVirtualPointerV1, _: PointerEvent, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
    }

    impl Dispatch<ZwpVirtualKeyboardManagerV1, ()> for State {
        fn event(_: &mut Self, _: &ZwpVirtualKeyboardManagerV1, _: KeyboardManagerEvent, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
    }

    impl Dispatch<ZwpVirtualKeyboardV1, ()> for State {
        fn event(_: &mut Self, _: &ZwpVirtualKeyboardV1, _: KeyboardEvent, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
    }

    /// Connects to the session compositor and lists its globals, the first step of the device.
    fn list_globals() -> Result<(Connection, EventQueue<State>, GlobalList), String> {
        if std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return Err("cannot send input: this session is not Wayland (WAYLAND_DISPLAY is unset), and the Linux backend drives input through the compositor's Wayland protocols".to_string());
        }
        let connection = Connection::connect_to_env()
            .map_err(|error| format!("cannot connect to the Wayland display: {error}"))?;
        let (globals, event_queue) = registry_queue_init::<State>(&connection)
            .map_err(|error| format!("cannot list the Wayland globals: {error}"))?;
        Ok((connection, event_queue, globals))
    }

    /// The session's virtual input device: one connection, the virtual pointer every pointer post
    /// needs, and, when the compositor has them, the seat and manager (and with them the device)
    /// the virtual keyboard needs. Dropping it destroys both devices, which releases anything a
    /// failed post could have left held (held keys and mouse buttons included).
    pub(super) struct Device {
        connection: Connection,
        manager: ZwlrVirtualPointerManagerV1,
        pointer: ZwlrVirtualPointerV1,
        /// None when the compositor has no virtual keyboard: the pointer still works, and only
        /// pressing a key reports what is missing (with or without a seat).
        keyboard_manager: Option<ZwpVirtualKeyboardManagerV1>,
        /// None when the compositor has no keyboard globals (see `keyboard_manager`).
        keyboard: Option<VirtualKeyboard>,
        /// The queue the objects live in, kept alive for the whole session: a queue that goes away
        /// takes its objects, and the requests flushed through them, with it. `settle` roundtrips
        /// on it to make the compositor apply the keymap.
        event_queue: EventQueue<State>,
    }

    impl Device {
        /// Open the connection and create both virtual devices, the one device this app keeps.
        pub(super) fn open() -> Result<Self, String> {
            let (connection, event_queue, globals) = list_globals()?;
            let handle = event_queue.handle();
            let manager: ZwlrVirtualPointerManagerV1 =
                globals.bind(&handle, 1..=2, ()).map_err(|_| no_pointer_manager("send input"))?;
            let pointer = manager.create_virtual_pointer(None, &handle, ());
            let keyboard_manager = globals.bind(&handle, 1..=1, ()).ok();
            let seat = globals.bind(&handle, seat_versions(), ()).ok();
            let keyboard = match (keyboard_manager.as_ref(), seat.as_ref()) {
                (Some(manager), Some(seat)) => Some(VirtualKeyboard::create(manager, seat, &handle)),
                _ => None,
            };
            connection
                .flush()
                .map_err(|error| format!("cannot create the virtual input device: {error}"))?;
            Ok(Self { connection, manager, pointer, keyboard_manager, keyboard, event_queue })
        }

        /// The virtual keyboard, or why the compositor cannot take keys.
        fn keyboard_mut(&mut self) -> Result<&mut VirtualKeyboard, String> {
            if self.keyboard_manager.is_none() {
                return Err(no_keyboard_manager());
            }
            self.keyboard.as_mut().ok_or_else(no_seat)
        }
    }

    /// Whether the session compositor advertises the virtual pointer manager, which every post of
    /// this backend needs: the whole check of a Wayland session's input capability
    /// (`super::probe_virtual_input`). Nothing is created, so nothing is left behind, and the probe
    /// answers in one roundtrip: the caller caches it.
    pub(super) fn probe() -> Result<(), String> {
        let connection = Connection::connect_to_env()
            .map_err(|error| format!("cannot connect to the Wayland display: {error}"))?;
        let (globals, _queue) = registry_queue_init::<State>(&connection)
            .map_err(|error| format!("cannot list the Wayland globals: {error}"))?;
        let has_pointer_manager = globals
            .contents()
            .clone_list()
            .iter()
            .any(|global| global.interface == "zwlr_virtual_pointer_manager_v1");
        if !has_pointer_manager {
            return Err(no_pointer_manager("move the pointer"));
        }
        Ok(())
    }

    impl InputDevice for Device {
        fn send_pointer(&self, actions: &[PointerAction], screen: &VirtualScreen) -> Result<(), String> {
            let (width, height) = screen.pixel_size();
            for action in actions {
                match *action {
                    PointerAction::Move { x, y } => {
                        self.pointer.motion_absolute(now_ms(), x.max(0) as u32, y.max(0) as u32, width, height)
                    }
                    PointerAction::Button { button, down } => self.pointer.button(
                        now_ms(),
                        match button {
                            MouseButton::Left => BTN_LEFT,
                            MouseButton::Right => BTN_RIGHT,
                        },
                        if down { wl_pointer::ButtonState::Pressed } else { wl_pointer::ButtonState::Released },
                    ),
                    PointerAction::Axis { horizontal, value } => self.pointer.axis(
                        now_ms(),
                        if horizontal { wl_pointer::Axis::HorizontalScroll } else { wl_pointer::Axis::VerticalScroll },
                        value,
                    ),
                }
            }
            // One post is one logical pointer event sequence: version 2 compositors apply it
            // once they see the frame, and version 1 ones have no frame to wait for.
            if self.pointer.version() >= 2 {
                self.pointer.frame();
            }
            self.connection
                .flush()
                .map_err(|error| format!("cannot send pointer input to the compositor: {error}"))
        }
    }

    impl Drop for Device {
        fn drop(&mut self) {
            self.pointer.destroy();
            self.manager.destroy();
            // The keyboard manager has no destroy request: only the device does, and destroying it
            // is what releases anything it still held.
            if let Some(keyboard) = self.keyboard.as_mut() {
                keyboard.destroy();
            }
            let _ = self.connection.flush();
        }
    }

    /// Why the compositor cannot take keys, worded once so every post reports it the same way.
    fn no_keyboard_manager() -> String {
        "cannot press keys: the compositor has no zwp_virtual_keyboard_manager_v1 (Hyprland and other wlroots compositors have it; GNOME and KDE do not, so they would need the RemoteDesktop portal, odd/tasks/linux-input-control.md S3)".to_string()
    }

    fn no_seat() -> String {
        "cannot press keys: the compositor offers no wl_seat for the virtual keyboard to attach to".to_string()
    }

    impl KeyboardSink for Device {
        fn upload_keymap(&mut self, keymap: &str) -> Result<(), String> {
            self.keyboard_mut()?.upload_keymap(keymap)
        }

        /// Flush and read the compositor's replies, so it applies the keymap before the first key
        /// event: Hyprland 0.56.2 (live-verified) silently drops key events that arrive in the
        /// same batch of messages as their keymap, and wtype, which types fine there, roundtrips
        /// between the two for exactly this reason.
        fn settle(&mut self) -> Result<(), String> {
            self.event_queue
                .roundtrip(&mut State)
                .map(|_| ())
                .map_err(|error| format!("cannot settle the keymap with the compositor: {error}"))
        }

        fn key(&mut self, evdev: u32, down: bool) -> Result<(), String> {
            self.keyboard_mut()?.key(evdev, down)
        }

        fn modifiers(&mut self, depressed: u32) -> Result<(), String> {
            self.keyboard_mut()?.modifiers(depressed)
        }

        fn flush(&mut self) -> Result<(), String> {
            self.connection
                .flush()
                .map_err(|error| format!("cannot send key input to the compositor: {error}"))
        }
    }

    /// A `zwp_virtual_keyboard_v1` on the session's compositor, plus the file its keymap lives in.
    pub(super) struct VirtualKeyboard {
        keyboard: ZwpVirtualKeyboardV1,
        /// The keymap file has to outlive the flush that sends its descriptor.
        keymap: Option<OwnedFd>,
    }

    impl VirtualKeyboard {
        fn create(
            manager: &ZwpVirtualKeyboardManagerV1,
            seat: &wl_seat::WlSeat,
            handle: &QueueHandle<State>,
        ) -> Self {
            Self { keyboard: manager.create_virtual_keyboard(seat, handle, ()), keymap: None }
        }

        fn upload_keymap(&mut self, keymap: &str) -> Result<(), String> {
            // xkbcommon reads the keymap as a NUL-terminated string, so the file ends in one and
            // the size the compositor maps counts it.
            let mut bytes = keymap.as_bytes().to_vec();
            bytes.push(0);
            let mut file = memfd()?;
            file.write_all(&bytes).map_err(|error| format!("cannot write the keymap: {error}"))?;
            file.seek(SeekFrom::Start(0)).map_err(|error| format!("cannot rewind the keymap: {error}"))?;
            self.keyboard.keymap(KEYMAP_FORMAT_XKB_V1, file.as_fd(), bytes.len() as u32);
            self.keymap = Some(file.into());
            Ok(())
        }

        fn key(&mut self, evdev: u32, down: bool) -> Result<(), String> {
            self.keyboard.key(now_ms(), evdev, u32::from(down));
            Ok(())
        }

        fn modifiers(&mut self, depressed: u32) -> Result<(), String> {
            // Nothing is ever latched, locked, or on another group: this keymap has one group and
            // the plan releases every key it presses.
            self.keyboard.modifiers(depressed, 0, 0, 0);
            Ok(())
        }

        fn destroy(&mut self) {
            self.keyboard.destroy();
        }
    }

    /// The file the keymap is sent through: an anonymous memory file, gone once the descriptor
    /// closes, so nothing is left on disk.
    fn memfd() -> Result<std::fs::File, String> {
        let name = std::ffi::CString::new("gentle-dot-keymap").expect("the memfd name has no NUL");
        // SAFETY: the name is a valid C string and the flags are constants.
        let fd = unsafe { libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC) };
        if fd < 0 {
            return Err(format!("cannot create the keymap file: {}", std::io::Error::last_os_error()));
        }
        // SAFETY: `fd` is a fresh descriptor that nothing else owns.
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    /// Milliseconds since the process started, the monotonic stamp the protocol asks for.
    fn now_ms() -> u32 {
        static START: OnceLock<Instant> = OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_millis() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::keys::{names, parse_combo};

    /// One 1920 × 1080 monitor at the origin, as `hyprctl monitors -j` reports it.
    const SINGLE: &str = r#"[{"id":0,"name":"DP-1","width":1920,"height":1080,"x":0,"y":0,"scale":1.0,"focused":true}]"#;

    /// Two monitors: a 2560 × 1440 at 1x, and a 1920 × 1080 at 2x up and to its left.
    const TWO: &str = r#"[
        {"id":0,"name":"DP-1","width":2560,"height":1440,"x":0,"y":0,"scale":1.0,"focused":true},
        {"id":1,"name":"HDMI-A-1","width":1920,"height":1080,"x":-1920,"y":-200,"scale":2.0,"focused":false}
    ]"#;

    fn at(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn single() -> VirtualScreen {
        virtual_screen(SINGLE).unwrap()
    }

    fn plan(event: InputEvent) -> Vec<PointerAction> {
        pointer_plan(&event, &single()).unwrap()
    }

    fn left(down: bool) -> PointerAction {
        PointerAction::Button { button: MouseButton::Left, down }
    }

    fn moved(x: i32, y: i32) -> PointerAction {
        PointerAction::Move { x, y }
    }

    #[test]
    fn a_move_is_one_absolute_move_in_pixels() {
        assert_eq!(plan(InputEvent::Move(at(10.0, 20.0))), [moved(10, 20)]);
    }

    #[test]
    fn a_click_moves_then_presses_and_releases_once_per_count() {
        let click = |button, count| InputEvent::Click { at: at(100.0, 200.0), button, count };
        assert_eq!(plan(click(MouseButton::Left, 1)), [moved(100, 200), left(true), left(false)]);
        // A count above one is that many press/release pairs, as on the other platforms.
        assert_eq!(
            plan(click(MouseButton::Left, 3)),
            [moved(100, 200), left(true), left(false), left(true), left(false), left(true), left(false)]
        );
        let right = |down| PointerAction::Button { button: MouseButton::Right, down };
        assert_eq!(plan(click(MouseButton::Right, 1)), [moved(100, 200), right(true), right(false)]);
    }

    #[test]
    fn a_drag_presses_at_the_start_visits_drag_steps_points_and_releases_at_the_end() {
        let drag = plan(InputEvent::Drag { from: at(0.0, 0.0), to: at(120.0, 240.0) });
        assert_eq!(drag.len(), 2 + DRAG_STEPS as usize + 1);
        assert_eq!(drag[0], moved(0, 0));
        assert_eq!(drag[1], left(true));
        let steps: Vec<PointerAction> =
            (1..=DRAG_STEPS).map(|step| moved((10 * step) as i32, (20 * step) as i32)).collect();
        assert_eq!(drag[2..2 + DRAG_STEPS as usize], steps[..]);
        assert_eq!(drag[drag.len() - 1], left(false));
    }

    #[test]
    fn scrolling_moves_there_and_turns_pixels_into_wheel_notches() {
        // dy > 0 scrolls down: positive vertical axis units, 100 pixels = 100 * 120 / 50 = 240.
        assert_eq!(
            plan(InputEvent::Scroll { at: at(50.0, 60.0), dx: 0, dy: 100 }),
            [moved(50, 60), PointerAction::Axis { horizontal: false, value: 240.0 }]
        );
        // A negative dy scrolls up, and a positive dx scrolls right.
        assert_eq!(
            plan(InputEvent::Scroll { at: at(50.0, 60.0), dx: 25, dy: -50 }),
            [
                moved(50, 60),
                PointerAction::Axis { horizontal: false, value: -120.0 },
                PointerAction::Axis { horizontal: true, value: 60.0 },
            ]
        );
    }

    #[test]
    fn one_notch_of_scroll_is_the_wheel_delta() {
        assert_eq!(
            plan(InputEvent::Scroll { at: at(0.0, 0.0), dx: 0, dy: PIXELS_PER_NOTCH })[1],
            PointerAction::Axis { horizontal: false, value: f64::from(WHEEL_DELTA) }
        );
        assert_eq!(
            plan(InputEvent::Scroll { at: at(0.0, 0.0), dx: -PIXELS_PER_NOTCH, dy: 0 })[1],
            PointerAction::Axis { horizontal: true, value: -f64::from(WHEEL_DELTA) }
        );
    }

    #[test]
    fn a_tiny_scroll_still_turns_the_wheel() {
        assert_eq!(plan(InputEvent::Scroll { at: at(0.0, 0.0), dx: 0, dy: 1 })[1], PointerAction::Axis { horizontal: false, value: 2.0 });
        assert_eq!(plan(InputEvent::Scroll { at: at(0.0, 0.0), dx: 0, dy: -1 })[1], PointerAction::Axis { horizontal: false, value: -2.0 });
        // No scroll at all is no axis request, only the move.
        assert_eq!(plan(InputEvent::Scroll { at: at(0.0, 0.0), dx: 0, dy: 0 }), [moved(0, 0)]);
    }

    #[test]
    fn moves_outside_the_virtual_screen_are_clamped_to_its_edges() {
        let screen = single();
        assert_eq!(screen.move_to(at(-50.0, -50.0)), moved(0, 0));
        assert_eq!(screen.move_to(at(9999.0, 9999.0)), moved(1920, 1080));
        assert_eq!(screen.move_to(at(5000.0, 10.0)), moved(1920, 10));
    }

    #[test]
    fn the_virtual_screen_is_the_box_of_every_monitor_in_pixels() {
        let screen = virtual_screen(TWO).unwrap();
        assert_eq!(screen.origin, at(-1920.0, -200.0));
        assert_eq!((screen.width_pt, screen.height_pt), (4480.0, 1640.0));
        assert_eq!(screen.pixels_per_point, 2.0);
        // 4480 points × 2 = 8960 pixels wide, 1640 × 2 = 3280 high.
        assert_eq!(screen.pixel_size(), (8960, 3280));
    }

    #[test]
    fn points_map_to_pixels_over_the_whole_virtual_screen() {
        let screen = virtual_screen(TWO).unwrap();
        assert_eq!(screen.move_to(at(-1920.0, -200.0)), moved(0, 0));
        // The primary monitor's corner sits inside the box, scaled by the 2x monitor's scale.
        assert_eq!(screen.move_to(at(0.0, 0.0)), moved(3840, 400));
        // The far corner is the extent itself; `motion_absolute` includes it.
        assert_eq!(screen.move_to(at(2560.0, 1440.0)), moved(8960, 3280));
        assert_eq!(screen.move_to(at(-5000.0, 9000.0)), moved(0, 3280));
    }

    #[test]
    fn the_virtual_screen_needs_parsable_monitors() {
        assert!(virtual_screen("not json").is_err());
        assert!(virtual_screen("{}").is_err());
        assert!(virtual_screen("[]").is_err());
        assert!(virtual_screen(r#"[{"x":0,"y":0,"height":1080,"scale":1.0}]"#).is_err());
        // Hyprland always reports a scale; without one a monitor is one point per pixel.
        let unscaled = virtual_screen(r#"[{"x":0,"y":0,"width":1920,"height":1080}]"#).unwrap();
        assert_eq!(unscaled.pixels_per_point, 1.0);
        assert_eq!(unscaled.pixel_size(), (1920, 1080));
    }

    #[test]
    fn keys_and_text_are_not_pointer_actions() {
        let screen = single();
        for event in [InputEvent::Key(parse_combo("ctrl+a").unwrap()), InputEvent::Text("hi".into())] {
            let error = pointer_plan(&event, &screen).unwrap_err();
            assert!(error.contains("keyboard"), "{error}");
        }
    }

    fn down(evdev: u32) -> KeyboardAction {
        KeyboardAction::Key { evdev, down: true }
    }

    fn up(evdev: u32) -> KeyboardAction {
        KeyboardAction::Key { evdev, down: false }
    }

    fn held(depressed: u32) -> KeyboardAction {
        KeyboardAction::Modifiers { depressed }
    }

    fn actions(event: InputEvent) -> Vec<KeyboardAction> {
        keyboard_plan(&event).unwrap().actions
    }

    #[test]
    fn every_key_the_parser_accepts_has_an_evdev_keycode() {
        for name in names() {
            assert!(key_evdev(name).is_some(), "{name} has no evdev keycode");
        }
        assert_eq!(key_evdev("hyper"), None);
        // linux/input-event-codes.h, spot checked: letters, digits, Return, the navigation block
        // and F12, and macOS's delete, which is Backspace.
        for (name, evdev) in [
            ("a", 30),
            ("1", 2),
            ("return", 28),
            ("delete", 14),
            ("forwarddelete", 111),
            ("left", 105),
            ("pageup", 104),
            ("f12", 88),
        ] {
            assert_eq!(key_evdev(name), Some(evdev), "{name}");
        }
    }

    #[test]
    fn the_keymap_declares_every_key_at_its_xkb_keycode() {
        let keymap = default_keymap();
        // The keymap's keycodes are evdev + 8: `q` is evdev 16, keycode 24.
        assert!(keymap.contains("<K16> = 24;"), "{keymap}");
        for name in names() {
            let evdev = key_evdev(name).unwrap_or_else(|| panic!("{name} has no evdev keycode"));
            assert!(
                keymap.contains(&format!("<K{evdev}> = {};", evdev + XKB_KEYCODE_OFFSET)),
                "{name}: no keycode {}",
                evdev + XKB_KEYCODE_OFFSET
            );
            assert!(keymap.contains(&format!("key <K{evdev}> {{")), "{name}: no symbols for evdev {evdev}");
        }
        // The modifier keys and the maps that turn them into real modifiers, and the standard
        // types and compatibility rules the two levels and the modifier masks come from.
        for (keysym, evdev, mask) in [
            ("Control_L", EVDEV_CONTROL, "Control"),
            ("Shift_L", EVDEV_SHIFT, "Shift"),
            ("Alt_L", EVDEV_ALT, "Mod1"),
        ] {
            assert!(keymap.contains(&format!("[ {keysym} ]")), "{keysym}");
            assert!(keymap.contains(&format!("modifier_map {mask} {{ <K{evdev}> }};")), "{mask}");
        }
        for section in ["xkb_keycodes", "xkb_types", "xkb_compatibility", "xkb_symbols"] {
            assert!(keymap.contains(section), "{section}");
        }
        assert!(keymap.contains("xkb_types \"gentle-dot\" { include \"complete\" }"));
    }

    #[test]
    fn the_modifier_masks_are_the_ones_the_keymap_sets() {
        // Shift, Control and Mod1 in XKB's bit order, as libxkbcommon reports them for this keymap.
        assert_eq!((MOD_SHIFT, MOD_CONTROL, MOD_ALT), (1, 4, 8));
        // A combo holds exactly the masks of its modifier keys.
        let combo = parse_combo("ctrl+alt+shift+a").unwrap();
        let masks: Vec<u32> = held_modifiers(&combo).unwrap().into_iter().map(|(_, mask)| mask).collect();
        assert_eq!(masks, [MOD_SHIFT, MOD_ALT, MOD_CONTROL]);
    }

    #[test]
    fn a_combo_presses_the_modifiers_around_the_key_and_releases_them_in_reverse() {
        // Ctrl, Shift and Alt are held in the order the other platforms press them, and released
        // latest first, with the modifier state following the keys in both directions.
        assert_eq!(
            actions(InputEvent::Key(parse_combo("ctrl+alt+shift+t").unwrap())),
            [
                down(EVDEV_SHIFT),
                down(EVDEV_ALT),
                down(EVDEV_CONTROL),
                held(MOD_SHIFT | MOD_ALT | MOD_CONTROL),
                down(20),
                up(20),
                up(EVDEV_CONTROL),
                up(EVDEV_ALT),
                up(EVDEV_SHIFT),
                held(0),
            ]
        );
        // cmd is Ctrl, as on Windows, and cmd+ctrl presses it once.
        assert_eq!(
            actions(InputEvent::Key(parse_combo("cmd+shift+t").unwrap())),
            [
                down(EVDEV_CONTROL),
                down(EVDEV_SHIFT),
                held(MOD_CONTROL | MOD_SHIFT),
                down(20),
                up(20),
                up(EVDEV_SHIFT),
                up(EVDEV_CONTROL),
                held(0),
            ]
        );
        assert_eq!(
            actions(InputEvent::Key(parse_combo("alt+f4").unwrap())),
            [down(EVDEV_ALT), held(MOD_ALT), down(62), up(62), up(EVDEV_ALT), held(0)]
        );
        // A key without modifiers presses no modifier and reports no modifier state.
        assert_eq!(actions(InputEvent::Key(parse_combo("return").unwrap())), [down(28), up(28)]);
        assert_eq!(actions(InputEvent::Key(parse_combo("left").unwrap())), [down(105), up(105)]);
    }

    #[test]
    fn fn_has_no_linux_key_and_is_refused() {
        let error = keyboard_plan(&InputEvent::Key(parse_combo("fn+f1").unwrap())).unwrap_err();
        assert!(error.contains("fn"), "{error}");
    }

    #[test]
    fn text_types_each_character_with_shift_only_where_the_layout_needs_it() {
        assert_eq!(
            actions(InputEvent::Text("aA1!".into())),
            [
                down(30),
                up(30),
                // A is the same key with Shift, and the layout reports it as such.
                down(EVDEV_SHIFT),
                held(MOD_SHIFT),
                down(30),
                up(30),
                // 1 drops Shift again, ! asks for it back.
                up(EVDEV_SHIFT),
                held(0),
                down(2),
                up(2),
                down(EVDEV_SHIFT),
                held(MOD_SHIFT),
                down(2),
                up(2),
                up(EVDEV_SHIFT),
                held(0),
            ]
        );
        // Shift is held across a run, so a capitalised word presses it once.
        let caps = actions(InputEvent::Text("AB".into()));
        assert_eq!(caps.iter().filter(|action| **action == down(EVDEV_SHIFT)).count(), 1);
        assert_eq!(caps.iter().filter(|action| **action == up(EVDEV_SHIFT)).count(), 1);
        // Text with no shift at all never touches a modifier.
        let plain = actions(InputEvent::Text("hi there".into()));
        assert_eq!(plain.iter().filter(|action| matches!(action, KeyboardAction::Modifiers { .. })).count(), 0);
        // A tab is the Tab key.
        assert_eq!(actions(InputEvent::Text("\t".into())), [down(15), up(15)]);
    }

    #[test]
    fn text_the_us_keymap_cannot_type_names_every_unsupported_character() {
        let error = keyboard_plan(&InputEvent::Text("aé🦀é".into())).unwrap_err();
        assert!(error.contains('é'), "{error}");
        assert!(error.contains('🦀'), "{error}");
        // Once each, however often the character appears, and never the typeable ones.
        assert_eq!(error.matches('é').count(), 1, "{error}");
        assert!(!error.contains("`a`"), "{error}");
        assert!(error.contains("US keymap"), "{error}");
        // A single character is named on its own.
        let error = keyboard_plan(&InputEvent::Text("é".into())).unwrap_err();
        assert!(error.contains("cannot type `é`:"), "{error}");
    }

    #[test]
    fn the_us_layout_types_every_printable_ascii_character_on_one_key() {
        for c in ' '..='~' {
            let (evdev, shift) = char_key(c).unwrap_or_else(|| panic!("{c} is not typeable"));
            let key = LAYOUT.iter().find(|key| key.evdev == evdev).unwrap_or_else(|| panic!("{c} has no key"));
            let level = if shift { key.shifted } else { key.unshifted };
            assert_eq!(level.1, c, "{c} lands on the wrong key");
        }
        assert_eq!(char_key('é'), None);
        assert_eq!(char_key('a'), Some((30, false)));
        assert_eq!(char_key('A'), Some((30, true)));
        assert_eq!(char_key(' '), Some((57, false)));
        assert_eq!(char_key('!'), Some((2, true)));
    }

    /// A keyboard device that records the requests in order, standing in for the compositor.
    /// Clones share the log, so a test sees the requests of every device its cache opened.
    #[derive(Debug, Default, Clone)]
    struct Sent(std::rc::Rc<std::cell::RefCell<Vec<SentRequest>>>);

    #[derive(Debug, Clone, PartialEq)]
    enum SentRequest {
        Keymap(String),
        Settle,
        Key { evdev: u32, down: bool },
        Modifiers(u32),
        Pointer(Vec<PointerAction>),
        Flush,
    }

    impl Sent {
        fn requests(&self) -> Vec<SentRequest> {
            self.0.borrow().clone()
        }

        fn count(&self, wanted: impl Fn(&SentRequest) -> bool) -> usize {
            self.0.borrow().iter().filter(|request| wanted(request)).count()
        }

        fn keymaps(&self) -> usize {
            self.count(|request| matches!(request, SentRequest::Keymap(_)))
        }

        fn settles(&self) -> usize {
            self.count(|request| matches!(request, SentRequest::Settle))
        }

        fn flushes(&self) -> usize {
            self.count(|request| matches!(request, SentRequest::Flush))
        }

        fn keys(&self) -> usize {
            self.count(|request| matches!(request, SentRequest::Key { .. }))
        }

        fn pointers(&self) -> usize {
            self.count(|request| matches!(request, SentRequest::Pointer(_)))
        }

        fn push_pointer(&self, actions: &[PointerAction]) {
            self.0.borrow_mut().push(SentRequest::Pointer(actions.to_vec()));
        }
    }

    impl KeyboardSink for Sent {
        fn upload_keymap(&mut self, keymap: &str) -> Result<(), String> {
            self.0.borrow_mut().push(SentRequest::Keymap(keymap.to_string()));
            Ok(())
        }

        fn settle(&mut self) -> Result<(), String> {
            self.0.borrow_mut().push(SentRequest::Settle);
            Ok(())
        }

        fn key(&mut self, evdev: u32, down: bool) -> Result<(), String> {
            self.0.borrow_mut().push(SentRequest::Key { evdev, down });
            Ok(())
        }

        fn modifiers(&mut self, depressed: u32) -> Result<(), String> {
            self.0.borrow_mut().push(SentRequest::Modifiers(depressed));
            Ok(())
        }

        fn flush(&mut self) -> Result<(), String> {
            self.0.borrow_mut().push(SentRequest::Flush);
            Ok(())
        }
    }

    /// A device that records the requests and fails the next N key, keymap or pointer requests,
    /// the way the real device fails when its compositor connection is gone. Opens are counted so
    /// a test sees how many devices the cache created.
    #[derive(Debug, Clone)]
    struct Flaky {
        sent: Sent,
        opens: std::rc::Rc<std::cell::Cell<usize>>,
        fail_keys: std::rc::Rc<std::cell::Cell<usize>>,
        fail_keymaps: std::rc::Rc<std::cell::Cell<usize>>,
        fail_pointers: std::rc::Rc<std::cell::Cell<usize>>,
    }

    impl Flaky {
        /// The opener every test passes to the cache: one more device.
        fn opener(&self) -> Self {
            self.opens.set(self.opens.get() + 1);
            self.clone()
        }

        fn take(fails: &std::rc::Rc<std::cell::Cell<usize>>, what: &str) -> Result<(), String> {
            if fails.get() == 0 {
                return Ok(());
            }
            fails.set(fails.get() - 1);
            Err(format!("cannot send {what}"))
        }
    }

    impl KeyboardSink for Flaky {
        fn upload_keymap(&mut self, keymap: &str) -> Result<(), String> {
            Self::take(&self.fail_keymaps, "the keymap")?;
            self.sent.upload_keymap(keymap)
        }

        fn settle(&mut self) -> Result<(), String> {
            self.sent.settle()
        }

        fn key(&mut self, evdev: u32, down: bool) -> Result<(), String> {
            Self::take(&self.fail_keys, "a key")?;
            self.sent.key(evdev, down)
        }

        fn modifiers(&mut self, depressed: u32) -> Result<(), String> {
            self.sent.modifiers(depressed)
        }

        fn flush(&mut self) -> Result<(), String> {
            self.sent.flush()
        }
    }

    impl InputDevice for Flaky {
        fn send_pointer(&self, actions: &[PointerAction], _screen: &VirtualScreen) -> Result<(), String> {
            Self::take(&self.fail_pointers, "a pointer action")?;
            self.sent.push_pointer(actions);
            Ok(())
        }
    }

    fn sent(action: KeyboardAction) -> SentRequest {
        match action {
            KeyboardAction::Key { evdev, down } => SentRequest::Key { evdev, down },
            KeyboardAction::Modifiers { depressed } => SentRequest::Modifiers(depressed),
        }
    }

    fn flaky() -> Flaky {
        Flaky {
            sent: Sent::default(),
            opens: std::rc::Rc::new(std::cell::Cell::new(0)),
            fail_keys: std::rc::Rc::new(std::cell::Cell::new(0)),
            fail_keymaps: std::rc::Rc::new(std::cell::Cell::new(0)),
            fail_pointers: std::rc::Rc::new(std::cell::Cell::new(0)),
        }
    }

    fn text_plan() -> KeyboardPlan {
        keyboard_plan(&InputEvent::Text("ab".into())).unwrap()
    }

    #[test]
    fn the_first_key_post_opens_the_device_and_sends_the_keymap_before_any_key() {
        let device = flaky();
        let mut cache = InputCache::new();
        let plan = text_plan();
        cache.keys(&plan, || Ok::<_, String>(device.opener())).unwrap();
        // One device, the keymap first, then the settle that makes the compositor apply it before
        // the first key (Hyprland drops keys batched with their keymap), then the plan's actions.
        let mut expected = vec![SentRequest::Keymap(plan.keymap.clone()), SentRequest::Settle];
        expected.extend(plan.actions.iter().copied().map(sent));
        expected.push(SentRequest::Flush);
        assert_eq!(device.sent.requests(), expected);
        assert_eq!(device.opens.get(), 1);
    }

    #[test]
    fn every_later_key_post_reuses_the_device_and_sends_only_its_keys() {
        let device = flaky();
        let mut cache = InputCache::new();
        let plan = text_plan();
        cache.keys(&plan, || Ok::<_, String>(device.opener())).unwrap();
        let after_first = device.sent.requests().len();
        for _ in 0..2 {
            cache.keys(&plan, || Ok::<_, String>(device.opener())).unwrap();
        }
        // One device for every post, its keymap uploaded and settled once.
        assert_eq!(device.opens.get(), 1, "one device for every post");
        assert_eq!(device.sent.keymaps(), 1, "the keymap goes out once per device");
        assert_eq!(device.sent.settles(), 1, "the settle goes with the keymap");
        assert_eq!(device.sent.flushes(), 3, "every post reaches the compositor");
        assert_eq!(device.sent.keys(), 3 * plan.actions.len(), "every post sends its keys");
        // The second post starts with its first key: no keymap and no settle in between.
        assert!(matches!(device.sent.requests()[after_first], SentRequest::Key { .. }));
    }

    #[test]
    fn a_failed_key_post_drops_the_device_so_the_next_post_opens_a_new_one() {
        let device = flaky();
        // The first device loses its second key: the post fails like a broken connection.
        device.fail_keys.set(1);
        let mut cache = InputCache::new();
        let plan = text_plan();
        let error = cache.keys(&plan, || Ok::<_, String>(device.opener())).unwrap_err();
        assert!(error.contains("cannot send a key"), "{error}");
        // Nothing is flushed after the failure: the error is what the caller sees.
        assert_eq!(device.sent.flushes(), 0);
        // The failed device was dropped, so the next post opens another one and hands it the keymap
        // again: nothing is torn down while the app runs, but a failure starts from a clean state.
        cache.keys(&plan, || Ok::<_, String>(device.opener())).unwrap();
        assert_eq!(device.opens.get(), 2);
        assert_eq!(device.sent.keymaps(), 2);
        assert_eq!(device.sent.flushes(), 1);
    }

    #[test]
    fn the_pointer_and_the_keyboard_share_one_device() {
        // The pointer and the keyboard live on the same connection: a pointer post opens the
        // device and a key post right after it uploads the keymap on that same device.
        let device = flaky();
        let mut cache = InputCache::new();
        let screen = single();
        let move_to = pointer_plan(&InputEvent::Move(at(10.0, 20.0)), &screen).unwrap();
        cache.pointer(&move_to, &screen, || Ok::<_, String>(device.opener())).unwrap();
        cache.keys(&text_plan(), || Ok::<_, String>(device.opener())).unwrap();
        assert_eq!(device.opens.get(), 1, "one device for pointer and keys");
        assert_eq!(device.sent.pointers(), 1);
        assert_eq!(device.sent.keymaps(), 1);
        // The pointer post came first and needed no keymap.
        assert_eq!(device.sent.requests().first(), Some(&SentRequest::Pointer(move_to)));
    }

    #[test]
    fn a_failed_pointer_post_drops_the_device_too() {
        // A drag that fails halfway must not leave the button held on a device the app keeps.
        let device = flaky();
        device.fail_pointers.set(1);
        let mut cache = InputCache::new();
        let screen = single();
        let drag = pointer_plan(&InputEvent::Drag { from: at(0.0, 0.0), to: at(120.0, 240.0) }, &screen).unwrap();
        let error = cache.pointer(&drag, &screen, || Ok::<_, String>(device.opener())).unwrap_err();
        assert!(error.contains("cannot send a pointer action"), "{error}");
        cache.pointer(&drag, &screen, || Ok::<_, String>(device.opener())).unwrap();
        assert_eq!(device.opens.get(), 2);
        assert_eq!(device.sent.pointers(), 1);
    }

    #[test]
    fn a_first_key_post_whose_keymap_fails_keeps_no_device() {
        let device = flaky();
        device.fail_keymaps.set(1);
        let mut cache = InputCache::new();
        let plan = text_plan();
        let error = cache.keys(&plan, || Ok::<_, String>(device.opener())).unwrap_err();
        assert!(error.contains("cannot send the keymap"), "{error}");
        // The keymap never arrived, so no keys were sent and no device was kept: the next post
        // starts over instead of reusing a device with no keymap.
        assert_eq!(device.sent.keys(), 0);
        assert_eq!(device.sent.flushes(), 0);
        cache.keys(&plan, || Ok::<_, String>(device.opener())).unwrap();
        assert_eq!(device.opens.get(), 2);
        assert_eq!(device.sent.flushes(), 1);
    }

    #[test]
    fn the_keyboard_binds_the_seat_at_wtypes_cap_of_version_seven() {
        // wtype caps wl_seat at 7 and delivers; versions 8 and 9 only add pointer and touch
        // capabilities this keyboard never uses (live-verified the same either way, L7).
        assert_eq!(WL_SEAT_VERSION, 7);
        assert_eq!(seat_versions(), 1..=7);
        assert!(!seat_versions().contains(&8));
        assert!(seat_versions().contains(&1));
    }

    /// A Wayland session, as the environment reports it (T1's `connect` reads the same variable).
    fn wayland_session() -> &'static std::ffi::OsStr {
        std::ffi::OsStr::new("wayland-1")
    }

    #[test]
    fn a_compositor_without_the_virtual_pointer_names_the_protocol_and_the_portal() {
        // The capability probe and `connect` share this wording: missing the manager is what makes
        // input unavailable, and the message names the compositors that have it.
        let error = no_pointer_manager("move the pointer");
        assert!(
            error.starts_with("cannot move the pointer: the compositor has no zwlr_virtual_pointer_manager_v1"),
            "{error}"
        );
        assert!(error.contains("Hyprland") && error.contains("RemoteDesktop portal"), "{error}");
        assert!(no_pointer_manager("press keys").starts_with("cannot press keys: "));
    }

    #[test]
    fn virtual_input_needs_a_wayland_session_and_never_probes_another_display_server() {
        // Not a Wayland session: the compositor is not even asked (the probe fails the test if it
        // runs), because `connect` would refuse before touching a display.
        assert!(!virtual_input_supported(None, || panic!("probed without a Wayland display")));
    }

    #[test]
    fn virtual_input_is_available_when_the_compositor_has_the_protocols() {
        assert!(virtual_input_supported(Some(wayland_session()), || Ok(())));
    }

    #[test]
    fn virtual_input_is_unavailable_when_the_compositor_lacks_the_pointer_manager() {
        // GNOME and KDE: the session is Wayland, the virtual pointer manager is not there.
        let error = || Err("the compositor has no zwlr_virtual_pointer_manager_v1".to_string());
        assert!(!virtual_input_supported(Some(wayland_session()), error));
    }

    #[test]
    fn the_probe_without_a_wayland_session_answers_without_a_compositor() {
        // The environment here decides, so only the shape is asserted: no compositor means no
        // input, with no connection attempted and nothing to cache.
        if std::env::var_os("WAYLAND_DISPLAY").is_none() {
            assert!(!probe_virtual_input());
        }
    }
}
