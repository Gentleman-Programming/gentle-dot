//! Validated output geometry and buffer/global coordinate mapping (T3b1, S1-S4).
//!
//! Pure geometry only: no Wayland connection, no buffers, no input. The future
//! protocol collector (`outputs.rs`) fills this type from `wl_output` plus
//! `zxdg_output_v1` events; the future capture step (T3b2) uses
//! [`OutputGeometry::buffer_to_global`] to map screenshot pixels back to the
//! global logical points the input step (T4) posts.
//!
//! Mapping contract (the whole point is to rotate exactly once):
//! - Logical extents (`x`, `y`, `logical_width`, `logical_height`) live in
//!   global compositor space and already account for rotation: a 1920x1080
//!   panel turned 90 degrees reports logical 1080x1920 here (xdg-output
//!   logical size; negative origins preserved). Hit-testing uses these
//!   extents only; the transform is never applied to them.
//! - Buffer dimensions are the hardware mode size in physical pixels, in
//!   *pre-transform* orientation: Niri answers a full-output screencopy with
//!   `output.current_mode().size`, untransformed
//!   (`src/protocols/screencopy.rs`, `CaptureOutput`). A region capture is
//!   clamped in transformed physical space and then stored through
//!   `transform.invert().transform_rect_in` (same file,
//!   `CaptureOutputRegion`); damage travels physical-to-buffer through
//!   `transform.invert()` as well (`src/niri.rs`, screencopy damage path).
//!   What the user sees on screen is `transform.transform_size(mode.size)`
//!   (`src/ui/screenshot_ui.rs`). So for rotated outputs the buffer is
//!   transposed relative to logical times scale, and the output transform
//!   describes how logical content is presented in that buffer: mapping a
//!   buffer pixel back to logical applies the inverse exactly once (the
//!   flip-first counter-clockwise math Smithay/Niri implement). The
//!   constructor enforces the expected size; see
//!   [`OutputGeometry::expected_buffer_dimensions`].
//! - `scale` is physical pixels per logical point. Fractional scales are
//!   kept: 3840 physical over 2560 logical is 1.5, never rounded to 2.
//! - Nominal scale vs effective ratios: `scale` is the compositor-reported
//!   nominal scale (diagnostics, and the basis of the constructor's size
//!   check). Mapping instead uses the effective per-axis ratios derived
//!   from the validated hardware buffer (`buffer / logical` per axis,
//!   upright orientation): when the fractional tolerance accepts a one-pixel
//!   mismatch, the actual buffer is authoritative, so an accepted pixel can
//!   never map outside the logical extents. Integral mismatches are still
//!   rejected outright.
//! - Pixel-center contract: [`OutputGeometry::buffer_to_global`] takes pixel
//!   *indices*, where integers are pixel centers. The valid domain is the
//!   closed `[0, dim - 1]` range per axis; fractions are sub-pixel sample
//!   positions between centers (what a downscaled screenshot maps through).
//!   Every integer pixel, including the last row and column, lands strictly
//!   inside the output under every transform, so the result always feeds
//!   back into [`OutputGeometry::global_to_buffer`].
//! - [`OutputGeometry::buffer_to_global`] samples the pixel center, applies
//!   the *inverse* output transform, divides by scale, and adds the origin.
//!   [`OutputGeometry::global_to_buffer`] is the exact reverse, returning
//!   index-space coordinates. The transform lives on the buffer side only:
//!   applying it anywhere else rotates twice.
//! - Coordinates are exact `f64`. Exact min-edge global inputs map to
//!   half-negative indices (e.g. `-0.5`); callers flooring to integer pixels
//!   must bounds-check afterwards. Nothing is ever clamped.
//! - Off-output inputs (indices past the last pixel center, global points in
//!   the gaps between outputs) are refused, never clamped into an output.

use crate::computer::coords::Point;

