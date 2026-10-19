//! XKB keymap-text generation for the virtual keyboard (T4b, S1-S5):
//! pure Unicode keysym mapping plus a hand-rolled `xkb_keymap` text the
//! compositor compiles. No Wayland, no file, no fork, no libxkbcommon and
//! no xkeysym: the client never links an XKB parser. Unit tests check the
//! structure; separate verification compiled six generated maps with
//! libxkbcommon 1.13.2, including Unicode and punctuation. Actual compositor
//! input remains unverified.
//!
//! Technique ported in structure from the read-only reference
//! `wlroots-bridge` (`src/input/keymap.rs`, MIT, see
//! `THIRD_PARTY_NOTICES.md`): Latin-1 chars keep their codepoint, anything
//! else uses the `0x01000000 | codepoint` Unicode encoding, and the keymap
//! binds the four modifiers plus each requested keysym to sequential XKB
//! keycodes starting at 9 (evdev code = XKB keycode - 8, which is what the
//! `zwp_virtual_keyboard_v1.key` request wants). Deliberate divergences:
//! the symbol table is hand-rolled (ASCII alphanumerics as themselves,
//! punctuation through a fixed name table because bare punctuation inside
//! `[ ... ]` is an XKB syntax error, everything else as `U%04X`) instead
//! of xkeysym lookups; every keysym is bound at level 1 with both levels
//! identical, so Shift is never synthesized and every tap is one
//! press/release pair; generation fails past explicit caps instead of
//! paging; and Mac `cmd` arrives already mapped to Super by the caller.

use std::fmt;

/// How many distinct keysyms one keymap upload may bind. Past this the
/// caller splits the text; a single bounded operation never does.
pub const MAX_DISTINCT_KEYS: usize = 256;
/// Largest keymap text one operation uploads (bytes, NUL excluded).
pub const MAX_KEYMAP_BYTES: usize = 65536;

/// XKB keycodes below 9 are reserved; real keys start here, so the first
/// placement lands on a predictable code.
const XKB_KEYCODE_BASE: u32 = 9;

/// What went wrong mapping a key or generating its keymap. Every variant
/// fires before any Wayland request is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeymapError {
    /// A key name outside the Mac canonical grammar and single chars.
    UnsupportedKey { name: String },
    /// A char with no keysym (NUL).
    UnsupportedChar(char),
    /// More distinct keysyms than one upload binds.
    TooManyKeys { count: usize },
    /// Generated text past the byte cap.
    KeymapTooLarge { bytes: usize },
}

impl fmt::Display for KeymapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedKey { name } => write!(f, "unsupported key name `{name}`"),
            Self::UnsupportedChar(ch) => {
                write!(f, "cannot type control character U+{:04X}", *ch as u32)
            }
            Self::TooManyKeys { count } => write!(
                f,
                "too many distinct keys for one keymap upload ({count} > {MAX_DISTINCT_KEYS})"
            ),
            Self::KeymapTooLarge { bytes } => write!(
                f,
                "generated keymap too large ({bytes} bytes > {MAX_KEYMAP_BYTES})"
            ),
        }
    }
}

impl std::error::Error for KeymapError {}

/// Map a Unicode scalar to an XKB keysym: newline/CR become Return, tab
/// becomes Tab, Latin-1 keeps its codepoint, and everything else uses the
/// Unicode encoding (`0x01000000 | codepoint`) every XKB-based compositor
/// resolves through the `U`-style symbol the generator emits.
pub fn keysym_for_char(ch: char) -> Result<u32, KeymapError> {
    match ch {
        '\n' | '\r' => Ok(0xFF0D),
        '\t' => Ok(0xFF09),
        '\0' => Err(KeymapError::UnsupportedChar(ch)),
        _ => {
            let cp = ch as u32;
            if cp < 0x100 {
                Ok(cp)
            } else {
                Ok(0x0100_0000 | cp)
            }
        }
    }
}

