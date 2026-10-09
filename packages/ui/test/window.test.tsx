import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DotState, initialState } from "../src/store.ts";

/** Hide the rose and full-screen chat (S26), through the panel and its mocked Tauri commands. */
const h = vi.hoisted(() => ({
	tauri: true,
	roseHidden: false,
	fullscreen: false,
	computer: { active: false } as unknown,
	invoke: vi.fn(),
	listeners: new Map<string, (event: { payload: unknown }) => void>(),
	state: undefined as unknown as DotState,
}));

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => h.tauri,
	invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
		h.listeners.set(name, handler);
		return () => h.listeners.delete(name);
	},
}));

// As in computer.test.tsx: the panel's other desktop events are not under test, and concurrent first
// imports of the mocked event module can reach the real one.
vi.mock("../src/desktop.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/desktop.ts")>()),
	onDesktopEvent: async () => () => {},
}));

vi.mock("../src/useDot.ts", () => ({
	useDot: () => ({ state: h.state, send: () => {}, dismiss: () => {}, dispatch: () => {} }),
}));

async function renderApp(search: string) {
	window.history.replaceState(null, "", `/${search}`);
	const { App } = await import("../src/App.tsx");
	return render(<App />);
}

const invoked = (command: string) => h.invoke.mock.calls.filter(([c]) => c === command);
const lastArgs = (command: string) => invoked(command).at(-1)?.[1];
const chat = (container: HTMLElement) => container.querySelector(".chat");

