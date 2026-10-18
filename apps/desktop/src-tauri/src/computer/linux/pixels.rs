//! SHM pixel decoding for screencopy capture (T3b2, S1-S4).
//!
//! Pure conversion only: validated `wl_shm` buffer bytes become packed BGRA
//! rows for [`crate::computer::encode::bgra_to_jpeg`]. No Wayland connection,
//! no file mapping, no allocation beyond the returned rows: the caller sizes
//! and reads the SHM file itself (see [`super::capture`]), so a short file
//! surfaces here as [`PixelsError::Truncated`] instead of an unsafe read.
//!
//! Reference divergence (attribution in `THIRD_PARTY_NOTICES.md`): the
//! little-endian channel maps and the y-invert row flip follow
//! `wlroots-bridge` `capture.rs` `decode_shm`, but the output is packed BGRA
//! (not packed RGB) so the established `encode.rs` JPEG path is reused
//! instead of growing a second encoder, and every dimension is checked
//! before any byte is indexed.

use wayland_client::protocol::wl_shm;

/// One validated screencopy `buffer` event: format plus dimensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameParams {
    pub format: wl_shm::Format,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
}

/// What went wrong decoding SHM bytes. Every variant names the offending
/// values so the capture step can log them truthfully.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PixelsError {
    /// A buffer dimension is zero (nothing to decode).
    EmptyExtent { field: &'static str },
    /// The compositor offered a format this slice cannot decode; `format`
    /// is the debug rendering (`Unknown(...)` for unlisted codes).
    UnsupportedFormat { format: String },
    /// `stride` is smaller than the row's pixel data (`width * 4`).
    StrideTooSmall { stride: u32, minimum: usize },
    /// Checked dimension math overflowed; `field` names the product.
    Overflow { field: &'static str },
    /// The validated byte length exceeds the explicit memory cap.
    TooLarge { bytes: usize, limit: usize },
    /// The file handed over fewer bytes than the validated length.
    Truncated { expected: usize, got: usize },
    /// Processing stopped because the cancel handle fired mid-decode.
    Cancelled,
}

impl std::fmt::Display for PixelsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyExtent { field } => {
                write!(f, "{field} must be positive (compositor sent zero)")
            }
            Self::UnsupportedFormat { format } => {
                write!(f, "unsupported screencopy pixel format {format}")
            }
            Self::StrideTooSmall { stride, minimum } => {
                write!(f, "screencopy stride {stride} is smaller than the row minimum {minimum}")
            }
            Self::Overflow { field } => write!(f, "screencopy {field} overflows usize"),
            Self::TooLarge { bytes, limit } => {
                write!(f, "screencopy buffer needs {bytes} bytes, over the {limit}-byte cap")
            }
            Self::Truncated { expected, got } => {
                write!(f, "screencopy file holds {got} bytes, expected {expected}")
            }
            Self::Cancelled => write!(f, "frame processing was cancelled"),
        }
    }
}

impl std::error::Error for PixelsError {}

use super::transport::CancelHandle;

/// Validated pixel count (`width * height`) as `u64`: dimensions are checked
/// first (same rules as the byte length), and the product cannot overflow
/// `u64` for `u32` dimensions. The capture step caps this before the BGRA
/// allocation exists.
pub fn pixel_count(params: FrameParams) -> Result<u64, PixelsError> {
    frame_byte_len(params, usize::MAX)?;
    Ok(params.width as u64 * params.height as u64)
}

/// Worst-case transient bytes for one frame: the validated SHM file plus the
/// decoded BGRA rows plus the encoder-internal RGB copy. Every addend is
/// checked. Kept for the decode-side accounting pin; the capture path
/// budgets through [`capture_peak_bytes`], which additionally covers the
/// kernel memfd pages, the capped JPEG output, and the phased drops.
pub fn aggregate_len(shm_len: usize, params: FrameParams) -> Result<u64, PixelsError> {
    let pixels = pixel_count(params)?;
    let bgra = pixels.checked_mul(4).ok_or(PixelsError::Overflow { field: "bgra rows" })?;
    let rgb = pixels.checked_mul(3).ok_or(PixelsError::Overflow { field: "encoder rgb" })?;
    (shm_len as u64)
        .checked_add(bgra)
        .and_then(|total| total.checked_add(rgb))
        .ok_or(PixelsError::Overflow { field: "aggregate frame memory" })
}

