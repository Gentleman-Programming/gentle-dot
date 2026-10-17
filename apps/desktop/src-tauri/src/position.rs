//! Persistence of the Dot in `<data dir>/desktop.json`: its position and
//! whether the user hid it (S26.1). Each write keeps the other field.
//!
//! UNIDAD (Niri/Linux, aditiva): el ancla única de la unidad rosa-panel es
//! el spot compacto del PANEL en memoria de sesión (`Shell::native_compact`,
//! `CompactSpot`: output + posición lógica); la rosa deriva beside-panel
//! (derecha-centrada, `PANEL_GAP`) y nunca se persiste por separado. Quién la
//! escribe: SOLO el mover del usuario (EventStream rosa/panel, lado que
//! movió) y la captura explícita hide/expand; los movimientos propios del
//! worker NUNCA la reescriben (anti-ping-pong por construcción). Cada evento
//! (reopen/unhide/follow/restore) calcula AMBOS destinos desde el ancla y
//! mueve ambas ventanas en la misma pasada (hasta dos AdjustFixed exact-id,
//! un hold del lock, misma época; Niri no tiene batch atómico). En Niri no
//! se lee ni escribe `dot_points` / `panel_points` / `panel_spot`: esas
//! claves solo sirven al path app-owned (X11/macOS/otros, intacto y
//! prioritario) o quedan como legacy parseado sin migrar ni borrar del
//! disco. La pref `rose_hidden` sí persiste y manda sobre la visibilidad.
//! Límite honesto: Niri no pre-posiciona ventanas nuevas (la rosa remapeada
//! aparece en su default, p.ej. centro exacto); el ancla se impone DESPUÉS
//! del mapeo bajo gated opacity-0 + reveal tras settle — sin afirmar píxel.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::Mutex;

/// Serializes in-process read-modify-write updates so concurrent
/// `save`/`save_rose_hidden`/`save_panel` calls cannot lose sibling fields.
static STATE_LOCK: Mutex<()> = Mutex::new(());

/// Top-left corner of the Dot window, in logical points.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DotPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DesktopState {
    /// Older builds saved `dot` in physical pixels; that key is ignored.
    dot_points: Option<DotPosition>,
    /// Missing in files written before the rose could be hidden.
    /// `None` preserves absence so sibling saves never synthesize an explicit
    /// choice; the startup fallback is selected by the caller.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rose_hidden: Option<bool>,
    /// Where the panel was when it was last hidden; missing before T1 persisted it.
    /// Legacy only: the shell keeps the hidden-panel spot in memory for the
    /// running session and no longer reads or writes this field, so it never
    /// survives an app restart. It stays parsed for old files (no migration,
    /// no deletion) and keeps surviving sibling updates untouched.
    #[serde(default)]
    panel_points: Option<DotPosition>,
    /// Forward compatibility: unknown keys survive sibling updates untouched.
    #[serde(default, flatten)]
    extra: HashMap<String, serde_json::Value>,
}

/// Reads the state, distinguishing "missing, may initialize" from errors.
/// `Ok(None)` means the file does not exist yet. Any other read or parse
/// failure is an error, so callers never replace a corrupt file with defaults.
fn read_state(path: &Path) -> io::Result<Option<DesktopState>> {
    match std::fs::read_to_string(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
    }
}

fn read(path: &Path) -> Option<DesktopState> {
    read_state(path).ok()?
}

fn write_atomic(path: &Path, state: &DesktopState) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir)?;
        }
    }
    let json = serde_json::to_string_pretty(state).map_err(io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    let wrote = (|| -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true).mode(0o600);
            options.open(&tmp).and_then(|mut file| {
                use std::io::Write;
                file.write_all(json.as_bytes())?;
                file.write_all(b"\n")?;
                file.sync_all()
            })?;
        }
        #[cfg(not(unix))]
        {
            std::fs::write(&tmp, json + "\n")?;
        }
        std::fs::rename(&tmp, path)
    })();
    if wrote.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    wrote
}

