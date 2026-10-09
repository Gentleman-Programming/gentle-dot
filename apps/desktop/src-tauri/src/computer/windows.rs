//! Which window owns a point (S24.4), decided from the on-screen window list, front to back.
//! The list also holds windows no app owns (the pointer, the menu bar backdrop), which must
//! never stand in for the app underneath. Neither may Gentle Dot's click-through glow overlay
//! (S28), skipped by its window number alone: the panel and the Dot still own their points.

use super::coords::Point;

/// `kCGCursorWindowLevel`: the pointer and everything above it are never a target.
pub const CURSOR_WINDOW_LEVEL: i64 = 2_147_483_630;

/// One entry of `CGWindowListCopyWindowInfo`, in global points.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowRow {
    /// `kCGWindowNumber`.
    pub number: u32,
    pub pid: i32,
    pub owner_name: String,
    pub layer: i64,
    pub alpha: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WindowRow {
    fn contains(&self, at: Point) -> bool {
        at.x >= self.x && at.y >= self.y && at.x < self.x + self.width && at.y < self.y + self.height
    }

    /// The window server draws the pointer, the menu bar backdrop, and other system layers.
    fn is_window_server(&self) -> bool {
        let owner: String = self.owner_name.chars().filter(|c| !c.is_whitespace()).collect();
        owner.eq_ignore_ascii_case("WindowServer")
    }

    fn belongs_to_an_app(&self) -> bool {
        self.pid > 0 && self.layer < CURSOR_WINDOW_LEVEL && !self.is_window_server()
    }
}

/// The frontmost visible window under `at` that belongs to an app, or `None` when there is none.
/// `overlay` is the glow overlay's window number, once it exists.
pub fn owner_row_at(rows: &[WindowRow], at: Point, overlay: Option<u32>) -> Option<&WindowRow> {
    rows.iter().find(|row| {
        Some(row.number) != overlay && row.alpha > 0.0 && row.belongs_to_an_app() && row.contains(at)
    })
}

