import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceChecks } from "../src/components/VoiceChecks.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY, useLocale } from "../src/i18n.tsx";
import { createVoiceDeviceRuntime } from "../src/voice-device-runtime.ts";
import { createVoiceDevices } from "../src/voice-devices.ts";
import type { CheckObserver } from "../src/voice-diagnostics.ts";

const inputDone = "Input check finished. Preview is not sent to chat.";
const inputEs = "Prueba de entrada finalizada. La vista previa no se envía al chat.";
function fixture() {
	let observer!: CheckObserver;
	const stop = vi.fn();
	const cancel = vi.fn(async () => {});
	const input = vi.fn((value: CheckObserver) => {
		observer = value;
		return { stop, cancel };
	});
	const output = vi.fn((value: CheckObserver) => {
		observer = value;
		return { stop, cancel };
	});
	const runtime = createVoiceDeviceRuntime({
		devices: createVoiceDevices({ storage: localStorage }),
		nativeDevices: vi.fn(),
		startNative: vi.fn(),
		getUserMedia: vi.fn(),
	});
	runtime.registerChecks({ input, output });
	return {
		runtime,
		input,
		output,
		stop,
		cancel,
		get observer() {
			return observer;
		},
	};
}
function SwitchLocale() {
	const { setLocale } = useLocale();
	return (
		<button type="button" onClick={() => setLocale("es")}>
			Español
		</button>
	);
}
const mount = (runtime: ReturnType<typeof fixture>["runtime"]) =>
	render(
		<LocaleProvider>
			<SwitchLocale />
			<VoiceChecks runtime={runtime} />
		</LocaleProvider>,
	);
const startInput = () =>
	fireEvent.click(screen.getByRole("button", { name: /^(Check input|Comprobar entrada)$/ }));
beforeEach(() => localStorage.clear());

