/**
 * How the daemon touches the engine's own files in server mode (S25.8, B1). The daemon runs as root
 * there, and the engine's folders (`agent`, `home`, `workspace`, `sessions`, `gentle-ai`) belong to
 * the engine's user, who has a shell: any path in them may be a link to a root file, and any file
 * may hold what the engine chose. So every read, write, mkdir, chmod, or removal there runs inside
 * {@link EngineAccess}: the daemon takes the engine's user as its effective user and group (and its
 * group as its only supplementary group) for that synchronous call, and the kernel enforces the
 * engine's own permissions on every path component; what it creates belongs to the engine's user.
 * Then it takes root back. The saved user stays root, and the effective capabilities are dropped
 * while the effective user is not root, so a bracket can neither read nor write a root file.
 *
 * Rules (checked where they can be): the call is synchronous (a returned promise is refused: the
 * work would continue as root), it never starts a process (a child would get root as its real
 * user), and nothing writes a root file meanwhile ({@link insideEngineAccess}; see
 * `private-file.ts`). On Linux the ids change for every thread of the process (glibc broadcasts
 * them), so anything on libuv's thread pool during a bracket runs as the engine's user too: the
 * daemon has no asynchronous file work on root paths (see the static check in the tests). If root
 * cannot be taken back, the daemon stops: it never goes on as the wrong user.
 *
 * On the desktop there is no bracket: {@link directAccess} runs the call as it is.
 */
import type { OsUser } from "./vps.ts";

export type EngineAccess = <T>(fn: () => T) => T;

/** The desktop: the daemon and the engine are the same user. */
export const directAccess: EngineAccess = (fn) => fn();

let depth = 0;

/** True while a bracket runs: a root file must not be written now. */
export function insideEngineAccess(): boolean {
	return depth > 0;
}

function refuseAsync<T>(result: T): T {
	if (typeof (result as { then?: unknown } | null)?.then === "function")
		throw new Error("The engine's files are reached only synchronously.");
	return result;
}

/** Runs `fn` as `user` (see the module comment); nested calls run inside the outer bracket. */
export function engineAccess(user: OsUser, onFatal: (error: Error) => never = fatal): EngineAccess {
	return <T>(fn: () => T): T => {
		if (depth > 0) return refuseAsync(fn());
		const euid = process.geteuid?.() ?? -1;
		if (euid !== 0) {
			// Without root there is nothing to switch to; only the engine's own user may go on.
			if (euid !== user.uid)
				throw new Error(`Server mode: cannot reach the engine's files as uid ${user.uid} without root.`);
			depth++;
			try {
				return refuseAsync(fn());
			} finally {
				depth--;
			}
		}
		const groups = process.getgroups?.() ?? [];
		const egid = process.getegid?.() ?? 0;
		depth++;
		try {
			// Inside the try, so a switch that fails halfway is undone like a finished one.
			process.setgroups?.([user.gid]);
			process.setegid?.(user.gid);
			process.seteuid?.(user.uid);
			return refuseAsync(fn());
		} finally {
			depth--;
			try {
				process.seteuid?.(0);
				process.setegid?.(egid);
				process.setgroups?.(groups);
			} catch (error) {
				onFatal(error as Error);
			}
			if (process.geteuid?.() !== 0 || process.getegid?.() !== egid)
				onFatal(new Error("the daemon did not get its own user back"));
		}
	};
}

function fatal(error: Error): never {
	process.stderr.write(`${new Date().toISOString()} stopping: ${error.message}\n`);
	process.exit(70);
}
