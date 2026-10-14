//! Bounded shared-window restore planner/identity helper (T10/T11/T12/T19).
//! Dormant (no caller, native FALSE): ONE panel surface across Pair/PanelOnly/
//! RoseOnly/Fullscreen, never the DOT (no DOT selector/move). The remembered
//! CompactSpot stays the PANEL anchor; RoseOnly translates (+428,+284)
//! transiently and clamps the 72px rose footprint. No work-area cache survives:
//! prepare remeasures under cover (panel-only base::calibrate, 420x640) and
//! derives the mode plan, preserving the anchor and clamping only the planned
//! target. Fullscreen plans nothing (the managed path owns it). No state
//! mutexes: freshness and socket I/O arrive as closures, so no lock spans a
//! socket/GTK wait. Shell order: cover, resize 420x640, prepare, resize to
//! cover, resize 420x640, prepare, resize to surface_size, finish, reveal.
//!
//! Primary tile contract (niri-ipc 26.04): tile_size INCLUDES decorations, so a
//! client 500x640 may sit in a tile 508x648 or fractional 503.2x643.2 with a
//! valid window_offset_in_tile. Enclosure, never round-equality.

use super::calibration::{WorkAreaEstimate, clamp_unit_inside, upper_right_base_logical};
use super::{CompactSpot, PanelWindow, WINDOWS_REQUEST, WORKSPACES_REQUEST, action_move_floating, is_handled, own_panel_window, workspace_output};
use serde_json::Value;
use std::io;
use std::time::{Duration, Instant};

/// Fixed extents mirroring unit_surface without GTK, so this stays portable.
pub const PANEL_WINDOW: (i32, i32) = (420, 640);
pub const PAIR_WINDOW: (i32, i32) = (500, 640);
pub const ROSE_WINDOW: (i32, i32) = (72, 72);
/// Rose top-left inside the pair (right of panel+gap, vertically centered).
pub const ROSE_OFFSET: (i32, i32) = (428, 284);
/// Per-request socket share; the aggregate budget stays caller-owned.
const PASS: Duration = Duration::from_millis(250);

/// IPC Outputs request (niri-ipc 26.04 `Request::Outputs`): a name-keyed map
/// of outputs, each carrying an optional `logical` {x,y,width,height,scale,
/// transform}. Niri exposes no work-area or struts field, so this only
/// identifies the layout — never the usable area.
pub const OUTPUTS_REQUEST: &str = "\"Outputs\"";

/// IPC Layers request (niri-ipc 26.04 `Request::Layers`): answers the live
/// layer-shell set (`LayerSurface` namespace/output/layer/interactivity).
/// Read-only and cheap: the hit path re-queries it before trusting a cache entry.
pub const LAYERS_REQUEST: &str = "\"Layers\"";

/// Layout identity for one output: the name plus the logical geometry from
/// the IPC Outputs reply. Any mode/scale/rotation change alters it, so a
/// cached work area measured under a different key must be re-measured.
#[derive(Debug, Clone, PartialEq)]
pub struct OutputKey {
    pub output: String,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub transform: String,
}

/// Covered calibration cached per output: the measured work area plus the
/// observed client offset (the keep-visible/clamp behaviour) plus the
/// layer-shell set observed while measuring. Valid only while the live
/// output key still equals `key` AND the live layer set still equals `layers`.
///
/// Known limit, inherent and not yet closed: niri exposes no work area and no
/// strut geometry, so a bar that grows in place - same layer surface, no
/// config reload - keeps this entry looking valid, and only the finish
/// re-query catches it, once niri actually clamps the stale position.
/// Accepted because closing it would need a heuristic re-probe, not a signal.
#[derive(Debug, Clone, PartialEq)]
pub struct CachedCalibration {
    pub key: OutputKey,
    pub area: WorkAreaEstimate,
    pub panel_offset: Option<(f64, f64)>,
    pub layers: Vec<LayerIdentity>,
}

/// Layout key for one output from an Outputs reply (`{"Outputs": {...}}`
/// or a bare map/array, entries carrying `name` plus `logical`). `None`
/// when the output is absent, unmapped (`logical: null`), or
/// non-finite/non-positive: never a fabricated key.
pub fn output_key(outputs: &Value, output: &str) -> Option<OutputKey> {
    if output.is_empty() {
        return None;
    }
    let payload = outputs.get("Outputs").unwrap_or(outputs);
    let entries: Vec<&Value> = match payload {
        Value::Object(map) => map.values().collect(),
        Value::Array(list) => list.iter().collect(),
        _ => return None,
    };
    let entry = entries.into_iter().find(|item| item.get("name").and_then(Value::as_str) == Some(output))?;
    let logical = entry.get("logical")?;
    if logical.is_null() {
        return None;
    }
    let width = logical.get("width")?.as_u64()?;
    let height = logical.get("height")?.as_u64()?;
    let scale = logical.get("scale")?.as_f64()?;
    let transform = logical.get("transform")?.as_str()?;
    if width == 0 || height == 0 || width > u64::from(u32::MAX) || height > u64::from(u32::MAX) {
        return None;
    }
    if !scale.is_finite() || scale <= 0.0 || transform.is_empty() {
        return None;
    }
    Some(OutputKey {
        output: output.to_owned(),
        width: width as u32,
        height: height as u32,
        scale,
        transform: transform.to_owned(),
    })
}

/// Canonical identity of one layer-shell surface for environment-change
/// detection (T10/S7): namespace, output, layer and keyboard interactivity
/// only — the `Layers` payload carries no geometry, so this answers "did
/// the set change" (when the work area may have changed), never "how".
/// Sorted before comparison so wire order never fakes a change.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct LayerIdentity {
    pub namespace: String,
    pub output: String,
    pub layer: String,
    pub keyboard_interactivity: String,
}

/// Parsed `Layers` payload from a request reply or event line, if present:
/// `Some` (possibly empty — a removed bar is a real observation) for a
/// top-level `Layers` array of LayerSurface-shaped objects, `None` when the
/// payload carries no such array. Entries missing any string field are
/// skipped, never invented.
pub fn layer_snapshot(event: &Value) -> Option<Vec<LayerIdentity>> {
    let list = event
        .get("Layers")
        .or_else(|| event.get("Ok")?.get("Layers"))?
        .as_array()?;
    let mut snapshot: Vec<LayerIdentity> = list
        .iter()
        .filter_map(|entry| {
            Some(LayerIdentity {
                namespace: entry.get("namespace")?.as_str()?.to_owned(),
                output: entry.get("output")?.as_str()?.to_owned(),
                layer: entry.get("layer")?.as_str()?.to_owned(),
                keyboard_interactivity: entry.get("keyboard_interactivity")?.as_str()?.to_owned(),
            })
        })
        .collect();
    snapshot.sort();
    Some(snapshot)
}

/// Whether the line is a compositor config-reload signal: any `ConfigLoaded`
/// payload, success or failure — a reload is when a bar or its exclusive
/// zone usually changes, and an extra re-probe on a failed reload is the
/// fail-safe direction (never a stale reuse).
pub fn is_config_loaded(event: &Value) -> bool {
    event.get("ConfigLoaded").is_some()
}

