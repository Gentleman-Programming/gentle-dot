import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceModelEntry } from "../src/components/VoiceModel.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY, useLocale } from "../src/i18n.tsx";
import type { VoiceModelEvent, VoiceModelStatus } from "../src/voice-native.ts";

const h = vi.hoisted(() => ({
	status: vi.fn(),
	download: vi.fn(),
	cancel: vi.fn(),
	remove: vi.fn(),
	unlisten: vi.fn(),
	subscribe: vi.fn(),
	listener: undefined as ((event: VoiceModelEvent) => void) | undefined,
}));
vi.mock("../src/voice-native.ts", () => ({
	voiceModelStatus: () => h.status(),
	downloadVoiceModel: () => h.download(),
	cancelVoiceModel: () => h.cancel(),
	removeVoiceModel: () => h.remove(),
	onVoiceModel: async (listener: (event: VoiceModelEvent) => void) => {
		h.subscribe(listener);
		h.listener = listener;
		return h.unlisten;
	},
}));
const emit = async (event: VoiceModelEvent) =>
	act(async () => {
		h.listener?.(event);
	});
function SwitchLocale() {
	const { setLocale } = useLocale();
	return (
		<button type="button" onClick={() => setLocale("es")}>
			Español
		</button>
	);
}
beforeEach(() => {
	localStorage.clear();
	vi.clearAllMocks();
	h.listener = undefined;
	h.status.mockResolvedValue({ engine: "apple", installed: false, downloading: false });
	h.download.mockResolvedValue(undefined);
	h.cancel.mockResolvedValue(undefined);
	h.remove.mockResolvedValue(undefined);
});

