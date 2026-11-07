import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceChecks } from "../src/components/VoiceChecks.tsx";
import { VoiceDevicesSettings } from "../src/components/VoiceDevicesSettings.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY, useLocale } from "../src/i18n.tsx";
import { createVoiceDeviceRuntime } from "../src/voice-device-runtime.ts";
import { createVoiceDevices, VOICE_DEVICE_KEY } from "../src/voice-devices.ts";
import type { CheckObserver } from "../src/voice-diagnostics.ts";

function fixture() {
	const permission = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
	const devices = createVoiceDevices({
		storage: localStorage,
		secureContext: true,
		sinkSupported: true,
		media: {
			getUserMedia: permission,
			enumerateDevices: async () => [
				{ kind: "audioinput", deviceId: "mic-id", label: "Voice input" },
				{ kind: "audiooutput", deviceId: "speaker-id", label: "System default" },
				{ kind: "audiooutput", deviceId: "blank-id", label: "" },
			],
		},
	});
	const runtime = createVoiceDeviceRuntime({
		devices,
		nativeDevices: async () => ({
			supported: true,
			devices: [{ id: "endpoint", label: "System default", isDefault: true }],
		}),
		startNative: vi.fn(),
		getUserMedia: vi.fn(),
	});
	runtime.setRoute({ kind: "daemon" });
	return { runtime, permission };
}
function SwitchLocale() {
	const { setLocale } = useLocale();
	return (
		<button type="button" onClick={() => setLocale("es")}>
			Español
		</button>
	);
}
beforeEach(() => localStorage.clear());

