import { describe, it } from "vitest";

export const WINDOWS_APP_CHANNEL =
	"Windows admits only the native production app channel (daemon.ts startDaemon); the protocol is covered on Linux and macOS";

export const INHERITED_APP_CHANNEL =
	"Windows uses the native production channel, not inherited Unix fd 3; Linux and macOS cover fd 3";

export const SERVER_MODE =
	"Server mode runs the engine as another POSIX user (setuid); it is Linux only and covered on Linux";

const windows = process.platform === "win32";

/** Only daemon tests requiring a generic Duplex app channel lack Windows coverage. */
export const describeWithAppChannel: ReturnType<typeof describe.skipIf> = describe.skipIf(windows);

/** Server-mode tests are absent on Windows; desktop and generic file behavior remain active. */
export const itServerMode: ReturnType<typeof it.skipIf> = it.skipIf(windows);

export const describeWithInheritedAppChannel: ReturnType<typeof describe.skipIf> = describe.skipIf(windows);

if (windows) {
	console.info(`Windows-only test skip: ${WINDOWS_APP_CHANNEL}`);
	console.info(`Windows-only test skip: ${SERVER_MODE}`);
	console.info(`Windows-only test skip: ${INHERITED_APP_CHANNEL}`);
}