/// Resolve a Mac canonical key name (the `KeyCombo.key` grammar in
/// `computer::keys`: lowercase single chars plus named keys) to an XKB
/// keysym. Anything outside that grammar fails instead of guessing.
pub fn keysym_for_key_name(name: &str) -> Result<u32, KeymapError> {
    match name {
        "return" | "enter" => Ok(0xFF0D),
        "tab" => Ok(0xFF09),
        "space" => Ok(0x20),
        "delete" | "backspace" => Ok(0xFF08),
        "forwarddelete" => Ok(0xFFFF),
        "escape" | "esc" => Ok(0xFF1B),
        "left" => Ok(0xFF53),
        "right" => Ok(0xFF51),
        "up" => Ok(0xFF52),
        "down" => Ok(0xFF54),
        "home" => Ok(0xFF50),
        "end" => Ok(0xFF57),
        "pageup" => Ok(0xFF55),
        "pagedown" => Ok(0xFF56),
        "f1" => Ok(0xFFBE),
        "f2" => Ok(0xFFBF),
        "f3" => Ok(0xFFC0),
        "f4" => Ok(0xFFC1),
        "f5" => Ok(0xFFC2),
        "f6" => Ok(0xFFC3),
        "f7" => Ok(0xFFC4),
        "f8" => Ok(0xFFC5),
        "f9" => Ok(0xFFC6),
        "f10" => Ok(0xFFC7),
        "f11" => Ok(0xFFC8),
        "f12" => Ok(0xFFC9),
        _ => {
            if name.chars().count() == 1 {
                keysym_for_char(name.chars().next().expect("count == 1"))
            } else {
                Err(KeymapError::UnsupportedKey { name: name.to_owned() })
            }
        }
    }
}

/// The XKB symbol for a keysym, as it must appear inside `xkb_symbols`.
/// Specials use their X names, ASCII letters/digits spell themselves,
/// punctuation uses its X name (a bare `,` inside `[ ... ]` is a syntax
/// error), and everything else — Latin-1 supplement, CJK, emoji — uses
/// xkbcommon's `U` Unicode escape, which the Unicode-encoded keysyms above
/// resolve through.
fn xkb_symbol_name(keysym: u32) -> String {
    // Unicode-encoded keysyms (`0x01000000 | codepoint`) spell the bare
    // codepoint: without the strip an emoji would render as `U11F600`.
    if keysym & 0xFF00_0000 == 0x0100_0000 {
        return format!("U{:04X}", keysym & 0x00FF_FFFF);
    }
    match keysym {
        0xFF0D => "Return".to_owned(),
        0xFF09 => "Tab".to_owned(),
        0xFF08 => "BackSpace".to_owned(),
        0xFFFF => "Delete".to_owned(),
        0xFF1B => "Escape".to_owned(),
        0xFF51 => "Right".to_owned(),
        0xFF52 => "Up".to_owned(),
        0xFF53 => "Left".to_owned(),
        0xFF54 => "Down".to_owned(),
        0xFF50 => "Home".to_owned(),
        0xFF57 => "End".to_owned(),
        0xFF55 => "Prior".to_owned(),
        0xFF56 => "Next".to_owned(),
        0xFFBE..=0xFFC9 => format!("F{}", keysym - 0xFFBE + 1),
        0x20 => "space".to_owned(),
        0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A => {
            char::from_u32(keysym).expect("ASCII").to_string()
        }
        _ => ascii_punct_symbol(keysym).unwrap_or_else(|| format!("U{keysym:04X}")),
    }
}

/// XKB names for ASCII punctuation: the only valid spelling inside
/// `[ ... ]`. Returns `None` outside ASCII punctuation (the caller falls
/// back to the `U` escape).
fn ascii_punct_symbol(keysym: u32) -> Option<String> {
    let name = match keysym {
        0x21 => "exclam",
        0x22 => "quotedbl",
        0x23 => "numbersign",
        0x24 => "dollar",
        0x25 => "percent",
        0x26 => "ampersand",
        0x27 => "apostrophe",
        0x28 => "parenleft",
        0x29 => "parenright",
        0x2A => "asterisk",
        0x2B => "plus",
        0x2C => "comma",
        0x2D => "minus",
        0x2E => "period",
        0x2F => "slash",
        0x3A => "colon",
        0x3B => "semicolon",
        0x3C => "less",
        0x3D => "equal",
        0x3E => "greater",
        0x3F => "question",
        0x40 => "at",
        0x5B => "bracketleft",
        0x5C => "backslash",
        0x5D => "bracketright",
        0x5E => "asciicircum",
        0x5F => "underscore",
        0x60 => "grave",
        0x7B => "braceleft",
        0x7C => "bar",
        0x7D => "braceright",
        0x7E => "asciitilde",
        _ => return None,
    };
    Some(name.to_owned())
}

/// Placement of one requested keysym: the evdev-style code the
/// `zwp_virtual_keyboard_v1.key` request wants (XKB keycode - 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyPlacement {
    pub evdev_code: u32,
}

