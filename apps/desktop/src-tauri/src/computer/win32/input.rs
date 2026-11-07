//! Bounded native input plans. Planning/cleanup tests exercise this implementation,
//! not a second-language copy. All events in one action are inserted in one native batch.
use std::mem::size_of;
use windows::Win32::{Foundation::{GetLastError, SetLastError, ERROR_SUCCESS},
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::WHEEL_DELTA}};
use super::{context::{point, PixelRect}, super::{InputEvent, MouseButton, coords::Point, keys::{parse_combo, KeyCombo}}};

pub(super) const MAX_INPUTS: usize = 256;
pub(super) const DRAG_STEPS: usize = 16;
const MAX_TEXT_UNITS: usize = MAX_INPUTS / 2;
const MAX_SCROLL_PIXELS: i32 = 12_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Held { Key(u16, bool), Unicode(u16), Button(bool) }

pub(super) struct Step {
    native: INPUT,
    change: Option<(Held, bool)>,
}

fn keyboard(held: Held, down: bool) -> Step {
    let (vk, scan, mut flags) = match held {
        Held::Key(vk, extended) => (VIRTUAL_KEY(vk), 0,
            if extended { KEYEVENTF_EXTENDEDKEY } else { Default::default() }),
        Held::Unicode(unit) => (VIRTUAL_KEY::default(), unit, KEYEVENTF_UNICODE),
        Held::Button(_) => unreachable!("button passed to keyboard planner"),
    };
    if !down { flags |= KEYEVENTF_KEYUP; }
    Step { native: INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 {
        ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, ..Default::default() } } },
        change: Some((held, down)) }
}

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: u32) -> Step {
    Step { native: INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 {
        mi: MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, ..Default::default() } } }, change: None }
}

fn button(left: bool, down: bool) -> Step {
    let flag = match (left, down) {
        (true, true) => MOUSEEVENTF_LEFTDOWN, (true, false) => MOUSEEVENTF_LEFTUP,
        (false, true) => MOUSEEVENTF_RIGHTDOWN, (false, false) => MOUSEEVENTF_RIGHTUP,
    };
    let mut step = mouse(flag, 0, 0, 0);
    step.change = Some((Held::Button(left), down));
    step
}

/// Explicit translation from canonical ANSI names, never the Mac virtual key numbers.
/// OEM punctuation follows the Windows keyboard layout; `Text` supplies exact Unicode.
fn virtual_key(key: &str) -> Option<(VIRTUAL_KEY, bool)> {
    let vk = match key {
        "a" => VK_A, "b" => VK_B, "c" => VK_C, "d" => VK_D, "e" => VK_E,
        "f" => VK_F, "g" => VK_G, "h" => VK_H, "i" => VK_I, "j" => VK_J,
        "k" => VK_K, "l" => VK_L, "m" => VK_M, "n" => VK_N, "o" => VK_O,
        "p" => VK_P, "q" => VK_Q, "r" => VK_R, "s" => VK_S, "t" => VK_T,
        "u" => VK_U, "v" => VK_V, "w" => VK_W, "x" => VK_X, "y" => VK_Y, "z" => VK_Z,
        "0" => VK_0, "1" => VK_1, "2" => VK_2, "3" => VK_3, "4" => VK_4,
        "5" => VK_5, "6" => VK_6, "7" => VK_7, "8" => VK_8, "9" => VK_9,
        "return" => VK_RETURN, "tab" => VK_TAB, "space" => VK_SPACE,
        "delete" => VK_BACK, "escape" => VK_ESCAPE, "forwarddelete" => VK_DELETE,
        "home" => VK_HOME, "end" => VK_END, "pageup" => VK_PRIOR, "pagedown" => VK_NEXT,
        "left" => VK_LEFT, "right" => VK_RIGHT, "up" => VK_UP, "down" => VK_DOWN,
        "f1" => VK_F1, "f2" => VK_F2, "f3" => VK_F3, "f4" => VK_F4,
        "f5" => VK_F5, "f6" => VK_F6, "f7" => VK_F7, "f8" => VK_F8,
        "f9" => VK_F9, "f10" => VK_F10, "f11" => VK_F11, "f12" => VK_F12,
        ";" => VK_OEM_1, "/" => VK_OEM_2, "`" => VK_OEM_3, "[" => VK_OEM_4,
        "\\" => VK_OEM_5, "]" => VK_OEM_6, "'" => VK_OEM_7,
        "=" => VK_OEM_PLUS, "-" => VK_OEM_MINUS, "," => VK_OEM_COMMA, "." => VK_OEM_PERIOD,
        _ => return None,
    };
    Some((vk, matches!(key, "forwarddelete" | "home" | "end" | "pageup" | "pagedown"
        | "left" | "right" | "up" | "down")))
}

