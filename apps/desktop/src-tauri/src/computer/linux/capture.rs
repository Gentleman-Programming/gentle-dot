//! Bounded full-output screencopy capture over `zwlr_screencopy_manager_v1`
//! (T3b2, S1-S4; fused normalization T5, S1-S5): capture the caller-selected
//! [`Monitor`] by its stable registry id through the provided [`Connection`],
//! reusing the transport's total deadline and cooperative [`CancelHandle`].
//!
//! Two tails share one protocol path: the raw tail ([`capture_monitor`])
//! encodes the full buffer as-is for regression tests, while the normalized
//! tail ([`capture_monitor_normalized`]) rotates the raw buffer upright,
//! downscales it to [`MAX_LONG_EDGE`](crate::computer::coords::MAX_LONG_EDGE)
//! and encodes once — the production adapter path, with no JPEG
//! decode/re-encode anywhere. Both tails reuse the same owned resources,
//! deadline, memory accounting and [`CancelWriter`]..
//!
//! What this binds, and nothing more: one `wl_shm`, one screencopy manager,
//! and the one selected `wl_output`, all at the versions the
//! [`CapabilitySnapshot`] negotiated. No input globals, no cursor sampling,
//! no primary-output claim: the caller names the monitor and the returned
//! [`CapturedFrame`] carries its validated geometry for the future Desktop
//! capture to map with (no front-app story, no monitor-under-pointer story).
//!
//! Request/event order follows `wlr-screencopy-unstable-v1.xml` (attribution
//! in `THIRD_PARTY_NOTICES.md`): `capture_output` with the cursor excluded,
//! then the `buffer` description, then pool allocation, `copy`, and the
//! `flags`/`ready` (or `failed`) terminal. Version rules are explicit: below
//! v3 the single `buffer` event completes the description (SHM is guaranteed
//! there), at v3 the client waits for `buffer_done` and refuses a burst that
//! offers no SHM buffer. Every wait is deadline/cancel bounded through the
//! shared transport helpers; there is no `roundtrip` anywhere.
//!
//! Memory and cleanup: dimensions, stride and format are validated against
//! the monitor's actual hardware buffer *before* anything is allocated, with
//! an explicit [`MAX_SHM_BYTES`] cap plus pixel-count ([`MAX_FRAME_PIXELS`]),
//! phased-peak ([`MAX_AGGREGATE_BYTES`], raw via [`capture_peak_bytes`]
//! and normalized via [`normalized_peak_bytes`](super::pixels::normalized_peak_bytes))
//! and encoded-output ([`MAX_JPEG_BYTES`]) caps covering the memfd (kernel,
//! server-mapped for the whole capture), the read-back vec, the decoded rows,
//! the upright/downscaled RGB copies and the JPEG output; the pool file is an
//! owned memfd sized once. The fused tail's target (upright size downscaled)
//! derives from the validated geometry alone, so its JPEG budget and peak are
//! known before the memfd exists, exactly like the raw tail's. Every owned protocol object (frame, buffer, pool)
//! lives in a scope guard that protocol-destroys them in order (buffer,
//! pool, frame) with one best-effort nonblocking flush on every exit —
//! success, error, or panic unwind — while the shared [`Connection`] itself
//! is only borrowed, never destroyed. Post-ready work is chunked and
//! deadline-aware (64 KiB read chunks with per-chunk checks, per-row decode,
//! per-band RGB conversion, per-write JPEG encode through a writer that
//! checks cancel, the total deadline and the encoded-output budget, plus a
//! post-encode gate that discards a finished JPEG after Stop or expiry), so
//! no stage outlives the deadline or a cancel except for the codec's own
//! CPU stretches between writer calls — prompt, but not a hard-realtime
//! guarantee.

use std::cell::Cell;
use std::os::unix::io::{AsFd, FromRawFd};
use std::time::Instant;
use wayland_client::protocol::{wl_buffer, wl_output, wl_registry, wl_shm, wl_shm_pool};
use wayland_client::{Connection, Dispatch, QueueHandle, WEnum};
use wayland_protocols_wlr::screencopy::v1::client::{
    zwlr_screencopy_frame_v1, zwlr_screencopy_manager_v1,
};

use super::capabilities::{CapabilityError, CapabilitySnapshot, SCREENCOPY, WL_SHM};
use super::normalize::{
    downscale_rgb_bilinear, normalize_bgra_to_rgb, normalize_error, normalized_target,
};
use super::outputs::Monitor;
use super::pixels::{
    capture_peak_bytes, decode_shm_to_bgra, frame_byte_len, normalized_peak_bytes, pixel_count,
    FrameParams, PixelsError,
};
use super::transport::{
    check_wait, flush_with_retry, read_ready_op, wait_readable, CancelHandle, TransportError,
    TransportKind,
};
use crate::computer::encode::JPEG_QUALITY;

/// Hard cap on one SHM frame (`stride * height`): an 8K XRGB frame needs
/// ~127 MiB, so this admits it while refusing absurd bursts before any
/// allocation or fd exists.
pub const MAX_SHM_BYTES: usize = 128 * 1024 * 1024;

/// Hard cap on frame pixels (`width * height`): ~8K class (7680x4320 =
/// 33.2M), bounding both transient memory and per-block JPEG encode time
/// before anything beyond the SHM file is allocated.
pub const MAX_FRAME_PIXELS: u64 = 34_000_000;