/// Whether this event-stream line invalidates the covered calibration (T10/S7).
/// `ConfigLoaded` always invalidates (a live 26.04 event); a `Layers` payload
/// invalidates when its parsed set differs from `last`, but 26.04 exposes no
/// such event — `Layers` there is a request/response pair, so this arm only
/// serves future niri versions while the live check is the read-only query.
/// Records the new baseline either way — the first observation only seeds it.
pub fn environment_invalidates(event: &Value, last: &mut Option<Vec<LayerIdentity>>) -> bool {
    if is_config_loaded(event) {
        return true;
    }
    let Some(snapshot) = layer_snapshot(event) else {
        return false;
    };
    if last.as_ref() == Some(&snapshot) {
        return false;
    }
    let known = last.is_some();
    *last = Some(snapshot);
    known
}

/// Which single surface the shared window currently shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitRestoreMode {
    Pair,
    PanelOnly,
    RoseOnly,
    Fullscreen,
}
use UnitRestoreMode as M;

/// Fresh work area plus the panel identity it was measured against.
/// Per-transition only: never cached across jobs. Carries the calibration
/// window_offset as the anchor plane (client origin inside the panel tile).
#[derive(Debug, Clone, PartialEq)]
pub struct MeasuredArea {
    pub output: String,
    pub workspace: Option<u64>,
    pub panel_id: u64,
    pub area: WorkAreaEstimate,
    pub panel_offset: Option<(f64, f64)>,
}

/// Committable restore: `remembered` is the preserved anchor (never the
/// clamp); the clamp moves only the PLANNED `surface_target`. Consumed by `finish`
/// (move + requery + reveal), which returns `remembered` untouched.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedRestore {
    pub pid: u32,
    pub mode: UnitRestoreMode,
    pub measured: MeasuredArea,
    pub surface_target: (f64, f64),
    pub remembered: CompactSpot,
    pub surface_size: (i32, i32),
    pub gap: i32,
    pub margin: f64,
    pub bootstrapped: bool,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Fixed surface size per mode; Fullscreen fills the compositor frame, so that
/// path stays explicit with the caller (managed tiling, never this planner).
pub fn surface_size(mode: UnitRestoreMode) -> Option<(i32, i32)> {
    match mode {
        M::Pair => Some(PAIR_WINDOW),
        M::PanelOnly => Some(PANEL_WINDOW),
        M::RoseOnly => Some(ROSE_WINDOW),
        M::Fullscreen => None,
    }
}

/// Fullscreen is effective only for an open stored-expanded window; anything
/// else leaves the compact anchor (and this planner) untouched.
pub fn fullscreen_effective(mode: UnitRestoreMode, open: bool, stored_expanded: bool) -> bool {
    mode == M::Fullscreen && open && stored_expanded
}

/// Clamped surface top-left for a panel anchor: Pair/PanelOnly clamp the panel
/// footprint; RoseOnly clamps the translated 72px rose footprint. `None` on
/// non-finite/empty anchors, Fullscreen, or no fit: never fabricated.
pub fn plan_surface_target(
    anchor: &CompactSpot,
    mode: UnitRestoreMode,
    area: &WorkAreaEstimate,
    margin: f64,
) -> Option<(f64, f64)> {
    if anchor.output.is_empty() || !anchor.x.is_finite() || !anchor.y.is_finite() {
        return None;
    }
    match mode {
        M::Pair => clamp_unit_inside(*area, (500.0, 640.0), (anchor.x, anchor.y), margin),
        M::PanelOnly => clamp_unit_inside(*area, (420.0, 640.0), (anchor.x, anchor.y), margin),
        M::RoseOnly => clamp_unit_inside(
            *area,
            (72.0, 72.0),
            (anchor.x + f64::from(ROSE_OFFSET.0), anchor.y + f64::from(ROSE_OFFSET.1)),
            margin,
        ),
        M::Fullscreen => None,
    }
}

/// Panel anchor implied by a rose-surface position (exact inverse translate).
pub fn capture_from_rose_surface(output: &str, rose: (f64, f64)) -> Option<CompactSpot> {
    if output.is_empty() || !rose.0.is_finite() || !rose.1.is_finite() {
        return None;
    }
    Some(CompactSpot {
        output: output.to_owned(),
        x: rose.0 - f64::from(ROSE_OFFSET.0),
        y: rose.1 - f64::from(ROSE_OFFSET.1),
    })
}

/// Bootstrap panel anchor from a fresh panel-only measurement, accounting the
/// FULL mode footprint: a 420-wide panel base would leave a Pair rose outside.
pub fn bootstrap_anchor(
    output: &str,
    area: &WorkAreaEstimate,
    mode: UnitRestoreMode,
    gap: f64,
    margin: f64,
) -> Option<CompactSpot> {
    if output.is_empty() {
        return None;
    }
    let rose = match mode {
        M::Pair | M::RoseOnly => Some((72.0, 72.0)),
        M::PanelOnly => None,
        M::Fullscreen => return None,
    };
    let base = upper_right_base_logical(*area, (420.0, 640.0), rose, gap, margin)?;
    Some(CompactSpot { output: output.to_owned(), x: base.panel.0, y: base.panel.1 })
}

/// Whether the observed panel is still the measured one: floating, same id,
/// workspace and output, finite mapped position. Size is checked separately
/// against the mode surface (the shell resizes between prepare and finish).
pub fn panel_matches(panel: &PanelWindow, measured: &MeasuredArea, output: Option<&str>) -> bool {
    panel.floating
        && panel.id == measured.panel_id
        && panel.workspace == measured.workspace
        && output == Some(measured.output.as_str())
        && matches!(panel.pos, Some((x, y)) if x.is_finite() && y.is_finite())
}

/// Finite positive tile extents for one id. The tile INCLUDES compositor
/// decorations (niri-ipc 26.04), so callers must never equate it with the
/// integer client window size: enclosure, not equality.
fn panel_tile(windows: &Value, id: u64) -> Option<(f64, f64)> {
    let list = windows.as_array().or_else(|| windows.get("Windows")?.as_array())?;
    let tile = list
        .iter()
        .find(|window| window.get("id").and_then(Value::as_u64) == Some(id))?
        .get("layout")?
        .get("tile_size")?
        .as_array()?;
    let [width, height] = tile.as_slice() else { return None };
    let (width, height) = (width.as_f64()?, height.as_f64()?);
    (width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0).then_some((width, height))
}

/// Whether a tile may frame its client: finite positive tile enclosing the
/// integer window, with an optional offset that is finite, non-negative and
/// keeps the client inside the tile. Borders (tile 508 vs client 500, or
/// fractional 503.2) are legitimate; shrink or overflow is not.
fn tile_encloses(tile: (f64, f64), window: (i32, i32), offset: Option<(f64, f64)>) -> bool {
    if !(tile.0.is_finite() && tile.1.is_finite() && tile.0 > 0.0 && tile.1 > 0.0) {
        return false;
    }
    if tile.0 < f64::from(window.0) || tile.1 < f64::from(window.1) {
        return false;
    }
    match offset {
        None => true,
        Some((ox, oy)) => {
            ox.is_finite() && oy.is_finite() && ox >= 0.0 && oy >= 0.0
                && ox + f64::from(window.0) <= tile.0
                && oy + f64::from(window.1) <= tile.1
        }
    }
}

