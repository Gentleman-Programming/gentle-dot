import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentState } from "@gentle-dot/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DotSurface } from "../src/components/DotSurface.tsx";
import { DOT_LIGHT_STROKES, ROSE_DISC_VIEWBOX } from "../src/rose/Rose.tsx";
import { ROSE_SPARKLES, ROSE_STROKES } from "../src/rose/strokes.ts";

function setup(agentState: AgentState = "idle", connected = true) {
	const toggle = vi.fn();
	const startDrag = vi.fn();
	render(<DotSurface agentState={agentState} connected={connected} toggle={toggle} startDrag={startDrag} />);
	return { toggle, startDrag, dot: screen.getByRole("button") };
}

describe("DotSurface", () => {
	it("opens the panel on click", () => {
		const { toggle, startDrag, dot } = setup();
		fireEvent.pointerDown(dot, { clientX: 10, clientY: 10, button: 0 });
		fireEvent.pointerUp(dot, { clientX: 11, clientY: 10, button: 0 });
		expect(toggle).toHaveBeenCalledTimes(1);
		expect(startDrag).not.toHaveBeenCalled();
	});

	it("drags instead of opening when the pointer moves", () => {
		const { toggle, startDrag, dot } = setup();
		fireEvent.pointerDown(dot, { clientX: 10, clientY: 10, button: 0 });
		fireEvent.pointerMove(dot, { clientX: 20, clientY: 18, button: 0 });
		fireEvent.pointerUp(dot, { clientX: 20, clientY: 18, button: 0 });
		expect(startDrag).toHaveBeenCalledTimes(1);
		expect(toggle).not.toHaveBeenCalled();
	});

	it("opens from the keyboard", () => {
		const { toggle, dot } = setup();
		fireEvent.keyDown(dot, { key: "Enter" });
		expect(toggle).toHaveBeenCalledTimes(1);
	});

	it("shows the state and a badge when the assistant needs the user", () => {
		const { dot } = setup("needs_you");
		expect(dot).toHaveAccessibleName("Gentle Dot: needs your answer");
		expect(dot).toHaveClass("dot-needs_you");
		// The badge sits on the circle's edge, outside the disc.
		expect(dot.querySelector(":scope > .dot-badge")).toHaveTextContent("!");
	});

	it("is the glowing rose inside a black disc", () => {
		const { dot } = setup();
		const rose = dot.querySelector(":scope > .dot-disc > .rose");
		expect(rose).not.toBeNull();
		expect(dot.querySelector(".dot-disc")).toHaveAttribute("aria-hidden", "true");
		expect(rose).toHaveAttribute("aria-hidden", "true");

		// Three stacked SVG layers, each with its own glow (see Rose.tsx), framed for the disc.
		const layers = [...(rose?.querySelectorAll(":scope > svg") ?? [])];
		expect(layers.map((svg) => svg.getAttribute("class"))).toEqual([
			"rose-base",
			"rose-light",
			"rose-sparkles",
		]);
		for (const svg of layers) expect(svg).toHaveAttribute("viewBox", ROSE_DISC_VIEWBOX);
		const base = [...(rose?.querySelectorAll(".rose-base path") ?? [])];
		const light = [...(rose?.querySelectorAll(".rose-light path") ?? [])];
		expect(base).toHaveLength(ROSE_STROKES.length);
		expect(light).toHaveLength(DOT_LIGHT_STROKES);
		// The light runs along the longest strokes, each normalized for dash animation.
		light.forEach((path, i) => {
			expect(path).toHaveAttribute("d", ROSE_STROKES[i]?.d);
			expect(path).toHaveAttribute("pathLength", "1");
		});
		expect(rose?.querySelectorAll(".rose-sparkles circle")).toHaveLength(ROSE_SPARKLES.length);
	});

	it("frames the whole rose inside the circle", () => {
		const [x, y, width, height] = ROSE_DISC_VIEWBOX.split(" ").map(Number) as [
			number,
			number,
			number,
			number,
		];
		expect(width).toBe(height);
		const [cx, cy, radius] = [x + width / 2, y + height / 2, width / 2];
		const points = ROSE_STROKES.flatMap(({ d }) =>
			[...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2]), 0]),
		);
		for (const [px, py, r] of [...points, ...ROSE_SPARKLES]) {
			expect(Math.hypot(px - cx, py - cy) + r).toBeLessThan(radius);
		}
	});

	it("keeps the Dot surface the same size as its window", () => {
		const read = (relative: string) =>
			readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
		const rule = read("../src/styles.css").match(/\n\.dot \{([^}]*)\}/)?.[1] ?? "";
		const window = read("../../../apps/desktop/src-tauri/src/shell.rs").match(
			/const DOT_SIZE: \(f64, f64\) = \(([\d.]+), ([\d.]+)\)/,
		);
		expect(window?.slice(1).map(Number)).toEqual([72, 72]);
		expect(rule).toMatch(/\twidth: 72px;/);
		expect(rule).toMatch(/\theight: 72px;/);
	});

	it.each<[AgentState, string, string]>([
		["starting", "rose-restarting", "starting"],
		["idle", "rose-idle", "ready"],
		["thinking", "rose-thinking", "thinking"],
		["working", "rose-working", "working"],
		["needs_you", "rose-needs", "needs your answer"],
		["restarting", "rose-restarting", "restarting"],
		["error", "rose-offline", "unavailable"],
	])("renders %s as %s", (state, mood, label) => {
		const { dot } = setup(state);
		expect(dot).toHaveAccessibleName(`Gentle Dot: ${label}`);
		expect(dot).toHaveClass(`dot-${state}`);
		expect(dot.querySelector(".rose")).toHaveClass(mood);
		if (state !== "needs_you") expect(screen.queryByText("!")).toBeNull();
	});

	it("shows a restarting rose while disconnected", () => {
		const { dot } = setup("working", false);
		expect(dot).toHaveAccessibleName("Gentle Dot: restarting");
		expect(dot.querySelector(".rose")).toHaveClass("rose-restarting");
	});
});
