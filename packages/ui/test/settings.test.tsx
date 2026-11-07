import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatShortcut, recordKey } from "../src/shortcut.ts";
import { type DotState, initialState } from "../src/store.ts";

/** The Settings screen and its keyboard shortcut (S33), through the panel and mocked Tauri commands. */
const h = vi.hoisted(() => ({
	tauri: true,
	shortcut: "Alt+Space",
	memory: "shared" as "shared" | "private",
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
	localStorage.removeItem("gentle-dot-ui-language");
	h.tauri = true;
	h.shortcut = "Alt+Space";
	h.memory = "shared";
	h.setResult = undefined;
	h.state = { ...initialState, connection: "open", agentState: "idle" };
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_AGENT);
	h.invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
		switch (command) {
			case "connection_info":
				return new Promise(() => {});
			case "voice_input_devices":
				return { supported: false, devices: [] };
			case "shortcut_get":
				return { shortcut: h.shortcut, default: "Alt+Space" };
			case "shortcut_set": {
				const shortcut = String(args?.shortcut);
				if (h.setResult) return h.setResult(shortcut);
				h.shortcut = shortcut;
				return { shortcut };
			}
			case "memory_get":
				return { memory: h.memory };
			case "memory_set": {
				const memory = String(args?.memory) as "shared" | "private";
				h.memory = memory;
				return { memory };
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
	localStorage.removeItem("gentle-dot-ui-language");
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

describe("when the web page has no access key", () => {
	it("tells both a computer user and a server user how to open it", async () => {
		h.tauri = false;
		await renderApp("?surface=web");
		const status = await screen.findByRole("status");
		expect(status).toHaveTextContent(
			"This page needs your access key. On your computer, open it from the Gentle Dot menu (Open in browser); on a server, open the link with #token=<your access key>.",
		);
	});
});

describe("the Settings screen (S33.1)", () => {
	it("keeps Windows memory and device settings without duplicating macOS speech language", async () => {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
		const settings = await openSettings();
		expect(await screen.findByRole("switch", { name: "Private memory" })).toBeVisible();
		expect(settings.querySelectorAll("#settings-voice-devices")).toHaveLength(1);
		expect(settings.querySelectorAll("#settings-voice-language")).toHaveLength(1);
		expect(settings.querySelector('[aria-labelledby="settings-voice-language"]')).not.toBeVisible();
		expect(screen.queryByRole("combobox", { name: "Voice language" })).toBeNull();
		expect(invoked("memory_set")).toHaveLength(0);
	});

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

describe("the Private memory toggle (SW9)", () => {
	it("shows the stored value and flips it through the app", async () => {
		h.memory = "private";
		await openSettings();
		const toggle = await screen.findByRole("switch", { name: "Private memory" });
		await waitFor(() => expect(toggle).toBeEnabled());
		expect(toggle).toBeChecked();
		expect(invoked("memory_set")).toHaveLength(0);
		await userEvent.click(toggle);
		await waitFor(() => expect(invoked("memory_set")).toHaveLength(1));
		expect(invoked("memory_set")[0]?.[1]).toEqual({ memory: "shared" });
		await waitFor(() => expect(toggle).not.toBeChecked());
	});

	it("defaults to the shared Engram and turns private memory on", async () => {
		await openSettings();
		const toggle = await screen.findByRole("switch", { name: "Private memory" });
		await waitFor(() => expect(toggle).toBeEnabled());
		expect(toggle).not.toBeChecked();
		await userEvent.click(toggle);
		await waitFor(() => expect(invoked("memory_set")).toHaveLength(1));
		expect(invoked("memory_set")[0]?.[1]).toEqual({ memory: "private" });
		await waitFor(() => expect(toggle).toBeChecked());
	});
});

describe("interface language (F2a)", () => {
	it("switches mounted Settings labels without changing speech or backend settings", async () => {
		await openSettings();
		const picker = screen.getByRole("combobox", { name: "Interface language" });
		expect(picker).toHaveValue("en");
		const voice = screen.getByRole("combobox", { name: "Voice language" });
		const speechBefore = localStorage.getItem("gentle-dot-voice-language");
		const commandsBefore = h.invoke.mock.calls.length;
		await userEvent.selectOptions(picker, "es");
		expect(screen.getByRole("heading", { name: "Ajustes", level: 2 })).toBeInTheDocument();
		expect(screen.getByRole("region", { name: "Ajustes" })).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Idioma de la interfaz" })).toHaveValue("es");
		expect(localStorage.getItem("gentle-dot-ui-language")).toBe("es");
		expect(localStorage.getItem("gentle-dot-voice-language")).toBe(speechBefore);
		expect(voice).toHaveValue("");
		expect(h.invoke.mock.calls).toHaveLength(commandsBefore);
		await userEvent.selectOptions(picker, "en");
		expect(screen.getByRole("heading", { name: "Settings", level: 2 })).toBeInTheDocument();
	});

	it("restores Spanish on App mount and follows another window's preference", async () => {
		localStorage.setItem("gentle-dot-ui-language", "es");
		await renderApp("?surface=panel");
		await userEvent.click(await screen.findByRole("button", { name: "Ajustes" }));
		expect(await screen.findByRole("heading", { name: "Ajustes", level: 2 })).toBeInTheDocument();
		act(() => {
			window.dispatchEvent(
				new StorageEvent("storage", {
					key: "gentle-dot-ui-language",
					newValue: "en",
					storageArea: localStorage,
				}),
			);
		});
		expect(screen.getByRole("combobox", { name: "Interface language" })).toHaveValue("en");
		expect(screen.getByRole("heading", { name: "Settings", level: 2 })).toBeInTheDocument();
	});
});

describe("localized Settings body (S1–S4)", () => {
	async function spanish() {
		await openSettings();
		await screen.findByText("⌥ Space");
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Interface language" }), "es");
	}

	it("translates body and accessibility while preserving speech autonyms, codes and memory payloads", async () => {
		await spanish();
		expect(screen.getByRole("heading", { name: "Atajo de teclado" })).toBeInTheDocument();
		expect(screen.getByText("Abre y oculta el panel desde cualquier aplicación.")).toBeInTheDocument();
		expect(screen.getByText(/Usa al menos una tecla modificadora/)).toHaveTextContent("⌘ ⌥ ⌃ ⇧");
		expect(screen.getByRole("button", { name: "Restablecer predeterminado" })).toHaveAttribute(
			"title",
			"Predeterminado: ⌥ Space",
		);
		expect(screen.getByRole("heading", { name: "Memoria" })).toBeInTheDocument();
		expect(screen.getByText(/Activa esta opción para darle al asistente/)).toHaveTextContent("Engram");
		expect(
			screen.getByText(
				"El idioma que escucha el reconocimiento de voz de macOS. El modelo de voz local lo detecta por sí solo.",
			),
		).toBeInTheDocument();
		const toggle = screen.getByRole("switch", { name: "Memoria privada" });
		await userEvent.click(toggle);
		await waitFor(() => expect(toggle).toBeChecked());
		expect(invoked("memory_set")[0]?.[1]).toEqual({ memory: "private" });
		await userEvent.click(toggle);
		await waitFor(() => expect(toggle).not.toBeChecked());
		expect(invoked("memory_set")[1]?.[1]).toEqual({ memory: "shared" });
		const voice = screen.getByRole("combobox", { name: "Idioma de voz" });
		expect(screen.getByRole("option", { name: "Automático (idioma del sistema)" })).toHaveValue("");
		for (const [code, label] of [
			["es-ES", "Español"],
			["en-US", "English"],
			["pt-BR", "Português"],
			["fr-FR", "Français"],
			["de-DE", "Deutsch"],
			["it-IT", "Italiano"],
		] as const) {
			expect(voice.querySelector(`option[value="${code}"]`)).toHaveTextContent(label);
		}
		const callsBefore = h.invoke.mock.calls.length;
		await userEvent.selectOptions(voice, "pt-BR");
		expect(localStorage.getItem("gentle-dot-voice-language")).toBe("pt-BR");
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Idioma de la interfaz" }), "en");
		expect(voice).toHaveValue("pt-BR");
		expect(screen.getByRole("option", { name: "Automatic (system language)" })).toHaveValue("");
		await userEvent.selectOptions(voice, "");
		expect(localStorage.getItem("gentle-dot-voice-language")).toBeNull();
		expect(h.invoke.mock.calls).toHaveLength(callsBefore);
	});

	it("renders recording, applying, saved and reset in the current locale with exact accelerators", async () => {
		let answer: (value: unknown) => void = () => {};
		h.setResult = () => new Promise((resolve) => (answer = resolve));
		await spanish();
		await userEvent.click(screen.getByRole("button", { name: "Cambiar" }));
		expect(screen.getByText("Pulsa el nuevo atajo… Esc cancela.")).toHaveFocus();
		await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
		expect(invoked("shortcut_set")).toHaveLength(0);
		await userEvent.click(screen.getByRole("button", { name: "Cambiar" }));
		fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true, altKey: true });
		expect(screen.getByText("Aplicando ⌃⌥K…", { selector: '[role="status"]' })).toBeInTheDocument();
		expect(invoked("shortcut_set")[0]?.[1]).toEqual({ shortcut: "Ctrl+Alt+K" });
		expect(screen.getByRole("button", { name: "Cambiar" })).toBeDisabled();
		const picker = screen.getByRole("combobox", { name: "Idioma de la interfaz" });
		await userEvent.selectOptions(picker, "en");
		expect(screen.getByText("Applying ⌃⌥K…", { selector: '[role="status"]' })).toBeInTheDocument();
		await act(async () => answer({ shortcut: "Ctrl+Alt+K" }));
		expect(
			screen.getByText("Saved. It works right away.", { selector: '[role="status"]' }),
		).toBeInTheDocument();
		await userEvent.selectOptions(picker, "es");
		expect(
			screen.getByText("Guardado. Funciona de inmediato.", { selector: '[role="status"]' }),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Restablecer predeterminado" }));
		expect(invoked("shortcut_set")[1]?.[1]).toEqual({ shortcut: "Alt+Space" });
		await act(async () => answer({ shortcut: "Alt+Space" }));
		expect(screen.getByRole("button", { name: "Restablecer predeterminado" })).toBeDisabled();
	});

	it.each([
		undefined,
		"Gentle Dot could not change the shortcut.",
		new Error("Native shortcut error"),
		"Error nativo 日本語",
	])("distinguishes authored fallback from raw shortcut rejection %s", async (reason) => {
		h.setResult = async () => {
			throw reason;
		};
		await spanish();
		await userEvent.click(screen.getByRole("button", { name: "Cambiar" }));
		fireEvent.keyDown(window, { key: "F5", code: "F5" });
		const expected =
			reason === undefined
				? "Gentle Dot no pudo cambiar el atajo."
				: reason instanceof Error
					? reason.message
					: reason;
		expect(await screen.findByRole("alert")).toHaveTextContent(expected);
		expect(screen.getByText("⌥ Space")).toBeInTheDocument();
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Idioma de la interfaz" }), "en");
		expect(screen.getByRole("alert")).toHaveTextContent(
			reason === undefined ? "Gentle Dot could not change the shortcut." : expected,
		);
		expect(invoked("shortcut_set")[0]?.[1]).toEqual({ shortcut: "F5" });
	});

	it.each([undefined, "Gentle Dot could not change the memory setting.", new Error("Native memory error")])(
		"preserves memory failure provenance %s",
		async (reason) => {
			const fallback = h.invoke.getMockImplementation();
			h.invoke = vi.fn(async (command, args) => {
				if (command === "memory_set") throw reason;
				return fallback?.(command, args);
			});
			await spanish();
			const toggle = screen.getByRole("switch", { name: "Memoria privada" });
			await userEvent.click(toggle);
			const raw = reason instanceof Error ? reason.message : reason;
			expect(await screen.findByRole("alert")).toHaveTextContent(
				raw ?? "Gentle Dot no pudo cambiar la configuración de memoria.",
			);
			expect(toggle).not.toBeChecked();
			expect(toggle).toBeEnabled();
			await userEvent.selectOptions(screen.getByRole("combobox", { name: "Idioma de la interfaz" }), "en");
			expect(screen.getByRole("alert")).toHaveTextContent(
				raw ?? "Gentle Dot could not change the memory setting.",
			);
			expect(invoked("memory_set")[0]?.[1]).toEqual({ memory: "private" });
		},
	);

	it("localizes authored load failures and keeps unavailable controls disabled", async () => {
		const fallback = h.invoke.getMockImplementation();
		h.invoke = vi.fn(async (command, args) => {
			if (command === "shortcut_get" || command === "memory_get") throw "unavailable";
			return fallback?.(command, args);
		});
		await openSettings();
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Interface language" }), "es");
		expect(screen.getByText("Gentle Dot no pudo leer el atajo actual.")).toHaveAttribute("role", "alert");
		expect(screen.getByText("Gentle Dot no pudo leer la configuración de memoria.")).toHaveAttribute(
			"role",
			"alert",
		);
		expect(screen.getByRole("button", { name: "Cambiar" })).toBeDisabled();
		expect(screen.getByRole("switch", { name: "Memoria privada" })).toBeDisabled();
		expect(invoked("shortcut_set")).toHaveLength(0);
		expect(invoked("memory_set")).toHaveLength(0);
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Idioma de la interfaz" }), "en");
		expect(screen.getByText("Gentle Dot could not read the current shortcut.")).toHaveAttribute(
			"role",
			"alert",
		);
		expect(screen.getByText("Gentle Dot could not read the memory setting.")).toHaveAttribute(
			"role",
			"alert",
		);
	});

	it("keeps non-Mac modifiers and Spanish recording cancellation behavior", async () => {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINUX_AGENT);
		await openSettings();
		await screen.findByText("Alt+Space");
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Interface language" }), "es");
		expect(screen.getByText(/Usa al menos una tecla modificadora/)).toHaveTextContent(
			"Super, Alt, Ctrl, Shift",
		);
		await userEvent.click(screen.getByRole("button", { name: "Cambiar" }));
		fireEvent.keyDown(window, { key: "Alt", code: "AltLeft", altKey: true });
		expect(screen.getByText("Pulsa el nuevo atajo… Esc cancela.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Restablecer predeterminado" })).toBeDisabled();
		fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
		expect(screen.getByRole("region", { name: "Ajustes" })).toBeInTheDocument();
		expect(invoked("shortcut_set")).toHaveLength(0);
		expect(invoked("hide_panel")).toHaveLength(0);
	});
});

describe("voice language (S30.6)", () => {
	it("does not offer macOS voice language on Windows", async () => {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
		await openSettings();
		expect(screen.queryByRole("combobox", { name: "Voice language" })).toBeNull();
	});
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
		expect(
			screen.getByText("Saved. It works right away.", { selector: '[role="status"]' }),
		).toBeInTheDocument();
	});

	it("shows that the change is pending until the app answers", async () => {
		let answer: (value: unknown) => void = () => {};
		h.setResult = () => new Promise((resolve) => (answer = resolve));
		await startRecording();
		fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true, shiftKey: true });
		expect(await screen.findByText("Applying ⇧⌘K…", { selector: '[role="status"]' })).toBeInTheDocument();
		await act(async () => answer({ shortcut: "Shift+Super+K" }));
		expect(
			screen.getByText("Saved. It works right away.", { selector: '[role="status"]' }),
		).toBeInTheDocument();
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

it("does not load or expose the retired debug preference", async () => {
	await openSettings();
	await screen.findByText("⌥ Space");
	expect(screen.queryByRole("switch", { name: "debug" })).toBeNull();
	expect(invoked("debug_get")).toEqual([]);
	expect(invoked("debug_set")).toEqual([]);
	expect(invoked("restart_daemon")).toEqual([]);
});