/// Rose client origin from a panel tile origin: the stored panel offset plus
/// client layout offsets, minus the current rose offset. All offsets explicit;
/// None on non-finite or negative offsets, never a misplaced guess.
pub fn rose_origin_aligned(panel_tile: (f64, f64), panel_offset: (f64, f64), rose_offset: (f64, f64)) -> Option<(f64, f64)> {
    for value in [panel_tile.0, panel_tile.1, panel_offset.0, panel_offset.1, rose_offset.0, rose_offset.1] {
        if !value.is_finite() {
            return None;
        }
    }
    if panel_offset.0 < 0.0 || panel_offset.1 < 0.0 || rose_offset.0 < 0.0 || rose_offset.1 < 0.0 {
        return None;
    }
    Some((
        panel_tile.0 + panel_offset.0 + f64::from(ROSE_OFFSET.0) - rose_offset.0,
        panel_tile.1 + panel_offset.1 + f64::from(ROSE_OFFSET.1) - rose_offset.1,
    ))
}

/// Inverse of the aligned origin: the panel tile origin implied by a rose tile
/// position with explicit measured (panel) and transient (rose) offsets.
pub fn capture_rose_aligned(output: &str, rose_tile: (f64, f64), rose_offset: (f64, f64), panel_offset: (f64, f64)) -> Option<CompactSpot> {
    if output.is_empty() {
        return None;
    }
    for value in [rose_tile.0, rose_tile.1, rose_offset.0, rose_offset.1, panel_offset.0, panel_offset.1] {
        if !value.is_finite() {
            return None;
        }
    }
    if rose_offset.0 < 0.0 || rose_offset.1 < 0.0 || panel_offset.0 < 0.0 || panel_offset.1 < 0.0 {
        return None;
    }
    Some(CompactSpot {
        output: output.to_owned(),
        x: rose_tile.0 + rose_offset.0 - panel_offset.0 - f64::from(ROSE_OFFSET.0),
        y: rose_tile.1 + rose_offset.1 - panel_offset.1 - f64::from(ROSE_OFFSET.1),
    })
}

/// Client origin inside its tile (`window_offset_in_tile`, border size
/// included); None when absent or null, which callers treat as borderless
/// only when the tile already equals the window.
fn panel_offset(windows: &Value, id: u64) -> Option<(f64, f64)> {
    let list = windows.as_array().or_else(|| windows.get("Windows")?.as_array())?;
    let offset = list
        .iter()
        .find(|window| window.get("id").and_then(Value::as_u64) == Some(id))?
        .get("layout")?
        .get("window_offset_in_tile")?;
    if offset.is_null() {
        return None;
    }
    let pair = offset.as_array()?;
    let [x, y] = pair.as_slice() else { return None };
    Some((x.as_f64()?, y.as_f64()?))
}

/// One bounded request share: stale generations return `None` (commit/send
/// nothing further) instead of failing, so a superseded job simply stops.
fn send(
    request: &mut impl FnMut(&str, Duration) -> io::Result<Value>,
    budget: Duration,
    start: Instant,
    fresh: &impl Fn() -> bool,
    wire: &str,
) -> io::Result<Option<Value>> {
    if !fresh() {
        return Ok(None);
    }
    let left = budget.saturating_sub(start.elapsed());
    if left.is_zero() {
        return Err(io::Error::new(io::ErrorKind::TimedOut, "niri: restore budget exceeded"));
    }
    let outcome = request(wire, left.min(PASS));
    if !fresh() {
        return Ok(None);
    }
    outcome.map(Some)
}

/// Fresh floating panel plus its output and tile extents; `None` on stale,
/// `Err` on unusable.
fn sample(
    pid: u32,
    request: &mut impl FnMut(&str, Duration) -> io::Result<Value>,
    budget: Duration,
    start: Instant,
    fresh: &impl Fn() -> bool,
) -> io::Result<Option<(PanelWindow, Option<String>, Option<(f64, f64)>, Option<(f64, f64)>)>> {
    let Some(windows) = send(request, budget, start, fresh, WINDOWS_REQUEST)? else {
        return Ok(None);
    };
    let Some(panel) = own_panel_window(&windows, pid).filter(|window| window.floating) else {
        return Err(invalid("niri: restore panel unavailable"));
    };
    let tile = panel_tile(&windows, panel.id);
    let offset = panel_offset(&windows, panel.id);
    let Some(workspaces) = send(request, budget, start, fresh, WORKSPACES_REQUEST)? else {
        return Ok(None);
    };
    let workspace = panel.workspace;
    Ok(Some((panel, workspace_output(&workspaces, workspace), tile, offset)))
}

/// Calibrate panel-only under the caller's cover, then derive the mode plan.
/// `None` anchor bootstraps from the fresh measurement (full mode footprint);
/// `Some` preserves the remembered spot and clamps only the planned target.
/// Fullscreen and stale generations yield `Ok(None)` (the latter having sent
/// nothing further); no-fit/drift/unsupported are explicit `Err`.
#[allow(clippy::too_many_arguments)]
pub fn prepare(
    pid: u32,
    anchor: Option<&CompactSpot>,
    mode: UnitRestoreMode,
    gap: i32,
    margin: f64,
    budget: Duration,
    fresh: impl Fn() -> bool,
    request: &mut impl FnMut(&str, Duration) -> io::Result<Value>,
) -> io::Result<Option<PreparedRestore>> {
    if mode == M::Fullscreen || !fresh() {
        return Ok(None);
    }
    let start = Instant::now();
    let mut probed = |wire: &str, _: Duration| match send(request, budget, start, &fresh, wire) {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Err(io::Error::new(io::ErrorKind::Interrupted, "niri: restore superseded")),
        Err(error) => Err(error),
    };
    let calibrated = super::base::calibrate(
        pid,
        false,
        gap,
        margin,
        budget.saturating_sub(start.elapsed()),
        || fresh(),
        &mut probed,
    )?;
    let Some((_, work)) = calibrated else { return Ok(None) };
    let Some((panel, output, _, offset)) = sample(pid, request, budget, start, &fresh)? else {
        return Ok(None);
    };
    let output = output.ok_or_else(|| invalid("niri: restore output unavailable"))?;
    let measured = MeasuredArea { output, workspace: panel.workspace, panel_id: panel.id, area: work, panel_offset: offset };
    let size = surface_size(mode).ok_or_else(|| invalid("niri: restore mode unsupported"))?;
    let remembered = match anchor {
        Some(spot) if spot.output == measured.output => spot.clone(),
        Some(_) => return Err(invalid("niri: restore output changed")),
        None => bootstrap_anchor(&measured.output, &work, mode, f64::from(gap), margin)
            .ok_or_else(|| invalid("niri: restore unit does not fit"))?,
    };
    let surface_target = plan_surface_target(&remembered, mode, &work, margin)
        .ok_or_else(|| invalid("niri: restore unit does not fit"))?;
    Ok(Some(PreparedRestore { pid, mode, measured, surface_target, remembered, surface_size: size, gap, margin, bootstrapped: anchor.is_none() }))
}

/// Accepted settle error between the re-queried IPC position and the planned
/// target, per axis. Fractional tile/border residue reports sub-pixel
/// positions, while a real clamp shifts by 2px (the observed min-visible
/// clamp) up to a full strut — so 1px catches clamps without false misses.
pub const SETTLED_TOLERANCE_PX: f64 = 1.0;

/// Whether a re-queried position matches its planned target within tolerance.
pub fn position_settled(actual: (f64, f64), target: (i32, i32)) -> bool {
    (actual.0 - f64::from(target.0)).abs() <= SETTLED_TOLERANCE_PX
        && (actual.1 - f64::from(target.1)).abs() <= SETTLED_TOLERANCE_PX
}

