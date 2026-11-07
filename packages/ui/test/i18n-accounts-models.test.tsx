import { THINKING_LEVELS } from "@gentle-dot/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountsPanel, FlowEvent, FlowPrompt } from "../src/components/AccountsPanel.tsx";
import { ModelPicker } from "../src/components/ModelPicker.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY } from "../src/i18n.tsx";
import type { AuthState, ModelsState } from "../src/store.ts";

const providers: AuthState["providers"] = [
	{
		id: "plan-id",
		name: "Provider Original",
		oauthName: "Plan Original",
		methods: ["oauth"],
		configured: true,
		source: "stored",
	},
	{
		id: "key-id",
		name: "Key Original",
		methods: ["api_key"],
		configured: true,
		source: "env",
	},
];

function panel(auth: AuthState = { open: true, providers }) {
	const send = vi.fn();
	const dispatch = vi.fn();
	const openUrl = vi.fn();
	const view = render(
		<LocaleProvider>
			<AccountsPanel auth={auth} send={send} dispatch={dispatch} openUrl={openUrl} />
		</LocaleProvider>,
	);
	return { ...view, send, dispatch, openUrl };
}

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem(UI_LANGUAGE_KEY, "es");
});
afterEach(() => localStorage.clear());

const modelState: ModelsState = {
	current: { provider: "provider-id", id: "model-id", name: "Model Original", thinking: "medium" },
	groups: [
		{
			provider: "provider-id",
			name: "Provider Original",
			models: [
				{
					provider: "provider-id",
					id: "model-id",
					name: "Model Original",
					images: true,
					thinkingLevels: [...THINKING_LEVELS],
				},
				{
					provider: "other-id",
					id: "other-model",
					name: "Other Original",
					images: false,
					thinkingLevels: ["medium"],
				},
				{ provider: "plain-id", id: "plain-model", name: "Plain Original", images: false },
			],
		},
	],
	profiles: [{ name: "Profile Original", model: "provider-id/model-id" }],
	activeProfile: "Profile Original",
};

function picker(models: ModelsState = modelState) {
	const send = vi.fn();
	const dispatch = vi.fn();
	const view = render(
		<LocaleProvider>
			<ModelPicker models={models} send={send} dispatch={dispatch} />
		</LocaleProvider>,
	);
	return { ...view, send, dispatch };
}

const modelLabels = {
	es: {
		chip: "Modelo: Model Original",
		choose: "Elegir un modelo",
		search: "Buscar modelos",
		list: "Modelos",
		profiles: "Perfiles",
		thinking: "Razonamiento",
		inUse: "En uso",
	},
	en: {
		chip: "Model: Model Original",
		choose: "Choose a model",
		search: "Search models",
		list: "Models",
		profiles: "Profiles",
		thinking: "Thinking",
		inUse: "In use",
	},
};