beforeEach(() => {
	h.tauri = true;
	h.roseHidden = false;
	h.fullscreen = false;
	h.computer = { active: false };
	h.listeners.clear();
	h.state = { ...initialState, connection: "open", agentState: "idle" };
	h.invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
		switch (command) {
			case "connection_info":
				return new Promise(() => {});
			case "rose_hidden":
				return h.roseHidden;
			case "set_rose_hidden":
				h.roseHidden = args?.hidden === true;
				return h.roseHidden;
			case "set_panel_fullscreen":
				h.fullscreen = args?.on === true;
				return h.fullscreen;
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

describe("hide the rose (S26.1)", () => {
	it("the panel header hides the rose and then offers to show it again", async () => {
		await renderApp("?surface=panel");
		await waitFor(() => expect(invoked("rose_hidden")).toHaveLength(1));
		await userEvent.click(await screen.findByRole("button", { name: "Hide the rose" }));
		expect(h.invoke).toHaveBeenCalledWith("set_rose_hidden", { hidden: true });

		const show = await screen.findByRole("button", { name: "Show the rose" });
		expect(show).toHaveAttribute("title", "Show the rose");
		await userEvent.click(show);
		expect(lastArgs("set_rose_hidden")).toEqual({ hidden: false });
		await screen.findByRole("button", { name: "Hide the rose" });
	});

	it("starts from the remembered choice and follows the tray", async () => {
		h.roseHidden = true;
		await renderApp("?surface=panel");
		await screen.findByRole("button", { name: "Show the rose" });

		await waitFor(() => expect(h.listeners.has("dot://rose")).toBe(true));
		await act(async () => h.listeners.get("dot://rose")?.({ payload: { hidden: false } }));
		await screen.findByRole("button", { name: "Hide the rose" });
	});

	it("keeps the computer-control banner, yolo included, while the rose is hidden", async () => {
		h.roseHidden = true;
		h.computer = { active: true, endsAt: Date.now() + 60_000, yolo: true };
		await renderApp("?surface=panel");
		await screen.findByRole("button", { name: "Show the rose" });
		const banner = await screen.findByRole("region", { name: "Computer control" });
		expect(banner).toHaveTextContent(/yolo/i);
	});
});

describe("full-screen chat (S26.2)", () => {
	it("the header button fills the screen and the same button restores it", async () => {
		const { container } = await renderApp("?surface=panel");
		await userEvent.click(await screen.findByRole("button", { name: "Full screen" }));
		expect(h.invoke).toHaveBeenCalledWith("set_panel_fullscreen", { on: true });
		const exit = await screen.findByRole("button", { name: "Exit full screen" });
		expect(chat(container)).toHaveClass("chat-fullscreen");

		await userEvent.click(exit);
		expect(lastArgs("set_panel_fullscreen")).toEqual({ on: false });
		await screen.findByRole("button", { name: "Full screen" });
		expect(chat(container)).not.toHaveClass("chat-fullscreen");
	});

	it("⌘⇧F toggles full screen while the panel has focus", async () => {
		const { container } = await renderApp("?surface=panel");
		await screen.findByRole("button", { name: "Full screen" });
		fireEvent.keyDown(window, { key: "F", code: "KeyF", metaKey: true, shiftKey: true });
		await waitFor(() => expect(chat(container)).toHaveClass("chat-fullscreen"));
		fireEvent.keyDown(window, { key: "F", code: "KeyF", metaKey: true, shiftKey: true });
		await waitFor(() => expect(chat(container)).not.toHaveClass("chat-fullscreen"));
		// Plain ⌘F (find) and ⇧F (typing a capital F) are left alone.
		fireEvent.keyDown(window, { key: "f", code: "KeyF", metaKey: true });
		fireEvent.keyDown(window, { key: "F", code: "KeyF", shiftKey: true });
		expect(invoked("set_panel_fullscreen")).toHaveLength(2);
	});

	it("Esc restores from full screen first and hides the panel only after that", async () => {
		const { container } = await renderApp("?surface=panel");
		await userEvent.click(await screen.findByRole("button", { name: "Full screen" }));
		await waitFor(() => expect(chat(container)).toHaveClass("chat-fullscreen"));

		fireEvent.keyDown(window, { key: "Escape" });
		await waitFor(() => expect(chat(container)).not.toHaveClass("chat-fullscreen"));
		expect(lastArgs("set_panel_fullscreen")).toEqual({ on: false });
		expect(invoked("hide_panel")).toHaveLength(0);

		fireEvent.keyDown(window, { key: "Escape" });
		expect(invoked("hide_panel")).toHaveLength(1);
		expect(invoked("set_panel_fullscreen")).toHaveLength(2);
	});

	it("leaves an Esc that something inside the panel already handled alone", async () => {
		const { container } = await renderApp("?surface=panel");
		await userEvent.click(await screen.findByRole("button", { name: "Full screen" }));
		await waitFor(() => expect(chat(container)).toHaveClass("chat-fullscreen"));
		const box = screen.getByRole("textbox", { name: "Message" });
		box.addEventListener("keydown", (event) => event.preventDefault());

		fireEvent.keyDown(box, { key: "Escape" });
		expect(chat(container)).toHaveClass("chat-fullscreen");
		expect(invoked("set_panel_fullscreen")).toHaveLength(1);
		expect(invoked("hide_panel")).toHaveLength(0);
	});

	it("gives the conversation a readable centered column in full screen", async () => {
		const stylesheet = "../src/styles.css";
		const css = readFileSync(fileURLToPath(new URL(stylesheet, import.meta.url)), "utf8");
		expect(css).toMatch(/--reading-width: 780px;/);
		expect(css).toMatch(/\.chat-web \{[^}]*max-width: var\(--reading-width\);/);
		expect(css).toMatch(/\.chat-fullscreen \.chat-body[^{]*\{[^}]*var\(--reading-width\)/);
	});
});

describe("outside the desktop panel", () => {
	it("the web page shows neither the full-screen nor the rose button and calls nothing", async () => {
		h.tauri = false;
		await renderApp("?#token=web-key");
		await screen.findByRole("textbox", { name: "Message" });
		expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull();
		expect(screen.queryByRole("button", { name: /the rose/ })).toBeNull();
		fireEvent.keyDown(window, { key: "F", metaKey: true, shiftKey: true });
		expect(h.invoke).not.toHaveBeenCalled();
	});

	it("the Dot window loads no panel controls", async () => {
		await renderApp("?surface=dot");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(invoked("rose_hidden")).toHaveLength(0);
		expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull();
	});
});