fn combo(combo: &KeyCombo) -> Result<Vec<Step>, String> {
    if combo.modifiers.fn_key { return Err("Windows has no portable Fn injection key".into()); }
    if parse_combo(combo.key)?.code != combo.code { return Err("inconsistent canonical key/code".into()); }
    let (vk, extended) = virtual_key(combo.key).ok_or("key has no Windows translation")?;
    let m = combo.modifiers;
    // cmd explicitly means the Windows/Super key here, not a silent Ctrl substitution.
    let mut held: Vec<Held> = [(m.ctrl, VK_LCONTROL, false), (m.shift, VK_LSHIFT, false),
        (m.alt, VK_LMENU, false), (m.cmd, VK_LWIN, true)].into_iter()
        .filter(|(enabled, ..)| *enabled).map(|(_, vk, extended)| Held::Key(vk.0, extended)).collect();
    held.push(Held::Key(vk.0, extended));
    Ok(held.iter().map(|key| keyboard(*key, true))
        .chain(held.iter().rev().map(|key| keyboard(*key, false))).collect())
}

fn movement(at: Point, desktop: PixelRect) -> Result<Step, String> {
    let at = point(at)?;
    if desktop.width < 2 || desktop.height < 2 || !desktop.contains(at) {
        return Err("point outside the virtual desktop".into());
    }
    let normalize = |n: i32, origin: i32, size: i32| -> i32 {
        ((i64::from(n) - i64::from(origin)) * 65535 / (i64::from(size) - 1)) as i32
    };
    Ok(mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        normalize(at.x, desktop.x, desktop.width), normalize(at.y, desktop.y, desktop.height), 0))
}