/// Move the exact panel id to the planned target and verify settlement. Checks
/// identity AND tile/size before acting (only the expected post-resize surface
/// passes, never the 420 calibration size nor a wrong size), requires `Handled`
/// AND a matching re-queried position (a bare `Handled` never succeeds), then
/// re-validates identity after the move. Returns the preserved compact PANEL
/// anchor, never the observed compositor frame. `Ok(None)` when superseded
/// (before or after the move: no further requests, no commit). Fullscreen stays
/// managed and is refused here. Never moves the DOT surface.
pub fn finish(
    prepared: &PreparedRestore,
    budget: Duration,
    fresh: impl Fn() -> bool,
    request: &mut impl FnMut(&str, Duration) -> io::Result<Value>,
) -> io::Result<Option<CompactSpot>> {
    if !fresh() {
        return Ok(None);
    }
    if prepared.mode == M::Fullscreen {
        return Err(invalid("niri: restore fullscreen is managed"));
    }
    let start = Instant::now();
    // GTK set_size acknowledges the request, not the compositor commit.
    // Wait for the expected client geometry under the SAME job budget before
    // moving anything; never accept the still-mapped 420 calibration frame.
    let (panel, tile, offset) = loop {
        let Some((panel, output, tile, offset)) = sample(prepared.pid, request, budget, start, &fresh)?
        else {
            return Ok(None);
        };
        if !panel_matches(&panel, &prepared.measured, output.as_deref()) {
            return Err(invalid("niri: restore frame changed"));
        }
        if panel.size == prepared.surface_size {
            let tile = tile.ok_or_else(|| invalid("niri: restore tile size unexpected"))?;
            if !tile_encloses(tile, panel.size, offset) {
                return Err(invalid("niri: restore tile size unexpected"));
            }
            break (panel, tile, offset);
        }
        if !fresh() {
            return Ok(None);
        }
        let remaining = budget.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, format!(
                "niri: restore resize unsettled: expected {:?}, observed {:?}",
                prepared.surface_size, panel.size,
            )));
        }
        std::thread::sleep(remaining.min(Duration::from_millis(10)));
    };
    // One combined surface: the actual tile ALREADY spans the compound UI, so
    // every mode clamps the tile alone — tile+gap+rose would double-count.
    // Anchored spots stay preserved, bootstrap bases recompute with the tile.
    // Never the 420 probe frame and never an observed arbitrary frame.
    let remembered = if prepared.bootstrapped {
        upper_right_base_logical(prepared.measured.area, tile, None, f64::from(prepared.gap), prepared.margin)
            .map(|base| CompactSpot { output: prepared.measured.output.clone(), x: base.panel.0, y: base.panel.1 })
            .ok_or_else(|| invalid("niri: restore unit does not fit"))?
    } else {
        prepared.remembered.clone()
    };
    let target = match prepared.mode {
        M::Pair | M::PanelOnly => clamp_unit_inside(prepared.measured.area, tile, (remembered.x, remembered.y), prepared.margin),
        M::RoseOnly => {
            let stored = prepared.measured.panel_offset
                .ok_or_else(|| invalid("niri: restore rose offset unavailable"))?;
            let current = offset
                .ok_or_else(|| invalid("niri: restore rose offset unavailable"))?;
            // The tile here IS the rose surface: align its client through the
            // stored panel offset and the current rose offset, never synthesis.
            let origin = rose_origin_aligned((remembered.x, remembered.y), stored, current)
                .ok_or_else(|| invalid("niri: restore rose offset unavailable"))?;
            clamp_unit_inside(prepared.measured.area, tile, origin, prepared.margin)
        }
        M::Fullscreen => return Err(invalid("niri: restore fullscreen is managed")),
    }
    .ok_or_else(|| invalid("niri: restore unit does not fit"))?;
    let target = (target.0.round() as i32, target.1.round() as i32);
    let (cx, cy) = panel.pos.ok_or_else(|| invalid("niri: restore panel unavailable"))?;
    let delta = (target.0 - cx.round() as i32, target.1 - cy.round() as i32);
    if delta != (0, 0) {
        let wire = action_move_floating(panel.id, delta.0, delta.1);
        let Some(reply) = send(request, budget, start, &fresh, &wire)? else {
            return Ok(None);
        };
        if !is_handled(&reply) {
            return Err(invalid("niri: unexpected action response"));
        }
        let Some((moved, moved_output, moved_tile, moved_offset)) =
            sample(prepared.pid, request, budget, start, &fresh)?
        else {
            return Ok(None);
        };
        let moved_tile = moved_tile.ok_or_else(|| invalid("niri: restore tile size unexpected"))?;
        if !panel_matches(&moved, &prepared.measured, moved_output.as_deref())
            || !tile_encloses(moved_tile, moved.size, moved_offset)
            || moved.size != prepared.surface_size
        {
            return Err(invalid("niri: restore frame changed"));
        }
        let (fx, fy) = moved.pos.ok_or_else(|| invalid("niri: restore panel unavailable"))?;
        if (fx.round() as i32, fy.round() as i32) != target {
            return Err(invalid("niri: restore position unverified"));
        }
    }
    // Outcome observation (T10/S7): the work area is unobservable, so a
    // cached plan may aim at a stale inset. Re-query the ACTUAL position
    // read-only — even when no move was needed — and fail beyond tolerance
    // instead of reporting a clamped or drifted frame as settled. The caller
    // drops the stale entry and re-probes in the same job.
    if delta != (0, 0) || !budget.saturating_sub(start.elapsed()).is_zero() {
        let Some((settled, settled_output, settled_tile, settled_offset)) =
            sample(prepared.pid, request, budget, start, &fresh)?
        else {
            return Ok(None);
        };
        let settled_tile = settled_tile.ok_or_else(|| invalid("niri: restore tile size unexpected"))?;
        if !panel_matches(&settled, &prepared.measured, settled_output.as_deref())
            || !tile_encloses(settled_tile, settled.size, settled_offset)
            || settled.size != prepared.surface_size
        {
            return Err(invalid("niri: restore frame changed"));
        }
        let (sx, sy) = settled.pos.ok_or_else(|| invalid("niri: restore panel unavailable"))?;
        if !position_settled((sx, sy), target) {
            return Err(invalid("niri: restore position unverified"));
        }
    }
    if !fresh() {
        return Ok(None);
    }
    Ok(Some(remembered))
}

#[cfg(test)]
mod tests {
    use super::super::calibration::WorkAreaEstimate as WorkArea;
    use super::*;
    use serde_json::json;
    use std::cell::{Cell, RefCell};

    const ORIGIN: (f64, f64) = (12.0, 30.0);
    const EXTENT: (f64, f64) = (1280.0, 1000.0); // right 1292, bottom 1030
    const KEEP: f64 = 75.0; // min_on_screen for the 420x640 probe tile

    fn work() -> WorkArea {
        WorkArea { origin: ORIGIN, size: EXTENT }
    }
    fn anchor(x: f64, y: f64) -> CompactSpot {
        CompactSpot { output: "DP-1".into(), x, y }
    }

    /// Scripted compositor: version-gated, probes move the exact panel id only.
    /// window_size/tile emulate the shell's GTK resize between prepare/finish.
    struct Fake {
        pos: Cell<(f64, f64)>,
        accept: bool,
        handled: bool,
        drift: bool,
        moves: Cell<usize>,
        window_size: Cell<(i32, i32)>,
        tile: Cell<(f64, f64)>,
        offset: Cell<(f64, f64)>,
        log: RefCell<Vec<Value>>,
        windows_seen: Cell<usize>,
        relocate: Cell<Option<(f64, f64)>>,
    }

