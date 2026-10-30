//! What Windows posts for each input event (S24.2 on Windows), planned as plain steps so the
//! plan is tested on every OS; `win` turns each step into one `SendInput` record.
//!
//! Points are physical pixels of the virtual screen (the app is per-monitor DPI aware), and
//! moves are absolute, normalized to 0..=65535 over that screen. Key names are the ones
//! `keys` parses; `cmd` presses Ctrl, the key Windows shortcuts use where macOS uses ⌘.

use super::coords::Point;
use super::keys::KeyCombo;
use super::{InputEvent, MouseButton};

/// One notch of the mouse wheel (`WHEEL_DELTA`).
pub const WHEEL_DELTA: i32 = 120;
/// The tool scrolls in pixels; Windows scrolls in notches of about three lines.
pub const PIXELS_PER_NOTCH: i32 = 50;
/// Intermediate moves of a drag, as on macOS.
pub const DRAG_STEPS: u32 = 12;

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12;

/// The bounding box of every display, in physical pixels (`SM_*VIRTUALSCREEN`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualScreen {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// An absolute move, normalized to 0..=65535 over the virtual screen.
    Move { x: i32, y: i32 },
    Button { button: MouseButton, down: bool },
    /// Positive vertical deltas scroll up, positive horizontal ones scroll right.
    Wheel { horizontal: bool, delta: i32 },
    /// `extended` marks the keys of the navigation block (arrows, Home, Delete, ...).
    Key { vk: u16, down: bool, extended: bool },
    /// One UTF-16 unit typed as itself, whatever the keyboard layout.
    Unicode { unit: u16, down: bool },
}

impl VirtualScreen {
    /// The absolute move to `at`, clamped to the virtual screen.
    pub fn move_to(&self, at: Point) -> Step {
        let axis = |value: f64, start: i32, length: i32| {
            let span = f64::from((length - 1).max(1));
            ((value - f64::from(start)) * 65535.0 / span).round().clamp(0.0, 65535.0) as i32
        };
        Step::Move { x: axis(at.x, self.x, self.width), y: axis(at.y, self.y, self.height) }
    }
}

/// The virtual-key code of a key name `keys` knows, and whether it is an extended key.
/// Punctuation uses the US layout, as `keys` uses the ANSI one.
pub fn virtual_key(name: &str) -> Option<(u16, bool)> {
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            return Some((c.to_ascii_uppercase() as u16, false));
        }
    }
    if let Some(n) = name.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()).filter(|n| (1..=12).contains(n)) {
        return Some((0x6F + n, false));
    }
    let (vk, extended) = match name {
        "return" => (0x0D, false),
        "tab" => (0x09, false),
        "space" => (0x20, false),
        // macOS's delete is the key left of it: Backspace.
        "delete" => (0x08, false),
        "escape" => (0x1B, false),
        ";" => (0xBA, false),
        "=" => (0xBB, false),
        "," => (0xBC, false),
        "-" => (0xBD, false),
        "." => (0xBE, false),
        "/" => (0xBF, false),
        "`" => (0xC0, false),
        "[" => (0xDB, false),
        "\\" => (0xDC, false),
        "]" => (0xDD, false),
        "'" => (0xDE, false),
        "pageup" => (0x21, true),
        "pagedown" => (0x22, true),
        "end" => (0x23, true),
        "home" => (0x24, true),
        "left" => (0x25, true),
        "up" => (0x26, true),
        "right" => (0x27, true),
        "down" => (0x28, true),
        "forwarddelete" => (0x2E, true),
        _ => return None,
    };
    Some((vk, extended))
}

/// The held modifiers in macOS's order (Cmd, Shift, Alt, Ctrl). `cmd` presses Ctrl in Cmd's
/// place, and with `ctrl` too it is pressed once.
fn modifiers(combo: &KeyCombo) -> Result<Vec<u16>, String> {
    let m = combo.modifiers;
    if m.fn_key {
        return Err(format!("`fn` has no Windows key, so `{}` cannot be pressed", combo.key));
    }
    Ok([(m.cmd, VK_CONTROL), (m.shift, VK_SHIFT), (m.alt, VK_MENU), (m.ctrl && !m.cmd, VK_CONTROL)]
        .into_iter()
        .filter_map(|(on, vk)| on.then_some(vk))
        .collect())
}