/// Fixed per-frame JPEG overhead allowance: marker segments plus quant and
/// Huffman tables cost ~0.7 KiB regardless of dimensions (observed from the
/// encoder's own header writes), so the per-frame budget is this slack plus
/// four bytes per pixel — never below what headers alone need, never above
/// the raw frame plus tables.
pub const JPEG_HEADER_SLACK_BYTES: u64 = 4 * 1024;

/// Hard cap on one frame's encoded JPEG bytes: the header slack plus four
/// per pixel (the raw BGRA size), so the encoder can never grow the output
/// past the raw frame it compresses. Per frame the capture derives
/// `slack + 4 * pixels` with checked math (tests may inject a smaller
/// cap); this global bounds the formula itself through the pixel cap above.
pub const MAX_JPEG_BYTES: u64 = JPEG_HEADER_SLACK_BYTES + 4 * MAX_FRAME_PIXELS;

/// Hard cap on worst-case simultaneously-live bytes across the capture
/// phases (see [`pixels::capture_peak_bytes`]): the memfd — kernel pages
/// the compositor keeps mapped until the pool is destroyed, counted for
/// the whole capture, not just the userspace read-back copy — plus, per
/// phase, the read-back vec, the decoded BGRA rows, the encoder-internal
/// RGB copy and the capped JPEG output. An 8K XRGB frame peaks near
/// 398 MiB (decode phase: memfd plus read-back plus BGRA), admitted with
/// headroom; anything beyond fails before the memfd exists. Intermediate
/// buffers are dropped as soon as their phase ends so reality stays at or
/// under the accounted peak.
pub const MAX_AGGREGATE_BYTES: u64 = 512 * 1024 * 1024;

/// Processing stage reported to the [`capture_monitor_with_hooks`] hook:
/// file read-back, row decode, downscale rows, and JPEG encode. The hook is
/// the injected seam tests use to cancel deterministically mid-stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureStage {
    ReadFile,
    DecodeRows,
    DownscaleRows,
    EncodeJpeg,
}

/// One captured monitor: JPEG bytes plus the validated geometry they map
/// through. `width`/`height` are the encoded dimensions (the full buffer
/// for the raw tail, the upright downscaled target for the normalized
/// tail); `geometry` is the monitor's own validated geometry, never adjusted
/// to fit the frame (a mismatch fails instead).
#[derive(Debug, Clone)]
pub struct CapturedFrame {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub buffer_width: u32,
    pub buffer_height: u32,
    pub geometry: super::geometry::OutputGeometry,
    pub monitor_name: Option<String>,
}

/// What went wrong capturing. Every variant names the guilty party (output
/// id, interface, dimensions) and never guesses a compositor.
#[derive(Debug, Clone)]
pub enum CaptureError {
    /// The socket wait failed (timeout, cancel, disconnect, I/O).
    Transport(TransportError),
    /// The compositor does not advertise a required global.
    MissingProtocol(CapabilityError),
    /// No advertised `wl_output` has this registry name.
    UnknownOutput { registry_name: u32 },
    /// The frame description cannot be decoded (bad format, stride, or
    /// extents); `detail` carries the pixel-level reason.
    UnsupportedBuffer { detail: String },
    /// The validated byte length exceeds [`MAX_SHM_BYTES`].
    Oversized { bytes: usize, limit: usize },
    /// The frame dimensions disagree with the monitor's validated geometry;
    /// capture stops instead of silently remapping.
    DimensionMismatch { registry_name: u32, expected: (u32, u32), got: (u32, u32) },
    /// The compositor sent `failed` for this output.
    Failed { registry_name: u32 },
    /// The SHM file handed over fewer bytes than validated.
    Truncated { expected: usize, got: usize },
    /// JPEG encoding failed after a good copy.
    Encode { detail: String },
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => write!(f, "{error}"),
            Self::MissingProtocol(error) => write!(f, "{error}"),
            Self::UnknownOutput { registry_name } => write!(
                f,
                "no advertised wl_output has registry name {registry_name}"
            ),
            Self::UnsupportedBuffer { detail } => {
                write!(f, "compositor offered an undecodable screencopy buffer: {detail}")
            }
            Self::Oversized { bytes, limit } => {
                write!(f, "screencopy buffer needs {bytes} bytes, over the {limit}-byte cap")
            }
            Self::DimensionMismatch { registry_name, expected, got } => write!(
                f,
                "output {registry_name} capture is {}x{} but its validated geometry needs {}x{}; \
                 refusing instead of remapping",
                got.0, got.1, expected.0, expected.1,
            ),
            Self::Failed { registry_name } => write!(
                f,
                "compositor reported screencopy failure for output {registry_name}"
            ),
            Self::Truncated { expected, got } => {
                write!(f, "screencopy file holds {got} bytes, expected {expected}")
            }
            Self::Encode { detail } => write!(f, "cannot encode the captured frame: {detail}"),
        }
    }
}

impl std::error::Error for CaptureError {}

impl From<TransportError> for CaptureError {
    fn from(error: TransportError) -> Self {
        Self::Transport(error)
    }
}

impl From<CapabilityError> for CaptureError {
    fn from(error: CapabilityError) -> Self {
        Self::MissingProtocol(error)
    }
}

impl From<PixelsError> for CaptureError {
    fn from(error: PixelsError) -> Self {
        match error {
            PixelsError::TooLarge { bytes, limit } => Self::Oversized { bytes, limit },
            PixelsError::Truncated { expected, got } => Self::Truncated { expected, got },
            PixelsError::Cancelled => Self::Transport(TransportError {
                kind: TransportKind::Cancelled,
                op: "capture",
                detail: "cancelled during frame processing".to_owned(),
            }),
            other => Self::UnsupportedBuffer { detail: other.to_string() },
        }
    }
}

