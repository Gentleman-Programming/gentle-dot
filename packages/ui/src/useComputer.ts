import type { ClientMessage } from "@gentle-dot/protocol";
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
 * Registers the app's helper with the daemon on every connection (S24.7); the daemon drops it when
 * this window disconnects. True when the app has a helper. The key is passed on, never kept.
 */
export function useComputerRegistration(
	enabled: boolean,
	connected: boolean,
	send: (message: ClientMessage) => void,
): boolean {
	const [available, setAvailable] = useState(false);
	useEffect(() => {
		if (!enabled || !connected) return;
		let live = true;
		computerEndpoint().then(
			(endpoint) => {
				if (!live) return;
				setAvailable(endpoint !== null);
				if (endpoint) send({ type: "computer_register", url: endpoint.url, token: endpoint.token });
			},
			() => {
				if (live) setAvailable(false);
			},
		);
		return () => {
			live = false;
		};
	}, [enabled, connected, send]);
	return available;
}
