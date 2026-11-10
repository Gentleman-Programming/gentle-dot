import type { ClientMessage, ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { Composer } from "../src/components/Composer.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";
import { useVoice } from "../src/useVoice.ts";

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
	static playNext: (() => Promise<void>) | undefined;
	onended: (() => void) | null = null;
	play = vi.fn(() => FakeAudio.playNext?.() ?? Promise.resolve());
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
	FakeAudio.playNext = undefined;
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
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** A voice turn through the daemon: record, stop, transcript, and the reply's messages. */
async function voiceTurn(transcript: string) {
	const previous = sentOf("voice_transcribe").length;
	await userEvent.click(talk());
	await userEvent.click(await screen.findByRole("button", { name: "Stop and send" }));
	const request = await waitFor(() => {
		const found = sentOf("voice_transcribe").at(-1);
		if (!found || sentOf("voice_transcribe").length !== previous + 1)
			throw new Error("no new voice_transcribe yet");
		return found;
	});
	server({ type: "voice_transcript", requestId: request.requestId, text: transcript });
	return request;
}

/** Missing fixture values must fail at runtime, not merely satisfy the type checker. */
function required<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined) throw new Error(`Missing ${label}`);
	return value;
}

/** Output wiring fixtures: real Blob bytes, but no OS, device, URL allocation, or playback. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

// RIFF/WAVE, PCM mono, 16 kHz, one 16-bit silent sample.
const wav = [
	82, 73, 70, 70, 38, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32, 16, 0, 0, 0, 1, 0, 1, 0, 128, 62, 0, 0, 0,
	125, 0, 0, 2, 0, 16, 0, 100, 97, 116, 97, 2, 0, 0, 0, 0, 0,
];
const invoked = (command: string) => h.invoke.mock.calls.filter(([name]) => name === command);
const completeReply = (id = "answer", text = "**Hello** there!") =>
	server(
		{ type: "agent_state", state: "thinking" },
		{ type: "message_done", messageId: id, text },
		{ type: "agent_state", state: "idle" },
	);
const sendMessage = (message: ClientMessage) => {
	sent.push(message);
};

/** A public hook consumer for cancel(), which is valid even without a recording. */
function outputHook() {
	return renderHook(
		() => {
			const [state, dispatch] = useReducer(reduce, withVoice(true, true));
			h.server = (payload) =>
				dispatch({ type: "server", message: { ...payload, seq: ++seq } as ServerMessage });
			return useVoice(state, sendMessage);
		},
		{ wrapper: StrictMode },
	);
}

