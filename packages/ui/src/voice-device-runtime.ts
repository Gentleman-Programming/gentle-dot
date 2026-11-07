import type { VoiceSourceDisplay } from "./i18n-voice-messages.ts";
import { createVoiceDevices, type VoiceDevices } from "./voice-devices.ts";
import { type CheckDriver, createVoiceChecks, validDiagnosticToken } from "./voice-diagnostics.ts";
import { VoiceFailure } from "./voice-failures.ts";
import type { NativeOutput } from "./voice-output.ts";

export type VoiceSource =
	| { kind: "daemon" | "native" }
	| { kind: "none"; reason?: string; reasonDisplay?: VoiceSourceDisplay };
export type NativeCatalog = {
	supported: boolean;
	devices: Array<{ id: string; label: string; isDefault: boolean }>;
};
/** Same priority as useVoice: capable daemon recorder first, desktop recognizer second. */
export function chooseVoiceSource(
	desktop: boolean,
	transcribe: boolean,
	native: { available: boolean; reason?: string; reasonDisplay?: VoiceSourceDisplay } | undefined,
	secure: boolean,
	recorder: boolean,
): VoiceSource {
	if (transcribe && secure && recorder) return { kind: "daemon" };
	if (desktop) {
		if (!native) return { kind: "none" };
		if (native.available) return { kind: "native" };
		const reasonDisplay = native.reason == null ? "noRecorder" : native.reasonDisplay;
		return {
			kind: "none",
			reason: native.reason ?? "This browser cannot record audio.",
			...(reasonDisplay ? { reasonDisplay } : {}),
		};
	}
	if (!transcribe) return { kind: "none" };
	return {
		kind: "none",
		reason: secure ? "This browser cannot record audio." : "Voice needs a secure page (HTTPS or localhost).",
		reasonDisplay: secure ? "noRecorder" : "insecure",
	};
}
interface RuntimeDependencies {
	devices: VoiceDevices;
	nativeDevices(): Promise<NativeCatalog>;
	startNative(locale: string, deviceId?: string, diagnosticToken?: string): Promise<void>;
	getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

/** Injected public seam; constructing it performs no storage, IPC or media action. */
export function createVoiceDeviceRuntime(deps: RuntimeDependencies) {
	let source: VoiceSource = { kind: "none" };
	let checkDriver: CheckDriver | undefined;
	let captureOwner: symbol | undefined;
	const checks = createVoiceChecks(() => checkDriver);
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const fn of [...listeners]) fn();
	};
	function selection(slot: "nativeInput" | "browserInput" | "browserOutput") {
		const result = deps.devices.read();
		if (result.status !== "ok")
			throw new VoiceFailure(
				"Could not read voice device preferences. Clear saved choices in Settings.",
				"preferences",
			);
		return result.preferences[slot];
	}
	async function startNativeInput(locale: string, current = () => true, diagnosticToken?: string) {
		if (diagnosticToken !== undefined && !validDiagnosticToken(diagnosticToken))
			throw new VoiceFailure("Invalid voice diagnostic token.", "diagnosticToken");
		if (!current()) throw new VoiceFailure("Recording was cancelled.", "cancelled");
		const id = selection("nativeInput");
		if (id !== null) {
			const catalog = await deps.nativeDevices();
			if (!catalog.supported)
				throw new VoiceFailure("Selected native input is unsupported on this platform.", "nativeUnsupported");
			if (!catalog.devices.some((d) => d.id === id))
				throw new VoiceFailure("Selected input is missing or unavailable.", "nativeMissing");
		}
		if (!current()) throw new VoiceFailure("Recording was cancelled.", "cancelled");
		if (diagnosticToken === undefined) await deps.startNative(locale, id ?? undefined);
		else await deps.startNative(locale, id ?? undefined, diagnosticToken);
	}
	async function openBrowserInput(current = () => true) {
		if (!current()) throw new VoiceFailure("Recording was cancelled.", "cancelled");
		const id = selection("browserInput");
		if (id !== null) {
			const catalog = await deps.devices.enumerate();
			const selected = deps.devices.currentSelection("browserInput", catalog.devices);
			if (
				catalog.status !== "ok" ||
				!catalog.devices.some((d) => d.kind === "audioinput" && d.deviceId === id) ||
				selected.status === "unsupported"
			)
				throw new VoiceFailure("Selected browser input is missing or unavailable.", "browserMissing");
		}
		if (!current()) throw new VoiceFailure("Recording was cancelled.", "cancelled");
		try {
			return await deps.getUserMedia({ audio: id === null ? true : { deviceId: { exact: id } } });
		} catch {
			throw new VoiceFailure(
				"Microphone access was denied. Allow it to talk to the assistant.",
				"microphoneDenied",
			);
		}
	}
	return {
		devices: deps.devices,
		startNativeInput,
		openBrowserInput,
		outputSelection: () => selection("browserOutput"),
		checks,
		captureBusy: () => captureOwner !== undefined,
		claimCapture() {
			if (captureOwner !== undefined) return undefined;
			const owner = Symbol("voice capture");
			captureOwner = owner;
			return () => {
				if (captureOwner === owner) captureOwner = undefined;
			};
		},
		registerChecks(driver: CheckDriver) {
			checkDriver = driver;
			return () => {
				if (checkDriver !== driver) return;
				void checks.cancel();
				checkDriver = undefined;
			};
		},
		route: () => source,
		setRoute(next: VoiceSource) {
			if (
				next.kind === source.kind &&
				("reason" in next ? next.reason : undefined) === ("reason" in source ? source.reason : undefined)
			) {
				// Display ownership can change without a route/control notification.
				if (next.kind === "none" && source.kind === "none" && next.reasonDisplay !== source.reasonDisplay)
					source = next;
				return;
			}
			source = next;
			notify();
		},
		subscribe(fn: () => void) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		async catalog() {
			const browser = await deps.devices.enumerate();
			try {
				return { browser, native: await deps.nativeDevices(), nativeError: false };
			} catch {
				return { browser, native: { supported: false, devices: [] } as NativeCatalog, nativeError: true };
			}
		},
		nativeDevices: deps.nativeDevices,
	};
}
export type VoiceDeviceRuntime = ReturnType<typeof createVoiceDeviceRuntime>;

