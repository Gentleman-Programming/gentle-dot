import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY } from "../src/i18n.tsx";
import { type DotState, initialState } from "../src/store.ts";
import type { VoiceControls } from "../src/useVoice.ts";

const h = vi.hoisted(() => ({
	desktop: false,
	reason: "",
	pending: false,
	state: undefined as unknown as DotState,
	send: vi.fn(),
	dispatch: vi.fn(),
	dismiss: vi.fn(),
	setMuted: vi.fn(),
	setRoseHidden: vi.fn(),
	setFullscreen: vi.fn(),
}));
vi.mock("../src/desktop.ts", async (original) => ({
	...(await original<typeof import("../src/desktop.ts")>()),
	inDesktop: () => h.desktop,
	connectionInfo: async () => {
		if (h.pending) return new Promise<never>(() => {});
		throw h.reason;
	},
	hidePanel: async () => {
		throw new Error("native reason unchanged");
	},
	onDesktopEvent: async () => () => {},
}));
vi.mock("../src/useDot.ts", () => ({
	useDot: () => ({ state: h.state, send: h.send, dispatch: h.dispatch, dismiss: h.dismiss }),
}));
vi.mock("../src/useComputer.ts", () => ({ useComputerAvailable: () => false, useComputerState: () => ({}) }));
vi.mock("../src/usePanelWindow.ts", () => ({
	usePanelWindow: () => ({
		fullscreenNow: { current: false },
		controls: {
			roseHidden: false,
			fullscreen: false,
			setRoseHidden: h.setRoseHidden,
			setFullscreen: h.setFullscreen,
		},
	}),
}));
const voice: VoiceControls = {
	mic: { available: true },
	phase: "idle",
	elapsed: 0,
	level: 0,
	partial: "",
	speaking: false,
	muted: false,
	sendOnStop: false,
	setMuted: h.setMuted,
	start() {},
	stop() {},
	cancel() {},
	stopSpeaking() {},
	typed() {},
	setSendOnStop() {},
	draftTaken() {},
	sent() {},
};
vi.mock("../src/useVoice.ts", () => ({ useVoice: () => voice }));

const ready: DotState = {
	...initialState,
	connection: "open",
	agentState: "idle",
	features: { conversations: true },
};
const controls = {
	roseHidden: false,
	fullscreen: false,
	setRoseHidden: h.setRoseHidden,
	setFullscreen: h.setFullscreen,
};
function chat(state = ready, toggled = false) {
	return (
		<LocaleProvider>
			<ChatSurface
				variant="panel"
				state={state}
				send={h.send}
				dispatch={h.dispatch}
				dismiss={h.dismiss}
				onHide={hide}
				settings
				panelWindow={{ ...controls, roseHidden: toggled, fullscreen: toggled }}
			/>
		</LocaleProvider>
	);
}
const hide = vi.fn();
beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	localStorage.setItem(UI_LANGUAGE_KEY, "es");
	h.desktop = false;
	h.reason = "";
	h.pending = false;
	h.state = ready;
	voice.muted = false;
	window.history.replaceState(null, "", "/");
});
afterEach(() => {
	localStorage.clear();
	window.sessionStorage.clear();
	window.history.replaceState(null, "", "/");
});

