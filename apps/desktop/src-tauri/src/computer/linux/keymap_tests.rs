//! RED/GREEN checks for [`super::keymap`]: Unicode keysym mapping, Mac
//! canonical key-name resolution, XKB symbol spelling, and hand-rolled
//! keymap-text structure. No Wayland, no compositor, no file: everything
//! here runs against pure functions. These tests check structure, not parser
//! acceptance. Separate verification compiled six exact generated maps with
//! libxkbcommon 1.13.2; real-compositor input is still unverified.

use super::keymap::{
    generate_keymap, keysym_for_char, keysym_for_key_name, MAX_DISTINCT_KEYS, MAX_KEYMAP_BYTES,
};

#[test]
fn ascii_chars_map_to_their_codepoint() {
    assert_eq!(keysym_for_char('a').unwrap(), 0x61);
    assert_eq!(keysym_for_char('A').unwrap(), 0x41);
    assert_eq!(keysym_for_char('1').unwrap(), 0x31);
    assert_eq!(keysym_for_char(' ').unwrap(), 0x20);
    assert_eq!(keysym_for_char(',').unwrap(), 0x2C);
}

#[test]
fn latin1_chars_keep_their_codepoint() {
    // e-acute stays 0xE9 (not the Unicode-encoded form): the compositor
    // resolves it through the U00E9 symbol the generator emits.
    assert_eq!(keysym_for_char('é').unwrap(), 0xE9);
    assert_eq!(keysym_for_char('ñ').unwrap(), 0xF1);
}

#[test]
fn astral_and_cjk_chars_use_the_unicode_encoding() {
    assert_eq!(keysym_for_char('好').unwrap(), 0x0100_0000 | 0x597D);
    assert_eq!(keysym_for_char('😀').unwrap(), 0x0100_0000 | 0x1F600);
}

#[test]
fn newline_and_tab_map_to_return_and_tab() {
    assert_eq!(keysym_for_key_name("return").unwrap(), 0xFF0D);
    assert_eq!(keysym_for_char('\n').unwrap(), 0xFF0D);
    assert_eq!(keysym_for_char('\r').unwrap(), 0xFF0D);
    assert_eq!(keysym_for_char('\t').unwrap(), 0xFF09);
}

#[test]
fn nul_is_refused() {
    assert!(keysym_for_char('\0').is_err(), "NUL can never name a key");
}

#[test]
fn mac_canonical_names_resolve() {
    let cases = [
        ("return", 0xFF0D),
        ("enter", 0xFF0D),
        ("tab", 0xFF09),
        ("space", 0x20),
        ("delete", 0xFF08),
        ("backspace", 0xFF08),
        ("forwarddelete", 0xFFFF),
        ("escape", 0xFF1B),
        ("esc", 0xFF1B),
        ("left", 0xFF53),
        ("right", 0xFF51),
        ("up", 0xFF52),
        ("down", 0xFF54),
        ("home", 0xFF50),
        ("end", 0xFF57),
        ("pageup", 0xFF55),
        ("pagedown", 0xFF56),
        ("f1", 0xFFBE),
        ("f5", 0xFFC2),
        ("f12", 0xFFC9),
        ("a", 0x61),
        ("z", 0x7A),
        ("0", 0x30),
        (",", 0x2C),
        ("-", 0x2D),
    ];
    for (name, keysym) in cases {
        assert_eq!(keysym_for_key_name(name).unwrap(), keysym, "key {name:?}");
    }
}

#[test]
fn unknown_key_names_fail() {
    for name in ["", "hyper", "f13", "f0", "plus", "returnx"] {
        assert!(keysym_for_key_name(name).is_err(), "{name:?} must fail");
    }
}

#[test]
fn generated_keymap_is_structurally_well_formed() {
    let syms = [0x68, 0x69, 0x0100_0000 | 0x597D]; // h, i, 好
    let keymap = generate_keymap(&syms).unwrap();
    assert!(keymap.text.starts_with("xkb_keymap {"), "got: {}", keymap.text);
    for section in ["xkb_keycodes", "xkb_types", "xkb_compat", "xkb_symbols"] {
        assert!(keymap.text.contains(section), "missing {section}");
    }
    assert!(keymap.text.trim_end().ends_with("};"));
    assert!(!keymap.text.contains('\0'), "NUL is appended separately");
    let opens = keymap.text.matches('{').count();
    let closes = keymap.text.matches('}').count();
    assert_eq!(opens, closes, "unbalanced braces");
    for entry in ["modifier_map Control", "modifier_map Shift", "modifier_map Mod1", "modifier_map Mod4"] {
        assert!(keymap.text.contains(entry), "missing {entry}");
    }
    // One placement per keysym, evdev codes strictly increasing past the
    // four modifier codes.
    assert_eq!(keymap.placements.len(), 3);
    let codes: Vec<u32> = keymap.placements.iter().map(|p| p.evdev_code).collect();
    assert!(codes[0] < codes[1] && codes[1] < codes[2], "got: {codes:?}");
    for code in [keymap.ctrl_code, keymap.shift_code, keymap.alt_code, keymap.super_code] {
        assert!(code < codes[0], "modifier codes precede key codes");
    }
    assert_eq!(
        [keymap.ctrl_code, keymap.shift_code, keymap.alt_code, keymap.super_code].iter().collect::<std::collections::HashSet<_>>().len(),
        4,
        "modifier codes are distinct"
    );
}

#[test]
fn unicode_symbols_use_valid_xkb_spellings() {
    let keymap = generate_keymap(&[0xE9, 0x0100_0000 | 0x1F600, 0x0100_0000 | 0x597D]).unwrap();
    assert!(keymap.text.contains("U00E9"), "latin-1 via U escape, got: {}", keymap.text);
    assert!(keymap.text.contains("U1F600"), "emoji via U escape, got: {}", keymap.text);
    assert!(keymap.text.contains("U597D"), "CJK via U escape, got: {}", keymap.text);
}

#[test]
fn punctuation_uses_named_xkb_symbols_never_bare_glyphs() {
    // Bare punctuation inside `[ ... ]` would be an XKB syntax error; the
    // generator must spell names (`comma`, not `,`).
    let keymap = generate_keymap(&[0x2C, 0x2E, 0x2F, 0x27, 0x5B, 0x5C, 0x2D, 0x3D]).unwrap();
    for symbol in ["comma", "period", "slash", "apostrophe", "bracketleft", "backslash", "minus", "equal"] {
        assert!(keymap.text.contains(symbol), "missing {symbol}, got: {}", keymap.text);
    }
    assert!(!keymap.text.contains("[ ,"), "bare comma is an XKB syntax error");
}

#[test]
fn named_specials_use_their_xkb_names() {
    let keymap = generate_keymap(&[0xFF0D, 0xFF09, 0xFF08, 0xFF1B, 0xFF53, 0x20]).unwrap();
    for symbol in ["Return", "Tab", "BackSpace", "Escape", "Left", "space"] {
        assert!(keymap.text.contains(symbol), "missing {symbol}, got: {}", keymap.text);
    }
}

#[test]
fn keymap_limits_fail_before_any_upload() {
    let too_many: Vec<u32> = (0..MAX_DISTINCT_KEYS as u32 + 1).map(|i| 0xE0 + i).collect();
    let err = generate_keymap(&too_many).expect_err("past the distinct cap must fail");
    assert!(err.to_string().contains(&too_many.len().to_string()), "got: {err}");
    assert!(MAX_KEYMAP_BYTES >= 4096, "the byte cap stays realistic");
}