/// A Wayland `wl_output.transform` value: counter-clockwise rotation, with the
/// flipped variants mirroring horizontally around the vertical axis first
/// (protocol `wayland.xml`, enum `wl_output.transform`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputTransform {
    Normal,
    R90,
    R180,
    R270,
    Flipped,
    Flipped90,
    Flipped180,
    Flipped270,
}

impl OutputTransform {
    /// The raw `wl_output.geometry` transform integer (valid values are 0-7).
    pub fn from_raw(raw: i32) -> Result<Self, GeometryError> {
        match raw {
            0 => Ok(Self::Normal),
            1 => Ok(Self::R90),
            2 => Ok(Self::R180),
            3 => Ok(Self::R270),
            4 => Ok(Self::Flipped),
            5 => Ok(Self::Flipped90),
            6 => Ok(Self::Flipped180),
            7 => Ok(Self::Flipped270),
            _ => Err(GeometryError::BadTransform(raw)),
        }
    }

    /// Whether the transform swaps axes (90/270 families report swapped
    /// buffer dimensions relative to upright physical size).
    pub fn swaps_axes(self) -> bool {
        matches!(self, Self::R90 | Self::R270 | Self::Flipped90 | Self::Flipped270)
    }

    fn is_flipped(self) -> bool {
        matches!(self, Self::Flipped | Self::Flipped90 | Self::Flipped180 | Self::Flipped270)
    }

    fn rotation(self) -> u8 {
        match self {
            Self::Normal | Self::Flipped => 0,
            Self::R90 | Self::Flipped90 => 1,
            Self::R180 | Self::Flipped180 => 2,
            Self::R270 | Self::Flipped270 => 3,
        }
    }

    /// Upright physical `(x, y)` in `w` by `h` to buffer coordinates.
    fn forward(self, mut x: f64, y: f64, w: f64, h: f64) -> (f64, f64) {
        // Flipped values mirror first, then rotate counter-clockwise.
        if self.is_flipped() {
            x = w - x;
        }
        match self.rotation() {
            0 => (x, y),
            1 => (y, w - x),
            2 => (w - x, h - y),
            _ => (h - y, x),
        }
    }

    /// Buffer `(bx, by)` back to upright physical in `w` by `h`: un-rotate,
    /// then un-flip (the mirror is its own inverse).
    fn inverse(self, bx: f64, by: f64, w: f64, h: f64) -> (f64, f64) {
        let (mut x, y) = match self.rotation() {
            0 => (bx, by),
            1 => (w - by, bx),
            2 => (w - bx, h - by),
            _ => (by, h - bx),
        };
        if self.is_flipped() {
            x = w - x;
        }
        (x, y)
    }
}

