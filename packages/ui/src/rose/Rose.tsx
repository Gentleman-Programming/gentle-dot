import type { CSSProperties } from "react";
import { ROSE_SPARKLES, ROSE_STROKES, ROSE_VIEWBOX } from "./strokes.ts";

/** How the rose looks (design sheet `docs/brand/rose-design.html`). */
export type RoseMood = "idle" | "thinking" | "working" | "needs" | "restarting" | "offline";

/**
 * Strokes that carry the traveling light. In the 64 px Dot one screen pixel is
 * about 13 source pixels, so only the 60 longest strokes (50 source px and up,
 * 57% of the drawing) are long enough to show a moving light; the rest would
 * flicker as dots. The outline always draws all 178 strokes, which stay static.
 */
export const DOT_LIGHT_STROKES = 60;

const outline = ROSE_STROKES.map(({ d }) => <path key={d} d={d} />);

const lights = ROSE_STROKES.slice(0, DOT_LIGHT_STROKES).map(({ d, length }, i) => {
	// Longer strokes take longer to travel, so the light moves at a similar speed everywhere.
	const duration = Math.min(4.2, Math.max(1.1, length / 120)).toFixed(2);
	const style = { "--i": i, "--d": `${duration}s` } as CSSProperties;
	return <path key={d} d={d} pathLength={1} style={style} />;
});

const sparkles = ROSE_SPARKLES.map(([cx, cy, r], i) => (
	<circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} style={{ "--i": i } as CSSProperties} />
));

/**
 * The neon rose: a glowing outline, a light layer, and sparkles, stacked as
 * three inline SVGs. Each layer is its own SVG root because WebKit (the macOS
 * webview) ignores CSS filters on elements inside an SVG, so the glow must
 * sit on an outer `<svg>` box.
 */
export function Rose({ mood }: { mood: RoseMood }) {
	return (
		<span className={`rose rose-${mood}`} aria-hidden="true">
			<svg className="rose-base" viewBox={ROSE_VIEWBOX} aria-hidden="true" focusable="false">
				{outline}
			</svg>
			<svg className="rose-light" viewBox={ROSE_VIEWBOX} aria-hidden="true" focusable="false">
				{lights}
			</svg>
			<svg className="rose-sparkles" viewBox={ROSE_VIEWBOX} aria-hidden="true" focusable="false">
				{sparkles}
			</svg>
		</span>
	);
}
