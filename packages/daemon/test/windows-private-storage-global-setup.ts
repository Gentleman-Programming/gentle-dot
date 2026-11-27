import { prepareWindowsPrivateStorageForSource } from "../src/runtime-build.ts";

export default function setup() {
	if (process.platform !== "win32") return;
	prepareWindowsPrivateStorageForSource();
}