/// What went wrong validating geometry or mapping a coordinate. Off-output
/// inputs are refused (never clamped); every variant carries the values the
/// caller needs to log or pick another output.
#[derive(Debug, Clone, PartialEq)]
pub enum GeometryError {
    /// A logical or buffer dimension is zero or negative, or rounds to zero
    /// physical pixels. `field` names the offending dimension.
    EmptyExtent { field: &'static str },
    /// Scale is NaN or infinite.
    NonFiniteScale,
    /// Scale is zero or negative.
    NonPositiveScale,
    /// `logical * scale` is not finite or does not fit `u32` pixels.
    Overflow { field: &'static str },
    /// Raw `wl_output.geometry` transform outside 0-7.
    BadTransform(i32),
    /// A coordinate is NaN or infinite.
    NonFiniteCoordinate,
    /// Buffer pixel index outside this output's buffer (closed `[0, dim - 1]`
    /// pixel-index space; integers are pixel centers).
    OutsideBuffer { x: f64, y: f64, width: u32, height: u32 },
    /// Buffer dimensions do not match the logical extents at this
    /// scale/transform: `expected` is the (possibly transposed) physical size,
    /// `got` is what was passed. Only +/-1 per axis for fractional scales is
    /// forgiven (float dust); anything more is a different mode.
    InconsistentBuffer { field: &'static str, expected: u32, got: u32 },
    /// Global point outside this output's logical extents (half-open), which
    /// includes points in the gaps between outputs.
    OutsideOutput { x: f64, y: f64 },
}

impl std::fmt::Display for GeometryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyExtent { field } => {
                write!(f, "{field} must be positive (got zero, negative, or zero physical pixels)")
            }
            Self::NonFiniteScale => write!(f, "scale must be a finite number"),
            Self::NonPositiveScale => write!(f, "scale must be positive"),
            Self::Overflow { field } => write!(f, "{field} overflows u32 pixels"),
            Self::BadTransform(raw) => {
                write!(f, "unknown Wayland output transform {raw} (valid values are 0-7)")
            }
            Self::NonFiniteCoordinate => write!(f, "coordinates must be finite numbers"),
            Self::OutsideBuffer { x, y, width, height } => write!(
                f,
                "buffer pixel ({x}, {y}) is outside this output's {width}x{height} buffer"
            ),
            Self::InconsistentBuffer { field, expected, got } => write!(
                f,
                "buffer {field} mismatch: got {got} physical pixels but this output needs {expected} \
                 (only +/-1 rounding for fractional scales is accepted)"
            ),
            Self::OutsideOutput { x, y } => write!(
                f,
                "global point ({x}, {y}) is not inside this output (gaps are refused, never clamped)"
            ),
        }
    }
}

impl std::error::Error for GeometryError {}

/// `u32::MAX` as an exact `f64` (below 2^53, so no rounding): the largest
/// physical dimension the buffer math can represent.
const MAX_DIM_F: f64 = 4_294_967_295.0;

/// A validated output: logical extents in global compositor space plus the
/// transformed physical buffer size. Construct with [`OutputGeometry::new`];
/// fields are read through getters so the invariant cannot be broken.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OutputGeometry {
    x: i32,
    y: i32,
    logical_width: i32,
    logical_height: i32,
    scale: f64,
    transform: OutputTransform,
    buffer_width: u32,
    buffer_height: u32,
    // Upright (untransformed) physical size: round(logical * scale) per axis.
    physical_width: u32,
    physical_height: u32,
}

/// A buffer pixel in exact `f64` index-space coordinates (integers are pixel
/// centers; see the module contract). Floor and re-check bounds before
/// indexing discrete pixels: exact min-edge global inputs yield half-negative
/// indices such as `-0.5`, which flooring turns into a clean rejection.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BufferPoint {
    pub x: f64,
    pub y: f64,
}

