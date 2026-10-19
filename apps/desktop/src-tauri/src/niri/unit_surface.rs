//! Dormant Niri-only shared-unit surface (T10/T11/T12/T19, S2/S6-S10/S13/S15-S17).
//!
//! One Niri-only surface keeps the EXACT visuals: 420x640 panel, 8px gap, the
//! strips pass clicks (Wayland `wl_surface_set_input_region` via GTK3
//! `input_shape_combine_region`). No caller yet: no window builds, no dot
//! hide, Linux+Niri only. One remembered PANEL anchor owns every compact
//! mode; rose-only is its inverse translate. A later calibration unit probes
//! panel-only and derives the rest via [`frame_for_mode`]; no invented origins.

use gtk::prelude::WidgetExt;

/// Panel size in logical pixels (existing `PANEL_SIZE`).
pub const PANEL_W: i32 = 420;
pub const PANEL_H: i32 = 640;
/// Transparent gap between panel and rose (existing `PANEL_GAP`).
pub const GAP: i32 = 8;
/// Rose canvas (existing `DOT_SIZE`): the 66px disc plus a 3px ring.
pub const ROSE_SIZE: i32 = 72;
/// Visible rose disc diameter: 72 - 2*3 inset.
pub const ROSE_DISC_DIAM: i32 = 66;
/// Inset of the disc inside its canvas.
pub const ROSE_DISC_INSET: i32 = 3;
/// Pair surface: 420 + 8 + 72 = 500 wide, panel height dominates.
pub const PAIR_W: i32 = 500;
pub const PAIR_H: i32 = 640;
/// Rose top-left inside the pair: right of panel+gap, vertically centered.
pub const ROSE_OFF_X: i32 = 428;
pub const ROSE_OFF_Y: i32 = 284;
/// Panel corner radius (`.chat-panel --radius: 20px`).
pub const PANEL_RADIUS: i32 = 20;
/// Needs-you badge square inside the rose canvas (`.dot-badge`).
pub const BADGE_X: i32 = 52;
pub const BADGE_Y: i32 = 4;
pub const BADGE_SIZE: i32 = 16;

/// Face shown: `Fullscreen` fills the compositor frame; rest are fixed sizes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitMode {
    RoseOnly,
    PanelOnly,
    Pair,
    Fullscreen,
}

/// One surface-local input rect (x, y, w, h), scanline rows included.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Remembered panel top-left anchor: the ONE position source of truth.
#[derive(Debug, Clone, PartialEq)]
pub struct UnitAnchor {
    pub output: String,
    pub x: f64,
    pub y: f64,
}

/// Concrete surface frame derived from an anchor for one mode.
#[derive(Debug, Clone, PartialEq)]
pub struct UnitFrame {
    pub output: String,
    pub x: f64,
    pub y: f64,
    pub w: i32,
    pub h: i32,
}

/// What the GTK input shape must be: `Empty` while covered, `Full` for revealed
/// fullscreen, else the compact scanline region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShapeKind {
    Empty,
    Region(Vec<InputRect>),
    Full,
}

/// Fixed surface size per mode (`None`: fullscreen fills the screen, so the caller
/// supplies that frame explicitly, never a dormant constant).
pub fn mode_size(mode: UnitMode) -> Option<(i32, i32)> {
    match mode {
        UnitMode::RoseOnly => Some((ROSE_SIZE, ROSE_SIZE)),
        UnitMode::PanelOnly => Some((PANEL_W, PANEL_H)),
        UnitMode::Pair => Some((PAIR_W, PAIR_H)),
        UnitMode::Fullscreen => None,
    }
}

fn in_disc(x: i32, y: i32, cx: i32, cy: i32, r: i32) -> bool {
    let (dx, dy) = (x - cx, y - cy);
    dx * dx + dy * dy <= r * r
}

/// Disc center inside the rose canvas: inset plus half the diameter.
const ROSE_CENTER: i32 = ROSE_DISC_INSET + ROSE_DISC_DIAM / 2;

