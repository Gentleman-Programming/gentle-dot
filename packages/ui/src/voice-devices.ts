// Browser IDs and native endpoint IDs deliberately occupy different namespaces.
export const VOICE_DEVICE_KEY = "gentle:voice-devices:v1";
export type DeviceSlot = "nativeInput" | "browserInput" | "browserOutput";
export type DevicePreferences = { version: 1 } & Record<DeviceSlot, string | null>;
export type DeviceStatus = "ok" | "invalid" | "storage-error" | "unsupported" | "error";
export type PreferenceResult = { status: DeviceStatus; preferences: DevicePreferences };
export type BrowserDevice = { kind: "audioinput" | "audiooutput"; deviceId: string; label: string };
export type Selection = {
	status: "default" | "available" | "missing" | DeviceStatus;
	deviceId: string | null;
};
export interface DeviceDependencies {
	storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
	media?: {
		enumerateDevices?: () => Promise<ReadonlyArray<{ kind: string; deviceId: string; label: string }>>;
		getUserMedia?: (constraints: { audio: true }) => Promise<{ getTracks(): Array<{ stop(): void }> }>;
	};
	secureContext?: boolean;
	// The caller checks typeof HTMLAudioElement.prototype.setSinkId === 'function'.
	sinkSupported?: boolean;
}
const slots: DeviceSlot[] = ["nativeInput", "browserInput", "browserOutput"];
const defaults = (): DevicePreferences => ({
	version: 1,
	nativeInput: null,
	browserInput: null,
	browserOutput: null,
});
const validId = (id: unknown): id is string =>
	typeof id === "string" && id.length > 0 && id.length <= 1024 && !id.includes("\0");
const validSlot = (slot: unknown): slot is DeviceSlot => slots.includes(slot as DeviceSlot);
function validPreferences(value: unknown): value is DevicePreferences {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const pref = value as Record<string, unknown>;
	return (
		Object.keys(pref).length === 4 &&
		pref.version === 1 &&
		slots.every((slot) => Object.hasOwn(pref, slot) && (pref[slot] === null || validId(pref[slot])))
	);
}

/** No browser globals, hardware access, or storage reads occur at construction/import. */
export function createVoiceDevices(deps: DeviceDependencies) {
	const listeners = new Set<(preferences: DevicePreferences) => void>();
	const result = (status: DeviceStatus, preferences = defaults()): PreferenceResult => ({
		status,
		preferences,
	});
	function read(): PreferenceResult {
		let raw: string | null;
		try {
			if (!deps.storage) return result("storage-error");
			raw = deps.storage.getItem(VOICE_DEVICE_KEY);
		} catch {
			return result("storage-error");
		}
		if (raw === null) return result("ok");
		if (raw.length > 19000) return result("invalid");
		try {
			const pref: unknown = JSON.parse(raw);
			return validPreferences(pref) ? result("ok", { ...pref }) : result("invalid");
		} catch {
			return result("invalid");
		}
	}
	function notify(pref: DevicePreferences) {
		for (const listener of [...listeners]) {
			try {
				listener({ ...pref });
			} catch {
				/* One UI subscriber must not block others. */
			}
		}
	}
	function set(slot: DeviceSlot, deviceId: string | null): PreferenceResult {
		if (!validSlot(slot) || (deviceId !== null && !validId(deviceId))) return result("invalid");
		const current = read();
		// Do not overwrite a future schema or unreadable preference record.
		if (current.status !== "ok") return current;
		if (current.preferences[slot] === deviceId) return current;
		const next = { ...current.preferences, [slot]: deviceId };
		try {
			deps.storage!.setItem(VOICE_DEVICE_KEY, JSON.stringify(next));
		} catch {
			return result("storage-error", current.preferences);
		}
		notify(next);
		return result("ok", next);
	}
	function reset(): PreferenceResult {
		try {
			if (!deps.storage) return result("storage-error");
			deps.storage.removeItem(VOICE_DEVICE_KEY);
		} catch {
			return result("storage-error");
		}
		const pref = defaults();
		notify(pref);
		return result("ok", pref);
	}
	function capabilities() {
		return {
			enumerate: deps.secureContext === true && typeof deps.media?.enumerateDevices === "function",
			permission: deps.secureContext === true && typeof deps.media?.getUserMedia === "function",
			output: deps.secureContext === true && deps.sinkSupported === true,
		};
	}
	function currentSelection(
		slot: DeviceSlot,
		devices: ReadonlyArray<BrowserDevice | { id: string }>,
	): Selection {
		if (!validSlot(slot)) return { status: "invalid", deviceId: null };
		const pref = read();
		if (pref.status !== "ok") return { status: pref.status, deviceId: null };
		const deviceId = pref.preferences[slot];
		if (deviceId === null) return { status: "default", deviceId: null };
		const support = capabilities();
		if ((slot === "browserOutput" && !support.output) || (slot === "browserInput" && !support.enumerate)) {
			return { status: "unsupported", deviceId };
		}
		const found = devices.some((device) =>
			slot === "nativeInput"
				? "id" in device && device.id === deviceId
				: "deviceId" in device &&
					device.deviceId === deviceId &&
					device.kind === (slot === "browserInput" ? "audioinput" : "audiooutput"),
		);
		// Available means metadata matched, NOT that capture/playback or permission succeeded.
		return { status: found ? "available" : "missing", deviceId };
	}
	async function enumerate(): Promise<{ status: DeviceStatus; devices: BrowserDevice[] }> {
		if (!capabilities().enumerate) return { status: "unsupported", devices: [] };
		try {
			const devices = (await deps.media!.enumerateDevices!())
				.slice(0, 256)
				.filter(
					(device) =>
						(device.kind === "audioinput" || device.kind === "audiooutput") && validId(device.deviceId),
				)
				.map((device) => ({
					kind: device.kind as BrowserDevice["kind"],
					deviceId: device.deviceId,
					// Labels are transient local UI metadata, never persisted or sent to diagnostics.
					label: typeof device.label === "string" ? device.label.replaceAll("\0", "").slice(0, 256) : "",
				}));
			return { status: "ok", devices };
		} catch {
			return { status: "error", devices: [] };
		}
	}
	/** Call only from an explicit user action. Never used by construction/enumeration. */
	async function requestPermission(): Promise<{ status: DeviceStatus }> {
		if (!capabilities().permission) return { status: "unsupported" };
		let tracks: Array<{ stop(): void }> = [];
		let status: DeviceStatus = "ok";
		try {
			const stream = await deps.media!.getUserMedia!({ audio: true });
			tracks = stream.getTracks();
		} catch {
			status = "error";
		} finally {
			for (const track of tracks) {
				try {
					track.stop();
				} catch {
					status = "error";
				}
			}
		}
		return { status };
	}
	return {
		read,
		set,
		reset,
		currentSelection,
		capabilities,
		enumerate,
		requestPermission,
		subscribe(listener: (preferences: DevicePreferences) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
export type VoiceDevices = ReturnType<typeof createVoiceDevices>;
