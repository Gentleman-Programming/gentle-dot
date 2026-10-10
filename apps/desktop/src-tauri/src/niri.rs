//! Linux-only Niri pure window-selection/geometry helpers.
//!
//! This first Niri slice owns no socket, transport, action, or shell wiring:
//! it selects the single own window by exact PID and title, decodes floating
//! geometry, and associates compact spots with outputs. Transport, actions,
//! and mode policy arrive in later slices.

use serde_json::Value;

/// A window owned by this app: its Niri id, tiling/floating mode, size, the
/// logical `tile_pos_in_workspace_view` (`None` may occur, e.g. during an
/// interactive move, so it is skipped, never read as the origin), and its
/// workspace.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelWindow {
    pub id: u64,
    pub floating: bool,
    pub size: (i32, i32),
    pub pos: Option<(f64, f64)>,
    pub workspace: Option<u64>,
}

/// The single window owned by `pid` with exactly `title`. `None` when
/// missing, id-less, or ambiguous: never a focused-window fallback, never an
/// app-id guess.
pub fn own_panel(payload: &Value, pid: u32, title: &str) -> Option<PanelWindow> {
    let windows = payload.as_array().or_else(|| payload.get("Windows")?.as_array())?;
    let mut found = None;
    for window in windows {
        let Some(id) = window.get("id").and_then(Value::as_u64) else { continue };
        let owned = window.get("pid").and_then(Value::as_u64) == Some(u64::from(pid));
        let titled = window.get("title").and_then(Value::as_str) == Some(title);
        if !(owned && titled) {
            continue;
        }
        let layout = window.get("layout");
        let size = layout.and_then(|layout| layout.get("window_size")).and_then(Value::as_array);
        let (width, height) = match size {
            Some(pair) if pair.len() == 2 => {
                (pair[0].as_i64().unwrap_or(0) as i32, pair[1].as_i64().unwrap_or(0) as i32)
            }
            _ => (0, 0),
        };
        let pos = layout.and_then(|layout| layout.get("tile_pos_in_workspace_view")).and_then(|pos| {
            let pair = pos.as_array()?;
            if pair.len() != 2 {
                return None;
            }
            Some((pair[0].as_f64()?, pair[1].as_f64()?))
        });
        if found.is_some() {
            return None; // Ambiguous: two windows claim this pid and title.
        }
        found = Some(PanelWindow {
            id,
            floating: window.get("is_floating").and_then(Value::as_bool).unwrap_or(false),
            size: (width, height),
            pos,
            workspace: window.get("workspace_id").and_then(Value::as_u64),
        });
    }
    found
}

/// Convenience for the exact production title (`crate::platform::PANEL_TITLE`).
pub fn own_panel_window(payload: &Value, pid: u32) -> Option<PanelWindow> {
    own_panel(payload, pid, crate::platform::PANEL_TITLE)
}

/// Output name for a workspace id; accepts `{"Workspaces":[...]}` or a bare array.
pub fn workspace_output(payload: &Value, workspace: Option<u64>) -> Option<String> {
    let id = workspace?;
    let list = payload.as_array().or_else(|| payload.get("Workspaces")?.as_array())?;
    for entry in list {
        if entry.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        return entry
            .get("output")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .map(str::to_owned);
    }
    None
}

/// A captured floating spot: output plus logical position.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactSpot {
    pub output: String,
    pub x: f64,
    pub y: f64,
}

/// Captures a floating panel's logical spot. Tiling panels (the expanded
/// normal mode) are never captured; stale null positions and non-finite or
/// non-positive geometry yield `None`. The origin (0,0) is a real spot.
pub fn compact_spot(panel: &PanelWindow, output: Option<String>) -> Option<CompactSpot> {
    if !panel.floating || panel.size.0 <= 0 || panel.size.1 <= 0 {
        return None;
    }
    let (x, y) = panel.pos?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some(CompactSpot { output: output.filter(|name| !name.is_empty())?, x, y })
}

