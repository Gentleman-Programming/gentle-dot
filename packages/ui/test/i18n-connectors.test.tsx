import { type ConnectorInfo, type ImportCandidate } from "@gentle-dot/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectorsPanel } from "../src/components/ConnectorsPanel.tsx";
import { LocaleProvider, useLocale } from "../src/i18n.tsx";
import type { ConnectorsState } from "../src/store.ts";

const raw: ConnectorInfo = {
	id: "raw-id",
	name: "Connected",
	reads: "Read only",
	sends: "Sign-in did not finish.",
	added: true,
	enabled: true,
	mode: "read_write",
	status: "connected",
	custom: { origin: "Off", summary: "Needs setup" },
};
const candidate = (id: string, importable = true): ImportCandidate => ({
	id,
	name: id,
	sources: ["Connected"],
	transport: "http",
	summary: "https://example.test/mcp",
	envNames: ["KEY"],
	headerNames: [],
	inputs: ["INPUT"],
	importable,
	notes: ["Read only"],
	reason: importable ? undefined : "Sign-in did not finish.",
});
function Language() {
	const { setLocale } = useLocale();
	return (
		<>
			<button type="button" onClick={() => setLocale("es")}>
				Español
			</button>
			<button type="button" onClick={() => setLocale("en")}>
				English
			</button>
		</>
	);
}
function panel(extra: Partial<ConnectorsState> = {}, desktop = true) {
	const send = vi.fn();
	const appSend = vi.fn();
	const dispatch = vi.fn();
	const openUrl = vi.fn();
	render(
		<LocaleProvider>
			<Language />
			<ConnectorsPanel
				connectors={{ open: true, list: [raw], ...extra }}
				send={send}
				{...(desktop ? { appSend } : {})}
				dispatch={dispatch}
				openUrl={openUrl}
			/>
		</LocaleProvider>,
	);
	return { send, appSend, dispatch, openUrl };
}
const spanish = async () => userEvent.setup().click(screen.getByRole("button", { name: "Español" }));