fn in_rose(x: i32, y: i32, badge_visible: bool) -> bool {
    if x < 0 || y < 0 || x >= ROSE_SIZE || y >= ROSE_SIZE {
        return false;
    }
    let center = ROSE_CENTER;
    if in_disc(x, y, center, center, ROSE_DISC_DIAM / 2) {
        return true;
    }
    badge_visible
        && in_disc(x, y, BADGE_X + BADGE_SIZE / 2, BADGE_Y + BADGE_SIZE / 2, BADGE_SIZE / 2)
}

fn in_rounded_panel(x: i32, y: i32) -> bool {
    if x < 0 || y < 0 || x >= PANEL_W || y >= PANEL_H {
        return false;
    }
    let r = PANEL_RADIUS;
    in_disc(x, y, x.clamp(r, PANEL_W - 1 - r), y.clamp(r, PANEL_H - 1 - r), r)
}

/// Surface-local containment: compact modes require their exact dormant size;
pub fn is_hit(mode: UnitMode, badge_visible: bool, surface: (i32, i32), x: i32, y: i32) -> bool {
    if mode == UnitMode::Fullscreen {
        return surface.0 > 0 && surface.1 > 0 && x >= 0 && y >= 0 && x < surface.0 && y < surface.1;
    }
    if Some(surface) != mode_size(mode) {
        return false;
    }
    match mode {
        UnitMode::RoseOnly => in_rose(x, y, badge_visible),
        UnitMode::PanelOnly => in_rounded_panel(x, y),
        UnitMode::Pair if x < PANEL_W => in_rounded_panel(x, y),
        UnitMode::Pair if x < ROSE_OFF_X => false,
        UnitMode::Pair => in_rose(x - ROSE_OFF_X, y - ROSE_OFF_Y, badge_visible),
        UnitMode::Fullscreen => unreachable!(),
    }
}

/// One chord row of a disc: the widest integer span inside the circle, so both
/// row corners sit on or inside the rim and [`is_hit`] agrees with every rect.
fn disc_rows(rects: &mut Vec<InputRect>, ox: i32, oy: i32, cx: i32, cy: i32, r: i32) {
    for y in (cy - r)..=(cy + r) {
        let dy = y - cy;
        let dx = f64::sqrt(f64::from(r * r - dy * dy)).floor() as i32;
        rects.push(InputRect { x: ox + cx - dx, y: oy + y, w: 2 * dx + 1, h: 1 });
    }
}

fn panel_rows(rects: &mut Vec<InputRect>) {
    let r = PANEL_RADIUS;
    for y in 0..PANEL_H {
        let edge = y.min(PANEL_H - 1 - y);
        if edge >= r {
            continue;
        }
        let inset = r - f64::sqrt(f64::from(r * r - (r - edge) * (r - edge))).floor() as i32;
        rects.push(InputRect { x: inset, y, w: PANEL_W - 2 * inset, h: 1 });
    }
    rects.push(InputRect { x: 0, y: r, w: PANEL_W, h: PANEL_H - 2 * r });
}

fn rose_rows(rects: &mut Vec<InputRect>, ox: i32, oy: i32, badge_visible: bool) {
    disc_rows(rects, ox, oy, ROSE_CENTER, ROSE_CENTER, ROSE_DISC_DIAM / 2);
    if badge_visible {
        disc_rows(rects, ox, oy, BADGE_X + BADGE_SIZE / 2, BADGE_Y + BADGE_SIZE / 2, BADGE_SIZE / 2);
    }
}

/// Compact scanline input rects: panel rows honour the 20px corners, rose rows the
/// 66px disc (plus badge when shown). Gap and strips get NO rect, staying click-through.
/// use [`fullscreen_rects`] or [`ShapeKind::Full`].
pub fn input_rects(mode: UnitMode, badge_visible: bool) -> Vec<InputRect> {
    let mut rects = Vec::new();
    match mode {
        UnitMode::RoseOnly => rose_rows(&mut rects, 0, 0, badge_visible),
        UnitMode::PanelOnly => panel_rows(&mut rects),
        UnitMode::Pair => {
            panel_rows(&mut rects);
            rose_rows(&mut rects, ROSE_OFF_X, ROSE_OFF_Y, badge_visible);
        }
        UnitMode::Fullscreen => {}
    }
    rects
}

