//! Bounded-normalization checks (T5 follow-up, S1-S5): the hardcoded
//! asymmetric grid through all eight transforms, the fused
//! rotate-plus-downscale path, scalar `ScreenshotGeometry` agreement, and
//! the cancel/deadline/budget bounds. Pure bytes in, no compositor, no
//! filesystem, no startup, no JPEG roundtrip: the production path normalizes
//! raw pixels and encodes once.

use std::time::{Duration, Instant};

use super::capture::encode_frame_jpeg;
use super::normalize::{
    buffer_to_upright, downscale_rgb_bilinear, normalize_bgra_to_rgb, normalized_target,
    upright_dimensions, NormalizeError,
};
use super::pixels::normalized_peak_bytes;
use super::transport::CancelHandle;
use crate::computer::coords::{fit_long_edge, MAX_LONG_EDGE};

fn live() -> CancelHandle {
    CancelHandle::new()
}

fn soon() -> Instant {
    Instant::now() + Duration::from_secs(30)
}

/// Eight distinct colors for the 4x2 reference grid, row-major:
/// row 0: red green blue white; row 1: cyan magenta yellow black.
fn reference_bgra() -> Vec<u8> {
    let pixels = [
        (255, 0, 0),
        (0, 255, 0),
        (0, 0, 255),
        (255, 255, 255),
        (0, 255, 255),
        (255, 0, 255),
        (255, 255, 0),
        (0, 0, 0),
    ];
    let mut out = Vec::with_capacity(8 * 4);
    for (r, g, b) in pixels {
        out.extend([b, g, r, 255]);
    }
    out
}

fn reference_rgb() -> Vec<u8> {
    let pixels = [
        (255, 0, 0),
        (0, 255, 0),
        (0, 0, 255),
        (255, 255, 255),
        (0, 255, 255),
        (255, 0, 255),
        (255, 255, 0),
        (0, 0, 0),
    ];
    let mut out = Vec::with_capacity(8 * 3);
    for (r, g, b) in pixels {
        out.extend([r, g, b]);
    }
    out
}

/// Geometry for `raw` with the 4x2 logical grid at scale 1: swapped
/// transforms carry the transposed 2x4 buffer, the rest the 4x2 buffer.
fn grid_geometry(raw: i32) -> OutputGeometry {
    let swaps = matches!(raw, 1 | 3 | 5 | 7);
    let (bw, bh) = if swaps { (2, 4) } else { (4, 2) };
    OutputGeometry::new(0, 0, 4, 2, 1.0, raw, bw, bh).unwrap()
}

use super::geometry::OutputGeometry;

/// Build the raw buffer for `raw` by placing every upright reference pixel
/// through the validated geometry mapping (global center of the upright
/// pixel back to a buffer index). Uses the trusted geometry math, pinned
/// independently by the hardcoded `b3_hardcoded_table`, so this test pins
/// agreement between normalization and geometry rather than re-stating the
/// implementation.
fn buffer_via_geometry(raw: i32) -> (Vec<u8>, OutputGeometry) {
    let geometry = grid_geometry(raw);
    let reference = reference_bgra();
    let (bw, bh) = (geometry.buffer_width() as usize, geometry.buffer_height() as usize);
    let mut buffer = vec![0u8; bw * bh * 4];
    for uy in 0..2 {
        for ux in 0..4 {
            let global = crate::computer::coords::Point {
                x: ux as f64 + 0.5,
                y: uy as f64 + 0.5,
            };
            let back = geometry.global_to_buffer(global.x, global.y).unwrap();
            let (bx, by) = (back.x.round() as usize, back.y.round() as usize);
            let s = (uy * 4 + ux) * 4;
            let d = (by * bw + bx) * 4;
            buffer[d..d + 4].copy_from_slice(&reference[s..s + 4]);
        }
    }
    (buffer, geometry)
}

