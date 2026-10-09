//! Where the agent acts (S28): after each action that went through, the helper reports a
//! `Mark` in global points, and the app draws a pink glow there in a click-through overlay.
//! `place` picks the display the overlay covers and turns the mark into the overlay's own
//! coordinates (points from the display's top-left corner).

use super::coords::Point;
use serde::Serialize;

/// A rectangle in global points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Frame {
    pub fn contains(&self, at: Point) -> bool {
        at.x >= self.x && at.y >= self.y && at.x < self.x + self.width && at.y < self.y + self.height
    }

    fn center(&self) -> Point {
        Point { x: self.x + self.width / 2.0, y: self.y + self.height / 2.0 }
    }
}

/// What the agent just did, and where, in global points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Mark {
    /// A pulse.
    Click(Point),
    /// A short marker.
    Move(Point),
    /// A short marker.
    Scroll(Point),
    /// A trail from one point to the other.
    Drag { from: Point, to: Point },
    /// Keys went to the focused element; the app looks up where it is.
    Key,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GlowKind {
    Click,
    Move,
    Scroll,
    Drag,
    Key,
}

/// The `computer://glow` event for the overlay, in points from its top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlowEvent {
    pub kind: GlowKind,
    pub x: f64,
    pub y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

/// The display the overlay covers for `mark` and the event to draw on it, or `None` when the
/// position is unknown (a focused element without a frame, a point on no display). A drag
/// glows on the display where it starts; `focus` runs only for keyboard marks.
pub fn place(
    mark: Mark,
    display_at: impl Fn(Point) -> Option<Frame>,
    focus: impl FnOnce() -> Option<Frame>,
) -> Option<(Frame, GlowEvent)> {
    let at = |kind, point: Point| GlowEvent {
        kind,
        x: point.x,
        y: point.y,
        to_x: None,
        to_y: None,
        width: None,
        height: None,
    };
    let (anchor, event) = match mark {
        Mark::Click(point) => (point, at(GlowKind::Click, point)),
        Mark::Move(point) => (point, at(GlowKind::Move, point)),
        Mark::Scroll(point) => (point, at(GlowKind::Scroll, point)),
        Mark::Drag { from, to } => {
            (from, GlowEvent { to_x: Some(to.x), to_y: Some(to.y), ..at(GlowKind::Drag, from) })
        }
        Mark::Key => {
            let frame = focus().filter(|f| f.width > 0.0 && f.height > 0.0)?;
            let origin = Point { x: frame.x, y: frame.y };
            let event = GlowEvent { width: Some(frame.width), height: Some(frame.height), ..at(GlowKind::Key, origin) };
            (frame.center(), event)
        }
    };
    let display = display_at(anchor)?;
    let local = |x: f64, y: f64| (x - display.x, y - display.y);
    let (x, y) = local(event.x, event.y);
    let to = event.to_x.zip(event.to_y).map(|(tx, ty)| local(tx, ty));
    Some((display, GlowEvent { x, y, to_x: to.map(|t| t.0), to_y: to.map(|t| t.1), ..event }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Two displays side by side: the main one at the origin, a second one to its right.
    fn display_at(at: Point) -> Option<Frame> {
        let main = Frame { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };
        let second = Frame { x: 1440.0, y: -100.0, width: 1920.0, height: 1080.0 };
        [main, second].into_iter().find(|frame| frame.contains(at))
    }

    fn no_focus() -> Option<Frame> {
        None
    }

    fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    #[test]
    fn a_click_glows_at_its_point_on_the_display_it_is_on() {
        let (display, event) = place(Mark::Click(p(1500.0, 20.0)), display_at, no_focus).unwrap();
        assert_eq!(display, Frame { x: 1440.0, y: -100.0, width: 1920.0, height: 1080.0 });
        assert_eq!(serde_json::to_value(event).unwrap(), json!({"kind": "click", "x": 60.0, "y": 120.0}));
    }

    #[test]
    fn move_and_scroll_are_short_markers() {
        let (_, moved) = place(Mark::Move(p(10.0, 20.0)), display_at, no_focus).unwrap();
        let (_, scrolled) = place(Mark::Scroll(p(30.0, 40.0)), display_at, no_focus).unwrap();
        assert_eq!(serde_json::to_value(moved).unwrap(), json!({"kind": "move", "x": 10.0, "y": 20.0}));
        assert_eq!(serde_json::to_value(scrolled).unwrap(), json!({"kind": "scroll", "x": 30.0, "y": 40.0}));
    }

    #[test]
    fn a_drag_is_a_trail_on_the_display_where_it_starts() {
        let drag = Mark::Drag { from: p(100.0, 100.0), to: p(300.0, 250.0) };
        let (display, event) = place(drag, display_at, no_focus).unwrap();
        assert_eq!(display.x, 0.0);
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({"kind": "drag", "x": 100.0, "y": 100.0, "toX": 300.0, "toY": 250.0})
        );
    }

    #[test]
    fn a_keyboard_action_glows_around_the_focused_element() {
        let field = || Some(Frame { x: 1600.0, y: 0.0, width: 200.0, height: 30.0 });
        let (display, event) = place(Mark::Key, display_at, field).unwrap();
        assert_eq!(display.x, 1440.0);
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({"kind": "key", "x": 160.0, "y": 100.0, "width": 200.0, "height": 30.0})
        );
    }

    #[test]
    fn nothing_glows_where_the_position_is_unknown() {
        // The focused element has no frame, or the point is on no display.
        assert_eq!(place(Mark::Key, display_at, no_focus), None);
        assert_eq!(place(Mark::Click(p(-5000.0, 0.0)), display_at, no_focus), None);
        let empty = || Some(Frame { x: 10.0, y: 10.0, width: 0.0, height: 0.0 });
        assert_eq!(place(Mark::Key, display_at, empty), None);
    }
}