/// Worst-case simultaneously-live bytes for one NORMALIZED capture: the
/// fused rotate-plus-downscale pipeline the production adapter uses. Same
/// phase discipline as [`capture_peak_bytes`], with one more phase. Every
/// addend is checked, the capture step caps the peak before the memfd
/// exists, and drops each intermediate buffer as soon as its phase ends, so
/// reality stays at or under the accounted peak. Phases, each counting the
/// memfd (kernel pages the compositor keeps mapped until the pool is
/// destroyed): decode (plus read-back vec plus BGRA rows), convert (plus
/// BGRA plus the upright RGB copy, same pixel count as the buffer,
/// transposed), downscale (plus upright RGB plus the downscaled RGB), and
/// encode (plus downscaled RGB plus the capped JPEG output `jpeg_cap` the
/// writer enforces before the output vec grows).
/// `target_pixels` is the downscaled `tw * ht` product the caller computed
/// with checked math; it is rechecked here against the pixel cap so a
/// lying caller cannot smuggle an unbounded allocation past the accounting.
pub fn normalized_peak_bytes(
    shm_len: usize,
    params: FrameParams,
    target_pixels: u64,
    jpeg_cap: u64,
) -> Result<u64, PixelsError> {
    let pixels = pixel_count(params)?;
    if target_pixels > pixels {
        // The fused path only ever downscales: a larger target is a
        // caller bug, refused before any allocation.
        return Err(PixelsError::TooLarge {
            bytes: usize::try_from(target_pixels).unwrap_or(usize::MAX),
            limit: usize::try_from(pixels).unwrap_or(usize::MAX),
        });
    }
    let bgra = pixels.checked_mul(4).ok_or(PixelsError::Overflow { field: "bgra rows" })?;
    // Upright RGB holds the same pixel count transposed: identical size.
    let upright = pixels.checked_mul(3).ok_or(PixelsError::Overflow { field: "upright rgb" })?;
    let resized = target_pixels
        .checked_mul(3)
        .ok_or(PixelsError::Overflow { field: "downscaled rgb" })?;
    let shm = shm_len as u64;
    let decode_peak = shm
        .checked_add(shm)
        .and_then(|total| total.checked_add(bgra))
        .ok_or(PixelsError::Overflow { field: "decode-phase frame memory" })?;
    let convert_peak = shm
        .checked_add(bgra)
        .and_then(|total| total.checked_add(upright))
        .ok_or(PixelsError::Overflow { field: "convert-phase frame memory" })?;
    let downscale_peak = shm
        .checked_add(upright)
        .and_then(|total| total.checked_add(resized))
        .ok_or(PixelsError::Overflow { field: "downscale-phase frame memory" })?;
    let encode_peak = shm
        .checked_add(resized)
        .and_then(|total| total.checked_add(jpeg_cap))
        .ok_or(PixelsError::Overflow { field: "encode-phase frame memory" })?;
    Ok(decode_peak.max(convert_peak).max(downscale_peak).max(encode_peak))
}

/// Worst-case simultaneously-live bytes for one capture, as the largest of
/// the three phase peaks. Every addend is checked; the capture step caps
/// the peak before the memfd exists and drops each intermediate buffer as
/// soon as its phase ends, so reality stays at or under the accounted peak:
/// - decode phase: memfd (kernel pages the compositor keeps mapped until
///   the pool is destroyed — counted for the whole capture, not just the
///   userspace read-back copy) plus the read-back vec plus BGRA rows;
/// - convert phase: memfd plus BGRA plus the encoder-internal RGB copy;
/// - encode phase: memfd plus RGB plus the capped JPEG output (`jpeg_cap`)
///   the writer enforces before the output vec grows.
pub fn capture_peak_bytes(
    shm_len: usize,
    params: FrameParams,
    jpeg_cap: u64,
) -> Result<u64, PixelsError> {
    let pixels = pixel_count(params)?;
    let bgra = pixels.checked_mul(4).ok_or(PixelsError::Overflow { field: "bgra rows" })?;
    let rgb = pixels.checked_mul(3).ok_or(PixelsError::Overflow { field: "encoder rgb" })?;
    let shm = shm_len as u64;
    let decode_peak = shm
        .checked_add(shm)
        .and_then(|total| total.checked_add(bgra))
        .ok_or(PixelsError::Overflow { field: "decode-phase frame memory" })?;
    let convert_peak = shm
        .checked_add(bgra)
        .and_then(|total| total.checked_add(rgb))
        .ok_or(PixelsError::Overflow { field: "convert-phase frame memory" })?;
    let encode_peak = shm
        .checked_add(rgb)
        .and_then(|total| total.checked_add(jpeg_cap))
        .ok_or(PixelsError::Overflow { field: "encode-phase frame memory" })?;
    Ok(decode_peak.max(convert_peak).max(encode_peak))
}

