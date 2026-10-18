//! Bounded screenshot normalization (T5 slice, S1-S5): rotate one raw
//! pre-transform screencopy buffer upright exactly once, downscale it to
//! [`crate::computer::coords::MAX_LONG_EDGE`], and hand the final RGB to the
//! capture step's single capped JPEG encode.
//!
//! The capture step hands over raw buffer pixels: for a rotated output that
//! buffer is transposed relative to what the user sees, so the agent would
//! misread every coordinate without this step. The transform applied here is
//! the [`OutputGeometry`] inverse exactly once (buffer to upright, the
//! reverse of the validated forward map): applying it anywhere else, twice,
//! or in the guessed direction scrambles the image and is pinned by the
//! asymmetric-grid tests, which hardcode the expected upright pixels for
//! all eight transforms.
//!
//! There is deliberately no JPEG entrypoint in this module (B1): decoding a
//! JPEG before validating its dimensions lets a small input drive a huge
//! allocation (compressed length is not a pixel limit, and the default
//! image-reader limits are non-strict). The production path normalizes raw
//! pixels and encodes once; this module stays on raw pixels throughout.
//!
//! Bounds: every stage shares the caller's total `deadline` and cooperative
//! [`CancelHandle`] (checked per band/row through rotation and downscale,
//! so a large frame stays preemptible instead of blocking inside one
//! monolithic `imageops::resize`, whose internal allocations are not
//! accounted here). Dimensions and the phased peak are validated before any
//! allocation through the capture caps ([`MAX_FRAME_PIXELS`],
//! [`MAX_JPEG_BYTES`], [`MAX_AGGREGATE_BYTES`]) and
//! [`normalized_peak_bytes`], so this step never weakens the capture
//! resource guarantees: the SHM length and pixel count clear their caps
//! before the memfd exists, and the BGRA/upright/resized/JPEG allocations
//! clear the phased peak before the BGRA rows exist.
//!
//! Aspect metadata (anisotropic advisory, no Mac changes): the normalized
//! image is the upright hardware buffer (`buffer` transposed back exactly
//! when the transform swaps axes), downscaled with
//! [`fit_long_edge`](crate::computer::coords::fit_long_edge), which
//! preserves the upright aspect up to one rounding pixel per side. The
//! [`ScreenshotGeometry`](crate::computer::coords::ScreenshotGeometry) scale
//! is uniform by construction (`image_width / logical_width`): it cannot
//! spell a per-axis skew. The skew it cannot spell is bounded — at most the
//! fractional-tolerance ±1 px the geometry constructor already accepts, plus
//! the `fit_long_edge` rounding — and the center-sampled mapping agreement
//! test pins every transform's corners against
//! [`OutputGeometry::buffer_to_global`]. If a future fractional scale ever
//! exceeds that bound, the geometry (not the pixels) is where to address
//! it; `coords.rs` stays untouched by this slice.
//!
//! No Wayland connection, no compositor, no filesystem: pure bytes in,
//! bounded pixels out.

use std::time::Instant;

use super::capture::{MAX_AGGREGATE_BYTES, MAX_FRAME_PIXELS, MAX_SHM_BYTES};
use super::geometry::{OutputGeometry, OutputTransform};
use super::transport::{check_wait, CancelHandle};
use crate::computer::coords::{fit_long_edge, Point, ScreenshotGeometry, MAX_LONG_EDGE};

/// What went wrong normalizing raw pixels. Every variant names the guilty
/// values and never guesses a compositor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizeError {
    /// A [`CancelHandle`] fired before the step finished.
    Cancelled,
    /// The total deadline elapsed before the step finished.
    Timeout,
    /// The frame needs more bytes than the cap allows, or the target
    /// contradicts the validated buffer (upscale requests, absurd sizes).
    TooLarge { bytes: u64, limit: u64 },
    /// The pixels are not the monitor's actual buffer size.
    DimensionMismatch { expected: (u32, u32), got: (u32, u32) },
    /// The input slice is shorter than the validated packed size.
    Truncated { expected: usize, got: usize },
}