#[test]
fn upright_dimensions_unswap_exactly_for_all_transforms() {
    for raw in 0..=7 {
        let geometry = grid_geometry(raw);
        assert_eq!(upright_dimensions(&geometry), (4, 2), "transform {raw}");
    }
}

#[test]
fn asymmetric_grid_normalizes_upright_exactly_once_for_all_transforms() {
    let expected = reference_rgb();
    for raw in 0..=7 {
        let (buffer, geometry) = buffer_via_geometry(raw);
        let (bw, bh) = (geometry.buffer_width(), geometry.buffer_height());
        let (rgb, uw, uh) =
            normalize_bgra_to_rgb(&buffer, bw, bh, &geometry, soon(), &live()).unwrap();
        assert_eq!((uw, uh), (4, 2), "transform {raw} upright size");
        assert_eq!(rgb, expected, "transform {raw} must invert exactly once");
    }
}

#[test]
fn hardcoded_buffers_pin_the_rotation_direction_without_helpers() {
    // Fully hand-derived buffers for three transforms over the reference
    // grid (rows: [R G B W] / [C M Y K]). No geometry helper is consulted:
    // if the inverse ran in the guessed direction, these fail.
    //
    // R90 (buffer 2x4): upright (ux,uy) sits at buffer (uy, 3-ux), so the
    // buffer rows read [D H] [C G] [B F] [A E] with A=R..H=K.
    let r90_rows = [
        [(255, 255, 255), (0, 0, 0)],
        [(0, 0, 255), (255, 255, 0)],
        [(0, 255, 0), (255, 0, 255)],
        [(255, 0, 0), (0, 255, 255)],
    ];
    // R180 (buffer 4x2): the buffer is the grid flipped both ways.
    let r180_rows = [
        [(0, 0, 0), (255, 255, 0), (255, 0, 255), (0, 255, 255)],
        [(255, 255, 255), (0, 0, 255), (0, 255, 0), (255, 0, 0)],
    ];
    // Flipped (buffer 4x2): the buffer is the grid mirrored horizontally.
    let flipped_rows = [
        [(255, 255, 255), (0, 0, 255), (0, 255, 0), (255, 0, 0)],
        [(0, 0, 0), (255, 255, 0), (255, 0, 255), (0, 255, 255)],
    ];
    let pack = |rows: &[&[(u8, u8, u8)]]| {
        let mut out = Vec::new();
        for row in rows {
            for (r, g, b) in row.iter() {
                out.extend([*b, *g, *r, 255]);
            }
        }
        out
    };
    let expected = reference_rgb();
    let cases = [
        (1, pack(&[&r90_rows[0], &r90_rows[1], &r90_rows[2], &r90_rows[3]])),
        (2, pack(&[&r180_rows[0], &r180_rows[1]])),
        (4, pack(&[&flipped_rows[0], &flipped_rows[1]])),
    ];
    for (raw, buffer) in cases {
        let geometry = grid_geometry(raw);
        let (bw, bh) = (geometry.buffer_width(), geometry.buffer_height());
        let (rgb, _, _) =
            normalize_bgra_to_rgb(&buffer, bw, bh, &geometry, soon(), &live()).unwrap();
        assert_eq!(rgb, expected, "hand-derived transform {raw} buffer");
    }
}

#[test]
fn buffer_dimensions_must_match_the_actual_hardware_buffer() {
    let geometry = grid_geometry(0);
    let buffer = reference_bgra();
    // Right pixels, wrong claim: refused, never remapped.
    let err = normalize_bgra_to_rgb(&buffer, 2, 4, &geometry, soon(), &live()).unwrap_err();
    assert!(
        matches!(err, NormalizeError::DimensionMismatch { .. }),
        "wrong refusal: {err}"
    );
    // Right claim, short slice: refused before any indexing.
    let short = &buffer[..buffer.len() - 1];
    assert!(matches!(
        normalize_bgra_to_rgb(short, 4, 2, &geometry, soon(), &live()).unwrap_err(),
        NormalizeError::Truncated { .. }
    ));
}