/// The wheel steps for a scroll of `pixels`, or none for 0. A scroll of a few pixels still
/// turns the wheel a little.
fn wheel(horizontal: bool, pixels: i32) -> Option<Step> {
    if pixels == 0 {
        return None;
    }
    let notches = f64::from(pixels) * f64::from(WHEEL_DELTA) / f64::from(PIXELS_PER_NOTCH);
    let magnitude = (notches.abs().round() as i32).max(1);
    let delta = if notches < 0.0 { -magnitude } else { magnitude };
    // The tool's dy > 0 scrolls down, which is a negative vertical wheel delta.
    Some(Step::Wheel { horizontal, delta: if horizontal { delta } else { -delta } })
}

/// Re-check the recipient before each character's first key-down (S5), not between surrogate
/// halves. Releases must still go through, and combos may change the foreground on purpose.
pub fn checks_typing_target(step: &Step) -> bool {
    matches!(step, Step::Unicode { unit, down: true } if !(0xDC00..=0xDFFF).contains(unit))
}

/// Whether the helper waits after `step` until the window in front handles its input (S4): after
/// every key release. Input queued while that window's thread stalls reaches it as other
/// characters, or not at all.
pub fn settles(step: &Step) -> bool {
    matches!(step, Step::Key { down: false, .. } | Step::Unicode { down: false, .. })
}

/// A surrogate pair's down/up/down/up is one SendInput batch, with no wait between halves.
/// Every other step stays separate, preserving BMP, combo, and mouse timing.
pub fn send_batches(mut plan: &[Step]) -> Vec<&[Step]> {
    let mut batches = Vec::new();
    while !plan.is_empty() {
        let paired = matches!(plan,
            [Step::Unicode { unit: high, down: true }, Step::Unicode { unit: high_up, down: false },
             Step::Unicode { unit: low, down: true }, Step::Unicode { unit: low_up, down: false }, ..]
                if (0xD800..=0xDBFF).contains(high) && high == high_up
                    && (0xDC00..=0xDFFF).contains(low) && low == low_up);
        let count = if paired { 4 } else { 1 };
        batches.push(&plan[..count]);
        plan = &plan[count..];
    }
    batches
}

/// What releases every key and button `sent` left pressed, latest first: posted when an input
/// fails halfway, so a failed action never leaves Ctrl or a mouse button held.
pub fn releases(sent: &[Step]) -> Vec<Step> {
    let mut held: Vec<Step> = Vec::new();
    for step in sent {
        let up = match *step {
            Step::Button { button, down } => (Step::Button { button, down: false }, down),
            Step::Key { vk, down, extended } => (Step::Key { vk, down: false, extended }, down),
            Step::Unicode { unit, down } => (Step::Unicode { unit, down: false }, down),
            Step::Move { .. } | Step::Wheel { .. } => continue,
        };
        held.retain(|pressed| *pressed != up.0);
        if up.1 {
            held.push(up.0);
        }
    }
    held.reverse();
    held
}