/// Conservative updater: a missing file initializes from defaults, but parse
/// and read errors return without touching the file, preserving siblings and
/// unknown keys. Writes go through a temp file plus rename.
fn update(path: &Path, mutate: impl FnOnce(&mut DesktopState)) -> io::Result<()> {
    let _guard = STATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = read_state(path)?.unwrap_or_default();
    mutate(&mut state);
    write_atomic(path, &state)
}

/// The saved position, or `None` when the file is missing or unreadable.
pub fn load(path: &Path) -> Option<DotPosition> {
    read(path)?.dot_points
}

pub fn save(path: &Path, position: DotPosition) -> io::Result<()> {
    update(path, |state| state.dot_points = Some(position))
}

/// Whether the user hid the rose; false when the file is missing or unreadable.
pub fn load_rose_hidden(path: &Path) -> bool {
    load_rose_hidden_or(path, false)
}

/// Whether the user hid the rose, falling back to `default` when the file is
/// missing, the field is absent, or the file is unreadable. An explicit saved
/// `true`/`false` always wins; the default is never written back here.
pub fn load_rose_hidden_or(path: &Path, default: bool) -> bool {
    read(path).and_then(|state| state.rose_hidden).unwrap_or(default)
}

pub fn save_rose_hidden(path: &Path, hidden: bool) -> io::Result<()> {
    update(path, |state| state.rose_hidden = Some(hidden))
}

/// Where the panel was when it was last hidden, or `None` when it was never
/// hidden while persistence existed, or the file is missing or unreadable.
/// Legacy reader for old files: the shell no longer calls this at startup
/// (session-only memory starts empty) and never writes it back. A stale spot
/// stays safe to return for callers that still clamp it inside the current
/// display. Never read on native Wayland, where the compositor owns placement.
pub fn load_panel(path: &Path) -> Option<DotPosition> {
    read(path)?.panel_points
}

