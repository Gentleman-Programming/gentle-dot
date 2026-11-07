//! Private raw-ancestry walk: exact root, validate first, no presentation reads.
const RETAINED_BYTES: usize = 64 * 1024;
const RESOURCE: &str = "accessibility ancestry resource limit";

pub(super) fn walk<N: Clone>(mut node: N, root: &N,
    mut validate: impl FnMut(&N) -> Result<(), String>,
    mut parent: impl FnMut(&N) -> Result<N, String>,
    mut same: impl FnMut(&N, &N) -> Result<bool, String>,
    mut budget: impl FnMut() -> Result<(), String>,
) -> Result<Vec<N>, String> {
    walk_bounded(&mut node, root, &mut validate, &mut parent, &mut same,
        &mut budget, RETAINED_BYTES)
}

fn walk_bounded<N: Clone>(node: &mut N, root: &N,
    validate: &mut impl FnMut(&N) -> Result<(), String>,
    parent: &mut impl FnMut(&N) -> Result<N, String>,
    same: &mut impl FnMut(&N, &N) -> Result<bool, String>,
    budget: &mut impl FnMut() -> Result<(), String>, bytes: usize,
) -> Result<Vec<N>, String> {
    // Reserve four reference slots outside the vector: caller's root, current
    // node, Brent checkpoint, and a transient parent/clone during replacement.
    // This bounds retained reference storage, not the provider's object heaps.
    let limit = bytes.checked_div(std::mem::size_of::<N>().max(1))
        .and_then(|n| n.checked_sub(4)).ok_or(RESOURCE)?;
    let mut nodes = Vec::new();
    let mut checkpoint = node.clone();
    let (mut power, mut distance) = (1usize, 0usize);
    loop {
        budget()?;
        validate(node)?;
        budget()?;
        let reached = same(node, root)?;
        if nodes.len() == limit { return Err(RESOURCE.into()); }
        if nodes.len() == nodes.capacity() {
            let next = nodes.capacity().max(1).checked_mul(2).ok_or(RESOURCE)?.min(limit);
            let additional = next.checked_sub(nodes.len()).ok_or(RESOURCE)?;
            nodes.try_reserve_exact(additional).map_err(|_| RESOURCE)?;
            if nodes.capacity() > limit { return Err(RESOURCE.into()); }
        }
        nodes.push(node.clone());
        budget()?;
        if reached { return Ok(nodes); }
        *node = parent(node)?; // null/missing/provider failures must be errors
        budget()?;
        distance = distance.checked_add(1).ok_or(RESOURCE)?;
        // Brent uses one identity comparison per edge, not a quadratic scan of
        // retained COM interfaces and never a RuntimeID fallback.
        if same(node, &checkpoint)? { return Err("accessibility ancestry cycle".into()); }
        if distance == power {
            checkpoint = node.clone();
            power = power.checked_mul(2).ok_or(RESOURCE)?;
            distance = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn long_path_validates_before_labels() {
        let validated = Cell::new(0);
        let nodes = walk(0usize, &80, |n| {
            assert_eq!(*n, validated.get());
            validated.set(validated.get() + 1);
            Ok(())
        }, |n| Ok(n + 1), |a, b| Ok(a == b), || Ok(())).unwrap();
        let labels: Vec<_> = nodes.iter().map(|n| {
            assert_eq!(validated.get(), 81);
            *n
        }).collect();
        assert_eq!(labels, (0..=80).collect::<Vec<_>>());
    }

    #[test]
    fn cycles_refuse_linearly() {
        for (prefix, cycle) in [(0usize, 1usize), (0, 2), (0, 17), (19, 1), (19, 79)] {
            let calls = Cell::new(0);
            let result = walk(0usize, &usize::MAX, |_| Ok(()),
                |n| Ok(if *n + 1 == prefix + cycle { prefix } else { n + 1 }), |a, b| {
                    calls.set(calls.get() + 1);
                    Ok(a == b)
                }, || Ok(()));
            assert_eq!(result.unwrap_err(), "accessibility ancestry cycle");
            assert!(calls.get() <= 8 * (prefix + cycle));
        }
    }

    #[test]
    fn foreign_or_protected_ancestor_refuses_before_labels() {
        for failure in ["foreign owner", "protected", "disabled", "offscreen", "custom role"] {
            let labels = Cell::new(0);
            let result = walk(0usize, &40, |n| {
                if *n == 23 { Err(failure.into()) } else { Ok(()) }
            }, |n| Ok(n + 1), |a, b| Ok(a == b), || Ok(()));
            let described = result.map(|nodes| nodes.iter().for_each(|_| labels.set(labels.get() + 1)));
            assert_eq!(described.unwrap_err(), failure);
            assert_eq!(labels.get(), 0);
        }
    }

    #[test]
    fn missing_root_and_provider_failures_refuse() {
        for failure in ["root absent", "provider timeout"] {
            assert_eq!(walk(0usize, &40, |_| Ok(()),
                |n| if *n == 24 { Err(failure.into()) } else { Ok(n + 1) },
                |a, b| Ok(a == b), || Ok(())).unwrap_err(), failure);
        }
        assert!(walk(0usize, &40, |_| Ok(()), |n| Ok(n + 1),
            |_, _| Err("comparison failure".into()), || Ok(())).is_err());
        assert!(walk(0usize, &40, |_| Err("validation provider failure".into()),
            |n| Ok(n + 1), |a, b| Ok(a == b), || Ok(())).is_err());
    }

    #[test]
    fn exact_root_needs_no_parent_and_still_checks_final_budget() {
        assert_eq!(walk(7usize, &7, |_| Ok(()),
            |_| panic!("root must not request a parent"), |a, b| Ok(a == b),
            || Ok(())).unwrap(), vec![7]);
        let ticks = Cell::new(0);
        assert_eq!(walk(7usize, &7, |_| Ok(()),
            |_| panic!("root must not request a parent"), |a, b| Ok(a == b), || {
                ticks.set(ticks.get() + 1);
                if ticks.get() == 3 { Err("final budget".into()) } else { Ok(()) }
            }).unwrap_err(), "final budget");
    }

    #[test]
    fn budget_and_storage_exhaustion_refuse() {
        let ticks = Cell::new(0);
        assert_eq!(walk(0usize, &40, |_| Ok(()), |n| Ok(n + 1),
            |a, b| Ok(a == b), || {
                ticks.set(ticks.get() + 1);
                if ticks.get() > 12 { Err("budget".into()) } else { Ok(()) }
            }).unwrap_err(), "budget");
        for bytes in [0, 4 * std::mem::size_of::<usize>(), 128] {
            assert_eq!(walk_bounded(&mut 0usize, &40, &mut |_| Ok(()),
                &mut |n| Ok(n + 1), &mut |a, b| Ok(a == b), &mut || Ok(()), bytes)
                .unwrap_err(), RESOURCE);
        }
        let bytes = 20 * std::mem::size_of::<usize>();
        assert_eq!(walk_bounded(&mut 0usize, &15, &mut |_| Ok(()),
            &mut |n| Ok(n + 1), &mut |a, b| Ok(a == b), &mut || Ok(()), bytes)
            .unwrap().len(), 16);
    }
}
