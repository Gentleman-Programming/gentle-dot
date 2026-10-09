import { useEffect, useState } from "react";
import { type ComputerState, computerEndpoint, computerStatus, onComputerState } from "./computer.ts";

/** The control session and yolo mode the app reports (desktop windows only). */
export function useComputerState(enabled: boolean): ComputerState {
	const [state, setState] = useState<ComputerState>({});
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		const update = (next: ComputerState) => {
			if (live) setState(next);
		};
		computerStatus().then(update, () => {});
		const unlisten = onComputerState(update);
		return () => {
			live = false;
			void unlisten.then((stop) => stop());
		};
	}, [enabled]);
	return state;
}

/**
 * Whether the app has a computer-control helper (S24.7). The app itself registers it with the daemon
 * it launched, over its private channel (L61); the window never sends its key.
 */
export function useComputerAvailable(enabled: boolean, connected: boolean): boolean {
	const [available, setAvailable] = useState(false);
	useEffect(() => {
		if (!enabled || !connected) return;
		let live = true;
		computerEndpoint().then(
			(endpoint) => {
				if (!live) return;
				setAvailable(endpoint !== null);
			},
			() => {
				if (live) setAvailable(false);
			},
		);
		return () => {
			live = false;
		};
	}, [enabled, connected]);
	return available;
}