describe("connector management locale", () => {
	it("switches public controls, preserving colliding raw data and exact action payloads", async () => {
		const { send, appSend, dispatch } = panel();
		expect(screen.getByRole("region", { name: "Connectors" })).toBeInTheDocument();
		await spanish();
		expect(screen.getByRole("region", { name: "Conectores" })).toBeInTheDocument();
		const row = within(screen.getByRole("listitem", { name: "Connected" }));
		for (const text of ["Conectado", "Read only", "Sign-in did not finish.", "Off", "Needs setup"]) {
			expect(row.getByText(text)).toBeInTheDocument();
		}
		const user = userEvent.setup();
		await user.click(row.getByRole("radio", { name: "Solo lectura" }));
		await user.click(row.getByRole("button", { name: "Volver a iniciar sesión en Connected" }));
		await user.click(row.getByRole("button", { name: "Desconectar Connected" }));
		await user.click(row.getByRole("button", { name: "Eliminar Connected" }));
		expect(appSend.mock.calls.map(([m]) => m)).toEqual([
			{ type: "connector_mode", connectorId: "raw-id", mode: "read_only" },
			{ type: "connector_signin", connectorId: "raw-id" },
			{ type: "connector_disconnect", connectorId: "raw-id" },
			{ type: "connector_remove", connectorId: "raw-id" },
		]);
		expect(send).not.toHaveBeenCalled();
		expect(dispatch).toHaveBeenCalledWith({ type: "connector_started", connectorId: "raw-id" });
		await user.click(screen.getByRole("button", { name: "English" }));
		expect(row.getByRole("radio", { name: "Read and send" })).toBeChecked();
		expect(row.getByRole("button", { name: "Sign in to Connected again" })).toBeInTheDocument();
	});

	it("localizes add wrappers without changing the generated request or close action", async () => {
		const { send, appSend, dispatch } = panel();
		await spanish();
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Añadir otro conector" }));
		expect(screen.getByRole("button", { name: "Pedir al asistente" })).toBeDisabled();
		await user.type(screen.getByLabelText("¿Qué quieres conectar?"), "  Jira Cloud  ");
		await user.click(screen.getByRole("button", { name: "Pedir al asistente" }));
		expect(send.mock.calls).toEqual([
			[
				{
					type: "send",
					text: "Please help me add a connector for Jira Cloud. Find its MCP server and draft it for me to review.",
				},
			],
		]);
		expect(dispatch).toHaveBeenCalledWith({ type: "connectors", open: false });
		expect(appSend).not.toHaveBeenCalled();
	});

	it("keeps guide data and URLs raw while translating only wrappers", async () => {
		const guide = {
			steps: ["Read only"],
			note: "Connected",
			redirectUrl: "https://example.test/callback",
			links: [{ label: "Off", url: "https://example.test/setup" }],
		};
		const { appSend, openUrl } = panel({ list: [{ ...raw, added: false, enabled: false, guide }] });
		await spanish();
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Conectar Connected" }));
		const view = within(screen.getByRole("region", { name: "Configurar Connected" }));
		for (const text of ["Read only", "Connected", guide.redirectUrl])
			expect(view.getByText(text)).toBeInTheDocument();
		await user.click(view.getByRole("button", { name: "Abrir Off" }));
		expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.test/setup");
		await user.click(view.getByRole("button", { name: "Continuar" }));
		expect(appSend).toHaveBeenCalledExactlyOnceWith({ type: "connector_connect", connectorId: "raw-id" });
	});

	it("uses zero/singular/plural import grammar and preserves candidate data and restrictions", async () => {
		const { send, appSend, dispatch } = panel({
			imports: [candidate("one"), candidate("two"), candidate("locked", false)],
		});
		await spanish();
		const view = within(screen.getByRole("region", { name: "Servidores encontrados" }));
		expect(view.getByRole("button", { name: "Importar" })).toBeDisabled();
		expect(view.getByRole("checkbox", { name: "locked" })).toBeDisabled();
		expect(view.getByText("Sign-in did not finish.")).toBeInTheDocument();
		expect(view.getAllByText("Read only")).toHaveLength(3);
		expect(view.getAllByText("De Connected")).toHaveLength(3);
		const user = userEvent.setup();
		await user.click(view.getByRole("checkbox", { name: "one" }));
		expect(view.getByRole("button", { name: "Importar 1 servidor" })).toBeEnabled();
		await user.click(view.getByRole("checkbox", { name: "two" }));
		await user.click(view.getByRole("button", { name: "Importar 2 servidores" }));
		expect(appSend).toHaveBeenCalledExactlyOnceWith({ type: "connector_import", ids: ["one", "two"] });
		await user.click(view.getByRole("button", { name: "Cerrar la lista" }));
		expect(dispatch).toHaveBeenCalledWith({ type: "connector_imports_closed" });
		expect(send).not.toHaveBeenCalled();
	});

	it.each([undefined, "", "Sign-in did not finish."])(
		"preserves failure message %j, translating only missing fallback",
		async (message) => {
			panel({
				flow: {
					providerId: "raw-id",
					events: [],
					done: { ok: false, ...(message === undefined ? {} : { message }) },
				},
			});
			await spanish();
			expect(screen.getByRole("status").textContent).toBe(message ?? "El inicio de sesión no se completó.");
			expect(screen.getByRole("button", { name: "Volver a conectores" })).toBeInTheDocument();
		},
	);

	it.each([
		["off", "Desactivado"],
		["needs_setup", "Necesita configuración"],
		["needs_signin", "Necesita iniciar sesión"],
		["error", "Error al iniciar sesión"],
	] as const)("localizes the %s status without changing its protocol value", async (status, label) => {
		panel({ list: [{ ...raw, status }] });
		await spanish();
		expect(screen.getByText(label)).toHaveClass(`connector-${status}`);
	});

	it("localizes setup and cancellation without changing the flow identifier", async () => {
		const { send } = panel({ flow: { providerId: "raw-id", flowId: "connector-setup-7", events: [] } });
		await spanish();
		expect(screen.getByText("Configurando Connected")).toBeInTheDocument();
		expect(screen.getByText("Iniciando…")).toBeInTheDocument();
		await userEvent.setup().click(screen.getByRole("button", { name: "Cancelar" }));
		expect(send).toHaveBeenCalledExactlyOnceWith({
			type: "auth_reply",
			flowId: "connector-setup-7",
			cancelled: true,
		});
	});

	it("localizes success and returns through the original dispatch", async () => {
		const { dispatch } = panel({ flow: { providerId: "raw-id", events: [], done: { ok: true } } });
		await spanish();
		expect(screen.getByText("Iniciando sesión en Connected")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("Conectado a Connected.");
		await userEvent.setup().click(screen.getByRole("button", { name: "Volver a conectores" }));
		expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "connectors", open: true });
	});

	it("keeps desktop-only controls locked in Spanish", async () => {
		const { send, appSend } = panel({ imports: [candidate("one")] }, false);
		await spanish();
		expect(screen.getByRole("radio", { name: "Solo lectura" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Desconectar Connected" })).toBeDisabled();
		await userEvent.setup().click(screen.getByRole("checkbox", { name: "one" }));
		expect(screen.getByRole("button", { name: "Importar 1 servidor" })).toBeDisabled();
		expect(send).not.toHaveBeenCalled();
		expect(appSend).not.toHaveBeenCalled();
	});
});