#[test]
fn bgra_normalize_is_preemptible() {
    let (buffer, geometry) = buffer_via_geometry(3);
    let (bw, bh) = (geometry.buffer_width(), geometry.buffer_height());
    let cancel = live();
    cancel.cancel();
    assert_eq!(
        normalize_bgra_to_rgb(&buffer, bw, bh, &geometry, soon(), &cancel).unwrap_err(),
        NormalizeError::Cancelled
    );
    let past = Instant::now() - Duration::from_secs(1);
    assert_eq!(
        normalize_bgra_to_rgb(&buffer, bw, bh, &geometry, past, &live()).unwrap_err(),
        NormalizeError::Timeout
    );
}

#[test]
fn normalized_target_downscales_and_tracks_origin() {
    // 2560x1440 at scale 1: long edge 2560 shrinks to 1280x720, the scale
    // tracks the downscale, and the origin is preserved.
    let geometry = OutputGeometry::new(10, -4, 2560, 1440, 1.0, 0, 2560, 1440).unwrap();
    let (tw, th, out) = normalized_target(&geometry);
    assert_eq!((tw, th), fit_long_edge(2560, 1440, MAX_LONG_EDGE));
    assert_eq!((tw, th), (1280, 720));
    assert!((out.scale - 1280.0 / 2560.0).abs() < 1e-9);
    assert_eq!((out.image_width, out.image_height), (1280, 720));
    assert_eq!((out.origin.x, out.origin.y), (10.0, -4.0));
    // Small grids pass through at full size with the buffer scale.
    let small = grid_geometry(0);
    let (tw, th, out) = normalized_target(&small);
    assert_eq!((tw, th), (4, 2));
    assert!((out.scale - 1.0).abs() < 1e-9);
    // Rotated: the target is the upright size, downscaled if needed.
    let rotated = OutputGeometry::new(32, 0, 24, 32, 1.0, 1, 32, 24).unwrap();
    let (tw, th, out) = normalized_target(&rotated);
    assert_eq!((tw, th), (24, 32));
    assert!((out.scale - 1.0).abs() < 1e-9);
    assert_eq!((out.origin.x, out.origin.y), (32.0, 0.0));
}

/// Upright RGB quadrants over a `width`x`height` image (both even):
/// TL red, TR green, BL blue, BR white.
fn quadrant_rgb(width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut rgb = vec![0u8; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let color = match (x < w / 2, y < h / 2) {
                (true, true) => [255, 0, 0],
                (false, true) => [0, 255, 0],
                (true, false) => [0, 0, 255],
                (false, false) => [255, 255, 255],
            };
            rgb[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&color);
        }
    }
    rgb
}

#[test]
fn bilinear_downscale_keeps_quadrant_colors_exactly() {
    // 8x6 quadrants down to 4x3: every output pixel averages a uniform 2x2
    // block, so the colors are exact with no tolerance needed.
    let rgb = quadrant_rgb(8, 6);
    let out =
        downscale_rgb_bilinear(&rgb, 8, 6, 4, 3, soon(), &live(), None).unwrap();
    assert_eq!(out.len(), 4 * 3 * 3);
    let pixel = |x: usize, y: usize| [out[(y * 4 + x) * 3], out[(y * 4 + x) * 3 + 1], out[(y * 4 + x) * 3 + 2]];
    assert_eq!(pixel(0, 0), [255, 0, 0]);
    assert_eq!(pixel(3, 0), [0, 255, 0]);
    assert_eq!(pixel(0, 2), [0, 0, 255]);
    assert_eq!(pixel(3, 2), [255, 255, 255]);
}

