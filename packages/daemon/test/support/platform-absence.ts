// Suites whose subject this host does not have, with the reason and what the host uses instead,
// announced on raw stderr so a plain `pnpm test` never shows a silent skip.
//
// `fixture-capabilities.ts` substitutes a *mechanism* for a fixture (a junction for a directory link,
// a probe for a privilege the host may or may not have). This file is for a *subject that does not
// exist* on the host: there is nothing to substitute, so the suite skips and says so by name.
//
// - The app's channel as an inherited **fd 3** (S25.1). Windows inherits no such descriptor: the app
//   creates a named pipe before it spawns the daemon and hands the name over in
//   `GENTLE_DOT_CHANNEL_PIPE` (W7), which `app-channel-pipe.test.ts` covers on every platform.
// - **Server mode** (S25.8). The daemon runs as root and takes the engine's user for a synchronous
//   call with `setuid`/`setegid`; Windows has no such call, so `engineAccess` refuses there and the
//   daemon never enters server mode. The desktop path (`directAccess`) is what Windows uses.
//
// The line goes to raw stderr rather than `console.warn`, for the reason W18 and W23 measured:
// vitest's default reporter drops console output around a skipped test, so `pnpm test` would show
// `N skipped` with no reason at all.
//
// The host is injected with the same default a production call takes, so both branches are asserted
// on any machine rather than only the one this host happens to be (W23's pattern).

const ABSENT_FD3 =
	"Windows inherits no fd 3, and the app's channel there is the named pipe it names in " +
	"GENTLE_DOT_CHANNEL_PIPE (W7); app-channel-pipe.test.ts covers it on every platform";
const ABSENT_SERVER_MODE =
	"Windows has no setuid/setegid, so the daemon never takes the engine's user; it runs the " +
	"desktop path (directAccess) instead";

/** The one message an absent subject prints, and the only channel a plain `pnpm test` shows. */
export function absenceLine(where: string, reason: string): string {
	return `platform-absence: skipping ${where}; ${reason}\n`;
}

function announce(where: string, reason: string): void {
	process.stderr.write(absenceLine(where, reason));
}

/**
 * Whether the app's channel arrives as an inherited fd 3 (S25.1).
 * On Windows it does not: the channel is a named pipe, so the suite skips and says what covers it.
 */
export function hasInheritedAppChannel(where: string, host: NodeJS.Platform = process.platform): boolean {
	if (host !== "win32") return true;
	announce(where, ABSENT_FD3);
	return false;
}

/** Whether the daemon can take the engine's user for a call (S25.8). On Windows it cannot. */
export function hasServerMode(where: string, host: NodeJS.Platform = process.platform): boolean {
	if (host !== "win32") return true;
	announce(where, ABSENT_SERVER_MODE);
	return false;
}
