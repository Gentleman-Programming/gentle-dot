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

/** One shared load of the event module (under Vitest mocks, a second concurrent import got the real one). */
let events: Promise<typeof import("@tauri-apps/api/event")> | undefined;
const tauriEvents = () => {
	events ??= import("@tauri-apps/api/event");
	return events;
};

export interface NativeVoiceHandlers {
	partial: (text: string) => void;
	level: (level: number) => void;
	error: (message: string) => void;
}

/** Listens to the recognizer's events; resolves with a function that stops listening. */
export async function onNativeVoice(handlers: NativeVoiceHandlers): Promise<() => void> {
	const { listen } = await tauriEvents();
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

/**
 * The input devices the app offers and the one chosen (S1, S4): the stored identity is the device
 * UID and the name is display only. `chosen` is `null` when following the system default.
 */
export interface VoiceInputDevice {
	uid: string;
	name: string;
}

export interface VoiceInputOptions {
	devices: VoiceInputDevice[];
	chosen: string | null;
	default: string | null;
}

/** The devices and the stored choice; a malformed answer reads as no devices yet and the system default. */
export async function loadVoiceInputOptions(): Promise<VoiceInputOptions> {
	const answer = await invoke<{ devices?: unknown; chosen?: unknown; default?: unknown } | undefined>(
		"voice_input_options",
	);
	const list: unknown[] = Array.isArray(answer?.devices) ? answer.devices : [];
	const devices: VoiceInputDevice[] = [];
	for (const entry of list) {
		const device = entry as { uid?: unknown; name?: unknown } | null | undefined;
		if (typeof device?.uid !== "string" || !device.uid) continue;
		devices.push({ uid: device.uid, name: typeof device.name === "string" ? device.name : "" });
	}
	return { devices, chosen: deviceId(answer?.chosen), default: deviceId(answer?.default) };
}

/** A device UID the app gave, or `null` (the system default) when it gave none. */
function deviceId(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

/** Stores the chosen microphone by UID (`null` follows the system default); rejects with the app's reason. */
export async function saveVoiceInput(uid: string | null): Promise<string | null> {
	const result = await invoke<{ chosen?: string | null } | undefined>("voice_input_set", { uid });
	return result?.chosen ?? null;
}

/** Why `voice_start` refused, in the app's words when it gave some. */
export function startRefusal(error: unknown): string {
	if (typeof error === "string" && error) return error;
	if (error instanceof Error && error.message) return error.message;
	return "Could not start listening.";
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