let shared: VoiceDeviceRuntime | undefined;
/** Lazy accessors tolerate Node/SSR and blocked storage. No import-time browser actions. */
export function voiceDeviceRuntime(): VoiceDeviceRuntime {
	if (shared) return shared;
	const media = () => (typeof navigator === "undefined" ? undefined : navigator.mediaDevices);
	const devices = createVoiceDevices({
		storage: {
			getItem: (key) => globalThis.localStorage.getItem(key),
			setItem: (key, value) => globalThis.localStorage.setItem(key, value),
			removeItem: (key) => globalThis.localStorage.removeItem(key),
		},
		secureContext: globalThis.isSecureContext === true,
		sinkSupported:
			typeof HTMLAudioElement !== "undefined" && typeof HTMLAudioElement.prototype.setSinkId === "function",
		media: {
			...(media()?.enumerateDevices ? { enumerateDevices: () => media()!.enumerateDevices() } : {}),
			...(media()?.getUserMedia
				? { getUserMedia: (constraints: { audio: true }) => media()!.getUserMedia(constraints) }
				: {}),
		},
	});
	shared = createVoiceDeviceRuntime({
		devices,
		nativeDevices: async () => (await import("./voice-device-native.ts")).nativeDeviceCatalog(),
		startNative: async (locale, id, token) =>
			(await import("./voice-device-native.ts")).startNativeVoice(locale, id, token),
		getUserMedia: async (constraints) => {
			if (!media()?.getUserMedia) throw new Error("Microphone unavailable.");
			return media()!.getUserMedia(constraints);
		},
	});
	return shared;
}

// Lazy session identity plus monotonic counter: no reused IDs after Stop or failure.
let session: string | undefined;
let request = 0;
export function nativeOutputAdapter(runtime = voiceDeviceRuntime()): NativeOutput {
	return {
		available: async () => (await runtime.nativeDevices()).supported,
		requestId: () => {
			session ??= globalThis.crypto.randomUUID();
			return `${session}-${++request}`;
		},
		synthesize: async (requestId, text, locale) =>
			(await import("./voice-device-native.ts")).synthesizeNativeVoice(requestId, text, locale),
		cancel: async (requestId) => (await import("./voice-device-native.ts")).cancelNativeSynthesis(requestId),
		wav: (bytes) => {
			const src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "audio/wav" }));
			return { src, release: () => URL.revokeObjectURL(src) };
		},
	};
}
