import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";

const connected: DotState = { ...initialState, connection: "open", agentState: "idle" };
const withOverlay = (overlay: "accounts" | "profiles" | "connectors"): DotState =>
	reduce(connected, { type: overlay, open: true });

function renderChat(state: DotState) {
	const dispatch = vi.fn();
	const { container } = render(
		<ChatSurface
			variant="panel"
			state={state}
			settings
			send={vi.fn()}
			dismiss={vi.fn()}
			dispatch={dispatch}
			onHide={vi.fn()}
		/>,
	);
	const surface = container.querySelector<HTMLElement>(".chat");
	if (!surface) throw new Error("no chat surface");
	return { surface, dispatch };
}

describe("Esc in the chat", () => {
	it("closes the accounts overlay like its own ×", () => {
		const { dispatch } = renderChat(withOverlay("accounts"));
		const handled = fireEvent.keyDown(screen.getByLabelText("Close accounts").closest("main") as Element, {
			key: "Escape",
		});
		expect(dispatch).toHaveBeenCalledWith({ type: "accounts", open: false });
		// Handled here, so the app does not hide the panel (App.tsx checks defaultPrevented).
		expect(handled).toBe(false);
	});

	it("closes the profiles and connectors overlays the same way", () => {
		for (const overlay of ["profiles", "connectors"] as const) {
			const { dispatch } = renderChat(withOverlay(overlay));
			const label = overlay === "profiles" ? "Close profiles" : "Close connectors";
			fireEvent.keyDown(screen.getByLabelText(label).closest("main") as Element, { key: "Escape" });
			expect(dispatch).toHaveBeenCalledWith({ type: overlay, open: false });
		}
	});

	it("closes the settings overlay like its own ×", () => {
		const { surface, dispatch } = renderChat(connected);
		fireEvent.click(screen.getByRole("button", { name: "Settings" }));
		expect(screen.getByRole("region", { name: "Settings" })).toBeInTheDocument();
		const handled = fireEvent.keyDown(surface, { key: "Escape" });
		expect(screen.queryByRole("region", { name: "Settings" })).not.toBeInTheDocument();
		expect(dispatch).not.toHaveBeenCalled();
		expect(handled).toBe(false);
	});

	it("leaves Esc alone when no overlay is open, so the app keeps its own order", () => {
		const { surface, dispatch } = renderChat(connected);
		const handled = fireEvent.keyDown(surface, { key: "Escape" });
		expect(dispatch).not.toHaveBeenCalled();
		expect(handled).toBe(true);
	});

	it("leaves an Escape another control already handled", () => {
		const { surface, dispatch } = renderChat(withOverlay("accounts"));
		// Stands in for the model picker, which cancels itself on Esc before the surface sees it.
		surface.addEventListener("keydown", (event) => event.preventDefault(), { capture: true });
		const handled = fireEvent.keyDown(surface, { key: "Escape" });
		expect(dispatch).not.toHaveBeenCalled();
		expect(handled).toBe(false);
	});
});
