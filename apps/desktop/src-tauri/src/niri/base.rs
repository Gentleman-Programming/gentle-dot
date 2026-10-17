//! Covered, generation-owned Niri 26.04 work-area calibration.
//! The caller must cover the panel and serialize this transaction with native_io.
use super::{CompactSpot, WINDOWS_REQUEST, WORKSPACES_REQUEST};
use serde_json::Value;
use std::io;
use std::time::{Duration, Instant};

#[derive(PartialEq)]
struct Identity {
    panel: u64,
    workspace: Option<u64>,
    output: String,
    panel_size: (f64, f64),
    rose: Option<(u64, Option<u64>, (f64, f64))>,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn tile_size(windows: &Value, id: u64) -> io::Result<(f64, f64)> {
    let list = windows.as_array().or_else(|| windows.get("Windows")?.as_array());
    let size = list.and_then(|list| list.iter().find(|w| w["id"].as_u64() == Some(id)))
        .and_then(|w| w["layout"]["tile_size"].as_array());
    if let Some(size) = size.filter(|size| size.len() == 2) {
        if let (Some(w), Some(h)) = (size[0].as_f64(), size[1].as_f64()) {
            if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 {
                return Ok((w, h));
            }
        }
    }
    Err(invalid("niri: calibration tile size unavailable"))
}

fn sample(
    pid: u32,
    visible: bool,
    send: &mut impl FnMut(&str) -> io::Result<Value>,
) -> io::Result<(Identity, (f64, f64))> {
    let windows = send(WINDOWS_REQUEST)?;
    let panel = super::own_panel_window(&windows, pid)
        .filter(|w| super::default_anchor_valid(w))
        .ok_or_else(|| invalid("niri: calibration frame unavailable"))?;
    let workspaces = send(WORKSPACES_REQUEST)?;
    let output = super::workspace_output(&workspaces, panel.workspace)
        .ok_or_else(|| invalid("niri: calibration output unavailable"))?;
    let rose = if visible {
        let dot = super::own_dot_window(&windows, pid)
            .filter(|w| super::default_anchor_valid(w))
            .ok_or_else(|| invalid("niri: calibration rose unavailable"))?;
        if super::workspace_output(&workspaces, dot.workspace).as_deref() != Some(&output) {
            return Err(invalid("niri: calibration output changed"));
        }
        Some((dot.id, dot.workspace, tile_size(&windows, dot.id)?))
    } else {
        None
    };
    let identity = Identity {
        panel: panel.id, workspace: panel.workspace, output,
        panel_size: tile_size(&windows, panel.id)?, rose,
    };
    Ok((identity, panel.pos.unwrap()))
}

fn probe_move(id: u64, kind: &str, value: f64) -> String {
    let position = serde_json::json!({(kind): value});
    serde_json::json!({"Action":{"MoveFloatingWindow":{
        "id":id,"x":position,"y":position
    }}}).to_string()
}

pub(crate) fn calibrate(
    pid: u32,
    rose_visible: bool,
    gap: i32,
    margin: f64,
    budget: Duration,
    fresh: impl Fn() -> bool,
    request: &mut impl FnMut(&str, Duration) -> io::Result<Value>,
) -> io::Result<Option<(CompactSpot, super::calibration::WorkAreaEstimate)>> {
    let start = Instant::now();
    let mut send = |wire: &str| {
        if !fresh() {
            return Err(io::Error::from(io::ErrorKind::Interrupted));
        }
        let left = budget.saturating_sub(start.elapsed());
        if left.is_zero() {
            return Err(io::Error::from(io::ErrorKind::TimedOut));
        }
        let result = request(wire, left.min(Duration::from_millis(250)));
        if !fresh() {
            return Err(io::Error::from(io::ErrorKind::Interrupted));
        }
        result
    };
    let result = (|| {
        let version = send("\"Version\"")?;
        if version["Version"].as_str().and_then(|v| v.split_whitespace().next()) != Some("26.04") {
            return Err(invalid("niri: unsupported calibration version"));
        }
        let (identity, _) = sample(pid, rose_visible, &mut send)?;
        let mut positions = Vec::new();
        // Fixed(1) must move exactly one logical pixel from Fixed(0).
        // Handled alone cannot establish acceptance (e.g. a grabbed window).
        for (kind, value) in [("SetFixed",0.0),("SetFixed",1.0),("SetFixed",0.0),("SetProportion",100.0)] {
            let reply = send(&probe_move(identity.panel, kind, value))?;
            if !super::is_handled(&reply) {
                return Err(invalid("niri: unexpected calibration action response"));
            }
            let (current, pos) = sample(pid, rose_visible, &mut send)?;
            if current != identity {
                return Err(invalid("niri: calibration frame changed"));
            }
            positions.push(pos);
            if positions.len() == 2 && pos != (positions[0].0+1.0,positions[0].1+1.0) {
                return Err(invalid("niri: calibration movement rejected"));
            }
            if positions.len() == 3 && pos != positions[0] {
                return Err(invalid("niri: calibration movement rejected"));
            }
        }
        let work = super::calibration::infer_work_area_logical(positions[0],positions[3],identity.panel_size)
            .ok_or_else(|| invalid("niri: calibration work area invalid"))?;
        let base = super::calibration::upper_right_base_logical(
            work,identity.panel_size,identity.rose.map(|(_,_,size)|size),f64::from(gap),margin,
        ).ok_or_else(|| invalid("niri: calibration unit does not fit"))?;
        Ok(Some((
            CompactSpot {output:identity.output,x:base.panel.0,y:base.panel.1},
            work,
        )))
    })();
    match result {
        Err(_) if !fresh() => Ok(None),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::{Cell, RefCell};

    struct Compositor {
        pos: Cell<(f64, f64)>,
        accept: bool,
        version: &'static str,
        log: RefCell<Vec<Value>>,
    }

    impl Compositor {
        fn new(accept: bool) -> Self {
            Self { pos: Cell::new((200.0, 100.0)), accept, version: "26.04 (test)", log: RefCell::new(vec![]) }
        }

        fn request(&self, wire: &str, _: Duration) -> io::Result<Value> {
            let request: Value = serde_json::from_str(wire)?;
            self.log.borrow_mut().push(request.clone());
            if request == json!("Version") {
                return Ok(json!({"Version": self.version}));
            }
            if request == json!("Workspaces") {
                return Ok(json!({"Workspaces": [{"id":7,"output":"DP-1"}]}));
            }
            if request == json!("Windows") {
                return Ok(json!({"Windows": [
                    {"id":9,"pid":42,"title":crate::platform::PANEL_TITLE,
                     "workspace_id":7,"is_floating":true,
                     "layout":{"window_size":[420,640],"tile_size":[420.5,640.5],
                               "tile_pos_in_workspace_view":self.pos.get()}},
                    {"id":7,"pid":42,"title":crate::platform::DOT_TITLE,
                     "workspace_id":7,"is_floating":true,
                     "layout":{"window_size":[72,72],"tile_size":[72.0,72.0],
                               "tile_pos_in_workspace_view":[300.0,100.0]}}
                ]}));
            }
            let move_window = &request["Action"]["MoveFloatingWindow"];
            assert_eq!(move_window["id"], 9, "never move the focused or another application's window");
            if self.accept {
                let axis = |v: &Value, origin: f64, extent: f64| {
                    if let Some(value) = v["SetFixed"].as_f64() {
                        origin + value
                    } else {
                        assert_eq!(v["SetProportion"], 100.0);
                        origin + extent - 75.0
                    }
                };
                self.pos.set((axis(&move_window["x"],12.0,1280.0),axis(&move_window["y"],30.0,1000.0)));
            }
            Ok(json!("Handled"))
        }
    }

    #[test]
    fn calibrates_upper_right_pair_and_panel_alone() {
        for (visible, x) in [(true,779.5),(false,859.5)] {
            let server = Compositor::new(true);
            let mut request = |wire: &str, timeout| server.request(wire, timeout);
            let result = calibrate(42,visible,8,12.0,Duration::from_secs(1),||true,&mut request);
            let (spot, work) = result.unwrap().expect("a calibrated base");
            assert_eq!(spot,CompactSpot {output:"DP-1".into(),x,y:42.0});
            // The same probes measure the work area the clamp needs (S7).
            assert_eq!(work.origin,(12.0,30.0));
            assert_eq!(work.size,(1280.0,1000.0));
            let log = server.log.borrow();
            assert_eq!(log[0],json!("Version"));
            assert!(log.iter().any(|wire| wire["Action"]["MoveFloatingWindow"]["x"]["SetProportion"] == 100.0));
        }
    }

    #[test]
    fn handled_without_motion_is_rejected_and_window_stays_unchanged() {
        let server = Compositor::new(false);
        let mut request = |wire: &str, timeout| server.request(wire, timeout);
        let result = calibrate(42,true,8,12.0,Duration::from_secs(1),||true,&mut request);
        assert_eq!(result.unwrap_err().to_string(),"niri: calibration movement rejected");
        assert_eq!(server.pos.get(),(200.0,100.0));
        assert!(!server.log.borrow().iter().any(|wire| wire["Action"]["MoveFloatingWindow"]["x"]["SetProportion"] == 100.0));
    }

    #[test]
    fn unsupported_version_has_no_geometry_side_effects() {
        let mut server = Compositor::new(true);
        server.version = "26.05 (test)";
        let mut request = |wire: &str, timeout| server.request(wire, timeout);
        let result = calibrate(42,true,8,12.0,Duration::from_secs(1),||true,&mut request);
        assert_eq!(result.unwrap_err().to_string(),"niri: unsupported calibration version");
        assert_eq!(*server.log.borrow(),vec![json!("Version")]);
        assert_eq!(server.pos.get(),(200.0,100.0));
    }

    #[test]
    fn stale_generation_sends_nothing_and_commits_nothing() {
        let server = Compositor::new(true);
        let mut request = |wire: &str, timeout| server.request(wire, timeout);
        let result = calibrate(42,true,8,12.0,Duration::from_secs(1),||false,&mut request);
        assert!(result.unwrap().is_none());
        assert!(server.log.borrow().is_empty());
        assert_eq!(server.pos.get(),(200.0,100.0));
    }
}