describe("Spanish chat chrome (T2)", () => {
	it("localizes header names/tooltips and preserves navigation commands and hide", async () => {
		render(chat());
		for (const name of [
			"Conversaciones",
			"Cuentas",
			"Perfiles",
			"Conectores",
			"Nueva conversación",
			"Ajustes",
			"Ocultar",
		]) {
			expect(screen.getByRole("button", { name })).toHaveAttribute("title", name);
		}
		for (const [name, command, action] of [
			["Cuentas", "auth_list", "accounts"],
			["Perfiles", "profiles_list", "profiles"],
			["Conectores", "connectors_list", "connectors"],
		]) {
			await userEvent.click(screen.getByRole("button", { name }));
			expect(h.send).toHaveBeenLastCalledWith({ type: command });
			expect(h.dispatch).toHaveBeenLastCalledWith({ type: action, open: true });
		}
		await userEvent.click(screen.getByRole("button", { name: "Nueva conversación" }));
		expect(h.send).toHaveBeenLastCalledWith({ type: "new_conversation" });
		await userEvent.click(screen.getByRole("button", { name: "Ajustes" }));
		expect(screen.getByRole("region", { name: "Ajustes" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Ocultar" }));
		expect(hide).toHaveBeenCalledOnce();
	});

	it("localizes missing titles/empty navigation, never real titles even equal to the English fallback", async () => {
		const view = render(chat());
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Nueva conversación");
		await userEvent.click(screen.getByRole("button", { name: "Conversaciones" }));
		expect(h.send).toHaveBeenLastCalledWith({ type: "list_conversations" });
		const nav = screen.getByRole("navigation", { name: "Conversaciones anteriores" });
		expect(nav).toHaveTextContent("Conversaciones");
		expect(nav).toHaveTextContent("Aún no hay conversaciones.");
		const first = { id: "a", title: "New conversation", updatedAt: "2026-01-01T00:00:00Z" };
		const conversations = [first, { id: "b", title: "My exact title", updatedAt: "2026-01-02T00:00:00Z" }];
		view.rerender(chat({ ...ready, conversationId: "a", conversations }));
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("New conversation");
		expect(nav.querySelector("time")).toHaveAttribute("dateTime", first.updatedAt);
		await userEvent.click(within(nav).getByRole("button", { name: /My exact title/ }));
		expect(h.send).toHaveBeenLastCalledWith({ type: "open_conversation", conversationId: "b" });
		expect(first.title).toBe("New conversation");
		view.rerender(chat({ ...ready, conversationId: "a", conversations: [{ ...first, title: "" }] }));
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("");
	});

	it.each([
		[
			"unauthorized",
			"idle",
			"Esta clave de acceso ya no es válida. Abre la página de nuevo desde el menú de Gentle Dot (Abrir en el navegador).",
		],
		["closed", "idle", "Reconectando con el asistente…"],
		["connecting", "idle", "Conectando…"],
		["open", "restarting", "El asistente se está reiniciando…"],
		["open", "starting", "Iniciando el asistente…"],
	] as const)("localizes %s/%s and keeps actions disabled", (connection, agentState, text) => {
		render(chat({ ...ready, connection, agentState, interrupted: true }));
		expect(screen.getByRole("status")).toHaveTextContent(text);
		expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Nueva conversación" })).toBeDisabled();
	});

	it.each(["es", "en"])("keeps the exact continuation payload in %s", async (locale) => {
		localStorage.setItem(UI_LANGUAGE_KEY, locale);
		render(chat({ ...ready, interrupted: true }));
		expect(screen.queryByRole("status")).toBeNull();
		expect(
			screen.getByText(locale === "es" ? "Me interrumpieron. ¿Continuar?" : "I was interrupted. Continue?"),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: locale === "es" ? "Continuar" : "Continue" }));
		expect(h.send.mock.calls).toEqual([
			[{ type: "send", text: "Continue where you left off.", requestId: expect.any(String) }],
		]);
		expect(h.send.mock.calls[0]?.[0].requestId.length).toBeGreaterThan(0);
	});

	it("localizes onboarding and dispatches only the account-list/open actions", async () => {
		render(chat({ ...ready, auth: { open: false, providers: [] } }));
		expect(
			screen.getByText(
				"Para empezar, conecta el servicio de IA que usas (una suscripción o una clave de API).",
			),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Conectar una cuenta de IA" }));
		expect(h.send.mock.calls).toEqual([[{ type: "auth_list" }]]);
		expect(h.dispatch.mock.calls).toEqual([[{ type: "accounts", open: true }]]);
	});

	it("localizes stop/switch confirmation; cancel sends nothing and confirm keeps the command", async () => {
		render(chat({ ...ready, agentState: "thinking" }));
		await userEvent.click(screen.getByRole("button", { name: "Nueva conversación" }));
		const dialog = screen.getByRole("alertdialog", { name: "¿Detener y cambiar?" });
		expect(dialog).toHaveTextContent(
			"El asistente sigue respondiendo. ¿Detenerlo y abrir la otra conversación?",
		);
		await userEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
		expect(h.send).not.toHaveBeenCalled();
		expect(screen.queryByRole("alertdialog")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Nueva conversación" }));
		await userEvent.click(screen.getByRole("button", { name: "Detener y cambiar" }));
		expect(h.send.mock.calls).toEqual([[{ type: "new_conversation" }]]);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("keeps an existing conversation id through the busy switch confirmation", async () => {
		render(
			chat({
				...ready,
				agentState: "working",
				conversationId: "a",
				conversations: [
					{ id: "a", title: "Current data", updatedAt: "2026-01-01T00:00:00Z" },
					{ id: "b", title: "Target data", updatedAt: "2026-01-02T00:00:00Z" },
				],
			}),
		);
		await userEvent.click(screen.getByRole("button", { name: "Conversaciones" }));
		await userEvent.click(screen.getByRole("button", { name: /Target data/ }));
		expect(h.send.mock.calls).toEqual([[{ type: "list_conversations" }]]);
		await userEvent.click(screen.getByRole("button", { name: "Detener y cambiar" }));
		expect(h.send).toHaveBeenLastCalledWith({ type: "open_conversation", conversationId: "b" });
	});

	it("translates dismissal only, preserving the native/backend notice body and id", async () => {
		render(
			chat({ ...ready, notices: [{ id: 17, level: "error", message: "Backend reason: do not translate" }] }),
		);
		expect(screen.getByText("Backend reason: do not translate")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Descartar" }));
		expect(h.dismiss.mock.calls).toEqual([[17]]);
	});

	it("localizes both toggle states, keeping boolean values, shortcut and pressed state", async () => {
		const view = render(chat());
		for (const [name, setter] of [
			["Silenciar las respuestas habladas", h.setMuted],
			["Ocultar la rosa", h.setRoseHidden],
			["Pantalla completa", h.setFullscreen],
		] as const) {
			const button = screen.getByRole("button", { name });
			expect(button).toHaveAttribute("title", name === "Pantalla completa" ? `${name} (⌘⇧F)` : name);
			await userEvent.click(button);
			expect(setter).toHaveBeenLastCalledWith(true);
		}
		voice.muted = true;
		view.rerender(chat(ready, true));
		for (const [name, setter] of [
			["Activar las respuestas habladas", h.setMuted],
			["Mostrar la rosa", h.setRoseHidden],
			["Salir de pantalla completa", h.setFullscreen],
		] as const) {
			const button = screen.getByRole("button", { name });
			expect(button).toHaveAttribute("title", name.startsWith("Salir") ? `${name} (⌘⇧F)` : name);
			if (setter !== h.setRoseHidden) expect(button).toHaveAttribute("aria-pressed", "true");
			await userEvent.click(button);
			expect(setter).toHaveBeenLastCalledWith(false);
		}
	});

	it("reacts to locale updates without sending commands", () => {
		render(chat());
		act(() => window.dispatchEvent(new StorageEvent("storage", { key: UI_LANGUAGE_KEY, newValue: "en" })));
		expect(screen.getByRole("button", { name: "Accounts" })).toHaveAttribute("title", "Accounts");
		expect(h.send).not.toHaveBeenCalled();
	});
});

describe("App-owned wrappers", () => {
	it("localizes missing browser access-key guidance", async () => {
		render(<App />);
		expect(await screen.findByRole("status")).toHaveTextContent(
			"Esta página necesita tu clave de acceso. En tu ordenador, ábrela desde el menú de Gentle Dot (Abrir en el navegador); en un servidor, abre el enlace con #token=<tu clave de acceso>.",
		);
	});
	it("does not translate the desktop connection reason", async () => {
		h.desktop = true;
		h.reason = "Native connection reason unchanged";
		window.history.replaceState(null, "", "/?surface=panel");
		render(<App />);
		expect(await screen.findByRole("status")).toHaveTextContent(h.reason);
	});
	it.each(["en", "es"] as const)(
		"keeps every raw hide-action field and adds display provenance in %s",
		async (locale) => {
			localStorage.setItem(UI_LANGUAGE_KEY, locale);
			window.history.replaceState(null, "", "/?surface=panel");
			// A pending synthetic connection leaves the panel visible without any transport.
			h.desktop = true;
			h.pending = true;
			const view = render(<App />);
			await userEvent.click(screen.getByRole("button", { name: locale === "es" ? "Ocultar" : "Hide" }));
			expect(h.dispatch.mock.calls).toEqual([
				[
					{
						type: "notice",
						level: "error",
						message: `${locale === "es" ? "No se pudo ocultar el chat:" : "Could not hide the chat:"} Error: native reason unchanged`,
						display: { kind: "hideFailed", reason: "Error: native reason unchanged" },
					},
				],
			]);
			act(() =>
				window.dispatchEvent(
					new StorageEvent("storage", { key: UI_LANGUAGE_KEY, newValue: locale === "es" ? "en" : "es" }),
				),
			);
			expect(h.dispatch).toHaveBeenCalledOnce();
			view.unmount();
		},
	);
});