    impl Fake {
        fn live() -> Self {
            Self { pos: Cell::new((200.0, 100.0)), accept: true, handled: true, drift: false, moves: Cell::new(0), window_size: Cell::new((420, 640)), tile: Cell::new((420.5, 640.5)), offset: Cell::new((0.0, 0.0)), log: RefCell::new(vec![]), windows_seen: Cell::new(0), relocate: Cell::new(None) }
        }
        /// Post-resize emulator: the shell's GTK resize between prepare and finish.
        fn resized() -> Self {
            let fake = Self::live();
            fake.pos.set((1217.0, 955.0));
            fake.window_size.set(PAIR_WINDOW);
            fake.tile.set((508.0, 648.0));
            fake.offset.set((4.0, 4.0));
            fake
        }
        fn request(&self, wire: &str, _: Duration) -> io::Result<Value> {
            let asked: Value = serde_json::from_str(wire)?;
            self.log.borrow_mut().push(asked.clone());
            if asked == json!("Version") {
                return Ok(json!({"Version": "26.04 (test)"}));
            }
            if asked == json!("Windows") {
                // Late-compositor relocation hook: on the second sample the
                // window reports a drifted position (clamp/race), so tests
                // can prove the final verification observes the outcome.
                self.windows_seen.set(self.windows_seen.get() + 1);
                if self.windows_seen.get() == 2 {
                    if let Some(next) = self.relocate.take() {
                        self.pos.set(next);
                    }
                }
                let ws = if self.drift && self.moves.get() > 0 { 8 } else { 7 };
                let (px, py) = self.pos.get();
                let (sw, sh) = self.window_size.get();
                let (tw, th) = self.tile.get();
                let (ox, oy) = self.offset.get();
                return Ok(json!({"Windows": [
                    {"id": 9, "pid": 42, "title": crate::platform::PANEL_TITLE, "workspace_id": ws, "is_floating": true,
                     "layout": {"window_size": [sw, sh], "tile_size": [tw, th], "window_offset_in_tile": [ox, oy], "tile_pos_in_workspace_view": [px, py]}},
                    {"id": 5, "pid": 42, "title": crate::platform::DOT_TITLE, "workspace_id": 7, "is_floating": true,
                     "layout": {"window_size": [72, 72], "tile_size": [72.0, 72.0], "tile_pos_in_workspace_view": [300.0, 100.0]}},
                ]}));
            }
            if asked == json!("Workspaces") {
                return Ok(json!({"Workspaces": [{"id": 7, "output": "DP-1"}, {"id": 8, "output": "HDMI-1"}]}));
            }
            let mover = &asked["Action"]["MoveFloatingWindow"];
            assert_eq!(mover["id"], 9, "restore moves the exact panel id, never the DOT");
            if !self.handled {
                return Ok(json!({"unexpected": "ok"}));
            }
            if self.accept {
                if let (Some(dx), Some(dy)) = (mover["x"]["AdjustFixed"].as_i64(), mover["y"]["AdjustFixed"].as_i64()) {
                    let (x, y) = self.pos.get();
                    self.pos.set((x + dx as f64, y + dy as f64));
                    self.moves.set(self.moves.get() + 1);
                } else {
                    let axis = |v: &Value, origin: f64, extent: f64| {
                        if let Some(fixed) = v["SetFixed"].as_f64() { origin + fixed } else { assert_eq!(v["SetProportion"], json!(100.0)); origin + extent - KEEP }
                    };
                    self.pos.set((axis(&mover["x"], ORIGIN.0, EXTENT.0), axis(&mover["y"], ORIGIN.1, EXTENT.1)));
                }
            }
            Ok(json!("Handled"))
        }
        /// Every move id on the wire; tests require panel-only traffic.
        fn moved_ids(&self) -> Vec<u64> {
            self.log.borrow().iter().filter_map(|w| w.pointer("/Action/MoveFloatingWindow/id").and_then(Value::as_u64)).collect()
        }
        fn adjust_moves(&self) -> usize {
            self.log.borrow().iter().filter(|w| w.pointer("/Action/MoveFloatingWindow/x/AdjustFixed").is_some()).count()
        }
    }

    /// Post-resize plan: prepare ran on the 420 surface, the shell resized to Pair.
    fn pair_plan() -> PreparedRestore {
        PreparedRestore { pid: 42, mode: M::Pair, measured: MeasuredArea { output: "DP-1".into(), workspace: Some(7), panel_id: 9, area: work(), panel_offset: Some((4.0, 4.0)) },
            surface_target: (100.0, 200.0), remembered: anchor(100.0, 200.0), surface_size: PAIR_WINDOW, gap: 8, margin: 12.0, bootstrapped: false }
    }

    /// Rose plan with a client-layout (borderless) estimate; finish re-derives
    /// the border-aware origin from the tile, never trusting this estimate.
    fn rose_plan() -> PreparedRestore {
        PreparedRestore { pid: 42, mode: M::RoseOnly, measured: MeasuredArea { output: "DP-1".into(), workspace: Some(7), panel_id: 9, area: work(), panel_offset: Some((4.0, 4.0)) },
            surface_target: (528.0, 484.0), remembered: anchor(100.0, 200.0), surface_size: ROSE_WINDOW, gap: 8, margin: 12.0, bootstrapped: false }
    }

    #[test]
    fn anchored_pair_stays_inside_all_margins() {
        let area = work();
        for (ax, ay, ex, ey) in [(100.0, 200.0, 100.0, 200.0), (-100.0, -100.0, 24.0, 42.0), (2000.0, 2000.0, 780.0, 378.0),
            (100.0, 2000.0, 100.0, 378.0), (2000.0, 200.0, 780.0, 200.0)] {
            assert_eq!(plan_surface_target(&anchor(ax, ay), M::Pair, &area, 12.0), Some((ex, ey)));
        }
        assert_eq!(plan_surface_target(&anchor(1200.0, 200.0), M::PanelOnly, &area, 12.0), Some((860.0, 200.0)));
        assert!(plan_surface_target(&anchor(f64::NAN, 0.0), M::Pair, &area, 12.0).is_none());
        assert!(plan_surface_target(&anchor(0.0, 0.0), M::Fullscreen, &area, 12.0).is_none());
    }

    #[test]
    fn bootstrap_accounts_the_full_pair_width() {
        let area = work();
        // Pair base leaves room for the rose: 1292-500-12, not the 860 panel-only base.
        assert_eq!(bootstrap_anchor("DP-1", &area, M::Pair, 8.0, 12.0), Some(anchor(780.0, 42.0)));
        assert_eq!(bootstrap_anchor("DP-1", &area, M::PanelOnly, 8.0, 12.0), Some(anchor(860.0, 42.0)));
        assert!(780.0 + 428.0 + 72.0 <= 1292.0 - 12.0); // derived rose stays inside
        assert!(bootstrap_anchor("", &area, M::Pair, 8.0, 12.0).is_none());
        assert!(bootstrap_anchor("DP-1", &area, M::Fullscreen, 8.0, 12.0).is_none());
    }

    #[test]
    fn rose_only_translates_clamps_and_inverse_captures() {
        let area = work();
        assert_eq!(plan_surface_target(&anchor(100.0, 200.0), M::RoseOnly, &area, 12.0), Some((528.0, 484.0)));
        assert_eq!(capture_from_rose_surface("DP-1", (528.0, 484.0)), Some(anchor(100.0, 200.0)));
        // Past the corner the 72px rose clamps; the caller preserves the anchor itself.
        assert_eq!(plan_surface_target(&anchor(1200.0, 900.0), M::RoseOnly, &area, 12.0), Some((1208.0, 946.0)));
        assert!(capture_from_rose_surface("", (528.0, 484.0)).is_none());
    }

