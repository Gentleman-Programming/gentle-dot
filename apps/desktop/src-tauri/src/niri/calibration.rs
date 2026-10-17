//! Conditional math for Niri 26.04 logical clamp samples, not a live probe.
//! Callers must independently validate version, window identity, stable
//! workspace/output/size and accepted movement. IPC positions do not prove
//! rendered settlement. No GTK, sockets, locks or persisted state here.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WorkAreaEstimate {
    pub origin: (f64, f64),
    pub size: (f64, f64),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BasePlacement {
    pub panel: (f64, f64),
    pub rose: Option<(f64, f64)>,
}

impl WorkAreaEstimate {
    fn bounds(self) -> Option<(f64, f64)> {
        let right = self.origin.0 + self.size.0;
        let bottom = self.origin.1 + self.size.1;
        // Existing move planners use i32 coordinates: never silently saturate.
        if self.size.0 <= 0.0 || self.size.1 <= 0.0
            || !self.size.0.is_finite() || !self.size.1.is_finite()
            || right <= self.origin.0 || bottom <= self.origin.1
            || [self.origin.0, self.origin.1, right, bottom].into_iter().any(|v|
                !v.is_finite() || v < f64::from(i32::MIN) || v > f64::from(i32::MAX)) {
            return None;
        }
        Some((right, bottom))
    }
}

/// Whole-pixel convenience wrapper for the inference below. Production uses
/// the logical overload: Niri tile extents carry fractional borders.
#[cfg(test)]
pub fn infer_work_area(
    fixed: (f64, f64),
    proportional: (f64, f64),
    probe_size: (i32, i32),
) -> Option<WorkAreaEstimate> {
    infer_work_area_logical(fixed, proportional, (f64::from(probe_size.0), f64::from(probe_size.1)))
}

/// Estimate both axes from Fixed(0,0) and Proportion(100,100) clamp samples.
/// The probe must fit: otherwise Fixed(0,0) cannot establish the origin.
/// Takes fractional compositor tile extents, including their borders.
pub fn infer_work_area_logical(
    fixed: (f64, f64),
    proportional: (f64, f64),
    probe_size: (f64, f64),
) -> Option<WorkAreaEstimate> {
    if probe_size.0 <= 0.0 || probe_size.1 <= 0.0
        || [probe_size.0, probe_size.1, fixed.0, fixed.1, proportional.0, proportional.1].into_iter().any(|v| !v.is_finite())
        || proportional.0 < fixed.0 || proportional.1 < fixed.1 {
        return None;
    }
    let minimum = |size: f64| (size / 4.0).clamp(10.0, 75.0);
    let work = WorkAreaEstimate {
        origin: fixed,
        size: (proportional.0 - fixed.0 + minimum(probe_size.0),
            proportional.1 - fixed.1 + minimum(probe_size.1)),
    };
    work.bounds()?;
    if work.size.0 < probe_size.0 || work.size.1 < probe_size.1 {
        return None;
    }
    Some(work)
}

/// Whole-pixel convenience wrapper for the placement below.
#[cfg(test)]
pub fn upper_right_base(
    work: WorkAreaEstimate,
    panel_size: (i32, i32),
    rose_size: Option<(i32, i32)>,
    gap: i32,
    margin: i32,
) -> Option<BasePlacement> {
    upper_right_base_logical(work, (f64::from(panel_size.0), f64::from(panel_size.1)),
        rose_size.map(|(w,h)|(f64::from(w),f64::from(h))), f64::from(gap), f64::from(margin))
}

/// Keeps a whole unit (panel plus optional rose) inside the measured work area,
/// inset by `margin`, by translating it — never by shrinking it: an oversized
/// unit is refused so no caller silently clamps a window into a falsely fitting
/// position. `origin` is the unit's top-left corner; the result is the nearest
/// corner that leaves every part of the unit on screen, which is what stops the
/// pair from hanging off an edge after a drag near a border. A hidden rose is
/// simply a unit without it.
pub fn clamp_unit_inside(work: WorkAreaEstimate, unit: (f64, f64), origin: (f64, f64), margin: f64) -> Option<(f64, f64)> {
    let (right, bottom) = work.bounds()?;
    let valid = |value: f64| value.is_finite() && value >= 0.0;
    if !valid(unit.0) || !valid(unit.1) || !margin.is_finite() || margin < 0.0
        || !origin.0.is_finite() || !origin.1.is_finite() {
        return None;
    }
    let (low_x, low_y) = (work.origin.0 + margin, work.origin.1 + margin);
    let (high_x, high_y) = (right - margin - unit.0, bottom - margin - unit.1);
    if high_x < low_x || high_y < low_y {
        return None;
    }
    Some((origin.0.clamp(low_x, high_x), origin.1.clamp(low_y, high_y)))
}

/// The area a visible pair occupies: panel, gap and rose side by side.
pub fn pair_size(panel_size: (f64, f64), rose_size: Option<(f64, f64)>, gap: f64) -> (f64, f64) {
    match rose_size {
        Some((rose_width, rose_height)) => (panel_size.0 + gap + rose_width, panel_size.1.max(rose_height)),
        None => panel_size,
    }
}