/// Capture the full output of `monitor` (selected by stable registry id)
/// through `conn`, bounded by `deadline` and `cancel`. Returns JPEG bytes
/// plus the monitor's validated geometry for future mapping.
///
/// Consumes `conn` and closes it before returning: one connection per
/// operation, so the per-capture registry (which has no destructor) can
/// never accumulate on a shared connection.
///
/// No processing hook:equivalent to [`capture_monitor_with_hooks`] with no
/// hook. Every exit path (including this one) runs the scope guard, which
/// protocol-destroys the owned frame, buffer and pool.
pub fn capture_monitor(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    monitor: &Monitor,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<CapturedFrame, CaptureError> {
    capture_monitor_with_hooks(conn, snapshot, monitor, deadline, cancel, None)
}

/// Capture with an injected per-stage hook (`None` in production). The hook
/// fires per read chunk, per decode band and around the JPEG encode with
/// the stage and a progress count (bytes read, rows decoded, bytes written);
/// it is how tests cancel deterministically mid-stage instead of only
/// pre-setting the cancel flag.
///
/// Validation order is the whole point: unknown ids and missing protocols
/// fail before any bind; frame dimensions must equal the monitor's expected
/// buffer size and the byte length must clear [`MAX_SHM_BYTES`] before the
/// memfd exists; only then is the pool created, the copy issued, and the
/// file read back. Anything else destroys the frame best-effort and returns
/// without allocating.
pub fn capture_monitor_with_hooks(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    monitor: &Monitor,
    deadline: Instant,
    cancel: &CancelHandle,
    hook: Option<&dyn Fn(CaptureStage, u64)>,
) -> Result<CapturedFrame, CaptureError> {
    capture_monitor_with_limits(conn, snapshot, monitor, deadline, cancel, hook, &EncodeLimits::standard())
}

/// Capture the selected monitor normalized: rotate the raw buffer upright,
/// downscale it to the normalized target and encode once — the production
/// adapter path. Consumes `conn` and closes it before returning, exactly
/// like the raw tail. No processing hook: equivalent to
/// [`capture_monitor_normalized_with_hooks`] with no hook.
pub fn capture_monitor_normalized(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    monitor: &Monitor,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<CapturedFrame, CaptureError> {
    capture_monitor_normalized_with_hooks(conn, snapshot, monitor, deadline, cancel, None)
}

/// Normalized capture with an injected per-stage hook (`None` in
/// production). The hook fires per read chunk, per decode band, per
/// downscale row and around the JPEG encode; it is how tests cancel
/// deterministically mid-stage instead of only pre-setting the cancel flag.
pub fn capture_monitor_normalized_with_hooks(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    monitor: &Monitor,
    deadline: Instant,
    cancel: &CancelHandle,
    hook: Option<&dyn Fn(CaptureStage, u64)>,
) -> Result<CapturedFrame, CaptureError> {
    capture_inner(conn, snapshot, monitor, deadline, cancel, hook, CapturePlan::Normalized)
}

/// Which tail runs after the SHM bytes land: the raw regression tail
/// encodes the full buffer as-is, while the normalized production tail
/// rotates upright, downscales and encodes once. Both share the protocol
/// path, the owned resources, the deadline and the memory accounting.
#[derive(Debug, Clone, Copy)]
pub(crate) enum CapturePlan {
    Raw { jpeg_cap: Option<u64> },
    Normalized,
}

/// Internal encode budget for tests (`None` in production, which derives
/// the per-frame cap): lets the fake-peer suite force an encoded-output
/// refusal without allocating a gigapixel frame. Raw tail only; the
/// normalized tail derives its (smaller) cap from the downscaled target.
#[derive(Debug, Clone, Copy)]
pub(crate) struct EncodeLimits {
    pub jpeg_cap: Option<u64>,
}

impl EncodeLimits {
    pub(crate) fn standard() -> Self {
        Self { jpeg_cap: None }
    }
}

/// Crate-internal capture with an injectable encode budget. Production
/// calls [`capture_monitor_with_hooks`]; tests pass [`EncodeLimits`] to pin
/// the encoded-output refusal through the public boundary.
pub(crate) fn capture_monitor_with_limits(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    monitor: &Monitor,
    deadline: Instant,
    cancel: &CancelHandle,
    hook: Option<&dyn Fn(CaptureStage, u64)>,
    limits: &EncodeLimits,
) -> Result<CapturedFrame, CaptureError> {
    capture_inner(
        conn,
        snapshot,
        monitor,
        deadline,
        cancel,
        hook,
        CapturePlan::Raw { jpeg_cap: limits.jpeg_cap },
    )
}

/// One protocol path, two tails: binds, Phase 1/2 and read-back are shared;
/// only the post-decode processing and the encoded dimensions differ.
#[allow(clippy::too_many_arguments)]
fn capture_inner(
    conn: Connection,
    snapshot: &CapabilitySnapshot,
    monitor: &Monitor,
    deadline: Instant,
    cancel: &CancelHandle,
    hook: Option<&dyn Fn(CaptureStage, u64)>,
    plan: CapturePlan,
) -> Result<CapturedFrame, CaptureError> {
    let output_global = snapshot
        .outputs
        .iter()
        .find(|global| global.name == monitor.registry_name)
        .copied()
        .ok_or(CaptureError::UnknownOutput { registry_name: monitor.registry_name })?;
    let shm_global = snapshot.require(WL_SHM)?;
    let manager_global = snapshot.require(SCREENCOPY)?;

    let mut queue = conn.new_event_queue::<Capture>();
    let qh = queue.handle();
    let registry = conn.display().get_registry(&qh, ());
    let shm: wl_shm::WlShm = registry.bind(shm_global.name, shm_global.negotiated, &qh, ());
    let manager: zwlr_screencopy_manager_v1::ZwlrScreencopyManagerV1 =
        registry.bind(manager_global.name, manager_global.negotiated, &qh, ());
    let output: wl_output::WlOutput =
        registry.bind(output_global.name, output_global.negotiated, &qh, ());
    // Cursor excluded (overlay_cursor = 0, the grim default): the frame is
    // the desktop alone, never a cursor sprite baked into pixels.
    let frame = manager.capture_output(0, &output, &qh, ());
    let frame_version = manager_global.negotiated;
    // Own every protocol object from here on: the scope guard below is the
    // only owner, so every exit (success, error, panic unwind) runs the
    // same cleanup.
    let mut scope = CaptureScope::new(&conn, frame);
    flush_with_retry(&conn, "capture", deadline, cancel)?;

    let mut state = Capture::default();
    // Phase 1: wait for the buffer description that sizes the pool.
    let offer = loop {
        check_wait("capture", deadline, cancel)?;
        queue.dispatch_pending(&mut state).map_err(|error| TransportError {
            kind: TransportKind::Disconnected,
            op: "capture",
            detail: format!("cannot dispatch compositor events: {error}"),
        })?;
        if state.failed {
            return Err(CaptureError::Failed { registry_name: monitor.registry_name });
        }
        if state.repeated_buffer {
            return Err(CaptureError::UnsupportedBuffer {
                detail: format!(
                    "compositor sent {} buffer descriptions for one frame; refusing instead of last-wins",
                    state.buffer_events
                ),
            });
        }
        if let Some(offer) = state.copy_offer(frame_version) {
            break offer;
        }
        if frame_version >= 3 && state.buffer_done {
            // Described but SHM-less (dmabuf-only burst): nothing here can
            // back a `wl_shm` pool with.
            return Err(CaptureError::UnsupportedBuffer {
                detail: "compositor offered no wl_shm buffer for this frame".to_owned(),
            });
        }
        match queue.prepare_read() {
            Some(guard) => {
                wait_readable(conn.backend().poll_fd(), "capture", deadline, cancel)?;
                if !read_ready_op(guard, "capture")? {
                    continue;
                }
            }
            // The pure-Rust backend always grants a guard; sleep instead of
            // hot-spinning, bounds still hold at loop top.
            None => std::thread::sleep(std::time::Duration::from_millis(1)),
        }
    };

    // Dimensions must equal the monitor's ACTUAL validated hardware buffer
    // (`buffer_width`/`buffer_height`): for fractional scales the geometry
    // accepts a +/-1 slop buffer, and that accepted buffer is what the
    // compositor sends. Comparing against the nominal expected size would
    // refuse those valid frames; a real mismatch still fails here instead
    // of silently remapping.
    let expected = (monitor.geometry.buffer_width(), monitor.geometry.buffer_height());
    if (offer.width, offer.height) != expected {
        return Err(CaptureError::DimensionMismatch {
            registry_name: monitor.registry_name,
            expected,
            got: (offer.width, offer.height),
        });
    }
    let params = FrameParams {
        format: offer.format.ok_or_else(|| CaptureError::UnsupportedBuffer {
            detail: format!(
                "unsupported screencopy pixel format Unknown({})",
                offer.format_raw
            ),
        })?,
        width: offer.width,
        height: offer.height,
        stride: offer.stride,
    };
    // Checked budget before the memfd exists: the SHM length (capped),
    // then the pixel count (encode-time bound), then the worst-case
    // simultaneously-live peak across the tail's phases. The raw tail
    // budgets the full buffer through `capture_peak_bytes`; the normalized
    // tail budgets the fused rotate/downscale/encode pipeline through
    // `normalized_peak_bytes`, with the JPEG cap derived from the
    // downscaled target (known from the validated geometry alone). Both
    // refuse before the memfd exists; the explicit drops below keep reality
    // at or under the accounted peak.
    let byte_len = frame_byte_len(params, MAX_SHM_BYTES)?;
    let pixels = pixel_count(params)?;
    if pixels > MAX_FRAME_PIXELS {
        return Err(CaptureError::Oversized {
            bytes: usize::try_from(pixels).unwrap_or(usize::MAX),
            limit: MAX_FRAME_PIXELS as usize,
        });
    }
    // The normalized target derives from the validated geometry alone
    // (upright size downscaled, never upscaled), so it is known here.
    let (tw, th, _) = normalized_target(&monitor.geometry);
    let (jpeg_cap, peak) = match plan {
        CapturePlan::Raw { jpeg_cap } => {
            // Per-frame encoded-output budget: the header slack plus four
            // bytes per pixel (checked), so the JPEG can never outgrow the
            // raw frame it compresses; tests may inject a smaller cap to
            // pin the refusal without a huge allocation.
            let jpeg_cap = match jpeg_cap {
                Some(cap) => cap,
                None => pixels
                    .checked_mul(4)
                    .and_then(|body| body.checked_add(JPEG_HEADER_SLACK_BYTES))
                    .ok_or(PixelsError::Overflow { field: "encoded frame budget" })?,
            };
            let peak = capture_peak_bytes(byte_len, params, jpeg_cap)?;
            (jpeg_cap, peak)
        }
        CapturePlan::Normalized => {
            let target_pixels = (u64::from(tw))
                .checked_mul(u64::from(th))
                .ok_or(PixelsError::Overflow { field: "normalized frame pixels" })?;
            let jpeg_cap = target_pixels
                .checked_mul(4)
                .and_then(|body| body.checked_add(JPEG_HEADER_SLACK_BYTES))
                .ok_or(PixelsError::Overflow { field: "normalized frame budget" })?;
            if jpeg_cap > MAX_JPEG_BYTES {
                return Err(CaptureError::Oversized {
                    bytes: usize::try_from(jpeg_cap).unwrap_or(usize::MAX),
                    limit: usize::try_from(MAX_JPEG_BYTES).unwrap_or(usize::MAX),
                });
            }
            let peak = normalized_peak_bytes(byte_len, params, target_pixels, jpeg_cap)?;
            (jpeg_cap, peak)
        }
    };
    if peak > MAX_AGGREGATE_BYTES {
        return Err(CaptureError::Oversized {
            bytes: usize::try_from(peak).unwrap_or(usize::MAX),
            limit: MAX_AGGREGATE_BYTES as usize,
        });
    }

    let file = create_memfd(byte_len)?;
    let pool = shm.create_pool(file.as_fd(), byte_len as i32, &qh, ());
    let buffer = pool.create_buffer(
        0,
        params.width as i32,
        params.height as i32,
        params.stride as i32,
        params.format,
        &qh,
        (),
    );
    scope.frame.as_ref().expect("scope owns the frame").copy(&buffer);
    scope.buffer = Some(buffer);
    scope.pool = Some(pool);
    flush_with_retry(&conn, "capture", deadline, cancel)?;

    // Phase 2: wait for the copy to land (`flags` then `ready`, or `failed`).
    let y_invert = loop {
        check_wait("capture", deadline, cancel)?;
        queue.dispatch_pending(&mut state).map_err(|error| TransportError {
            kind: TransportKind::Disconnected,
            op: "capture",
            detail: format!("cannot dispatch compositor events: {error}"),
        })?;
        if state.failed {
            return Err(CaptureError::Failed { registry_name: monitor.registry_name });
        }
        if state.ready {
            break state.y_invert;
        }
        match queue.prepare_read() {
            Some(guard) => {
                wait_readable(conn.backend().poll_fd(), "capture", deadline, cancel)?;
                if !read_ready_op(guard, "capture")? {
                    continue;
                }
            }
            None => std::thread::sleep(std::time::Duration::from_millis(1)),
        }
    };
    // The scope guard owns frame/buffer/pool to function exit and
    // protocol-destroys them on drop; the fd drops with the queue.

    // Safe read-back of exactly the validated length: the compositor wrote
    // through the shared file, and this is the only copy the decoder sees.
    // Chunked with a deadline/cancel check per 64 KiB (plus the hook, so
    // tests cancel deterministically mid-read) instead of one unbounded
    // `read_exact`.
    use std::io::{Read, Seek};
    const READ_CHUNK: usize = 64 * 1024;
    let mut file = file;
    file.seek(std::io::SeekFrom::Start(0)).map_err(|_| CaptureError::Truncated {
        expected: byte_len,
        got: 0,
    })?;
    let mut bytes = vec![0u8; byte_len];
    let mut got = 0;
    while got < byte_len {
        check_wait("capture", deadline, cancel)?;
        if let Some(report) = hook {
            report(CaptureStage::ReadFile, got as u64);
        }
        let end = (got + READ_CHUNK).min(byte_len);
        match file.read(&mut bytes[got..end]) {
            Ok(0) => break,
            Ok(read) => got += read,
            Err(_) => {
                return Err(CaptureError::Truncated { expected: byte_len, got });
            }
        }
    }
    if got < byte_len {
        return Err(CaptureError::Truncated { expected: byte_len, got });
    }

    let decode_progress = hook.map(|report| move |rows: u64| report(CaptureStage::DecodeRows, rows));
    let bgra = decode_shm_to_bgra(
        &bytes,
        params,
        y_invert,
        cancel,
        decode_progress.as_ref().map(|report| report as &dyn Fn(u64)),
    )?;
    // The read-back vec's phase is over: drop it now so the later phases
    // never carry it (the phased peak accounts this).
    drop(bytes);
    let (jpeg, width, height) = match plan {
        CapturePlan::Raw { .. } => {
            // Packed BGRA to packed RGB (same channel order as `encode.rs`,
            // kept local so the shared Mac encoder stays untouched), checking
            // cancel per band so a large frame stays preemptible before the
            // encode starts. Regression tail: the encoded dims stay the
            // buffer dims, so the geometry mapping is exact by construction.
            let width = params.width as usize;
            let height = params.height as usize;
            let mut rgb = vec![0u8; width * height * 3];
            for row in 0..height {
                if row % 64 == 0 && cancel.is_cancelled() {
                    return Err(PixelsError::Cancelled.into());
                }
                let src = &bgra[row * width * 4..(row + 1) * width * 4];
                let dst = &mut rgb[row * width * 3..(row + 1) * width * 3];
                for col in 0..width {
                    dst[col * 3] = src[col * 4 + 2];
                    dst[col * 3 + 1] = src[col * 4 + 1];
                    dst[col * 3 + 2] = src[col * 4];
                }
            }
            // BGRA's phase is over: the encoder only ever sees the RGB copy.
            drop(bgra);
            let jpeg = encode_jpeg_cancel(
                &rgb,
                params.width,
                params.height,
                deadline,
                cancel,
                hook,
                jpeg_cap,
            )?;
            (jpeg, params.width, params.height)
        }
        CapturePlan::Normalized => {
            // Production tail: rotate the validated buffer upright exactly
            // once, downscale to the normalized target, and encode that
            // once — one JPEG encode, no decode/re-encode. Every row band
            // checks the deadline and cancel; the explicit drops keep
            // reality at or under the accounted peak.
            check_wait("capture", deadline, cancel)?;
            let (upright, uw, uh) = normalize_bgra_to_rgb(
                &bgra,
                params.width,
                params.height,
                &monitor.geometry,
                deadline,
                cancel,
            )
            .map_err(|error| normalize_error(error, monitor.registry_name))?;
            // BGRA's phase is over: rotation and downscale only ever see
            // the upright copy.
            drop(bgra);
            let down_progress =
                hook.map(|report| move |rows: u64| report(CaptureStage::DownscaleRows, rows));
            let rgb = downscale_rgb_bilinear(
                &upright,
                uw,
                uh,
                tw,
                th,
                deadline,
                cancel,
                down_progress.as_ref().map(|report| report as &dyn Fn(u64)),
            )
            .map_err(|error| normalize_error(error, monitor.registry_name))?;
            // Upright's phase is over: the encoder only ever sees the
            // downscaled copy.
            drop(upright);
            let jpeg =
                encode_jpeg_cancel(&rgb, tw, th, deadline, cancel, hook, jpeg_cap)?;
            (jpeg, tw, th)
        }
    };
    Ok(CapturedFrame {
        jpeg,
        width,
        height,
        buffer_width: params.width,
        buffer_height: params.height,
        geometry: monitor.geometry,
        monitor_name: monitor.name.clone(),
    })
}

/// One frame's description as the `buffer` event reports it. `format` stays
/// `None` for wire codes this slice cannot name (kept raw for the error).
#[derive(Debug, Clone, Copy, Default)]
struct Offer {
    format: Option<wl_shm::Format>,
    format_raw: u32,
    width: u32,
    height: u32,
    stride: u32,
}

/// State driving one screencopy frame to its terminal event.
#[derive(Debug, Default)]
struct Capture {
    offer: Option<Offer>,
    buffer_events: u32,
    repeated_buffer: bool,
    buffer_done: bool,
    y_invert: bool,
    ready: bool,
    failed: bool,
}

impl Capture {
    /// The description the pool allocation may proceed with: below v3 the
    /// single `buffer` event is complete (SHM is guaranteed there); at v3
    /// the burst must close with `buffer_done` first.
    fn copy_offer(&self, frame_version: u32) -> Option<Offer> {
        let offer = self.offer?;
        if frame_version >= 3 && !self.buffer_done {
            return None;
        }
        Some(offer)
    }
}

impl Dispatch<zwlr_screencopy_frame_v1::ZwlrScreencopyFrameV1, ()> for Capture {
    fn event(
        state: &mut Self,
        _frame: &zwlr_screencopy_frame_v1::ZwlrScreencopyFrameV1,
        event: zwlr_screencopy_frame_v1::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        match event {
            zwlr_screencopy_frame_v1::Event::Buffer { format, width, height, stride } => {
                // The protocol sends exactly one description per frame. A
                // second one (identical or mutated) is a violation: refuse
                // instead of last-wins, keeping the first for the error.
                state.buffer_events += 1;
                if state.buffer_events > 1 {
                    state.repeated_buffer = true;
                    return;
                }
                let (known, raw) = match format {
                    WEnum::Value(known) => (Some(known), known as u32),
                    WEnum::Unknown(raw) => (None, raw),
                };
                state.offer = Some(Offer { format: known, format_raw: raw, width, height, stride });
            }
            zwlr_screencopy_frame_v1::Event::Flags { flags } => {
                state.y_invert = flags
                    .into_result()
                    .map(|set| set.contains(zwlr_screencopy_frame_v1::Flags::YInvert))
                    .unwrap_or(false);
            }
            zwlr_screencopy_frame_v1::Event::Ready { .. } => state.ready = true,
            zwlr_screencopy_frame_v1::Event::Failed => state.failed = true,
            zwlr_screencopy_frame_v1::Event::BufferDone => state.buffer_done = true,
            // `damage`/`linux_dmabuf` carry nothing this SHM-only slice uses.
            _ => {}
        }
    }
}

wayland_client::delegate_noop!(Capture: ignore wl_registry::WlRegistry);
wayland_client::delegate_noop!(Capture: ignore wl_shm::WlShm);
wayland_client::delegate_noop!(Capture: ignore wl_shm_pool::WlShmPool);
wayland_client::delegate_noop!(Capture: ignore wl_buffer::WlBuffer);
wayland_client::delegate_noop!(Capture: ignore wl_output::WlOutput);
wayland_client::delegate_noop!(Capture: ignore zwlr_screencopy_manager_v1::ZwlrScreencopyManagerV1);

/// Scoped owner of one capture's protocol objects. The guard is created the
/// moment `capture_output` returns and takes each object as it is created,
/// so every exit path destroys exactly what exists in the correct order
/// (buffer, then pool, then frame) with one best-effort nonblocking flush.
/// The shared [`Connection`] itself is only borrowed, never destroyed.
struct CaptureScope<'a> {
    conn: &'a Connection,
    frame: Option<zwlr_screencopy_frame_v1::ZwlrScreencopyFrameV1>,
    buffer: Option<wl_buffer::WlBuffer>,
    pool: Option<wl_shm_pool::WlShmPool>,
}

impl<'a> CaptureScope<'a> {
    fn new(
        conn: &'a Connection,
        frame: zwlr_screencopy_frame_v1::ZwlrScreencopyFrameV1,
    ) -> Self {
        Self { conn, frame: Some(frame), buffer: None, pool: None }
    }
}

impl Drop for CaptureScope<'_> {
    fn drop(&mut self) {
        // Reverse creation order: the buffer must go before its pool, the
        // frame last. Each destroy is a best-effort request on our own
        // proxies only: the shared connection is never touched beyond one
        // nonblocking flush, and drop cannot fail so the original error
        // (or success value) is never swallowed or replaced.
        if let Some(buffer) = self.buffer.take() {
            buffer.destroy();
        }
        if let Some(pool) = self.pool.take() {
            pool.destroy();
        }
        if let Some(frame) = self.frame.take() {
            frame.destroy();
        }
        // One flush attempt, nonblocking by backend contract (MSG_DONTWAIT
        // sends): if the kernel buffer is full the destroys stay queued,
        // which is acceptable best-effort on a dead or busy connection.
        let _ = self.conn.flush();
    }
}

