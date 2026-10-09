import type { ClientMessage, ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";

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
			send={(m) => sent.push(m)}
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
	vi.useRealTimers();
	vi.unstubAllGlobals();
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