#[test]
fn downscale_is_preemptible_mid_way() {
    // The progress hook fires per output row: cancelling from the hook
    // stops the downscale on the next row, deterministically mid-way
    // instead of only via a pre-set flag.
    let rgb = quadrant_rgb(64, 64);
    let cancel = live();
    let handle = cancel.clone();
    let hook = move |row: u64| {
        if row >= 1 {
            handle.cancel();
        }
    };
    let err = downscale_rgb_bilinear(&rgb, 64, 64, 32, 32, soon(), &cancel, Some(&hook))
        .unwrap_err();
    assert_eq!(err, NormalizeError::Cancelled);
    // A fired handle and an expired deadline refuse before any allocation.
    let fired = live();
    fired.cancel();
    assert_eq!(
        downscale_rgb_bilinear(&rgb, 64, 64, 32, 32, soon(), &fired, None).unwrap_err(),
        NormalizeError::Cancelled
    );
    let past = Instant::now() - Duration::from_secs(1);
    assert_eq!(
        downscale_rgb_bilinear(&rgb, 64, 64, 32, 32, past, &live(), None).unwrap_err(),
        NormalizeError::Timeout
    );
}

#[test]
fn downscale_refuses_absurd_targets_before_allocating() {
    // 100000x100000 RGB output would need 30 GB: the checked budget
    // refuses it while the input is still 48 bytes. Passing this test
    // without an allocation failure is the point.
    let rgb = quadrant_rgb(4, 4);
    let err =
        downscale_rgb_bilinear(&rgb, 4, 4, 100_000, 100_000, soon(), &live(), None).unwrap_err();
    assert!(matches!(err, NormalizeError::TooLarge { .. }), "wrong refusal: {err}");
    // A short input slice is refused before any indexing.
    assert!(matches!(
        downscale_rgb_bilinear(&rgb[..47], 4, 4, 2, 2, soon(), &live(), None).unwrap_err(),
        NormalizeError::Truncated { .. }
    ));
}

#[test]
fn fused_scalars_agree_with_geometry_for_all_transforms() {
    // For every transform, every buffer pixel center maps through geometry
    // to the same global point the normalized screenshot geometry reports
    // for the corresponding upright pixel center: rotation happens exactly
    // once, and the agent's coordinate mapping stays exact.
    //
    // Contract bridge: `OutputGeometry` buffer indices address pixel
    // centers (integer = center), while `ScreenshotGeometry::to_point`
    // addresses corners over half-open `[0, width)`. Both meet at centers,
    // so the comparison samples `ux + 0.5` against the rounded globals.
    for raw in 0..=7 {
        let (buffer, geometry) = buffer_via_geometry(raw);
        let (bw, bh) = (geometry.buffer_width(), geometry.buffer_height());
        let (upright, uw, uh) =
            normalize_bgra_to_rgb(&buffer, bw, bh, &geometry, soon(), &live()).unwrap();
        let (tw, th, out_geometry) = normalized_target(&geometry);
        // Small grids stay far below the long edge: 1:1 pixels.
        assert_eq!((tw, th), (4, 2), "transform {raw} upright size");
        let rgb = downscale_rgb_bilinear(&upright, uw, uh, tw, th, soon(), &live(), None).unwrap();
        assert_eq!(rgb.len(), 4 * 2 * 3);
        let transform = geometry.transform();
        for uy in 0..2 {
            for ux in 0..4 {
                let (bx, by) = buffer_to_upright(ux, uy, uw, uh, transform);
                let global = geometry.buffer_to_global(bx as f64, by as f64).unwrap();
                let mapped = out_geometry.to_point(ux as f64 + 0.5, uy as f64 + 0.5).unwrap();
                assert_eq!(
                    (mapped.x, mapped.y),
                    (global.x.round(), global.y.round()),
                    "transform {raw} pixel ({ux},{uy}) vs buffer ({bx},{by})"
                );
            }
        }
    }
}

