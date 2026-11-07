import type { ClientMessage, ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { VoiceChecks } from "../src/components/VoiceChecks.tsx";
import { VoiceDevicesSettings } from "../src/components/VoiceDevicesSettings.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY } from "../src/i18n.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";
import * as voiceRuntime from "../src/voice-device-runtime.ts";
import { createVoiceDeviceRuntime, voiceDeviceRuntime } from "../src/voice-device-runtime.ts";
import { createVoiceDevices, VOICE_DEVICE_KEY } from "../src/voice-devices.ts";
import { nativeVoiceStatus, startNativeVoice } from "../src/voice-native.ts";

/** Talking to the assistant (S30.2–S30.4) through the chat, with the desktop and browser mocked. */
const h = vi.hoisted(() => ({
	tauri: false,
	invoke: vi.fn(),
	listeners: new Map<string, (event: { payload: unknown }) => void>(),
	server: (_payload: ServerPayload) => {},
}));

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => h.tauri,
	invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
		h.listeners.set(name, handler);
		return () => h.listeners.delete(name);
	},
}));

class FakeRecorder {
	static instances: FakeRecorder[] = [];
	static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
	state: "inactive" | "recording" = "inactive";
	mimeType: string;
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	constructor(_stream: unknown, options?: { mimeType?: string }) {
		this.mimeType = options?.mimeType ?? "";
		FakeRecorder.instances.push(this);
	}
	start() {
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		this.ondataavailable?.({ data: new Blob(["fake audio"], { type: this.mimeType }) });
		this.onstop?.();
	}
}

const track = { stop: vi.fn() };
const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));

class FakeUtterance {
	lang = "";
	voice: unknown = null;
	onend: (() => void) | null = null;
	onerror: (() => void) | null = null;
	readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
}
const synth = {
	speaking: false,
	speak: vi.fn((u: FakeUtterance) => {
		synth.speaking = true;
		synth.current = u;
	}),
	cancel: vi.fn(() => {
		synth.speaking = false;
	}),
	getVoices: () => [
		{ name: "Samantha", lang: "en-US" },
		{ name: "Paulina", lang: "es-MX" },
	],
	current: undefined as FakeUtterance | undefined,
};

class FakeAudio {
	static instances: FakeAudio[] = [];
	onended: (() => void) | null = null;
	play = vi.fn(async () => {});
	pause = vi.fn();
	readonly src: string;
	constructor(src: string) {
		this.src = src;
		FakeAudio.instances.push(this);
	}
}

let seq = 0;
const sent: ClientMessage[] = [];
const sentOf = <T extends ClientMessage["type"]>(type: T) =>
	sent.filter((m): m is Extract<ClientMessage, { type: T }> => m.type === type);

function Harness({ initial }: { initial: DotState }) {
	const [state, dispatch] = useReducer(reduce, initial);
	h.server = (payload) => dispatch({ type: "server", message: { ...payload, seq: ++seq } as ServerMessage });
	return (
		<ChatSurface
			variant="panel"
			state={state}
			send={(m) => {
				sent.push(m);
			}}
			dismiss={() => {}}
			dispatch={dispatch}
		/>
	);
}

const ready: DotState = { ...initialState, connection: "open", agentState: "idle" };
const withVoice = (transcribe: boolean, speak = transcribe): DotState => ({
	...ready,
	voice: { transcribe, speak },
});
const server = (...payloads: ServerPayload[]) =>
	act(() => {
		for (const payload of payloads) h.server(payload);
	});
const talk = () => screen.getByRole("button", { name: "Talk" });

function setSecure(secure: boolean) {
	Object.defineProperty(window, "isSecureContext", { value: secure, configurable: true });
}

