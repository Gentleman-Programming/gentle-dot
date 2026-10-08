//! Pure placement math for the Dot and the panel, in logical points: the
//! global macOS screen space that every monitor shares, whatever its scale.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self { x, y, width, height }
    }

    fn right(&self) -> i32 {
        self.x + self.width
    }

    fn bottom(&self) -> i32 {
        self.y + self.height
    }

    fn center(&self) -> (i32, i32) {
        (self.x + self.width / 2, self.y + self.height / 2)
    }

    fn contains(&self, (x, y): (i32, i32)) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }

    /// Squared distance from a point to the closest point of this rectangle.
    fn distance_squared(&self, (x, y): (i32, i32)) -> i64 {
        let dx = i64::from((self.x - x).max(0).max(x - self.right()));
        let dy = i64::from((self.y - y).max(0).max(y - self.bottom()));
        dx * dx + dy * dy
    }
}

/// Converts a rectangle tao reports in physical pixels back to points. Tao
/// derives each physical rectangle from points times one scale factor (a
/// monitor's own, or the window's current one), so `scale` must be that same
/// factor. Physical rectangles of monitors with different scales overlap and
/// cannot be compared; their points can.
pub fn to_points(position: (i32, i32), size: (u32, u32), scale: f64) -> Rect {
    let points = |value: f64| (value / scale).round() as i32;
    Rect::new(
        points(position.0.into()),
        points(position.1.into()),
        points(size.0.into()),
        points(size.1.into()),
    )
}

/// Keeps `[value, value + size]` inside `[start + margin, end - margin]`; when
/// it cannot fit, the start wins.
fn clamp_span(value: i32, size: i32, start: i32, end: i32, margin: i32) -> i32 {
    value.min(end - size - margin).max(start + margin)
}

/// The monitor that contains the window center, or the nearest one.
pub fn monitor_for(window: Rect, monitors: &[Rect]) -> Option<Rect> {
    let center = window.center();
    monitors
        .iter()
        .find(|m| m.contains(center))
        .or_else(|| monitors.iter().min_by_key(|m| m.distance_squared(center)))
        .copied()
}

/// Snaps a window to the nearest edge of its monitor, `margin` pixels inside,
/// and keeps the other axis on screen.
pub fn snap_to_edge(window: Rect, monitors: &[Rect], margin: i32) -> (i32, i32) {
    let Some(m) = monitor_for(window, monitors) else {
        return (window.x, window.y);
    };
    let x = clamp_span(window.x, window.width, m.x, m.right(), margin);
    let y = clamp_span(window.y, window.height, m.y, m.bottom(), margin);
    let left = window.x - m.x;
    let right = m.right() - window.right();
    let top = window.y - m.y;
    let bottom = m.bottom() - window.bottom();
    // Ties prefer the left and right edges, where the Dot lives by default.
    let nearest = [left, right, top, bottom].into_iter().min().unwrap();
    if nearest == left {
        (m.x + margin, y)
    } else if nearest == right {
        (m.right() - window.width - margin, y)
    } else if nearest == top {
        (x, m.y + margin)
    } else {
        (x, m.bottom() - window.height - margin)
    }
}

/// Right edge, vertically centered.
pub fn default_dot_position(monitor: Rect, size: (i32, i32), margin: i32) -> (i32, i32) {
    (monitor.right() - size.0 - margin, monitor.y + (monitor.height - size.1) / 2)
}

/// Where the Dot starts: the saved position re-snapped to the current monitors
/// (they may have changed since it was saved), or the right edge of the
/// primary work area. `size` is the Dot's real window size.
pub fn initial_dot_position(
    saved: Option<(i32, i32)>,
    size: (i32, i32),
    monitors: &[Rect],
    primary: Option<Rect>,
    margin: i32,
) -> Option<(i32, i32)> {
    match saved {
        Some((x, y)) if !monitors.is_empty() => Some(snap_to_edge(Rect::new(x, y, size.0, size.1), monitors, margin)),
        _ => primary.map(|work| default_dot_position(work, size, margin)),
    }
}