/// The steps that post `event`, in order.
pub fn steps(event: &InputEvent, screen: &VirtualScreen) -> Result<Vec<Step>, String> {
    let press = |button, steps: &mut Vec<Step>| {
        steps.push(Step::Button { button, down: true });
        steps.push(Step::Button { button, down: false });
    };
    let mut steps = Vec::new();
    match event {
        InputEvent::Move(at) => steps.push(screen.move_to(*at)),
        InputEvent::Click { at, button, count } => {
            steps.push(screen.move_to(*at));
            for _ in 0..*count {
                press(*button, &mut steps);
            }
        }
        InputEvent::Drag { from, to } => {
            steps.push(screen.move_to(*from));
            steps.push(Step::Button { button: MouseButton::Left, down: true });
            for step in 1..=DRAG_STEPS {
                let t = f64::from(step) / f64::from(DRAG_STEPS);
                steps.push(screen.move_to(Point { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }));
            }
            steps.push(Step::Button { button: MouseButton::Left, down: false });
        }
        InputEvent::Scroll { at, dx, dy } => {
            steps.push(screen.move_to(*at));
            steps.extend(wheel(false, *dy));
            steps.extend(wheel(true, *dx));
        }
        InputEvent::Key(combo) => {
            let held = modifiers(combo)?;
            let (vk, extended) =
                virtual_key(combo.key).ok_or_else(|| format!("`{}` has no Windows key", combo.key))?;
            let modifier = |vk, down| Step::Key { vk, down, extended: false };
            steps.extend(held.iter().map(|&vk| modifier(vk, true)));
            steps.push(Step::Key { vk, down: true, extended });
            steps.push(Step::Key { vk, down: false, extended });
            steps.extend(held.iter().rev().map(|&vk| modifier(vk, false)));
        }
        InputEvent::Text(chunk) => {
            for unit in chunk.encode_utf16() {
                steps.push(Step::Unicode { unit, down: true });
                steps.push(Step::Unicode { unit, down: false });
            }
        }
    }
    Ok(steps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::keys::parse_combo;

    /// Two 1920 × 1080 displays, the second to the left of the primary one.
    const SCREEN: VirtualScreen = VirtualScreen { x: -1920, y: 0, width: 3840, height: 1080 };

    fn at(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn key(vk: u16, down: bool) -> Step {
        Step::Key { vk, down, extended: false }
    }

    fn plan(event: InputEvent) -> Vec<Step> {
        steps(&event, &SCREEN).unwrap()
    }

    #[test]
    fn surrogate_pairs_are_one_send_batch_and_other_steps_stay_separate() {
        let text = plan(InputEvent::Text("a🦀éb".into()));
        let batches = send_batches(&text);
        assert_eq!(batches.iter().map(|batch| batch.len()).collect::<Vec<_>>(), [1, 1, 4, 1, 1, 1, 1]);
        assert_eq!(batches[2], &text[2..6]);
        assert!(checks_typing_target(&batches[2][0]));
        assert!(settles(batches[2].last().unwrap()));
        assert!(releases(batches[2]).is_empty());
        // A partial SendInput result must still release whichever half was pressed.
        for count in [1, 3] {
            assert_eq!(releases(&batches[2][..count]).len(), 1);
        }
        for event in [
            InputEvent::Key(parse_combo("alt+tab").unwrap()),
            InputEvent::Click { at: at(0.0, 0.0), button: MouseButton::Left, count: 1 },
            InputEvent::Scroll { at: at(0.0, 0.0), dx: 50, dy: 50 },
        ] {
            let planned = plan(event);
            assert!(send_batches(&planned).iter().all(|batch| batch.len() == 1));
        }
    }

    #[test]
    fn only_character_start_key_downs_recheck_the_typing_target() {
        assert_eq!(
            plan(InputEvent::Text("a🦀".into())).iter().map(checks_typing_target).collect::<Vec<_>>(),
            [true, false, true, false, false, false]
        );
        for event in [
            InputEvent::Key(parse_combo("alt+tab").unwrap()),
            InputEvent::Click { at: at(0.0, 0.0), button: MouseButton::Left, count: 1 },
            InputEvent::Drag { from: at(0.0, 0.0), to: at(10.0, 10.0) },
            InputEvent::Scroll { at: at(0.0, 0.0), dx: 50, dy: 50 },
        ] {
            assert!(plan(event).iter().all(|step| !checks_typing_target(step)));
        }
    }

    #[test]
    fn moves_are_absolute_over_the_whole_virtual_screen() {
        assert_eq!(SCREEN.move_to(at(-1920.0, 0.0)), Step::Move { x: 0, y: 0 });
        assert_eq!(SCREEN.move_to(at(1919.0, 1079.0)), Step::Move { x: 65535, y: 65535 });
        // The primary display's top-left corner sits in the middle of the virtual screen.
        assert_eq!(SCREEN.move_to(at(0.0, 0.0)), Step::Move { x: 32776, y: 0 });
    }

    #[test]
    fn moves_outside_the_virtual_screen_are_clamped() {
        assert_eq!(SCREEN.move_to(at(-5000.0, -10.0)), Step::Move { x: 0, y: 0 });
        assert_eq!(SCREEN.move_to(at(9000.0, 2000.0)), Step::Move { x: 65535, y: 65535 });
    }

    #[test]
    fn a_click_moves_then_presses_and_releases_once_per_count() {
        let left = |down| Step::Button { button: MouseButton::Left, down };
        let moved = SCREEN.move_to(at(100.0, 200.0));
        assert_eq!(
            plan(InputEvent::Click { at: at(100.0, 200.0), button: MouseButton::Left, count: 1 }),
            [moved, left(true), left(false)]
        );
        assert_eq!(
            plan(InputEvent::Click { at: at(100.0, 200.0), button: MouseButton::Left, count: 2 }),
            [moved, left(true), left(false), left(true), left(false)]
        );
        let right = |down| Step::Button { button: MouseButton::Right, down };
        assert_eq!(
            plan(InputEvent::Click { at: at(100.0, 200.0), button: MouseButton::Right, count: 1 }),
            [moved, right(true), right(false)]
        );
    }

    #[test]
    fn a_drag_presses_at_the_start_moves_in_steps_and_releases_at_the_end() {
        let (from, to) = (at(0.0, 0.0), at(120.0, 240.0));
        let drag = plan(InputEvent::Drag { from, to });
        assert_eq!(drag.len(), 2 + DRAG_STEPS as usize + 1);
        assert_eq!(drag[0], SCREEN.move_to(from));
        assert_eq!(drag[1], Step::Button { button: MouseButton::Left, down: true });
        assert_eq!(drag[2], SCREEN.move_to(at(10.0, 20.0)));
        assert_eq!(drag[drag.len() - 2], SCREEN.move_to(to));
        assert_eq!(drag[drag.len() - 1], Step::Button { button: MouseButton::Left, down: false });
    }

    #[test]
    fn scrolling_moves_there_and_turns_pixels_into_wheel_notches() {
        let moved = SCREEN.move_to(at(50.0, 60.0));
        // dy > 0 scrolls down: a negative vertical delta. 100 pixels are two notches.
        assert_eq!(
            plan(InputEvent::Scroll { at: at(50.0, 60.0), dx: 0, dy: 100 }),
            [moved, Step::Wheel { horizontal: false, delta: -240 }]
        );
        // dx > 0 scrolls right: a positive horizontal delta.
        assert_eq!(
            plan(InputEvent::Scroll { at: at(50.0, 60.0), dx: 25, dy: -50 }),
            [moved, Step::Wheel { horizontal: false, delta: 120 }, Step::Wheel { horizontal: true, delta: 60 }]
        );
    }

    #[test]
    fn a_tiny_scroll_still_moves_the_wheel() {
        assert_eq!(
            plan(InputEvent::Scroll { at: at(0.0, 0.0), dx: 0, dy: 1 })[1],
            Step::Wheel { horizontal: false, delta: -2 }
        );
        assert_eq!(plan(InputEvent::Scroll { at: at(0.0, 0.0), dx: 0, dy: 0 }), [SCREEN.move_to(at(0.0, 0.0))]);
    }

    #[test]
    fn a_combo_holds_the_modifiers_around_the_key_and_releases_them_in_reverse() {
        // macOS presses Cmd, Shift, Alt, Ctrl in that order; Ctrl keeps Ctrl's place, cmd's Ctrl Cmd's.
        let combo = parse_combo("ctrl+alt+shift+t").unwrap();
        assert_eq!(
            plan(InputEvent::Key(combo)),
            [
                key(VK_SHIFT, true), key(VK_MENU, true), key(VK_CONTROL, true), key(0x54, true),
                key(0x54, false), key(VK_CONTROL, false), key(VK_MENU, false), key(VK_SHIFT, false),
            ]
        );
        let cmd = parse_combo("cmd+shift+t").unwrap();
        assert_eq!(
            plan(InputEvent::Key(cmd)),
            [key(VK_CONTROL, true), key(VK_SHIFT, true), key(0x54, true), key(0x54, false), key(VK_SHIFT, false), key(VK_CONTROL, false)]
        );
        let alt = parse_combo("alt+f4").unwrap();
        assert_eq!(plan(InputEvent::Key(alt)), [key(VK_MENU, true), key(0x73, true), key(0x73, false), key(VK_MENU, false)]);
    }

    #[test]
    fn cmd_presses_ctrl_and_cmd_with_ctrl_presses_it_once() {
        let copy = |combo| plan(InputEvent::Key(parse_combo(combo).unwrap()));
        let ctrl_c = [key(VK_CONTROL, true), key(0x43, true), key(0x43, false), key(VK_CONTROL, false)];
        assert_eq!(copy("cmd+c"), ctrl_c);
        assert_eq!(copy("cmd+ctrl+c"), ctrl_c);
    }

    #[test]
    fn fn_has_no_windows_key_and_is_refused() {
        let error = steps(&InputEvent::Key(parse_combo("fn+f1").unwrap()), &SCREEN).unwrap_err();
        assert!(error.contains("fn"), "{error}");
    }

    #[test]
    fn navigation_keys_are_extended_and_others_are_not() {
        let plain = plan(InputEvent::Key(parse_combo("left").unwrap()));
        assert_eq!(plain, [Step::Key { vk: 0x25, down: true, extended: true }, Step::Key { vk: 0x25, down: false, extended: true }]);
        assert_eq!(virtual_key("forwarddelete"), Some((0x2E, true)));
        assert_eq!(virtual_key("delete"), Some((0x08, false)), "macOS delete is Backspace");
        assert_eq!(virtual_key("return"), Some((0x0D, false)));
    }

    #[test]
    fn letters_digits_punctuation_and_function_keys_have_their_codes() {
        assert_eq!(virtual_key("a"), Some((0x41, false)));
        assert_eq!(virtual_key("z"), Some((0x5A, false)));
        assert_eq!(virtual_key("0"), Some((0x30, false)));
        assert_eq!(virtual_key("9"), Some((0x39, false)));
        assert_eq!(virtual_key("f1"), Some((0x70, false)));
        assert_eq!(virtual_key("f12"), Some((0x7B, false)));
        for (name, vk) in [(";", 0xBA), ("=", 0xBB), (",", 0xBC), ("-", 0xBD), (".", 0xBE), ("/", 0xBF), ("`", 0xC0), ("[", 0xDB), ("\\", 0xDC), ("]", 0xDD), ("'", 0xDE)] {
            assert_eq!(virtual_key(name), Some((vk, false)), "{name}");
        }
        for (name, vk) in [("tab", 0x09), ("space", 0x20), ("escape", 0x1B)] {
            assert_eq!(virtual_key(name), Some((vk, false)), "{name}");
        }
        for (name, vk) in [("home", 0x24), ("end", 0x23), ("pageup", 0x21), ("pagedown", 0x22), ("up", 0x26), ("right", 0x27), ("down", 0x28)] {
            assert_eq!(virtual_key(name), Some((vk, true)), "{name}");
        }
    }

    #[test]
    fn every_key_the_parser_accepts_has_a_windows_code() {
        for name in crate::computer::keys::names() {
            assert!(virtual_key(name).is_some(), "{name} has no virtual-key code");
        }
        assert_eq!(virtual_key("hyper"), None);
    }

    #[test]
    fn the_target_catches_up_after_each_key_release_only() {
        let mut sent = plan(InputEvent::Text("hé".into()));
        sent.extend(plan(InputEvent::Key(parse_combo("ctrl+a").unwrap())));
        sent.extend(plan(InputEvent::Click { at: at(10.0, 10.0), button: MouseButton::Left, count: 1 }));
        let waits: Vec<Step> = sent.iter().copied().filter(settles).collect();
        // Both characters and the A of ctrl+a, then Ctrl: never a press or the mouse.
        assert_eq!(waits, [Step::Unicode { unit: 0x68, down: false }, Step::Unicode { unit: 0xE9, down: false }, key(0x41, false), key(0x11, false)]);
    }

    #[test]
    fn text_types_each_utf16_unit_as_itself() {
        let unicode = |unit, down| Step::Unicode { unit, down };
        assert_eq!(plan(InputEvent::Text("hé".into())), [unicode(0x68, true), unicode(0x68, false), unicode(0xE9, true), unicode(0xE9, false)]);
        // A character beyond the BMP is its two surrogates, each pressed and released.
        assert_eq!(
            plan(InputEvent::Text("😀".into())),
            [unicode(0xD83D, true), unicode(0xD83D, false), unicode(0xDE00, true), unicode(0xDE00, false)]
        );
    }

    #[test]
    fn a_failed_input_releases_what_was_left_pressed_latest_first() {
        let left = |down| Step::Button { button: MouseButton::Left, down };
        // Failed after Ctrl, Shift, and T went down, and T came back up.
        let sent = [key(VK_CONTROL, true), key(VK_SHIFT, true), key(0x54, true), key(0x54, false)];
        assert_eq!(releases(&sent), [key(VK_SHIFT, false), key(VK_CONTROL, false)]);
        // Failed in the middle of a drag: the button is released.
        let drag = [SCREEN.move_to(at(0.0, 0.0)), left(true), SCREEN.move_to(at(5.0, 5.0))];
        assert_eq!(releases(&drag), [left(false)]);
        // An extended key is released as extended, a typed unit as itself.
        let nav = [Step::Key { vk: 0x25, down: true, extended: true }, Step::Unicode { unit: 0x68, down: true }];
        assert_eq!(releases(&nav), [Step::Unicode { unit: 0x68, down: false }, Step::Key { vk: 0x25, down: false, extended: true }]);
        // Nothing held, nothing to release.
        assert_eq!(releases(&[left(true), left(false), key(VK_MENU, true), key(VK_MENU, false)]), []);
        assert_eq!(releases(&[]), []);
    }

    #[test]
    fn negative_origins_on_both_axes_and_tiny_screens_are_normalized() {
        let above = VirtualScreen { x: 0, y: -1080, width: 1920, height: 2160 };
        assert_eq!(above.move_to(at(0.0, -1080.0)), Step::Move { x: 0, y: 0 });
        assert_eq!(above.move_to(at(1919.0, 1079.0)), Step::Move { x: 65535, y: 65535 });
        let tiny = VirtualScreen { x: 0, y: 0, width: 1, height: 1 };
        assert_eq!(tiny.move_to(at(0.0, 0.0)), Step::Move { x: 0, y: 0 });
        assert_eq!(tiny.move_to(at(3.0, 3.0)), Step::Move { x: 65535, y: 65535 });
    }

    #[test]
    fn scrolling_left_is_a_negative_horizontal_delta() {
        assert_eq!(plan(InputEvent::Scroll { at: at(0.0, 0.0), dx: -50, dy: 0 })[1], Step::Wheel { horizontal: true, delta: -120 });
    }

    #[test]
    fn a_drag_visits_twelve_evenly_spaced_points() {
        let drag = plan(InputEvent::Drag { from: at(0.0, 0.0), to: at(120.0, 240.0) });
        let moves: Vec<Step> = (1..=12).map(|i| SCREEN.move_to(at(10.0 * f64::from(i), 20.0 * f64::from(i)))).collect();
        assert_eq!(drag[2..14], moves[..]);
    }

    #[test]
    fn a_move_is_one_absolute_step() {
        assert_eq!(plan(InputEvent::Move(at(10.0, 10.0))), [SCREEN.move_to(at(10.0, 10.0))]);
    }
}
