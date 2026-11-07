import type { Ask, ClientMessage, ConnectorInfo } from "@gentle-dot/protocol";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskCard } from "../src/components/AskCard.tsx";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { describePinCommand } from "../src/components/PinForm.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY } from "../src/i18n.tsx";
import { controlEs } from "../src/i18n-control-messages.ts";
import { type DotState, initialState } from "../src/store.ts";

const PIN = "731942";
const ask: Ask = {
	requestId: "request-English",
	method: "confirm",
	title: "Approve English title?",
	message: "Backend detail: https://example.test/path?pin=unchanged",
};
const connector: ConnectorInfo = {
	id: "notion",
	name: "Notion",
	reads: "Read pages",
	sends: "Write pages",
	added: true,
	enabled: true,
	mode: "read_only",
	status: "connected",
};
beforeEach(() => {
	localStorage.clear();
	localStorage.setItem(UI_LANGUAGE_KEY, "es");
});
afterEach(() => localStorage.clear());

function card(overrides: Partial<Ask> = {}, pin?: { set: boolean; locked?: boolean }) {
	const send = vi.fn();
	render(
		<LocaleProvider>
			<AskCard ask={{ ...ask, ...overrides }} send={send} {...(pin ? { pin } : {})} />
		</LocaleProvider>,
	);
	return send;
}

describe("Spanish authored answer controls", () => {
	it("preserves supplied title/details and exact yes/no/skip responses", async () => {
		const send = card();
		expect(screen.getByLabelText("El asistente necesita su respuesta")).toBeInTheDocument();
		expect(screen.getByText(ask.title)).toBeInTheDocument();
		expect(screen.getByLabelText("Detalles")).toHaveTextContent(ask.message!);
		await userEvent.click(screen.getByRole("button", { name: "Sí" }));
		await userEvent.click(screen.getByRole("button", { name: "No" }));
		await userEvent.click(screen.getByRole("button", { name: "Omitir" }));
		expect(send.mock.calls).toEqual([
			[{ type: "ui_response", requestId: ask.requestId, confirmed: true }],
			[{ type: "ui_response", requestId: ask.requestId, confirmed: false }],
			[{ type: "ui_response", requestId: ask.requestId, cancelled: true }],
		]);
	});

	it.each(["input", "editor"] as const)(
		"preserves %s prefill, placeholder and submitted text",
		async (method) => {
			const send = card({ method, prefill: "English prefill", placeholder: "English placeholder" });
			const input = screen.getByRole("textbox", { name: ask.title });
			expect(input).toHaveValue("English prefill");
			if (method === "input") {
				expect(input).toHaveAttribute("placeholder", "English placeholder");
			}
			await userEvent.type(input, " / comando ñ");
			await userEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
			expect(send.mock.calls).toEqual([
				[{ type: "ui_response", requestId: ask.requestId, value: "English prefill / comando ñ" }],
			]);
		},
	);

	it("keeps option display and protocol values verbatim", async () => {
		const send = card({ method: "select", options: ["Yes", "English option"] });
		await userEvent.click(screen.getByRole("button", { name: "Yes" }));
		expect(send.mock.calls).toEqual([[{ type: "ui_response", requestId: ask.requestId, value: "Yes" }]]);
	});

	it("waits for the app without adding actionable controls", () => {
		const send = card({ method: "app" });
		expect(screen.getByLabelText("Esperando su respuesta en la aplicación")).toHaveTextContent(
			"Necesita su respuesta",
		);
		expect(screen.queryByRole("button")).toBeNull();
		expect(send).not.toHaveBeenCalled();
	});
});

describe("Spanish PIN validation and approval", () => {
	it("rejects boundaries and mismatch without changing storage or sending; then creates and approves exactly once", async () => {
		const send = card({ method: "pin" }, { set: false });
		const stored = { ...localStorage };
		const value = screen.getByLabelText("Nuevo PIN");
		const repeat = screen.getByLabelText("Repita el PIN");
		const submit = screen.getByRole("button", { name: "Permitir" });
		expect(value).toHaveAttribute("type", "password");
		expect(value).toHaveAttribute("inputmode", "numeric");
		expect(screen.getByText(/El asistente nunca lo ve/)).toBeInTheDocument();
		for (const invalid of ["", "12345", "1234567890123", "12345a", " 123456"]) {
			fireEvent.change(value, { target: { value: invalid } });
			await userEvent.click(submit);
			expect(screen.getByRole("alert")).toHaveTextContent("Use entre 6 y 12 dígitos.");
			expect(value).toHaveValue(invalid);
			expect(send).toHaveBeenCalledTimes(0);
			expect({ ...localStorage }).toEqual(stored);
		}
		fireEvent.change(value, { target: { value: PIN } });
		fireEvent.change(repeat, { target: { value: "000000" } });
		await userEvent.click(submit);
		expect(screen.getByRole("alert")).toHaveTextContent("Los dos PIN no coinciden.");
		expect(send).toHaveBeenCalledTimes(0);
		expect({ ...localStorage }).toEqual(stored);
		expect(value).toHaveValue(PIN);
		expect(repeat).toHaveValue("000000");
		fireEvent.change(repeat, { target: { value: PIN } });
		await userEvent.click(submit);
		expect(send.mock.calls).toEqual([
			[{ type: "pin_set", pin: PIN }],
			[{ type: "pin_approve", requestId: ask.requestId, pin: PIN }],
		]);
		expect(value).toHaveValue("");
		expect(repeat).toHaveValue("");
	});

	it.each(["123456", "123456789012"])(
		"accepts existing PIN boundary %s and denies without a PIN",
		async (value) => {
			const send = card({ method: "pin" }, { set: true, locked: true });
			expect(screen.getByText("Demasiados PIN incorrectos. Inténtelo más tarde.")).toBeInTheDocument();
			await userEvent.type(screen.getByLabelText("PIN"), value);
			await userEvent.click(screen.getByRole("button", { name: "Permitir" }));
			await userEvent.click(screen.getByRole("button", { name: "Denegar" }));
			expect(send.mock.calls).toEqual([
				[{ type: "pin_approve", requestId: ask.requestId, pin: value }],
				[{ type: "ui_response", requestId: ask.requestId, confirmed: false }],
			]);
		},
	);
});