/// Places the panel beside the Dot on the side with more room, vertically
/// centered on the Dot, and clamped inside the monitor.
pub fn place_panel(dot: Rect, panel: (i32, i32), monitor: Rect, gap: i32, margin: i32) -> (i32, i32) {
    let (width, height) = panel;
    let room_left = dot.x - monitor.x;
    let room_right = monitor.right() - dot.right();
    let x = if room_right >= room_left { dot.right() + gap } else { dot.x - gap - width };
    let y = dot.y + dot.height / 2 - height / 2;
    (
        clamp_span(x, width, monitor.x, monitor.right(), margin),
        clamp_span(y, height, monitor.y, monitor.bottom(), margin),
    )
}

/// Places the panel when the rose is hidden (S26.1): back at its remembered
/// spot when that lies on the current display (pulled inside it), otherwise at
/// the right edge of the current display, vertically centered.
pub fn place_panel_alone(
    remembered: Option<(i32, i32)>,
    panel: (i32, i32),
    current: Rect,
    margin: i32,
) -> (i32, i32) {
    let (width, height) = panel;
    match remembered {
        Some((x, y)) if current.contains(Rect::new(x, y, width, height).center()) => (
            clamp_span(x, width, current.x, current.right(), margin),
            clamp_span(y, height, current.y, current.bottom(), margin),
        ),
        _ => default_dot_position(current, panel, margin),
    }
}

/// The frame of the full-screen panel (S26.2): the work area of the display
/// it is on, so the menu bar and the Dock stay visible.
pub fn full_screen_rect(panel: Rect, monitors: &[Rect]) -> Option<Rect> {
    monitor_for(panel, monitors)
}

