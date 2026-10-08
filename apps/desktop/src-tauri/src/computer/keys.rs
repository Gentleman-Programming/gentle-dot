//! Key combos for the `key` tool (S24.2), such as `cmd+shift+t` or `return`, parsed into
//! modifiers and one macOS virtual key code (ANSI layout).

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub cmd: bool,
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
    pub fn_key: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyCombo {
    pub modifiers: Modifiers,
    /// Canonical key name, for messages and the risk check.
    pub key: &'static str,
    /// macOS virtual key code (`kVK_*`).
    pub code: u16,
}

impl KeyCombo {
    /// Return (or Enter) with any modifiers: the key that submits forms and sends messages.
    pub fn is_return(&self) -> bool {
        self.key == "return"
    }

    /// Space with any modifiers: it presses the focused button.
    pub fn is_space(&self) -> bool {
        self.key == "space"
    }
}

/// Named keys and their virtual key codes. Single characters use the ANSI layout.
const KEYS: &[(&str, u16)] = &[
    ("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8), ("v", 9),
    ("b", 11), ("q", 12), ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17), ("1", 18), ("2", 19),
    ("3", 20), ("4", 21), ("6", 22), ("5", 23), ("=", 24), ("9", 25), ("7", 26), ("-", 27), ("8", 28),
    ("0", 29), ("]", 30), ("o", 31), ("u", 32), ("[", 33), ("i", 34), ("p", 35), ("return", 36), ("l", 37),
    ("j", 38), ("'", 39), ("k", 40), (";", 41), ("\\", 42), (",", 43), ("/", 44), ("n", 45), ("m", 46),
    (".", 47), ("tab", 48), ("space", 49), ("`", 50), ("delete", 51), ("escape", 53), ("f5", 96), ("f6", 97),
    ("f7", 98), ("f3", 99), ("f8", 100), ("f9", 101), ("f11", 103), ("f10", 109), ("f12", 111), ("home", 115),
    ("pageup", 116), ("forwarddelete", 117), ("f4", 118), ("end", 119), ("f2", 120), ("pagedown", 121),
    ("f1", 122), ("left", 123), ("right", 124), ("down", 125), ("up", 126),
];

/// Other spellings of the named keys.
const ALIASES: &[(&str, &str)] = &[
    ("enter", "return"), ("esc", "escape"), ("backspace", "delete"), ("del", "forwarddelete"),
    ("page_up", "pageup"), ("page_down", "pagedown"), ("arrowleft", "left"), ("arrowright", "right"),
    ("arrowup", "up"), ("arrowdown", "down"), ("minus", "-"), ("equal", "="),
    ("comma", ","), ("period", "."), ("slash", "/"), ("backslash", "\\"),
];

/// Parses `mod+mod+key`: case-insensitive, parts joined by `+`, any number of modifiers
/// (`cmd`, `shift`, `alt`/`option`, `ctrl`/`control`, `fn`) and exactly one key.
pub fn parse_combo(combo: &str) -> Result<KeyCombo, String> {
    let mut modifiers = Modifiers::default();
    let mut key = None;
    for part in combo.split('+') {
        let part = part.trim().to_lowercase();
        let flag = match part.as_str() {
            "cmd" | "command" => &mut modifiers.cmd,
            "shift" => &mut modifiers.shift,
            "alt" | "option" | "opt" => &mut modifiers.alt,
            "ctrl" | "control" => &mut modifiers.ctrl,
            "fn" => &mut modifiers.fn_key,
            _ => {
                if key.is_some() {
                    return Err(format!("`{combo}` names more than one key"));
                }
                let name = ALIASES.iter().find(|(alias, _)| *alias == part).map_or(part.as_str(), |(_, name)| name);
                let found = KEYS.iter().find(|(known, _)| *known == name);
                key = Some(*found.ok_or_else(|| format!("unknown key `{part}` in `{combo}`"))?);
                continue;
            }
        };
        *flag = true;
    }
    let (key, code) = key.ok_or_else(|| format!("`{combo}` names no key"))?;
    Ok(KeyCombo { modifiers, key, code })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mods(cmd: bool, shift: bool, alt: bool, ctrl: bool) -> Modifiers {
        Modifiers { cmd, shift, alt, ctrl, fn_key: false }
    }

    #[test]
    fn a_plain_named_key() {
        let combo = parse_combo("return").unwrap();
        assert_eq!((combo.key, combo.code, combo.modifiers), ("return", 36, Modifiers::default()));
    }

    #[test]
    fn modifiers_and_a_letter() {
        let combo = parse_combo("cmd+shift+t").unwrap();
        assert_eq!((combo.key, combo.code, combo.modifiers), ("t", 17, mods(true, true, false, false)));
    }

    #[test]
    fn modifier_spellings_and_case_are_accepted() {
        let combo = parse_combo(" Command + Option + Control + A ").unwrap();
        assert_eq!((combo.key, combo.code, combo.modifiers), ("a", 0, mods(true, false, true, true)));
        assert_eq!(parse_combo("opt+ctrl+left").unwrap().modifiers, mods(false, false, true, true));
        assert!(parse_combo("fn+f1").unwrap().modifiers.fn_key);
    }

    #[test]
    fn aliases_name_the_same_key() {
        assert_eq!(parse_combo("enter").unwrap().code, 36);
        assert_eq!(parse_combo("esc").unwrap().code, 53);
        assert_eq!(parse_combo("backspace").unwrap().code, 51);
        assert_eq!(parse_combo("cmd+minus").unwrap().code, 27);
    }

    #[test]
    fn digits_punctuation_and_function_keys() {
        assert_eq!(parse_combo("cmd+1").unwrap().code, 18);
        assert_eq!(parse_combo("cmd+,").unwrap().code, 43);
        assert_eq!(parse_combo("f12").unwrap().code, 111);
        assert_eq!(parse_combo("space").unwrap().code, 49);
    }

    #[test]
    fn invalid_combos_are_rejected() {
        for combo in ["", "cmd+", "cmd", "cmd+shift", "cmd+a+b", "hyper+a", "f13", "cmd++a"] {
            assert!(parse_combo(combo).is_err(), "{combo:?} should be rejected");
        }
    }

    #[test]
    fn return_is_recognized_with_any_modifiers() {
        assert!(parse_combo("return").unwrap().is_return());
        assert!(parse_combo("cmd+return").unwrap().is_return());
        assert!(parse_combo("ctrl+enter").unwrap().is_return());
        assert!(!parse_combo("tab").unwrap().is_return());
    }
}
