import { MAX_VOICE_AUDIO, MAX_VOICE_TEXT } from "@gentle-dot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { newRequestId, type Send } from "./components/types.ts";
import { inDesktop } from "./desktop.ts";
import type { RecordingNoteDisplay, VoiceSourceDisplay } from "./i18n-voice-messages.ts";
import { speakableText } from "./speech.ts";
import { type DotState, isBusy } from "./store.ts";
import { chooseVoiceSource, nativeOutputAdapter, voiceDeviceRuntime } from "./voice-device-runtime.ts";
import type { CheckObserver } from "./voice-diagnostics.ts";
import { VoiceFailure } from "./voice-failures.ts";
import { voiceLanguage } from "./voice-language.ts";
import {
	cancelNativeVoice,
	type NativeVoiceStatus,
	nativeVoiceStatus,
	onNativeVoice,
	onVoiceModel,
	startRefusal,
	startRefusalDisplay,
	stopNativeVoice,
} from "./voice-native.ts";
import { createVoiceOutput } from "./voice-output.ts";

export type VoicePhase = "idle" | "recording" | "transcribing";

/** The mic button: usable, or disabled with the reason. */
export type MicState =
	| { available: true }
	| { available: false; reason: string; reasonDisplay?: VoiceSourceDisplay };

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
	/** Display provenance from a known voice-owned origin; note itself stays raw. */
	noteDisplay?: RecordingNoteDisplay;
	speaking: boolean;
	muted: boolean;
	start(): void;
	stop(): void;
	cancel(): void;
	stopSpeaking(): void;
	setMuted(muted: boolean): void;
	/** The user sent a typed message: its reply is not read aloud. */
	typed(): void;
	/** Whether a dictation is sent when recording stops, or left in the input for review. */
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
/** Set when a dictation is sent on stop; otherwise it stays in the input for review. */
const SEND_KEY = "gentle-dot-voice-send";
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const REASONS = {
	insecure: "Voice needs a secure page (HTTPS or localhost).",
	noRecorder: "This browser cannot record audio.",
	denied: "Microphone access was denied. Allow it to talk to the assistant.",
	tooLong: "That recording is too long. Keep it under a minute.",
	empty: "I didn't catch anything. Try again.",
} as const;

interface Recording {
	kind: "daemon" | "native";
	cancelled: boolean;
	recorder?: MediaRecorder;
	ticker?: ReturnType<typeof setInterval>;
	limit?: ReturnType<typeof setTimeout>;
	stopMeter?: () => void;
	retireTracks?: () => void;
}

/** Stops the elapsed-time ticker, the length limit, and the level meter. */
function stopTimers(entry: Recording): void {
	clearInterval(entry.ticker);
	clearTimeout(entry.limit);
	entry.stopMeter?.();
}

