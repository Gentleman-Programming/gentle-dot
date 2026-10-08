//! Persistence of the Dot position in `<data dir>/desktop.json`.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

/// Top-left corner of the Dot window, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DotPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DesktopState {
    dot: Option<DotPosition>,
}

/// The saved position, or `None` when the file is missing or unreadable.
pub fn load(path: &Path) -> Option<DotPosition> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<DesktopState>(&text).ok()?.dot
}

pub fn save(path: &Path, position: DotPosition) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let state = DesktopState { dot: Some(position) };
    let json = serde_json::to_string_pretty(&state).map_err(io::Error::other)?;
    std::fs::write(path, json + "\n")
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
        assert_eq!(json["dot"]["x"], 1852);
    }

    #[test]
    fn missing_file_yields_none() {
        assert_eq!(load(&scratch("missing").join("absent.json")), None);
    }

    #[test]
    fn corrupt_file_yields_none() {
        let dir = scratch("corrupt");
        for (name, body) in [("garbage.json", "{ nope"), ("wrong.json", r#"{ "dot": { "x": "a" } }"#), ("empty.json", "{}")] {
            let file = dir.join(name);
            fs::write(&file, body).unwrap();
            assert_eq!(load(&file), None, "{name}");
        }
    }
}
