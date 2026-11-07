import { APP_REQUIRED, type ConnectorDraft } from "@gentle-dot/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectorDraftCard } from "../src/components/ConnectorDraftCard.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY } from "../src/i18n.tsx";

afterEach(() => localStorage.clear());
const language = (locale: "en" | "es") => {
	localStorage.clear();
	if (locale === "es") localStorage.setItem(UI_LANGUAGE_KEY, locale);
};

it.each(["en", "es"] as const)(
	"renders an HTTP draft in %s with raw data and exact desktop approval",
	async (locale) => {
		language(locale);
		const draft: ConnectorDraft = {
			draftId: "draft$&",
			name: "None $&",
			description: "New connector",
			transport: "http",
			url: "https://example.test/$&",
			envNames: ["None"],
			needsOAuth: true,
		};
		const before = structuredClone(draft);
		const send = vi.fn(),
			appSend = vi.fn(),
			approved = vi.fn();
		render(
			<LocaleProvider>
				<ConnectorDraftCard draft={draft} send={send} appSend={appSend} approved={approved} />
			</LocaleProvider>,
		);
		const storage = JSON.stringify({ ...localStorage });
		const card = within(
			screen.getByRole("region", { name: locale === "es" ? "¿Añadir None $&?" : "Add None $&?" }),
		);
		expect(
			card.getByText(locale === "es" ? "Nuevo conector" : "New connector", { selector: ".eyebrow" }),
		).toBeInTheDocument();
		expect(card.getByText(locale === "es" ? "Inicio de sesión" : "Sign-in")).toBeInTheDocument();
		expect(
			card.getByText(
				locale === "es"
					? "Escribes cada secreto en la aplicación, nunca en el chat. Empieza en modo de solo lectura, con todas sus herramientas ocultas."
					: "You type each secret in the app, never in the chat. It starts read only, with all of its tools hidden.",
			),
		).toBeInTheDocument();
		expect(card.getByText(locale === "es" ? "Dirección" : "Address")).toBeInTheDocument();
		expect(card.getByText(locale === "es" ? "Secretos necesarios" : "Secrets it needs")).toBeInTheDocument();
		expect(card.getByText("https://example.test/$&")).toBeInTheDocument();
		expect(card.getByText("None", { exact: true })).toBeInTheDocument();
		expect(card.getAllByText("New connector").length).toBe(locale === "es" ? 1 : 2);
		expect(
			card.getByText(
				locale === "es"
					? "Inicias sesión en la página del propio servicio."
					: "You sign in on the service's own page.",
			),
		).toBeInTheDocument();
		expect(card.queryByText(APP_REQUIRED)).toBeNull();
		await userEvent.click(
			card.getByRole("button", { name: locale === "es" ? "Añadir None $&" : "Add None $&" }),
		);
		expect(appSend.mock.calls).toEqual([
			[{ type: "connector_draft_reply", draftId: "draft$&", approve: true }],
		]);
		expect(send).not.toHaveBeenCalled();
		expect(approved).toHaveBeenCalledExactlyOnceWith();
		expect(draft).toEqual(before);
		expect(JSON.stringify({ ...localStorage })).toBe(storage);
	},
);

it.each(["en", "es"] as const)(
	"renders a stdio draft in %s while web approval stays disabled and decline stays exact",
	async (locale) => {
		language(locale);
		const draft: ConnectorDraft = {
			draftId: "stdio-id",
			name: "Server",
			description: "",
			transport: "stdio",
			command: "runner",
			args: ["--token", "$&"],
			envNames: [],
			needsOAuth: false,
		};
		const before = structuredClone(draft),
			send = vi.fn(),
			approved = vi.fn();
		render(
			<LocaleProvider>
				<ConnectorDraftCard draft={draft} send={send} approved={approved} />
			</LocaleProvider>,
		);
		const storage = JSON.stringify({ ...localStorage });
		expect(
			screen.getByText(locale === "es" ? "Se ejecuta en este equipo" : "Runs on this computer"),
		).toBeInTheDocument();
		expect(screen.getByText("runner --token $&")).toBeInTheDocument();
		expect(screen.getByText(locale === "es" ? "Ninguno" : "None")).toBeInTheDocument();
		expect(screen.getByText(APP_REQUIRED)).toBeInTheDocument();
		expect(screen.queryByText(locale === "es" ? "Inicio de sesión" : "Sign-in")).toBeNull();
		expect(
			screen.queryByText(
				locale === "es"
					? "Inicias sesión en la página del propio servicio."
					: "You sign in on the service's own page.",
			),
		).toBeNull();
		const add = screen.getByRole("button", { name: locale === "es" ? "Añadir Server" : "Add Server" });
		expect(add).toBeDisabled();
		await userEvent.click(add);
		expect(send).not.toHaveBeenCalled();
		expect(approved).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: locale === "es" ? "Rechazar" : "Decline" }));
		expect(send.mock.calls).toEqual([
			[{ type: "connector_draft_reply", draftId: "stdio-id", approve: false }],
		]);
		expect(approved).not.toHaveBeenCalled();
		expect(draft).toEqual(before);
		expect(JSON.stringify({ ...localStorage })).toBe(storage);
	},
);