pub(super) fn drag_points(from: Point, to: Point) -> Vec<Point> {
    (0..=DRAG_STEPS).map(|step| {
        let t = step as f64 / DRAG_STEPS as f64;
        Point { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
    }).collect()
}

pub(super) fn plan(event: &InputEvent, desktop: PixelRect) -> Result<Vec<Step>, String> {
    let mut steps = Vec::new();
    match event {
        InputEvent::Move(at) => steps.push(movement(*at, desktop)?),
        InputEvent::Click { at, button: which, count } => {
            if !(1..=2).contains(count) { return Err("click count must be 1 or 2".into()); }
            steps.push(movement(*at, desktop)?);
            for _ in 0..*count {
                steps.push(button(*which == MouseButton::Left, true));
                steps.push(button(*which == MouseButton::Left, false));
            }
        }
        InputEvent::Drag { from, to } => {
            steps.push(movement(*from, desktop)?);
            steps.push(button(true, true));
            for at in drag_points(*from, *to).into_iter().skip(1) { steps.push(movement(at, desktop)?); }
            steps.push(button(true, false));
        }
        InputEvent::Scroll { at, dx, dy } => {
            if dx.unsigned_abs() > MAX_SCROLL_PIXELS as u32 || dy.unsigned_abs() > MAX_SCROLL_PIXELS as u32 {
                return Err("scroll exceeds 12000 nominal pixels per axis".into());
            }
            steps.push(movement(*at, desktop)?);
            // Windows wheel units are NOT pixels. Use a documented nominal 40 pixels
            // per notch; actual distance depends on the application and OS settings.
            if *dy != 0 { steps.push(mouse(MOUSEEVENTF_WHEEL, 0, 0, (-dy * WHEEL_DELTA as i32 / 40) as u32)); }
            if *dx != 0 { steps.push(mouse(MOUSEEVENTF_HWHEEL, 0, 0, (dx * WHEEL_DELTA as i32 / 40) as u32)); }
        }
        InputEvent::Key(key) => steps = combo(key)?,
        InputEvent::Text(text) => {
            if text.len() > MAX_TEXT_UNITS * 4 { return Err("text chunk exceeds byte limit".into()); }
            if text.chars().any(char::is_control) { return Err("text chunk must not contain control characters".into()); }
            let units: Vec<_> = text.encode_utf16().take(MAX_TEXT_UNITS + 1).collect();
            if units.len() > MAX_TEXT_UNITS { return Err("text chunk exceeds 128 UTF-16 units".into()); }
            for unit in units { steps.push(keyboard(Held::Unicode(unit), true)); steps.push(keyboard(Held::Unicode(unit), false)); }
        }
    }
    if steps.len() > MAX_INPUTS { return Err("native input batch exceeds 256 events".into()); }
    Ok(steps)
}

/// Exactly the keys/buttons this adapter still owns after an accepted ordered prefix.
/// Never includes a key rejected by the initial human-held-state check.
fn cleanup_prefix(steps: &[Step], accepted: usize) -> Vec<Step> {
    let mut held = Vec::new();
    for step in steps.iter().take(accepted) {
        if let Some((key, down)) = step.change {
            if down { held.push(key); }
            else if let Some(index) = held.iter().rposition(|item| *item == key) { held.remove(index); }
        }
    }
    held.into_iter().rev().map(|key| match key {
        Held::Button(left) => button(left, false), _ => keyboard(key, false),
    }).collect()
}

fn human_held(steps: &[Step]) -> bool {
    let mut keys = vec![VK_LCONTROL.0, VK_RCONTROL.0, VK_LSHIFT.0, VK_RSHIFT.0,
        VK_LMENU.0, VK_RMENU.0, VK_LWIN.0, VK_RWIN.0, VK_LBUTTON.0, VK_RBUTTON.0,
        VK_MBUTTON.0, VK_XBUTTON1.0, VK_XBUTTON2.0];
    keys.extend(steps.iter().filter_map(|step| match step.change {
        Some((Held::Key(key, _), _)) => Some(key), _ => None,
    }));
    // SAFETY: query-only. Only the high bit means currently down (not the shared
    // 'pressed since last call' bit). Refuse rather than releasing pre-held human keys.
    keys.into_iter().any(|key| unsafe { GetAsyncKeyState(i32::from(key)) } < 0)
}

/// Err includes exact insertion/cleanup counts. A failed cleanup latches the adapter
/// unhealthy; it must not claim keys were released when Windows rejected the releases.
pub(super) fn send(steps: &[Step], unhealthy: &std::sync::atomic::AtomicBool) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if steps.is_empty() { return Ok(()); }
    if steps.len() > MAX_INPUTS { return Err("native input batch exceeds limit".into()); }
    if human_held(steps) { return Err("release physically held keys/buttons before computer input".into()); }
    let native: Vec<_> = steps.iter().map(|step| step.native).collect();
    // SAFETY: bounded correctly typed slice; all pointers remain live for this call.
    // SendInput inserts this batch serially, without sleeps or an unbounded drag loop.
    unsafe { SetLastError(ERROR_SUCCESS) };
    let sent = unsafe { SendInput(&native, size_of::<INPUT>() as i32) } as usize;
    let last_error = unsafe { GetLastError() }.0;
    if sent == steps.len() { return Ok(()); }
    if sent > steps.len() {
        unhealthy.store(true, Ordering::Release);
        return Err("SendInput reported an impossible insertion count; adapter disabled".into());
    }
    let cleanup = cleanup_prefix(steps, sent);
    let release: Vec<_> = cleanup.iter().map(|step| step.native).collect();
    let (released, cleanup_error) = if release.is_empty() { (0, 0) } else {
        unsafe { SetLastError(ERROR_SUCCESS) };
        let count = unsafe { SendInput(&release, size_of::<INPUT>() as i32) } as usize;
        (count, unsafe { GetLastError() }.0)
    };
    if released != release.len() { unhealthy.store(true, Ordering::Release); }
    Err(format!("SendInput inserted {sent}/{} (Win32 {last_error}); owned cleanup inserted {released}/{} (Win32 {cleanup_error}); UIPI cause unknown{}",
        steps.len(), release.len(), if released != release.len() { "; adapter disabled, manual key/button release may be needed" } else { "" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn desktop() -> PixelRect { PixelRect { x: -1920, y: -300, width: 3840, height: 1380 } }
    #[test]
    fn mac_keycodes_are_not_forwarded() {
        let key = parse_combo("cmd+shift+t").unwrap();
        assert_eq!(key.code, 17); // preserve the existing Mac parser contract
        let plan = plan(&InputEvent::Key(key), desktop()).unwrap();
        assert_eq!(plan[2].change, Some((Held::Key(VK_T.0, false), true)));
        assert_eq!(plan[1].change, Some((Held::Key(VK_LWIN.0, true), true)));
        assert_ne!(VK_T.0, key.code);
        assert!(plan.iter().all(|step| step.native.r#type == INPUT_KEYBOARD));
    }
    #[test]
    fn accepted_prefix_cleanup_releases_only_owned_keys_in_reverse_order() {
        let plan = plan(&InputEvent::Key(parse_combo("ctrl+alt+return").unwrap()), desktop()).unwrap();
        for prefix in 0..=plan.len() {
            let cleanup = cleanup_prefix(&plan, prefix);
            assert!(cleanup.iter().all(|step| matches!(step.change, Some((_, false)))));
            let mut combined = Vec::new();
            combined.extend(plan.iter().take(prefix).map(|step| Step { native: step.native, change: step.change }));
            combined.extend(cleanup);
            assert!(cleanup_prefix(&combined, combined.len()).is_empty());
        }
        assert_eq!(cleanup_prefix(&plan, 2)[0].change, Some((Held::Key(VK_LMENU.0, false), false)));
        assert!(cleanup_prefix(&plan, 0).is_empty());
    }
    #[test]
    fn invalid_input_is_rejected_before_a_native_call() {
        assert!(plan(&InputEvent::Click { at: Point { x: 0.0, y: 0.0 }, button: MouseButton::Left, count: 3 }, desktop()).is_err());
        assert!(plan(&InputEvent::Move(Point { x: f64::NAN, y: 0.0 }), desktop()).is_err());
        assert!(plan(&InputEvent::Text("x".repeat(129)), desktop()).is_err());
        assert!(plan(&InputEvent::Text("\n".into()), desktop()).is_err());
        assert!(plan(&InputEvent::Key(parse_combo("fn+f1").unwrap()), desktop()).is_err());
        assert!(plan(&InputEvent::Scroll { at: Point { x: 0.0, y: 0.0 }, dx: i32::MIN, dy: 0 }, desktop()).is_err());
    }
    #[test]
    fn negative_origin_endpoints_and_surrogates_are_planned() {
        let move_plan = plan(&InputEvent::Move(Point { x: -1920.0, y: -300.0 }), desktop()).unwrap();
        assert_eq!(unsafe { move_plan[0].native.Anonymous.mi.dx }, 0);
        let text = plan(&InputEvent::Text("😀".into()), desktop()).unwrap();
        assert_eq!(text.len(), 4);
        assert!(cleanup_prefix(&text, 4).is_empty());
        let drag = plan(&InputEvent::Drag { from: Point { x: -1.0, y: 0.0 }, to: Point { x: 100.0, y: 100.0 } }, desktop()).unwrap();
        assert_eq!(drag.len(), DRAG_STEPS + 3);
        assert_eq!(cleanup_prefix(&drag, 2)[0].change, Some((Held::Button(true), false)));
    }
}