async function hookReply(view: ReturnType<typeof outputHook>, id = "answer") {
	const transcripts = sentOf("voice_transcribe").length;
	const speeches = sentOf("voice_speak").length;
	act(() => view.result.current.start());
	await waitFor(() => expect(view.result.current.phase).toBe("recording"));
	act(() => view.result.current.stop());
	const request = await waitFor(() => {
		expect(sentOf("voice_transcribe")).toHaveLength(transcripts + 1);
		return required(sentOf("voice_transcribe").at(-1), "new transcription request");
	});
	server({ type: "voice_transcript", requestId: request.requestId, text: "hi" });
	completeReply(id);
	return waitFor(() => {
		expect(sentOf("voice_speak")).toHaveLength(speeches + 1);
		return required(sentOf("voice_speak").at(-1), "new daemon speech request");
	});
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

describe("talking on the desktop", () => {
	function desktop(status: unknown, stopText = "hola mundo") {
		h.tauri = true;
		h.invoke = vi.fn(async (command: string) => {
			if (command === "voice_status") return status;
			if (command === "voice_synthesis_status") return { supported: false };
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

	it("useVoice re-checks voice status when the local model is installed or removed", async () => {
		const noModel = { available: false, reason: "Download the local voice model in Connectors." };
		let status: unknown = noModel;
		h.tauri = true;
		h.invoke = vi.fn(async (command: string) => {
			if (command === "voice_status") return status;
			if (command === "voice_synthesis_status") return { supported: false };
			return undefined;
		});
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

describe("local output integration", () => {
	const createURL = vi.fn((_blob: Blob): string => `blob:voice-${createURL.mock.calls.length}`);
	const revokeURL = vi.fn();

	function desktopOutput(
		supported = true,
		synthesize: () => Promise<number[]> = async () => wav,
		status: () => Promise<{ supported: boolean }> = async () => ({ supported }),
	) {
		h.tauri = true;
		h.invoke = vi.fn(async (command: string) => {
			if (command === "voice_status") return { available: false, reason: "No microphone model." };
			if (command === "voice_synthesis_status") return status();
			if (command === "voice_synthesize") return synthesize();
			if (command === "voice_synthesize_cancel") return undefined;
			throw new Error(`Unexpected IPC: ${command}`);
		});
	}

	beforeEach(() => {
		createURL.mockClear();
		revokeURL.mockClear();
		vi.stubGlobal(
			"URL",
			class extends URL {
				static createObjectURL = createURL;
				static revokeObjectURL = revokeURL;
			},
		);
	});
	afterEach(() => vi.restoreAllMocks());

	it("uses exact native IPC without browser voices or a microphone model, with unique IDs across StrictMode mounts", async () => {
		desktopOutput();
		vi.spyOn(synth, "getVoices").mockReturnValue([]);
		const ids: string[] = [];
		for (let turn = 0; turn < 2; turn++) {
			const view = render(
				<StrictMode>
					<Harness initial={withVoice(true, false)} />
				</StrictMode>,
			);
			await voiceTurn("hi");
			completeReply(`native-${turn}`);
			await waitFor(() => expect(invoked("voice_synthesize")).toHaveLength(turn + 1));
			const args = invoked("voice_synthesize")[turn]?.[1];
			expect(args).toEqual({ requestId: expect.any(String), text: "Hello there!", locale: "en" });
			expect(args.requestId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
			ids.push(args.requestId);
			await waitFor(() => expect(FakeAudio.instances[turn]?.play).toHaveBeenCalledTimes(1));
			expect(createURL.mock.calls[turn]?.[0]).toBeInstanceOf(Blob);
			const blob = required(createURL.mock.calls[turn], "native WAV URL call")[0];
			expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(wav);
			const player = required(FakeAudio.instances[turn], "native playback instance");
			expect(player.src).toBe(`blob:voice-${turn + 1}`);
			act(() => player.onended?.());
			view.unmount();
			expect(revokeURL.mock.calls.filter(([url]) => url === player.src)).toHaveLength(1);
		}
		expect(new Set(ids).size).toBe(2);
		expect(invoked("voice_synthesis_status").length).toBeGreaterThan(0);
		for (const call of invoked("voice_synthesis_status"))
			expect(call).toEqual(["voice_synthesis_status", {}]);
		expect(synth.speak).not.toHaveBeenCalled();
		expect(sentOf("voice_speak")).toEqual([]);
	});

	it.each(["non-Windows desktop", "browser"])("preserves regional browser voices on %s", async (platform) => {
		if (platform === "non-Windows desktop") desktopOutput(false);
		vi.spyOn(synth, "getVoices").mockReturnValue([
			{ name: "Other Spanish", lang: "es-ES" },
			{ name: "Paulina", lang: "es-MX" },
		]);
		vi.spyOn(navigator, "language", "get").mockReturnValue("es-MX");
		render(<Harness initial={withVoice(true, false)} />);
		await voiceTurn("hola");
		completeReply("regional", "¡Hola! ¿Qué necesitás hoy?");
		await waitFor(() => expect(synth.speak).toHaveBeenCalledTimes(1));
		expect(synth.current?.lang).toBe("es");
		expect(synth.current?.voice).toMatchObject({ name: "Paulina", lang: "es-MX" });
		expect(invoked("voice_synthesize")).toEqual([]);
		if (platform === "browser") expect(invoked("voice_synthesis_status")).toEqual([]);
		else expect(invoked("voice_synthesis_status")[0]).toEqual(["voice_synthesis_status", {}]);
	});

	it.each(["voice_speech", "voice_unavailable"] as const)(
		"prefers the daemon; matching %s selects local output at most once",
		async (type) => {
			desktopOutput();
			render(<Harness initial={withVoice(true, true)} />);
			await voiceTurn("hi");
			completeReply();
			const request = await waitFor(() => {
				expect(sentOf("voice_speak")).toHaveLength(1);
				return required(sentOf("voice_speak")[0], "daemon speech request");
			});
			expect(invoked("voice_synthesize")).toEqual([]);
			server({ type: "voice_unavailable", requestId: "unrelated", reason: "Not this request." });
			expect(invoked("voice_synthesize")).toEqual([]);
			const response: ServerPayload =
				type === "voice_speech"
					? { type, requestId: request.requestId, mime: "audio/mpeg", data: "QUJD" }
					: { type, requestId: request.requestId, reason: "Offline." };
			server(response);
			await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
			server(response);
			await act(async () => {});
			expect(invoked("voice_synthesize")).toHaveLength(type === "voice_unavailable" ? 1 : 0);
			expect(FakeAudio.instances[0]?.src).toBe(
				type === "voice_speech" ? "data:audio/mpeg;base64,QUJD" : "blob:voice-1",
			);
			expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(1);
			expect(synth.speak).not.toHaveBeenCalled();
		},
	);

	it.each(["status", "synthesis"])(
		"shows a native %s failure without silently switching to browser speech",
		async (stage) => {
			const fail = async (): Promise<never> => {
				throw new Error("Native output failed.");
			};
			desktopOutput(
				true,
				stage === "synthesis" ? fail : async () => wav,
				stage === "status" ? fail : async () => ({ supported: true }),
			);
			render(<Harness initial={withVoice(true, false)} />);
			await voiceTurn("hi");
			completeReply();
			await waitFor(() =>
				expect(screen.getByRole("status", { name: "Voice" })).toHaveTextContent(
					"Local speech failed. Check installed speech voices and audio output, then retry.",
				),
			);
			expect(synth.speak).not.toHaveBeenCalled();
			expect(FakeAudio.instances).toEqual([]);
			expect(sentOf("voice_speak")).toEqual([]);
		},
	);

	it("calls typed on every user textarea change, but not programmatic dictation", async () => {
		const hook = outputHook();
		const typed = vi.fn();
		const draftTaken = vi.fn();
		const onStartTyping = vi.fn();
		render(
			<Composer
				busy={false}
				disabled={false}
				send={sendMessage}
				onStartTyping={onStartTyping}
				voice={{ ...hook.result.current, typed, draftTaken, draft: { id: 1, text: "dictated" } }}
			/>,
		);
		const box = screen.getByRole("textbox", { name: "Message" });
		await waitFor(() => expect(box).toHaveValue("dictated"));
		expect(typed).not.toHaveBeenCalled();
		for (const value of ["dictated edit", "", "new"]) fireEvent.change(box, { target: { value } });
		expect(typed).toHaveBeenCalledTimes(3);
		expect(onStartTyping).toHaveBeenCalledTimes(1);
	});

	it("typing in a nonempty composer retires pending daemon output and disarms its spoken turn", async () => {
		render(<Harness initial={withVoice(true, true)} />);
		const box = () => screen.getByRole("textbox", { name: "Message" });
		fireEvent.change(box(), { target: { value: "already here" } });
		await voiceTurn("hi");
		fireEvent.change(box(), { target: { value: "already here edited" } });
		completeReply("disarmed");
		await act(async () => {});
		expect(sentOf("voice_speak")).toEqual([]);
		await voiceTurn("again");
		completeReply("pending");
		const request = await waitFor(() => {
			expect(sentOf("voice_speak")).toHaveLength(1);
			return required(sentOf("voice_speak")[0], "pending daemon speech request");
		});
		fireEvent.change(box(), { target: { value: "typed instead" } });
		server({ type: "voice_unavailable", requestId: request.requestId, reason: "Late." });
		server({ type: "voice_speech", requestId: request.requestId, mime: "audio/mpeg", data: "QUJD" });
		await userEvent.type(box(), "{Enter}");
		completeReply("typed-answer");
		await act(async () => {});
		expect(sentOf("voice_speak")).toHaveLength(1);
		expect(synth.speak).not.toHaveBeenCalled();
		expect(FakeAudio.instances).toEqual([]);
	});

	const retirements = ["Stop", "mute", "new recording", "cancel", "typing", "unmount"] as const;
	function retire(view: ReturnType<typeof outputHook>, action: (typeof retirements)[number]) {
		act(() => {
			if (action === "Stop") view.result.current.stopSpeaking();
			if (action === "mute") view.result.current.setMuted(true);
			if (action === "new recording") view.result.current.start();
			if (action === "cancel") view.result.current.cancel();
			if (action === "typing") view.result.current.typed();
		});
		if (action === "unmount") view.unmount();
	}

	it.each(retirements)("%s retires pending daemon output even with no active recording", async (action) => {
		const view = outputHook();
		const request = await hookReply(view);
		retire(view, action);
		server({ type: "voice_unavailable", requestId: request.requestId, reason: "Late." });
		server({ type: "voice_speech", requestId: request.requestId, mime: "audio/mpeg", data: "QUJD" });
		await act(async () => {});
		expect(synth.speak).not.toHaveBeenCalled();
		expect(FakeAudio.instances).toEqual([]);
	});

	it.each(retirements)("%s cancels pending native synthesis and ignores its late WAV", async (action) => {
		const pending = deferred<number[]>();
		desktopOutput(true, () => pending.promise);
		const view = outputHook();
		const speech = await hookReply(view);
		server({ type: "voice_unavailable", requestId: speech.requestId, reason: "Use local output." });
		await waitFor(() => expect(invoked("voice_synthesize")).toHaveLength(1));
		const requestId = required(invoked("voice_synthesize")[0], "native synthesis call")[1].requestId;
		retire(view, action);
		await waitFor(() =>
			expect(invoked("voice_synthesize_cancel")).toContainEqual(["voice_synthesize_cancel", { requestId }]),
		);
		await act(async () => pending.resolve(wav));
		expect(createURL).not.toHaveBeenCalled();
		expect(FakeAudio.instances).toEqual([]);
		expect(synth.speak).not.toHaveBeenCalled();
	});

	it.each(["Stop", "unmount"] as const)(
		"%s retires native readiness before synthesis starts",
		async (action) => {
			const status = deferred<{ supported: boolean }>();
			desktopOutput(
				true,
				async () => wav,
				() => status.promise,
			);
			const view = outputHook();
			const speech = await hookReply(view);
			server({ type: "voice_unavailable", requestId: speech.requestId, reason: "Use local output." });
			await waitFor(() => expect(invoked("voice_synthesis_status").length).toBeGreaterThan(0));
			retire(view, action);
			await act(async () => status.resolve({ supported: true }));
			expect(invoked("voice_synthesize")).toEqual([]);
			expect(synth.speak).not.toHaveBeenCalled();
			expect(createURL).not.toHaveBeenCalled();
		},
	);

	it.each(retirements)(
		"%s releases a native playback URL exactly once despite late ended",
		async (action) => {
			desktopOutput();
			const view = outputHook();
			const speech = await hookReply(view);
			server({ type: "voice_unavailable", requestId: speech.requestId, reason: "Use local output." });
			await waitFor(() => expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(1));
			expect(createURL).toHaveBeenCalledTimes(1);
			const player = required(FakeAudio.instances[0], "native playback instance");
			const ended = player.onended;
			retire(view, action);
			expect(player.pause).toHaveBeenCalled();
			act(() => ended?.());
			view.unmount();
			expect(revokeURL.mock.calls.filter(([url]) => url === player.src)).toHaveLength(1);
			expect(FakeAudio.instances).toHaveLength(1);
			expect(synth.speak).not.toHaveBeenCalled();
		},
	);

	it.each(["ended", "play rejection"])(
		"ignores a replaced daemon player's late %s without replay or clearing the new output",
		async (callback) => {
			const pending = deferred<void>();
			FakeAudio.playNext = () => pending.promise;
			const view = outputHook();
			const first = await hookReply(view, "first");
			server({ type: "voice_speech", requestId: first.requestId, mime: "audio/mpeg", data: "QUJD" });
			const old = required(FakeAudio.instances[0], "first daemon playback instance");
			const ended = old.onended;
			act(() => view.result.current.stopSpeaking());
			FakeAudio.playNext = undefined;
			const second = await hookReply(view, "second");
			server({ type: "voice_speech", requestId: second.requestId, mime: "audio/mpeg", data: "REVG" });
			expect(view.result.current.speaking).toBe(true);
			await act(async () => {
				if (callback === "ended") {
					ended?.();
					pending.resolve();
				} else pending.reject(new Error("Old play failed after replacement."));
			});
			expect(view.result.current.speaking).toBe(true);
			expect(FakeAudio.instances).toHaveLength(2);
			expect(synth.speak).not.toHaveBeenCalled();
		},
	);
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
			if (command === "voice_status") return { available: true };
			if (command === "voice_synthesis_status") return { supported: false };
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
	});

	it("keeps an edited reviewed dictation spoken without treating draft insertion as typing", async () => {
		desktop("hi");
		render(<Harness initial={withVoice(false, false)} />);
		await waitFor(() => expect(talk()).toBeEnabled());
		await userEvent.click(talk());
		await userEvent.click(await screen.findByRole("button", { name: "Stop and review" }));
		await waitFor(() => expect(box()).toHaveValue("hi"));
		await userEvent.type(box(), " edited{Enter}");
		expect(sentOf("send").at(-1)?.text).toBe("hi edited");
		completeReply("edited-dictation", "Hello there!");
		await waitFor(() => expect(synth.speak).toHaveBeenCalledTimes(1));
	});

	it("offers sending on stop as a remembered option while recording", async () => {
		desktop("hola");
		render(<Harness initial={withVoice(false)} />);
		await waitFor(() => expect(talk()).toBeEnabled());
		await userEvent.click(talk());
		const option = await screen.findByRole("switch", { name: "Send when I stop" });
		expect(option).toHaveAttribute("title", "Send after 2 seconds of silence following speech");
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

/** No microphone: controllable web samples and genuinely asynchronous recorder completion. */
class MeterContext {
	static byte = 128;
	createAnalyser() {
		return { fftSize: 512, getByteTimeDomainData: (samples: Uint8Array) => samples.fill(MeterContext.byte) };
	}
	createMediaStreamSource() {
		return { connect: () => {} };
	}
	close = async () => {};
}
class AsyncRecorder extends FakeRecorder {
	stop = vi.fn(() => {
		if (this.state !== "recording") throw new Error("Recorder already stopped");
		this.state = "inactive";
		setTimeout(() => {
			this.ondataavailable?.({ data: new Blob(["fake audio"], { type: this.mimeType }) });
			this.onstop?.();
		}, 100);
	});
}

describe("sending after a speech pause", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		MeterContext.byte = 128;
		vi.stubGlobal("AudioContext", MeterContext);
		vi.stubGlobal("MediaRecorder", AsyncRecorder);
	});
	async function capture(kind: "daemon" | "native", pending?: ReturnType<typeof deferred<unknown>>) {
		h.tauri = kind === "native";
		h.invoke = vi.fn(async (command: string) => {
			if (command === "voice_status") return { available: true };
			if (command === "voice_stop") return pending ? pending.promise : { text: "hello" };
			if (command === "voice_synthesis_status") return { supported: false };
			return undefined;
		});
		const view = renderHook(() => {
			const [state, dispatch] = useReducer(reduce, withVoice(kind === "daemon", false));
			h.server = (payload) =>
				dispatch({ type: "server", message: { ...payload, seq: ++seq } as ServerMessage });
			return useVoice(state, sendMessage);
		});
		await act(async () => {});
		await act(async () => view.result.current.start());
		expect(view.result.current.phase).toBe("recording");
		return view;
	}
	async function samples(kind: "daemon" | "native", active: boolean, count: number) {
		MeterContext.byte = active ? 132 : 128;
		for (let i = 0; i < count; i++) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
				if (kind === "native") h.listeners.get("voice://level")?.({ payload: { level: active ? 0.4 : 0 } });
			});
		}
	}
	async function transcript(kind: "daemon" | "native") {
		if (kind === "daemon") {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			const request = required(sentOf("voice_transcribe").at(-1), "pause transcription");
			server({ type: "voice_transcript", requestId: request.requestId, text: "hello" });
		}
	}
	for (const kind of ["daemon", "native"] as const) {
		it(`${kind}: sends once after two seconds of quiet following speech, without a button`, async () => {
			const view = await capture(kind);
			await samples(kind, false, 25);
			expect(view.result.current.phase).toBe("recording");
			await samples(kind, true, 1);
			await samples(kind, false, 20);
			expect(view.result.current.phase).toBe("recording");
			await samples(kind, false, 1);
			await transcript(kind);
			expect(sentOf("send")).toEqual([{ type: "send", text: "hello", requestId: expect.any(String) }]);
			await samples(kind, false, 25);
			expect(sentOf("send")).toHaveLength(1);
			if (kind === "native") expect(invoked("voice_stop")).toHaveLength(1);
			else expect(FakeRecorder.instances[0]?.stop).toHaveBeenCalledTimes(1);
		});
		it(`${kind}: disabled retains manual review instead of silence sending`, async () => {
			localStorage.removeItem("gentle-dot-voice-send");
			const view = await capture(kind);
			await samples(kind, true, 1);
			await samples(kind, false, 25);
			expect(view.result.current.phase).toBe("recording");
			act(() => view.result.current.stop());
			await act(async () => {});
			await transcript(kind);
			expect(view.result.current.draft?.text).toBe("hello");
			expect(sentOf("send")).toEqual([]);
		});
		it(`${kind}: cancelling retires quiet state and the next recording needs fresh activity`, async () => {
			const view = await capture(kind);
			await samples(kind, true, 1);
			await samples(kind, false, 10);
			act(() => view.result.current.cancel());
			await samples(kind, false, 25);
			expect(sentOf("send")).toEqual([]);
			expect(sentOf("voice_transcribe")).toEqual([]);
			expect(invoked("voice_stop")).toHaveLength(0);
			await act(async () => view.result.current.start());
			await samples(kind, false, 25);
			expect(view.result.current.phase).toBe("recording");
		});
	}
	for (const action of ["cancel", "unmount", "replace"] as const) {
		it(`retires a pending daemon recorder completion after ${action}`, async () => {
			const view = await capture("daemon");
			await samples("daemon", true, 1);
			await samples("daemon", false, 21);
			expect(FakeRecorder.instances[0]?.stop).toHaveBeenCalledTimes(1);
			if (action === "unmount") view.unmount();
			else {
				act(() => view.result.current.cancel());
				if (action === "replace") await act(async () => view.result.current.start());
			}
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			expect(sentOf("voice_transcribe")).toEqual([]);
			expect(sentOf("send")).toEqual([]);
			if (action === "replace") expect(view.result.current.phase).toBe("recording");
		});
	}
	it("manual and automatic stop share a single asynchronous recorder stop", async () => {
		const view = await capture("daemon");
		await samples("daemon", true, 1);
		await samples("daemon", false, 21);
		act(() => view.result.current.stop());
		await transcript("daemon");
		expect(FakeRecorder.instances[0]?.stop).toHaveBeenCalledTimes(1);
		expect(sentOf("voice_transcribe")).toHaveLength(1);
		expect(sentOf("send")).toHaveLength(1);
	});
	for (const action of ["cancel", "unmount", "replace"] as const) {
		for (const settle of ["resolve", "reject"] as const) {
			it(`ignores a native stop ${settle} after ${action}`, async () => {
				const pending = deferred<unknown>();
				const view = await capture("native", pending);
				await samples("native", true, 1);
				await samples("native", false, 21);
				expect(invoked("voice_stop")).toHaveLength(1);
				if (action === "unmount") view.unmount();
				else {
					act(() => view.result.current.cancel());
					if (action === "replace") await act(async () => view.result.current.start());
				}
				await act(async () => {
					if (settle === "resolve") pending.resolve({ text: "stale dictation" });
					else pending.reject(new Error("stale failure"));
				});
				expect(sentOf("send")).toEqual([]);
				if (action === "replace") {
					expect(view.result.current.phase).toBe("recording");
					expect(view.result.current.note).toBeUndefined();
				}
			});
		}
	}
});
