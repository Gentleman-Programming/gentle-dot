import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatShortcut, recordKey } from "../src/shortcut.ts";
import { type DotState, initialState } from "../src/store.ts";

/** The Settings screen and its keyboard shortcut (S33), through the panel and mocked Tauri commands. */
const h = vi.hoisted(() => ({
	tauri: true,
	shortcut: "Alt+Space",
	setResult: undefined as undefined | ((shortcut: string) => Promise<unknown>),
	invoke: vi.fn(),
	state: undefined as unknown as DotState,
}));

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => h.tauri,
	invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async () => () => {},
}));

// As in computer.test.tsx: the panel's other desktop events are not under test.
vi.mock("../src/desktop.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/desktop.ts")>()),
	onDesktopEvent: async () => () => {},
}));

vi.mock("../src/useDot.ts", () => ({
	useDot: () => ({ state: h.state, send: () => {}, dismiss: () => {}, dispatch: () => {} }),
}));

const MAC_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const LINUX_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";

async function renderApp(search: string) {
	window.history.replaceState(null, "", `/${search}`);
	const { App } = await import("../src/App.tsx");
	return render(<App />);
}

const invoked = (command: string) => h.invoke.mock.calls.filter(([c]) => c === command);

async function openSettings() {
	await renderApp("?surface=panel");
	await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
	return screen.findByRole("region", { name: "Settings" });
}

async function startRecording() {
	await openSettings();
	await screen.findByText("⌥ Space");
	await userEvent.click(screen.getByRole("button", { name: "Change" }));
	await screen.findByText(/Press the new shortcut/);
}

beforeEach(() => {
	h.tauri = true;
	h.shortcut = "Alt+Space";
	h.setResult = undefined;
	h.state = { ...initialState, connection: "open", agentState: "idle" };
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_AGENT);
	h.invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
		switch (command) {
			case "connection_info":
				return new Promise(() => {});
			case "shortcut_get":
				return { shortcut: h.shortcut, default: "Alt+Space" };
			case "shortcut_set": {
				const shortcut = String(args?.shortcut);
				if (h.setResult) return h.setResult(shortcut);
				h.shortcut = shortcut;
				return { shortcut };
			}
			default:
				return null;
		}
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
	window.sessionStorage.clear();
});

describe("showing a shortcut", () => {
	it("uses the macOS symbols on macOS", () => {
		expect(formatShortcut("Alt+Space", true)).toBe("⌥ Space");
		expect(formatShortcut("Shift+Super+K", true)).toBe("⇧⌘K");
		expect(formatShortcut("Ctrl+Alt+Shift+Super+1", true)).toBe("⌃⌥⇧⌘1");
		// Any spelling of config.json shows the same way, in the macOS order.
		expect(formatShortcut("cmd+shift+k", true)).toBe("⇧⌘K");
		expect(formatShortcut("F5", true)).toBe("F5");
		expect(formatShortcut("Ctrl+Escape", true)).toBe("⌃ Esc");
	});

	it("uses key names elsewhere", () => {
		expect(formatShortcut("Alt+Space", false)).toBe("Alt+Space");
		expect(formatShortcut("Shift+Super+K", false)).toBe("Shift+Super+K");
		expect(formatShortcut("control+option+k", false)).toBe("Ctrl+Alt+K");
	});
});

describe("recording a key combination", () => {
	const key = (init: Partial<KeyboardEvent>) =>
		recordKey({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });

	it("turns modifiers and the key into the app's accelerator, by physical key", () => {
		// ⌥K types "˚" on a US Mac; the shortcut is still ⌥K.
		expect(key({ key: "˚", code: "KeyK", altKey: true })).toEqual({ kind: "shortcut", accelerator: "Alt+K" });
		expect(key({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true, metaKey: true })).toEqual({
			kind: "shortcut",
			accelerator: "Ctrl+Shift+Super+1",
		});
		expect(key({ key: " ", code: "Space", altKey: true })).toEqual({
			kind: "shortcut",
			accelerator: "Alt+Space",
		});
		expect(key({ key: "F5", code: "F5" })).toEqual({ kind: "shortcut", accelerator: "F5" });
	});

	it("keeps waiting while only modifiers are held", () => {
		expect(key({ key: "Alt", code: "AltLeft", altKey: true })).toEqual({ kind: "waiting" });
		expect(key({ key: "Meta", code: "MetaRight", metaKey: true })).toEqual({ kind: "waiting" });
		expect(key({ key: "Shift", code: "ShiftLeft", shiftKey: true })).toEqual({ kind: "waiting" });
	});

	it("cancels on Esc alone", () => {
		expect(key({ key: "Escape", code: "Escape" })).toEqual({ kind: "cancel" });
		expect(key({ key: "Escape", code: "Escape", ctrlKey: true })).toEqual({
			kind: "shortcut",
			accelerator: "Ctrl+Escape",
		});
	});
});