/// Capture-local JPEG encode with a deadline/budget-aware writer.
/// `image`'s `JpegEncoder::encode` is monolithic over the input slice (no
/// scanline API), but it emits through the wrapped `Write` via `write_all`
/// during header, block and MCU writes — verified against image 0.25
/// `encoder.rs` (`write_bits`/`write_block`/`write_marker`/`write_segment`
/// all go through `write_all`) — so a writer that fails on cancel, expiry
/// or budget aborts the encode promptly with no thread and no invented
/// interruptibility. The pre-encode check plus a check per write and per
/// flush bounds the uninterruptible window to the codec's own CPU stretches
/// between calls: prompt, but not a hard-realtime guarantee (see
/// `CancelWriter`). A finished JPEG is still discarded when Stop or the
/// deadline landed on the final write — success never outruns the bound.
/// `encode.rs` (`bgra_to_jpeg`) stays untouched for the shared Mac path.
///
/// Shared with the adapter fakes and tests through [`encode_frame_jpeg`]:
/// the production fused tail calls this directly with its derived cap.
pub(crate) fn encode_jpeg_cancel(
    rgb: &[u8],
    width: u32,
    height: u32,
    deadline: Instant,
    cancel: &CancelHandle,
    hook: Option<&dyn Fn(CaptureStage, u64)>,
    jpeg_cap: u64,
) -> Result<Vec<u8>, CaptureError> {
    check_wait("capture", deadline, cancel)?;
    if let Some(report) = hook {
        report(CaptureStage::EncodeJpeg, 0);
    }
    let meter = EncodeMeter::default();
    let mut jpeg = Vec::new();
    {
        let writer = CancelWriter {
            inner: &mut jpeg,
            cancel,
            deadline,
            hook,
            remaining: jpeg_cap,
            meter: &meter,
        };
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(writer, JPEG_QUALITY);
        if let Err(error) =
            encoder.encode(rgb, width, height, image::ExtendedColorType::Rgb8)
        {
            // Priority is explicit and shared with the post-encode gate: a
            // fired cancel reports Cancelled even when the deadline also
            // passed; an expired deadline reports Timeout (never Encode);
            // a blown encoded-output budget reports Oversized with the
            // attempted total; anything else is a real encoder failure.
            if let Some(stop) = encode_stop(deadline, cancel) {
                return Err(stop);
            }
            if meter.refused.get() {
                return Err(CaptureError::Oversized {
                    bytes: usize::try_from(meter.attempted.get()).unwrap_or(usize::MAX),
                    limit: usize::try_from(jpeg_cap).unwrap_or(usize::MAX),
                });
            }
            return Err(CaptureError::Encode { detail: error.to_string() });
        }
    }
    // The encoder can finish between the last write and this check (or the
    // cancel can land inside the final hook call): never hand back a JPEG
    // after Stop or after the deadline.
    if let Some(stop) = encode_stop(deadline, cancel) {
        return Err(stop);
    }
    Ok(jpeg)
}

