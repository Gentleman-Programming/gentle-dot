//! RED/GREEN checks for [`super::OutputGeometry`]: normal, fractional,
//! negative-origin, rotated and flipped mappings, plus refusal of invalid
//! dimensions, bad transforms, and off-output coordinates. Pure geometry: no
//! compositor, no buffers, no input.

use super::geometry::{GeometryError, OutputGeometry, OutputTransform};

fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

fn normal() -> OutputGeometry {
    OutputGeometry::new(0, 0, 1920, 1080, 1.0, 0, 1920, 1080).unwrap()
}

#[test]
fn normal_pixels_map_centers_one_to_one() {
    let g = normal();
    // Integers are pixel centers: pixel (960,540) samples (960.5,540.5).
    let center = g.buffer_to_global(960.0, 540.0).unwrap();
    assert_eq!((center.x, center.y), (960.5, 540.5));
    let first = g.buffer_to_global(0.0, 0.0).unwrap();
    assert_eq!((first.x, first.y), (0.5, 0.5));
    let far = g.buffer_to_global(1919.0, 1079.0).unwrap();
    assert_eq!((far.x, far.y), (1919.5, 1079.5));
    let back = g.global_to_buffer(960.5, 540.5).unwrap();
    assert_eq!((back.x, back.y), (960.0, 540.0));
}

#[test]
fn fractional_scale_keeps_subpixel_math() {
    // 2560x1440 logical at 1.5x: the bridge must not round this to 2x.
    let g = OutputGeometry::new(0, 0, 2560, 1440, 1.5, 0, 3840, 2160).unwrap();
    let center = g.buffer_to_global(1920.0, 1080.0).unwrap();
    assert!(approx(center.x, 1920.5 / 1.5) && approx(center.y, 1080.5 / 1.5));
    let sub = g.buffer_to_global(1.0, 1.0).unwrap();
    assert_eq!((sub.x, sub.y), (1.0, 1.0));
    let back = g.global_to_buffer(1280.0, 720.0).unwrap();
    assert_eq!((back.x, back.y), (1919.5, 1079.5));
    assert_eq!(g.expected_buffer_dimensions(), (3840, 2160));
}

#[test]
fn negative_origin_shifts_global_without_clamping() {
    let g = OutputGeometry::new(-1920, -300, 1920, 1080, 1.0, 0, 1920, 1080).unwrap();
    let p = g.buffer_to_global(640.0, 360.0).unwrap();
    assert_eq!((p.x, p.y), (-1279.5, 60.5));
    let back = g.global_to_buffer(-1919.5, -299.5).unwrap();
    assert_eq!((back.x, back.y), (0.0, 0.0));
    // The right/bottom edges belong to the neighbor (or a gap): refused.
    assert_eq!(
        g.global_to_buffer(0.0, 0.0).unwrap_err(),
        GeometryError::OutsideOutput { x: 0.0, y: 0.0 }
    );
    assert_eq!(
        g.global_to_buffer(-1921.0, 0.0).unwrap_err(),
        GeometryError::OutsideOutput { x: -1921.0, y: 0.0 }
    );
}

#[test]
fn rotated_90_swaps_axes_with_exact_corners() {
    // 1920x1080 panel turned 90 degrees: logical 1080x1920, buffer 1920x1080.
    let g = OutputGeometry::new(1920, 0, 1080, 1920, 1.0, 1, 1920, 1080).unwrap();
    assert_eq!(g.expected_buffer_dimensions(), (1920, 1080));
    // Buffer center lands on the logical center; first pixel lands strictly
    // inside (top-right under the counter-clockwise rotation), usable by the
    // inverse. Logical top-left maps to the first column, last row.
    let center = g.buffer_to_global(960.0, 540.0).unwrap();
    assert_eq!((center.x, center.y), (2459.5, 960.5));
    let corner = g.buffer_to_global(0.0, 0.0).unwrap();
    assert_eq!((corner.x, corner.y), (2999.5, 0.5));
    assert!(g.contains_global(corner.x, corner.y));
    let back = g.global_to_buffer(1920.5, 0.5).unwrap();
    assert_eq!((back.x, back.y), (0.0, 1079.0));
}

#[test]
fn rotated_270_is_not_90() {
    let g = OutputGeometry::new(1920, 0, 1080, 1920, 1.0, 3, 1920, 1080).unwrap();
    let center = g.buffer_to_global(960.0, 540.0).unwrap();
    assert_eq!((center.x, center.y), (2460.5, 959.5));
    // Opposite side from the 90-degree case: direction matters.
    let corner = g.buffer_to_global(0.0, 0.0).unwrap();
    assert_eq!((corner.x, corner.y), (1920.5, 1919.5));
    assert!(g.contains_global(corner.x, corner.y));
}

