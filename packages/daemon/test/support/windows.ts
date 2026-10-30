import { describe, expect, it } from "vitest";

export const WINDOWS_APP_CHANNEL =
	"Windows admits only the native production app channel (daemon.ts startDaemon); the protocol is covered on Linux and macOS";

export const INHERITED_APP_CHANNEL =
	"Windows uses the native production channel, not inherited Unix fd 3; Linux and macOS cover fd 3";

export const SERVER_MODE =
	"Server mode runs the engine as another POSIX user (setuid); it is Linux only and covered on Linux";

export const POSIX_FILE_MODE =
	"Windows has no POSIX permission bits; private files rely on the user profile's ACL. Linux and macOS cover these mode assertions";

export const UNMANAGED_CLI =
	"Windows CLI startup requires a native exact-launch owner record; Linux and macOS cover unmanaged CLI startup";

export const POSIX_LOGIN_SHELL =
	"Windows intentionally ignores POSIX login shells; Linux and macOS cover login-shell Engram discovery";

export const WINDOWS_STOP_ADDON =
	"the runtime build needs the Windows stop addon, built with MSVC (build:windows-stop) on the Windows build machine; runs there and on Linux and macOS";

const windows = process.platform === "win32";

/** Keep the test and its stat/lstat running; only POSIX permission bits are platform-specific. */
export function expectPosixMode(actualMode: number, expectedMode: number): void {
	if (!windows) expect(actualMode & 0o777, POSIX_FILE_MODE).toBe(expectedMode);
}

/** Only daemon tests requiring a generic Duplex app channel lack Windows coverage. */
export const describeWithAppChannel: ReturnType<typeof describe.skipIf> = describe.skipIf(windows);
export const itWithAppChannel: ReturnType<typeof it.skipIf> = it.skipIf(windows);

/** Server-mode tests are absent on Windows; desktop and generic file behavior remain active. */
export const itServerMode: ReturnType<typeof it.skipIf> = it.skipIf(windows);

export const itWithPosixShell: ReturnType<typeof it.skipIf> = it.skipIf(windows);

export const describeWithInheritedAppChannel: ReturnType<typeof describe.skipIf> = describe.skipIf(windows);
export const itWithInheritedAppChannel: ReturnType<typeof it.skipIf> = it.skipIf(windows);
export const itWithUnmanagedCli: ReturnType<typeof it.skipIf> = it.skipIf(windows);

if (windows) {
	console.info(`Windows-only test skip: ${WINDOWS_APP_CHANNEL}`);
	console.info(`Windows-only test skip: ${SERVER_MODE}`);
	console.info(`Windows-only test skip: ${INHERITED_APP_CHANNEL}`);
	console.info(`Windows-only test skip: ${UNMANAGED_CLI}`);
	console.info(`Windows-only test skip: ${POSIX_LOGIN_SHELL}`);
}
