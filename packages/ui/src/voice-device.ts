import type { VoiceInputDevice, VoiceInputOptions } from "./voice-native.ts";

/** The device's name for display, trimmed; the UID is the identity (S4), so the name is never what is stored. */
export function deviceLabel(device: VoiceInputDevice): string {
	return device.name.trim() || "Unnamed microphone";
}

/** True when a stored choice is set and the system no longer lists it (S3): the default is used, the choice is kept. */
export function missingChoice(options: VoiceInputOptions): boolean {
	return (
		options.chosen !== null &&
		options.devices.length > 0 &&
		!options.devices.some((device) => device.uid === options.chosen)
	);
}

/** What the select shows: `""` for the system default, otherwise the stored UID. */
export function deviceValue(options: VoiceInputOptions): string {
	return options.chosen ?? "";
}
