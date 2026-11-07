import type { ClientMessage } from "@gentle-dot/protocol";
import { MAX_VOICE_AUDIO } from "@gentle-dot/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY } from "../src/i18n.tsx";
import { type DotAction, initialState, reduce } from "../src/store.ts";
import { useVoice, type VoiceControls } from "../src/useVoice.ts";
import { createVoiceDeviceRuntime, type VoiceDeviceRuntime } from "../src/voice-device-runtime.ts";
import { createVoiceDevices } from "../src/voice-devices.ts";

const h = vi.hoisted(() => ({ runtime: undefined as VoiceDeviceRuntime | undefined }));
vi.mock("../src/desktop.ts", async (original) => ({
	...(await original<typeof import("../src/desktop.ts")>()),
	inDesktop: () => false,
}));
vi.mock("../src/voice-device-runtime.ts", async (original) => ({
	...(await original<typeof import("../src/voice-device-runtime.ts")>()),
	voiceDeviceRuntime: () => h.runtime!,
}));
class Recorder {
	static instances: Recorder[] = [];
	static startFails = false;
	static chunk = new Blob(["audio"]);
	static isTypeSupported = () => true;
	state = "inactive";
	mimeType = "audio/webm;codecs=opus";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor() {
		Recorder.instances.push(this);
	}
	start() {
		if (Recorder.startFails) throw new Error("external start detail");
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		this.ondataavailable?.({ data: Recorder.chunk });
		this.onstop?.();
	}
}
const trackStop = vi.fn();
const media = vi.fn();
const send = vi.fn<(message: ClientMessage) => void>();
let controls: VoiceControls;
let dispatch: (action: DotAction) => void;
function Harness() {
	const [state, update] = useReducer(reduce, {
		...initialState,
		connection: "open",
		agentState: "idle",
		voice: { transcribe: true, speak: false },
	});
	dispatch = update;
	controls = useVoice(state, send);
	return <Composer busy={false} disabled={false} send={send} voice={controls} />;
}
function language(value: "en" | "es") {
	act(() => window.dispatchEvent(new StorageEvent("storage", { key: UI_LANGUAGE_KEY, newValue: value })));
}
async function start() {
	await act(async () => controls.start());
	await waitFor(() => expect(controls.phase).toBe("recording"));
}
async function transcribe() {
	await start();
	await act(async () => controls.stop());
	return await waitFor(() => {
		const request = send.mock.calls
			.map(([message]) => message)
			.find((message) => message.type === "voice_transcribe");
		expect(request?.type).toBe("voice_transcribe");
		if (!request || request.type !== "voice_transcribe") throw new Error("no synthetic request");
		return request;
	});
}
beforeEach(() => {
	localStorage.clear();
	vi.clearAllMocks();
	Recorder.instances = [];
	Recorder.startFails = false;
	Recorder.chunk = new Blob(["audio"]);
	media.mockResolvedValue({ getTracks: () => [{ stop: trackStop }] });
	h.runtime = createVoiceDeviceRuntime({
		devices: createVoiceDevices({
			storage: localStorage,
			secureContext: true,
			media: { getUserMedia: media, enumerateDevices: async () => [] },
		}),
		getUserMedia: media,
		nativeDevices: vi.fn(async () => ({ supported: false, devices: [] })),
		startNative: vi.fn(),
	});
	vi.stubGlobal("MediaRecorder", Recorder);
	vi.stubGlobal("isSecureContext", true);
	Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: media }, configurable: true });
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
const rules = [
	["empty", "I didn't catch anything. Try again.", "No se reconoció nada. Inténtalo de nuevo."],
	[
		"tooLong",
		"That recording is too long. Keep it under a minute.",
		"La grabación es demasiado larga. Limítala a menos de un minuto.",
	],
	["conversion", "Could not transcribe this recording.", "No se pudo transcribir esta grabación."],
	["recorder", "Audio recording failed.", "La grabación de audio falló."],
	["start", "Could not start the audio recorder.", "No se pudo iniciar la grabadora de audio."],
	["busy", "Voice input is already recording.", "La entrada de voz ya está grabando."],
] as const;
describe("recording-owned note provenance", () => {
	it("clears old ownership when a later daemon error has identical English copy", async () => {
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		const view = render(
			<LocaleProvider>
				<Harness />
			</LocaleProvider>,
		);
		await start();
		act(() => Recorder.instances[0]!.onerror?.());
		expect(screen.getByRole("status")).toHaveTextContent(rules[3][2]);
		const request = await transcribe();
		act(() =>
			dispatch({
				type: "server",
				message: { type: "voice_unavailable", seq: 1, requestId: request.requestId, reason: rules[3][1] },
			}),
		);
		expect(screen.getByRole("status")).toHaveTextContent(rules[3][1]);
		expect(controls.noteDisplay).toBeUndefined();
		expect(send).toHaveBeenCalledTimes(1);
		expect(controls.phase).toBe("idle");
		expect(h.runtime!.captureBusy()).toBe(false);
		view.unmount();
	});
	it.each(rules)(
		"localizes only the owned %s note, preserving raw data and controls",
		async (kind, raw, translated) => {
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			const view = render(
				<LocaleProvider>
					<Harness />
				</LocaleProvider>,
			);
			let release: (() => void) | undefined;
			if (kind === "busy") {
				release = h.runtime!.claimCapture();
				await act(async () => controls.start());
			} else if (kind === "start") {
				Recorder.startFails = true;
				await act(async () => controls.start());
			} else if (kind === "empty") {
				const request = await transcribe();
				expect(request).toEqual({
					type: "voice_transcribe",
					requestId: expect.any(String),
					mime: "audio/webm;codecs=opus",
					data: btoa("audio"),
				});
				act(() =>
					dispatch({
						type: "server",
						message: { type: "voice_transcript", seq: 1, requestId: request.requestId, text: "  " },
					}),
				);
			} else {
				await start();
				if (kind === "recorder") act(() => Recorder.instances[0]!.onerror?.());
				else {
					if (kind === "tooLong")
						vi.spyOn(globalThis, "btoa").mockReturnValueOnce("x".repeat(MAX_VOICE_AUDIO + 1));
					else
						vi.spyOn(Blob.prototype, "arrayBuffer").mockRejectedValueOnce(
							new Error("external conversion detail"),
						);
					await act(async () => controls.stop());
				}
			}
			await waitFor(() => expect(controls.note).toBe(raw));
			expect(screen.getByRole("status")).toHaveTextContent(translated);
			expect(controls.phase).toBe("idle");
			expect(send.mock.calls.some(([message]) => message.type === "send")).toBe(false);
			if (kind !== "empty") expect(send).not.toHaveBeenCalled();
			if (kind === "busy") {
				expect(media).not.toHaveBeenCalled();
				expect(h.runtime!.captureBusy()).toBe(true);
			} else {
				expect(trackStop).toHaveBeenCalled();
				expect(h.runtime!.captureBusy()).toBe(false);
			}
			language("en");
			expect(screen.getByRole("status")).toHaveTextContent(raw);
			expect(controls.note).toBe(raw);
			release?.();
			view.unmount();
		},
	);

	it.each([
		rules[0][1],
		"Speech synthesis is busy",
		"Speech request session limit reached; restart the app",
		"",
	])("keeps supplied daemon reason %j raw", async (reason) => {
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		const view = render(
			<LocaleProvider>
				<Harness />
			</LocaleProvider>,
		);
		const request = await transcribe();
		act(() =>
			dispatch({
				type: "server",
				message: { type: "voice_unavailable", seq: 1, requestId: request.requestId, reason },
			}),
		);
		expect(controls.note).toBe(reason || undefined);
		if (reason) expect(screen.getByRole("status")).toHaveTextContent(reason);
		else expect(screen.queryByRole("status")).toBeNull();
		expect(send).toHaveBeenCalledTimes(1);
		expect(h.runtime!.captureBusy()).toBe(false);
		view.unmount();
	});

	it("keeps legacy unannotated note props literal and does not send on locale changes", async () => {
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		const view = render(
			<LocaleProvider>
				<Harness />
			</LocaleProvider>,
		);
		await start();
		act(() => Recorder.instances[0]!.onerror?.());
		const current = controls;
		view.rerender(
			<LocaleProvider>
				<Composer
					busy={false}
					disabled={false}
					send={send}
					voice={{ ...current, note: rules[0][1], noteDisplay: undefined }}
				/>
			</LocaleProvider>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(rules[0][1]);
		view.rerender(
			<LocaleProvider>
				<Composer
					busy={false}
					disabled={false}
					send={send}
					voice={{ ...current, note: "", noteDisplay: "recorder" }}
				/>
			</LocaleProvider>,
		);
		expect(screen.queryByRole("status")).toBeNull();
		language("en");
		expect(send).not.toHaveBeenCalled();
		view.unmount();
	});
});