/// Map a normalization failure into the capture error with the guilty
/// monitor attached, so the fused tail reports through the same truthful
/// variants as the raw tail (cancel/timeout as transport stops, oversize
/// as cap refusals, never a guessed compositor).
pub(crate) fn normalize_error(error: NormalizeError, registry_name: u32) -> super::capture::CaptureError {
    use super::capture::CaptureError;
    use super::transport::{TransportError, TransportKind};
    match error {
        NormalizeError::Cancelled => TransportError {
            kind: TransportKind::Cancelled,
            op: "capture",
            detail: "cancelled during frame normalization".to_owned(),
        }
        .into(),
        NormalizeError::Timeout => TransportError {
            kind: TransportKind::Timeout,
            op: "capture",
            detail: "the total deadline elapsed during frame normalization".to_owned(),
        }
        .into(),
        NormalizeError::TooLarge { bytes, limit } => CaptureError::Oversized {
            bytes: usize::try_from(bytes).unwrap_or(usize::MAX),
            limit: usize::try_from(limit).unwrap_or(usize::MAX),
        },
        NormalizeError::DimensionMismatch { expected, got } => {
            CaptureError::DimensionMismatch { registry_name, expected, got }
        }
        NormalizeError::Truncated { expected, got } => {
            CaptureError::Truncated { expected, got }
        }
    }
}

impl std::fmt::Display for NormalizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "normalize cancelled"),
            Self::Timeout => write!(f, "normalize deadline elapsed"),
            Self::TooLarge { bytes, limit } => {
                write!(f, "normalize needs {bytes} bytes, over the {limit}-byte cap")
            }
            Self::DimensionMismatch { expected, got } => write!(
                f,
                "raw pixels are {}x{} but this output needs {}x{}; \
                 refusing instead of remapping",
                got.0, got.1, expected.0, expected.1,
            ),
            Self::Truncated { expected, got } => {
                write!(f, "raw pixels hold {got} bytes, expected {expected}")
            }
        }
    }
}

impl std::error::Error for NormalizeError {}

impl From<super::transport::TransportError> for NormalizeError {
    fn from(error: super::transport::TransportError) -> Self {
        match error.kind {
            super::transport::TransportKind::Cancelled => Self::Cancelled,
            super::transport::TransportKind::Timeout => Self::Timeout,
            _ => Self::TooLarge { bytes: 0, limit: 0 },
        }
    }
}

/// The upright (untransformed, unswapped) image size for this geometry: the
/// buffer transposed back exactly when the transform swaps axes. At scale 1
/// this equals the logical size; at other scales it is the hardware size the
/// rotation math in [`OutputGeometry`] already validated.
pub fn upright_dimensions(geometry: &OutputGeometry) -> (u32, u32) {
    if geometry.transform().swaps_axes() {
        (geometry.buffer_height(), geometry.buffer_width())
    } else {
        (geometry.buffer_width(), geometry.buffer_height())
    }
}

/// The final normalized target for this geometry: the upright size
/// downscaled to [`MAX_LONG_EDGE`] (never upscaled) plus the
/// [`ScreenshotGeometry`] mapping the downscaled pixels back to the
/// output's global logical points with the origin preserved. Pure: no
/// deadline, no cancel, no allocation.
pub fn normalized_target(geometry: &OutputGeometry) -> (u32, u32, ScreenshotGeometry) {
    let (uw, uh) = upright_dimensions(geometry);
    let (tw, th) = fit_long_edge(uw, uh, MAX_LONG_EDGE);
    let origin = Point { x: geometry.x() as f64, y: geometry.y() as f64 };
    let out = ScreenshotGeometry::for_display(origin, geometry.logical_width() as f64, tw, th);
    (tw, th, out)
}

