import type { RecordingNoteDisplay } from "./i18n-voice-messages.ts";
import { guessLanguage, pickVoice } from "./speech.ts";

type Synthesis = Pick<SpeechSynthesis, "getVoices" | "speak" | "cancel"> &
	Partial<Pick<SpeechSynthesis, "addEventListener" | "removeEventListener">>;
type Player = Pick<HTMLAudioElement, "play" | "pause" | "onended" | "onerror"> & {
	setSinkId?: (id: string) => Promise<void>;
};
export interface NativeOutput {
	available(): Promise<boolean>;
	requestId(): string;
	synthesize(requestId: string, text: string, locale: string): Promise<number[]>;
	cancel(requestId: string): Promise<void>;
	wav(bytes: number[]): { src: string; release(): void };
}
interface OutputOptions {
	synthesis?: Synthesis;
	utterance?: (text: string) => SpeechSynthesisUtterance;
	audio: (src: string) => Player;
	language: string;
	onSpeaking(value: boolean): void;
	onError(message: string, display?: RecordingNoteDisplay): void;
	clock?: { after(ms: number, fn: () => void): () => void };
	routing?: { selection(): string | null; supported(): boolean };
	native?: NativeOutput;
}

/** One output at a time. stop() retires callbacks, voice discovery and audio fallback together. */
export function createVoiceOutput(options: OutputOptions) {
	const { synthesis: synth, onSpeaking, onError } = options;
	const clock = options.clock ?? {
		after: (ms: number, fn: () => void) => {
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		},
	};
	let generation = 0;
	let dispose = () => {};
	function stop() {
		++generation;
		dispose();
		dispose = () => {};
		synth?.cancel();
		onSpeaking(false);
	}
	function fail(id: number, message: string, display?: RecordingNoteDisplay) {
		if (id !== generation) return;
		stop();
		if (display) onError(message, display);
		else onError(message);
	}
	function sayBrowserLocal(text: string) {
		stop();
		const id = generation;
		if (!synth || !options.utterance) {
			fail(id, "System speech is unavailable in this runtime.", "outputUnavailable");
			return;
		}
		onSpeaking(true);
		let clearWait = () => {};
		const unwatch = () => {
			clearWait();
			synth.removeEventListener?.("voiceschanged", ready);
		};
		const ready = () => {
			if (id !== generation || dispose !== unwatch) return;
			try {
				const voices = synth.getVoices();
				if (!voices.length) return;
				unwatch();
				const utterance = options.utterance!(text);
				const language = guessLanguage(text) ?? options.language.slice(0, 2).toLowerCase();
				utterance.lang = language;
				const voice = pickVoice(voices, language, options.language);
				if (voice) utterance.voice = voice;
				utterance.onend = () => {
					if (id === generation) stop();
				};
				utterance.onerror = () =>
					fail(
						id,
						"System speech failed. Check the installed voices and audio output.",
						"outputSystemFailed",
					);
				dispose = () => {
					unwatch();
					utterance.onend = null;
					utterance.onerror = null;
				};
				synth.speak(utterance);
			} catch {
				fail(id, "System speech failed. Check the installed voices and audio output.", "outputSystemFailed");
			}
		};
		dispose = unwatch;
		// Bound discovery even when the runtime never emits voiceschanged.
		clearWait = clock.after(1500, () => {
			ready();
			if (id === generation && dispose === unwatch)
				fail(id, "No system voices became available. Check the installed speech voices.", "outputNoVoices");
		});
		synth.addEventListener?.("voiceschanged", ready);
		ready();
	}
	const ROUTING_ERROR =
		"Selected audio output is unavailable. Check output support, permission and device connection.";
	function selectedOutput(): string | null {
		const sink = options.routing?.selection() ?? null;
		if (sink !== null && !options.routing?.supported()) throw new Error(ROUTING_ERROR);
		return sink;
	}
	async function playRouted(
		id: number,
		text: string,
		src: string,
		sink: string | null,
		release = () => {},
		allowFallback = true,
	) {
		if (id !== generation) {
			release();
			return;
		}
		let released = false;
		const cleanup = () => {
			if (!released) {
				released = true;
				release();
			}
		};
		const fallback = () => {
			if (id !== generation) return;
			if (sink !== null || !allowFallback) fail(id, ROUTING_ERROR, "outputRouting");
			else sayLocal(text);
		};
		try {
			const player = options.audio(src);
			dispose = () => {
				player.onended = null;
				player.onerror = null;
				try {
					player.pause();
				} finally {
					cleanup();
				}
			};
			player.onended = () => {
				if (id === generation) stop();
			};
			player.onerror = fallback;
			if (sink !== null) {
				if (!player.setSinkId) throw new Error(ROUTING_ERROR);
				await player.setSinkId(sink);
			}
			if (id !== generation) return;
			await player.play();
		} catch {
			cleanup();
			fallback();
		}
	}
	function sayLocal(text: string) {
		if (!options.native && !options.routing) {
			sayBrowserLocal(text);
			return;
		}
		stop();
		const id = generation;
		let sink: string | null;
		try {
			sink = selectedOutput();
		} catch {
			fail(id, ROUTING_ERROR, "outputRouting");
			return;
		}
		onSpeaking(true);
		void (async () => {
			try {
				const native = options.native;
				const available = native ? await native.available() : false;
				if (id !== generation) return;
				if (!available || !native) {
					if (sink !== null) fail(id, ROUTING_ERROR, "outputRouting");
					else sayBrowserLocal(text);
					return;
				}
				const requestId = native.requestId();
				dispose = () => {
					void native.cancel(requestId).catch(() => {});
				};
				const locale = guessLanguage(text) ?? options.language;
				const bytes = await native.synthesize(requestId, text, locale);
				if (id !== generation) return;
				dispose = () => {};
				const wav = native.wav(bytes);
				await playRouted(id, text, wav.src, sink, wav.release, false);
			} catch (error) {
				// These registry errors contain no request text or device metadata.
				const actionable =
					error === "Speech request session limit reached; restart the app" ||
					error === "Speech synthesis is busy";
				fail(
					id,
					actionable ? error : "Local speech failed. Check speech support and the selected output.",
					actionable ? undefined : "outputLocalFailed",
				);
			}
		})();
	}
	function sayAudio(text: string, src: string) {
		if (options.routing) {
			stop();
			const id = generation;
			try {
				const sink = selectedOutput();
				onSpeaking(true);
				void playRouted(id, text, src, sink);
			} catch {
				fail(id, ROUTING_ERROR, "outputRouting");
			}
			return;
		}
		stop();
		const id = generation;
		onSpeaking(true);
		const fallback = () => {
			if (id === generation) sayLocal(text);
		};
		try {
			const player = options.audio(src);
			dispose = () => {
				player.onended = null;
				player.onerror = null;
				player.pause();
			};
			player.onended = () => {
				if (id === generation) stop();
			};
			player.onerror = fallback;
			void player.play().catch(fallback);
		} catch {
			fallback();
		}
	}
	return { stop, sayLocal, sayAudio };
}