/// Bounded JPEG encode for already-normalized RGB (`width * height * 3`)
/// through the shared [`CancelWriter`]: the standard per-frame budget
/// (header slack plus four bytes per pixel, checked) plus the pixel-count
/// cap, the total deadline and the cancel handle. The adapter fakes and
/// the normalization tests encode through this helper so every JPEG on
/// the Linux path shares the same cap, the same writer checks and the
/// same post-encode Stop/expiry gate — never a bare `JpegEncoder` with
/// its own unwatched budget. Test-only: the production tails call
/// [`encode_jpeg_cancel`] directly with their derived caps and hooks.
#[cfg(test)]
pub(crate) fn encode_frame_jpeg(
    rgb: &[u8],
    width: u32,
    height: u32,
    deadline: Instant,
    cancel: &CancelHandle,
) -> Result<Vec<u8>, CaptureError> {
    let pixels = (u64::from(width))
        .checked_mul(u64::from(height))
        .ok_or(PixelsError::Overflow { field: "encoded frame pixels" })?;
    if pixels > MAX_FRAME_PIXELS {
        return Err(CaptureError::Oversized {
            bytes: usize::try_from(pixels).unwrap_or(usize::MAX),
            limit: MAX_FRAME_PIXELS as usize,
        });
    }
    let jpeg_cap = pixels
        .checked_mul(4)
        .and_then(|body| body.checked_add(JPEG_HEADER_SLACK_BYTES))
        .ok_or(PixelsError::Overflow { field: "encoded frame budget" })?;
    encode_jpeg_cancel(rgb, width, height, deadline, cancel, None, jpeg_cap)
}