#[test]
fn fused_rotation_matches_the_lossless_path_through_jpeg() {
    // R90 8x6 buffer quadrants (TL red, TR green, BL blue, BR white):
    // the upright top-left shows the buffer bottom-left (blue), the
    // upright top-right the buffer top-left (red). Same direction the
    // BGRA tests pin, through the shared capped encoder.
    let geometry = OutputGeometry::new(32, 0, 6, 8, 1.0, 1, 8, 6).unwrap();
    let bgra = buffer_quadrants_bgra(8, 6);
    let (bw, bh) = (geometry.buffer_width(), geometry.buffer_height());
    let (upright, uw, uh) =
        normalize_bgra_to_rgb(&bgra, bw, bh, &geometry, soon(), &live()).unwrap();
    assert_eq!((uw, uh), (6, 8));
    let (tw, th, _) = normalized_target(&geometry);
    assert_eq!((tw, th), (6, 8));
    let rgb = downscale_rgb_bilinear(&upright, uw, uh, tw, th, soon(), &live(), None).unwrap();
    let jpeg = encode_frame_jpeg(&rgb, tw, th, soon(), &live()).unwrap();
    let image = image::load_from_memory(&jpeg).unwrap().to_rgb8();
    assert_eq!(image.dimensions(), (6, 8));
    let near = |a: &[u8], b: [u8; 3]| {
        a[0].abs_diff(b[0]) < 40 && a[1].abs_diff(b[1]) < 40 && a[2].abs_diff(b[2]) < 40
    };
    assert!(near(&image.get_pixel(1, 1).0, [0, 0, 255]), "upright TL is buffer BL blue");
    assert!(near(&image.get_pixel(4, 1).0, [255, 0, 0]), "upright TR is buffer TL red");
}

/// Buffer-orientation BGRA quadrants: TL red, TR green, BL blue, BR white.
fn buffer_quadrants_bgra(width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut bgra = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let (r, g, b) = match (x < w / 2, y < h / 2) {
                (true, true) => (255, 0, 0),
                (false, true) => (0, 255, 0),
                (true, false) => (0, 0, 255),
                (false, false) => (255, 255, 255),
            };
            bgra[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[b, g, r, 255]);
        }
    }
    bgra
}

#[test]
fn shared_encoder_is_capped_and_cancellable() {
    let rgb = quadrant_rgb(8, 6);
    let jpeg = encode_frame_jpeg(&rgb, 8, 6, soon(), &live()).unwrap();
    assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
    let image = image::load_from_memory(&jpeg).unwrap().to_rgb8();
    assert_eq!(image.dimensions(), (8, 6));
    // Cancel and deadline refuse before encoding (transport stop, same as
    // the capture path's pre-encode gate).
    let fired = live();
    fired.cancel();
    assert!(matches!(
        encode_frame_jpeg(&rgb, 8, 6, soon(), &fired).unwrap_err(),
        super::capture::CaptureError::Transport(_)
    ));
    let past = Instant::now() - Duration::from_secs(1);
    assert!(encode_frame_jpeg(&rgb, 8, 6, past, &live()).is_err());
}

#[test]
fn normalized_peak_accounts_every_live_phase() {
    use super::pixels::{capture_peak_bytes, FrameParams};
    use wayland_client::protocol::wl_shm;
    let params = FrameParams {
        format: wl_shm::Format::Xrgb8888,
        width: 32,
        height: 24,
        stride: 128,
    };
    let shm_len = 32 * 128;
    let jpeg_cap = 4 * 24 * 32 + 4 * 1024;
    let peak = normalized_peak_bytes(shm_len, params, 24 * 32, jpeg_cap).unwrap();
    // Every phase fits under the aggregate cap, and the fused peak never
    // exceeds the raw peak for the same frame (the target is smaller than
    // the buffer here).
    let raw = capture_peak_bytes(shm_len, params, 4 * 32 * 24 + 4 * 1024).unwrap();
    assert!(peak <= raw, "fused peak {peak} must not exceed raw peak {raw}");
    assert!(peak > shm_len as u64, "the peak must cover more than the SHM file alone");
    // Overflow is a refusal, never a wrap.
    assert!(normalized_peak_bytes(usize::MAX, params, u64::MAX, u64::MAX).is_err());
}
