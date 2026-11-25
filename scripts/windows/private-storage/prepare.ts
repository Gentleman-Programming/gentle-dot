import { prepareWindowsPrivateStorageForSource } from "../../../packages/daemon/src/runtime-build.ts";

if (process.platform !== "win32") {
	process.stderr.write("Windows private-storage source preparation is available only on Windows.\n");
	process.exit(2);
}

prepareWindowsPrivateStorageForSource();
process.stdout.write("Prepared the local Windows private-storage helper for source mode.\n");