#[test]
fn flipped_and_180_mirror_without_double_rotation() {
    let flip = OutputGeometry::new(0, 0, 1920, 1080, 1.0, 4, 1920, 1080).unwrap();
    let left = flip.buffer_to_global(0.0, 0.0).unwrap();
    assert_eq!((left.x, left.y), (1919.5, 0.5));
    let back = flip.global_to_buffer(0.5, 0.5).unwrap();
    assert_eq!((back.x, back.y), (1919.0, 0.0));
    let turn = OutputGeometry::new(0, 0, 1920, 1080, 1.0, 2, 1920, 1080).unwrap();
    let origin = turn.buffer_to_global(0.0, 0.0).unwrap();
    assert_eq!((origin.x, origin.y), (1919.5, 1079.5));
    let center = turn.buffer_to_global(960.0, 540.0).unwrap();
    assert_eq!((center.x, center.y), (959.5, 539.5));
}

#[test]
fn every_transform_roundtrips_an_interior_point() {
    for raw in 0..=7 {
        let (lw, lh, bw, bh) = if OutputTransform::from_raw(raw).unwrap().swaps_axes() {
            (1080, 1920, 1920, 1080)
        } else {
            (1920, 1080, 1920, 1080)
        };
        let g = OutputGeometry::new(0, 0, lw, lh, 1.0, raw, bw, bh).unwrap();
        let global = g.buffer_to_global(100.5, 200.25).unwrap();
        let back = g.global_to_buffer(global.x, global.y).unwrap();
        assert!(
            approx(back.x, 100.5) && approx(back.y, 200.25),
            "transform {raw} must roundtrip, got ({}, {})",
            back.x,
            back.y
        );
    }
}

#[test]
fn invalid_dimensions_transforms_and_scales_are_rejected() {
    assert_eq!(
        OutputGeometry::new(0, 0, 0, 1080, 1.0, 0, 1920, 1080).unwrap_err(),
        GeometryError::EmptyExtent { field: "logical_width" }
    );
    assert_eq!(
        OutputGeometry::new(0, 0, 1920, -1080, 1.0, 0, 1920, 1080).unwrap_err(),
        GeometryError::EmptyExtent { field: "logical_height" }
    );
    assert!(matches!(
        OutputGeometry::new(0, 0, 1920, 1080, 1.0, 0, 0, 1080),
        Err(GeometryError::EmptyExtent { .. })
    ));
    assert!(matches!(
        OutputGeometry::new(0, 0, 1920, 1080, 1.0, 0, 1920, -1),
        Err(GeometryError::EmptyExtent { .. })
    ));
    assert_eq!(
        OutputGeometry::new(0, 0, 1920, 1080, f64::NAN, 0, 1920, 1080).unwrap_err(),
        GeometryError::NonFiniteScale
    );
    assert_eq!(
        OutputGeometry::new(0, 0, 1920, 1080, 0.0, 0, 1920, 1080).unwrap_err(),
        GeometryError::NonPositiveScale
    );
    // A scale so small the output would have no physical pixels.
    assert!(matches!(
        OutputGeometry::new(0, 0, 1, 1, 0.4, 0, 1, 1),
        Err(GeometryError::EmptyExtent { .. })
    ));
    // Overflow: logical * scale neither fits u32 nor stays finite.
    assert!(matches!(
        OutputGeometry::new(0, 0, i32::MAX, 1080, 3.0, 0, 4096, 2160),
        Err(GeometryError::Overflow { .. })
    ));
    assert_eq!(
        OutputGeometry::new(0, 0, 1920, 1080, 1.0, 8, 1920, 1080).unwrap_err(),
        GeometryError::BadTransform(8)
    );
    assert_eq!(
        OutputGeometry::new(0, 0, 1920, 1080, 1.0, -1, 1920, 1080).unwrap_err(),
        GeometryError::BadTransform(-1)
    );
}