    #[test]
    fn prepare_plans_anchored_pair_without_dot_moves() {
        let fake = Fake::live();
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        let plan = prepare(42, Some(&anchor(100.0, 200.0)), M::Pair, 8, 12.0, Duration::from_secs(2), || true, &mut request).unwrap().expect("anchored plan");
        // The remembered spot is preserved verbatim, never the clamp or probe trail.
        assert_eq!(plan.remembered, anchor(100.0, 200.0));
        assert_eq!(plan.surface_target, (100.0, 200.0));
        assert_eq!((plan.pid, plan.surface_size), (42, PAIR_WINDOW));
        assert_eq!(plan.measured, MeasuredArea { output: "DP-1".into(), workspace: Some(7), panel_id: 9, area: work(), panel_offset: Some((0.0, 0.0)) });
        assert!(!fake.moved_ids().is_empty() && fake.moved_ids().iter().all(|id| *id == 9));
        assert_eq!(fake.log.borrow()[0], json!("Version"));
    }

    #[test]
    fn prepare_bootstraps_pair_width_from_panel_only_measurement() {
        let fake = Fake::live();
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        let plan = prepare(42, None, M::Pair, 8, 12.0, Duration::from_secs(2), || true, &mut request).unwrap().expect("bootstrap plan");
        // The raw panel-only base would be x=860; the Pair plan accounts the rose.
        assert_eq!((plan.remembered, plan.surface_target), (anchor(780.0, 42.0), (780.0, 42.0)));
        assert!(fake.moved_ids().iter().all(|id| *id == 9));
    }

    #[test]
    fn prepare_rejects_drift_and_rejected_probes_without_anchors() {
        // Remembered output no longer matches the fresh measurement: no fabricated move.
        let fake = Fake::live();
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        let stale = CompactSpot { output: "HDMI-1".into(), x: 100.0, y: 200.0 };
        assert!(prepare(42, Some(&stale), M::Pair, 8, 12.0, Duration::from_secs(2), || true, &mut request).is_err());
        // Handled-without-motion probes fail calibration, so prepare fails too.
        let stuck = Fake { accept: false, ..Fake::live() };
        let mut request = |wire: &str, budget| stuck.request(wire, budget);
        assert!(prepare(42, Some(&anchor(100.0, 200.0)), M::Pair, 8, 12.0, Duration::from_secs(2), || true, &mut request).is_err());
    }

    #[test]
    fn finish_waits_for_asynchronous_resize_before_moving() {
        // set_size returning only queues a GTK/Wayland resize; IPC can still
        // report the calibration frame until the compositor commits it.
        for plan in [pair_plan(), rose_plan()] {
            let fake = Fake::live();
            let mut samples = 0;
            let mut request = |wire: &str, budget| {
                if wire == WINDOWS_REQUEST {
                    samples += 1;
                    if samples <= 2 {
                        assert_eq!(fake.adjust_moves(), 0, "never move the old calibration frame");
                    } else {
                        fake.window_size.set(plan.surface_size);
                        fake.tile.set((f64::from(plan.surface_size.0) + 8.0, f64::from(plan.surface_size.1) + 8.0));
                        fake.offset.set((4.0, 4.0));
                    }
                }
                fake.request(wire, budget)
            };
            let done = finish(&plan, Duration::from_millis(250), || true, &mut request)
                .expect("an acknowledged resize must wait for its compositor geometry")
                .expect("fresh restore");
            assert_eq!(done, plan.remembered);
            assert!(samples >= 3);
            assert_eq!(fake.adjust_moves(), 1);
            assert!(fake.moved_ids().iter().all(|id| *id == 9));
            let expected = if plan.mode == M::Pair { (100.0, 200.0) } else { (528.0, 484.0) };
            assert_eq!(fake.pos.get(), expected);
        }
    }

    #[test]
    fn finish_moves_once_and_verifies_the_final_position() {
        let fake = Fake::live();
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        let plan = prepare(42, Some(&anchor(100.0, 200.0)), M::Pair, 8, 12.0, Duration::from_secs(2), || true, &mut request).unwrap().unwrap();
        // Shell GTK resize between prepare and finish: 420 panel-only to Pair.
        fake.window_size.set(PAIR_WINDOW);
        fake.tile.set((500.0, 640.0));
        assert_eq!(fake.pos.get(), (1217.0, 955.0)); // probes end at the Proportion corner
        let done = finish(&plan, Duration::from_secs(2), || true, &mut request).unwrap().expect("settled");
        assert_eq!((done, fake.pos.get()), (anchor(100.0, 200.0), (100.0, 200.0)));
        assert_eq!(fake.adjust_moves(), 1);
        assert!(fake.moved_ids().iter().all(|id| *id == 9));
    }

    #[test]
    fn unhandled_or_rejected_move_is_never_success() {
        // A non-Handled reply fails instead of reporting the requested mode.
        let ghost = Fake { handled: false, ..Fake::resized() };
        let mut request = |wire: &str, budget| ghost.request(wire, budget);
        assert!(finish(&pair_plan(), Duration::from_secs(2), || true, &mut request).is_err());
        // Handled without motion fails too: the re-queried position must match.
        let stuck = Fake { accept: false, ..Fake::resized() };
        let mut request = |wire: &str, budget| stuck.request(wire, budget);
        assert!(finish(&pair_plan(), Duration::from_secs(2), || true, &mut request).is_err());
        assert_eq!(stuck.pos.get(), (1217.0, 955.0));
    }

    #[test]
    fn output_or_workspace_drift_rejects_the_stale_measurement() {
        let fake = Fake { drift: true, ..Fake::resized() };
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        // Pre-move identity still matches, so the move sends; the post-move requery
        // lands on another workspace/output and must fail, never settle.
        assert!(finish(&pair_plan(), Duration::from_secs(2), || true, &mut request).is_err());
    }

    #[test]
    fn stale_after_move_sends_nothing_further_and_commits_nothing() {
        let fake = Fake::resized();
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        // Fresh until the move lands, stale right after: verify-then-commit stops.
        let fresh = || fake.moves.get() == 0;
        assert!(finish(&pair_plan(), Duration::from_secs(2), fresh, &mut request).unwrap().is_none());
        // Exactly one pre-move sample plus the move: no post-move requery, no commit.
        assert_eq!(fake.log.borrow().len(), 3);
        assert_eq!(fake.adjust_moves(), 1);
    }

    #[test]
    fn unresized_or_wrong_surface_size_is_rejected() {
        // Shell forgot the resize: still the 420 calibration size with consistent tile.
        let unresized = Fake { tile: Cell::new((420.0, 640.0)), ..Fake::resized() };
        unresized.window_size.set((420, 640));
        unresized.offset.set((0.0, 0.0));
        let mut request = |wire: &str, budget| unresized.request(wire, budget);
        assert!(finish(&pair_plan(), Duration::from_secs(2), || true, &mut request).is_err());
        assert_eq!(unresized.adjust_moves(), 0);
        // A wrong size is rejected too, never moved.
        let wide = Fake { tile: Cell::new((800.0, 600.0)), ..Fake::resized() };
        wide.window_size.set((800, 600));
        wide.offset.set((0.0, 0.0));
        let mut request = |wire: &str, budget| wide.request(wire, budget);
        assert!(finish(&pair_plan(), Duration::from_secs(2), || true, &mut request).is_err());
        assert_eq!(wide.adjust_moves(), 0);
    }