beforeEach(() => {
	h.tauri = false;
	h.listeners.clear();
	h.invoke = vi.fn(async () => undefined);
	sent.length = 0;
	FakeRecorder.instances = [];
	FakeAudio.instances = [];
	synth.speaking = false;
	synth.current = undefined;
	synth.speak.mockClear();
	synth.cancel.mockClear();
	getUserMedia.mockClear();
	track.stop.mockClear();
	localStorage.clear();
	// These tests cover sending on stop; "review before sending" (the default) has its own below.
	localStorage.setItem("gentle-dot-voice-send", "1");
	setSecure(true);
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
	vi.stubGlobal("speechSynthesis", synth);
	vi.stubGlobal("Audio", FakeAudio);
	Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("recording refusal provenance", () => {
	it("preserves native diagnostic-token rejection before any IPC", async () => {
		await expect(startNativeVoice("en", undefined, "invalid token!")).rejects.toMatchObject({
			message: "Invalid voice diagnostic token.",
			display: "diagnosticToken",
		});
		expect(h.invoke).not.toHaveBeenCalled();
	});
	it.each(["preferences", "permission", "nativeUnsupported", "nativeMissing", "browserMissing"] as const)(
		"localizes only the runtime-owned %s refusal",
		async (kind) => {
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			const native = kind === "nativeUnsupported" || kind === "nativeMissing";
			if (kind === "preferences") localStorage.setItem(VOICE_DEVICE_KEY, "{bad");
			if (kind === "permission") getUserMedia.mockRejectedValueOnce(new Error("external media detail"));
			if (native) {
				h.tauri = true;
				h.invoke.mockImplementation(async (command) =>
					command === "voice_status"
						? { available: true }
						: { supported: kind !== "nativeUnsupported", devices: [] },
				);
				voiceDeviceRuntime().devices.set("nativeInput", "missing");
			}
			if (kind === "browserMissing") voiceDeviceRuntime().devices.set("browserInput", "missing");
			const saved = localStorage.getItem(VOICE_DEVICE_KEY);
			const view = render(
				<LocaleProvider>
					<Harness initial={withVoice(!native)} />
				</LocaleProvider>,
			);
			await userEvent.click(await screen.findByRole("button", { name: "Hablar" }));
			const translated = {
				preferences:
					"No se pudieron leer las preferencias de dispositivos de voz. Borra las opciones guardadas en Ajustes.",
				permission: "Se denegó el acceso al micrófono. Permítelo para hablar con el asistente.",
				nativeUnsupported: "La entrada nativa seleccionada no es compatible con esta plataforma.",
				nativeMissing: "La entrada seleccionada no existe o no está disponible.",
				browserMissing: "La entrada del navegador seleccionada no existe o no está disponible.",
			}[kind];
			expect(await screen.findByRole("status", { name: "Voz" })).toHaveTextContent(translated);
			expect(localStorage.getItem(VOICE_DEVICE_KEY)).toBe(saved);
			expect(sent).toEqual([]);
			expect(FakeRecorder.instances).toEqual([]);
			expect(h.invoke.mock.calls.some(([name]) => name === "voice_start")).toBe(false);
			if (kind !== "permission") expect(getUserMedia).not.toHaveBeenCalled();
			view.unmount();
		},
	);

	it.each([undefined, "", "Listening stopped."] as const)(
		"preserves native event empty/collision policy for %j",
		async (message) => {
			h.tauri = true;
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			h.invoke.mockImplementation(async (command) =>
				command === "voice_status" ? { available: true } : undefined,
			);
			const view = render(
				<LocaleProvider>
					<Harness initial={withVoice(false)} />
				</LocaleProvider>,
			);
			await userEvent.click(await screen.findByRole("button", { name: "Hablar" }));
			await screen.findByRole("button", { name: "Detener y enviar" });
			act(() => h.listeners.get("voice://error")?.({ payload: { message } }));
			expect(await screen.findByRole("status", { name: "Voz" })).toHaveTextContent(
				message === undefined ? "La escucha se detuvo." : "Listening stopped.",
			);
			expect(sent).toEqual([]);
			view.unmount();
		},
	);

	it.each([42, "", new Error(""), new Error("Could not start listening.")])(
		"keeps native start rejection %j raw unless the fallback is renderer-owned",
		async (reason) => {
			h.tauri = true;
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			h.invoke.mockImplementation(async (command) => {
				if (command === "voice_status") return { available: true };
				if (command === "voice_start") throw reason;
			});
			const view = render(
				<LocaleProvider>
					<Harness initial={withVoice(false)} />
				</LocaleProvider>,
			);
			await userEvent.click(await screen.findByRole("button", { name: "Hablar" }));
			expect(await screen.findByRole("status", { name: "Voz" })).toHaveTextContent(
				reason === 42 ? "No se pudo iniciar la escucha." : "Could not start listening.",
			);
			expect(sent).toEqual([]);
			expect(h.invoke.mock.calls.filter(([name]) => name === "voice_start")).toHaveLength(1);
			view.unmount();
		},
	);
});

describe("availability reason provenance", () => {
	it.each(["nonstring", "rejected"] as const)("marks only the authored native %s fallback", async (kind) => {
		h.tauri = true;
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		if (kind === "rejected") h.invoke.mockRejectedValue(new Error("external status detail"));
		else h.invoke.mockResolvedValue({ available: false, reason: 42 });
		expect(await nativeVoiceStatus()).toEqual({
			available: false,
			reason: "Voice is not available on this computer.",
			reasonDisplay: "nativeUnavailable",
		});
		const view = render(
			<LocaleProvider>
				<Harness initial={withVoice(false)} />
			</LocaleProvider>,
		);
		expect(await screen.findByRole("button", { name: "Hablar" })).toHaveAttribute(
			"title",
			"La voz no está disponible en este equipo.",
		);
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
		view.unmount();
	});
	it.each(["insecure", "recorder", "native"] as const)(
		"localizes only owned %s tooltips and keeps the mic disabled",
		async (kind) => {
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			if (kind === "insecure") setSecure(false);
			if (kind === "recorder") vi.stubGlobal("MediaRecorder", undefined);
			if (kind === "native") h.tauri = true;
			const raw =
				kind === "insecure"
					? "Voice needs a secure page (HTTPS or localhost)."
					: kind === "recorder"
						? "This browser cannot record audio."
						: "Voice is not available on this computer.";
			const translated =
				kind === "insecure"
					? "La voz necesita una página segura (HTTPS o localhost)."
					: kind === "recorder"
						? "Este navegador no puede grabar audio."
						: "La voz no está disponible en este equipo.";
			const view = render(
				<LocaleProvider>
					<Harness initial={withVoice(kind !== "native")} />
				</LocaleProvider>,
			);
			const mic = await screen.findByRole("button", { name: "Hablar" });
			expect(mic).toBeDisabled();
			expect(mic).toHaveAttribute("title", translated);
			act(() => window.dispatchEvent(new StorageEvent("storage", { key: UI_LANGUAGE_KEY, newValue: "en" })));
			expect(mic).toHaveAttribute("title", raw);
			expect(mic).toBeDisabled();
			expect(getUserMedia).not.toHaveBeenCalled();
			expect(sent).toEqual([]);
			expect(
				h.invoke.mock.calls.some(([name]) => name === "voice_start" || name === "voice_synthesize"),
			).toBe(false);
			view.unmount();
		},
	);

	it.each(["Voice is not available on this computer.", "This browser cannot record audio.", ""])(
		"keeps supplied native reason %j raw and empty hidden",
		async (reason) => {
			h.tauri = true;
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			h.invoke.mockResolvedValue({ available: false, reason });
			expect(await nativeVoiceStatus()).toEqual({ available: false, reason });
			const view = render(
				<LocaleProvider>
					<Harness initial={withVoice(false)} />
				</LocaleProvider>,
			);
			await act(async () => {});
			if (reason) expect(screen.getByRole("button", { name: "Hablar" })).toHaveAttribute("title", reason);
			else expect(screen.queryByRole("button", { name: "Hablar" })).toBeNull();
			expect(getUserMedia).not.toHaveBeenCalled();
			expect(sent).toEqual([]);
			view.unmount();
		},
	);
});

/** A voice turn through the daemon: record, stop, transcript, and the reply's messages. */
async function voiceTurn(transcript: string) {
	await userEvent.click(talk());
	await userEvent.click(await screen.findByRole("button", { name: "Stop and send" }));
	const request = await waitFor(() => {
		const found = sentOf("voice_transcribe").at(-1);
		if (!found) throw new Error("no voice_transcribe yet");
		return found;
	});
	server({ type: "voice_transcript", requestId: request.requestId, text: transcript });
	return request;
}

describe("the mic in the browser", () => {
	it("is hidden without an OpenAI key, and so is the mute toggle", () => {
		render(<Harness initial={withVoice(false)} />);
		expect(screen.queryByRole("button", { name: "Talk" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /spoken replies/ })).not.toBeInTheDocument();
	});

	it("is disabled with the reason on a page that is not secure", () => {
		setSecure(false);
		render(<Harness initial={withVoice(true)} />);
		expect(talk()).toBeDisabled();
		expect(talk()).toHaveAccessibleDescription("Voice needs a secure page (HTTPS or localhost).");
	});

	it("appears once the accounts list reports voice", () => {
		render(<Harness initial={withVoice(false)} />);
		server({ type: "auth_providers", providers: [], voice: { transcribe: true, speak: true } });
		expect(talk()).toBeEnabled();
	});
});

describe("talking through the daemon", () => {
	it("goes idle → recording → transcribing → sent, and the transcript stays as the message", async () => {
		render(<Harness initial={withVoice(true)} />);
		await userEvent.click(talk());
		expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
		expect(await screen.findByRole("timer")).toHaveTextContent("0:00");
		expect(screen.getByRole("meter", { name: "Microphone level" })).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Stop and send" }));
		const request = await waitFor(() => {
			const found = sentOf("voice_transcribe")[0];
			if (!found) throw new Error("not sent");
			return found;
		});
		expect(request.mime).toBe("audio/webm;codecs=opus");
		expect(request.data).toBe(btoa("fake audio"));
		expect(track.stop).toHaveBeenCalled();
		expect(screen.getByRole("status", { name: "Voice" })).toHaveTextContent("Transcribing…");

		server({ type: "voice_transcript", requestId: request.requestId, text: "remind me at five" });
		expect(sentOf("send")).toEqual([
			{ type: "send", text: "remind me at five", requestId: expect.any(String) },
		]);
		server({ type: "user_message", messageId: "u1", text: "remind me at five" });
		expect(screen.getByText("remind me at five")).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
	});

	it("cancels with ✕ or Esc without sending anything, and Esc does not reach the panel", async () => {
		render(<Harness initial={withVoice(true)} />);
		await userEvent.click(talk());
		await userEvent.click(await screen.findByRole("button", { name: "Cancel recording" }));
		expect(talk()).toBeEnabled();

		await userEvent.click(talk());
		await screen.findByRole("timer");
		const panelSaw = vi.fn();
		window.addEventListener("keydown", panelSaw);
		fireEvent.keyDown(document.body, { key: "Escape" });
		window.removeEventListener("keydown", panelSaw);
		expect(panelSaw.mock.calls[0]?.[0].defaultPrevented).toBe(true);
		await waitFor(() => expect(talk()).toBeEnabled());
		expect(sentOf("voice_transcribe")).toEqual([]);
		expect(sentOf("send")).toEqual([]);
	});

	it("stops and sends on its own after about 60 seconds", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		render(<Harness initial={withVoice(true)} />);
		fireEvent.click(talk());
		await screen.findByRole("timer");
		await act(async () => {
			vi.advanceTimersByTime(60_000);
		});
		await waitFor(() => expect(sentOf("voice_transcribe")).toHaveLength(1));
	});

	it("shows why when the daemon cannot transcribe, and sends nothing", async () => {
		render(<Harness initial={withVoice(true)} />);
		await userEvent.click(talk());
		await userEvent.click(await screen.findByRole("button", { name: "Stop and send" }));
		const request = await waitFor(() => {
			const found = sentOf("voice_transcribe")[0];
			if (!found) throw new Error("not sent");
			return found;
		});
		server({
			type: "voice_unavailable",
			requestId: request.requestId,
			reason: "OpenAI did not accept the API key. Check it in Accounts.",
		});
		expect(screen.getByRole("status", { name: "Voice" })).toHaveTextContent(
			"OpenAI did not accept the API key. Check it in Accounts.",
		);
		expect(sentOf("send")).toEqual([]);
	});
});

describe("voice device Settings source integration (renderer runner unavailable here)", () => {
	function settings() {
		const permission = vi.fn(async () => ({ getTracks: () => [track] }));
		const devices = createVoiceDevices({
			storage: localStorage,
			secureContext: true,
			sinkSupported: true,
			media: {
				enumerateDevices: async () => [
					{ kind: "audioinput", deviceId: "browser-mic", label: "Desk mic" },
					{ kind: "audiooutput", deviceId: "speaker", label: "Headphones" },
				],
				getUserMedia: permission,
			},
		});
		const startNative = vi.fn(async () => {});
		const runtime = createVoiceDeviceRuntime({
			devices,
			startNative,
			nativeDevices: async () => ({
				supported: true,
				devices: [{ id: "endpoint", label: "Native mic", isDefault: true }],
			}),
			getUserMedia: async () => ({ getTracks: () => [track] }) as unknown as MediaStream,
		});
		runtime.setRoute({ kind: "native" });
		return { runtime, permission, startNative };
	}
	it("mounts real selectors without activation and applies the choice to the next capture", async () => {
		const h = settings();
		render(<VoiceDevicesSettings runtime={h.runtime} />);
		await screen.findByRole("option", { name: "Native mic" });
		expect(h.permission).not.toHaveBeenCalled();
		expect(h.startNative).not.toHaveBeenCalled();
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Voice input" }), "endpoint");
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Voice output" }), "speaker");
		await h.runtime.startNativeInput("en-US");
		expect(h.startNative).toHaveBeenCalledWith("en-US", "endpoint");
		expect(h.runtime.outputSelection()).toBe("speaker");
		expect(localStorage.getItem("gentle:voice-devices:v1")).not.toMatch(/Native mic|Headphones/);
		await userEvent.click(
			screen.getByRole("button", { name: "Allow microphone access to reveal device labels" }),
		);
		expect(h.permission).toHaveBeenCalledTimes(1);
		expect(track.stop).toHaveBeenCalledTimes(1);
	});
	it("keeps a disconnected choice visible and clearable", async () => {
		const h = settings();
		h.runtime.devices.set("nativeInput", "disconnected");
		render(<VoiceDevicesSettings runtime={h.runtime} />);
		await screen.findByText("Selected device is missing or disconnected.");
		expect(screen.getByRole("combobox", { name: "Voice input" })).toHaveValue("disconnected");
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Voice input" }), "");
		expect(h.runtime.devices.read().preferences.nativeInput).toBeNull();
		expect(h.startNative).not.toHaveBeenCalled();
		expect(h.permission).not.toHaveBeenCalled();
	});
});

/** Authored source regressions only: renderer/dependencies are unavailable here. */
describe("Settings checks through the actual chat hook (UNEXECUTED)", () => {
	function Checks({ initial, show = true }: { initial: DotState; show?: boolean }) {
		return (
			<>
				<Harness initial={initial} />
				{show ? <VoiceChecks runtime={voiceDeviceRuntime()} /> : null}
			</>
		);
	}
	it("uses selected native input, shows real metadata/level/preview, and never sends a chat turn", async () => {
		h.tauri = true;
		localStorage.setItem(
			"gentle:voice-devices:v1",
			JSON.stringify({
				version: 1,
				nativeInput: "endpoint",
				browserInput: "browser-only",
				browserOutput: null,
			}),
		);
		h.invoke = vi.fn(async (command: string) => {
			if (command === "voice_status") return { available: true };
			if (command === "voice_input_devices")
				return { supported: true, devices: [{ id: "endpoint", label: "Mic", isDefault: true }] };
			if (command === "voice_stop") {
				h.listeners.get("voice://diagnostic")?.({
					payload: {
						route: "native",
						stage: "complete",
						pcmSamples: 37,
						sampleRate: 16000,
						diagnosticToken: h.invoke.mock.calls.findLast(([c]) => c === "voice_start")?.[1]?.diagnosticToken,
					},
				});
				return { text: "temporary final words" };
			}
		});
		const view = render(<Checks initial={withVoice(false)} />);
		await waitFor(() => expect(talk()).toBeEnabled());
		expect(h.invoke.mock.calls.filter(([c]) => c === "voice_start")).toHaveLength(0);
		expect(getUserMedia).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Check input" }));
		await screen.findByRole("timer");
		expect(h.invoke).toHaveBeenCalledWith("voice_start", {
			locale: navigator.language,
			deviceId: "endpoint",
			diagnosticToken: expect.any(String),
		});
		act(() => {
			h.listeners.get("voice://partial")?.({ payload: { text: "temporary words" } });
			h.listeners.get("voice://level")?.({ payload: { level: 0.6 } });
		});
		expect(screen.getByLabelText("Temporary transcription preview")).toHaveTextContent("temporary words");
		expect((screen.getByRole("meter", { name: "Check input level" }) as HTMLMeterElement).value).toBe(0.6);
		await userEvent.click(screen.getByRole("button", { name: "Stop check" }));
		await screen.findByText("temporary final words");
		expect(screen.getByText(/Final PCM samples: 37/)).toBeInTheDocument();
		expect(sent).toEqual([]);
		view.rerender(<Checks initial={withVoice(false)} show={false} />);
		expect(voiceDeviceRuntime().checks.read().preview).toBe("");
		expect(h.invoke.mock.calls.filter(([c]) => c === "voice_cancel")).toHaveLength(0);
	});
	it("joins result-before-metadata and rejects delayed old/missing events through real native subscriptions", async () => {
		h.tauri = true;
		h.invoke = vi.fn(async (command: string) => {
			if (command === "voice_status") return { available: true };
			if (command === "voice_stop") return { text: "result first" };
		});
		render(<Checks initial={withVoice(false)} />);
		await waitFor(() => expect(talk()).toBeEnabled());
		await userEvent.click(screen.getByRole("button", { name: "Check input" }));
		await screen.findByRole("timer");
		const token = () => h.invoke.mock.calls.findLast(([c]) => c === "voice_start")?.[1]?.diagnosticToken;
		const oldToken = token();
		await userEvent.click(screen.getByRole("button", { name: "Stop check" }));
		await screen.findByText("result first");
		expect(voiceDeviceRuntime().checks.read().note).toMatch(/unknown/);
		act(() =>
			h.listeners.get("voice://diagnostic")?.({
				payload: {
					route: "native",
					stage: "load-failed",
					pcmSamples: 37,
					sampleRate: 16000,
					diagnosticToken: oldToken,
				},
			}),
		);
		expect(voiceDeviceRuntime().checks.read().kind).toBe("failed");
		await userEvent.click(screen.getByRole("button", { name: "Check input" }));
		await screen.findByRole("timer");
		expect(token()).not.toBe(oldToken);
		const before = structuredClone(voiceDeviceRuntime().checks.read());
		const stored = JSON.stringify({ ...localStorage });
		let changes = 0;
		const off = voiceDeviceRuntime().checks.subscribe(() => changes++);
		act(() => {
			for (const diagnosticToken of [oldToken, undefined, "mismatch"])
				h.listeners.get("voice://diagnostic")?.({
					payload: {
						route: "native",
						stage: "complete",
						pcmSamples: 999,
						sampleRate: 16000,
						diagnosticToken,
					},
				});
		});
		expect(voiceDeviceRuntime().checks.read()).toEqual(before);
		expect(changes).toBe(0);
		expect(JSON.stringify({ ...localStorage })).toBe(stored);
		expect(sent).toEqual([]);
		off();
	});
	it("browser check uses existing ASR only, labels bytes as bytes, and retires tracks/listeners", async () => {
		render(<Checks initial={withVoice(true)} />);
		await userEvent.click(screen.getByRole("button", { name: "Check input" }));
		await screen.findByRole("timer");
		await userEvent.click(screen.getByRole("button", { name: "Stop check" }));
		const request = await waitFor(() => {
			const value = sentOf("voice_transcribe").at(-1);
			if (!value) throw Error("No existing ASR request");
			return value;
		});
		server({ type: "voice_transcript", requestId: request.requestId, text: "ephemeral result" });
		await screen.findByText("ephemeral result");
		expect(sentOf("send")).toEqual([]);
		expect(sentOf("voice_speak")).toEqual([]);
		expect(screen.getByText(/Final PCM samples: unknown/)).toHaveTextContent("Compressed bytes: 10");
		expect(track.stop).toHaveBeenCalled();
		expect(FakeRecorder.instances[0]?.onstop).toBeNull();
		expect(FakeRecorder.instances[0]?.ondataavailable).toBeNull();
	});
	it("rejects a check while chat owns a recording, without cancelling it on Settings unmount", async () => {
		const view = render(<Checks initial={withVoice(true)} />);
		await userEvent.click(talk());
		await screen.findByRole("timer");
		await userEvent.click(screen.getByRole("button", { name: "Check input" }));
		expect(screen.getByRole("alert")).toHaveTextContent("already recording");
		view.rerender(<Checks initial={withVoice(true)} show={false} />);
		expect(FakeRecorder.instances).toHaveLength(1);
		expect(FakeRecorder.instances[0]?.state).toBe("recording");
		expect(track.stop).not.toHaveBeenCalled();
	});
	it("cancel during permission admission retires late tracks without cancelling a newer recording", async () => {
		let resolve!: (stream: { getTracks: () => (typeof track)[] }) => void;
		getUserMedia.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		render(<Checks initial={withVoice(true)} />);
		await userEvent.click(screen.getByRole("button", { name: "Check input" }));
		await userEvent.click(screen.getByRole("button", { name: "Cancel check" }));
		await userEvent.click(talk());
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		await act(async () => {
			resolve({ getTracks: () => [track] });
		});
		expect(track.stop).toHaveBeenCalledTimes(1);
		expect(FakeRecorder.instances).toHaveLength(0);
		expect(sent).toEqual([]);
		await userEvent.click(talk());
		await screen.findByRole("timer");
		expect(FakeRecorder.instances).toHaveLength(1);
		expect(FakeRecorder.instances[0]?.state).toBe("recording");
	});
	it("does not bypass saved mute or automatically play on mount", async () => {
		localStorage.setItem("gentle-dot-voice-muted", "1");
		render(<Checks initial={withVoice(true)} />);
		expect(synth.speak).not.toHaveBeenCalled();
		expect(FakeAudio.instances).toHaveLength(0);
		await userEvent.click(screen.getByRole("button", { name: "Play output test phrase" }));
		expect(screen.getByRole("alert")).toHaveTextContent("muted");
		expect(synth.speak).not.toHaveBeenCalled();
		expect(FakeAudio.instances).toHaveLength(0);
		expect(sent).toEqual([]);
	});
});

describe("talking on the desktop", () => {
	function desktop(status: unknown, stopText = "hola mundo") {
		h.tauri = true;
		h.invoke = vi.fn(async (command: string) => {
			if (command === "voice_status") return status;
			if (command === "voice_stop") return { text: stopText };
			return undefined;
		});
	}
	const invoked = (command: string) => h.invoke.mock.calls.filter(([c]) => c === command);
	const emit = (name: string, payload: unknown) => act(() => h.listeners.get(name)?.({ payload }));

	it("uses the native recognizer without a key: live partial text, level, then the final text is sent", async () => {
		desktop({ available: true });
		render(<Harness initial={withVoice(false)} />);
		await waitFor(() => expect(talk()).toBeEnabled());
		await userEvent.click(talk());
		expect(invoked("voice_start")[0]?.[1]).toEqual({ locale: navigator.language });
		expect(getUserMedia).not.toHaveBeenCalled();
		await screen.findByRole("timer");
		emit("voice://partial", { text: "hola" });
		emit("voice://level", { level: 0.5 });
		expect(screen.getByText("hola")).toBeInTheDocument();
		expect((screen.getByRole("meter", { name: "Microphone level" }) as HTMLMeterElement).value).toBe(0.5);
		await userEvent.click(screen.getByRole("button", { name: "Stop and send" }));
		await waitFor(() =>
			expect(sentOf("send")).toEqual([{ type: "send", text: "hola mundo", requestId: expect.any(String) }]),
		);
		expect(invoked("voice_stop")).toHaveLength(1);
	});

	it("snapshots the native choice for the next start without passing the browser ID", async () => {
		desktop({ available: true });
		localStorage.setItem(
			"gentle:voice-devices:v1",
			JSON.stringify({
				version: 1,
				nativeInput: "endpoint",
				browserInput: "browser-id",
				browserOutput: null,
			}),
		);
		h.invoke = vi.fn(async (command: string) => {
			if (command === "voice_status") return { available: true };
			if (command === "voice_input_devices")
				return { supported: true, devices: [{ id: "endpoint", label: "Microphone", isDefault: true }] };
		});
		render(<Harness initial={withVoice(false)} />);
		await waitFor(() => expect(talk()).toBeEnabled());
		expect(invoked("voice_start")).toHaveLength(0);
		expect(getUserMedia).not.toHaveBeenCalled();
		await userEvent.click(talk());
		await waitFor(() =>
			expect(invoked("voice_start")[0]?.[1]).toEqual({ locale: navigator.language, deviceId: "endpoint" }),
		);
		expect(getUserMedia).not.toHaveBeenCalled();
	});

	it("useVoice re-checks voice status when the local model is installed or removed", async () => {
		const noModel = { available: false, reason: "Download the local voice model in Connectors." };
		let status: unknown = noModel;
		h.tauri = true;
		h.invoke = vi.fn(async (command: string) => (command === "voice_status" ? status : undefined));
		render(<Harness initial={withVoice(false)} />);
		await waitFor(() => expect(invoked("voice_status")).toHaveLength(1));
		await waitFor(() => expect(h.listeners.has("voice://model")).toBe(true));
		expect(talk()).toBeDisabled();

		// Progress alone does not change what the engine can do.
		emit("voice://model", { state: "downloading", received: 1, total: 2 });
		expect(invoked("voice_status")).toHaveLength(1);

		status = { available: true };
		emit("voice://model", { state: "installed" });
		await waitFor(() => expect(talk()).toBeEnabled());

		status = noModel;
		emit("voice://model", { state: "removed" });
		await waitFor(() => expect(talk()).toBeDisabled());
		expect(invoked("voice_status")).toHaveLength(3);
	});

	it("listens in the language chosen in Settings instead of the system's", async () => {
		localStorage.setItem("gentle-dot-voice-language", "es-ES");
		desktop({ available: true });
		render(<Harness initial={withVoice(false)} />);
		await waitFor(() => expect(talk()).toBeEnabled());
		await userEvent.click(talk());
		expect(invoked("voice_start")[0]?.[1]).toEqual({ locale: "es-ES" });
	});

	it("cancels the native recognizer", async () => {
		desktop({ available: true });
		render(<Harness initial={withVoice(false)} />);
		await waitFor(() => expect(talk()).toBeEnabled());
		await userEvent.click(talk());
		await userEvent.click(await screen.findByRole("button", { name: "Cancel recording" }));
		expect(invoked("voice_cancel")).toHaveLength(1);
		expect(sentOf("send")).toEqual([]);
	});

	it("shows the native error and goes back to idle", async () => {
		desktop({ available: true });
		render(<Harness initial={withVoice(false)} />);
		await waitFor(() => expect(talk()).toBeEnabled());
		await userEvent.click(talk());
		await screen.findByRole("timer");
		emit("voice://error", { message: "Speech recognition stopped." });
		expect(screen.getByRole("status", { name: "Voice" })).toHaveTextContent("Speech recognition stopped.");
		expect(talk()).toBeEnabled();
	});

	it("disables the mic with the reason the app gives", async () => {
		desktop({ available: false, reason: "Microphone access is off. Turn it on in System Settings." });
		render(<Harness initial={withVoice(false)} />);
		await waitFor(() =>
			expect(talk()).toHaveAccessibleDescription("Microphone access is off. Turn it on in System Settings."),
		);
		expect(talk()).toBeDisabled();
	});

	it("prefers the daemon when an OpenAI key is connected", async () => {
		desktop({ available: true });
		render(<Harness initial={withVoice(true)} />);
		await userEvent.click(talk());
		expect(getUserMedia).toHaveBeenCalled();
		expect(invoked("voice_start")).toHaveLength(0);
	});
});

describe("spoken replies", () => {
	const reply = (id: string, text: string) =>
		server(
			{ type: "agent_state", state: "thinking" },
			{ type: "message_done", messageId: id, text },
			{ type: "agent_state", state: "idle" },
		);

	it("reads a reply to a spoken message aloud with a system voice, without markdown or code", async () => {
		render(<Harness initial={withVoice(true, false)} />);
		await voiceTurn("hi");
		server({ type: "user_message", messageId: "u1", text: "hi" });
		reply("a1", "**Hello** there!\n\n```js\nconsole.log(1)\n```\nSee [the docs](https://x.dev) and `npm i`.");
		await waitFor(() => expect(synth.speak).toHaveBeenCalledTimes(1));
		expect(synth.current?.text).toBe("Hello there! See the docs and.");
		expect(synth.current?.lang).toBe("en");
	});

	it.each(["mute", "Stop", "record", "unmount"])("retires delayed output on %s", async (action) => {
		let changed = () => {};
		let voices: { name: string; lang: string }[] = [];
		vi.stubGlobal("speechSynthesis", {
			...synth,
			getVoices: () => voices,
			addEventListener: (_name: string, handler: () => void) => {
				changed = handler;
			},
			removeEventListener: vi.fn(),
		});
		const view = render(<Harness initial={withVoice(true, false)} />);
		await voiceTurn("hola");
		reply("a1", "Hola gracias por la ayuda");
		expect(synth.speak).not.toHaveBeenCalled();
		if (action === "unmount") view.unmount();
		else if (action === "record") await userEvent.click(talk());
		else
			await userEvent.click(
				screen.getByRole("button", {
					name: action === "mute" ? "Mute spoken replies" : "Stop",
				}),
			);
		voices = [{ name: "Paulina", lang: "es-MX" }];
		act(() => changed());
		expect(synth.speak).not.toHaveBeenCalled();
	});

	it("reports utterance failure through the existing voice note and releases Stop", async () => {
		render(<Harness initial={withVoice(true, false)} />);
		await voiceTurn("hi");
		reply("a1", "Hello there");
		await waitFor(() => expect(synth.speak).toHaveBeenCalled());
		act(() => synth.current?.onerror?.());
		expect(screen.getByRole("status", { name: "Voice" })).toHaveTextContent("System speech failed");
		expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
	});

	it("does not play a retired cloud reply after mute and unmute", async () => {
		render(<Harness initial={withVoice(true, true)} />);
		await voiceTurn("hi");
		reply("a1", "Hello there");
		const request = await waitFor(() => {
			const found = sentOf("voice_speak")[0];
			if (!found) throw new Error("not asked");
			return found;
		});
		await userEvent.click(screen.getByRole("button", { name: "Mute spoken replies" }));
		await userEvent.click(screen.getByRole("button", { name: "Unmute spoken replies" }));
		server({ type: "voice_speech", requestId: request.requestId, mime: "audio/mpeg", data: "QUJD" });
		expect(FakeAudio.instances).toHaveLength(0);
		expect(synth.speak).not.toHaveBeenCalled();
	});

	it("picks a voice in the reply's language", async () => {
		render(<Harness initial={withVoice(true, false)} />);
		await voiceTurn("hola");
		reply("a1", "¡Hola! ¿Qué necesitás que haga por vos hoy?");
		await waitFor(() => expect(synth.speak).toHaveBeenCalled());
		expect(synth.current?.lang).toBe("es");
		expect(synth.current?.voice).toMatchObject({ name: "Paulina" });
	});

	it("does not read replies to typed messages", async () => {
		render(<Harness initial={withVoice(true, false)} />);
		await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "typed{Enter}");
		reply("a1", "A typed answer.");
		await new Promise((r) => setTimeout(r, 20));
		expect(synth.speak).not.toHaveBeenCalled();
	});

	it("uses the daemon's voice when it can speak, and plays the audio it returns", async () => {
		render(<Harness initial={withVoice(true, true)} />);
		await voiceTurn("hi");
		reply("a1", "# Done\n- one item");
		const request = await waitFor(() => {
			const found = sentOf("voice_speak")[0];
			if (!found) throw new Error("not asked");
			return found;
		});
		expect(request.text).toBe("Done one item");
		server({ type: "voice_speech", requestId: request.requestId, mime: "audio/mpeg", data: "QUJD" });
		await waitFor(() => expect(FakeAudio.instances[0]?.play).toHaveBeenCalled());
		expect(FakeAudio.instances[0]?.src).toBe("data:audio/mpeg;base64,QUJD");
		expect(synth.speak).not.toHaveBeenCalled();
	});

	it("stays silent while muted, and remembers the choice", async () => {
		const { unmount } = render(<Harness initial={withVoice(true, false)} />);
		await userEvent.click(screen.getByRole("button", { name: "Mute spoken replies" }));
		expect(screen.getByRole("button", { name: "Unmute spoken replies" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await voiceTurn("hi");
		reply("a1", "Quiet answer.");
		await new Promise((r) => setTimeout(r, 20));
		expect(synth.speak).not.toHaveBeenCalled();
		unmount();
		render(<Harness initial={withVoice(true, false)} />);
		expect(screen.getByRole("button", { name: "Unmute spoken replies" })).toBeInTheDocument();
	});

	it("cuts the speech when the user presses Stop or starts to talk", async () => {
		render(<Harness initial={withVoice(true, false)} />);
		await voiceTurn("hi");
		reply("a1", "A long answer to read.");
		await waitFor(() => expect(synth.speak).toHaveBeenCalled());
		await userEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(synth.cancel).toHaveBeenCalled();
		expect(sentOf("abort")).toEqual([]);

		await voiceTurn("again");
		reply("a2", "Another answer.");
		await waitFor(() => expect(synth.speak).toHaveBeenCalledTimes(2));
		synth.cancel.mockClear();
		await userEvent.click(talk());
		expect(synth.cancel).toHaveBeenCalled();
	});
});

describe("the composer with the mic present", () => {
	it("still sends typed messages, steers while busy, and stops the run as before", async () => {
		render(<Harness initial={withVoice(true)} />);
		const box = screen.getByRole("textbox", { name: "Message" });
		await userEvent.type(box, "first{Enter}");
		expect(sentOf("send")).toEqual([{ type: "send", text: "first", requestId: expect.any(String) }]);
		server({ type: "agent_state", state: "working" });
		expect(box).toHaveAttribute("placeholder", "Add to what I'm doing…");
		await userEvent.type(box, "more{Enter}");
		expect(sentOf("send").map((m) => m.text)).toEqual(["first", "more"]);
		await userEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(sentOf("abort")).toEqual([{ type: "abort" }]);
	});
});

describe("reviewing a dictation before sending (the default)", () => {
	function desktop(stopText: string) {
		h.tauri = true;
		h.invoke = vi.fn(async (command: string) => {
			// Desktop dictation with browser-local speech; no native output devices.
			if (command === "voice_input_devices") return { supported: false, devices: [] };
			if (command === "voice_status") return { available: true };
			if (command === "voice_stop") return { text: stopText };
			return undefined;
		});
	}
	const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

	beforeEach(() => localStorage.removeItem("gentle-dot-voice-send"));

	it("leaves the transcript in the input, added to what was typed, and sends it on Enter", async () => {
		desktop("hola mundo");
		render(<Harness initial={withVoice(false)} />);
		await waitFor(() => expect(talk()).toBeEnabled());
		await userEvent.type(box(), "dijo:");
		await userEvent.click(talk());
		await userEvent.click(await screen.findByRole("button", { name: "Stop and review" }));
		await waitFor(() => expect(box().value).toBe("dijo: hola mundo"));
		expect(sentOf("send")).toEqual([]);
		await waitFor(() => expect(box()).toHaveFocus());

		await userEvent.type(box(), "{Enter}");
		expect(sentOf("send")).toEqual([
			{ type: "send", text: "dijo: hola mundo", requestId: expect.any(String) },
		]);
	});

	it("still reads the reply aloud when the message sent included a dictation", async () => {
		desktop("hi");
		render(<Harness initial={withVoice(false, false)} />);
		await waitFor(() => expect(talk()).toBeEnabled());
		await userEvent.click(talk());
		await userEvent.click(await screen.findByRole("button", { name: "Stop and review" }));
		await waitFor(() => expect(box().value).toBe("hi"));
		await userEvent.type(box(), "{Enter}");
		server({ type: "user_message", messageId: "u1", text: "hi" });
		server(
			{ type: "agent_state", state: "thinking" },
			{ type: "message_done", messageId: "a1", text: "Hello there" },
			{ type: "agent_state", state: "idle" },
		);
		await waitFor(() => expect(synth.speak).toHaveBeenCalledTimes(1));
		expect(synth.current?.text).toBe("Hello there");
		expect(sentOf("voice_speak")).toEqual([]);
		expect(h.invoke).not.toHaveBeenCalledWith("voice_synthesize", expect.anything());
		expect(localStorage.getItem("gentle-dot-voice-send")).toBeNull();
	});

	it("offers sending on stop as a remembered option while recording", async () => {
		desktop("hola");
		render(<Harness initial={withVoice(false)} />);
		await waitFor(() => expect(talk()).toBeEnabled());
		await userEvent.click(talk());
		const option = await screen.findByRole("switch", { name: "Send when I stop" });
		expect(option).toHaveAttribute("aria-checked", "false");
		await userEvent.click(option);
		expect(option).toHaveAttribute("aria-checked", "true");
		expect(localStorage.getItem("gentle-dot-voice-send")).toBe("1");
		await userEvent.click(screen.getByRole("button", { name: "Stop and send" }));
		await waitFor(() =>
			expect(sentOf("send")).toEqual([{ type: "send", text: "hola", requestId: expect.any(String) }]),
		);
		expect(box().value).toBe("");
	});
});

describe("hook-owned check failure provenance", () => {
	it("localizes the source-without-reason fallback without starting capture", async () => {
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		vi.spyOn(voiceRuntime, "chooseVoiceSource").mockReturnValue({ kind: "none" });
		mountChecks();
		await userEvent.click(screen.getByRole("button", { name: "Comprobar entrada" }));
		expect(screen.getByRole("alert")).toHaveTextContent("La entrada de voz no está disponible.");
		expect(voiceDeviceRuntime().checks.read()).toMatchObject({
			kind: "failed",
			note: "Voice input is unavailable.",
			noteDisplay: "checkInputUnavailable",
		});
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
	});
	it.each([
		"This browser cannot record audio.",
		"Voice input is already recording. Finish it before checking input.",
		"",
		"Speech synthesis is busy",
		"Speech request session limit reached; restart the app",
	])("keeps supplied native source reason %j unannotated", async (reason) => {
		h.tauri = true;
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		h.invoke.mockImplementation(async (command) =>
			command === "voice_status" ? { available: false, reason } : undefined,
		);
		await act(async () => {
			mountChecks(withVoice(false));
		});
		await userEvent.click(screen.getByRole("button", { name: "Comprobar entrada" }));
		expect(voiceDeviceRuntime().checks.read()).toMatchObject({
			kind: "failed",
			note: reason,
			noteDisplay: undefined,
		});
		if (reason) expect(screen.getByRole("alert")).toHaveTextContent(reason);
		else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(h.invoke.mock.calls.filter(([c]) => c === "voice_start")).toEqual([]);
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
	});
	function mountChecks(initial = withVoice(true)) {
		return render(
			<LocaleProvider>
				<Harness initial={initial} />
				<VoiceChecks runtime={voiceDeviceRuntime()} />
			</LocaleProvider>,
		);
	}
	it.each([
		"inputBusy",
		"unavailable",
		"muteRead",
		"muted",
		"outputBusy",
		"inputStopped",
		"outputStopped",
	] as const)("localizes %s without changing its lifecycle", async (kind) => {
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		if (kind === "muted") localStorage.setItem("gentle-dot-voice-muted", "1");
		if (kind === "unavailable") vi.stubGlobal("MediaRecorder", undefined);
		mountChecks();
		if (kind === "muteRead") {
			const get = Storage.prototype.getItem;
			vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
				if (key === "gentle-dot-voice-muted") throw new Error("external storage failure");
				return get.call(this, key);
			});
		}
		if (kind === "inputBusy" || kind === "outputBusy") {
			await userEvent.click(screen.getByRole("button", { name: "Hablar" }));
			await screen.findByRole("timer");
		}
		const input = ["inputBusy", "unavailable", "inputStopped"].includes(kind);
		await userEvent.click(
			screen.getByRole("button", { name: input ? "Comprobar entrada" : "Reproducir frase de prueba" }),
		);
		if (kind === "inputStopped") {
			await screen.findByRole("timer");
			await userEvent.click(screen.getByRole("button", { name: "Cancelar grabación" }));
		}
		if (kind === "outputStopped") await userEvent.click(screen.getByRole("button", { name: "Detener" }));
		const expected = {
			inputBusy: [
				"Voice input is already recording. Finish it before checking input.",
				"La entrada de voz ya está grabando. Finalízala antes de comprobar la entrada.",
			],
			unavailable: ["This browser cannot record audio.", "Este navegador no puede grabar audio."],
			muteRead: [
				"Could not read saved voice mute. Output check was not started.",
				"No se pudo leer el silencio de voz guardado. La prueba de salida no se inició.",
			],
			muted: [
				"Voice output is muted. Unmute before checking output.",
				"La salida de voz está silenciada. Actívala antes de comprobar la salida.",
			],
			outputBusy: [
				"Voice is busy. Finish the current recording or reply before checking output.",
				"La voz está ocupada. Finaliza la grabación o respuesta actual antes de comprobar la salida.",
			],
			inputStopped: [
				"Input check stopped. Nothing was sent to chat.",
				"La prueba de entrada se detuvo. No se envió nada al chat.",
			],
			outputStopped: [
				"Output check stopped. Playback is not audible proof.",
				"La prueba de salida se detuvo. La reproducción no demuestra que se haya oído.",
			],
		}[kind];
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(expected[1]!));
		expect(voiceDeviceRuntime().checks.read()).toMatchObject({ kind: "failed", note: expected[0] });
		expect(sent).toEqual([]);
		if (kind === "inputBusy" || kind === "outputBusy") {
			expect(FakeRecorder.instances).toHaveLength(1);
			expect(FakeRecorder.instances[0]?.state).toBe("recording");
			expect(track.stop).not.toHaveBeenCalled();
		} else if (kind === "inputStopped") {
			// Existing synchronous onstop retirement plus cancel's explicit retirement.
			expect(track.stop).toHaveBeenCalledTimes(2);
			expect(FakeRecorder.instances[0]).toMatchObject({
				state: "inactive",
				onstop: null,
				ondataavailable: null,
			});
		} else expect(getUserMedia).not.toHaveBeenCalled();
		if (kind !== "outputStopped") expect(synth.speak).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});
	it.each([false, true])(
		"preserves deadline/cleanup ordering and annotates callbacks (cleanup failure=%s)",
		async (fail) => {
			h.tauri = true;
			h.invoke.mockImplementation(async (command) => {
				if (command === "voice_status") return { available: true };
				if (command === "voice_cancel" && fail) throw new Error("external cleanup detail");
			});
			const runtime = voiceDeviceRuntime(),
				calls = vi.fn();
			const register = runtime.registerChecks.bind(runtime);
			vi.spyOn(runtime, "registerChecks").mockImplementation((driver) =>
				register({
					...driver,
					input: (observer) =>
						driver.input({
							...observer,
							error: (...args) => {
								calls(...args);
								observer.error(...args);
							},
						}),
				}),
			);
			mountChecks(withVoice(false));
			await waitFor(() => expect(talk()).toBeEnabled());
			vi.useFakeTimers();
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Check input" }));
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(60_000);
			});
			expect(calls.mock.calls).toEqual([
				["Input check stopped. Nothing was sent to chat.", "checkInputStopped"],
				[
					fail ? "Input check cleanup failed." : "Input check reached its one-minute deadline.",
					fail ? "checkInputCleanup" : "checkDeadline",
				],
			]);
			expect(runtime.checks.read()).toMatchObject({
				kind: "failed",
				note: "Input check stopped. Nothing was sent to chat.",
				noteDisplay: "checkInputStopped",
			});
			expect(h.invoke.mock.calls.filter(([c]) => c === "voice_cancel")).toEqual([
				["voice_cancel", undefined],
			]);
			expect(h.invoke.mock.calls.filter(([c]) => c === "voice_start")).toHaveLength(1);
			expect(sent).toEqual([]);
			expect(getUserMedia).not.toHaveBeenCalled();
			vi.useRealTimers();
			vi.restoreAllMocks();
		},
	);
	it.each(["nativeStopped", "microphoneDenied"] as const)(
		"carries %s provenance through the actual hook/controller",
		async (branch) => {
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			if (branch === "nativeStopped") {
				h.tauri = true;
				h.invoke.mockImplementation(async (command) =>
					command === "voice_status" ? { available: true } : undefined,
				);
			} else getUserMedia.mockRejectedValueOnce(new Error("external permission detail"));
			mountChecks(withVoice(branch !== "nativeStopped"));
			if (branch === "nativeStopped")
				await waitFor(() => expect(screen.getByRole("button", { name: "Hablar" })).toBeEnabled());
			await userEvent.click(screen.getByRole("button", { name: "Comprobar entrada" }));
			if (branch === "nativeStopped") {
				await screen.findByRole("timer");
				act(() => h.listeners.get("voice://error")?.({ payload: {} }));
			}
			await waitFor(() =>
				expect(screen.getByRole("alert")).toHaveTextContent(
					branch === "nativeStopped" ? "La escucha se detuvo." : "Se denegó el acceso al micrófono.",
				),
			);
			expect(voiceDeviceRuntime().checks.read()).toMatchObject({ kind: "failed", noteDisplay: branch });
			expect(sent).toEqual([]);
		},
	);
});

