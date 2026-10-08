import type { AgentState } from "@gentle-dot/protocol";
import { useRef } from "react";
import { Rose, type RoseMood } from "../rose/Rose.tsx";

const LABELS: Record<AgentState, string> = {
	starting: "starting",
	idle: "ready",
	thinking: "thinking",
	working: "working",
	needs_you: "needs your answer",
	restarting: "restarting",
	error: "unavailable",
};

const MOODS: Record<AgentState, RoseMood> = {
	starting: "restarting",
	idle: "idle",
	thinking: "thinking",
	working: "working",
	needs_you: "needs",
	restarting: "restarting",
	error: "offline",
};

const DRAG_THRESHOLD_PX = 3;

interface DotSurfaceProps {
	agentState: AgentState;
	connected: boolean;
	/** The assistant controls the Mac (S24.6); it shows over every other state. */
	inControl?: boolean;
	toggle: () => void;
	startDrag: () => void;
}

/** The collapsed, always-on-top rose in its black circle. A click opens the panel; a drag moves the window. */
export function DotSurface({ agentState, connected, inControl = false, toggle, startDrag }: DotSurfaceProps) {
	const press = useRef<{ x: number; y: number; dragging: boolean } | undefined>(undefined);
	const state = connected ? agentState : "restarting";

	return (
		<button
			type="button"
			className={`dot dot-${state}${inControl ? " dot-in_control" : ""}`}
			aria-label={`Gentle Dot: ${inControl ? "controlling your Mac" : LABELS[state]}`}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				press.current = { x: event.clientX, y: event.clientY, dragging: false };
			}}
			onPointerMove={(event) => {
				const p = press.current;
				if (!p || p.dragging) return;
				if (Math.hypot(event.clientX - p.x, event.clientY - p.y) > DRAG_THRESHOLD_PX) {
					p.dragging = true;
					startDrag();
				}
			}}
			onPointerUp={() => {
				const p = press.current;
				press.current = undefined;
				if (p && !p.dragging) toggle();
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					toggle();
				}
			}}
		>
			<span className="dot-disc" aria-hidden="true">
				<Rose mood={inControl ? "control" : MOODS[state]} />
			</span>
			{state === "needs_you" ? (
				<span className="dot-badge" aria-hidden="true">
					!
				</span>
			) : null}
		</button>
	);
}