/// Validated byte length of the SHM file (`stride * height`): checks
/// dimensions, stride, overflow and the caller-supplied memory cap before
/// anyone allocates or indexes. Both the pre-allocation check and the
/// post-read decode go through here so they can never disagree.
pub fn frame_byte_len(params: FrameParams, max_bytes: usize) -> Result<usize, PixelsError> {
    if params.width == 0 {
        return Err(PixelsError::EmptyExtent { field: "buffer_width" });
    }
    if params.height == 0 {
        return Err(PixelsError::EmptyExtent { field: "buffer_height" });
    }
    check_format(params.format)?;
    let row_min = (params.width as usize)
        .checked_mul(4)
        .ok_or(PixelsError::Overflow { field: "row bytes" })?;
    if (params.stride as usize) < row_min {
        return Err(PixelsError::StrideTooSmall { stride: params.stride, minimum: row_min });
    }
    // `stride` fits `u32` and `height` is checked nonzero, so the only
    // overflow left is the product itself.
    let total = (params.stride as usize)
        .checked_mul(params.height as usize)
        .ok_or(PixelsError::Overflow { field: "stride * height" })?;
    if total > max_bytes {
        return Err(PixelsError::TooLarge { bytes: total, limit: max_bytes });
    }
    Ok(total)
}

/// Decode validated SHM bytes to packed BGRA rows (`width * height * 4`,
/// alpha forced to 255): de-strides padded rows, flips bottom-up when the
/// frame reports y-invert, and maps the four little-endian 32-bit layouts
/// compositors hand out. Checks `cancel` every row and reports decoded rows
/// through `progress` every 16 rows (plus once at the end), so a large frame
/// stays preemptible. Pure otherwise: returns an error, never panics.
pub fn decode_shm_to_bgra(
    data: &[u8],
    params: FrameParams,
    y_invert: bool,
    cancel: &CancelHandle,
    progress: Option<&dyn Fn(u64)>,
) -> Result<Vec<u8>, PixelsError> {
    // Revalidate dimensions here (no memory cap: the buffer is already in
    // hand) so direct callers get the same refusal as the capture path,
    // then prove the slice actually holds the validated length.
    let total = frame_byte_len(params, usize::MAX)?;
    if data.len() < total {
        return Err(PixelsError::Truncated { expected: total, got: data.len() });
    }
    // Byte offsets of R, G, B inside one little-endian 32-bit pixel:
    // XRGB/ARGB pack as 0xAARRGGBB (memory order B, G, R, A), XBGR/ABGR as
    // 0xAABBGGRR (memory order R, G, B, A). Output is always B, G, R, 255.
    let flip_rb = match params.format {
        wl_shm::Format::Xrgb8888 | wl_shm::Format::Argb8888 => false,
        wl_shm::Format::Xbgr8888 | wl_shm::Format::Abgr8888 => true,
        // `check_format` above already refused anything else; keep the
        // match total without re-reporting.
        _ => false,
    };
    let (width, height, stride) = (params.width as usize, params.height as usize, params.stride as usize);
    let mut bgra = vec![0u8; width * height * 4];
    for dst_row in 0..height {
        // Preemptible per band: even an 8K decode yields within microseconds.
        if dst_row % 16 == 0 {
            if cancel.is_cancelled() {
                return Err(PixelsError::Cancelled);
            }
            if let Some(report) = progress {
                report(dst_row as u64);
            }
        }
        // y-invert means the compositor wrote the frame bottom-up: read the
        // mirrored source row so row 0 of the output is the visual top.
        let src_row = if y_invert { height - 1 - dst_row } else { dst_row };
        let src = &data[src_row * stride..src_row * stride + width * 4];
        let dst = &mut bgra[dst_row * width * 4..(dst_row + 1) * width * 4];
        for col in 0..width {
            let s = col * 4;
            let d = col * 4;
            if flip_rb {
                dst[d] = src[s + 2];
                dst[d + 1] = src[s + 1];
                dst[d + 2] = src[s];
            } else {
                dst[d] = src[s];
                dst[d + 1] = src[s + 1];
                dst[d + 2] = src[s + 2];
            }
            dst[d + 3] = 255;
        }
    }
    if cancel.is_cancelled() {
        return Err(PixelsError::Cancelled);
    }
    if let Some(report) = progress {
        report(height as u64);
    }
    Ok(bgra)
}

/// Refuse formats this slice cannot decode. The four 32-bit little-endian
/// layouts above are what wlroots-family compositors hand out (verified
/// against Niri's screencopy source, which always offers XRGB8888); the
/// `format` rendering keeps unknown wire codes visible in the error.
fn check_format(format: wl_shm::Format) -> Result<(), PixelsError> {
    match format {
        wl_shm::Format::Xrgb8888
        | wl_shm::Format::Argb8888
        | wl_shm::Format::Xbgr8888
        | wl_shm::Format::Abgr8888 => Ok(()),
        other => Err(PixelsError::UnsupportedFormat { format: format!("{other:?}") }),
    }
}
