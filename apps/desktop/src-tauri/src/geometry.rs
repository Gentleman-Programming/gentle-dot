//! Pure placement math for the Dot and the panel, in physical pixels.

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

    /// The rose window is taller than wide: 64 × 84 pt, here at 2× scale.
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
    fn panel_opens_toward_the_side_with_more_room() {
        assert_eq!(place_panel(dot(1852, 500), (420, 640), SCREEN, 8, 12), (1424, 208));
        assert_eq!(place_panel(dot(12, 500), (420, 640), SCREEN, 8, 12), (76, 208));
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
