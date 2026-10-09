import { invoke } from "@tauri-apps/api/core";

/**
 * The desktop app's speech recognizer (S30.1, contract in L88): the commands
 * `voice_status`, `voice_start`, `voice_stop`, `voice_cancel`, and the events
 * `voice://partial`, `voice://level`, `voice://error`. Desktop only.
 */
export interface NativeVoiceStatus {
	available: boolean;
	reason?: string;
}

const UNAVAILABLE = "Voice is not available on this computer.";

export async function nativeVoiceStatus(): Promise<NativeVoiceStatus> {
	try {
		const status = await invoke<Partial<NativeVoiceStatus> | undefined>("voice_status");
		if (status?.available === true) return { available: true };
		return { available: false, reason: typeof status?.reason === "string" ? status.reason : UNAVAILABLE };
	} catch {
		return { available: false, reason: UNAVAILABLE };
	}
}

/** Starts listening; rejects with the app's reason (for example a denied permission). */
export function startNativeVoice(locale?: string): Promise<void> {
	return invoke<void>("voice_start", locale ? { locale } : {});
}

/** Stops listening and resolves with the final text. */
export async function stopNativeVoice(): Promise<string> {
	const result = await invoke<{ text?: unknown } | undefined>("voice_stop");
	return typeof result?.text === "string" ? result.text : "";
}

export function cancelNativeVoice(): Promise<void> {
	return invoke<void>("voice_cancel");
}

export interface NativeVoiceHandlers {
	partial: (text: string) => void;
	level: (level: number) => void;
	error: (message: string) => void;
}

/** Listens to the recognizer's events; resolves with a function that stops listening. */
export async function onNativeVoice(handlers: NativeVoiceHandlers): Promise<() => void> {
	const { listen } = await import("@tauri-apps/api/event");
	const stops = await Promise.all([
		listen<{ text?: unknown }>("voice://partial", (event) => {
			if (typeof event.payload?.text === "string") handlers.partial(event.payload.text);
		}),
		listen<{ level?: unknown }>("voice://level", (event) => {
			const level = event.payload?.level;
			if (typeof level === "number" && Number.isFinite(level))
				handlers.level(Math.min(1, Math.max(0, level)));
		}),
		listen<{ message?: unknown }>("voice://error", (event) => {
			const message = event.payload?.message;
			handlers.error(typeof message === "string" && message ? message : "Listening stopped.");
		}),
	]);
	return () => {
		for (const stop of stops) stop();
	};
}

/** Why `voice_start` refused, in the app's words when it gave some. */
export function startRefusal(error: unknown): string {
	if (typeof error === "string" && error) return error;
	if (error instanceof Error && error.message) return error.message;
	return "Could not start listening.";
}