describe.each(["es", "en"] as const)("ModelPicker %s display and unchanged protocol boundaries", (locale) => {
	beforeEach(() => localStorage.setItem(UI_LANGUAGE_KEY, locale));

	it("preserves displayed provider/model/profile data and exact model, profile and thinking messages", async () => {
		const labels = modelLabels[locale];
		const snapshot = JSON.stringify(modelState);
		const { send, dispatch } = picker();
		const chip = screen.getByRole("button", { name: labels.chip });
		expect(chip).toHaveAttribute("title", locale === "es" ? "Cambiar el modelo" : "Change the model");
		await userEvent.click(chip);
		const dialog = screen.getByRole("dialog", { name: labels.choose });
		const search = within(dialog).getByRole("searchbox", { name: labels.search });
		expect(search).toHaveAttribute("placeholder", labels.search);
		expect(search).toHaveFocus();
		const list = screen.getByRole("listbox", { name: labels.list });
		expect(
			within(list)
				.getAllByRole("group")
				.map((g) => g.getAttribute("aria-label")),
		).toEqual(["Provider Original", labels.profiles]);
		expect(
			within(list)
				.getAllByRole("option")
				.map((o) => o.textContent),
		).toEqual([
			`Model Original${labels.inUse}`,
			"Other Original",
			"Plain Original",
			`Profile Originalprovider-id/model-id${labels.inUse}`,
		]);
		const thinking = screen.getByRole("combobox", { name: labels.thinking });
		expect(
			within(thinking)
				.getAllByRole("option")
				.map((o) => [o.getAttribute("value"), o.textContent]),
		).toEqual(
			THINKING_LEVELS.map((level, i) => [
				level,
				locale === "es" ? ["Desactivado", "Mínimo", "Bajo", "Medio", "Alto", "Muy alto", "Máximo"][i] : level,
			]),
		);
		for (const level of THINKING_LEVELS) await userEvent.selectOptions(thinking, level);
		await userEvent.type(search, "  other-MODEL  ");
		expect(search).toHaveValue("  other-MODEL  ");
		expect(within(list).getAllByRole("option")).toHaveLength(1);
		await userEvent.keyboard("{Enter}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(chip).toHaveFocus();
		await userEvent.click(chip);
		expect(screen.getByRole("searchbox")).toHaveValue("");
		await userEvent.click(screen.getByRole("option", { name: "Plain Original" }));
		await userEvent.click(chip);
		await userEvent.click(screen.getByRole("option", { name: /^Profile Original/ }));
		expect(send.mock.calls).toEqual([
			[{ type: "models_list" }],
			...THINKING_LEVELS.map((thinking) => [
				{ type: "model_set", provider: "provider-id", id: "model-id", thinking },
			]),
			[{ type: "model_set", provider: "other-id", id: "other-model", thinking: "medium" }],
			[{ type: "models_list" }],
			[{ type: "model_set", provider: "plain-id", id: "plain-model" }],
			[{ type: "models_list" }],
			[{ type: "profile_apply", name: "Profile Original" }],
		]);
		expect(dispatch.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ type: "models_opened" }]));
		expect(JSON.stringify(modelState)).toBe(snapshot);
	});

	it("keeps deferred model and backend error text intact while translating their surrounding chrome", async () => {
		const labels = modelLabels[locale];
		const state: ModelsState = {
			...modelState,
			next: { provider: "next-id", id: "next-model", name: "Next Original" },
			error: "Backend error Original",
		};
		const { send, dispatch } = picker(state);
		await userEvent.click(
			screen.getByRole("button", {
				name: locale === "es" ? "Modelo: Next Original" : "Model: Next Original",
			}),
		);
		expect(
			screen.getByText(
				locale === "es"
					? "Next Original se usará a partir de tu próximo mensaje."
					: "Next Original is used from your next message.",
			),
		).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("Backend error Original");
		await userEvent.type(screen.getByRole("searchbox", { name: labels.search }), "No-Match Original");
		expect(
			screen.getByText(locale === "es" ? "No hay modelos que coincidan." : "No models match."),
		).toBeInTheDocument();
		await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");
		expect(send.mock.calls).toEqual([[{ type: "models_list" }]]);
		expect(dispatch.mock.calls).toEqual([[{ type: "models_opened" }]]);
	});

	it("preserves literal replacement tokens and explicitly empty model names", async () => {
		const name = "$& {model} Original";
		const state: ModelsState = { ...modelState, next: { provider: "next-id", id: "next-model", name } };
		const { send, dispatch, rerender } = picker(state);
		await userEvent.click(
			screen.getByRole("button", { name: `${locale === "es" ? "Modelo" : "Model"}: ${name}` }),
		);
		expect(
			screen.getByText(
				locale === "es"
					? `${name} se usará a partir de tu próximo mensaje.`
					: `${name} is used from your next message.`,
			),
		).toBeInTheDocument();
		rerender(
			<LocaleProvider>
				<ModelPicker
					models={{ ...state, next: { provider: "next-id", id: "next-model", name: "" } }}
					send={send}
					dispatch={dispatch}
					disabled
				/>
			</LocaleProvider>,
		);
		const chip = screen.getByRole("button", { name: locale === "es" ? "Modelo:" : "Model:" });
		expect(chip).toBeDisabled();
		expect(chip.querySelector(".model-chip-name")).toBeEmptyDOMElement();
		expect(send.mock.calls).toEqual([[{ type: "models_list" }]]);
		expect(dispatch.mock.calls).toEqual([[{ type: "models_opened" }]]);
	});

	it("translates unchosen and loading states without inventing choices or thinking controls", async () => {
		const { send, dispatch } = picker({ profiles: [] });
		const chip = screen.getByRole("button", {
			name: locale === "es" ? "Modelo: sin elegir" : "Model: not chosen",
		});
		expect(chip).toHaveTextContent(modelLabels[locale].choose);
		await userEvent.click(chip);
		expect(screen.getByText(locale === "es" ? "Cargando modelos…" : "Loading models…")).toBeInTheDocument();
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(
			screen.queryByText(locale === "es" ? "No hay modelos que coincidan." : "No models match."),
		).toBeNull();
		await userEvent.keyboard("{Enter}");
		expect(send.mock.calls).toEqual([[{ type: "models_list" }]]);
		expect(dispatch.mock.calls).toEqual([[{ type: "models_opened" }]]);
	});
});

