import type { AgentState } from "@gentle-dot/protocol";
import type { ReactNode } from "react";
import { DotSurface } from "./DotSurface.tsx";

export type NiriUnitMode = "rose" | "panel" | "pair" | "fullscreen" | "empty";

export interface NiriUnitSurfaceProps {
	/** The compact chat is open (or fullscreen, which implies it). */
	open: boolean;
	/** The user's saved rose preference; fullscreen always hides the rose without changing it. */
	roseHidden: boolean;
	fullscreen: boolean;
	/** Shell intent generation, observed only: the native compact anchor stays the sole owner.
	    Dormant until bootstrap/worker integration; never remounts the chat children. */
	revision?: number;
	agentState: AgentState;
	connected: boolean;
	/** The assistant controls the Mac (S24.6); it shows over every other state. */
	inControl?: boolean;
	/** Yolo mode is on (S24.9). */
	yolo?: boolean;
	/** Clicking the rose opens/closes the panel; the shell owns the window. */
	onTogglePanel: () => void;
	/** Dragging the rose moves the ONE owning window; the chat header drag-region moves it too. */
	onStartDrag: () => void;
	/** The real ChatSurface, supplied by the caller so toggles never remount it. */
	children: ReactNode;
}

/**
 * The Niri-only shared surface (T10/T12/T19): the existing DotSurface plus the supplied chat
 * children inside ONE window, so moving either moves both with no follow animation. Fullscreen
 * hides the rose without touching the saved preference; a closed panel keeps the rose when
 * wanted; both hidden renders empty and the shell hides the window. No App hookup yet: these
 * props are the next unit interface the shell will drive.
 */
export function NiriUnitSurface({
	open,
	roseHidden,
	fullscreen,
	revision = 0,
	agentState,
	connected,
	inControl = false,
	yolo = false,
	onTogglePanel,
	onStartDrag,
	children,
}: NiriUnitSurfaceProps) {
	const showPanel = open || fullscreen;
	// Fullscreen hides the rose even when the preference says shown (S5); leaving fullscreen
	// restores it because the preference itself never changes here.
	const showRose = !roseHidden && !fullscreen;
	const mode: NiriUnitMode = fullscreen
		? "fullscreen"
		: showPanel && showRose
			? "pair"
			: showPanel
				? "panel"
				: showRose
					? "rose"
					: "empty";

	return (
		<div className={`niri-unit niri-unit-${mode}`} data-mode={mode} data-revision={revision}>
			{/* Always mounted: hiding (not unmounting) keeps Settings/input state across toggles.
			    inert backs hidden so a closed panel never takes focus even without layout CSS. */}
			<div
				className="niri-unit-panel"
				hidden={!showPanel}
				inert={!showPanel}
				data-testid="niri-panel-slot"
			>
				{children}
			</div>
			{showRose ? (
				<div className="niri-unit-rose">
					<DotSurface
						agentState={agentState}
						connected={connected}
						inControl={inControl}
						yolo={yolo}
						toggle={onTogglePanel}
						startDrag={onStartDrag}
					/>
				</div>
			) : null}
		</div>
	);
}
