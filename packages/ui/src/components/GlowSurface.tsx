import { type CSSProperties, useEffect, useRef, useState } from "react";
import { type ComputerGlow, onComputerGlow, onComputerState } from "../computer.ts";

/** The glow stays lit this long after the last action, then fades for `FADE_MS` (about 1.5 s in all). */
const HOLD_MS = 1200;
const FADE_MS = 300;
/** Older marks drop off so a long run of actions never piles up. */
const MAX_MARKS = 6;

interface Lit {
	id: number;
	glow: ComputerGlow;
}

function prefersReducedMotion(): boolean {
	return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

const px = (value: number) => `${value}px`;

function Mark({ glow, still }: { glow: ComputerGlow; still: boolean }) {
	if (glow.kind === "key") {
		const frame: CSSProperties = {
			left: px(glow.x),
			top: px(glow.y),
			width: px(glow.width),
			height: px(glow.height),
		};
		return <span className="glow-mark glow-key" style={frame} />;
	}
	if (glow.kind === "drag") {
		const end = <span className="glow-mark glow-drag" style={{ left: px(glow.toX), top: px(glow.toY) }} />;
		if (still) return end;
		const length = Math.hypot(glow.toX - glow.x, glow.toY - glow.y);
		const angle = Math.atan2(glow.toY - glow.y, glow.toX - glow.x);
		const trail: CSSProperties = {
			left: px(glow.x),
			top: px(glow.y),
			width: px(length),
			transform: `rotate(${angle}rad)`,
		};
		return (
			<>
				<span className="glow-trail" style={trail} />
				{end}
			</>
		);
	}
	return <span className={`glow-mark glow-${glow.kind}`} style={{ left: px(glow.x), top: px(glow.y) }} />;
}

/**
 * The click-through overlay where the agent acts (S28): a pink pulse on a click, a trail along a
 * drag, short markers for moves and scrolls, and an outline around the focused element for keys.
 * It shows only while the agent acts, fades out about 1.5 s after the last action, and clears at
 * once when the session ends. With reduced motion the glow is static: no pulse and no trail.
 */
export function GlowSurface() {
	const [marks, setMarks] = useState<Lit[]>([]);
	const [fading, setFading] = useState(false);
	const [still] = useState(prefersReducedMotion);
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
	const ended = useRef(false);
	const next = useRef(0);

	useEffect(() => {
		document.documentElement.dataset.surface = "glow";
		let live = true;
		const stopTimers = () => {
			for (const timer of timers.current) clearTimeout(timer);
			timers.current = [];
		};
		const clear = () => {
			stopTimers();
			setFading(false);
			setMarks([]);
		};
		const show = (glow: ComputerGlow) => {
			// A mark that arrives after Stop, panic, or the timeout stays dark.
			if (!live || ended.current) return;
			stopTimers();
			setFading(false);
			next.current += 1;
			const lit = { id: next.current, glow };
			setMarks((current) => [...current, lit].slice(-MAX_MARKS));
			timers.current = [
				setTimeout(() => setFading(true), HOLD_MS),
				setTimeout(() => setMarks([]), HOLD_MS + FADE_MS),
			];
		};
		const subscriptions = [
			onComputerGlow(show),
			onComputerState((state) => {
				ended.current = state.session === undefined;
				if (live && ended.current) clear();
			}),
		];
		return () => {
			live = false;
			stopTimers();
			for (const s of subscriptions) void s.then((unlisten) => unlisten());
		};
	}, []);

	const className = `glow-layer${fading ? " glow-fading" : ""}${still ? " glow-static" : ""}`;
	return (
		<div className={className} aria-hidden="true">
			{marks.map(({ id, glow }) => (
				<Mark key={id} glow={glow} still={still} />
			))}
		</div>
	);
}