describe("voice panel display boundary", () => {
	it.each(["en", "es"] as const)("keeps exact saved IDs and real device labels in %s", async (locale) => {
		localStorage.setItem(UI_LANGUAGE_KEY, locale);
		const { runtime, permission } = fixture();
		runtime.devices.set("nativeInput", "endpoint");
		const set = vi.spyOn(runtime.devices, "set");
		render(
			<LocaleProvider>
				<VoiceDevicesSettings runtime={runtime} />
			</LocaleProvider>,
		);
		const input = await screen.findByRole("combobox", {
			name: locale === "es" ? "Entrada de voz" : "Voice input",
		});
		await waitFor(() => expect(screen.getByRole("option", { name: "Voice input" })).toBeInTheDocument());
		expect(
			screen
				.getAllByRole("option", { name: "System default" })
				.some((option) => option.getAttribute("value") === "speaker-id"),
		).toBe(true);
		expect(permission).not.toHaveBeenCalled();
		fireEvent.change(input, { target: { value: "mic-id" } });
		expect(set).toHaveBeenLastCalledWith("browserInput", "mic-id");
		expect(runtime.devices.read().preferences).toEqual({
			version: 1,
			nativeInput: "endpoint",
			browserInput: "mic-id",
			browserOutput: null,
		});
		expect(
			screen.getByText(
				locale === "es"
					? "Guardado para la próxima grabación o respuesta hablada."
					: "Saved for the next recording or spoken reply.",
			),
		).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "es" ? "Borrar entrada inactiva" : "Clear inactive input choice",
			}),
		);
		expect(set).toHaveBeenLastCalledWith("nativeInput", null);
		expect(
			screen.getByRole("option", {
				name: locale === "es" ? "Dispositivo sin etiqueta 2" : "Unlabelled device 2",
			}),
		).toHaveValue("blank-id");
	});

	it("updates authored notices with locale and preserves native labels, unsupported choices and stored values", async () => {
		const { runtime } = fixture();
		runtime.setRoute({ kind: "native" });
		runtime.devices.set("nativeInput", "missing-id");
		const view = render(
			<LocaleProvider>
				<SwitchLocale />
				<VoiceDevicesSettings runtime={runtime} />
			</LocaleProvider>,
		);
		await screen.findByText("Selected device is missing or disconnected.");
		fireEvent.change(screen.getByRole("combobox", { name: "Voice input" }), {
			target: { value: "endpoint" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Español" }));
		expect(screen.getByText("Guardado para la próxima grabación o respuesta hablada.")).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Entrada de voz" })).toHaveValue("endpoint");
		expect(
			screen
				.getAllByRole("option", { name: "System default" })
				.some((option) => option.getAttribute("value") === "endpoint"),
		).toBe(true);
		const stored = localStorage.getItem(VOICE_DEVICE_KEY);
		act(() => runtime.setRoute({ kind: "none" }));
		await screen.findByText("La selección de dispositivos no está disponible en esta ruta.");
		expect(screen.getByRole("option", { name: "Dispositivo guardado (no compatible)" })).toHaveValue(
			"endpoint",
		);
		expect(localStorage.getItem(VOICE_DEVICE_KEY)).toBe(stored);
		view.unmount();
	});

	it("localizes unavailable metadata and guards without overwriting unreadable preferences", async () => {
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		localStorage.setItem(VOICE_DEVICE_KEY, "{invalid");
		const { runtime } = fixture();
		const reset = vi.spyOn(runtime.devices, "reset");
		vi.spyOn(runtime, "catalog").mockResolvedValue({
			browser: { status: "error", devices: [] },
			native: { supported: false, devices: [] },
			nativeError: true,
		});
		render(
			<LocaleProvider>
				<VoiceDevicesSettings runtime={runtime} />
			</LocaleProvider>,
		);
		await screen.findByText(
			"No se pudieron listar todos los dispositivos de voz. Las opciones guardadas no han cambiado.",
		);
		expect(screen.getByRole("combobox", { name: "Entrada de voz" })).toBeDisabled();
		expect(localStorage.getItem(VOICE_DEVICE_KEY)).toBe("{invalid");
		fireEvent.click(screen.getByRole("button", { name: "Borrar opciones de dispositivos guardadas" }));
		expect(reset).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Se borraron las opciones de dispositivos de voz.")).toBeInTheDocument();
		expect(localStorage.getItem(VOICE_DEVICE_KEY)).toBeNull();
	});

	it("keeps permission admission explicit and translates only its local result", async () => {
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		const { runtime, permission } = fixture();
		const request = vi.spyOn(runtime.devices, "requestPermission");
		render(
			<LocaleProvider>
				<VoiceDevicesSettings runtime={runtime} />
			</LocaleProvider>,
		);
		expect(request).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Permitir acceso al micrófono para mostrar etiquetas de dispositivos",
			}),
		);
		expect(request).toHaveBeenCalledTimes(1);
		await screen.findByText(
			"Permiso de micrófono concedido; pistas temporales detenidas. La captura no está verificada.",
		);
		expect(permission).toHaveBeenCalledWith({ audio: true });
		const catalog = vi.spyOn(runtime, "catalog");
		fireEvent.click(screen.getByRole("button", { name: "Actualizar dispositivos" }));
		await waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
	});

	it.each(["", "Speech synthesis is busy", "Speech request session limit reached; restart the app"])(
		"does not translate or replace raw check error %j",
		(note) => {
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			const { runtime } = fixture();
			runtime.registerChecks({
				input: (observer) => {
					observer.error(note);
					return { stop: vi.fn(), cancel: vi.fn(async () => {}) };
				},
				output: vi.fn(),
			});
			render(
				<LocaleProvider>
					<VoiceChecks runtime={runtime} />
				</LocaleProvider>,
			);
			fireEvent.click(screen.getByRole("button", { name: "Comprobar entrada" }));
			expect(runtime.checks.read().note).toBe(note);
			if (note) expect(screen.getByRole("alert")).toHaveTextContent(note);
			else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		},
	);

	it.each(["en", "es"] as const)(
		"uses existing check callbacks and keeps notes, previews, stage and route raw in %s",
		async (locale) => {
			localStorage.setItem(UI_LANGUAGE_KEY, locale);
			const { runtime } = fixture();
			let observer!: CheckObserver;
			const stop = vi.fn();
			const cancel = vi.fn(async () => {});
			const input = vi.fn((value: CheckObserver) => {
				observer = value;
				return { stop, cancel };
			});
			const output = vi.fn(() => ({ stop, cancel }));
			runtime.registerChecks({ input, output });
			const start = vi.spyOn(runtime.checks, "start");
			const view = render(
				<LocaleProvider>
					<VoiceChecks runtime={runtime} />
				</LocaleProvider>,
			);
			fireEvent.click(
				screen.getByRole("button", { name: locale === "es" ? "Comprobar entrada" : "Check input" }),
			);
			expect(start).toHaveBeenLastCalledWith("input");
			expect(input).toHaveBeenCalledTimes(1);
			expect(
				screen.getByRole("button", {
					name: locale === "es" ? "Reproducir frase de prueba" : "Play output test phrase",
				}),
			).toBeDisabled();
			act(() => {
				observer.level(0.4);
				observer.preview("Check input");
				observer.metadata({
					route: "daemon",
					stage: "transcribing",
					pcmSamples: null,
					sampleRate: null,
					compressedBytes: 7,
				});
			});
			expect(
				screen.getByRole("meter", {
					name: locale === "es" ? "Nivel de entrada de prueba" : "Check input level",
				}),
			).toHaveValue(0.4);
			expect(
				screen.getByLabelText(
					locale === "es" ? "Vista previa temporal de transcripción" : "Temporary transcription preview",
				),
			).toHaveTextContent("Check input");
			expect(screen.getByText(/daemon.*transcribing/)).toHaveTextContent(
				locale === "es" ? "Muestras PCM finales: desconocido" : "Final PCM samples: unknown",
			);
			fireEvent.click(
				screen.getByRole("button", { name: locale === "es" ? "Detener prueba" : "Stop check" }),
			);
			expect(stop).toHaveBeenCalledTimes(1);
			act(() => observer.error("Input check finished. Preview is not sent to chat."));
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Input check finished. Preview is not sent to chat.",
			);
			fireEvent.click(
				screen.getByRole("button", {
					name: locale === "es" ? "Reproducir frase de prueba" : "Play output test phrase",
				}),
			);
			expect(start).toHaveBeenLastCalledWith("output");
			expect(output).toHaveBeenCalledTimes(1);
			fireEvent.click(
				screen.getByRole("button", { name: locale === "es" ? "Cancelar prueba" : "Cancel check" }),
			);
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
			expect(screen.getByText(/Hello, this is the Gentle Dot voice output check\./)).toBeInTheDocument();
			view.unmount();
		},
	);
});
