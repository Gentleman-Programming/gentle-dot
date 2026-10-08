//! Persistence of the Dot in `<data dir>/desktop.json`: its position and
//! whether the user hid it (S26.1). Each write keeps the other field.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

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
    #[serde(default)]
    rose_hidden: bool,
}

fn read(path: &Path) -> Option<DesktopState> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write(path: &Path, state: &DesktopState) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(state).map_err(io::Error::other)?;
    std::fs::write(path, json + "\n")
}

/// The saved position, or `None` when the file is missing or unreadable.
pub fn load(path: &Path) -> Option<DotPosition> {
    read(path)?.dot_points
}

pub fn save(path: &Path, position: DotPosition) -> io::Result<()> {
    let state = read(path).unwrap_or_default();
    write(path, &DesktopState { dot_points: Some(position), ..state })
}

/// Whether the user hid the rose; false when the file is missing or unreadable.
pub fn load_rose_hidden(path: &Path) -> bool {
    read(path).is_some_and(|state| state.rose_hidden)
}

pub fn save_rose_hidden(path: &Path, hidden: bool) -> io::Result<()> {
    let state = read(path).unwrap_or_default();
    write(path, &DesktopState { rose_hidden: hidden, ..state })
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
    fn corrupt_file_yields_none() {
        let dir = scratch("corrupt");
        for (name, body) in [("garbage.json", "{ nope"), ("wrong.json", r#"{ "dot_points": { "x": "a" } }"#), ("empty.json", "{}")] {
            let file = dir.join(name);
            fs::write(&file, body).unwrap();
            assert_eq!(load(&file), None, "{name}");
        }
    }
}