describe("output-owned failure display", () => {
	it.each(["Speech request session limit reached; restart the app", "Speech synthesis is busy"])(
		"keeps native sentinel %s raw through chat and checks",
		async (reason) => {
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			h.tauri = true;
			h.invoke.mockImplementation(async (command) => {
				if (command === "voice_status") return { available: true };
				if (command === "voice_input_devices") return { supported: true, devices: [] };
				if (command === "voice_synthesize") throw reason;
			});
			render(
				<LocaleProvider>
					<Harness initial={withVoice(true)} />
					<VoiceChecks runtime={voiceDeviceRuntime()} />
				</LocaleProvider>,
			);
			await userEvent.click(screen.getByRole("button", { name: "Reproducir frase de prueba" }));
			await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(reason));
			expect(screen.getByRole("status", { name: "Voz" })).toHaveTextContent(reason);
			expect(voiceDeviceRuntime().checks.read()).toMatchObject({
				kind: "failed",
				note: reason,
				noteDisplay: undefined,
			});
			expect(h.invoke.mock.calls.filter(([c]) => c === "voice_synthesize")).toEqual([
				[
					"voice_synthesize",
					{
						requestId: expect.any(String),
						text: "Hello, this is the Gentle Dot voice output check.",
						locale: "en",
					},
				],
			]);
			expect(FakeAudio.instances).toHaveLength(0);
			expect(synth.speak).not.toHaveBeenCalled();
			expect(sent).toEqual([]);
			expect(getUserMedia).not.toHaveBeenCalled();
		},
	);

	it.each(["unavailable", "system", "voices", "routing", "local"] as const)(
		"carries %s output error through chat and checks without sending",
		async (kind) => {
			localStorage.setItem(UI_LANGUAGE_KEY, "es");
			if (kind === "unavailable") vi.stubGlobal("speechSynthesis", undefined);
			if (kind === "voices") vi.spyOn(synth, "getVoices").mockReturnValue([]);
			if (kind === "routing") voiceDeviceRuntime().devices.set("browserOutput", "missing");
			if (kind === "local") {
				h.tauri = true;
				h.invoke.mockImplementation(async (command) => {
					if (command === "voice_status") return { available: true };
					if (command === "voice_input_devices") throw new Error("external native detail");
				});
			}
			render(
				<LocaleProvider>
					<Harness initial={withVoice(true)} />
					<VoiceChecks runtime={voiceDeviceRuntime()} />
				</LocaleProvider>,
			);
			if (kind === "voices") vi.useFakeTimers();
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Reproducir frase de prueba" }));
			});
			if (kind === "system") act(() => synth.current?.onerror?.());
			if (kind === "voices")
				await act(async () => {
					await vi.advanceTimersByTimeAsync(1500);
				});
			const expected = {
				unavailable: [
					"System speech is unavailable in this runtime.",
					"La voz del sistema no está disponible en este entorno.",
					"outputUnavailable",
				],
				system: [
					"System speech failed. Check the installed voices and audio output.",
					"La voz del sistema falló. Comprueba las voces instaladas y la salida de audio.",
					"outputSystemFailed",
				],
				voices: [
					"No system voices became available. Check the installed speech voices.",
					"No se encontraron voces del sistema. Comprueba las voces instaladas.",
					"outputNoVoices",
				],
				routing: [
					"Selected audio output is unavailable. Check output support, permission and device connection.",
					"La salida de audio seleccionada no está disponible. Comprueba la compatibilidad, los permisos y la conexión del dispositivo.",
					"outputRouting",
				],
				local: [
					"Local speech failed. Check speech support and the selected output.",
					"La voz local falló. Comprueba la compatibilidad de voz y la salida seleccionada.",
					"outputLocalFailed",
				],
			}[kind];
			expect(screen.getByRole("alert")).toHaveTextContent(expected[1]!);
			expect(screen.getByRole("status", { name: "Voz" })).toHaveTextContent(expected[1]!);
			expect(voiceDeviceRuntime().checks.read()).toMatchObject({
				kind: "failed",
				note: expected[0],
				noteDisplay: expected[2],
			});
			expect(sent).toEqual([]);
			expect(getUserMedia).not.toHaveBeenCalled();
			expect(FakeAudio.instances).toHaveLength(0);
		},
	);
});
