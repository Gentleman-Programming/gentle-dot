//! The panel shortcut chosen in Settings (S33): which combinations are allowed, their spelling,
//! and applying a new one without a restart.

use crate::computer::app::PANIC_SHORTCUT;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

pub const UNREADABLE: &str = "Gentle Dot cannot use that key combination. Try another one.";
pub const NEEDS_MODIFIER: &str =
    "Add ⌘, ⌥ or ⌃ (Super, Alt or Ctrl), or use a function key (F1–F24). Shift alone would capture your typing.";
pub const RESERVED_PANIC: &str = "⌥⇧Esc (Alt+Shift+Esc) is reserved for stopping computer control.";
pub const ESC_ALONE: &str = "Esc alone closes the panel. Add a modifier key or choose another key.";
pub const TAKEN: &str = "That shortcut is taken by the system or another app.";
pub const SAME_AS_PANEL: &str = "That shortcut already opens the panel. Choose another one for voice.";

const FUNCTION_KEYS: [Code; 24] = [
    Code::F1,
    Code::F2,
    Code::F3,
    Code::F4,
    Code::F5,
    Code::F6,
    Code::F7,
    Code::F8,
    Code::F9,
    Code::F10,
    Code::F11,
    Code::F12,
    Code::F13,
    Code::F14,
    Code::F15,
    Code::F16,
    Code::F17,
    Code::F18,
    Code::F19,
    Code::F20,
    Code::F21,
    Code::F22,
    Code::F23,
    Code::F24,
];

fn parse(text: &str) -> Option<Shortcut> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    text.parse().ok()
}

/// Whether two spellings name the same keys.
pub fn same_keys(a: &str, b: &str) -> bool {
    matches!((parse(a), parse(b)), (Some(a), Some(b)) if a == b)
}

/// One spelling per combination: modifiers in the order ⌃⌥⇧⌘, then the key
/// (`K` for KeyK, `1` for Digit1, the key's code name otherwise).
fn spell(shortcut: &Shortcut) -> String {
    let mut parts: Vec<String> = [
        (Modifiers::CONTROL, "Ctrl"),
        (Modifiers::ALT, "Alt"),
        (Modifiers::SHIFT, "Shift"),
        (Modifiers::SUPER, "Super"),
    ]
    .into_iter()
    .filter(|(modifier, _)| shortcut.mods.contains(*modifier))
    .map(|(_, name)| name.to_string())
    .collect();
    let code = shortcut.key.to_string();
    let key = code.strip_prefix("Key").or_else(|| code.strip_prefix("Digit")).filter(|rest| rest.len() == 1);
    parts.push(key.map_or_else(|| code.clone(), str::to_string));
    parts.join("+")
}

/// Checks a requested shortcut and returns its normal spelling, or why it cannot be used.
pub fn normalize(text: &str) -> Result<String, String> {
    let shortcut = parse(text).ok_or(UNREADABLE)?;
    if shortcut.mods.is_empty() && shortcut.key == Code::Escape {
        return Err(ESC_ALONE.into());
    }
    if parse(PANIC_SHORTCUT) == Some(shortcut) {
        return Err(RESERVED_PANIC.into());
    }
    // Shift alone would take over typing: ⇧K is a capital K in every app.
    if shortcut.mods.difference(Modifiers::SHIFT).is_empty() && !FUNCTION_KEYS.contains(&shortcut.key) {
        return Err(NEEDS_MODIFIER.into());
    }
    Ok(spell(&shortcut))
}

/// What applying a shortcut needs from the running app.
pub trait Host {
    /// Makes the shortcut toggle the panel; fails when the system or another app holds it.
    fn bind_toggle(&self, shortcut: &str) -> Result<(), String>;
    /// Makes the shortcut record while held and send when released; same failure rule as `bind_toggle`.
    fn bind_voice(&self, shortcut: &str) -> Result<(), String>;
    fn unbind(&self, shortcut: &str);
    /// Saves the shortcut in `config.json`.
    fn save(&self, shortcut: &str) -> Result<(), String>;
    /// Saves the voice shortcut in `config.json`, or turns it off with `None`.
    fn save_voice(&self, shortcut: Option<&str>) -> Result<(), String>;
    /// Shows the shortcut on the tray's "Open" item.
    fn label_tray(&self, shortcut: &str);
}

