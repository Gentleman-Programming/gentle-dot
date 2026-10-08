import { useEffect, useState } from "react";
import { type ConnectionInfo, tokenFromLocation } from "./client.ts";
import { ChatSurface } from "./components/ChatSurface.tsx";
import { DotSurface } from "./components/DotSurface.tsx";
import {
	connectionInfo,
	hidePanel,
	inDesktop,
	onDesktopEvent,
	setDotState,
	startDragging,
	togglePanel,
} from "./desktop.ts";
import { useDot } from "./useDot.ts";

type Surface = "dot" | "panel" | "web";

function currentSurface(): Surface {
	const surface = new URLSearchParams(window.location.search).get("surface");
	return surface === "dot" || surface === "panel" ? surface : "web";
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
	const { state, send, dismiss } = useDot(info);

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
			onDesktopEvent("dot://new-conversation", () => send({ type: "new_conversation" })),
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
	}, [surface]);

	if (surface === "dot") {
		return (
			<DotSurface
				agentState={state.agentState}
				connected={state.connection === "open"}
				toggle={togglePanel}
				startDrag={() => void startDragging()}
			/>
		);
	}
	if (missingToken) {
		return (
			<div className="chat chat-web">
				<div className="status" role="status">
					Open the link the assistant printed when it started; it includes your access key.
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
			focusKey={focusKey}
			{...(surface === "panel" ? { onHide: hidePanel } : {})}
		/>
	);
}