describe("controller-owned check notes", () => {
	it.each(["en", "es"] as const)(
		"localizes input completion without changing raw state or callbacks in %s",
		(locale) => {
			localStorage.setItem(UI_LANGUAGE_KEY, locale);
			const h = fixture();
			mount(h.runtime);
			startInput();
			expect(h.input).toHaveBeenCalledTimes(1);
			expect(h.output).not.toHaveBeenCalled();
			expect(
				screen.getByRole("button", { name: locale === "es" ? "Comprobar entrada" : "Check input" }),
			).toBeDisabled();
			fireEvent.click(
				screen.getByRole("button", { name: locale === "es" ? "Detener prueba" : "Stop check" }),
			);
			expect(h.stop.mock.calls).toEqual([[]]);
			act(() => {
				h.observer.preview("Input check finished. Preview is not sent to chat.");
				h.observer.complete();
			});
			expect(h.runtime.checks.read()).toMatchObject({
				kind: "done",
				level: 0,
				note: inputDone,
				preview: inputDone,
			});
			expect(screen.getByRole("status")).toHaveTextContent(locale === "es" ? inputEs : inputDone);
			expect(
				screen.getByLabelText(
					locale === "es" ? "Vista previa temporal de transcripción" : "Temporary transcription preview",
				),
			).toHaveTextContent(inputDone);
			expect(h.cancel).not.toHaveBeenCalled();
		},
	);

	it("updates mounted authored output completion without restarting or resubscribing", () => {
		const h = fixture();
		const subscribe = vi.spyOn(h.runtime.checks, "subscribe");
		mount(h.runtime);
		fireEvent.click(screen.getByRole("button", { name: "Play output test phrase" }));
		act(() => h.observer.complete());
		const before = h.runtime.checks.read();
		expect(before.note).toBe(
			"Playback completed. Please confirm you could hear the test phrase on the intended device.",
		);
		fireEvent.click(screen.getByRole("button", { name: "Español" }));
		expect(screen.getByRole("status")).toHaveTextContent(
			"Reproducción finalizada. Confirma que oíste la frase de prueba en el dispositivo deseado.",
		);
		expect(h.runtime.checks.read()).toBe(before);
		expect(h.output).toHaveBeenCalledTimes(1);
		expect(subscribe).toHaveBeenCalledTimes(1);
		expect(h.cancel).not.toHaveBeenCalled();
		expect(screen.getByText(/Hello, this is the Gentle Dot voice output check\./)).toBeInTheDocument();
	});

	it.each(["complete", "load-failed"] as const)(
		"joins late native %s with localized controller classification",
		(stage) => {
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			const h = fixture();
			mount(h.runtime);
			startInput();
			const observer = h.observer;
			act(() => {
				observer.metadata({
					route: "native",
					stage: "recording",
					pcmSamples: null,
					sampleRate: null,
					compressedBytes: null,
				});
				observer.complete();
			});
			expect(h.runtime.checks.read().note).toBe(
				"Input stopped. Final recognition metadata is unknown until available.",
			);
			expect(
				screen.getByText(
					"Entrada detenida. Los metadatos finales de reconocimiento son desconocidos hasta que estén disponibles.",
				),
			).toBeInTheDocument();
			act(() =>
				observer.metadata({
					route: "native",
					stage,
					pcmSamples: 37,
					sampleRate: 16000,
					compressedBytes: null,
					diagnosticToken: observer.diagnosticToken,
				}),
			);
			expect(h.runtime.checks.read().kind).toBe(stage === "complete" ? "done" : "failed");
			expect(h.runtime.checks.read().note).toBe(
				stage === "complete" ? inputDone : "Input recognition failed; see the failure stage.",
			);
			expect(
				screen.getByText(
					stage === "complete" ? inputEs : "El reconocimiento de entrada falló; consulta la etapa del fallo.",
				),
			).toBeInTheDocument();
			expect(screen.getByText(/native.*37/)).toHaveTextContent(stage);
		},
	);

	it.each([
		inputDone,
		"Input stopped. Final recognition metadata is unknown until available.",
		"Input recognition failed; see the failure stage.",
		"Playback completed. Please confirm you could hear the test phrase on the intended device.",
		"Voice cleanup failed. Wait for the active recording to retire.",
		"",
		"Speech synthesis is busy",
		"Speech request session limit reached; restart the app",
	])("keeps observer error %j raw after an owned notice", async (note) => {
		const h = fixture();
		mount(h.runtime);
		startInput();
		act(() => h.observer.complete());
		startInput();
		act(() => h.observer.error(note));
		fireEvent.click(screen.getByRole("button", { name: "Español" }));
		expect(h.runtime.checks.read().note).toBe(note);
		expect(h.runtime.checks.read().noteDisplay).toBeUndefined();
		expect(h.runtime.checks.read().kind).toBe("failed");
		if (note) expect(screen.getByRole("alert")).toHaveTextContent(note);
		else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Cancelar prueba" }));
		expect(h.runtime.checks.read().note).toBe(note); // Completed failures have no active lease.
		await act(async () => {
			await h.runtime.checks.cancel();
		});
		expect(h.runtime.checks.read()).toMatchObject({ kind: "idle", note: "", preview: "" });
		expect(h.runtime.checks.read().noteDisplay).toBeUndefined();
	});

	it.each(["missing-driver", "unknown-throw", "cleanup"] as const)(
		"localizes controller-owned %s fallback only",
		async (branch) => {
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			const h = fixture();
			const own = (
				{
					"missing-driver": [
						"Voice checks are unavailable until the voice lifecycle is ready.",
						"Las pruebas de voz no están disponibles hasta que el ciclo de voz esté listo.",
					],
					"unknown-throw": ["Voice check failed.", "La prueba de voz falló."],
					cleanup: [
						"Voice cleanup failed. Wait for the active recording to retire.",
						"La limpieza de voz falló. Espera a que termine la grabación activa.",
					],
				} as const
			)[branch];
			const off = h.runtime.registerChecks({
				input: (observer) => {
					if (branch === "unknown-throw") throw 42;
					return h.input(observer);
				},
				output: h.output,
			});
			if (branch === "missing-driver") off();
			if (branch === "cleanup") h.cancel.mockRejectedValueOnce("external cleanup reason");
			mount(h.runtime);
			startInput();
			if (branch === "cleanup") {
				fireEvent.click(screen.getByRole("button", { name: "Cancelar prueba" }));
				await waitFor(() => expect(h.cancel).toHaveBeenCalledTimes(1));
			}
			await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(own[1]));
			expect(h.runtime.checks.read().note).toBe(own[0]);
			expect(h.runtime.checks.read().kind).toBe("failed");
		},
	);

	it.each(["Voice check failed.", "Voice checks are unavailable until the voice lifecycle is ready.", ""])(
		"keeps thrown Error collision %j raw",
		(note) => {
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			const h = fixture();
			h.input.mockImplementation(() => {
				throw new Error(note);
			});
			mount(h.runtime);
			startInput();
			expect(h.runtime.checks.read().note).toBe(note);
			expect(h.runtime.checks.read().noteDisplay).toBeUndefined();
			if (note) expect(screen.getByRole("alert")).toHaveTextContent(note);
			else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		},
	);
});