impl OutputGeometry {
    /// Validate raw output fields. Negative origins are kept (outputs left or
    /// above the reference point); every dimension must be positive, the
    /// scale finite and positive with a physical size of at least one pixel,
    /// and the transform a Wayland value 0-7. Buffer dimensions must equal
    /// the (possibly transposed) physical size: exact for integral scales,
    /// within one pixel per axis for fractional scales (the scale travels as
    /// `f64` while hardware pixels are integers). Anything else is a
    /// different mode, not rounding, and is refused.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        x: i32,
        y: i32,
        logical_width: i32,
        logical_height: i32,
        scale: f64,
        transform: i32,
        buffer_width: i32,
        buffer_height: i32,
    ) -> Result<Self, GeometryError> {
        if logical_width <= 0 {
            return Err(GeometryError::EmptyExtent { field: "logical_width" });
        }
        if logical_height <= 0 {
            return Err(GeometryError::EmptyExtent { field: "logical_height" });
        }
        if !scale.is_finite() {
            return Err(GeometryError::NonFiniteScale);
        }
        if scale <= 0.0 {
            return Err(GeometryError::NonPositiveScale);
        }
        let transform = OutputTransform::from_raw(transform)?;
        if buffer_width <= 0 {
            return Err(GeometryError::EmptyExtent { field: "buffer_width" });
        }
        if buffer_height <= 0 {
            return Err(GeometryError::EmptyExtent { field: "buffer_height" });
        }
        let physical_width = physical_dim(logical_width, scale, "physical_width")?;
        let physical_height = physical_dim(logical_height, scale, "physical_height")?;
        // The screencopy buffer is the hardware mode size in pre-transform
        // orientation (B1): transposed relative to logical extents exactly
        // when the transform swaps axes.
        let (expected_w, expected_h) = if transform.swaps_axes() {
            (physical_height, physical_width)
        } else {
            (physical_width, physical_height)
        };
        check_buffer_dim(buffer_width as u32, expected_w, scale, "buffer_width")?;
        check_buffer_dim(buffer_height as u32, expected_h, scale, "buffer_height")?;
        Ok(Self {
            x,
            y,
            logical_width,
            logical_height,
            scale,
            transform,
            buffer_width: buffer_width as u32,
            buffer_height: buffer_height as u32,
            physical_width,
            physical_height,
        })
    }

    pub fn x(&self) -> i32 {
        self.x
    }
    pub fn y(&self) -> i32 {
        self.y
    }
    pub fn logical_width(&self) -> i32 {
        self.logical_width
    }
    pub fn logical_height(&self) -> i32 {
        self.logical_height
    }
    /// Compositor-reported nominal scale. Retained for diagnostics and the
    /// constructor's size check; the mapping itself divides/multiplies by
    /// [`OutputGeometry::effective_scale`].
    pub fn scale(&self) -> f64 {
        self.scale
    }
    /// Effective per-axis ratios the mapping actually uses: validated buffer
    /// dimension over logical extent per axis, in upright (untransformed,
    /// unswapped) orientation. Equal to the nominal scale when the buffer
    /// matches exactly; skewed by the accepted rounding when the fractional
    /// tolerance forgives a one-pixel mismatch (the hardware buffer is then
    /// authoritative, so accepted pixels stay inside the logical extents).
    pub fn effective_scale(&self) -> (f64, f64) {
        self.effective_ratios()
    }
    pub fn transform(&self) -> OutputTransform {
        self.transform
    }
    pub fn buffer_width(&self) -> u32 {
        self.buffer_width
    }
    pub fn buffer_height(&self) -> u32 {
        self.buffer_height
    }

    /// The exact buffer size this geometry accepts (transposed when the
    /// transform swaps axes). The constructor enforces it: exact for integral
    /// scales, within one pixel per axis for fractional scales.
    pub fn expected_buffer_dimensions(&self) -> (u32, u32) {
        if self.transform.swaps_axes() {
            (self.physical_height, self.physical_width)
        } else {
            (self.physical_width, self.physical_height)
        }
    }

    /// Half-open hit test on the logical extents (the only place the
    /// transform must not appear). Non-finite inputs never match.
    pub fn contains_global(&self, gx: f64, gy: f64) -> bool {
        if !gx.is_finite() || !gy.is_finite() {
            return false;
        }
        // `as f64` is exact for i32, and the addition cannot overflow there.
        let (x0, y0) = (self.x as f64, self.y as f64);
        gx >= x0
            && gx < x0 + self.logical_width as f64
            && gy >= y0
            && gy < y0 + self.logical_height as f64
    }

    /// Screenshot pixel index to global logical point: sample the pixel
    /// center, apply the inverse transform, divide by the effective per-axis
    /// ratios, add origin. Same
    /// scale/origin semantics as `coords::ScreenshotGeometry::to_point`,
    /// extended with the output transform, negative origins, and the
    /// pixel-center contract (integers are centers, so every integer pixel
    /// lands strictly inside under every transform).
    pub fn buffer_to_global(&self, bx: f64, by: f64) -> Result<Point, GeometryError> {
        if !bx.is_finite() || !by.is_finite() {
            return Err(GeometryError::NonFiniteCoordinate);
        }
        let (bw, bh) = (self.buffer_width as f64, self.buffer_height as f64);
        if bx < 0.0 || by < 0.0 || bx > bw - 1.0 || by > bh - 1.0 {
            return Err(GeometryError::OutsideBuffer {
                x: bx,
                y: by,
                width: self.buffer_width,
                height: self.buffer_height,
            });
        }
        let (w, h) = self.upright_buffer();
        let (rx, ry) = self.effective_ratios();
        let (px, py) = self.transform.inverse(bx + 0.5, by + 0.5, w, h);
        Ok(Point { x: self.x as f64 + px / rx, y: self.y as f64 + py / ry })
    }

    /// Global logical point to screenshot pixel index: subtract origin,
    /// multiply by the effective per-axis ratios, apply the forward
    /// transform, express as an index (integers are centers). Points outside
    /// the logical extents (including gaps) are refused, never clamped to an
    /// edge. Exact min-edge inputs yield half-negative indices; flooring plus
    /// a bounds check rejects them.
    pub fn global_to_buffer(&self, gx: f64, gy: f64) -> Result<BufferPoint, GeometryError> {
        if !gx.is_finite() || !gy.is_finite() {
            return Err(GeometryError::NonFiniteCoordinate);
        }
        if !self.contains_global(gx, gy) {
            return Err(GeometryError::OutsideOutput { x: gx, y: gy });
        }
        let (rx, ry) = self.effective_ratios();
        let px = (gx - self.x as f64) * rx;
        let py = (gy - self.y as f64) * ry;
        if !px.is_finite() || !py.is_finite() {
            return Err(GeometryError::Overflow { field: "physical pixel" });
        }
        let (w, h) = self.upright_buffer();
        let (bx, by) = self.transform.forward(px, py, w, h);
        Ok(BufferPoint { x: bx - 0.5, y: by - 0.5 })
    }

    /// Validated buffer size in upright (untransformed) orientation as `f64`
    /// for the transform math: transposed back exactly when the transform
    /// swaps axes. This is the authoritative hardware size, not the nominal
    /// `round(logical * scale)`.
    fn upright_buffer(&self) -> (f64, f64) {
        if self.transform.swaps_axes() {
            (self.buffer_height as f64, self.buffer_width as f64)
        } else {
            (self.buffer_width as f64, self.buffer_height as f64)
        }
    }

    /// Per-axis `buffer / logical` ratios in upright orientation (see
    /// [`OutputGeometry::effective_scale`]).
    fn effective_ratios(&self) -> (f64, f64) {
        let (w, h) = self.upright_buffer();
        (w / self.logical_width as f64, h / self.logical_height as f64)
    }
}