describe("when the app cannot reach its assistant (S35.2)", () => {
	it("the panel shows the app's own reason, not the browser's access-key note", async () => {
		const reason =
			"Another Gentle Dot assistant is already running on port 4317. Stop it, then choose Restart assistant.";
		const fallback = h.invoke.getMockImplementation();
		h.invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
			if (command === "connection_info") throw reason;
			return fallback?.(command, args);
		});
		await renderApp("?surface=panel");
		expect(await screen.findByRole("status")).toHaveTextContent(reason);
		expect(screen.queryByText(/needs your access key/)).toBeNull();
	});
});

describe("the Settings screen (S33.1)", () => {
	it("opens from a gear in the desktop panel header", async () => {
		const settings = await openSettings();
		expect(settings).toHaveTextContent("Keyboard shortcut");
		expect(await screen.findByText("⌥ Space")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
		expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
	});

	it("the web UI shows no gear", async () => {
		h.tauri = false;
		await renderApp("?surface=web#token=abc");
		await screen.findByRole("button", { name: "Accounts" });
		expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
		expect(invoked("shortcut_get")).toHaveLength(0);
	});

	it("shows key names off macOS", async () => {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINUX_AGENT);
		h.shortcut = "Shift+Super+K";
		await openSettings();
		expect(await screen.findByText("Shift+Super+K")).toBeInTheDocument();
	});
});

describe("voice language (S30.6)", () => {
	it("defaults to the system language and remembers the one chosen for macOS speech", async () => {
		await openSettings();
		const picker = screen.getByRole("combobox", { name: "Voice language" });
		expect(picker).toHaveValue("");
		await userEvent.selectOptions(picker, "es-ES");
		expect(localStorage.getItem("gentle-dot-voice-language")).toBe("es-ES");
		await userEvent.selectOptions(picker, "");
		expect(localStorage.getItem("gentle-dot-voice-language")).toBeNull();
	});
});

describe("changing the shortcut (S33.2, S33.3)", () => {
	it("records the next combination and applies it", async () => {
		await startRecording();
		fireEvent.keyDown(window, { key: "˚", code: "KeyK", altKey: true, ctrlKey: true });
		await waitFor(() => expect(invoked("shortcut_set")).toHaveLength(1));
		expect(invoked("shortcut_set")[0]?.[1]).toEqual({ shortcut: "Ctrl+Alt+K" });
		expect(await screen.findByText("⌃⌥K")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("Saved. It works right away.");
	});

	it("shows that the change is pending until the app answers", async () => {
		let answer: (value: unknown) => void = () => {};
		h.setResult = () => new Promise((resolve) => (answer = resolve));
		await startRecording();
		fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true, shiftKey: true });
		expect(await screen.findByRole("status")).toHaveTextContent("Applying ⇧⌘K…");
		await act(async () => answer({ shortcut: "Shift+Super+K" }));
		expect(screen.getByRole("status")).toHaveTextContent("Saved. It works right away.");
	});

	it("Esc cancels recording without hiding the panel", async () => {
		await startRecording();
		fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
		await waitFor(() => expect(screen.queryByText(/Press the new shortcut/)).toBeNull());
		expect(invoked("hide_panel")).toHaveLength(0);
		expect(invoked("shortcut_set")).toHaveLength(0);
		expect(screen.getByText("⌥ Space")).toBeInTheDocument();
		// Not recording any more: the next Esc hides the panel as usual.
		fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
		expect(invoked("hide_panel")).toHaveLength(1);
	});

	it("keys pressed while recording do nothing else in the panel", async () => {
		await startRecording();
		// ⌘⇧F would toggle full screen.
		fireEvent.keyDown(window, { key: "f", code: "KeyF", metaKey: true, shiftKey: true });
		await waitFor(() => expect(invoked("shortcut_set")).toHaveLength(1));
		expect(invoked("set_panel_fullscreen")).toHaveLength(0);
	});

	it("keeps recording while only modifiers are held", async () => {
		await startRecording();
		fireEvent.keyDown(window, { key: "Alt", code: "AltLeft", altKey: true });
		expect(screen.getByText(/Press the new shortcut/)).toBeInTheDocument();
		expect(invoked("shortcut_set")).toHaveLength(0);
	});

	it("shows the app's reason when it refuses a shortcut and keeps the current one", async () => {
		h.setResult = async () => {
			throw "That shortcut is taken by the system or another app.";
		};
		await startRecording();
		fireEvent.keyDown(window, { key: " ", code: "Space", metaKey: true });
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"That shortcut is taken by the system or another app.",
		);
		expect(screen.getByText("⌥ Space")).toBeInTheDocument();
	});

	it("resets to the default shortcut", async () => {
		h.shortcut = "Shift+Super+K";
		await openSettings();
		await screen.findByText("⇧⌘K");
		await userEvent.click(screen.getByRole("button", { name: "Reset to default" }));
		await waitFor(() => expect(invoked("shortcut_set")).toHaveLength(1));
		expect(invoked("shortcut_set")[0]?.[1]).toEqual({ shortcut: "Alt+Space" });
		expect(await screen.findByText("⌥ Space")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reset to default" })).toBeDisabled();
	});
});
