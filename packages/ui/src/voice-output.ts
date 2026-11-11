import { validatedWav } from "./voice-output-wav.ts";

type Synthesis = Pick<SpeechSynthesis, "getVoices" | "speak" | "cancel"> &
	Partial<Pick<SpeechSynthesis, "addEventListener" | "removeEventListener">>;
type Player = Pick<HTMLAudioElement, "play" | "pause" | "onended" | "onerror">;

/** Native-first when compiled support is true, independent of microphone status.
 * Unsupported/absent adapters use browser speech; actual native failures never switch backends.
 * The native backend owns its cooperative 60s deadline; no competing UI synthesis timeout.
 */
export interface NativeOutput {
	status(args: Record<string, never>): Promise<{ supported: boolean }>;
	synthesize(args: { requestId: string; text: string; locale: string }): Promise<number[]>;
	cancel(args: { requestId: string }): Promise<void>;
}

export interface VoiceOutputOptions {
	browser?: {
		synthesis: Synthesis;
		/** Adapter owns existing speech.ts language/region policy, not this controller. */
		utterance(text: string, voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisUtterance;
	};
	/** Existing guessLanguage(text) ?? preferred language policy, supplied by the caller. */
	locale(text: string): string;
	/** Caller supplies globally unique, nonempty IDs of at most 128 characters. */
	requestId(): string;
	native?: NativeOutput;
	audio(src: string): Player;
	wav(bytes: Uint8Array): Blob;
	urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
	clock: { after(ms: number, fn: () => void): () => void };
	onSpeaking(value: boolean): void;
	onError(message: string): void;
}

export interface VoiceOutput {
	/** Only explicitly eligible speech reaches here; the hook retains spoken-turn gating. */
	sayLocal(text: string): void;
	/** Retires readiness, native requests and playback; reusable for the next eligible reply. */
	stop(): void;
	/** Permanently retires this controller, including late callbacks. */
	dispose(): void;
}

/** One explicitly eligible reply at a time; retiring a generation makes every late callback inert. */
export function createVoiceOutput(options: VoiceOutputOptions): VoiceOutput {
	const { browser, native, onSpeaking, onError } = options;
	let generation = 0;
	let disposed = false;
	let cleanup = () => {};
	const requestIds = new Set<string>();

	function stop() {
		if (disposed) return;
		++generation;
		const retire = cleanup;
		cleanup = () => {};
		let failed = false;
		try {
			retire();
		} catch {
			failed = true;
		}
		try {
			browser?.synthesis.cancel();
		} catch {
			failed = true;
		}
		onSpeaking(false);
		if (failed) onError("Speech output could not be fully stopped. Check the audio output and retry.");
	}
	const current = (id: number) => !disposed && id === generation;
	function fail(id: number, message: string) {
		if (!current(id)) return;
		stop();
		onError(message);
	}

	function sayBrowser(id: number, text: string) {
		if (!current(id)) return;
		if (!browser) {
			fail(id, "System speech is unavailable. Check installed speech support and retry.");
			return;
		}
		const synth = browser.synthesis;
		let pending = true;
		let clearTimer = () => {};
		const unwatch = () => {
			pending = false;
			clearTimer();
			synth.removeEventListener?.("voiceschanged", ready);
		};
		const ready = () => {
			if (!current(id) || !pending) return;
			try {
				const voices = synth.getVoices();
				if (!voices.length) return;
				unwatch();
				const utterance = browser.utterance(text, voices);
				cleanup = () => {
					utterance.onend = null;
					utterance.onerror = null;
				};
				utterance.onend = () => {
					if (current(id)) stop();
				};
				utterance.onerror = () =>
					fail(id, "System speech failed. Check installed speech voices and audio output.");
				synth.speak(utterance);
			} catch {
				fail(id, "System speech failed. Check installed speech voices and audio output.");
			}
		};
		cleanup = unwatch;
		try {
			clearTimer = options.clock.after(1500, () => {
				ready();
				if (current(id) && pending)
					fail(id, "No system voices became available. Check installed speech voices and retry.");
			});
			synth.addEventListener?.("voiceschanged", ready);
			ready();
		} catch {
			fail(id, "System speech failed. Check installed speech voices and audio output.");
		}
	}

	async function playWav(id: number, bytes: Uint8Array) {
		if (!current(id)) return;
		const src = options.urls.createObjectURL(options.wav(bytes));
		let player: Player | undefined;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			try {
				if (player) {
					player.onended = null;
					player.onerror = null;
					player.pause();
				}
			} finally {
				options.urls.revokeObjectURL(src);
			}
		};
		if (!current(id)) {
			release();
			return;
		}
		cleanup = release;
		try {
			player = options.audio(src);
			if (!current(id)) {
				release();
				return;
			}
			player.onended = () => {
				if (current(id)) stop();
			};
			player.onerror = () =>
				fail(id, "Speech audio playback failed. Check audio output and allow playback, then retry.");
			await player.play();
		} catch {
			fail(id, "Speech audio playback failed. Check audio output and allow playback, then retry.");
		}
	}

	async function sayNative(id: number, text: string) {
		if (!native) return;
		try {
			const requestId = options.requestId();
			if (typeof requestId !== "string" || !requestId || requestId.length > 128 || requestIds.has(requestId))
				throw new Error("Invalid or reused speech request ID");
			requestIds.add(requestId);
			// Register retirement before status/synthesis admission, not after either await.
			cleanup = () => {
				// A retired request's cancellation outcome must not mutate a newer generation.
				try {
					void native.cancel({ requestId }).catch(() => {});
				} catch {
					// Synchronous bridge failure is likewise retired; synthesis errors remain visible below.
				}
			};
			const status = await native.status({});
			if (!current(id)) return;
			if (status.supported === false) {
				cleanup = () => {};
				sayBrowser(id, text);
				return;
			}
			if (status.supported !== true) throw new Error("Invalid native speech support status");
			const bytes = await native.synthesize({ requestId, text, locale: options.locale(text) });
			if (!current(id)) return;
			cleanup = () => {};
			await playWav(id, validatedWav(bytes));
		} catch (error) {
			const sentinel =
				error === "Speech synthesis is busy" ||
				error === "Speech request session limit reached; restart the app";
			fail(
				id,
				sentinel ? error : "Local speech failed. Check installed speech voices and audio output, then retry.",
			);
		}
	}

	function sayLocal(text: string) {
		if (disposed) return;
		stop();
		const id = generation;
		onSpeaking(true);
		if (!current(id)) return;
		if (native) void sayNative(id, text);
		else sayBrowser(id, text);
	}
	function dispose() {
		if (disposed) return;
		stop();
		disposed = true;
		requestIds.clear();
	}
	return { sayLocal, stop, dispose };
}
