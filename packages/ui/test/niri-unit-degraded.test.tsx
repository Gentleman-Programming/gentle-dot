import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NiriUnitSnapshot } from "../src/desktop.ts";
import { initialState, type DotState } from "../src/store.ts";

/** Degraded shared unit: no assistant reachable, so the app renders its access-key status. */
const h = vi.hoisted(() => ({
	tauri: true,
	invoke: vi.fn(),
	listeners: new Map<string, (event: { payload: unknown }) => void>(),
	resolveGetter: (_value: unknown) => {},
	state: undefined as unknown as DotState,
}));

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => h.tauri,
	invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
		h.listeners.set(name, handler);
		return () => {
			h.listeners.delete(name);
		};
	},
}));

vi.mock("../src/desktop.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/desktop.ts")>()),
	onDesktopEvent: async () => () => {},
}));

vi.mock("../src/useDot.ts", () => ({
	useDot: () => ({ state: h.state, send: () => {}, dismiss: () => {}, dispatch: () => {} }),
}));

const unit = (over: Partial<NiriUnitSnapshot> = {}): NiriUnitSnapshot => ({
	enabled: true,
	open: false,
	roseHidden: false,
	fullscreen: false,
	revision: 1,
	...over,
});

async function renderPanel() {
	window.history.replaceState(null, "", "/?surface=panel");
	const { App } = await import("../src/App.tsx");
	return render(<App />);
}

const emitUnit = (snapshot: NiriUnitSnapshot) =>
	act(async () => {
		h.listeners.get("dot://unit")?.({ payload: snapshot });
	});
const waitSubscribed = () => waitFor(() => expect(h.listeners.has("dot://unit")).toBe(true));

beforeEach(() => {
	h.tauri = true;
	h.listeners.clear();
	h.state = { ...initialState, connection: "open", agentState: "idle" };
	h.invoke = vi.fn(async (command: string) => {
		switch (command) {
			// No assistant reachable: the app lands in its degraded access-key state.
			case "connection_info":
				throw "";
			case "niri_unit_state":
				return new Promise((resolve) => {
					h.resolveGetter = resolve as (value: unknown) => void;
				});
			case "niri_unit_ready":
				return true;
			case "computer_status":
				return { active: false };
			default:
				return null;
		}
	});
});

afterEach(() => {
	window.history.replaceState(null, "", "/");
});

describe("niri unit degraded state", () => {
	it("rose-only pose shows the rose while the chat pose keeps the access-key explanation", async () => {
		const { container } = await renderPanel();
		await waitSubscribed();
		await act(async () => {
			h.resolveGetter(unit({ open: false, revision: 1 }));
			await Promise.resolve();
		});
		// Rose-only: the 72x72 window is the rose, not clipped prose.
		await waitFor(() =>
			expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "rose"),
		);
		expect(screen.getByRole("button", { name: /Gentle Dot: / })).toBeInTheDocument();
		expect(container.querySelector(".niri-unit-panel")).toHaveAttribute("hidden");
		expect(screen.getByText(/needs your access key/)).toBeInTheDocument();

		// Chat pose: the degraded explanation stays visible exactly as today.
		await emitUnit(unit({ open: true, revision: 2 }));
		await waitFor(() =>
			expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "pair"),
		);
		expect(screen.getByText(/needs your access key/)).toBeVisible();
		expect(screen.getByRole("button", { name: /Gentle Dot: / })).toBeVisible();
	});
});