#[test]
fn out_of_range_coordinates_are_refused_without_side_effects() {
    let g = normal();
    assert_eq!(
        g.buffer_to_global(1920.0, 0.0).unwrap_err(),
        GeometryError::OutsideBuffer { x: 1920.0, y: 0.0, width: 1920, height: 1080 }
    );
    assert!(matches!(
        g.buffer_to_global(-0.5, 0.0),
        Err(GeometryError::OutsideBuffer { .. })
    ));
    assert!(matches!(
        g.buffer_to_global(0.0, 1080.0),
        Err(GeometryError::OutsideBuffer { .. })
    ));
    // Past the last pixel center is outside, even inside the buffer edge.
    assert!(matches!(
        g.buffer_to_global(1919.5, 0.0),
        Err(GeometryError::OutsideBuffer { .. })
    ));
    assert_eq!(
        g.buffer_to_global(f64::NAN, 0.0).unwrap_err(),
        GeometryError::NonFiniteCoordinate
    );
    assert!(matches!(
        g.global_to_buffer(10.0, f64::INFINITY),
        Err(GeometryError::NonFiniteCoordinate)
    ));
    // A point in the gap right of the output is refused, never clamped in.
    assert_eq!(
        g.global_to_buffer(1920.0, 540.0).unwrap_err(),
        GeometryError::OutsideOutput { x: 1920.0, y: 540.0 }
    );
    // Errors leave no state behind: the same geometry still maps exactly.
    let again = g.buffer_to_global(960.0, 540.0).unwrap();
    assert_eq!((again.x, again.y), (960.5, 540.5));
}

#[test]
fn boundaries_are_half_open_and_finite_only() {
    let g = normal();
    assert!(g.contains_global(0.0, 0.0));
    assert!(g.contains_global(1919.999, 1079.999));
    assert!(!g.contains_global(1920.0, 0.0));
    assert!(!g.contains_global(0.0, 1080.0));
    assert!(!g.contains_global(-1.0, 0.0));
    assert!(!g.contains_global(f64::NAN, 0.0));
    // Last pixel center maps inside; the exact min edge maps to half-negative
    // indices, which flooring plus a bounds check must reject (never feed to
    // another output).
    let last = g.buffer_to_global(1919.0, 1079.0).unwrap();
    assert_eq!((last.x, last.y), (1919.5, 1079.5));
    assert!(g.contains_global(last.x, last.y));
    let edge = g.global_to_buffer(0.0, 0.0).unwrap();
    assert_eq!((edge.x, edge.y), (-0.5, -0.5));
}

// --- B2/B3 regression tests: dimension consistency and the pixel-center
// contract. Written RED: they fail against the pre-fix constructor/mapping.

#[test]
fn b2_swapped_or_mismatched_buffer_dimensions_are_rejected() {
    // R90 logical 1080x1920 at scale 1 needs the 1920x1080 hardware buffer;
    // the unswapped 1080x1920 buffer describes a different mode, not this one.
    assert_eq!(
        OutputGeometry::new(1920, 0, 1080, 1920, 1.0, 1, 1080, 1920).unwrap_err(),
        GeometryError::InconsistentBuffer { field: "buffer_width", expected: 1920, got: 1080 }
    );
    // Unrotated output with a transposed buffer likewise.
    assert!(OutputGeometry::new(0, 0, 1920, 1080, 1.0, 0, 1080, 1920).is_err());
    // Off by more than rounding, even at a fractional scale.
    assert!(OutputGeometry::new(0, 0, 1001, 1001, 1.5, 0, 1504, 1504).is_err());
}

#[test]
fn b2_fractional_rounding_tolerance_is_at_most_one_pixel() {
    // 1001 * 1.5 = 1501.5 rounds to 1502: +-1 covers float dust, +-2 does not.
    assert!(OutputGeometry::new(0, 0, 1001, 1001, 1.5, 0, 1501, 1501).is_ok());
    assert!(OutputGeometry::new(0, 0, 1001, 1001, 1.5, 0, 1503, 1503).is_ok());
    assert!(OutputGeometry::new(0, 0, 1001, 1001, 1.5, 0, 1500, 1500).is_err());
    // Integral scales are exact in f64: no tolerance is granted.
    assert!(OutputGeometry::new(0, 0, 1920, 1080, 2.0, 0, 3840, 2160).is_ok());
    assert!(OutputGeometry::new(0, 0, 1920, 1080, 2.0, 0, 3839, 2160).is_err());
}

#[test]
fn b3_every_integer_pixel_maps_inside_for_all_transforms() {
    for raw in 0..=7 {
        let swaps = OutputTransform::from_raw(raw).unwrap().swaps_axes();
        let (lw, lh, bw, bh) =
            if swaps { (1080, 1920, 1920, 1080) } else { (1920, 1080, 1920, 1080) };
        let g = OutputGeometry::new(0, 0, lw, lh, 1.0, raw, bw, bh).unwrap();
        let corners =
            [(0.0, 0.0), (bw as f64 - 1.0, 0.0), (0.0, bh as f64 - 1.0), (bw as f64 - 1.0, bh as f64 - 1.0)];
        for (px, py) in corners {
            let global = g.buffer_to_global(px, py).unwrap();
            assert!(
                g.contains_global(global.x, global.y),
                "transform {raw} pixel ({px},{py}) mapped outside to ({}, {})",
                global.x,
                global.y
            );
            // ... so the result feeds straight back into the inverse.
            let back = g.global_to_buffer(global.x, global.y).unwrap();
            assert!(approx(back.x, px) && approx(back.y, py));
        }
    }
}

