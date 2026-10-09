import type { ClientMessage } from "@gentle-dot/protocol";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { type ConnectionInfo, DotClient } from "./client.ts";
import { initialState, reduce } from "./store.ts";

/** Connects to the daemon once `info` is known and exposes the reduced state. */
export function useDot(info: ConnectionInfo | undefined) {
	const [state, dispatch] = useReducer(reduce, initialState);
	const client = useRef<DotClient | undefined>(undefined);

	useEffect(() => {
		if (!info) return;
		const c = new DotClient(info, {
			onStatus: (status) => dispatch({ type: "connection", status }),
			onMessage: (message) => dispatch({ type: "server", message }),
		});
		client.current = c;
		c.start();
		return () => c.stop();
	}, [info]);

	const send = useCallback((message: ClientMessage) => {
		if (!client.current?.send(message)) {
			dispatch({
				type: "server",
				message: {
					type: "error",
					code: "offline",
					message: "Not connected yet. Try again in a moment.",
					seq: 0,
				},
			});
		}
	}, []);
	const dismiss = useCallback((id: number) => dispatch({ type: "dismiss", id }), []);

	return { state, send, dismiss, dispatch };
}