/// The app to hit-test again when the system-wide Accessibility hit test answered with
/// Gentle Dot (`hit_pid == own_pid`) while another app owns the window under the point: the
/// test went through the click-through overlay. `None` keeps the system-wide answer.
pub fn hit_test_app(own_pid: i32, hit_pid: i32, owner_pid: Option<i32>) -> Option<i32> {
    owner_pid.filter(|&owner| hit_pid == own_pid && owner != own_pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: Point = Point { x: 500.0, y: 400.0 };

    fn row(pid: i32, owner: &str, layer: i64, (x, y, width, height): (f64, f64, f64, f64)) -> WindowRow {
        WindowRow { number: 0, pid, owner_name: owner.into(), layer, alpha: 1.0, x, y, width, height }
    }

    const OWN_PID: i32 = 4242;
    const GLOW_WINDOW: u32 = 9001;

    /// The glow overlay (S28) as a real Mac would list it: Gentle Dot's, over the whole display.
    fn glow() -> WindowRow {
        WindowRow { number: GLOW_WINDOW, ..row(OWN_PID, "Gentle Dot", 102, (0.0, 0.0, 1440.0, 900.0)) }
    }

    /// The pointer window as a real Mac lists it, right under the pointer and first in the list.
    fn cursor() -> WindowRow {
        row(412, "Window Server", CURSOR_WINDOW_LEVEL, (496.0, 396.0, 32.0, 32.0))
    }

    fn safari() -> WindowRow {
        row(200, "Safari", 0, (0.0, 25.0, 1440.0, 875.0))
    }

    #[test]
    fn the_pointer_window_is_skipped_for_the_app_underneath() {
        let rows = [cursor(), safari()];
        assert_eq!(owner_row_at(&rows, AT, None).map(|r| r.pid), Some(200));
    }

    #[test]
    fn windows_owned_by_the_window_server_are_skipped() {
        let backdrop = row(412, "WindowServer", 0, (0.0, 0.0, 1440.0, 900.0));
        let rows = [row(412, "Window Server", 24, (0.0, 0.0, 1440.0, 900.0)), backdrop, safari()];
        assert_eq!(owner_row_at(&rows, AT, None).map(|r| r.pid), Some(200));
    }

    #[test]
    fn invisible_windows_and_windows_elsewhere_are_skipped() {
        let clear = WindowRow { alpha: 0.0, ..row(300, "Overlay", 0, (0.0, 0.0, 1440.0, 900.0)) };
        let elsewhere = row(301, "Notes", 0, (900.0, 600.0, 200.0, 200.0));
        let rows = [clear, elsewhere, safari()];
        assert_eq!(owner_row_at(&rows, AT, None).map(|r| r.pid), Some(200));
    }

    #[test]
    fn rows_without_a_process_are_skipped() {
        let rows = [row(0, "", 0, (0.0, 0.0, 1440.0, 900.0)), safari()];
        assert_eq!(owner_row_at(&rows, AT, None).map(|r| r.pid), Some(200));
    }

    #[test]
    fn high_system_prompts_still_own_their_point() {
        // A lock or authorization prompt sits above every app window but below the pointer.
        let prompt = row(150, "loginwindow", 2_147_483_628, (0.0, 0.0, 1440.0, 900.0));
        let rows = [cursor(), prompt, safari()];
        assert_eq!(owner_row_at(&rows, AT, None).map(|r| r.pid), Some(150));
    }

    #[test]
    fn only_the_pointer_under_the_point_resolves_to_nothing() {
        assert_eq!(owner_row_at(&[cursor()], AT, None), None);
        assert_eq!(owner_row_at(&[], AT, None), None);
    }

    #[test]
    fn the_glow_overlay_is_skipped_by_its_window_number() {
        let rows = [cursor(), glow(), safari()];
        assert_eq!(owner_row_at(&rows, AT, Some(GLOW_WINDOW)).map(|r| r.pid), Some(200));
    }

    #[test]
    fn the_panel_and_the_dot_under_the_glow_still_resolve_to_gentle_dot() {
        let panel = WindowRow { number: 9002, ..row(OWN_PID, "Gentle Dot", 3, (400.0, 300.0, 420.0, 640.0)) };
        let dot = WindowRow { number: 9003, ..row(OWN_PID, "Gentle Dot", 3, (490.0, 390.0, 72.0, 72.0)) };
        for rows in [[cursor(), glow(), panel.clone(), safari()], [cursor(), glow(), dot, safari()]] {
            assert_eq!(owner_row_at(&rows, AT, Some(GLOW_WINDOW)).map(|r| r.pid), Some(OWN_PID));
        }
    }

    #[test]
    fn only_the_overlay_number_is_skipped() {
        // Another window of the same owner and level, or the overlay before its number is known,
        // still owns the point (and Gentle Dot's windows are refused).
        let other = WindowRow { number: 9004, ..glow() };
        assert_eq!(owner_row_at(&[other, safari()], AT, Some(GLOW_WINDOW)).map(|r| r.pid), Some(OWN_PID));
        assert_eq!(owner_row_at(&[glow(), safari()], AT, None).map(|r| r.pid), Some(OWN_PID));
    }

    #[test]
    fn a_hit_test_that_lands_on_the_overlay_is_redone_in_the_app_underneath() {
        // The Accessibility hit test may land on the overlay; the risk check needs the element
        // of the app that owns the window under the point.
        assert_eq!(hit_test_app(OWN_PID, OWN_PID, Some(200)), Some(200));
        assert_eq!(hit_test_app(OWN_PID, 200, Some(200)), None);
        // Over the panel or the Dot (or nothing known), the system-wide answer stands.
        assert_eq!(hit_test_app(OWN_PID, OWN_PID, Some(OWN_PID)), None);
        assert_eq!(hit_test_app(OWN_PID, OWN_PID, None), None);
    }
}
