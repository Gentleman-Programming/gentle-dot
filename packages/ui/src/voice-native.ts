import { invoke } from "@tauri-apps/api/core";
import type { RecordingNoteDisplay, VoiceSourceDisplay } from "./i18n-voice-messages.ts";
import { type VoiceDiagnostic, validateNativeDiagnostic, validDiagnosticToken } from "./voice-diagnostics.ts";
import { VoiceFailure } from "./voice-failures.ts";

/**
 * The desktop app's speech recognizer (S30.1, contract in L88): the commands
 * `voice_status`, `voice_start`, `voice_stop`, `voice_cancel`, and the events
 * `voice://partial`, `voice://level`, `voice://error`. Desktop only.
 */
export interface NativeVoiceStatus {
	available: boolean;
	reason?: string;
	/** Renderer-only ownership of an authored unavailable fallback. */
	reasonDisplay?: VoiceSourceDisplay;
}

const UNAVAILABLE = "Voice is not available on this computer.";

export async function nativeVoiceStatus(): Promise<NativeVoiceStatus> {
	try {
		const status = await invoke<Partial<NativeVoiceStatus> | undefined>("voice_status");
		if (status?.available === true) return { available: true };
		const reason = typeof status?.reason === "string" ? status.reason : undefined;
		return {
			available: false,
			reason: reason ?? UNAVAILABLE,
			...(reason === undefined ? { reasonDisplay: "nativeUnavailable" as const } : {}),
		};
	} catch {
		return { available: false, reason: UNAVAILABLE, reasonDisplay: "nativeUnavailable" };
	}
}

/** Starts listening; rejects with the app's reason (for example a denied permission). */
export function startNativeVoice(
	locale?: string,
	deviceId?: string,
	diagnosticToken?: string,
): Promise<void> {
	if (diagnosticToken !== undefined && !validDiagnosticToken(diagnosticToken))
		return Promise.reject(new VoiceFailure("Invalid voice diagnostic token.", "diagnosticToken"));
	return invoke<void>("voice_start", {
		...(locale ? { locale } : {}),
		...(deviceId !== undefined ? { deviceId } : {}),
		...(diagnosticToken === undefined ? {} : { diagnosticToken }),
	});
}

/** Metadata only; support is not permission or successful capture. */
export function nativeInputDevices(): Promise<import("./voice-device-runtime.ts").NativeCatalog> {
	return invoke("voice_input_devices");
}

export function synthesizeNativeVoice(requestId: string, text: string, locale: string): Promise<number[]> {
	return invoke<number[]>("voice_synthesize", { requestId, text, locale });
}

export function cancelNativeSynthesis(requestId: string): Promise<void> {
	return invoke<void>("voice_synthesize_cancel", { requestId });
}

/** Stops listening and resolves with the final text. */
export async function stopNativeVoice(): Promise<string> {
	const result = await invoke<{ text?: unknown } | undefined>("voice_stop");
	return typeof result?.text === "string" ? result.text : "";
}

export function cancelNativeVoice(): Promise<void> {
	return invoke<void>("voice_cancel");
}

/** One shared load of the event module (under Vitest mocks, a second concurrent import got the real one). */
let events: Promise<typeof import("@tauri-apps/api/event")> | undefined;
const tauriEvents = () => {
	events ??= import("@tauri-apps/api/event");
	return events;
};

export interface NativeVoiceHandlers {
	diagnostic?: (metadata: VoiceDiagnostic) => void;
	partial: (text: string) => void;
	level: (level: number) => void;
	error: (message: string, display?: RecordingNoteDisplay) => void;
}

/** Listens to the recognizer's events; resolves with a function that stops listening. */
export async function onNativeVoice(handlers: NativeVoiceHandlers): Promise<() => void> {
	const { listen } = await tauriEvents();
	const stops: Array<() => void> = [];
	// Each successful subscription is retained even when a later one fails.
	try {
		stops.push(
			await listen<{ text?: unknown }>("voice://partial", (event: { payload: { text?: unknown } }) => {
				if (typeof event.payload?.text === "string") handlers.partial(event.payload.text);
			}),
		);
		stops.push(
			await listen<{ level?: unknown }>("voice://level", (event: { payload: { level?: unknown } }) => {
				const level = event.payload?.level;
				if (typeof level === "number" && Number.isFinite(level))
					handlers.level(Math.min(1, Math.max(0, level)));
			}),
		);
		stops.push(
			await listen<{ message?: unknown }>("voice://error", (event: { payload: { message?: unknown } }) => {
				const message = event.payload?.message;
				if (typeof message === "string") handlers.error(message || "Listening stopped.");
				else handlers.error("Listening stopped.", "nativeStopped");
			}),
		);
		if (handlers.diagnostic)
			stops.push(
				await listen<unknown>("voice://diagnostic", (event: { payload: unknown }) => {
					const value = validateNativeDiagnostic(event.payload);
					if (value) handlers.diagnostic?.(value);
				}),
			);
	} catch (error) {
		for (const stop of stops) stop();
		throw error;
	}
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

/** Preserve supplied Error/string fallback policies; only identified own origins are marked. */
export function startRefusalDisplay(error: unknown): RecordingNoteDisplay | undefined {
	if (error instanceof VoiceFailure) return error.display;
	return !(error instanceof Error) && typeof error !== "string" ? "nativeStart" : undefined;
}

/**
 * The optional local voice model (S30.5): `voice_model_status|download|cancel|remove` and the
 * `voice://model` event. Nothing downloads unless the user asks.
 */
export interface VoiceModelStatus {
	installed: boolean;
	bytes?: number;
	downloading: boolean;
	received?: number;
	total?: number;
	engine: "parakeet" | "apple" | "none";
}

export interface VoiceModelEvent {
	state: "downloading" | "verifying" | "installed" | "failed" | "removed";
	received?: number;
	total?: number;
	message?: string;
}

export const voiceModelStatus = () => invoke<VoiceModelStatus>("voice_model_status");
export const downloadVoiceModel = () => invoke<void>("voice_model_download");
export const cancelVoiceModel = () => invoke<void>("voice_model_cancel");
export const removeVoiceModel = () => invoke<void>("voice_model_remove");

/** Listens to the model's download and install progress. */
export async function onVoiceModel(handler: (event: VoiceModelEvent) => void): Promise<() => void> {
	const { listen } = await tauriEvents();
	return listen<VoiceModelEvent>("voice://model", (event) => {
		if (event.payload && typeof event.payload.state === "string") handler(event.payload);
	});
}