describe("Spanish accounts chrome without translating account data", () => {
	it("labels the initial panel, connected accounts, close and sign-out actions", async () => {
		const { send, dispatch } = panel();
		expect(screen.getByRole("region", { name: "Cuentas" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Cuentas" })).toBeInTheDocument();
		expect(
			screen.getByText(
				"Conecta el servicio de IA que ya pagas o pega una clave de API. Tu sesión permanece en este equipo.",
			),
		).toBeInTheDocument();
		const connected = screen.getByRole("region", { name: "Conectadas" });
		expect(within(connected).getByText("Provider Original")).toBeInTheDocument();
		expect(within(connected).getByText("desde la configuración de tu equipo")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Cerrar sesión de Provider Original" }));
		expect(send.mock.calls).toEqual([[{ type: "auth_logout", providerId: "plan-id" }]]);
		await userEvent.click(screen.getByRole("button", { name: "Cerrar cuentas" }));
		expect(dispatch.mock.calls).toEqual([[{ type: "accounts", open: false }]]);
	});

	it("filters subscription data and preserves the exact OAuth login and logout fields", async () => {
		const { send, dispatch } = panel();
		expect(
			screen.getByText("Inicia sesión con un plan que ya pagas, como ChatGPT, GitHub Copilot o Grok."),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /Usar una suscripción/ }));
		const list = screen.getByRole("region", { name: "Usar una suscripción" });
		expect(within(list).getByText("Inicia sesión con un plan que ya pagas.")).toBeInTheDocument();
		expect(within(list).getByText("Plan Original")).toBeInTheDocument();
		expect(within(list).getByText("Conectadas")).toBeInTheDocument();
		expect(within(list).queryByText("Key Original")).toBeNull();
		const search = screen.getByRole("searchbox", { name: "Buscar proveedores" });
		expect(search).toHaveAttribute("placeholder", "Buscar proveedores");
		await userEvent.type(search, "missing");
		expect(screen.queryByText("Provider Original")).toBeNull();
		await userEvent.clear(search);
		await userEvent.click(screen.getByRole("button", { name: "Iniciar sesión con Plan Original" }));
		await userEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
		expect(dispatch.mock.calls).toEqual([[{ type: "auth_started", providerId: "plan-id" }]]);
		expect(send.mock.calls).toEqual([
			[{ type: "auth_login", providerId: "plan-id", method: "oauth" }],
			[{ type: "auth_logout", providerId: "plan-id" }],
		]);
	});

	it("keeps API key selection and Back local, without changing provider IDs", async () => {
		const { send, dispatch } = panel();
		expect(
			screen.getByText("Pega una clave del sitio web del proveedor. Funciona con todos los servicios."),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /Usar una clave de API/ }));
		expect(screen.getByText("Pega la clave del sitio web del proveedor.")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Usar una clave de API para Key Original" }));
		expect(send.mock.calls).toEqual([[{ type: "auth_login", providerId: "key-id", method: "api_key" }]]);
		expect(dispatch.mock.calls).toEqual([[{ type: "auth_started", providerId: "key-id" }]]);
		await userEvent.click(screen.getByRole("button", { name: "Volver" }));
		expect(screen.queryByRole("searchbox")).toBeNull();
		expect(screen.getByRole("button", { name: /Usar una suscripción/ })).toBeInTheDocument();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("translates starting, cancel, success, fallback failure and Back, not backend errors", async () => {
		const auth: AuthState = {
			open: true,
			providers,
			flow: { providerId: "plan-id", flowId: "flow-original", events: [] },
		};
		const { send, dispatch, rerender } = panel(auth);
		expect(screen.getByText("Iniciando sesión en Provider Original")).toBeInTheDocument();
		expect(screen.getByText("Iniciando…")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
		expect(send.mock.calls).toEqual([[{ type: "auth_reply", flowId: "flow-original", cancelled: true }]]);
		function done(ok: boolean, message?: string) {
			rerender(
				<LocaleProvider>
					<AccountsPanel
						auth={{ ...auth, flow: { providerId: "plan-id", events: [], done: { ok, message } } }}
						send={send}
						dispatch={dispatch}
						openUrl={vi.fn()}
					/>
				</LocaleProvider>,
			);
		}
		done(true);
		expect(screen.getByRole("status")).toHaveTextContent("Conectado a Provider Original.");
		expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Volver a cuentas" }));
		expect(dispatch.mock.calls).toEqual([[{ type: "accounts", open: true }]]);
		done(false);
		expect(screen.getByRole("status")).toHaveTextContent("El inicio de sesión no se completó.");
		done(false, "Backend failure Original");
		expect(screen.getByRole("status")).toHaveTextContent("Backend failure Original");
	});
});

describe("Spanish shared flow helpers (also exported for connectors)", () => {
	it("does not replace explicitly empty backend placeholders or instructions", () => {
		const send = vi.fn();
		const { container } = render(
			<LocaleProvider>
				<FlowEvent
					event={{ kind: "auth_url", url: "https://example.test/empty", instructions: "" }}
					openUrl={vi.fn()}
				/>
				<FlowPrompt
					prompt={{ flowId: "empty-id", kind: "manual_code", message: "Empty Original", placeholder: "" }}
					send={send}
				/>
			</LocaleProvider>,
		);
		expect(container.querySelector("p")).toBeEmptyDOMElement();
		expect(screen.getByLabelText("Empty Original")).toHaveAttribute("placeholder", "");
		expect(send).not.toHaveBeenCalled();
	});

	it("translates fallback wrappers but preserves supplied instructions, progress, codes and URLs", async () => {
		const openUrl = vi.fn();
		render(
			<LocaleProvider>
				<FlowEvent
					event={{ kind: "auth_url", url: "https://example.test/default?challenge=Original" }}
					openUrl={openUrl}
				/>
				<FlowEvent
					event={{
						kind: "auth_url",
						url: "https://example.test/custom",
						instructions: "Instructions Original",
					}}
					openUrl={openUrl}
				/>
				<FlowEvent
					event={{
						kind: "device_code",
						userCode: "PIN-AbC-123",
						verificationUri: "https://example.test/device",
					}}
					openUrl={openUrl}
				/>
				<FlowEvent event={{ kind: "info", message: "Info Original" }} openUrl={openUrl} />
				<FlowEvent event={{ kind: "progress", message: "Progress Original 50%" }} openUrl={openUrl} />
			</LocaleProvider>,
		);
		for (const text of [
			"Termina de iniciar sesión en la página del proveedor.",
			"Instructions Original",
			"Abre la página de abajo e introduce este código:",
			"PIN-AbC-123",
			"Info Original",
			"Progress Original 50%",
		]) {
			expect(screen.getByText(text)).toBeInTheDocument();
		}
		for (const button of screen.getAllByRole("button", { name: "Abrir la página de inicio de sesión" })) {
			await userEvent.click(button);
		}
		await userEvent.click(screen.getByRole("button", { name: "Abrir la página" }));
		expect(openUrl.mock.calls).toEqual([
			["https://example.test/default?challenge=Original"],
			["https://example.test/custom"],
			["https://example.test/device"],
		]);
	});

	it("translates manual-code defaults and optional controls, preserving trimming and empty skip replies", async () => {
		const send = vi.fn();
		render(
			<LocaleProvider>
				<FlowPrompt
					prompt={{ flowId: "flow-id", kind: "manual_code", message: "Challenge Original", optional: true }}
					send={send}
				/>
			</LocaleProvider>,
		);
		const input = screen.getByLabelText("Challenge Original");
		expect(input).toHaveAttribute("placeholder", "Pega aquí el código o la dirección completa");
		expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
		await userEvent.type(input, "   ");
		expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
		expect(send).not.toHaveBeenCalled();
		await userEvent.type(input, "Code-Original  ");
		await userEvent.click(screen.getByRole("button", { name: "Continuar" }));
		await userEvent.click(screen.getByRole("button", { name: "Omitir" }));
		expect(send.mock.calls).toEqual([
			[{ type: "auth_reply", flowId: "flow-id", value: "Code-Original" }],
			[{ type: "auth_reply", flowId: "flow-id", value: "" }],
		]);
	});

	it("preserves supplied secret placeholders, masking and select option labels/descriptions/IDs", async () => {
		const send = vi.fn();
		const { rerender } = render(
			<LocaleProvider>
				<FlowPrompt
					prompt={{
						flowId: "secret-id",
						kind: "secret",
						message: "Secret Original",
						placeholder: "Placeholder Original",
					}}
					send={send}
				/>
			</LocaleProvider>,
		);
		const input = screen.getByLabelText("Secret Original");
		expect(input).toHaveAttribute("type", "password");
		expect(input).toHaveAttribute("placeholder", "Placeholder Original");
		expect(screen.queryByRole("button", { name: "Omitir" })).toBeNull();
		await userEvent.type(input, "synthetic-KEY");
		await userEvent.click(screen.getByRole("button", { name: "Continuar" }));
		rerender(
			<LocaleProvider>
				<FlowPrompt
					prompt={{
						flowId: "select-id",
						kind: "select",
						message: "Choose Original",
						options: [{ id: "option-id", label: "Option Original", description: "Description Original" }],
					}}
					send={send}
				/>
			</LocaleProvider>,
		);
		expect(screen.getByText("Choose Original")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Option Original" })).toHaveAttribute(
			"title",
			"Description Original",
		);
		await userEvent.click(screen.getByRole("button", { name: "Option Original" }));
		expect(send.mock.calls).toEqual([
			[{ type: "auth_reply", flowId: "secret-id", value: "synthetic-KEY" }],
			[{ type: "auth_reply", flowId: "select-id", value: "option-id" }],
		]);
	});
});