/// Stop check shared by the writer failures and the post-encode gate:
/// cancel first (Stop wins over an also-expired deadline), then the total
/// deadline. Returns the error to surface, or `None` to continue.
fn encode_stop(deadline: Instant, cancel: &CancelHandle) -> Option<CaptureError> {
    if cancel.is_cancelled() {
        return Some(
            TransportError {
                kind: TransportKind::Cancelled,
                op: "capture",
                detail: "cancelled during JPEG encode".to_owned(),
            }
            .into(),
        );
    }
    if Instant::now() >= deadline {
        return Some(
            TransportError {
                kind: TransportKind::Timeout,
                op: "capture",
                detail: "the total deadline elapsed during JPEG encode".to_owned(),
            }
            .into(),
        );
    }
    None
}

/// Shared encode meter: `attempted` counts every byte offered to the writer
/// (including refused ones), `written` counts accepted bytes, and `refused`
/// latches once the encoded-output budget refuses a write — all before the
/// output `Vec` grows, so the refusal itself needs no allocation.
#[derive(Debug, Default)]
struct EncodeMeter {
    attempted: Cell<u64>,
    written: Cell<u64>,
    refused: Cell<bool>,
}

/// A `Write` wrapper that fails once the cancel handle fires, the total
/// deadline passes, or the encoded-output budget runs out, so the
/// monolithic JPEG encode aborts mid-stream. Every failure is
/// `Error::other` (never `Interrupted`: `write_all`, which the image
/// encoder calls per marker/segment, retries `Interrupted` by std contract
/// and would spin forever instead of aborting). Priority matches the
/// post-encode gate: cancel first, then the deadline, then the budget.
/// Progress reports through the capture hook (bytes written) let tests stop
/// deterministically mid-encode; production passes no hook and pays only
/// an atomic load plus a clock read per write. Residual: CPU stretches
/// inside the codec between writer calls are bounded by the codec's own
/// behavior, not by this check — the deadline is observed at every
/// write/flush boundary and after encode, which is prompt but not a
/// hard-realtime guarantee.
struct CancelWriter<'a> {
    inner: &'a mut Vec<u8>,
    cancel: &'a CancelHandle,
    deadline: Instant,
    hook: Option<&'a dyn Fn(CaptureStage, u64)>,
    remaining: u64,
    meter: &'a EncodeMeter,
}

