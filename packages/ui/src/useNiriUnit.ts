import { useEffect, useState } from "react";
import { inDesktop, niriUnitState, onNiriUnit, type NiriUnitSnapshot } from "./desktop.ts";

const DISABLED: NiriUnitSnapshot = {
	enabled: false,
	open: false,
	roseHidden: false,
	fullscreen: false,
	revision: 0,
};

/** Malformed payloads (older shells, stray events) never reach state; the unit stays put. */
function isSnapshot(value: unknown): value is NiriUnitSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.enabled === "boolean" &&
		typeof v.open === "boolean" &&
		typeof v.roseHidden === "boolean" &&
		typeof v.fullscreen === "boolean" &&
		typeof v.revision === "number"
	);
}

/**
 * The shared-unit snapshot (T10/T12/T19): subscribes to `dot://unit` BEFORE reading the
 * `niri_unit_state` getter so no transition is missed. A late getter response never overwrites a
 * newer event, and stale (older-or-equal revision) events are ignored. The payload is logical
 * state only — no anchor ever reaches the UI. Off-desktop (or inactive) never invokes anything
 * and reads fully disabled, leaving the existing App routes untouched.
 */
export function useNiriUnit(active: boolean): NiriUnitSnapshot {
	const [snapshot, setSnapshot] = useState<NiriUnitSnapshot>(DISABLED);

	useEffect(() => {
		if (!active || !inDesktop()) return;
		let live = true;
		// Highest revision committed so far; anything at or below it is stale.
		let latest = -1;
		const commit = (next: NiriUnitSnapshot) => {
			if (!live || !isSnapshot(next) || next.revision <= latest) return;
			latest = next.revision;
			setSnapshot(next);
		};
		let stop: Promise<() => void>;
		try {
			// The bridge may be absent (legacy shell or fixed-shape mocks): stay disabled.
			stop = onNiriUnit(commit);
			void niriUnitState().then(commit, () => {});
		} catch {
			return;
		}
		return () => {
			live = false;
			// The subscription may register after unmount; cut it the moment it lands.
			void stop.then((unlisten) => unlisten());
		};
	}, [active]);

	return active ? snapshot : DISABLED;
}
