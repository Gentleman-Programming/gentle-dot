// Deferred desktop boundary: importing the pure device runtime needs no Tauri modules.
import { inDesktop } from "./desktop.ts";
import { nativeInputDevices } from "./voice-native.ts";

export { cancelNativeSynthesis, startNativeVoice, synthesizeNativeVoice } from "./voice-native.ts";

export async function nativeDeviceCatalog() {
	if (!inDesktop()) return { supported: false, devices: [] };
	return nativeInputDevices();
}