/// Remembers the panel spot, keeping the Dot position and the rose choice.
/// Legacy writer, kept so old files still parse: the shell no longer calls
/// this (hidden-panel memory is session-only and never touches the disk).
pub fn save_panel(path: &Path, position: DotPosition) -> io::Result<()> {
    update(path, |state| state.panel_points = Some(position))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-scratch").join(name);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trips_through_the_file() {
        let file = scratch("round-trip").join("nested/desktop.json");
        save(&file, DotPosition { x: -68, y: 400 }).unwrap();
        assert_eq!(load(&file), Some(DotPosition { x: -68, y: 400 }));
        save(&file, DotPosition { x: 1852, y: 12 }).unwrap();
        assert_eq!(load(&file), Some(DotPosition { x: 1852, y: 12 }));
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(json["dot_points"]["x"], 1852);
    }

    #[test]
    fn ignores_positions_saved_in_physical_pixels() {
        // Older builds saved `dot` in physical pixels; read as points it would be off screen.
        let file = scratch("legacy").join("desktop.json");
        fs::write(&file, r#"{ "dot": { "x": 3688, "y": 1036 } }"#).unwrap();
        assert_eq!(load(&file), None);
    }

    #[test]
    fn the_rose_is_shown_unless_the_file_says_hidden() {
        let dir = scratch("rose-default");
        assert!(!load_rose_hidden(&dir.join("absent.json")));
        // Files written before the rose could be hidden still load, position included.
        let old = dir.join("old.json");
        fs::write(&old, r#"{ "dot_points": { "x": 12, "y": 400 } }"#).unwrap();
        assert!(!load_rose_hidden(&old));
        assert_eq!(load(&old), Some(DotPosition { x: 12, y: 400 }));
        let corrupt = dir.join("corrupt.json");
        fs::write(&corrupt, "{ nope").unwrap();
        assert!(!load_rose_hidden(&corrupt));
    }

    #[test]
    fn hiding_the_rose_is_remembered_and_keeps_the_position() {
        let file = scratch("rose-hidden").join("desktop.json");
        fs::write(&file, "{}").unwrap();
        save(&file, DotPosition { x: 1852, y: 12 }).unwrap();
        save_rose_hidden(&file, true).unwrap();
        assert!(load_rose_hidden(&file));
        assert_eq!(load(&file), Some(DotPosition { x: 1852, y: 12 }));
        // Moving the Dot later keeps the choice, and showing it again is remembered too.
        save(&file, DotPosition { x: 12, y: 300 }).unwrap();
        assert!(load_rose_hidden(&file));
        save_rose_hidden(&file, false).unwrap();
        assert!(!load_rose_hidden(&file));
        assert_eq!(load(&file), Some(DotPosition { x: 12, y: 300 }));
    }

    #[test]
    fn missing_file_yields_none() {
        assert_eq!(load(&scratch("missing").join("absent.json")), None);
    }

    #[test]
    fn panel_spot_round_trips_through_the_file() {
        // The scratch directory persists across runs, so save before asserting.
        let file = scratch("panel-round-trip").join("nested/desktop.json");
        save_panel(&file, DotPosition { x: 300, y: 200 }).unwrap();
        assert_eq!(load_panel(&file), Some(DotPosition { x: 300, y: 200 }));
        save_panel(&file, DotPosition { x: 1488, y: 428 }).unwrap();
        assert_eq!(load_panel(&file), Some(DotPosition { x: 1488, y: 428 }));
    }

    #[test]
    fn panel_spot_keeps_the_dot_and_the_rose_choice() {
        let file = scratch("panel-keeps-rest").join("desktop.json");
        save(&file, DotPosition { x: 1852, y: 12 }).unwrap();
        save_rose_hidden(&file, true).unwrap();
        save_panel(&file, DotPosition { x: 300, y: 200 }).unwrap();
        assert_eq!(load(&file), Some(DotPosition { x: 1852, y: 12 }));
        assert!(load_rose_hidden(&file));
        assert_eq!(load_panel(&file), Some(DotPosition { x: 300, y: 200 }));
        // Moving the Dot later keeps the panel spot, and vice versa.
        save(&file, DotPosition { x: 12, y: 300 }).unwrap();
        assert_eq!(load_panel(&file), Some(DotPosition { x: 300, y: 200 }));
        save_panel(&file, DotPosition { x: 12, y: 300 }).unwrap();
        assert_eq!(load(&file), Some(DotPosition { x: 12, y: 300 }));
        assert!(load_rose_hidden(&file));
    }

    #[test]
    fn panel_spot_defaults_to_none_for_old_or_unreadable_files() {
        let dir = scratch("panel-default");
        assert_eq!(load_panel(&dir.join("absent.json")), None);
        // Files written before the panel spot existed still load, other fields included.
        let old = dir.join("old.json");
        fs::write(&old, r#"{ "dot_points": { "x": 12, "y": 400 }, "rose_hidden": true }"#).unwrap();
        assert_eq!(load_panel(&old), None);
        assert_eq!(load(&old), Some(DotPosition { x: 12, y: 400 }));
        assert!(load_rose_hidden(&old));
        let corrupt = dir.join("corrupt.json");
        fs::write(&corrupt, "{ nope").unwrap();
        assert_eq!(load_panel(&corrupt), None);
    }

    #[test]
    fn corrupt_file_is_left_unchanged_by_failed_saves() {
        let dir = scratch("corrupt-preserved");
        let file = dir.join("desktop.json");
        fs::write(&file, "{ nope").unwrap();
        let before = fs::read(&file).unwrap();
        assert!(save(&file, DotPosition { x: 12, y: 300 }).is_err());
        assert!(save_rose_hidden(&file, true).is_err());
        assert!(save_panel(&file, DotPosition { x: 1, y: 2 }).is_err());
        assert_eq!(fs::read(&file).unwrap(), before);
        // Loads still report absence, and no temp file leaks.
        assert_eq!(load(&file), None);
        assert_eq!(load_panel(&file), None);
        assert!(!load_rose_hidden(&file));
        let leftover: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("tmp"))
            .collect();
        assert!(leftover.is_empty(), "{leftover:?}");
    }

    #[test]
    fn unknown_keys_survive_sibling_updates() {
        let file = scratch("unknown-keys").join("desktop.json");
        fs::write(
            &file,
            r#"{ "dot_points": { "x": 12, "y": 400 }, "future": { "niri": true }, "v": 3 }"#,
        )
        .unwrap();
        save_panel(&file, DotPosition { x: 300, y: 200 }).unwrap();
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(json["future"]["niri"], true);
        assert_eq!(json["v"], 3);
        assert_eq!(json["dot_points"]["x"], 12);
        assert_eq!(json["panel_points"]["x"], 300);
        save_rose_hidden(&file, true).unwrap();
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(json["future"]["niri"], true);
        assert!(json["rose_hidden"].as_bool().unwrap());
    }

    #[test]
    fn concurrent_sibling_saves_keep_both_fields() {
        use std::thread;
        let file = scratch("concurrent-siblings").join("desktop.json");
        fs::write(&file, "{}").unwrap();
        let a = file.clone();
        let b = file.clone();
        let t1 = thread::spawn(move || {
            for i in 0..20 {
                save(&a, DotPosition { x: i, y: 400 }).unwrap();
            }
        });
        let t2 = thread::spawn(move || {
            for _ in 0..20 {
                save_rose_hidden(&b, true).unwrap();
            }
        });
        t1.join().unwrap();
        t2.join().unwrap();
        assert_eq!(load(&file), Some(DotPosition { x: 19, y: 400 }));
        assert!(load_rose_hidden(&file));
    }

    #[test]
    fn corrupt_file_yields_none() {
        let dir = scratch("corrupt");
        for (name, body) in [("garbage.json", "{ nope"), ("wrong.json", r#"{ "dot_points": { "x": "a" } }"#), ("empty.json", "{}")] {
            let file = dir.join(name);
            fs::write(&file, body).unwrap();
            assert_eq!(load(&file), None, "{name}");
        }
    }

    #[test]
    fn missing_or_legacy_rose_field_falls_back_to_selected_default() {
        let dir = scratch("rose-default-aware");
        let absent = dir.join("absent.json");
        assert_eq!(load_rose_hidden_or(&absent, false), false);
        assert_eq!(load_rose_hidden_or(&absent, true), true);
        // Legacy file without the rose key: the selected default wins.
        let old = dir.join("old.json");
        fs::write(&old, r#"{ "dot_points": { "x": 12, "y": 400 } }"#).unwrap();
        assert_eq!(load_rose_hidden_or(&old, false), false);
        assert_eq!(load_rose_hidden_or(&old, true), true);
        // Corrupt files fall back too, without being rewritten.
        let corrupt = dir.join("corrupt.json");
        fs::write(&corrupt, "{ nope").unwrap();
        let before = fs::read(&corrupt).unwrap();
        assert_eq!(load_rose_hidden_or(&corrupt, false), false);
        assert_eq!(load_rose_hidden_or(&corrupt, true), true);
        assert_eq!(fs::read(&corrupt).unwrap(), before);
    }

    #[test]
    fn explicit_rose_choice_wins_over_selected_default() {
        let dir = scratch("rose-explicit-wins");
        let shown = dir.join("shown.json");
        fs::write(&shown, r#"{ "rose_hidden": false }"#).unwrap();
        assert_eq!(load_rose_hidden_or(&shown, false), false);
        assert_eq!(load_rose_hidden_or(&shown, true), false);
        let hidden = dir.join("hidden.json");
        fs::write(&hidden, r#"{ "rose_hidden": true }"#).unwrap();
        assert_eq!(load_rose_hidden_or(&hidden, false), true);
        assert_eq!(load_rose_hidden_or(&hidden, true), true);
    }

    #[test]
    fn sibling_saves_preserve_absent_rose_field() {
        let dir = scratch("rose-absence-preserved");
        let file = dir.join("desktop.json");
        fs::write(&file, r#"{ "dot_points": { "x": 12, "y": 400 } }"#).unwrap();
        save(&file, DotPosition { x: 12, y: 300 }).unwrap();
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert!(json.get("rose_hidden").is_none(), "{json}");
        assert_eq!(load_rose_hidden_or(&file, true), true);
        save_panel(&file, DotPosition { x: 300, y: 200 }).unwrap();
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert!(json.get("rose_hidden").is_none(), "{json}");
        // An explicit false stays explicit through sibling updates.
        save_rose_hidden(&file, false).unwrap();
        save(&file, DotPosition { x: 1, y: 2 }).unwrap();
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(json["rose_hidden"], false);
        assert_eq!(load_rose_hidden_or(&file, true), false);
    }
}