describe("voice model display ownership", () => {
	it.each(["en", "es"] as const)(
		"retains download/cancel/remove callbacks and progress in %s",
		async (locale) => {
			localStorage.setItem(UI_LANGUAGE_KEY, locale);
			const view = render(
				<LocaleProvider>
					<VoiceModelEntry />
				</LocaleProvider>,
			);
			const download = await screen.findByRole("button", {
				name:
					locale === "es" ? "Descargar modelo de voz local (487 MB)" : "Download local voice model (487 MB)",
			});
			expect(h.download).not.toHaveBeenCalled();
			expect(h.cancel).not.toHaveBeenCalled();
			expect(h.remove).not.toHaveBeenCalled();
			fireEvent.click(download);
			expect(h.download.mock.calls).toEqual([[]]);
			await emit({ state: "downloading", received: 25, total: 100 });
			expect(
				screen.getByRole("progressbar", {
					name: locale === "es" ? "Descargando el modelo de voz local" : "Downloading the local voice model",
				}),
			).toHaveAttribute("value", "25");
			expect(screen.getByText(locale === "es" ? "Descargando… 25%" : "Downloading… 25%")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: /487 MB/ })).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: locale === "es" ? "Cancelar" : "Cancel" }));
			expect(h.cancel.mock.calls).toEqual([[]]);
			await emit({ state: "verifying" });
			expect(
				screen.getByText(locale === "es" ? "Comprobando y descomprimiendo…" : "Checking and unpacking…"),
			).toBeInTheDocument();
			h.status.mockResolvedValue({
				engine: "parakeet",
				installed: true,
				downloading: false,
				bytes: 670_478_772,
			});
			await emit({ state: "installed" });
			fireEvent.click(
				await screen.findByRole("button", {
					name: locale === "es" ? "Eliminar modelo local (670 MB)" : "Remove local model (670 MB)",
				}),
			);
			expect(h.remove.mock.calls).toEqual([[]]);
			expect(screen.getByText(locale === "es" ? "Sin conexión" : "Offline")).toHaveClass("chip");
			h.status.mockResolvedValue({ engine: "none", installed: false, downloading: false });
			await emit({ state: "removed" });
			expect(
				await screen.findByText(
					locale === "es"
						? "La entrada de voz necesita el modelo local en este equipo"
						: "Voice input needs the local model on this computer",
				),
			).toBeInTheDocument();
			view.unmount();
			expect(h.unlisten).toHaveBeenCalledTimes(1);
		},
	);

	it("localizes only the missing-message fallback and updates it after switching locale", async () => {
		render(
			<LocaleProvider>
				<SwitchLocale />
				<VoiceModelEntry />
			</LocaleProvider>,
		);
		await screen.findByRole("button", { name: /487 MB/ });
		await emit({ state: "failed" });
		expect(screen.getByRole("alert")).toHaveTextContent("The download did not finish.");
		fireEvent.click(screen.getByRole("button", { name: "Español" }));
		expect(screen.getByRole("alert")).toHaveTextContent("La descarga no se completó.");
		expect(h.status).toHaveBeenCalledTimes(2);
		expect(h.subscribe).toHaveBeenCalledTimes(1);
		expect(h.unlisten).not.toHaveBeenCalled();
		expect(screen.getByText(/NVIDIA Parakeet/)).toHaveTextContent("25 idiomas");
		expect(screen.getByText("macOS")).toHaveClass("chip");
		expect(screen.getByText("En uso: voz de macOS")).toBeInTheDocument();
	});

	it.each(["The download did not finish.", "", "native /models/Voice.bin: checksum failed"])(
		"keeps native event error %j raw",
		async (message) => {
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			render(
				<LocaleProvider>
					<VoiceModelEntry />
				</LocaleProvider>,
			);
			await screen.findByRole("button", { name: /487 MB/ });
			await emit({ state: "failed", message });
			if (message) expect(screen.getByRole("alert")).toHaveTextContent(message);
			else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		},
	);

	it.each(["The download did not finish.", "", new Error("native failure")])(
		"keeps rejected actions raw: %j",
		async (reason) => {
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			h.download.mockRejectedValue(reason);
			render(
				<LocaleProvider>
					<VoiceModelEntry />
				</LocaleProvider>,
			);
			fireEvent.click(await screen.findByRole("button", { name: /487 MB/ }));
			await act(async () => {});
			if (String(reason)) expect(screen.getByRole("alert")).toHaveTextContent(String(reason));
			else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			expect(h.download.mock.calls).toEqual([[]]);
		},
	);

	it("preserves a supplied English collision across locale changes and clears it only on existing events", async () => {
		render(
			<LocaleProvider>
				<SwitchLocale />
				<VoiceModelEntry />
			</LocaleProvider>,
		);
		await screen.findByRole("button", { name: /487 MB/ });
		await emit({ state: "failed", message: "The download did not finish." });
		fireEvent.click(screen.getByRole("button", { name: "Español" }));
		expect(screen.getByRole("alert")).toHaveTextContent("The download did not finish.");
		const stored = JSON.stringify({ ...localStorage });
		await emit({ state: "downloading", received: 0 });
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");
		expect(JSON.stringify({ ...localStorage })).toBe(stored);
	});

	it("keeps actions absent after a rejected status request", async () => {
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		h.status.mockRejectedValue("native status unavailable");
		render(
			<LocaleProvider>
				<VoiceModelEntry />
			</LocaleProvider>,
		);
		await act(async () => {});
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(h.status).toHaveBeenCalledTimes(1);
		expect(h.download).not.toHaveBeenCalled();
	});

	it("retains resumed progress and suppresses actions for unavailable status", async () => {
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		const status: VoiceModelStatus = {
			engine: "apple",
			installed: false,
			downloading: true,
			received: 7,
			total: 20,
		};
		h.status.mockResolvedValue(status);
		const original = structuredClone(status);
		render(
			<LocaleProvider>
				<VoiceModelEntry />
			</LocaleProvider>,
		);
		expect(
			await screen.findByRole("progressbar", { name: "Descargando el modelo de voz local" }),
		).toHaveAttribute("value", "35");
		expect(status).toEqual(original);
		h.status.mockResolvedValue(undefined);
		await emit({ state: "removed" });
		await waitFor(() => expect(screen.queryByRole("button")).not.toBeInTheDocument());
		expect(screen.getByText("Voz")).toBeInTheDocument();
		expect(h.download).not.toHaveBeenCalled();
	});
});