impl std::io::Write for CancelWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.cancel.is_cancelled() {
            return Err(std::io::Error::other("capture cancelled during JPEG encode"));
        }
        if Instant::now() >= self.deadline {
            return Err(std::io::Error::other("capture deadline elapsed during JPEG encode"));
        }
        let len = buf.len() as u64;
        self.meter.attempted.set(self.meter.attempted.get().saturating_add(len));
        // Checked before the output `Vec` grows: the refusal allocates
        // nothing and the attempted total (above) names the overrun.
        if len > self.remaining {
            self.meter.refused.set(true);
            return Err(std::io::Error::other(format!(
                "screencopy JPEG needs more than the {}-byte encoded cap",
                self.remaining
            )));
        }
        let wrote = std::io::Write::write(&mut *self.inner, buf)? as u64;
        self.remaining -= wrote;
        self.meter.written.set(self.meter.written.get() + wrote);
        if let Some(report) = self.hook {
            report(CaptureStage::EncodeJpeg, self.meter.written.get());
        }
        Ok(wrote as usize)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.cancel.is_cancelled() {
            return Err(std::io::Error::other("capture cancelled during JPEG encode"));
        }
        if Instant::now() >= self.deadline {
            return Err(std::io::Error::other("capture deadline elapsed during JPEG encode"));
        }
        std::io::Write::flush(&mut *self.inner)
    }
}
/// An owned anonymous file of `size` bytes backing the SHM pool. `memfd`
/// only (no tmpfile fallback): a sealed memfd can never spill the frame
/// into a world-readable temp dir, and kernels without `memfd_create` fail
/// here truthfully instead of degrading silently.
fn create_memfd(size: usize) -> Result<std::fs::File, TransportError> {
    let io_error = |detail: String| TransportError {
        kind: TransportKind::Io,
        op: "capture",
        detail,
    };
    // SAFETY: NUL-terminated name, no flags beyond close-on-exec; the
    // returned fd is fresh and owned, wrapped immediately below.
    let fd = unsafe { libc::memfd_create(c"gentle-dot-screencopy".as_ptr(), libc::MFD_CLOEXEC) };
    if fd < 0 {
        return Err(io_error(format!(
            "cannot create a memfd for the screencopy buffer: {}",
            std::io::Error::last_os_error()
        )));
    }
    // SAFETY: `fd` is a fresh owned descriptor from `memfd_create`.
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    file.set_len(size as u64).map_err(|error| {
        io_error(format!("cannot size the screencopy buffer to {size} bytes: {error}"))
    })?;
    Ok(file)
}
