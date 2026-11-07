import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProfilesPanel } from "../src/components/ProfilesPanel.tsx";
import { LocaleProvider, useLocale } from "../src/i18n.tsx";
import type { ProfilesState } from "../src/store.ts";

function Language() {
	const { setLocale } = useLocale();
	return (
		<button type="button" onClick={() => setLocale("es")}>
			Español
		</button>
	);
}

function panel(overrides: Partial<ProfilesState> = {}) {
	const send = vi.fn();
	const dispatch = vi.fn();
	render(
		<LocaleProvider>
			<Language />
			<ProfilesPanel
				profiles={{
					open: true,
					list: [
						{
							name: "Default",
							roles: {
								main: { model: "lost/model", thinking: "high" },
								hidden: { model: "x/y" },
							},
						},
						{ name: "active", roles: {} },
					],
					active: "active",
					roles: [{ id: "main", label: "Default" }],
					models: [{ provider: "p", id: "m", name: "Default", reasoning: true }],
					importable: true,
					...overrides,
				}}
				providers={[{ id: "p", name: "Default", methods: ["api_key"], configured: true }]}
				send={send}
				dispatch={dispatch}
			/>
		</LocaleProvider>,
	);
	return { send, dispatch };
}
const item = () => screen.getAllByRole("listitem")[0]!;
const spanish = () => userEvent.click(screen.getByRole("button", { name: "Español" }));

