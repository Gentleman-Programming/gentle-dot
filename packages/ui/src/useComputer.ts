import type { ClientMessage } from "@gentle-dot/protocol";
import { useEffect, useState } from "react";
import { type ComputerSession, computerEndpoint, computerStatus, onComputerState } from "./computer.ts";

/** The control session the app reports, while one is active (desktop windows only). */
export function useComputerSession(enabled: boolean): ComputerSession | undefined {
	const [session, setSession] = useState<ComputerSession | undefined>(undefined);
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		const update = (next: ComputerSession | undefined) => {
			if (live) setSession(next);
		};
		computerStatus().then(update, () => {});
		const unlisten = onComputerState(update);
		return () => {
			live = false;
			void unlisten.then((stop) => stop());
		};
	}, [enabled]);
	return session;
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
