import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

/** Whether the user hid the floating rose (S26.1); the choice is saved by the app. */
function loadRoseHidden(): Promise<boolean> {
	if (!isTauri()) return Promise.resolve(false);
	return invoke<boolean>("rose_hidden");
}

/** Hides or shows the rose; resolves with the resulting state. */
function setRoseHidden(hidden: boolean): Promise<boolean> {
	if (!isTauri()) return Promise.resolve(false);
	return invoke<boolean>("set_rose_hidden", { hidden });
}

/** The rose was hidden or shown, from the panel or the menu bar item. */
async function onRoseHidden(handler: (hidden: boolean) => void) {
	if (!isTauri()) return () => {};
	const { listen } = await import("@tauri-apps/api/event");
	return listen<{ hidden?: unknown }>("dot://rose", (event) => handler(event.payload?.hidden === true));
}

/** Fills the display's work area with the panel, or restores it (S26.2); resolves with the result. */
function setPanelFullscreen(on: boolean): Promise<boolean> {
	if (!isTauri()) return Promise.resolve(false);
	return invoke<boolean>("set_panel_fullscreen", { on });
}

/** What the panel header offers about its own window (S26), in the desktop panel only. */
export interface PanelWindowControls {
	roseHidden: boolean;
	setRoseHidden: (hidden: boolean) => void;
	fullscreen: boolean;
	setFullscreen: (on: boolean) => void;
}

/**
 * The rose's visibility as the app reports it, and the panel's full-screen state. The app does the
 * window work; this follows the state each command returns. `fullscreenNow` is read by key handlers.
 */
export function usePanelWindow(enabled: boolean) {
	const [roseHidden, setRose] = useState(false);
	const [fullscreen, setFull] = useState(false);
	const fullscreenNow = useRef(false);

	useEffect(() => {
		if (!enabled) return;
		let live = true;
		const update = (hidden: boolean) => {
			if (live) setRose(hidden);
		};
		loadRoseHidden().then(update, () => {});
		const unlisten = onRoseHidden(update);
		return () => {
			live = false;
			void unlisten.then((stop) => stop());
		};
	}, [enabled]);

	const hideRose = useCallback((hidden: boolean) => {
		setRoseHidden(hidden).then(setRose, () => {});
	}, []);
	const setFullscreen = useCallback((on: boolean) => {
		setPanelFullscreen(on).then(
			(result) => {
				fullscreenNow.current = result;
				setFull(result);
			},
			() => {},
		);
	}, []);

	const controls: PanelWindowControls = { roseHidden, setRoseHidden: hideRose, fullscreen, setFullscreen };
	return { controls, fullscreenNow };
}