/// A generated XKB keymap: the NUL-free text plus the evdev code of each
/// modifier and the placement of each requested keysym, in order.
#[derive(Debug, Clone)]
pub struct GeneratedKeymap {
    /// Full `xkb_keymap { ... }` text (the caller appends the NUL, whose
    /// byte the `size` argument counts).
    pub text: String,
    pub ctrl_code: u32,
    pub shift_code: u32,
    pub alt_code: u32,
    pub super_code: u32,
    pub placements: Vec<KeyPlacement>,
}

/// Build an XKB keymap text binding the four modifier keys plus every
/// keysym in `keysyms` to sequential keycodes: modifiers at
/// `XKB_KEYCODE_BASE..+4`, caller keys after. Each key binds its exact
/// keysym at level 1 with both levels identical, so Shift never changes the
/// glyph and no Shift synthesis is ever needed. Past the caps this fails
/// instead of paging: one bounded operation uploads exactly one keymap.
pub fn generate_keymap(keysyms: &[u32]) -> Result<GeneratedKeymap, KeymapError> {
    if keysyms.len() > MAX_DISTINCT_KEYS {
        return Err(KeymapError::TooManyKeys { count: keysyms.len() });
    }
    let ctrl_kc = XKB_KEYCODE_BASE;
    let shift_kc = XKB_KEYCODE_BASE + 1;
    let alt_kc = XKB_KEYCODE_BASE + 2;
    let super_kc = XKB_KEYCODE_BASE + 3;
    let first_key_kc = XKB_KEYCODE_BASE + 4;
    let max_kc = first_key_kc + keysyms.len() as u32;

    let mut keycodes = String::new();
    keycodes.push_str("xkb_keycodes \"gentle-dot\" {\n");
    keycodes.push_str(&format!("  minimum = {XKB_KEYCODE_BASE};\n"));
    // The maximum always covers at least the modifiers, so even an empty
    // keysym list (a modifiers-only combo keymap) stays well-formed.
    keycodes.push_str(&format!("  maximum = {};\n", max_kc.max(first_key_kc)));
    for kc in XKB_KEYCODE_BASE..max_kc.max(first_key_kc) {
        keycodes.push_str(&format!("  <K{kc}> = {kc};\n"));
    }
    keycodes.push_str("};\n");

    let types = "xkb_types \"gentle-dot\" { include \"complete\" };\n";
    let compat = "xkb_compat \"gentle-dot\" { include \"complete\" };\n";

    let mut symbols = String::new();
    symbols.push_str("xkb_symbols \"gentle-dot\" {\n");
    symbols.push_str(&format!("  key <K{ctrl_kc}> {{ [ Control_L ] }};\n"));
    symbols.push_str(&format!("  key <K{shift_kc}> {{ [ Shift_L ] }};\n"));
    symbols.push_str(&format!("  key <K{alt_kc}> {{ [ Alt_L ] }};\n"));
    symbols.push_str(&format!("  key <K{super_kc}> {{ [ Super_L ] }};\n"));
    let mut placements = Vec::with_capacity(keysyms.len());
    for (i, &keysym) in keysyms.iter().enumerate() {
        let kc = first_key_kc + i as u32;
        let symbol = xkb_symbol_name(keysym);
        symbols.push_str(&format!("  key <K{kc}> {{ [ {symbol}, {symbol} ] }};\n"));
        placements.push(KeyPlacement { evdev_code: kc - 8 });
    }
    symbols.push_str(&format!("  modifier_map Control {{ <K{ctrl_kc}> }};\n"));
    symbols.push_str(&format!("  modifier_map Shift {{ <K{shift_kc}> }};\n"));
    symbols.push_str(&format!("  modifier_map Mod1 {{ <K{alt_kc}> }};\n"));
    symbols.push_str(&format!("  modifier_map Mod4 {{ <K{super_kc}> }};\n"));
    symbols.push_str("};\n");

    let text = format!("xkb_keymap {{\n{keycodes}{types}{compat}{symbols}}};\n");
    if text.len() > MAX_KEYMAP_BYTES {
        return Err(KeymapError::KeymapTooLarge { bytes: text.len() });
    }
    Ok(GeneratedKeymap {
        text,
        ctrl_code: ctrl_kc - 8,
        shift_code: shift_kc - 8,
        alt_code: alt_kc - 8,
        super_code: super_kc - 8,
        placements,
    })
}