/// Delta that moves the floating panel back to `saved`: same output only
/// (workspace ids need not match, the output frame is identical either way).
pub fn restore_delta(
    saved: &CompactSpot,
    current: Option<(f64, f64)>,
    current_output: Option<&str>,
) -> Option<(i32, i32)> {
    if current_output != Some(saved.output.as_str()) {
        return None;
    }
    let (x, y) = current?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some(((saved.x - x).round() as i32, (saved.y - y).round() as i32))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(id: u64, pid: u64, title: &str, floating: bool, pos: Value) -> Value {
        serde_json::json!({"id": id, "pid": pid, "title": title, "workspace_id": 7,
            "is_floating": floating,
            "layout": {"tile_pos_in_workspace_view": pos, "window_size": [420, 200]}})
    }

    fn panel(floating: bool, size: (i32, i32), pos: Option<(f64, f64)>) -> PanelWindow {
        PanelWindow { id: 1, floating, size, pos, workspace: Some(7) }
    }

    /// A floating panel at a real spot on the first output.
    fn fl(pos: Option<(f64, f64)>) -> PanelWindow {
        panel(true, (420, 200), pos)
    }

    fn out() -> Option<String> {
        Some("DP-1".to_owned())
    }

    #[test]
    fn selects_only_the_unique_pid_and_title_match() {
        let at = serde_json::json!([10.0, 20.0]);
        let payload = serde_json::json!({"Windows": [
            win(1, 100, "Gentle Dot Panel", true, at.clone()),
            win(2, 100, "Gentle Dot", true, at.clone()),
            win(3, 999, "Gentle Dot Panel", true, at.clone()),
            serde_json::json!({"pid": 100, "title": "Gentle Dot Panel"}),
        ]});
        let found = own_panel(&payload, 100, "Gentle Dot Panel").unwrap();
        assert_eq!(found.id, 1);
        assert!(found.floating);
        assert_eq!(found.pos, Some((10.0, 20.0)));
        assert_eq!(found.size, (420, 200));
        assert_eq!(found.workspace, Some(7));
        // The exact production title resolves through the same selector.
        assert_eq!(own_panel_window(&payload, 100), Some(found));
    }

    #[test]
    fn ambiguous_or_missing_panels_are_none() {
        let dup = serde_json::json!({"Windows": [
            win(1, 100, "Gentle Dot Panel", true, Value::Null),
            win(2, 100, "Gentle Dot Panel", false, Value::Null),
        ]});
        assert!(own_panel(&dup, 100, "Gentle Dot Panel").is_none());
        // A bare array (already-unwrapped `Ok.Windows`) is accepted too.
        let bare = Value::Array(vec![win(4, 100, "Gentle Dot Panel", false, Value::Null)]);
        assert_eq!(own_panel(&bare, 100, "Gentle Dot Panel").unwrap().id, 4);
        assert!(own_panel(&serde_json::json!({"Windows": []}), 100, "Gentle Dot Panel").is_none());
    }

    #[test]
    fn compact_spot_captures_only_floating_finite_spots() {
        let floating = fl(Some((10.0, 20.0)));
        let spot = CompactSpot { output: "DP-1".to_owned(), x: 10.0, y: 20.0 };
        assert_eq!(compact_spot(&floating, out()), Some(spot));
        // The origin is a genuine spot; missing or empty outputs are not.
        assert!(compact_spot(&fl(Some((0.0, 0.0))), out()).is_some());
        assert!(compact_spot(&floating, Some(String::new())).is_none());
        assert!(compact_spot(&floating, None).is_none());
        // Expanded (tiling) windows are never captured as compact spots.
        assert!(compact_spot(&panel(false, (420, 640), Some((10.0, 20.0))), out()).is_none());
        // A floated window with a stale null position is skipped, never read as the origin.
        assert!(compact_spot(&fl(None), out()).is_none());
        for bad in [panel(true, (0, 0), Some((10.0, 20.0))), panel(true, (-420, 200), Some((10.0, 20.0)))]
        {
            assert!(compact_spot(&bad, out()).is_none());
        }
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(compact_spot(&fl(Some((bad, 20.0))), out()).is_none());
            assert!(compact_spot(&fl(Some((10.0, bad))), out()).is_none());
        }
    }

    #[test]
    fn restore_needs_the_same_output_and_a_current_spot() {
        let saved = CompactSpot { output: "DP-1".to_owned(), x: 100.0, y: 200.0 };
        assert_eq!(restore_delta(&saved, Some((90.0, 205.0)), Some("DP-1")), Some((10, -5)));
        assert_eq!(restore_delta(&saved, None, Some("DP-1")), None);
        assert_eq!(restore_delta(&saved, Some((90.0, 205.0)), Some("HDMI-1")), None);
        assert_eq!(restore_delta(&saved, Some((90.0, 205.0)), None), None);
        assert_eq!(restore_delta(&saved, Some((f64::NAN, 205.0)), Some("DP-1")), None);
        // Workspace outputs resolve by id; missing or empty outputs never match.
        let workspaces = serde_json::json!({"Workspaces": [{"id": 7, "output": "DP-1"}, {"id": 8}]});
        assert_eq!(workspace_output(&workspaces, Some(7)), Some("DP-1".to_owned()));
        assert_eq!(workspace_output(&workspaces, Some(8)), None);
        assert_eq!(workspace_output(&workspaces, Some(99)), None);
        assert_eq!(workspace_output(&workspaces, None), None);
    }
}
