import { MAX_VOICE_AUDIO, MAX_VOICE_TEXT } from "@gentle-dot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { newRequestId, type Send } from "./components/types.ts";
import { inDesktop } from "./desktop.ts";
import { guessLanguage, pickVoice, speakableText } from "./speech.ts";
import { type DotState, isBusy } from "./store.ts";
import { voiceLanguage } from "./voice-language.ts";
import {
	cancelNativeVoice,
	type NativeVoiceStatus,
	nativeVoiceOutput,
	nativeVoiceStatus,
	onNativeVoice,
	onVoiceModel,
	startNativeVoice,
	startRefusal,
	stopNativeVoice,
} from "./voice-native.ts";
import { createVoiceOutput, type VoiceOutput } from "./voice-output.ts";
import { VoiceSilence } from "./voice-silence.ts";

export type VoicePhase = "idle" | "recording" | "transcribing";

/** The mic button: usable, or disabled with the reason. */
export type MicState = { available: true } | { available: false; reason: string };

/** Talking to the assistant (S30.2–S30.4), as the composer and the header use it. */
export interface VoiceControls {
	/** Undefined when the mic is not offered at all (the web without an OpenAI key). */
	mic?: MicState;
	phase: VoicePhase;
	/** Seconds since recording started. */
	elapsed: number;
	/** Microphone level, 0 to 1. */
	level: number;
	/** Live text from the desktop recognizer. */
	partial: string;
	/** Why the last attempt did not work. */
	note?: string;
	speaking: boolean;
	muted: boolean;
	start(): void;
	stop(): void;
	cancel(): void;
	stopSpeaking(): void;
	setMuted(muted: boolean): void;
	/** User editing retires output and disarms an old spoken turn, without discarding dictation. */
	typed(): void;
	/** Auto-stop after a speech pause and send, or stop manually and leave text for review. */
	sendOnStop: boolean;
	setSendOnStop(send: boolean): void;
	/** A dictation waiting in the input for review; `id` changes with each one. */
	draft?: { id: number; text: string };
	/** The input took the draft. */
	draftTaken(id: number): void;
	/** The user sent the input: its reply is read aloud when it included a dictation. */
	sent(): void;
}

/** Recordings stop on their own so they fit the daemon's WebSocket limit (S30.2). */
const MAX_RECORDING_MS = 60_000;
const MUTED_KEY = "gentle-dot-voice-muted";
/** Opt in to send after a two-second speech pause; otherwise stop manually to review. */
const SEND_KEY = "gentle-dot-voice-send";
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const REASONS = {
	insecure: "Voice needs a secure page (HTTPS or localhost).",
	noRecorder: "This browser cannot record audio.",
	denied: "Microphone access was denied. Allow it to talk to the assistant.",
	tooLong: "That recording is too long. Keep it under a minute.",
	empty: "I didn't catch anything. Try again.",
} as const;

type Source = { kind: "daemon" | "native" } | { kind: "none"; reason?: string };

/**
 * Where speech becomes text: the daemon (an OpenAI key) when it can and the page may record,
 * else the desktop recognizer. The web offers only the daemon, over HTTPS or localhost.
 */
function chooseSource(desktop: boolean, transcribe: boolean, native: NativeVoiceStatus | undefined): Source {
	const secure = desktop || window.isSecureContext === true;
	const recorder = typeof MediaRecorder !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;
	if (transcribe && secure && recorder) return { kind: "daemon" };
	if (desktop) {
		if (!native) return { kind: "none" };
		return native.available
			? { kind: "native" }
			: { kind: "none", reason: native.reason ?? REASONS.noRecorder };
	}
	if (!transcribe) return { kind: "none" };
	return { kind: "none", reason: secure ? REASONS.noRecorder : REASONS.insecure };
}

interface Recording {
	kind: "daemon" | "native";
	cancelled: boolean;
	silence: VoiceSilence;
	recorder?: MediaRecorder;
	ticker?: ReturnType<typeof setInterval>;
	limit?: ReturnType<typeof setTimeout>;
	stopMeter?: () => void;
}

