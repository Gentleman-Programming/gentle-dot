//! Screenshot geometry (S24.2): the size a capture is downscaled to, and how a pixel of the
//! latest screenshot maps back to a global point (the unit macOS input events use).

/// Long edge of every screenshot, in pixels.
pub const MAX_LONG_EDGE: u32 = 1280;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// The size that fits `width × height` within a long edge of `max`, keeping the aspect
/// ratio. Never upscales and never returns a zero side.
pub fn fit_long_edge(width: u32, height: u32, max: u32) -> (u32, u32) {
    let long = width.max(height).max(1);
    if long <= max {
        return (width.max(1), height.max(1));
    }
    let fit = |side: u32| ((u64::from(side) * u64::from(max) + u64::from(long) / 2) / u64::from(long)).max(1) as u32;
    (fit(width), fit(height))
}

/// Where a screenshot came from: its size in pixels, the display's top-left corner in
/// global points, and `scale`, the screenshot pixels per point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenshotGeometry {
    pub image_width: u32,
    pub image_height: u32,
    pub scale: f64,
    pub origin: Point,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CoordError {
    NotFinite,
    OutOfBounds { width: u32, height: u32 },
}

impl std::fmt::Display for CoordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoordError::NotFinite => write!(f, "coordinates must be numbers"),
            CoordError::OutOfBounds { width, height } => {
                write!(f, "coordinates are outside the latest screenshot ({width} × {height} pixels)")
            }
        }
    }
}

impl ScreenshotGeometry {
    /// The geometry of a display `width_pt` points wide captured at `image_width × image_height`.
    pub fn for_display(origin: Point, width_pt: f64, image_width: u32, image_height: u32) -> Self {
        ScreenshotGeometry { image_width, image_height, scale: f64::from(image_width) / width_pt, origin }
    }

    /// Maps a screenshot pixel to a global point, rounded to a whole point.
    pub fn to_point(&self, x: f64, y: f64) -> Result<Point, CoordError> {
        if !x.is_finite() || !y.is_finite() {
            return Err(CoordError::NotFinite);
        }
        let (width, height) = (self.image_width, self.image_height);
        if x < 0.0 || y < 0.0 || x >= f64::from(width) || y >= f64::from(height) {
            return Err(CoordError::OutOfBounds { width, height });
        }
        Ok(Point { x: (self.origin.x + x / self.scale).round(), y: (self.origin.y + y / self.scale).round() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retina_laptop() -> ScreenshotGeometry {
        // A 1512 × 982 pt display captured at 1280 × 831 px.
        ScreenshotGeometry::for_display(Point { x: 0.0, y: 0.0 }, 1512.0, 1280, 831)
    }

    #[test]
    fn landscape_and_portrait_fit_the_long_edge() {
        assert_eq!(fit_long_edge(3024, 1964, 1280), (1280, 831));
        assert_eq!(fit_long_edge(1080, 1920, 1280), (720, 1280));
    }

    #[test]
    fn small_captures_are_never_upscaled() {
        assert_eq!(fit_long_edge(1024, 768, 1280), (1024, 768));
        assert_eq!(fit_long_edge(1280, 1280, 1280), (1280, 1280));
    }

    #[test]
    fn extreme_ratios_keep_at_least_one_pixel() {
        assert_eq!(fit_long_edge(100_000, 10, 1280), (1280, 1));
        assert_eq!(fit_long_edge(0, 0, 1280), (1, 1));
    }

    #[test]
    fn scale_is_screenshot_pixels_per_point() {
        let geometry = retina_laptop();
        assert!((geometry.scale - 1280.0 / 1512.0).abs() < 1e-9);
        assert_eq!((geometry.image_width, geometry.image_height), (1280, 831));
    }

    #[test]
    fn pixels_map_to_points_with_the_scale() {
        let geometry = ScreenshotGeometry::for_display(Point { x: 0.0, y: 0.0 }, 2560.0, 1280, 720);
        assert_eq!(geometry.to_point(640.0, 360.0), Ok(Point { x: 1280.0, y: 720.0 }));
        assert_eq!(geometry.to_point(0.0, 0.0), Ok(Point { x: 0.0, y: 0.0 }));
    }

    #[test]
    fn the_display_origin_is_added() {
        // A second display left of and above the main one.
        let geometry = ScreenshotGeometry::for_display(Point { x: -1920.0, y: -300.0 }, 1920.0, 1280, 720);
        assert_eq!(geometry.to_point(640.0, 360.0), Ok(Point { x: -960.0, y: 240.0 }));
    }

    #[test]
    fn points_are_rounded_to_whole_points() {
        // 100 px / (1280/1512) = 118.125 pt; 101 px = 119.30625 pt; 1279 px = 1510.81875 pt.
        let geometry = retina_laptop();
        assert_eq!(geometry.to_point(100.0, 101.0), Ok(Point { x: 118.0, y: 119.0 }));
        assert_eq!(geometry.to_point(1279.0, 0.5), Ok(Point { x: 1511.0, y: 1.0 }));
    }

    #[test]
    fn pixels_outside_the_screenshot_are_rejected() {
        let geometry = retina_laptop();
        let outside = Err(CoordError::OutOfBounds { width: 1280, height: 831 });
        assert_eq!(geometry.to_point(1280.0, 10.0), outside);
        assert_eq!(geometry.to_point(10.0, 831.0), outside);
        assert_eq!(geometry.to_point(-1.0, 10.0), outside);
        assert_eq!(geometry.to_point(10.0, -0.5), outside);
        assert_eq!(geometry.to_point(f64::NAN, 10.0), Err(CoordError::NotFinite));
        assert_eq!(geometry.to_point(10.0, f64::INFINITY), Err(CoordError::NotFinite));
    }
}