/// Fit actual logical tile bounds without rounding fractional decorations.
pub fn upper_right_base_logical(
    work: WorkAreaEstimate,
    panel_size: (f64, f64),
    rose_size: Option<(f64, f64)>,
    gap: f64,
    margin: f64,
) -> Option<BasePlacement> {
    let (right, _) = work.bounds()?;
    let valid_size = |(w,h): (f64,f64)| w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0;
    if !valid_size(panel_size) || rose_size.is_some_and(|size| !valid_size(size))
        || !gap.is_finite() || !margin.is_finite() || gap < 0.0 || margin < 0.0 {
        return None;
    }
    let (pw, ph) = panel_size;
    let (dw, dh) = rose_size.unwrap_or((0.0, 0.0));
    let unit_width = pw + if rose_size.is_some() { gap + dw } else { 0.0 };
    let unit_height = ph.max(dh);
    if work.size.0 < unit_width + 2.0 * margin || work.size.1 < unit_height + 2.0 * margin {
        return None;
    }
    let panel = (right - unit_width - margin,
        work.origin.1 + margin + (unit_height - ph) / 2.0);
    let rose = rose_size.map(|_| (panel.0 + pw + gap, panel.1 + (ph - dh) / 2.0));
    Some(BasePlacement { panel, rose })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work() -> WorkAreaEstimate {
        WorkAreaEstimate { origin: (-100.5, 32.25), size: (2560.0, 1400.0) }
    }

    #[test]
    fn derives_both_axes_without_losing_translation_or_fractions() {
        assert_eq!(infer_work_area((-100.5, 32.25), (2384.5, 1357.25), (420, 640)), Some(work()));
        assert_eq!(infer_work_area((0.0, 0.0), (2485.0, 1325.0), (420, 640)),
            Some(WorkAreaEstimate { origin: (0.0, 0.0), size: work().size }));
    }

    #[test]
    fn respects_both_clamp_thresholds_and_actual_probe_sizes() {
        for (size, minimum) in [(1, 10.0), (39, 10.0), (40, 10.0), (41, 10.25),
            (72, 18.0), (299, 74.75), (300, 75.0), (301, 75.0), (1000, 75.0)] {
            for probe in [(size, 640), (640, size)] {
                let minimums = if probe.0 == size { (minimum, 75.0) } else { (75.0, minimum) };
                let endpoint = (2000.0 - minimums.0, 1400.0 - minimums.1);
                assert_eq!(infer_work_area((0.0, 0.0), endpoint, probe),
                    Some(WorkAreaEstimate { origin: (0.0, 0.0), size: (2000.0, 1400.0) }));
            }
        }
    }

    #[test]
    fn rejects_nonfinite_samples_and_probes_that_cannot_establish_origin() {
        assert!(infer_work_area((0.0, 0.0), (2485.0, 1325.0), (420, 640)).is_some());
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for (fixed, proportional) in [((bad, 0.0), (2485.0, 1325.0)),
                ((0.0, bad), (2485.0, 1325.0)), ((0.0, 0.0), (bad, 1325.0)),
                ((0.0, 0.0), (2485.0, bad))] {
                assert_eq!(infer_work_area(fixed, proportional, (420, 640)), None);
            }
        }
        for size in [(0, 640), (-1, 640), (420, 0), (420, -1)] {
            assert_eq!(infer_work_area((0.0, 0.0), (2485.0, 1325.0), size), None);
        }
        for endpoint in [(-1.0, 1325.0), (2485.0, -1.0), (344.0, 1325.0), (2485.0, 564.0)] {
            assert_eq!(infer_work_area((0.0, 0.0), endpoint, (420, 640)), None);
        }
        assert_eq!(infer_work_area((-f64::MAX, 0.0), (f64::MAX, 1325.0), (420, 640)), None);
        assert_eq!(infer_work_area((1e30, 1e30), (1e30, 1e30), (1, 1)), None);
    }

    #[test]
    fn reserves_the_whole_pair_or_only_the_panel() {
        assert_eq!(upper_right_base(work(), (420, 640), Some((72, 72)), 8, 12),
            Some(BasePlacement { panel: (1947.5, 44.25), rose: Some((2375.5, 328.25)) }));
        assert_eq!(upper_right_base(work(), (420, 640), None, 8, 12),
            Some(BasePlacement { panel: (2027.5, 44.25), rose: None }));
    }

    #[test]
    fn requires_exact_full_unit_fit_and_centers_a_taller_rose() {
        let area = |size| WorkAreaEstimate { origin: (0.0, 0.0), size };
        assert_eq!(upper_right_base(area((524.0, 664.0)), (420, 640), Some((72, 72)), 8, 12),
            Some(BasePlacement { panel: (12.0, 12.0), rose: Some((440.0, 296.0)) }));
        for size in [(523.0, 664.0), (524.0, 663.0)] {
            assert_eq!(upper_right_base(area(size), (420, 640), Some((72, 72)), 8, 12), None);
        }
        assert_eq!(upper_right_base(area((444.0, 664.0)), (420, 640), None, 8, 12),
            Some(BasePlacement { panel: (12.0, 12.0), rose: None }));
        assert_eq!(upper_right_base(area((443.0, 664.0)), (420, 640), None, 8, 12), None);
        assert_eq!(upper_right_base(area((524.0, 824.0)), (420, 640), Some((72, 800)), 8, 12),
            Some(BasePlacement { panel: (12.0, 92.0), rose: Some((440.0, 12.0)) }));
    }

    #[test]
    fn rejects_invalid_area_or_unit_without_saturating_coordinates() {
        assert!(upper_right_base(work(), (420, 640), Some((72, 72)), 8, 12).is_some());
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -1.0] {
            for area in [WorkAreaEstimate { size: (bad, 1400.0), ..work() },
                WorkAreaEstimate { size: (2560.0, bad), ..work() }] {
                assert_eq!(upper_right_base(area, (420, 640), Some((72, 72)), 8, 12), None);
            }
        }
        for origin in [(f64::NAN, 0.0), (0.0, f64::INFINITY), (f64::MAX, 0.0),
            (0.0, f64::NEG_INFINITY), (1e30, 0.0)] {
            assert_eq!(upper_right_base(WorkAreaEstimate { origin, ..work() }, (420, 640), None, 8, 12), None);
        }
        for size in [(0, 640), (-1, 640), (420, 0), (420, -1)] {
            assert_eq!(upper_right_base(work(), size, None, 8, 12), None);
        }
        for size in [(0, 72), (-1, 72), (72, 0), (72, -1)] {
            assert_eq!(upper_right_base(work(), (420, 640), Some(size), 8, 12), None);
        }
        assert_eq!(upper_right_base(work(), (420, 640), None, -1, 12), None);
        assert_eq!(upper_right_base(work(), (420, 640), None, 8, -1), None);
        assert_eq!(upper_right_base(WorkAreaEstimate { size: (f64::MAX, f64::MAX), ..work() },
            (420, 640), None, 8, 12), None);
    }

    #[test]
    fn clamps_the_whole_pair_inside_the_work_area_on_every_edge() {
        // Measured area from the calibration probe: origin (12,30), 1280x1000.
        let work = WorkAreaEstimate { origin: (12.0, 30.0), size: (1280.0, 1000.0) };
        let pair = pair_size((420.0, 640.0), Some((72.0, 72.0)), 8.0);
        assert_eq!(pair, (500.0, 640.0));
        // Inside already: untouched, so an ordinary drag never shifts.
        assert_eq!(clamp_unit_inside(work, pair, (100.0, 200.0), 12.0), Some((100.0, 200.0)));
        // Past the right edge, past the bottom edge, and past the origin corner.
        assert_eq!(clamp_unit_inside(work, pair, (900.0, 200.0), 12.0), Some((780.0, 200.0)));
        assert_eq!(clamp_unit_inside(work, pair, (100.0, 500.0), 12.0), Some((100.0, 378.0)));
        assert_eq!(clamp_unit_inside(work, pair, (-80.0, -80.0), 12.0), Some((24.0, 42.0)));
        // A hidden rose leaves the panel alone, and the panel fits alone.
        assert_eq!(pair_size((420.0, 640.0), None, 8.0), (420.0, 640.0));
        assert_eq!(clamp_unit_inside(work, (420.0, 640.0), (900.0, 200.0), 12.0), Some((860.0, 200.0)));
        // A taller rose grows the unit's height, not the panel's.
        assert_eq!(pair_size((420.0, 640.0), Some((72.0, 800.0)), 8.0), (500.0, 800.0));
    }

    #[test]
    fn refuses_to_clamp_a_unit_that_cannot_fit() {
        let small = WorkAreaEstimate { origin: (0.0, 0.0), size: (400.0, 400.0) };
        assert_eq!(clamp_unit_inside(small, (500.0, 640.0), (0.0, 0.0), 12.0), None);
        // Exactly the usable area fits; one pixel less does not.
        let exact = WorkAreaEstimate { origin: (0.0, 0.0), size: (524.0, 664.0) };
        assert_eq!(clamp_unit_inside(exact, (500.0, 640.0), (99.0, 99.0), 12.0), Some((12.0, 12.0)));
        let tight = WorkAreaEstimate { origin: (0.0, 0.0), size: (523.0, 664.0) };
        assert_eq!(clamp_unit_inside(tight, (500.0, 640.0), (0.0, 0.0), 12.0), None);
        // Invalid inputs never produce a fabricated corner.
        let work = WorkAreaEstimate { origin: (0.0, 0.0), size: (1280.0, 1000.0) };
        assert_eq!(clamp_unit_inside(work, (f64::NAN, 640.0), (0.0, 0.0), 12.0), None);
        assert_eq!(clamp_unit_inside(work, (500.0, 640.0), (f64::INFINITY, 0.0), 12.0), None);
        assert_eq!(clamp_unit_inside(work, (500.0, 640.0), (0.0, 0.0), -1.0), None);
        assert_eq!(clamp_unit_inside(work, (500.0, 640.0), (0.0, 0.0), f64::NAN), None);
    }
}