/// Fullscreen input for an explicit frame, or `None` for an invalid extent.
pub fn fullscreen_rects(w: i32, h: i32) -> Option<Vec<InputRect>> {
    if w > 0 && h > 0 { Some(vec![InputRect { x: 0, y: 0, w, h }]) } else { None }
}

/// Covered (gate hidden, probe, pre-reveal) is ALWAYS empty — even fullscreen — so a
/// shape applied while covered never re-enables pointer events.
pub fn shape_for(mode: UnitMode, badge_visible: bool, covered: bool) -> ShapeKind {
    if covered {
        ShapeKind::Empty
    } else if mode == UnitMode::Fullscreen {
        ShapeKind::Full
    } else {
        ShapeKind::Region(input_rects(mode, badge_visible))
    }
}

fn valid_anchor_output(output: &str, x: f64, y: f64) -> bool {
    !output.is_empty() && x.is_finite() && y.is_finite()
}

/// Rose top-left implied by a remembered panel anchor (+428,+284).
pub fn rose_origin_from_anchor(anchor: &UnitAnchor) -> Option<(f64, f64)> {
    if !valid_anchor_output(&anchor.output, anchor.x, anchor.y) {
        return None;
    }
    Some((anchor.x + f64::from(ROSE_OFF_X), anchor.y + f64::from(ROSE_OFF_Y)))
}

/// Panel anchor from a rose-only drag: inverse translate, same output identity.
pub fn anchor_from_rose_origin(output: &str, rose: (f64, f64)) -> Option<UnitAnchor> {
    if !valid_anchor_output(output, rose.0, rose.1) {
        return None;
    }
    Some(UnitAnchor {
        output: output.to_owned(),
        x: rose.0 - f64::from(ROSE_OFF_X),
        y: rose.1 - f64::from(ROSE_OFF_Y),
    })
}

/// Concrete frame per mode from the one panel anchor, preserving its output. Refuses
/// invalid anchors; `Fullscreen` is `None` (the compositor owns it).
pub fn frame_for_mode(anchor: &UnitAnchor, mode: UnitMode) -> Option<UnitFrame> {
    if !valid_anchor_output(&anchor.output, anchor.x, anchor.y) {
        return None;
    }
    let frame = |x: f64, y: f64, w: i32, h: i32| UnitFrame { output: anchor.output.clone(), x, y, w, h };
    match mode {
        UnitMode::PanelOnly => Some(frame(anchor.x, anchor.y, PANEL_W, PANEL_H)),
        UnitMode::Pair => Some(frame(anchor.x, anchor.y, PAIR_W, PAIR_H)),
        UnitMode::RoseOnly => {
            let (x, y) = rose_origin_from_anchor(anchor)?;
            Some(frame(x, y, ROSE_SIZE, ROSE_SIZE))
        }
        UnitMode::Fullscreen => None,
    }
}

/// Cairo region from surface-local rects (`gtk` 0.18.2 re-exports `cairo`).
pub fn region_for_rects(rects: &[InputRect]) -> gtk::cairo::Region {
    let region = gtk::cairo::Region::create();
    for rect in rects {
        let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(rect.x, rect.y, rect.w, rect.h));
    }
    region
}

/// Thin main-thread apply, no locks/IPC: covered installs EMPTY; reveal via reapply..
pub fn apply_input_shape(window: &gtk::ApplicationWindow, mode: UnitMode, badge_visible: bool, covered: bool) {
    match shape_for(mode, badge_visible, covered) {
        ShapeKind::Empty => window.input_shape_combine_region(Some(&gtk::cairo::Region::create())),
        ShapeKind::Region(rects) => window.input_shape_combine_region(Some(&region_for_rects(&rects))),
        ShapeKind::Full => window.input_shape_combine_region(None),
    }
}