export function useVoice(state: DotState, send: Send): VoiceControls {
	const desktop = inDesktop();
	const devices = voiceDeviceRuntime();
	const [native, setNative] = useState<NativeVoiceStatus | undefined>(undefined);
	const [phase, setPhaseState] = useState<VoicePhase>("idle");
	const [elapsed, setElapsed] = useState(0);
	const [level, setLevel] = useState(0);
	const [partial, setPartial] = useState("");
	const [notice, setNotice] = useState<{ text: string; display?: RecordingNoteDisplay }>();
	const note = notice?.text;
	const setNote = useCallback((text?: string, display?: RecordingNoteDisplay) => {
		setNotice((current) =>
			current?.text === text && current?.display === display
				? current
				: text === undefined
					? undefined
					: { text, ...(display ? { display } : {}) },
		);
	}, []);
	const [speaking, setSpeaking] = useState(false);
	const [muted, setMutedState] = useState(() => readFlag(MUTED_KEY));

	const phaseNow = useRef<VoicePhase>("idle");
	const recording = useRef<Recording | undefined>(undefined);
	const starting = useRef(false);
	const startingRun = useRef<Promise<void> | undefined>(undefined);
	const retiring = useRef<Promise<void> | undefined>(undefined);
	const inputCheck = useRef<CheckObserver | undefined>(undefined);
	// Retain one terminal-metadata destination after stop{text}, until replacement/cancel.
	const nativeDiagnosticCheck = useRef<CheckObserver | undefined>(undefined);
	const outputSpeaking = useRef(false);
	const outputCheck = useRef<{ observer: CheckObserver; started: boolean } | undefined>(undefined);
	const checkDeadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const nativeListening = useRef<Promise<() => void> | undefined>(undefined);
	const captureGeneration = useRef(0);
	const releaseCapture = useRef<(() => void) | undefined>(undefined);
	const pendingTranscript = useRef<string | undefined>(undefined);
	const pendingSpeech = useRef<{ requestId: string; text: string } | undefined>(undefined);
	const output = useRef<ReturnType<typeof createVoiceOutput> | undefined>(undefined);
	if (!output.current)
		output.current = createVoiceOutput({
			synthesis: globalThis.speechSynthesis,
			utterance:
				typeof SpeechSynthesisUtterance === "undefined"
					? undefined
					: (text) => new SpeechSynthesisUtterance(text),
			audio: (src) => new Audio(src),
			language: navigator.language,
			onSpeaking: (value) => {
				setSpeaking(value);
				outputSpeaking.current = value;
				const check = outputCheck.current;
				if (!check) return;
				if (value) check.started = true;
				else if (check.started)
					queueMicrotask(() => {
						if (outputCheck.current !== check || outputSpeaking.current) return;
						outputCheck.current = undefined;
						clearTimeout(checkDeadline.current);
						check.observer.complete();
					});
			},
			onError: (message, display) => {
				setNote(message, display);
				const check = outputCheck.current;
				outputCheck.current = undefined;
				if (check) {
					clearTimeout(checkDeadline.current);
					if (display) check.observer.error(message, display);
					else check.observer.error(message);
				}
			},
			routing: { selection: devices.outputSelection, supported: () => devices.devices.capabilities().output },
			native: nativeOutputAdapter(devices),
		});
	/** A reply to a spoken message is awaited: the ids of the messages shown before it. */
	const voiceTurn = useRef<Set<string> | undefined>(undefined);
	const latest = useRef(state);
	latest.current = state;
	const mutedNow = useRef(muted);
	mutedNow.current = muted;

	const source = chooseVoiceSource(
		desktop,
		state.voice.transcribe,
		native,
		desktop || globalThis.isSecureContext === true,
		typeof MediaRecorder !== "undefined" &&
			typeof navigator !== "undefined" &&
			navigator.mediaDevices?.getUserMedia !== undefined,
	);
	useEffect(() => {
		devices.setRoute(source);
	}, [devices, source]);

	const setPhase = useCallback((next: VoicePhase) => {
		phaseNow.current = next;
		setPhaseState(next);
	}, []);

	const finish = useCallback(
		(reason?: string, display?: RecordingNoteDisplay) => {
			if (recording.current) stopTimers(recording.current);
			recording.current = undefined;
			pendingTranscript.current = undefined;
			releaseCapture.current?.();
			releaseCapture.current = undefined;
			setPhase("idle");
			setElapsed(0);
			setLevel(0);
			setPartial("");
			setNote(reason, display);
			const check = inputCheck.current;
			inputCheck.current = undefined;
			if (reason) nativeDiagnosticCheck.current = undefined;
			if (check) {
				clearTimeout(checkDeadline.current);
				if (reason) {
					if (display) check.error(reason, display);
					else check.error(reason);
				} else check.complete();
			}
		},
		[setPhase, setNote],
	);

	const stopSpeaking = useCallback(() => {
		const check = outputCheck.current;
		outputCheck.current = undefined;
		if (check) {
			clearTimeout(checkDeadline.current);
			check.observer.error("Output check stopped. Playback is not audible proof.", "checkOutputStopped");
		}
		pendingSpeech.current = undefined;
		voiceTurn.current = undefined;
		output.current?.stop();
	}, []);

	const speakWithSystem = useCallback((text: string) => {
		if (!mutedNow.current) output.current?.sayLocal(text);
	}, []);

	const speak = useCallback(
		(reply: string) => {
			const text = speakableText(reply).slice(0, MAX_VOICE_TEXT);
			if (!text || mutedNow.current) return;
			stopSpeaking();
			setNote(undefined);
			if (!latest.current.voice.speak) {
				speakWithSystem(text);
				return;
			}
			const requestId = newRequestId();
			pendingSpeech.current = { requestId, text };
			send({ type: "voice_speak", requestId, text });
		},
		[send, speakWithSystem, stopSpeaking, setNote],
	);

	const [sendOnStop, setSendOnStopState] = useState(readFlag(SEND_KEY));
	const sendOnStopNow = useRef(sendOnStop);
	sendOnStopNow.current = sendOnStop;
	const [draft, setDraft] = useState<{ id: number; text: string }>();
	/** The input holds dictated text that has not been sent yet. */
	const dictated = useRef(false);

	const sendTranscript = useCallback(
		(transcript: string) => {
			if (inputCheck.current) {
				inputCheck.current.preview(transcript);
				// The controller joins stop text with correlated terminal metadata in either order.
				finish();
				return;
			}
			const text = transcript.trim();
			if (!text) {
				finish(REASONS.empty, "empty");
				return;
			}
			if (sendOnStopNow.current) {
				voiceTurn.current = new Set(latest.current.messages.map((m) => m.id));
				send({ type: "send", text, requestId: newRequestId() });
			} else {
				dictated.current = true;
				setDraft((previous: { id: number; text: string } | undefined) => ({
					id: (previous?.id ?? 0) + 1,
					text,
				}));
			}
			finish();
		},
		[send, finish],
	);

	const setSendOnStop = useCallback((next: boolean) => {
		setSendOnStopState(next);
		try {
			if (next) localStorage.setItem(SEND_KEY, "1");
			else localStorage.removeItem(SEND_KEY);
		} catch {
			// Private browsing: the choice lasts for this window only.
		}
	}, []);

	const draftTaken = useCallback((id: number) => {
		setDraft((current: { id: number; text: string } | undefined) =>
			current?.id === id ? undefined : current,
		);
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
			inputCheck.current?.metadata({
				route: entry.kind,
				stage: "recording",
				pcmSamples: null,
				sampleRate: null,
				compressedBytes: null,
			});
		},
		[setPhase, setNote],
	);

	const upload = useCallback(
		async (blob: Blob, mime: string, generation: number) => {
			if (generation !== captureGeneration.current) return;
			setPhase("transcribing");
			inputCheck.current?.metadata({
				route: "daemon",
				stage: "transcribing",
				pcmSamples: null,
				sampleRate: null,
				compressedBytes: blob.size,
			});
			const data = await toBase64(blob);
			if (generation !== captureGeneration.current) return;
			if (data.length > MAX_VOICE_AUDIO) {
				finish(REASONS.tooLong, "tooLong");
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
		setPhase("transcribing");
		if (current.kind === "daemon") {
			current.recorder?.stop();
			return;
		}
		const generation = captureGeneration.current;
		void stopNativeVoice().then(
			(text) => {
				if (generation === captureGeneration.current) sendTranscript(text);
			},
			(error: unknown) => {
				if (generation === captureGeneration.current) finish(startRefusal(error), startRefusalDisplay(error));
			},
		);
	}, [finish, sendTranscript, setPhase]);

	const startDaemon = useCallback(
		async (generation: number) => {
			let stream: MediaStream;
			try {
				stream = await devices.openBrowserInput(() => generation === captureGeneration.current);
			} catch (error) {
				if (generation === captureGeneration.current) finish(startRefusal(error), startRefusalDisplay(error));
				return;
			}
			if (generation !== captureGeneration.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			let retire = () => {
				for (const track of stream.getTracks()) track.stop();
			};
			try {
				const type = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
				const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
				const entry: Recording = {
					kind: "daemon",
					cancelled: false,
					recorder,
					retireTracks: () => {
						for (const track of stream.getTracks()) track.stop();
						recorder.ondataavailable = null;
						recorder.onstop = null;
						recorder.onerror = null;
					},
				};
				retire = entry.retireTracks!;
				const chunks: Blob[] = [];
				recorder.ondataavailable = (event) => {
					if (event.data.size > 0) chunks.push(event.data);
				};
				recorder.onstop = () => {
					entry.retireTracks?.();
					if (entry.cancelled) return;
					const mime = recorder.mimeType || type || "audio/webm";
					void upload(new Blob(chunks, { type: mime }), mime, generation).catch(() => {
						if (generation === captureGeneration.current)
							finish("Could not transcribe this recording.", "conversion");
					});
				};
				recorder.onerror = () => {
					entry.cancelled = true;
					entry.retireTracks?.();
					if (generation === captureGeneration.current) finish("Audio recording failed.", "recorder");
				};
				recorder.start();
				entry.stopMeter = startMeter(stream, (value) => {
					setLevel(value);
					inputCheck.current?.level(value);
				});
				begin(entry);
				entry.limit = setTimeout(stop, MAX_RECORDING_MS);
			} catch {
				retire();
				if (generation === captureGeneration.current) finish("Could not start the audio recorder.", "start");
			}
		},
		[begin, devices, finish, stop, upload],
	);

	const startNative = useCallback(
		async (generation: number) => {
			try {
				await nativeListening.current;
				if (generation !== captureGeneration.current) return;
				// Apple's recognizer listens in one language: the one chosen in Settings, else the system's.
				await devices.startNativeInput(
					voiceLanguage() ?? navigator.language,
					() => generation === captureGeneration.current,
					inputCheck.current?.diagnosticToken,
				);
			} catch (error) {
				if (generation === captureGeneration.current) finish(startRefusal(error), startRefusalDisplay(error));
				return;
			}
			if (generation !== captureGeneration.current) {
				await cancelNativeVoice();
				return;
			}
			begin({ kind: "native", cancelled: false });
		},
		[begin, devices, finish],
	);

	const start = useCallback(() => {
		if (phaseNow.current !== "idle" || starting.current || retiring.current) return;
		stopSpeaking();
		if (source.kind === "none") return;
		const release = devices.claimCapture();
		if (!release) {
			setNote("Voice input is already recording.", "busy");
			return;
		}
		releaseCapture.current = release;
		if (!inputCheck.current) nativeDiagnosticCheck.current = undefined;
		starting.current = true;
		const generation = ++captureGeneration.current;
		const run = source.kind === "daemon" ? startDaemon(generation) : startNative(generation);
		startingRun.current = run.finally(() => {
			starting.current = false;
			startingRun.current = undefined;
		});
		void startingRun.current.catch(() => {}); // A cancelling owner awaits and reports cleanup errors.
	}, [source.kind, startDaemon, startNative, stopSpeaking, devices, setNote]);

	const cancel = useCallback(() => {
		if (retiring.current) return retiring.current;
		++captureGeneration.current;
		const check = inputCheck.current;
		inputCheck.current = undefined;
		nativeDiagnosticCheck.current = undefined;
		clearTimeout(checkDeadline.current);
		stopSpeaking();
		const current = recording.current;
		if (current) {
			current.cancelled = true;
			stopTimers(current);
			if (current.kind === "daemon" && current.recorder?.state !== "inactive") current.recorder?.stop();
			current.retireTracks?.();
		}
		const cleanup = async () => {
			if (current?.kind === "native") await cancelNativeVoice();
			await startingRun.current;
		};
		retiring.current = cleanup().finally(() => {
			finish();
			retiring.current = undefined;
			check?.preview("");
			check?.error("Input check stopped. Nothing was sent to chat.", "checkInputStopped");
		});
		void retiring.current.catch((error: unknown) => setNote(startRefusal(error), startRefusalDisplay(error)));
		return retiring.current;
	}, [finish, stopSpeaking, setNote]);

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
			diagnostic: (metadata) => {
				const check = nativeDiagnosticCheck.current;
				if (check?.diagnosticToken && metadata.diagnosticToken === check.diagnosticToken)
					check.metadata(metadata);
			},
			partial: (text) => {
				if (phaseNow.current === "recording") {
					setPartial(text);
					inputCheck.current?.preview(text);
				}
			},
			level: (value) => {
				if (phaseNow.current === "recording") {
					setLevel(value);
					inputCheck.current?.level(value);
				}
			},
			error: (message, display) => {
				if (recording.current?.kind === "native") finish(message, display);
			},
		});
		nativeListening.current = off;
		void off.catch(() => {});
		return () => {
			live = false;
			void off.then(
				(stopListening) => stopListening(),
				() => {},
			);
		};
	}, [desktop, finish]);

	// Settings borrows this lifecycle, including its busy/generation guards and recognizer.
	// A lease can only retire the check it created, never a later chat recording.
	const checkActions = useRef<import("./voice-diagnostics.ts").CheckDriver | undefined>(undefined);
	checkActions.current = {
		input(observer: CheckObserver) {
			if (starting.current || retiring.current || devices.captureBusy() || phaseNow.current !== "idle")
				throw new VoiceFailure(
					"Voice input is already recording. Finish it before checking input.",
					"checkInputBusy",
				);
			if (source.kind === "none") {
				const message = source.reason ?? "Voice input is unavailable.";
				if (source.reason === undefined || source.reasonDisplay)
					throw new VoiceFailure(message, source.reasonDisplay ?? "checkInputUnavailable");
				throw new Error(message);
			}
			inputCheck.current = observer;
			nativeDiagnosticCheck.current = source.kind === "native" ? observer : undefined;
			observer.metadata({
				route: source.kind,
				stage: "starting",
				pcmSamples: null,
				sampleRate: null,
				compressedBytes: null,
			});
			checkDeadline.current = setTimeout(() => {
				if (inputCheck.current !== observer) return;
				void cancel().then(
					() => observer.error("Input check reached its one-minute deadline.", "checkDeadline"),
					() => observer.error("Input check cleanup failed.", "checkInputCleanup"),
				);
			}, MAX_RECORDING_MS);
			start();
			return {
				stop() {
					if (inputCheck.current !== observer) return;
					if (starting.current) void devices.checks.cancel();
					else stop();
				},
				async cancel() {
					if (inputCheck.current === observer) await cancel();
				},
			};
		},
		output(observer: CheckObserver) {
			let savedMute: boolean;
			try {
				savedMute = localStorage.getItem(MUTED_KEY) === "1";
			} catch {
				throw new VoiceFailure(
					"Could not read saved voice mute. Output check was not started.",
					"checkMuteRead",
				);
			}
			if (mutedNow.current || savedMute)
				throw new VoiceFailure("Voice output is muted. Unmute before checking output.", "checkMuted");
			if (
				starting.current ||
				retiring.current ||
				devices.captureBusy() ||
				phaseNow.current !== "idle" ||
				outputSpeaking.current ||
				outputCheck.current ||
				pendingSpeech.current
			)
				throw new VoiceFailure(
					"Voice is busy. Finish the current recording or reply before checking output.",
					"checkOutputBusy",
				);
			const check = { observer, started: false };
			outputCheck.current = check;
			checkDeadline.current = setTimeout(() => {
				if (outputCheck.current === check) stopSpeaking();
			}, MAX_RECORDING_MS);
			output.current?.sayLocal("Hello, this is the Gentle Dot voice output check.");
			const cancelOutput = async () => {
				if (outputCheck.current !== check) return;
				outputCheck.current = undefined;
				clearTimeout(checkDeadline.current);
				output.current?.stop();
			};
			return {
				stop: () => {
					void devices.checks.cancel();
				},
				cancel: cancelOutput,
			};
		},
	};
	useEffect(
		() =>
			devices.registerChecks({
				input: (observer) => checkActions.current!.input(observer),
				output: (observer) => checkActions.current!.output(observer),
			}),
		[devices],
	);

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
			if (speech && !mutedNow.current && reply.requestId === speech.requestId) {
				pendingSpeech.current = undefined;
				if (reply.type === "voice_speech") {
					output.current?.sayAudio(speech.text, `data:${reply.mime};base64,${reply.data}`);
				} else if (reply.type === "voice_unavailable") {
					speakWithSystem(speech.text);
				}
			}
		}
	}, [state.voiceReplies, sendTranscript, finish, speakWithSystem]);

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
				? {
						available: false,
						reason: source.reason,
						...(source.reasonDisplay ? { reasonDisplay: source.reasonDisplay } : {}),
					}
				: undefined
			: { available: true };

	return {
		...(mic ? { mic } : {}),
		phase,
		elapsed,
		level,
		partial,
		...(note ? { note, ...(notice?.display ? { noteDisplay: notice.display } : {}) } : {}),
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
