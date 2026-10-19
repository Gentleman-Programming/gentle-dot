import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NiriUnitSnapshot } from "../src/desktop.ts";
import { initialState, type DotState } from "../src/store.ts";

/** Bridge the dormant shared unit (T10/T12/T19): getter plus dot://unit, through the panel. */
const h = vi.hoisted(() => ({
	tauri: true,
	roseHidden: false,
	fullscreen: false,
	computer: { active: false } as unknown,
	invoke: vi.fn(),
	listeners: new Map<string, (event: { payload: unknown }) => void>(),
	unlistened: [] as string[],
	listenImpl: null as null | ((name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>),
	resolveGetter: (_value: unknown) => {},
	state: undefined as unknown as DotState,
}));

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => h.tauri,
	invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
		if (h.listenImpl) return h.listenImpl(name, handler);
		h.listeners.set(name, handler);
		return () => {
			h.unlistened.push(name);
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
	open: true,
	roseHidden: false,
	fullscreen: false,
	revision: 1,
	...over,
});

async function renderPanel() {
	window.history.replaceState(null, "", "/?surface=panel");
	const { App } = await import("../src/App.tsx");
	const view = render(<App />);
	return { ...view, App };
}

const invoked = (command: string) => h.invoke.mock.calls.filter(([c]) => c === command);
const emitUnit = (snapshot: NiriUnitSnapshot) =>
	act(async () => {
		h.listeners.get("dot://unit")?.({ payload: snapshot });
	});
const resolveGetter = (snapshot: NiriUnitSnapshot) =>
	act(async () => {
		h.resolveGetter(snapshot);
		await Promise.resolve();
	});
// The subscription registers asynchronously (dynamic event import); events emitted before it
// lands are never delivered, so wait for it first — mirroring the bridge's subscribe-first order.
const waitSubscribed = () => waitFor(() => expect(h.listeners.has("dot://unit")).toBe(true));

beforeEach(() => {
	h.tauri = true;
	h.roseHidden = false;
	h.fullscreen = false;
	h.computer = { active: false };
	h.listeners.clear();
	h.unlistened = [];
	h.listenImpl = null;
	h.state = { ...initialState, connection: "open", agentState: "idle" };
	h.invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
		switch (command) {
			case "connection_info":
				return new Promise(() => {});
			case "niri_unit_state":
				return new Promise((resolve) => {
					h.resolveGetter = resolve as (value: unknown) => void;
				});
			case "rose_hidden":
				return h.roseHidden;
			case "set_rose_hidden":
				h.roseHidden = args?.hidden === true;
				return h.roseHidden;
			case "set_panel_fullscreen":
				h.fullscreen = args?.on === true;
				return h.fullscreen;
			case "niri_unit_ready":
				return true;
			case "computer_status":
				return h.computer;
			default:
				return null;
		}
	});
});

afterEach(() => {
	window.history.replaceState(null, "", "/");
});