it.each([false, true])(
	"localizes the ChatSurface PIN wrapper (set=%s) without altering command or state",
	async (set) => {
		const send = vi.fn();
		const dispatch = vi.fn();
		const state: DotState = {
			...initialState,
			connection: "open",
			pin: { set },
			connectors: { ...initialState.connectors, list: [connector], open: true },
		};
		const snapshot = structuredClone(state);
		render(
			<LocaleProvider>
				<ChatSurface variant="web" state={state} send={send} dispatch={dispatch} dismiss={vi.fn()} />
			</LocaleProvider>,
		);
		await userEvent.click(screen.getByRole("radio", { name: "Leer y enviar" }));
		let dialog = screen.getByRole("dialog", { name: set ? "Introduzca su PIN" : "Cree un PIN" });
		expect(within(dialog).getByText("¿Cambiar Notion a lectura y envío?")).toBeInTheDocument();
		const stored = { ...localStorage };
		await userEvent.click(within(dialog).getByRole("button", { name: "Continuar" }));
		expect(send.mock.calls).toEqual([]);
		expect(dispatch.mock.calls).toEqual([]);
		expect(state).toEqual(snapshot);
		expect({ ...localStorage }).toEqual(stored);
		await userEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(send.mock.calls).toEqual([]);
		expect(dispatch.mock.calls).toEqual([
			[
				{
					type: "server",
					message: { type: "error", code: "declined", message: "Nothing was changed.", seq: 0 },
					display: { kind: "pinCancelled" },
				},
			],
		]);
		await userEvent.click(screen.getByRole("radio", { name: "Leer y enviar" }));
		dialog = screen.getByRole("dialog");
		await userEvent.type(within(dialog).getByLabelText(set ? "PIN" : "Nuevo PIN"), PIN);
		if (!set) {
			await userEvent.type(within(dialog).getByLabelText("Repita el PIN"), PIN);
		}
		await userEvent.click(within(dialog).getByRole("button", { name: "Continuar" }));
		expect(send.mock.calls.map(([message]) => message)).toEqual([
			...(!set ? [{ type: "pin_set", pin: PIN }] : []),
			{
				type: "pin_command",
				pin: PIN,
				command: { type: "connector_mode", connectorId: "notion", mode: "read_write" },
			},
		]);
		expect(state).toEqual(snapshot);
	},
);

it("keeps pure confirmations faithful in Spanish and default English, including unknown IDs", () => {
	const cases: [ClientMessage, string, string][] = [
		[
			{ type: "connector_mode", connectorId: "notion", mode: "read_write" },
			"Switch Notion to read and send?",
			"¿Cambiar Notion a lectura y envío?",
		],
		[
			{ type: "connector_mode", connectorId: "notion", mode: "read_only" },
			"Switch Notion to read only?",
			"¿Cambiar Notion a solo lectura?",
		],
		...(["connector_connect", "connector_signin", "connector_setup"] as const).map(
			(type): [ClientMessage, string, string] => [
				{ type, connectorId: "notion" },
				"Connect Notion?",
				"¿Conectar Notion?",
			],
		),
		[{ type: "connector_disconnect", connectorId: "notion" }, "Disconnect Notion?", "¿Desconectar Notion?"],
		[{ type: "connector_remove", connectorId: "raw-ID" }, "Remove raw-ID?", "¿Eliminar raw-ID?"],
		[
			{ type: "connector_draft_reply", draftId: "draft", approve: true },
			"Add the connector the assistant drafted?",
			"¿Añadir el conector que preparó el asistente?",
		],
		[{ type: "connector_import", ids: ["raw-ID"] }, "Import 1 server?", "¿Importar 1 servidor?"],
		[{ type: "connector_import", ids: [] }, "Import 0 servers?", "¿Importar 0 servidores?"],
		[{ type: "connector_import", ids: ["a", "b"] }, "Import 2 servers?", "¿Importar 2 servidores?"],
		[{ type: "auth_list" }, "Change your connectors?", "¿Cambiar sus conectores?"],
	];
	for (const [message, english, spanish] of cases) {
		const snapshot = structuredClone(message);
		expect(describePinCommand(message, [connector])).toBe(english);
		expect(describePinCommand(message, [connector], (key) => controlEs[key])).toBe(spanish);
		expect(message).toEqual(snapshot);
	}
	const command: ClientMessage = { type: "connector_connect", connectorId: "raw-ID" };
	expect(describePinCommand(command)).toBe("Connect raw-ID?");
	const namedCommand: ClientMessage = {
		type: "connector_mode",
		connectorId: connector.id,
		mode: "read_write",
	};
	const suppliedName = "English $& {mode} {name}";
	expect(
		describePinCommand(namedCommand, [{ ...connector, name: suppliedName }], (key) => controlEs[key]),
	).toBe(`¿Cambiar ${suppliedName} a lectura y envío?`);
});