describe("localized Profiles public controls", () => {
	it("switches authored copy live while preserving fallback-identical data and exact edit payloads", async () => {
		const { send, dispatch } = panel();
		expect(screen.getByRole("region", { name: "Profiles" })).toBeInTheDocument();
		await spanish();
		expect(screen.getByRole("region", { name: "Perfiles" })).toBeInTheDocument();
		expect(within(item()).getByText("Default: lost/model · Alto")).toBeInTheDocument();
		expect(screen.getByText("Usa el modelo predeterminado en todas las funciones.")).toBeInTheDocument();
		const active = within(screen.getAllByRole("listitem")[1]!);
		expect(active.getByText("En uso")).toBeInTheDocument();
		expect(active.getByRole("button", { name: "Eliminar" })).toBeDisabled();
		expect(active.getByRole("button", { name: "Eliminar" })).toHaveAttribute(
			"title",
			"Cambia a otro perfil antes de eliminar este.",
		);
		await userEvent.click(within(item()).getByRole("button", { name: "Usar" }));
		expect(send).toHaveBeenLastCalledWith({ type: "profile_apply", name: "Default" });
		await userEvent.click(within(item()).getByRole("button", { name: "Editar" }));
		expect(screen.getByRole("form", { name: "Editar Default" })).toBeInTheDocument();
		const model = screen.getByRole("combobox", { name: "Modelo de Default" });
		expect(model).toHaveValue("lost/model");
		expect(within(model).getByRole("option", { name: "lost/model (no disponible)" })).toHaveValue(
			"lost/model",
		);
		expect(model.querySelector("optgroup")).toHaveAttribute("label", "Default");
		expect(within(model).getByRole("option", { name: "Default" })).toHaveValue("p/m");
		expect(within(model).getByRole("option", { name: "Predeterminado" })).toHaveValue("");
		for (const [value, label] of Object.entries({
			off: "Desactivado",
			minimal: "Mínimo",
			low: "Bajo",
			medium: "Medio",
			high: "Alto",
			xhigh: "Muy alto",
			max: "Máximo",
		}))
			expect(screen.getByRole("option", { name: label })).toHaveValue(value);
		await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
		expect(send).toHaveBeenLastCalledWith({
			type: "profile_save",
			name: "Default",
			roles: {
				main: { model: "lost/model", thinking: "high" },
				hidden: { model: "x/y" },
			},
		});
		await userEvent.click(screen.getByRole("button", { name: "Cerrar perfiles" }));
		expect(dispatch).toHaveBeenLastCalledWith({ type: "profiles", open: false });
	});

	it("keeps validation guards, duplicate suffix, rename, current setup and delete payloads", async () => {
		const { send } = panel();
		await spanish();
		await userEvent.click(screen.getByRole("button", { name: "Nuevo perfil" }));
		const name = screen.getByRole("textbox", { name: "Nombre del perfil" });
		expect(name).toHaveAttribute("placeholder", "por ejemplo trabajo-profundo");
		expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled();
		await userEvent.type(name, "bad name");
		expect(screen.getByText(/Usa letras, números/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled();
		await userEvent.clear(name);
		await userEvent.type(name, "Default");
		expect(screen.getByText("Ya existe un perfil con ese nombre.")).toBeInTheDocument();
		await userEvent.clear(name);
		await userEvent.type(name, "new");
		await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
		expect(send).toHaveBeenLastCalledWith({ type: "profile_save", name: "new", roles: {} });
		await userEvent.click(within(item()).getByRole("button", { name: "Duplicar" }));
		expect(screen.getByRole("textbox", { name: "Nombre de la copia" })).toHaveValue("Default-copy");
		await userEvent.click(screen.getByRole("button", { name: "Duplicar" }));
		expect(send).toHaveBeenLastCalledWith({ type: "profile_duplicate", from: "Default", to: "Default-copy" });
		await userEvent.click(within(item()).getByRole("button", { name: "Cambiar nombre" }));
		const rename = screen.getByRole("textbox", { name: "Nuevo nombre" });
		expect(screen.getByRole("button", { name: "Cambiar nombre" })).toBeDisabled();
		await userEvent.clear(rename);
		await userEvent.type(rename, "renamed");
		await userEvent.click(screen.getByRole("button", { name: "Cambiar nombre" }));
		expect(send).toHaveBeenLastCalledWith({ type: "profile_rename", from: "Default", to: "renamed" });
		await userEvent.click(screen.getByRole("button", { name: "Guardar mi configuración actual" }));
		await userEvent.type(screen.getByRole("textbox", { name: "Nombre de tu configuración actual" }), "today");
		await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
		expect(send).toHaveBeenLastCalledWith({ type: "profile_save_current", name: "today" });
		await userEvent.click(within(item()).getByRole("button", { name: "Eliminar" }));
		const dialog = screen.getByRole("alertdialog", { name: "Eliminar perfil" });
		expect(dialog).toHaveTextContent("¿Eliminar «Default»? Esta acción no se puede deshacer.");
		await userEvent.click(within(dialog).getByRole("button", { name: "Conservar" }));
		expect(send).toHaveBeenCalledTimes(4);
		await userEvent.click(within(item()).getByRole("button", { name: "Eliminar" }));
		await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Eliminar" }));
		expect(send).toHaveBeenLastCalledWith({ type: "profile_delete", name: "Default" });
	});

	it.each([0, 1, 2])(
		"displays import count %i with raw imported names/accounts and exact callbacks",
		async (count) => {
			const { send, dispatch } = panel({
				lastImport: {
					imported: Array.from({ length: count }, () => ({ from: "Default", to: "Default-imported" })),
					missingProviders: ["Default"],
				},
			});
			await spanish();
			expect(screen.getByRole("status")).toHaveTextContent(
				["No hay nada nuevo que importar.", "Se importó 1 perfil.", "Se importaron 2 perfiles."][count]!,
			);
			if (count) expect(screen.getByRole("status")).toHaveTextContent("Default → Default-imported");
			expect(screen.getByRole("status")).toHaveTextContent("Conecta estas cuentas para usarlas: Default.");
			await userEvent.click(screen.getByRole("button", { name: "Importar mis perfiles de Gentle Shell" }));
			expect(send).toHaveBeenLastCalledWith({ type: "profile_import" });
			await userEvent.click(screen.getByRole("button", { name: "Abrir cuentas" }));
			expect(send).toHaveBeenLastCalledWith({ type: "auth_list" });
			expect(dispatch).toHaveBeenLastCalledWith({ type: "accounts", open: true });
		},
	);

	it.each([undefined, []])(
		"localizes loading/empty state without offering unavailable import",
		async (list) => {
			panel({ list, importable: false });
			await spanish();
			expect(screen.getByText(list ? "Aún no hay perfiles." : "Cargando…")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Importar mis perfiles de Gentle Shell" })).toBeNull();
		},
	);
});