/// The buffer dimension must equal `expected` (the possibly transposed
/// physical size): exact when the scale is integral (exact in `f64`), within
/// one pixel when it is fractional (the scale travels as `f64` while hardware
/// pixels are integers, so the rounding can wobble by one). Anything beyond
/// that is a different mode, not rounding, and is refused.
fn check_buffer_dim(
    provided: u32,
    expected: u32,
    scale: f64,
    field: &'static str,
) -> Result<(), GeometryError> {
    if provided == expected {
        return Ok(());
    }
    let slop = (provided as i64 - expected as i64).abs();
    if scale.fract() != 0.0 && slop <= 1 {
        return Ok(());
    }
    Err(GeometryError::InconsistentBuffer { field, expected, got: provided })
}

/// `round(logical * scale)` as `u32` pixels: rejects non-finite products,
/// overflow, and scales so small the output would have no pixels.
fn physical_dim(logical: i32, scale: f64, field: &'static str) -> Result<u32, GeometryError> {
    let exact = logical as f64 * scale;
    if !exact.is_finite() {
        return Err(GeometryError::Overflow { field });
    }
    let rounded = exact.round();
    if rounded < 1.0 {
        return Err(GeometryError::EmptyExtent { field });
    }
    if rounded > MAX_DIM_F {
        return Err(GeometryError::Overflow { field });
    }
    Ok(rounded as u32)
}
