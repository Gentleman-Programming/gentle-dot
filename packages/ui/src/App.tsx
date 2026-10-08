import { useEffect, useRef, useState } from "react";
import { type ConnectionInfo, tokenFromLocation } from "./client.ts";
import { ChatSurface } from "./components/ChatSurface.tsx";
import type { ComputerControls } from "./components/Computer.tsx";
import { DotSurface } from "./components/DotSurface.tsx";
import { computerPermissions, requestComputerPermission, setComputerYolo, stopComputer } from "./computer.ts";
import {
	connectionInfo,
	hidePanel,
	inDesktop,
	onDesktopEvent,
	setDotState,
	startDragging,
	togglePanel,
} from "./desktop.ts";
import { useComputerRegistration, useComputerState } from "./useComputer.ts";
import { useDot } from "./useDot.ts";

type Surface = "dot" | "panel" | "web";

function currentSurface(): Surface {
	const surface = new URLSearchParams(window.location.search).get("surface");
	return surface === "dot" || surface === "panel" ? surface : "web";
}

/**
 * Whether the window behind the panel blurs the desktop (macOS vibrancy). The shell adds
 * `effects=none` to the panel URL where it cannot (Linux), and the panel paints its own background.
 */
export function windowEffects(search: string): "native" | "none" {
	return new URLSearchParams(search).get("effects") === "none" ? "none" : "native";
}

function browserConnection(): ConnectionInfo | undefined {
	const token = tokenFromLocation(window.location, window.sessionStorage, (url) =>
		window.history.replaceState(null, "", url),
	);
	if (!token) return undefined;
	const daemon = import.meta.env.VITE_DAEMON_ORIGIN as string | undefined;
	const base = daemon ? new URL(daemon) : window.location;
	const protocol = base.protocol === "https:" ? "wss:" : "ws:";
	return { url: `${protocol}//${base.host}/ws`, token };
}

export function App() {
	const surface = currentSurface();
	const [info, setInfo] = useState<ConnectionInfo | undefined>(undefined);
	const [missingToken, setMissingToken] = useState(false);
	const [focusKey, setFocusKey] = useState(0);
	const { state, send, dismiss, dispatch } = useDot(info);
	const conversations = useRef(state.features.conversations);
	conversations.current = state.features.conversations;
	// Computer control lives in the desktop app only (S24.7); the panel registers the helper.
	const desktop = inDesktop();
	const { session: computerSession, yolo } = useComputerState(desktop && surface !== "web");
	const computerAvailable = useComputerRegistration(
		desktop && surface === "panel",
		state.connection === "open",
		send,
	);
	const computer: ComputerControls | undefined =
		desktop && surface === "panel"
			? {
					available: computerAvailable,
					...(computerSession ? { session: computerSession } : {}),
					...(yolo ? { yolo } : {}),
					stop: stopComputer,
					setYolo: setComputerYolo,
					permissions: computerPermissions,
					requestPermission: requestComputerPermission,
				}
			: undefined;

	useEffect(() => {
		if (inDesktop()) {
			connectionInfo().then(setInfo, () => setMissingToken(true));
			return;
		}
		const found = browserConnection();
		if (found) setInfo(found);
		else setMissingToken(true);
	}, []);

	useEffect(() => {
		if (surface === "dot") setDotState(state.agentState);
	}, [surface, state.agentState]);

	useEffect(() => {
		if (surface !== "panel") return;
		const subscriptions = [
			// The menu bar item starts a new chat only when the conversations list is on.
			onDesktopEvent("dot://new-conversation", () => {
				if (conversations.current) send({ type: "new_conversation" });
			}),
			onDesktopEvent("dot://panel-shown", () => setFocusKey((k) => k + 1)),
		];
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") hidePanel();
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			for (const s of subscriptions) void s.then((unlisten) => unlisten());
		};
	}, [surface, send]);

	useEffect(() => {
		document.documentElement.dataset.surface = surface;
		document.documentElement.dataset.effects = windowEffects(window.location.search);
	}, [surface]);

	if (surface === "dot") {
		return (
			<DotSurface
				agentState={state.agentState}
				connected={state.connection === "open"}
				inControl={computerSession !== undefined}
				yolo={yolo !== undefined}
				toggle={togglePanel}
				startDrag={() => void startDragging()}
			/>
		);
	}
	if (missingToken) {
		return (
			<div className="chat chat-web">
				<div className="status" role="status">
					This page needs your access key. Open it from the Gentle Dot menu (Open in browser).
				</div>
			</div>
		);
	}
	return (
		<ChatSurface
			variant={surface === "panel" ? "panel" : "web"}
			state={state}
			send={send}
			dismiss={dismiss}
			dispatch={dispatch}
			focusKey={focusKey}
			{...(surface === "panel" ? { onHide: hidePanel } : {})}
			{...(computer ? { computer } : {})}
		/>
	);
}