/// The frame to return to from full screen: the one before, kept on a display
/// that still exists.
pub fn restore_rect(before: Rect, monitors: &[Rect], margin: i32) -> Rect {
    let Some(m) = monitor_for(before, monitors) else {
        return before;
    };
    Rect {
        x: clamp_span(before.x, before.width, m.x, m.right(), margin),
        y: clamp_span(before.y, before.height, m.y, m.bottom(), margin),
        ..before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect { x: 0, y: 0, width: 1920, height: 1080 };

    fn dot(x: i32, y: i32) -> Rect {
        Rect::new(x, y, 56, 56)
    }

    #[test]
    fn snaps_to_each_edge() {
        assert_eq!(snap_to_edge(dot(100, 500), &[SCREEN], 12), (12, 500));
        assert_eq!(snap_to_edge(dot(1700, 500), &[SCREEN], 12), (1852, 500));
        assert_eq!(snap_to_edge(dot(900, 40), &[SCREEN], 12), (900, 12));
        assert_eq!(snap_to_edge(dot(900, 1000), &[SCREEN], 12), (900, 1012));
    }

    #[test]
    fn snaps_corners_inside_the_monitor() {
        assert_eq!(snap_to_edge(dot(-30, -20), &[SCREEN], 12), (12, 12));
        // A tie between right and bottom prefers the vertical edge.
        assert_eq!(snap_to_edge(dot(1900, 1060), &[SCREEN], 12), (1852, 1012));
        assert_eq!(snap_to_edge(dot(5, 1030), &[SCREEN], 12), (12, 1012));
    }

    #[test]
    fn snaps_on_offset_monitors() {
        let right = Rect::new(1920, -200, 2560, 1440);
        let left = Rect::new(-1440, 0, 1440, 900);
        let monitors = [SCREEN, right, left];
        assert_eq!(snap_to_edge(dot(2000, 300), &monitors, 12), (1932, 300));
        assert_eq!(snap_to_edge(dot(-100, 400), &monitors, 12), (-68, 400));
        assert_eq!(snap_to_edge(dot(3000, -190), &monitors, 12), (3000, -188));
    }

    #[test]
    fn off_screen_window_goes_to_nearest_monitor() {
        assert_eq!(snap_to_edge(dot(3000, 500), &[SCREEN], 12), (1852, 500));
        assert_eq!(monitor_for(dot(3000, 500), &[SCREEN, Rect::new(-1440, 0, 1440, 900)]), Some(SCREEN));
        assert_eq!(monitor_for(dot(0, 0), &[]), None);
    }

    #[test]
    fn honors_the_margin_and_empty_monitor_list() {
        assert_eq!(snap_to_edge(dot(100, 500), &[SCREEN], 24), (24, 500));
        assert_eq!(snap_to_edge(dot(100, 500), &[SCREEN], 0), (0, 500));
        assert_eq!(snap_to_edge(dot(100, 500), &[], 12), (100, 500));
    }

    #[test]
    fn default_position_is_right_edge_vertically_centered() {
        assert_eq!(default_dot_position(SCREEN, (56, 56), 12), (1852, 512));
        assert_eq!(default_dot_position(Rect::new(1920, -200, 2560, 1440), (112, 112), 24), (4344, 464));
    }

    /// A window taller than wide: snapping must use its real size, whatever the shape.
    fn rose(x: i32, y: i32) -> Rect {
        Rect::new(x, y, 128, 168)
    }

    #[test]
    fn snaps_a_tall_window_by_its_real_size() {
        assert_eq!(snap_to_edge(rose(1700, 500), &[SCREEN], 24), (1768, 500));
        assert_eq!(snap_to_edge(rose(900, 900), &[SCREEN], 24), (900, 888));
        assert_eq!(snap_to_edge(rose(1850, 1000), &[SCREEN], 24), (1768, 888));
    }

    #[test]
    fn initial_position_restores_the_saved_spot_with_the_real_size() {
        // Saved near the bottom-right corner: the full 168 px height stays on screen.
        assert_eq!(initial_dot_position(Some((1768, 1000)), (128, 168), &[SCREEN], Some(SCREEN), 24), Some((1768, 888)));
        assert_eq!(initial_dot_position(Some((24, 300)), (128, 168), &[SCREEN], Some(SCREEN), 24), Some((24, 300)));
    }

    #[test]
    fn initial_position_defaults_to_the_primary_right_edge() {
        assert_eq!(initial_dot_position(None, (128, 168), &[SCREEN], Some(SCREEN), 24), Some((1768, 456)));
        // Without monitor information the saved spot cannot be checked, so use the primary monitor.
        assert_eq!(initial_dot_position(Some((5, 5)), (128, 168), &[], Some(SCREEN), 24), Some((1768, 456)));
        assert_eq!(initial_dot_position(None, (128, 168), &[], None, 24), None);
    }

    #[test]
    fn converts_each_rectangle_with_its_own_scale_factor() {
        // A 1512 × 945 pt Retina built-in (2×) and, to its right, a 2560 × 1440 pt display at 1×.
        // Tao reports them as (0, 0, 3024, 1890) and (1512, 0, 2560, 1440): in physical pixels the
        // two monitors overlap, so only points put every monitor in one coordinate space.
        let built_in = to_points((0, 0), (3024, 1890), 2.0);
        let external = to_points((1512, 0), (2560, 1440), 1.0);
        assert_eq!(built_in, Rect::new(0, 0, 1512, 945));
        assert_eq!(external, Rect::new(1512, 0, 2560, 1440));
        // The Dot on the external display, reported with the window's own 1× factor.
        let dot = to_points((3900, 600), (72, 72), 1.0);
        assert_eq!(dot, Rect::new(3900, 600, 72, 72));
        assert_eq!(monitor_for(dot, &[built_in, external]), Some(external));
        assert_eq!(snap_to_edge(dot, &[built_in, external], 12), (3988, 600));
        // The same window on the built-in reports twice the pixels, but the same points.
        assert_eq!(to_points((2736, 1200), (144, 144), 2.0), Rect::new(1368, 600, 72, 72));
    }

    #[test]
    fn places_a_72_point_dot_12_points_from_the_edge_of_a_retina_display() {
        // 3840 × 2160 at 2× (1920 × 1080 pt) below a 25 pt menu bar, as tao reports its work area.
        let main = to_points((0, 50), (3840, 2110), 2.0);
        assert_eq!(main, Rect::new(0, 25, 1920, 1055));
        let (x, y) = initial_dot_position(None, (72, 72), &[main], Some(main), 12).unwrap();
        assert_eq!((x, y), (1836, 516));
        assert_eq!(main.right() - (x + 72), 12);
        // A saved spot is restored in points, on whichever monitor it lies.
        let built_in = to_points((3840, 0), (2560, 1600), 2.0);
        assert_eq!(initial_dot_position(Some((3116, 400)), (72, 72), &[main, built_in], Some(main), 12), Some((3116, 400)));
    }

    #[test]
    fn panel_opens_toward_the_side_with_more_room() {
        assert_eq!(place_panel(dot(1852, 500), (420, 640), SCREEN, 8, 12), (1424, 208));
        assert_eq!(place_panel(dot(12, 500), (420, 640), SCREEN, 8, 12), (76, 208));
    }

    #[test]
    fn panel_without_the_rose_returns_to_its_remembered_spot_on_the_current_display() {
        assert_eq!(place_panel_alone(Some((300, 200)), (420, 640), SCREEN, 12), (300, 200));
        // A spot partly off the display is pulled back inside it.
        assert_eq!(place_panel_alone(Some((1700, 600)), (420, 640), SCREEN, 12), (1488, 428));
    }

    #[test]
    fn panel_without_the_rose_defaults_to_the_right_edge_of_the_current_display() {
        assert_eq!(place_panel_alone(None, (420, 640), SCREEN, 12), (1488, 220));
        // A spot remembered on another display does not drag the panel there.
        let right = Rect::new(1920, -200, 2560, 1440);
        assert_eq!(place_panel_alone(Some((300, 200)), (420, 640), right, 12), (4048, 200));
    }

    #[test]
    fn full_screen_fills_the_work_area_of_the_panel_display() {
        let right = Rect::new(1920, -200, 2560, 1440);
        assert_eq!(full_screen_rect(Rect::new(1424, 208, 420, 640), &[SCREEN, right]), Some(SCREEN));
        assert_eq!(full_screen_rect(Rect::new(2000, 0, 420, 640), &[SCREEN, right]), Some(right));
        assert_eq!(full_screen_rect(Rect::new(0, 0, 420, 640), &[]), None);
    }

    #[test]
    fn restoring_from_full_screen_returns_to_the_previous_frame() {
        let before = Rect::new(1424, 208, 420, 640);
        assert_eq!(restore_rect(before, &[SCREEN], 12), before);
        // The display it was on is gone: same size, moved onto the nearest one that remains.
        assert_eq!(restore_rect(Rect::new(2500, 100, 420, 640), &[SCREEN], 12), Rect::new(1488, 100, 420, 640));
        assert_eq!(restore_rect(before, &[], 12), before);
    }

    #[test]
    fn panel_is_clamped_to_the_monitor() {
        assert_eq!(place_panel(dot(12, 12), (420, 640), SCREEN, 8, 12), (76, 12));
        assert_eq!(place_panel(dot(12, 1012), (420, 640), SCREEN, 8, 12), (76, 428));
        let offset = Rect::new(1920, -200, 2560, 1440);
        assert_eq!(place_panel(dot(1932, -188), (420, 640), offset, 8, 12), (1996, -188));
        // A panel larger than the monitor keeps its top-left corner visible.
        assert_eq!(place_panel(dot(12, 100), (420, 640), Rect::new(0, 0, 400, 600), 8, 12), (12, 12));
    }
}
