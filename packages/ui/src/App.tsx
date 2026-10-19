import type { ClientMessage } from "@gentle-dot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ConnectionInfo, tokenFromLocation } from "./client.ts";
import { ChatSurface } from "./components/ChatSurface.tsx";
import type { ComputerControls } from "./components/Computer.tsx";
import { DotSurface } from "./components/DotSurface.tsx";
import { GlowSurface } from "./components/GlowSurface.tsx";
import { NiriUnitSurface } from "./components/NiriUnitSurface.tsx";
import { computerPermissions, requestComputerPermission, setComputerYolo, stopComputer } from "./computer.ts";
import {
	connectionInfo,
	connectorCommand,
	hidePanel,
	inDesktop,
	niriUnitReady,
	onDesktopEvent,
	setDotState,
	startDragging,
	togglePanel,
} from "./desktop.ts";
import { createUploader } from "./uploads.ts";
import { useComputerAvailable, useComputerPlatform, useComputerState } from "./useComputer.ts";
import { useDot } from "./useDot.ts";
import { useNiriUnit } from "./useNiriUnit.ts";
import { usePanelWindow } from "./usePanelWindow.ts";

type Surface = "dot" | "panel" | "web";

function currentSurface(): Surface | "glow" {
	const surface = new URLSearchParams(window.location.search).get("surface");
	return surface === "dot" || surface === "panel" || surface === "glow" ? surface : "web";
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

/** ⌘⇧F (Ctrl+Shift+F off macOS) toggles the panel's full screen. */
function isFullscreenShortcut(event: KeyboardEvent): boolean {
	return (
		(event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f"
	);
}

/** The desktop's glow overlay (S28) is its own surface: it never connects to the assistant. */
export function App() {
	const surface = currentSurface();
	return surface === "glow" ? <GlowSurface /> : <Assistant surface={surface} />;
}

function Assistant({ surface }: { surface: Surface }) {
	const [info, setInfo] = useState<ConnectionInfo | undefined>(undefined);
	const [missingToken, setMissingToken] = useState(false);
	/** Why the desktop app could not reach its assistant, in the app's own words (S35.2). */
	const [unreachable, setUnreachable] = useState<string>();
	const [focusKey, setFocusKey] = useState(0);
	const { state, send, dismiss, dispatch } = useDot(info);
	// Files go to the daemon over HTTP, with the same access key as the WebSocket (S31.2).
	const upload = useMemo(() => (info ? createUploader(info) : undefined), [info]);
	const conversations = useRef(state.features.conversations);
	conversations.current = state.features.conversations;
	// Computer control lives in the desktop app only (S24.7); the panel registers the helper.
	const desktop = inDesktop();
	const { session: computerSession, yolo } = useComputerState(desktop && surface !== "web");
	const computerAvailable = useComputerAvailable(desktop && surface === "panel", state.connection === "open");
	const computerPlatform = useComputerPlatform(desktop && surface === "panel");
	// Connector changes go through the app, on behalf of this window (S25.2); the web page has none.
	const clientId = state.clientId;
	const appSend = useCallback(
		(message: ClientMessage) => {
			if (!clientId) return;
			connectorCommand(clientId, message).catch((error: unknown) =>
				dispatch({ type: "notice", level: "error", message: String(error) }),
			);
		},
		[clientId, dispatch],
	);
	// The panel's own window (S26): hide the rose, full screen.
	const panel = usePanelWindow(desktop && surface === "panel");
	// The dormant shared Niri unit (T10/T19): logical state only, no anchor. Disabled (including
	// off-desktop and every legacy route) renders exactly the existing App below.
	const unit = useNiriUnit(desktop && surface === "panel");
	// Command callbacks stay the shell's; the rendered rose/fullscreen state follows the snapshot.
	const panelWindow = unit.enabled
		? { ...panel.controls, roseHidden: unit.roseHidden, fullscreen: unit.fullscreen }
		: panel.controls;
	const fullscreenNow = panel.fullscreenNow;
	const setFullscreen = panel.controls.setFullscreen;
	const computer: ComputerControls | undefined =
		desktop && surface === "panel"
			? {
					available: computerAvailable,
					platform: computerPlatform,
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
			let live = true;
			const connect = () =>
				connectionInfo().then(
					(next) => {
						if (!live) return;
						// The same assistant keeps its connection; only a new one replaces it.
						setInfo((current) =>
							current?.url === next.url && current.token === next.token ? current : next,
						);
						setUnreachable(undefined);
						setMissingToken(false);
					},
					(error: unknown) => {
						if (!live) return;
						const reason = typeof error === "string" ? error : error instanceof Error ? error.message : "";
						if (reason) setUnreachable(reason);
						else setMissingToken(true);
					},
				);
			// A refused or timed-out window recovers without a reopen: the app reports its assistant
				// ready after Restart assistant, or after a start slower than `connection_info` waits (S35.2).
			const ready = onDesktopEvent("dot://assistant-ready", () => void connect());
			void connect();
			return () => {
				live = false;
				void ready.then((unlisten) => unlisten());
			};
		}
		const found = browserConnection();
		if (found) setInfo(found);
		else setMissingToken(true);
	}, []);

	useEffect(() => {
		// The standalone Dot reports itself; the shared unit reports from its panel instead,
		// since that Dot will be hidden once the single window activates.
		if (surface === "dot" || unit.enabled) setDotState(state.agentState);
	}, [surface, state.agentState, unit.enabled]);

	// Render-ready handshake (T10/T19): after the shared wrapper DOM commits for the live
	// enabled revision — never inside the event receiver/getter. Stale pending acks are
	// cancelled on revision change/unmount, so nothing late is ever acknowledged.
	useEffect(() => {
		if (!unit.enabled) return;
		const revision = unit.revision;
		let cancelled = false;
		let settled = false;
		let frame: ReturnType<typeof requestAnimationFrame> | undefined;
		let backup: ReturnType<typeof setTimeout> | undefined;
		const send = () => {
			if (settled || cancelled) return;
			settled = true;
			if (frame !== undefined) cancelAnimationFrame(frame);
			if (backup !== undefined) clearTimeout(backup);
			try {
				void niriUnitReady(revision).catch(() => {});
			} catch {
				// Legacy bridge without the handshake: stay silent, never throw.
			}
		};
		if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(send);
		// Backup for surfaces where the frame never lands; the once-guard keeps one ack.
		backup = setTimeout(send, 50);
		return () => {
			cancelled = true;
			if (frame !== undefined) cancelAnimationFrame(frame);
			if (backup !== undefined) clearTimeout(backup);
		};
	}, [unit.enabled, unit.revision]);

	useEffect(() => {
		if (surface !== "panel") return;
		const subscriptions = [
			// The menu bar item starts a new chat only when the conversations list is on.
			onDesktopEvent("dot://new-conversation", () => {
				if (conversations.current) send({ type: "new_conversation" });
			}),
			onDesktopEvent("dot://panel-shown", () => setFocusKey((k) => k + 1)),
		];
		// Esc, in order: whatever inside the panel already handled it (it called preventDefault),
		// then leaving full screen, then hiding the panel.
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.key === "Escape") {
				if (fullscreenNow.current) setFullscreen(false);
				else hidePanel();
				return;
			}
			if (isFullscreenShortcut(event)) {
				event.preventDefault();
				setFullscreen(!fullscreenNow.current);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			for (const s of subscriptions) void s.then((unlisten) => unlisten());
		};
	}, [surface, send, fullscreenNow, setFullscreen]);

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
	if (unreachable !== undefined || missingToken) {
		const degraded = (
			<div className="chat chat-web">
				<div className="status" role="status">
					{unreachable ??
						"This page needs your access key. Open it from the Gentle Dot menu (Open in browser)."}
				</div>
			</div>
		);
		// The shared unit still owns the one window while degraded: the rose-only pose keeps
		// its rose (a 72x72 window of clipped prose is unreachable prose), and the chat pose
		// keeps this explanation visible in the panel slot. Disabled renders as before.
		return unit.enabled ? (
			<NiriUnitSurface
				open={unit.open}
				roseHidden={unit.roseHidden}
				fullscreen={unit.fullscreen}
				revision={unit.revision}
				agentState={state.agentState}
				connected={state.connection === "open"}
				inControl={computerSession !== undefined}
				yolo={yolo !== undefined}
				onTogglePanel={togglePanel}
				onStartDrag={() => void startDragging()}
			>
				{degraded}
			</NiriUnitSurface>
		) : (
			degraded
		);
	}
	const chat = (
		<ChatSurface
			variant={surface === "panel" ? "panel" : "web"}
			state={state}
			send={send}
			dismiss={dismiss}
			dispatch={dispatch}
			focusKey={focusKey}
			{...(surface === "panel" ? { onHide: hidePanel } : {})}
			{...(desktop && surface === "panel" ? { appSend } : {})}
			{...(computer ? { computer } : {})}
			{...(desktop && surface === "panel" ? { voiceModel: true } : {})}
			{...(desktop && surface === "panel" ? { panelWindow } : {})}
			{...(desktop && surface === "panel" ? { settings: true } : {})}
			{...(upload ? { upload } : {})}
		/>
	);
	// The shared unit owns the one window around the same chat element: one connection, and
	// open/mode changes never remount it. Dormant while the backend serves disabled.
	return unit.enabled ? (
		<NiriUnitSurface
			open={unit.open}
			roseHidden={unit.roseHidden}
			fullscreen={unit.fullscreen}
			revision={unit.revision}
			agentState={state.agentState}
			connected={state.connection === "open"}
			inControl={computerSession !== undefined}
			yolo={yolo !== undefined}
			onTogglePanel={togglePanel}
			onStartDrag={() => void startDragging()}
		>
			{chat}
		</NiriUnitSurface>
	) : (
		chat
	);
}