#[test]
fn b3_hardcoded_table_covers_all_eight_transforms() {
    // Logical 4x2 at origin (-7, 3), scale 1. Pixel A=(0,0) and B=(1,0) are
    // pixel centers; expected globals are hand-derived from the
    // flip-first counter-clockwise convention (wayland.xml
    // wl_output.transform), the same math Smithay/Niri implement. This is
    // not a roundtrip: every value below is pinned independently.
    let cases = [
        (0, 4, 2, -6.5, 3.5, -5.5, 3.5),
        (1, 2, 4, -3.5, 3.5, -3.5, 4.5),
        (2, 4, 2, -3.5, 4.5, -4.5, 4.5),
        (3, 2, 4, -6.5, 4.5, -6.5, 3.5),
        (4, 4, 2, -3.5, 3.5, -4.5, 3.5),
        (5, 2, 4, -6.5, 3.5, -6.5, 4.5),
        (6, 4, 2, -6.5, 4.5, -5.5, 4.5),
        (7, 2, 4, -3.5, 4.5, -3.5, 3.5),
    ];
    for (raw, bw, bh, ax, ay, bx, by) in cases {
        let g = OutputGeometry::new(-7, 3, 4, 2, 1.0, raw, bw, bh).unwrap();
        let a = g.buffer_to_global(0.0, 0.0).unwrap();
        let b = g.buffer_to_global(1.0, 0.0).unwrap();
        assert_eq!((a.x, a.y), (ax, ay), "transform {raw} pixel A");
        assert_eq!((b.x, b.y), (bx, by), "transform {raw} pixel B");
        assert!(g.contains_global(a.x, a.y) && g.contains_global(b.x, b.y));
    }
}

#[test]
fn b3_fractional_scale_centers_stay_usable() {
    // Logical 4x2 at scale 2 (buffer 8x4): pixel (1,0) samples the buffer at
    // (1.5, 0.5) physical, i.e. global (0.75, 0.25).
    let g = OutputGeometry::new(0, 0, 4, 2, 2.0, 0, 8, 4).unwrap();
    let p = g.buffer_to_global(1.0, 0.0).unwrap();
    assert_eq!((p.x, p.y), (0.75, 0.25));
    assert!(g.contains_global(p.x, p.y));
    let back = g.global_to_buffer(p.x, p.y).unwrap();
    assert!(approx(back.x, 1.0) && approx(back.y, 0.0));
}

#[test]
fn b4_tolerance_accepted_buffers_keep_every_corner_inside() {
    // Parent regression: 100x100 @1.25 nominally needs 125x125, but a 126x125
    // hardware buffer is accepted by the fractional tolerance. The hardware
    // buffer is then authoritative: every accepted corner must still map
    // strictly inside the logical extents and roundtrip, for every transform
    // and for positive and negative origins alike.
    for raw in 0..=7 {
        let swaps = OutputTransform::from_raw(raw).unwrap().swaps_axes();
        let (bw, bh) = if swaps { (125, 126) } else { (126, 125) };
        for (ox, oy) in [(0, 0), (-150, -40)] {
            let g = OutputGeometry::new(ox, oy, 100, 100, 1.25, raw, bw, bh)
                .expect("one-pixel fractional mismatch stays accepted");
            for (px, py) in [
                (0.0, 0.0),
                (bw as f64 - 1.0, 0.0),
                (0.0, bh as f64 - 1.0),
                (bw as f64 - 1.0, bh as f64 - 1.0),
            ] {
                let global = g.buffer_to_global(px, py).unwrap();
                assert!(
                    g.contains_global(global.x, global.y),
                    "transform {raw} origin ({ox},{oy}) pixel ({px},{py}) escaped to ({}, {})",
                    global.x, global.y
                );
                let back = g.global_to_buffer(global.x, global.y).unwrap();
                assert!(approx(back.x, px) && approx(back.y, py));
            }
        }
    }
}

#[test]
fn transform_raw_values_cover_all_wayland_transforms() {
    for raw in 0..=7 {
        let t = OutputTransform::from_raw(raw).unwrap();
        assert_eq!(t.swaps_axes(), matches!(raw, 1 | 3 | 5 | 7));
    }
    for raw in [-1, 8, i32::MIN, i32::MAX] {
        assert_eq!(OutputTransform::from_raw(raw).unwrap_err(), GeometryError::BadTransform(raw));
    }
}