/// Buffer pixel `(bx, by)` holding upright pixel `(ux, uy)`: the discrete
/// form of the [`OutputGeometry`] inverse (un-rotate, then un-flip), with
/// `(w, h)` the upright dimensions. Hand-verified against the hardcoded
/// `b3_hardcoded_table` in `geometry_tests` (every transform, pixels A and
/// B); the rotation tests pin it again through real pixels. `pub(crate)` so
/// the adapter agreement tests map through the same inverse.
pub(crate) fn buffer_to_upright(ux: u32, uy: u32, w: u32, h: u32, transform: OutputTransform) -> (u32, u32) {
    match transform {
        OutputTransform::Normal => (ux, uy),
        OutputTransform::R90 => (uy, w - 1 - ux),
        OutputTransform::R180 => (w - 1 - ux, h - 1 - uy),
        OutputTransform::R270 => (h - 1 - uy, ux),
        OutputTransform::Flipped => (w - 1 - ux, uy),
        OutputTransform::Flipped90 => (uy, ux),
        OutputTransform::Flipped180 => (ux, h - 1 - uy),
        OutputTransform::Flipped270 => (h - 1 - uy, w - 1 - ux),
    }
}

/// Rotate packed BGRA rows (`width * height * 4`) to upright packed RGB
/// through the geometry's transform exactly once. `width`/`height` must be
/// the monitor's actual buffer dimensions and the slice exactly that many
/// packed pixels; anything else is refused before any allocation. The total
/// `deadline` and `cancel` bound every 16-row band, so a large frame stays
/// preemptible.
pub fn normalize_bgra_to_rgb(
    bgra: &[u8],
    width: u32,
    height: u32,
    geometry: &OutputGeometry,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<(Vec<u8>, u32, u32), NormalizeError> {
    if (width, height) != (geometry.buffer_width(), geometry.buffer_height()) {
        return Err(NormalizeError::DimensionMismatch {
            expected: (geometry.buffer_width(), geometry.buffer_height()),
            got: (width, height),
        });
    }
    let pixels = (u64::from(width))
        .checked_mul(u64::from(height))
        .ok_or(NormalizeError::TooLarge { bytes: u64::MAX, limit: MAX_FRAME_PIXELS })?;
    if pixels > MAX_FRAME_PIXELS {
        return Err(NormalizeError::TooLarge { bytes: pixels, limit: MAX_FRAME_PIXELS });
    }
    let packed = pixels
        .checked_mul(4)
        .ok_or(NormalizeError::TooLarge { bytes: pixels, limit: MAX_SHM_BYTES as u64 })?;
    if packed > MAX_SHM_BYTES as u64 {
        return Err(NormalizeError::TooLarge { bytes: packed, limit: MAX_SHM_BYTES as u64 });
    }
    if bgra.len() != packed as usize {
        return Err(NormalizeError::Truncated { expected: packed as usize, got: bgra.len() });
    }
    let (uw, uh) = upright_dimensions(geometry);
    let upright_len = (u64::from(uw))
        .checked_mul(u64::from(uh))
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or(NormalizeError::TooLarge { bytes: pixels, limit: MAX_AGGREGATE_BYTES })?;
    if upright_len > MAX_AGGREGATE_BYTES {
        return Err(NormalizeError::TooLarge { bytes: upright_len, limit: MAX_AGGREGATE_BYTES });
    }
    let transform = geometry.transform();
    let (w, uw_usize, uh_usize) = (width as usize, uw as usize, uh as usize);
    let mut rgb = vec![0u8; upright_len as usize];
    for uy in 0..uh_usize {
        // Preemptible per band: the deadline and cancel both bind here.
        if uy % 16 == 0 {
            check_wait("normalize", deadline, cancel)?;
        }
        for ux in 0..uw_usize {
            let (bx, by) = buffer_to_upright(ux as u32, uy as u32, uw, uh, transform);
            let s = (by as usize * w + bx as usize) * 4;
            let d = (uy * uw_usize + ux) * 3;
            rgb[d] = bgra[s + 2];
            rgb[d + 1] = bgra[s + 1];
            rgb[d + 2] = bgra[s];
        }
    }
    check_wait("normalize", deadline, cancel)?;
    Ok((rgb, uw, uh))
}

/// Downscale upright packed RGB (`uw * uh * 3`) to `tw * th` with separable
/// bilinear sampling, one output row at a time. The target must not exceed
/// the upright size (the fused path only downscales) and must clear the
/// byte caps with checked math before the output allocation exists. Every
/// output row checks the total `deadline` and `cancel` and reports through
/// `progress`, so cancellation lands mid-downscale instead of only around
/// it — deterministically testable via the hook, with no uninterruptible
/// resizer anywhere on this path. Eight parameters (dims in, dims out,
/// bounds, progress) because the caller accounts every one; splitting them
/// would hide the checked math.
#[allow(clippy::too_many_arguments)]
pub fn downscale_rgb_bilinear(
    rgb: &[u8],
    uw: u32,
    uh: u32,
    tw: u32,
    th: u32,
    deadline: Instant,
    cancel: &CancelHandle,
    progress: Option<&dyn Fn(u64)>,
) -> Result<Vec<u8>, NormalizeError> {
    if tw == 0 || th == 0 || uw == 0 || uh == 0 {
        return Err(NormalizeError::TooLarge { bytes: 0, limit: 1 });
    }
    if tw > uw || th > uh {
        // The fused path only ever downscales; an upscale target is a
        // caller bug, refused before any allocation.
        return Err(NormalizeError::TooLarge {
            bytes: u64::from(tw).saturating_mul(u64::from(th)),
            limit: u64::from(uw).saturating_mul(u64::from(uh)),
        });
    }
    let upright_len = (u64::from(uw))
        .checked_mul(u64::from(uh))
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or(NormalizeError::TooLarge { bytes: u64::MAX, limit: MAX_AGGREGATE_BYTES })?;
    if rgb.len() != upright_len as usize {
        return Err(NormalizeError::Truncated { expected: upright_len as usize, got: rgb.len() });
    }
    let out_len = (u64::from(tw))
        .checked_mul(u64::from(th))
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or(NormalizeError::TooLarge { bytes: u64::MAX, limit: MAX_AGGREGATE_BYTES })?;
    if out_len > MAX_AGGREGATE_BYTES {
        return Err(NormalizeError::TooLarge { bytes: out_len, limit: MAX_AGGREGATE_BYTES });
    }
    let (uw_usize, tw_usize, th_usize) = (uw as usize, tw as usize, th as usize);
    let (uw_f, uh_f, tw_f, th_f) = (uw as f64, uh as f64, tw as f64, th as f64);
    let mut out = vec![0u8; out_len as usize];
    for ty in 0..th_usize {
        check_wait("normalize", deadline, cancel)?;
        if let Some(report) = progress {
            report(ty as u64);
        }
        // Output center back to upright index space (integers are centers).
        let gy = (ty as f64 + 0.5) * uh_f / th_f - 0.5;
        let y0 = (gy.floor() as i64).clamp(0, uh as i64 - 1);
        let y1 = (y0 + 1).min(uh as i64 - 1);
        let fy = (gy - y0 as f64).clamp(0.0, 1.0);
        for tx in 0..tw_usize {
            let gx = (tx as f64 + 0.5) * uw_f / tw_f - 0.5;
            let x0 = (gx.floor() as i64).clamp(0, uw as i64 - 1);
            let x1 = (x0 + 1).min(uw as i64 - 1);
            let fx = (gx - x0 as f64).clamp(0.0, 1.0);
            for channel in 0..3 {
                let top_left = rgb[(y0 as usize * uw_usize + x0 as usize) * 3 + channel] as f64;
                let top_right = rgb[(y0 as usize * uw_usize + x1 as usize) * 3 + channel] as f64;
                let bottom_left = rgb[(y1 as usize * uw_usize + x0 as usize) * 3 + channel] as f64;
                let bottom_right = rgb[(y1 as usize * uw_usize + x1 as usize) * 3 + channel] as f64;
                let top = top_left + (top_right - top_left) * fx;
                let bottom = bottom_left + (bottom_right - bottom_left) * fx;
                out[(ty * tw_usize + tx) * 3 + channel] =
                    (top + (bottom - top) * fy).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    check_wait("normalize", deadline, cancel)?;
    Ok(out)
}