    #[test]
    fn tile_must_enclose_client_with_optional_valid_offset() {
        assert!(tile_encloses((508.0, 648.0), (500, 640), Some((4.0, 4.0)))); // 8px borders
        assert!(tile_encloses((503.2, 643.2), (500, 640), Some((1.6, 1.6)))); // fractional
        assert!(tile_encloses((500.0, 640.0), (500, 640), None)); // borderless, offset absent
        for (tile, window, offset) in [((499.0, 640.0), (500, 640), None), ((0.0, 640.0), (500, 640), None),
            ((508.0, 648.0), (500, 640), Some((10.0, 10.0))), ((508.0, 648.0), (500, 640), Some((-1.0, 0.0)))] {
            assert!(!tile_encloses(tile, window, offset));
        }
    }

    #[test]
    fn rose_origin_aligns_client_through_both_offsets() {
        // Same old/new offset cancels out; a changed rose offset shifts the tile.
        assert_eq!(rose_origin_aligned((100.0, 200.0), (4.0, 4.0), (4.0, 4.0)), Some((528.0, 484.0)));
        assert_eq!(rose_origin_aligned((100.0, 200.0), (4.0, 4.0), (2.0, 2.0)), Some((530.0, 486.0)));
        assert_eq!(rose_origin_aligned((100.0, 200.0), (0.0, 0.0), (0.0, 0.0)), Some((528.0, 484.0)));
        assert!(rose_origin_aligned((f64::NAN, 200.0), (4.0, 4.0), (4.0, 4.0)).is_none());
        assert!(rose_origin_aligned((100.0, 200.0), (-1.0, 0.0), (4.0, 4.0)).is_none());
    }

    #[test]
    fn aligned_capture_inverts_aligned_origin() {
        let rose = rose_origin_aligned((100.0, 200.0), (4.0, 4.0), (2.0, 2.0)).unwrap();
        assert_eq!(rose, (530.0, 486.0));
        assert_eq!(capture_rose_aligned("DP-1", rose, (2.0, 2.0), (4.0, 4.0)), Some(anchor(100.0, 200.0)));
        assert!(capture_rose_aligned("", rose, (2.0, 2.0), (4.0, 4.0)).is_none());
        assert!(capture_rose_aligned("DP-1", (f64::NAN, 0.0), (2.0, 2.0), (4.0, 4.0)).is_none());
    }

    #[test]
    fn panel_only_clamps_the_actual_tile_alone() {
        let fake = Fake::live();
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        let plan = prepare(42, Some(&anchor(100.0, 200.0)), M::PanelOnly, 8, 12.0, Duration::from_secs(2), || true, &mut request).unwrap().unwrap();
        // PanelOnly client 420 in a 428 tile: the tile alone is the footprint.
        fake.tile.set((428.0, 648.0));
        fake.offset.set((4.0, 4.0));
        let done = finish(&plan, Duration::from_secs(2), || true, &mut request).unwrap().expect("settled");
        assert_eq!((done, fake.pos.get()), (anchor(100.0, 200.0), (100.0, 200.0)));
        assert_eq!(fake.adjust_moves(), 1);
        assert!(fake.moved_ids().iter().all(|id| *id == 9));
    }

    #[test]
    fn tile_footprint_clamps_inside_all_margins() {
        let fake = Fake::resized(); // tile 508x648 with 8px borders
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        // Actual tile 508 alone spans the compound UI: right 1292-12-508=772, bottom 1030-12-648=370.
        for (ax, ay, ex, ey) in [(100.0, 200.0, 100.0, 200.0), (-100.0, -100.0, 24.0, 42.0), (2000.0, 2000.0, 772.0, 370.0),
            (100.0, 2000.0, 100.0, 370.0), (2000.0, 200.0, 772.0, 200.0)] {
            let mut plan = pair_plan();
            plan.remembered = anchor(ax, ay);
            let done = finish(&plan, Duration::from_secs(2), || true, &mut request).unwrap().expect("settled");
            assert_eq!((done, fake.pos.get()), (anchor(ax, ay), (ex, ey)));
        }
        assert!(fake.moved_ids().iter().all(|id| *id == 9));
    }

    #[test]
    fn bootstrap_recomputes_with_actual_tile_after_resize() {
        let fake = Fake::live();
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        let plan = prepare(42, None, M::Pair, 8, 12.0, Duration::from_secs(2), || true, &mut request).unwrap().expect("bootstrap plan");
        fake.window_size.set(PAIR_WINDOW);
        fake.tile.set((508.0, 648.0));
        fake.offset.set((4.0, 4.0));
        let done = finish(&plan, Duration::from_secs(2), || true, &mut request).unwrap().expect("settled");
        // Actual tile 508 upper-right: 1292-508-12=772, not the 780 client base.
        assert_eq!((done, fake.pos.get()), (anchor(772.0, 42.0), (772.0, 42.0)));
    }

    #[test]
    fn fractional_bordered_tile_settles() {
        let fake = Fake::live();
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        let plan = prepare(42, Some(&anchor(100.0, 200.0)), M::Pair, 8, 12.0, Duration::from_secs(2), || true, &mut request).unwrap().unwrap();
        fake.window_size.set(PAIR_WINDOW);
        fake.tile.set((503.2, 643.2));
        fake.offset.set((1.6, 1.6));
        let done = finish(&plan, Duration::from_secs(2), || true, &mut request).unwrap().expect("settled");
        assert_eq!((done, fake.pos.get()), (anchor(100.0, 200.0), (100.0, 200.0)));
    }

    #[test]
    fn rose_finish_accounts_border_offset_from_panel_tile_origin() {
        let fake = Fake { window_size: Cell::new(ROSE_WINDOW), tile: Cell::new((80.0, 80.0)), offset: Cell::new((4.0, 4.0)), pos: Cell::new((1217.0, 955.0)), ..Fake::live() };
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        let done = finish(&rose_plan(), Duration::from_secs(2), || true, &mut request).unwrap().expect("rose settled");
        // Aligned client origin: tile origin + panel offset + layout minus rose offset.
        assert_eq!((done, fake.pos.get()), (anchor(100.0, 200.0), (528.0, 484.0)));
        assert_eq!(fake.adjust_moves(), 1);
        assert!(fake.moved_ids().iter().all(|id| *id == 9));
        // Missing stored offsets fail closed, never moved.
        let no_stored = PreparedRestore { measured: MeasuredArea { panel_offset: None, ..rose_plan().measured }, ..rose_plan() };
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        assert!(finish(&no_stored, Duration::from_secs(2), || true, &mut request).is_err());
    }

    #[test]
    fn degenerate_tile_or_offset_is_rejected_without_moving() {
        // Right-sized window but degenerate tile: frame drift, not the resize.
        let bad_tile = Fake { tile: Cell::new((0.0, 0.0)), ..Fake::resized() };
        let mut request = |wire: &str, budget| bad_tile.request(wire, budget);
        assert!(finish(&pair_plan(), Duration::from_secs(2), || true, &mut request).is_err());
        assert_eq!(bad_tile.adjust_moves(), 0);
        // Offset overflowing the tile is rejected too, never moved.
        let bad_offset = Fake { offset: Cell::new((10.0, 10.0)), ..Fake::resized() };
        let mut request = |wire: &str, budget| bad_offset.request(wire, budget);
        assert!(finish(&pair_plan(), Duration::from_secs(2), || true, &mut request).is_err());
        assert_eq!(bad_offset.adjust_moves(), 0);
    }