describe("niri unit bridge", () => {
	it("disabled fallback renders the legacy panel and never wraps", async () => {
		await renderPanel();
		await resolveGetter({ ...unit(), enabled: false, revision: 0 });
		expect(document.querySelector(".niri-unit")).toBeNull();
		await screen.findByRole("textbox", { name: "Message" });
		await screen.findByRole("button", { name: "Hide the rose" });
	});

	it("malformed payloads never enable the unit", async () => {
		await renderPanel();
		await waitSubscribed();
		await emitUnit(null as unknown as NiriUnitSnapshot);
		await resolveGetter(null as unknown as NiriUnitSnapshot);
		expect(document.querySelector(".niri-unit")).toBeNull();
		await screen.findByRole("textbox", { name: "Message" });
	});

	it("enabled wraps the real chat once: pair mode, same connection", async () => {
		const { container } = await renderPanel();
		await resolveGetter(unit({ revision: 1 }));
		const wrapped = container.querySelector(".niri-unit");
		expect(wrapped).toHaveAttribute("data-mode", "pair");
		expect(wrapped).toHaveAttribute("data-revision", "1");
		expect(screen.getByRole("button", { name: /Gentle Dot: / })).toBeInTheDocument();
		// One chat, not a duplicated connection surface.
		expect(container.querySelectorAll(".chat").length).toBe(1);
		await screen.findByRole("textbox", { name: "Message" });
	});

	it("a late getter response never overwrites a newer event", async () => {
		const { container } = await renderPanel();
		await waitSubscribed();
		await emitUnit(unit({ open: false, revision: 5 }));
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "rose");
		await resolveGetter(unit({ open: true, revision: 2 }));
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "rose");
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-revision", "5");
	});

	it("stale revision events are ignored", async () => {
		const { container } = await renderPanel();
		await waitSubscribed();
		await emitUnit(unit({ open: true, revision: 5 }));
		await emitUnit(unit({ open: false, revision: 3 }));
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "pair");
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-revision", "5");
	});

	it("closed panel stays mounted: input survives open toggles, inert while hidden", async () => {
		const { container } = await renderPanel();
		await waitSubscribed();
		await resolveGetter(unit({ open: true, revision: 1 }));
		const box = await screen.findByRole("textbox", { name: "Message" });
		fireEvent.change(box, { target: { value: "keep me" } });
		const slot = container.querySelector(".niri-unit-panel");
		await emitUnit(unit({ open: false, revision: 2 }));
		expect(slot).toHaveAttribute("hidden");
		expect(slot).toHaveAttribute("inert");
		await emitUnit(unit({ open: true, revision: 3 }));
		expect(container.querySelector(".niri-unit-panel")).toBe(slot);
		expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("keep me");
	});

	it("reports the assistant state from the shared panel while enabled", async () => {
		const view = await renderPanel();
		await resolveGetter(unit());
		h.state = { ...h.state, agentState: "thinking" };
		view.rerender(<view.App />);
		await act(async () => {});
		expect(h.invoke).toHaveBeenCalledWith("set_dot_state", { state: "thinking" });
	});

	it("fullscreen snapshot hides the rose but keeps its callbacks and the chat column", async () => {
		const { container } = await renderPanel();
		await resolveGetter(unit({ roseHidden: false, fullscreen: true, revision: 2 }));
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "fullscreen");
		// Fullscreen hides the rose even though the saved preference says shown.
		expect(screen.queryByRole("button", { name: /Gentle Dot: / })).toBeNull();
		expect(container.querySelector(".chat")).toHaveClass("chat-fullscreen");
		// The in-chat toggle stays reachable but disabled there: pressing it never
		// touches the saved preference.
		const toggle = await screen.findByRole("button", { name: "Hide the rose" });
		expect(toggle).toBeDisabled();
		expect(toggle.getAttribute("title") ?? "").toContain("full screen");
		await userEvent.click(toggle);
		expect(invoked("set_rose_hidden")).toHaveLength(0);
		expect(h.roseHidden).toBe(false);
		await userEvent.click(await screen.findByRole("button", { name: "Exit full screen" }));
		expect(h.invoke).toHaveBeenCalledWith("set_panel_fullscreen", { on: false });
		// Leaving fullscreen with the rose active shows it again; the toggle works as before.
		await waitSubscribed();
		await emitUnit(unit({ roseHidden: false, fullscreen: false, revision: 3 }));
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "pair");
		await screen.findByRole("button", { name: /Gentle Dot: / });
		const enabled = await screen.findByRole("button", { name: "Hide the rose" });
		expect(enabled).toBeEnabled();
		await userEvent.click(enabled);
		expect(h.invoke).toHaveBeenCalledWith("set_rose_hidden", { hidden: true });
	});

	it("Esc still hides the panel when the unit is enabled", async () => {
		await renderPanel();
		await resolveGetter(unit());
		await screen.findByRole("textbox", { name: "Message" });
		fireEvent.keyDown(window, { key: "Escape" });
		expect(invoked("hide_panel")).toHaveLength(1);
	});

	it("unmount cuts the subscription even when it registers late", async () => {
		let register!: (unlisten: () => void) => void;
		h.listenImpl = () =>
			new Promise<() => void>((resolve) => {
				register = resolve;
			});
		const view = await renderPanel();
		await act(async () => {});
		expect(h.listeners.has("dot://unit")).toBe(false);
		view.unmount();
		await act(async () => {
			register(() => {
				h.unlistened.push("dot://unit");
			});
		});
		expect(h.unlistened).toContain("dot://unit");
		expect(h.listeners.has("dot://unit")).toBe(false);
	});
});

describe("render-ready handshake", () => {
	it("acks the enabled revision after render, never inside the receiver", async () => {
		const { container } = await renderPanel();
		await waitSubscribed();
		await emitUnit(unit({ open: true, revision: 7 }));
		// The receiver only commits state; the ack follows the DOM commit.
		expect(invoked("niri_unit_ready")).toHaveLength(0);
		await waitFor(() => expect(invoked("niri_unit_ready")).toHaveLength(1));
		expect(h.invoke).toHaveBeenCalledWith("niri_unit_ready", { revision: 7 });
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-revision", "7");
	});

	it("cancels stale pending acks on revision change and unmount", async () => {
		const view = await renderPanel();
		await waitSubscribed();
		await emitUnit(unit({ open: true, revision: 5 }));
		await emitUnit(unit({ open: true, revision: 6 }));
		view.unmount();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(invoked("niri_unit_ready")).toHaveLength(0);
	});

	it("disabled never acks", async () => {
		await renderPanel();
		await resolveGetter({ ...unit(), enabled: false, revision: 0 });
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(invoked("niri_unit_ready")).toHaveLength(0);
	});
});

describe("outside the enabled unit", () => {
	it("off-desktop never invokes the getter", async () => {
		h.tauri = false;
		await renderPanel();
		await screen.findByText(/needs your access key/);
		expect(invoked("niri_unit_state")).toHaveLength(0);
		expect(document.querySelector(".niri-unit")).toBeNull();
	});
});