/** Stops the elapsed-time ticker, the length limit, and the level meter. */
function stopTimers(entry: Recording): void {
	entry.silence.reset();
	clearInterval(entry.ticker);
	clearTimeout(entry.limit);
	entry.stopMeter?.();
}

export function useVoice(state: DotState, send: Send): VoiceControls {
	const desktop = inDesktop();
	const [native, setNative] = useState<NativeVoiceStatus | undefined>(undefined);
	const [phase, setPhaseState] = useState<VoicePhase>("idle");
	const [elapsed, setElapsed] = useState(0);
	const [level, setLevel] = useState(0);
	const [partial, setPartial] = useState("");
	const [note, setNote] = useState<string | undefined>(undefined);
	const [speaking, setSpeaking] = useState(false);
	const [muted, setMutedState] = useState(() => readFlag(MUTED_KEY));

	const phaseNow = useRef<VoicePhase>("idle");
	const recording = useRef<Recording | undefined>(undefined);
	const starting = useRef(false);
	const pendingTranscript = useRef<string | undefined>(undefined);
	const pendingSpeech = useRef<{ requestId: string; text: string } | undefined>(undefined);
	const audio = useRef<HTMLAudioElement | undefined>(undefined);
	const output = useRef<VoiceOutput | undefined>(undefined);
	const outputLive = useRef(false);
	const outputGeneration = useRef(0);
	/** A reply to a spoken message is awaited: the ids of the messages shown before it. */
	const voiceTurn = useRef<Set<string> | undefined>(undefined);
	const latest = useRef(state);
	latest.current = state;
	const mutedNow = useRef(muted);
	mutedNow.current = muted;

	const source = chooseSource(desktop, state.voice.transcribe, native);

	const setPhase = useCallback((next: VoicePhase) => {
		phaseNow.current = next;
		setPhaseState(next);
	}, []);

	const finish = useCallback(
		(reason?: string) => {
			if (recording.current) stopTimers(recording.current);
			recording.current = undefined;
			pendingTranscript.current = undefined;
			setPhase("idle");
			setElapsed(0);
			setLevel(0);
			setPartial("");
			setNote(reason);
		},
		[setPhase],
	);

	const stopSpeaking = useCallback(() => {
		++outputGeneration.current;
		pendingSpeech.current = undefined;
		voiceTurn.current = undefined;
		const player = audio.current;
		audio.current = undefined;
		if (player) {
			player.onended = null;
			player.onerror = null;
			player.pause();
		}
		output.current?.stop();
		if (outputLive.current) setSpeaking(false);
	}, []);

	// Effect ownership recreates a disposed controller during StrictMode's setup/cleanup replay.
	useEffect(() => {
		let live = true;
		outputLive.current = true;
		const locale = (text: string) => guessLanguage(text) ?? navigator.language.slice(0, 2).toLowerCase();
		const synthesis = globalThis.speechSynthesis;
		const controller = createVoiceOutput({
			...(desktop ? { native: nativeVoiceOutput } : {}),
			...(synthesis && typeof SpeechSynthesisUtterance !== "undefined"
				? {
						browser: {
							synthesis,
							utterance: (text: string, voices: readonly SpeechSynthesisVoice[]) => {
								const utterance = new SpeechSynthesisUtterance(text);
								const language = locale(text);
								utterance.lang = language;
								const voice = pickVoice([...voices], language, navigator.language);
								if (voice) utterance.voice = voice;
								return utterance;
							},
						},
					}
				: {}),
			locale,
			// Platform UUIDs do not restart with controllers, hook mounts, or StrictMode setups.
			requestId: () => `voice-${crypto.randomUUID()}`,
			audio: (src) => new Audio(src),
			wav: (bytes) => new Blob([Uint8Array.from(bytes)], { type: "audio/wav" }),
			urls: URL,
			clock: {
				after: (ms, fn) => {
					const timer = window.setTimeout(fn, ms);
					return () => window.clearTimeout(timer);
				},
			},
			onSpeaking: (value) => {
				if (live) setSpeaking(value);
			},
			onError: (message) => {
				if (live) setNote(message);
			},
		});
		output.current = controller;
		return () => {
			live = false;
			outputLive.current = false;
			stopSpeaking();
			controller.dispose();
			output.current = undefined;
		};
	}, [desktop, stopSpeaking]);

	const speakLocally = useCallback((text: string) => {
		if (outputLive.current && !mutedNow.current) output.current?.sayLocal(text);
	}, []);

	const speak = useCallback(
		(reply: string) => {
			const text = speakableText(reply).slice(0, MAX_VOICE_TEXT);
			if (!text || mutedNow.current || !outputLive.current) return;
			stopSpeaking();
			setNote(undefined);
			if (!latest.current.voice.speak) {
				speakLocally(text);
				return;
			}
			const requestId = newRequestId();
			pendingSpeech.current = { requestId, text };
			setSpeaking(true);
			send({ type: "voice_speak", requestId, text });
		},
		[send, speakLocally, stopSpeaking],
	);

	const [sendOnStop, setSendOnStopState] = useState(readFlag(SEND_KEY));
	const sendOnStopNow = useRef(sendOnStop);
	sendOnStopNow.current = sendOnStop;
	const [draft, setDraft] = useState<{ id: number; text: string }>();
	/** The input holds dictated text that has not been sent yet. */
	const dictated = useRef(false);

	const sendTranscript = useCallback(
		(transcript: string) => {
			const text = transcript.trim();
			if (!text) {
				finish(REASONS.empty);
				return;
			}
			if (sendOnStopNow.current) {
				voiceTurn.current = new Set(latest.current.messages.map((m) => m.id));
				send({ type: "send", text, requestId: newRequestId() });
			} else {
				dictated.current = true;
				setDraft((previous) => ({ id: (previous?.id ?? 0) + 1, text }));
			}
			finish();
		},
		[send, finish],
	);

	const setSendOnStop = useCallback((next: boolean) => {
		sendOnStopNow.current = next;
		recording.current?.silence.reset();
		setSendOnStopState(next);
		try {
			if (next) localStorage.setItem(SEND_KEY, "1");
			else localStorage.removeItem(SEND_KEY);
		} catch {
			// Private browsing: the choice lasts for this window only.
		}
	}, []);

	const draftTaken = useCallback((id: number) => {
		setDraft((current) => (current?.id === id ? undefined : current));
	}, []);

	const sent = useCallback(() => {
		voiceTurn.current = dictated.current ? new Set(latest.current.messages.map((m) => m.id)) : undefined;
		dictated.current = false;
	}, []);

	const begin = useCallback(
		(entry: Recording) => {
			const started = Date.now();
			entry.ticker = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
			recording.current = entry;
			setNote(undefined);
			setPartial("");
			setElapsed(0);
			setPhase("recording");
		},
		[setPhase],
	);

	const upload = useCallback(
		async (entry: Recording, blob: Blob, mime: string) => {
			if (entry.cancelled || recording.current !== entry) return;
			setPhase("transcribing");
			const data = await toBase64(blob);
			if (entry.cancelled || recording.current !== entry) return;
			if (data.length > MAX_VOICE_AUDIO) {
				finish(REASONS.tooLong);
				return;
			}
			const requestId = newRequestId();
			pendingTranscript.current = requestId;
			send({ type: "voice_transcribe", requestId, mime: mime.replace(/\s+/g, ""), data });
		},
		[send, finish, setPhase],
	);

	const stop = useCallback(() => {
		const current = recording.current;
		if (!current || phaseNow.current !== "recording") return;
		stopTimers(current);
		// MediaRecorder.onstop is asynchronous too: retire recording before requesting either stop.
		setPhase("transcribing");
		if (current.kind === "daemon") {
			current.recorder?.stop();
			return;
		}
		void stopNativeVoice().then(
			(text) => {
				if (!current.cancelled && recording.current === current) sendTranscript(text);
			},
			(error: unknown) => {
				if (!current.cancelled && recording.current === current) finish(startRefusal(error));
			},
		);
	}, [finish, sendTranscript, setPhase]);

	const stopNow = useRef(stop);
	stopNow.current = stop;
	const observeLevel = useCallback((entry: Recording, value: number) => {
		if (recording.current !== entry || entry.cancelled || phaseNow.current !== "recording") return;
		setLevel(value);
		if (!sendOnStopNow.current) entry.silence.reset();
		else if (entry.silence.sample(value, Date.now())) stopNow.current();
	}, []);

	const startDaemon = useCallback(async () => {
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			finish(REASONS.denied);
			return;
		}
		const type = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
		const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
		const entry: Recording = {
			kind: "daemon",
			cancelled: false,
			silence: new VoiceSilence("daemon"),
			recorder,
		};
		const chunks: Blob[] = [];
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		};
		recorder.onstop = () => {
			for (const track of stream.getTracks()) track.stop();
			if (entry.cancelled || recording.current !== entry) return;
			const mime = recorder.mimeType || type || "audio/webm";
			void upload(entry, new Blob(chunks, { type: mime }), mime);
		};
		recorder.start();
		begin(entry);
		entry.stopMeter = startMeter(stream, (value) => observeLevel(entry, value));
		entry.limit = setTimeout(stop, MAX_RECORDING_MS);
	}, [begin, finish, observeLevel, stop, upload]);

	const startNative = useCallback(async () => {
		try {
			// Apple's recognizer listens in one language: the one chosen in Settings, else the system's.
			await startNativeVoice(voiceLanguage() ?? navigator.language);
		} catch (error) {
			finish(startRefusal(error));
			return;
		}
		begin({ kind: "native", cancelled: false, silence: new VoiceSilence("native") });
	}, [begin, finish]);

	const start = useCallback(() => {
		if (phaseNow.current !== "idle" || starting.current) return;
		stopSpeaking();
		if (source.kind === "none") return;
		starting.current = true;
		const run = source.kind === "daemon" ? startDaemon() : startNative();
		void run.finally(() => {
			starting.current = false;
		});
	}, [source.kind, startDaemon, startNative, stopSpeaking]);

	const cancel = useCallback(() => {
		stopSpeaking();
		const current = recording.current;
		if (!current) return;
		current.cancelled = true;
		if (current.kind === "daemon") {
			if (current.recorder && current.recorder.state !== "inactive") current.recorder.stop();
		} else void cancelNativeVoice().catch(() => {});
		finish();
	}, [finish, stopSpeaking]);

	const setMuted = useCallback(
		(next: boolean) => {
			mutedNow.current = next;
			setMutedState(next);
			try {
				if (next) localStorage.setItem(MUTED_KEY, "1");
				else localStorage.removeItem(MUTED_KEY);
			} catch {
				// Private browsing: the choice lasts for this window only.
			}
			if (next) stopSpeaking();
		},
		[stopSpeaking],
	);

	const typed = useCallback(() => {
		stopSpeaking();
	}, [stopSpeaking]);

	// The desktop recognizer's status and live events.
	useEffect(() => {
		if (!desktop) return;
		let live = true;
		void nativeVoiceStatus().then((status) => {
			if (live) setNative(status);
		});
		const off = onNativeVoice({
			partial: (text) => {
				if (phaseNow.current === "recording") setPartial(text);
			},
			level: (value) => {
				const current = recording.current;
				if (current?.kind === "native") observeLevel(current, value);
			},
			error: (message) => {
				if (recording.current?.kind === "native") finish(message);
			},
		}).catch(() => () => {});
		return () => {
			live = false;
			void off.then((stopListening) => stopListening());
		};
	}, [desktop, finish, observeLevel]);

	// Installing or removing the local model changes what the recognizer can do (#25).
	useEffect(() => {
		if (!desktop) return;
		let live = true;
		const off = onVoiceModel((event) => {
			if (event.state !== "installed" && event.state !== "removed") return;
			void nativeVoiceStatus().then((status) => {
				if (live) setNative(status);
			});
		}).catch(() => () => {});
		return () => {
			live = false;
			void off.then((stopListening) => stopListening());
		};
	}, [desktop]);

	// Answers to voice requests.
	useEffect(() => {
		for (const reply of state.voiceReplies) {
			if (reply.requestId === pendingTranscript.current) {
				pendingTranscript.current = undefined;
				if (reply.type === "voice_transcript") sendTranscript(reply.text);
				else if (reply.type === "voice_unavailable") finish(reply.reason);
			}
			const speech = pendingSpeech.current;
			if (speech && reply.requestId === speech.requestId) {
				pendingSpeech.current = undefined;
				if (!outputLive.current || mutedNow.current) continue;
				if (reply.type === "voice_speech") {
					const generation = outputGeneration.current;
					const player = new Audio(`data:${reply.mime};base64,${reply.data}`);
					audio.current = player;
					const finishPlayback = (reason?: string) => {
						if (!outputLive.current || generation !== outputGeneration.current || audio.current !== player)
							return;
						audio.current = undefined;
						player.onended = null;
						player.onerror = null;
						setSpeaking(false);
						if (reason) {
							player.pause();
							setNote(reason);
						}
					};
					player.onended = () => finishPlayback();
					player.onerror = () => finishPlayback("Could not play spoken reply.");
					setSpeaking(true);
					void player.play().catch(() => finishPlayback("Could not play spoken reply."));
				} else if (reply.type === "voice_unavailable") {
					speakLocally(speech.text);
				}
			}
		}
	}, [state.voiceReplies, sendTranscript, finish, speakLocally]);

	// Read the reply to a spoken message aloud once the assistant finished it.
	useEffect(() => {
		const before = voiceTurn.current;
		if (!before || isBusy(state.agentState)) return;
		const reply = state.messages.findLast((m) => m.role === "assistant" && !before.has(m.id));
		if (!reply || reply.streaming) return;
		voiceTurn.current = undefined;
		if (!reply.note) speak(reply.text);
	}, [state.messages, state.agentState, speak]);

	// Esc cancels a recording before the panel sees it (it would hide the panel).
	useEffect(() => {
		if (phase !== "recording") return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			cancel();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [phase, cancel]);

	// Leaving the chat drops a recording and silences the voice.
	const cancelNow = useRef(cancel);
	cancelNow.current = cancel;
	const stopSpeakingNow = useRef(stopSpeaking);
	stopSpeakingNow.current = stopSpeaking;
	useEffect(
		() => () => {
			cancelNow.current();
			stopSpeakingNow.current();
		},
		[],
	);

	const mic: MicState | undefined =
		source.kind === "none"
			? source.reason
				? { available: false, reason: source.reason }
				: undefined
			: { available: true };

	return {
		...(mic ? { mic } : {}),
		phase,
		elapsed,
		level,
		partial,
		...(note ? { note } : {}),
		speaking,
		muted,
		start,
		stop,
		cancel,
		stopSpeaking,
		setMuted,
		typed,
		sendOnStop,
		setSendOnStop,
		...(draft ? { draft } : {}),
		draftTaken,
		sent,
	};
}

function readFlag(key: string): boolean {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
}

async function toBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** The microphone level from the recording's stream, where the browser can measure it. */
function startMeter(stream: MediaStream, onLevel: (level: number) => void): () => void {
	const Context = globalThis.AudioContext;
	if (!Context) return () => {};
	try {
		const context = new Context();
		const analyser = context.createAnalyser();
		analyser.fftSize = 512;
		context.createMediaStreamSource(stream).connect(analyser);
		const samples = new Uint8Array(analyser.fftSize);
		const timer = setInterval(() => {
			analyser.getByteTimeDomainData(samples);
			let sum = 0;
			for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
			onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3));
		}, 100);
		return () => {
			clearInterval(timer);
			void context.close();
		};
	} catch {
		return () => {};
	}
}