/// Applies a new panel shortcut at once. The new one is bound before the old one is released,
/// so a refused or unsaved change leaves the old one working. Returns the saved spelling.
pub fn apply(host: &impl Host, current: Option<&str>, requested: &str) -> Result<String, String> {
    let shortcut = normalize(requested)?;
    let rebind = !current.is_some_and(|current| same_keys(current, &shortcut));
    if rebind {
        host.bind_toggle(&shortcut).map_err(|_| TAKEN.to_string())?;
    }
    if let Err(error) = host.save(&shortcut) {
        if rebind {
            host.unbind(&shortcut);
        }
        return Err(error);
    }
    if let Some(current) = current.filter(|_| rebind) {
        host.unbind(current);
    }
    host.label_tray(&shortcut);
    Ok(shortcut)
}

/// Applies a new voice shortcut at once, or `None` to turn it off. The new one is bound before the
/// old one is released, so a refused or unsaved change leaves the old one working. Returns the
/// saved spelling. `panel` is the panel shortcut: the same keys cannot hold both gestures.
pub fn apply_voice(
    host: &impl Host,
    panel: &str,
    current: Option<&str>,
    requested: Option<&str>,
) -> Result<Option<String>, String> {
    let shortcut = match requested {
        Some(text) => Some(normalize(text)?),
        None => None,
    };
    if let Some(shortcut) = &shortcut {
        if same_keys(panel, shortcut) {
            return Err(SAME_AS_PANEL.to_string());
        }
    }
    let rebind = match (&shortcut, current) {
        (Some(next), Some(current)) => !same_keys(current, next),
        (Some(_), None) => true,
        (None, Some(_)) => false,
        (None, None) => false,
    };
    if rebind {
        host.bind_voice(shortcut.as_deref().unwrap_or_default()).map_err(|_| TAKEN.to_string())?;
    }
    if let Err(error) = host.save_voice(shortcut.as_deref()) {
        if rebind {
            host.unbind(shortcut.as_deref().unwrap_or_default());
        }
        return Err(error);
    }
    if shortcut.is_none() {
        if let Some(current) = current {
            host.unbind(current);
        }
    } else if let Some(current) = current.filter(|_| rebind) {
        host.unbind(current);
    }
    Ok(shortcut)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn normalizes_any_spelling() {
        assert_eq!(normalize("alt+space"), Ok("Alt+Space".to_string()));
        assert_eq!(normalize(" Option + Space "), Ok("Alt+Space".to_string()));
        assert_eq!(normalize("Cmd+Shift+K"), Ok("Shift+Super+K".to_string()));
        assert_eq!(normalize("super+shift+control+alt+Digit1"), Ok("Ctrl+Alt+Shift+Super+1".to_string()));
        assert_eq!(normalize("CTRL+ArrowUp"), Ok("Ctrl+ArrowUp".to_string()));
        assert_eq!(normalize("Command+KeyK"), Ok("Super+K".to_string()));
    }

    #[test]
    fn a_normalized_shortcut_reads_back_as_the_same_keys() {
        for spelling in ["Alt+Space", "Cmd+Shift+K", "ctrl+alt+Digit7", "F5", "Shift+F12", "Super+Slash"] {
            let normalized = normalize(spelling).unwrap();
            assert_eq!(normalize(&normalized), Ok(normalized.clone()), "{spelling}");
            assert!(same_keys(spelling, &normalized), "{spelling}");
        }
    }

    #[test]
    fn refuses_what_it_cannot_read() {
        for text in ["", "   ", "Alt+", "Alt+Shift", "Hyper+K", "Alt+K+J", "Ctrl+Nope"] {
            assert_eq!(normalize(text), Err(UNREADABLE.to_string()), "{text:?}");
        }
    }

    #[test]
    fn needs_a_modifier_unless_it_is_a_function_key() {
        assert_eq!(normalize("K"), Err(NEEDS_MODIFIER.to_string()));
        assert_eq!(normalize("Space"), Err(NEEDS_MODIFIER.to_string()));
        assert_eq!(normalize("Digit1"), Err(NEEDS_MODIFIER.to_string()));
        assert_eq!(normalize("F1"), Ok("F1".to_string()));
        assert_eq!(normalize("f24"), Ok("F24".to_string()));
        // Shift alone would capture typing (⇧K is a capital K in every app).
        assert_eq!(normalize("Shift+K"), Err(NEEDS_MODIFIER.to_string()));
        assert_eq!(normalize("Shift+Space"), Err(NEEDS_MODIFIER.to_string()));
        assert_eq!(normalize("Shift+F5"), Ok("Shift+F5".to_string()));
        assert_eq!(normalize("Ctrl+Shift+K"), Ok("Ctrl+Shift+K".to_string()));
    }

    #[test]
    fn refuses_the_panic_shortcut_in_any_spelling() {
        for text in ["Alt+Shift+Escape", "shift+option+esc", "Shift + Alt + ESC"] {
            assert_eq!(normalize(text), Err(RESERVED_PANIC.to_string()), "{text}");
        }
        // Other modifiers with Esc are not the panic shortcut.
        assert_eq!(normalize("Ctrl+Shift+Escape"), Ok("Ctrl+Shift+Escape".to_string()));
    }

    #[test]
    fn refuses_esc_alone() {
        assert_eq!(normalize("Escape"), Err(ESC_ALONE.to_string()));
        assert_eq!(normalize("esc"), Err(ESC_ALONE.to_string()));
    }

    /// Records what `apply` asks of the app, in order.
    #[derive(Default)]
    struct FakeHost {
        taken: Vec<&'static str>,
        save_error: Option<&'static str>,
        calls: RefCell<Vec<String>>,
    }

    impl Host for FakeHost {
        fn bind_toggle(&self, shortcut: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("bind {shortcut}"));
            if self.taken.contains(&shortcut) {
                Err("HotKey already registered".into())
            } else {
                Ok(())
            }
        }
        fn bind_voice(&self, shortcut: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("bind voice {shortcut}"));
            if self.taken.contains(&shortcut) {
                Err("HotKey already registered".into())
            } else {
                Ok(())
            }
        }
        fn unbind(&self, shortcut: &str) {
            self.calls.borrow_mut().push(format!("unbind {shortcut}"));
        }
        fn save(&self, shortcut: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("save {shortcut}"));
            self.save_error.map_or(Ok(()), |error| Err(error.to_string()))
        }
        fn save_voice(&self, shortcut: Option<&str>) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("save voice {}", shortcut.unwrap_or("off")));
            self.save_error.map_or(Ok(()), |error| Err(error.to_string()))
        }
        fn label_tray(&self, shortcut: &str) {
            self.calls.borrow_mut().push(format!("tray {shortcut}"));
        }
    }

    fn calls(host: &FakeHost) -> Vec<String> {
        host.calls.borrow().clone()
    }

    #[test]
    fn applies_a_new_shortcut_live_and_releases_the_old_one() {
        // The changed shortcut is the one that toggles the panel, and the tray's Open item shows it.
        let host = FakeHost::default();
        assert_eq!(apply(&host, Some("Alt+Space"), "cmd+shift+k"), Ok("Shift+Super+K".to_string()));
        assert_eq!(
            calls(&host),
            ["bind Shift+Super+K", "save Shift+Super+K", "unbind Alt+Space", "tray Shift+Super+K"]
        );
    }

    #[test]
    fn keeps_the_old_shortcut_when_the_new_one_is_taken() {
        let host = FakeHost { taken: vec!["Ctrl+Alt+K"], ..FakeHost::default() };
        assert_eq!(apply(&host, Some("Alt+Space"), "Ctrl+Alt+K"), Err(TAKEN.to_string()));
        assert_eq!(calls(&host), ["bind Ctrl+Alt+K"]);
    }

    #[test]
    fn keeps_the_old_shortcut_when_it_cannot_be_saved() {
        let host = FakeHost { save_error: Some("config.json is not valid JSON"), ..FakeHost::default() };
        assert_eq!(apply(&host, Some("Alt+Space"), "Ctrl+Alt+K"), Err("config.json is not valid JSON".to_string()));
        assert_eq!(calls(&host), ["bind Ctrl+Alt+K", "save Ctrl+Alt+K", "unbind Ctrl+Alt+K"]);
    }

    #[test]
    fn refused_combinations_never_reach_the_app() {
        let host = FakeHost::default();
        assert_eq!(apply(&host, Some("Alt+Space"), "Alt+Shift+Esc"), Err(RESERVED_PANIC.to_string()));
        assert_eq!(apply(&host, Some("Alt+Space"), "K"), Err(NEEDS_MODIFIER.to_string()));
        assert!(calls(&host).is_empty());
    }

    #[test]
    fn the_same_keys_in_another_spelling_are_only_saved() {
        // Binding the shortcut that is already bound would fail as "taken".
        let host = FakeHost::default();
        assert_eq!(apply(&host, Some("option+space"), "Alt+Space"), Ok("Alt+Space".to_string()));
        assert_eq!(calls(&host), ["save Alt+Space", "tray Alt+Space"]);
    }

    #[test]
    fn binds_without_releasing_when_nothing_was_bound() {
        let host = FakeHost::default();
        assert_eq!(apply(&host, None, "F5"), Ok("F5".to_string()));
        assert_eq!(calls(&host), ["bind F5", "save F5", "tray F5"]);
    }

    #[test]
    fn applies_the_voice_shortcut_without_touching_the_tray() {
        let host = FakeHost::default();
        assert_eq!(apply_voice(&host, "Alt+Space", None, Some("ctrl+alt+v")), Ok(Some("Ctrl+Alt+V".into())));
        assert_eq!(calls(&host), ["bind voice Ctrl+Alt+V", "save voice Ctrl+Alt+V"]);
        // The same keys in another spelling are only saved: a second bind would fail as taken.
        let host = FakeHost::default();
        assert_eq!(apply_voice(&host, "Alt+Space", Some("ctrl+alt+v"), Some("Ctrl+Alt+V")), Ok(Some("Ctrl+Alt+V".into())));
        assert_eq!(calls(&host), ["save voice Ctrl+Alt+V"]);
        // A changed shortcut is bound before the old one is released.
        let host = FakeHost::default();
        assert_eq!(apply_voice(&host, "Alt+Space", Some("Ctrl+Alt+V"), Some("F6")), Ok(Some("F6".into())));
        assert_eq!(calls(&host), ["bind voice F6", "save voice F6", "unbind Ctrl+Alt+V"]);
    }

    #[test]
    fn turning_the_voice_shortcut_off_releases_it() {
        let host = FakeHost::default();
        assert_eq!(apply_voice(&host, "Alt+Space", Some("Ctrl+Alt+V"), None), Ok(None));
        assert_eq!(calls(&host), ["save voice off", "unbind Ctrl+Alt+V"]);
        // Already off: nothing to release, nothing to bind.
        let host = FakeHost::default();
        assert_eq!(apply_voice(&host, "Alt+Space", None, None), Ok(None));
        assert_eq!(calls(&host), ["save voice off"]);
    }

    #[test]
    fn the_voice_shortcut_refuses_the_panel_keys_and_taken_combinations() {
        let host = FakeHost::default();
        assert_eq!(apply_voice(&host, "Alt+Space", None, Some("option+space")), Err(SAME_AS_PANEL.to_string()));
        assert_eq!(apply_voice(&host, "Alt+Space", None, Some("Alt+Shift+Esc")), Err(RESERVED_PANIC.to_string()));
        assert_eq!(apply_voice(&host, "Alt+Space", None, Some("K")), Err(NEEDS_MODIFIER.to_string()));
        assert!(calls(&host).is_empty());
        let host = FakeHost { taken: vec!["F7"], ..FakeHost::default() };
        assert_eq!(apply_voice(&host, "Alt+Space", Some("F6"), Some("F7")), Err(TAKEN.to_string()));
        assert_eq!(calls(&host), ["bind voice F7"]);
    }

    #[test]
    fn a_voice_shortcut_that_cannot_be_saved_is_released_again() {
        let host = FakeHost { save_error: Some("config.json is not valid JSON"), ..FakeHost::default() };
        assert_eq!(
            apply_voice(&host, "Alt+Space", Some("F6"), Some("F7")),
            Err("config.json is not valid JSON".to_string())
        );
        assert_eq!(calls(&host), ["bind voice F7", "save voice F7", "unbind F7"]);
    }
}
