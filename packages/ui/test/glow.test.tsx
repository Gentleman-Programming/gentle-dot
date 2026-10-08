import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	invoke: vi.fn(),
	listeners: new Map<string, (event: { payload: unknown }) => void>(),
	reducedMotion: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => true,
	invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
		h.listeners.set(name, handler);
		return () => h.listeners.delete(name);
	},
}));

const { GlowSurface } = await import("../src/components/GlowSurface.tsx");
const { App } = await import("../src/App.tsx");

function emit(name: string, payload: unknown) {
	act(() => h.listeners.get(name)?.({ payload }));
}

const glow = (payload: unknown) => emit("computer://glow", payload);
const session = (active: boolean) => emit("computer://state", { active, yolo: false });

async function renderGlow() {
	const view = render(<GlowSurface />);
	await waitFor(() => expect(h.listeners.has("computer://glow")).toBe(true));
	await waitFor(() => expect(h.listeners.has("computer://state")).toBe(true));
	return view.container;
}

const marks = (root: HTMLElement) => root.querySelectorAll(".glow-mark");

beforeEach(() => {
	h.invoke.mockReset();
	h.invoke.mockImplementation(() => new Promise(() => {}));
	h.listeners.clear();
	h.reducedMotion = false;
	window.matchMedia = ((query: string) => ({
		matches: query.includes("reduced-motion") && h.reducedMotion,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	})) as unknown as typeof window.matchMedia;
});

afterEach(() => {
	vi.useRealTimers();
	window.history.replaceState(null, "", "/");
});

describe("GlowSurface (S28)", () => {
	it("shows nothing while the agent is idle", async () => {
		const root = await renderGlow();
		expect(marks(root)).toHaveLength(0);
		session(true);
		expect(marks(root)).toHaveLength(0);
	});

	it("pulses where the agent clicked, in the overlay's points", async () => {
		const root = await renderGlow();
		glow({ kind: "click", x: 60, y: 120 });
		const click = root.querySelector(".glow-mark.glow-click") as HTMLElement;
		expect(click).not.toBeNull();
		expect(click.style.left).toBe("60px");
		expect(click.style.top).toBe("120px");
	});

	it("draws a trail along a drag and short markers for move and scroll", async () => {
		const root = await renderGlow();
		glow({ kind: "drag", x: 100, y: 100, toX: 400, toY: 500 });
		const trail = root.querySelector(".glow-trail") as HTMLElement;
		expect(trail).not.toBeNull();
		expect(trail.style.width).toBe("500px");
		expect(root.querySelector(".glow-mark.glow-drag")).not.toBeNull();
		glow({ kind: "move", x: 1, y: 2 });
		glow({ kind: "scroll", x: 3, y: 4 });
		expect(root.querySelector(".glow-mark.glow-move")).not.toBeNull();
		expect(root.querySelector(".glow-mark.glow-scroll")).not.toBeNull();
	});

	it("outlines the focused element for keyboard actions", async () => {
		const root = await renderGlow();
		glow({ kind: "key", x: 160, y: 100, width: 200, height: 30 });
		const field = root.querySelector(".glow-mark.glow-key") as HTMLElement;
		expect(field.style.width).toBe("200px");
		expect(field.style.height).toBe("30px");
	});

	it("ignores events it cannot place", async () => {
		const root = await renderGlow();
		for (const payload of [
			null,
			{ kind: "click" },
			{ kind: "explode", x: 1, y: 1 },
			{ kind: "key", x: 1, y: 1 },
			{ kind: "drag", x: 1, y: 1 },
			{ kind: "click", x: Number.NaN, y: 1 },
		]) {
			glow(payload);
		}
		expect(marks(root)).toHaveLength(0);
	});

	it("fades out about 1.5 s after the last action", async () => {
		const root = await renderGlow();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		glow({ kind: "click", x: 10, y: 10 });
		act(() => vi.advanceTimersByTime(1000));
		// Another action keeps it lit.
		glow({ kind: "move", x: 20, y: 20 });
		act(() => vi.advanceTimersByTime(1200));
		expect(marks(root)).toHaveLength(2);
		expect(root.querySelector(".glow-layer")).toHaveClass("glow-fading");
		act(() => vi.advanceTimersByTime(300));
		expect(marks(root)).toHaveLength(0);
	});

	it("disappears at once when the session ends and stays dark until the next one", async () => {
		const root = await renderGlow();
		session(true);
		glow({ kind: "click", x: 10, y: 10 });
		session(false);
		expect(marks(root)).toHaveLength(0);
		// A mark that arrives after Stop, panic, or the timeout is dropped.
		glow({ kind: "click", x: 10, y: 10 });
		expect(marks(root)).toHaveLength(0);
		session(true);
		glow({ kind: "click", x: 10, y: 10 });
		expect(marks(root)).toHaveLength(1);
	});

	it("stays still with reduced motion: a static glow, no pulse or trail", async () => {
		h.reducedMotion = true;
		const root = await renderGlow();
		glow({ kind: "drag", x: 100, y: 100, toX: 400, toY: 500 });
		expect(root.querySelector(".glow-layer")).toHaveClass("glow-static");
		expect(root.querySelector(".glow-trail")).toBeNull();
		const end = root.querySelector(".glow-mark.glow-drag") as HTMLElement;
		expect([end.style.left, end.style.top]).toEqual(["400px", "500px"]);
	});

	it("is the app's glow window, which never connects to the assistant", async () => {
		window.history.replaceState(null, "", "/?surface=glow");
		const view = render(<App />);
		await waitFor(() => expect(h.listeners.has("computer://glow")).toBe(true));
		expect(view.container.querySelector(".glow-layer")).not.toBeNull();
		expect(document.documentElement.dataset.surface).toBe("glow");
		expect(h.invoke).not.toHaveBeenCalledWith("connection_info", undefined);
	});
});