/// Reapply after a reveal or after Tauri `set_ignore_cursor_events(false)` (which
/// overwrites the widget shape): the uncovered shape, never empty.
pub fn reapply_input_shape(window: &gtk::ApplicationWindow, mode: UnitMode, badge_visible: bool) {
    apply_input_shape(window, mode, badge_visible, false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_sizes_match_visual_layout() {
        assert_eq!(mode_size(UnitMode::RoseOnly), Some((72, 72)));
        assert_eq!(mode_size(UnitMode::PanelOnly), Some((420, 640)));
        assert_eq!(mode_size(UnitMode::Pair), Some((500, 640)));
        assert_eq!(mode_size(UnitMode::Fullscreen), None);
        assert_eq!(PANEL_W + GAP + ROSE_SIZE, PAIR_W);
        assert_eq!((PANEL_H - ROSE_SIZE) / 2, ROSE_OFF_Y);
        assert_eq!(PANEL_W + GAP, ROSE_OFF_X);
    }

    #[test]
    fn anchor_rose_roundtrip_exact() {
        let anchor = UnitAnchor { output: "DP-1".into(), x: 100.0, y: 200.0 };
        let rose = rose_origin_from_anchor(&anchor).unwrap();
        assert_eq!(rose, (528.0, 484.0));
        assert_eq!(anchor_from_rose_origin("DP-1", rose).unwrap(), anchor);
        assert!(rose_origin_from_anchor(&UnitAnchor { output: String::new(), x: 1.0, y: 1.0 }).is_none());
        assert!(rose_origin_from_anchor(&UnitAnchor { output: "DP-1".into(), x: f64::NAN, y: 1.0 }).is_none());
        assert!(anchor_from_rose_origin("", (1.0, 1.0)).is_none());
        assert!(anchor_from_rose_origin("DP-1", (f64::INFINITY, 1.0)).is_none());
    }

    #[test]
    fn frame_for_mode_derives_translated_modes() {
        let anchor = UnitAnchor { output: "DP-1".into(), x: 100.0, y: 200.0 };
        assert_eq!(frame_for_mode(&anchor, UnitMode::PanelOnly).unwrap(),
            UnitFrame { output: "DP-1".into(), x: 100.0, y: 200.0, w: 420, h: 640 });
        assert_eq!(frame_for_mode(&anchor, UnitMode::Pair).unwrap(),
            UnitFrame { output: "DP-1".into(), x: 100.0, y: 200.0, w: 500, h: 640 });
        assert_eq!(frame_for_mode(&anchor, UnitMode::RoseOnly).unwrap(),
            UnitFrame { output: "DP-1".into(), x: 528.0, y: 484.0, w: 72, h: 72 });
        assert_eq!(frame_for_mode(&anchor, UnitMode::Fullscreen), None);
        assert!(frame_for_mode(&UnitAnchor { output: String::new(), x: 0.0, y: 0.0 }, UnitMode::Pair).is_none());
    }

    #[test]
    fn pair_gap_and_strip_pass_clicks() {
        let surface = (500, 640);
        for y in [0, 283, 320, 356, 639] {
            for x in 420..428 {
                assert!(!is_hit(UnitMode::Pair, false, surface, x, y), "gap ({x},{y})");
            }
        }
        for point in [(460, 10), (499, 0), (421, 639), (500 - 1, 283), (428, 283)] {
            assert!(!is_hit(UnitMode::Pair, false, surface, point.0, point.1), "strip {point:?}");
        }
        assert!(is_hit(UnitMode::Pair, false, surface, 10, 10));
        assert!(is_hit(UnitMode::Pair, false, surface, 428 + 36, 284 + 36));
    }

    #[test]
    fn rose_hit_area_matches_disc() {
        let surface = (72, 72);
        assert!(is_hit(UnitMode::RoseOnly, false, surface, 36, 36));
        assert!(is_hit(UnitMode::RoseOnly, false, surface, 36, 3));
        assert!(!is_hit(UnitMode::RoseOnly, false, surface, 36, 2));
        assert!(is_hit(UnitMode::RoseOnly, false, surface, 3, 36));
        assert!(!is_hit(UnitMode::RoseOnly, false, surface, 2, 36));
        for corner in [(0, 0), (71, 0), (0, 71), (71, 71)] {
            assert!(!is_hit(UnitMode::RoseOnly, false, surface, corner.0, corner.1), "{corner:?}");
        }
    }

    #[test]
    fn badge_extends_hit_only_when_visible() {
        let surface = (72, 72);
        assert!(is_hit(UnitMode::RoseOnly, true, surface, 60, 12));
        assert!(is_hit(UnitMode::RoseOnly, true, surface, 58, 8));
        assert!(!is_hit(UnitMode::RoseOnly, false, surface, 60, 12));
        assert!(!is_hit(UnitMode::RoseOnly, false, surface, 58, 8));
        assert!(!is_hit(UnitMode::RoseOnly, true, surface, 52, 4));
    }

    #[test]
    fn panel_corners_match_radius() {
        let surface = (420, 640);
        assert!(is_hit(UnitMode::PanelOnly, false, surface, 210, 320));
        assert!(!is_hit(UnitMode::PanelOnly, false, surface, 0, 0));
        assert!(!is_hit(UnitMode::PanelOnly, false, surface, 419, 639));
        assert!(!is_hit(UnitMode::PanelOnly, false, surface, 2, 2));
        assert!(is_hit(UnitMode::PanelOnly, false, surface, 19, 19));
        assert!(!is_hit(UnitMode::PanelOnly, false, surface, -1, 10));
        assert!(!is_hit(UnitMode::PanelOnly, false, surface, 420, 10));
    }

    #[test]
    fn fullscreen_full_input() {
        assert!(is_hit(UnitMode::Fullscreen, false, (1920, 1080), 0, 0));
        assert!(is_hit(UnitMode::Fullscreen, false, (1920, 1080), 1919, 1079));
        assert!(!is_hit(UnitMode::Fullscreen, false, (1920, 1080), 1920, 0));
        assert!(!is_hit(UnitMode::Fullscreen, false, (0, 1080), 0, 0));
        assert_eq!(fullscreen_rects(1920, 1080), Some(vec![InputRect { x: 0, y: 0, w: 1920, h: 1080 }]));
        assert_eq!(fullscreen_rects(0, 1080), None);
        assert_eq!(fullscreen_rects(-1, 1080), None);
    }

    #[test]
    fn rects_agree_with_hit() {
        for mode in [UnitMode::RoseOnly, UnitMode::PanelOnly, UnitMode::Pair] {
            let size = mode_size(mode).unwrap();
            for badge in [false, true] {
                let rects = input_rects(mode, badge);
                assert!(!rects.is_empty(), "{mode:?} badge={badge}");
                for rect in &rects {
                    assert!(rect.w > 0 && rect.h > 0, "{rect:?}");
                    for corner in [(rect.x, rect.y), (rect.x + rect.w - 1, rect.y + rect.h - 1)] {
                        assert!(is_hit(mode, badge, size, corner.0, corner.1), "{mode:?} {rect:?}");
                    }
                }
            }
        }
        assert!(input_rects(UnitMode::Fullscreen, false).is_empty());
    }

    #[test]
    fn covered_shape_stays_empty_until_fresh_reveal() {
        assert_eq!(shape_for(UnitMode::Pair, false, true), ShapeKind::Empty);
        assert_eq!(shape_for(UnitMode::Fullscreen, false, true), ShapeKind::Empty);
        assert_eq!(shape_for(UnitMode::Fullscreen, false, false), ShapeKind::Full);
        assert!(matches!(shape_for(UnitMode::Pair, false, false), ShapeKind::Region(r) if !r.is_empty()));
    }
}
