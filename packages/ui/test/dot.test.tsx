import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DotSurface } from "../src/components/DotSurface.tsx";

function setup(agentState: Parameters<typeof DotSurface>[0]["agentState"] = "idle") {
	const toggle = vi.fn();
	const startDrag = vi.fn();
	render(<DotSurface agentState={agentState} connected toggle={toggle} startDrag={startDrag} />);
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
		expect(screen.getByText("!")).toBeInTheDocument();
	});
});