    #[test]
    fn fullscreen_finish_stays_managed() {
        let managed = PreparedRestore { mode: M::Fullscreen, surface_size: (0, 0), ..pair_plan() };
        let fake = Fake::live();
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        assert!(finish(&managed, Duration::from_secs(2), || true, &mut request).is_err());
        assert!(fake.log.borrow().is_empty());
    }

    #[test]
    fn stale_generations_send_nothing() {
        let fake = Fake::live();
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        assert!(prepare(42, Some(&anchor(100.0, 200.0)), M::Pair, 8, 12.0, Duration::from_secs(2), || false, &mut request).unwrap().is_none());
        assert!(fake.log.borrow().is_empty() && fake.pos.get() == (200.0, 100.0));
    }

    #[test]
    fn settled_tolerance_catches_clamps_not_subpixel_residue() {
        assert!(position_settled((100.6, 200.0), (100, 200)));
        assert!(position_settled((100.0, 199.4), (100, 200)));
        // The observed 2px min-visible clamp and a 44px strut both miss.
        assert!(!position_settled((102.0, 200.0), (100, 200)));
        assert!(!position_settled((100.0, 244.0), (100, 200)));
    }

    #[test]
    fn finish_requeries_the_settled_position_without_a_move() {
        // Already on the planned target: zero moves, but the position must
        // still be verified with a read-only re-query, never trusted.
        let fake = Fake::resized();
        fake.pos.set((100.0, 200.0));
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        let done = finish(&pair_plan(), Duration::from_secs(2), || true, &mut request)
            .unwrap()
            .expect("settled");
        assert_eq!(done, anchor(100.0, 200.0));
        assert_eq!(fake.adjust_moves(), 0, "already on target: zero moves");
        let windows = fake.log.borrow().iter().filter(|w| w.as_str() == Some("Windows")).count();
        assert_eq!(windows, 2, "settle sample plus a read-only verification query");
        // A late clamp/drift that lands elsewhere fails instead of trusting the plan.
        let fake = Fake::resized();
        fake.pos.set((100.0, 200.0));
        fake.relocate.set(Some((100.0, 250.0)));
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        assert!(finish(&pair_plan(), Duration::from_secs(2), || true, &mut request).is_err());
    }

    #[test]
    fn fullscreen_plans_no_floating_move() {
        assert!(fullscreen_effective(M::Fullscreen, true, true));
        assert!(!fullscreen_effective(M::Fullscreen, true, false) && !fullscreen_effective(M::Fullscreen, false, true));
        assert!(!fullscreen_effective(M::Pair, true, true));
        let fake = Fake::live();
        let mut request = |wire: &str, budget| fake.request(wire, budget);
        // Even effective fullscreen leaves the compact anchor to the managed path.
        assert!(prepare(42, Some(&anchor(100.0, 200.0)), M::Fullscreen, 8, 12.0, Duration::from_secs(2), || true, &mut request).unwrap().is_none());
        assert!(fake.log.borrow().is_empty());
    }

    #[test]
    fn output_key_parses_the_real_outputs_shape() {
        let reply = json!({"Outputs": {"DP-1": {"name": "DP-1", "make": "X", "model": "Y",
            "logical": {"x": 0, "y": 0, "width": 2560, "height": 1440, "scale": 1.0, "transform": "Normal"}}}});
        assert_eq!(output_key(&reply, "DP-1"), Some(OutputKey { output: "DP-1".into(), width: 2560, height: 1440, scale: 1.0, transform: "Normal".into() }));
        assert_eq!(output_key(&reply, "HDMI-1"), None);
        // A disabled output (logical null) never yields a key.
        let reply = json!({"Outputs": {"DP-1": {"name": "DP-1", "logical": null}}});
        assert_eq!(output_key(&reply, "DP-1"), None);
        assert_eq!(output_key(&reply, ""), None);
    }

    #[test]
    fn output_key_rejects_layout_drift() {
        let key = OutputKey { output: "DP-1".into(), width: 2560, height: 1440, scale: 1.0, transform: "Normal".into() };
        let scaled = json!({"Outputs": {"DP-1": {"name": "DP-1",
            "logical": {"x": 0, "y": 0, "width": 2560, "height": 1440, "scale": 2.0, "transform": "Normal"}}}});
        assert_ne!(output_key(&scaled, "DP-1").as_ref(), Some(&key));
        let rotated = json!({"Outputs": {"DP-1": {"name": "DP-1",
            "logical": {"x": 0, "y": 0, "width": 1440, "height": 2560, "scale": 1.0, "transform": "_90"}}}});
        assert_ne!(output_key(&rotated, "DP-1").as_ref(), Some(&key));
    }

    #[test]
    fn layer_snapshot_parses_namespace_output_layer_and_interactivity() {
        let event = json!({"Layers": [
            {"namespace": "osd", "output": "DP-1", "layer": "Overlay", "keyboard_interactivity": "OnDemand"},
            {"namespace": "bar", "output": "DP-1", "layer": "Top", "keyboard_interactivity": "None"},
        ]});
        let snapshot = layer_snapshot(&event).expect("layer payload parses");
        assert_eq!(snapshot.len(), 2);
        // Canonical order is sorted, so wire order never fakes a change.
        assert!(snapshot[0] <= snapshot[1]);
        assert_eq!(snapshot[0].namespace, "bar");
        assert_eq!(snapshot[1].keyboard_interactivity, "OnDemand");
        // An empty list is a real observation (bar removed), not a miss.
        assert_eq!(layer_snapshot(&json!({"Layers": []})), Some(vec![]));
        // No payload or a wrong shape never parses.
        assert_eq!(layer_snapshot(&json!({"WindowClosed": {"id": 9}})), None);
        assert_eq!(layer_snapshot(&json!({"Layers": {}})), None);
        // Malformed entries are skipped, never invented.
        assert_eq!(layer_snapshot(&json!({"Layers": [{"namespace": "bar"}]})), Some(vec![]));
    }

    #[test]
    fn environment_invalidates_on_layer_change_and_config_reload() {
        let bar = || json!({"Layers": [{"namespace": "bar", "output": "DP-1", "layer": "Top", "keyboard_interactivity": "None"}]});
        let bar_reordered = || json!({"Layers": [{"keyboard_interactivity": "None", "layer": "Top", "output": "DP-1", "namespace": "bar"}]});
        let no_bar = || json!({"Layers": []});
        let mut last = None;
        // Baseline observation only records, never invalidates.
        assert!(!environment_invalidates(&bar(), &mut last));
        assert_eq!(last, layer_snapshot(&bar()));
        // Identical set (even reordered) invalidates nothing.
        assert!(!environment_invalidates(&bar_reordered(), &mut last));
        // Any namespace/output/layer/count difference invalidates, including removal.
        assert!(environment_invalidates(&no_bar(), &mut last));
        assert_eq!(last, Some(vec![]));
        assert!(!environment_invalidates(&no_bar(), &mut last));
        // Config reload invalidates without touching the layer baseline.
        let before = last.clone();
        assert!(environment_invalidates(&json!({"ConfigLoaded": {"failed": false}}), &mut last));
        assert_eq!(last, before);
        // Unrelated events invalidate nothing and record nothing.
        assert!(!environment_invalidates(&json!({"WindowClosed": {"id": 9}}), &mut last));
        assert_eq!(last, before);
    }
}
