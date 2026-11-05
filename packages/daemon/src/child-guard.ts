import { watch, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POLICY_ENV } from "./extensions/approval-guard.ts";

/**
 * The approval guard for subagents (S25.4). Gentle Shell's subagents are child engines (`pi --mode
 * rpc`) that load only their own child extensions plus the extensions they discover in the engine's
 * home, never the `-e` the assistant's engine gets. So the daemon puts this file in that home's
 * `extensions` folder: it loads the guard in a child of the assistant's engine and does nothing
 * anywhere else (the main engine already has the guard, and an engine Gentle Dot did not start has
 * no policy from the daemon). It imports the guard from the daemon's own install, never from a
 * path the environment names. Defense in depth only: the proxy and the app's native approvals are
 * the boundary, and the agent's shell can change files between the daemon's checks.
 */
export const CHILD_GUARD_NAME = "gentle-dot-child-guard.ts";

/** Where the engine's child engines find the file: `<agentHome>/extensions/`. */
export function childGuardFile(agentHome: string): string {
	return join(agentHome, "extensions", CHILD_GUARD_NAME);
}

/** The file's text, importing the guard at `guardPath`. */
export function childGuardText(guardPath: string): string {
	return [
		"// Written by Gentle Dot at every engine start and put back when changed. It loads the approval",
		"// guard into the subagents of the assistant's engine; anywhere else it does nothing.",
		`import guard from ${JSON.stringify(guardPath)};`,
		"",
		"export default function gentleDotChildGuard(pi: Parameters<typeof guard>[0]): void {",
		`\tif (process.env.GENTLE_PI_AGENTS_CHILD === "1" && process.env.${POLICY_ENV} !== undefined) guard(pi, { subagent: true });`,
		"}",
		"",
	].join("\n");
}

export type ChildGuardInstall =
	| { ok: true; file: string }
	| { ok: false; reason: "not-a-folder" | "cannot-be-written"; file: string };

/**
 * Puts the child guard in place. An `extensions` folder that became a symlink is replaced by a
 * real folder without ever writing through the link, and a folder that cannot be written is
 * reported instead of thrown: the caller turns subagents off.
 */
export function installChildGuardFile(agentHome: string, guardPath: string): ChildGuardInstall {
	const folder = join(agentHome, "extensions");
	const file = childGuardFile(agentHome);

	try {
		const stat = existsSync(folder) ? lstatSync(folder) : null;
		if (stat?.isSymbolicLink()) {
			// Never write through the link: drop it and make our own folder.
			rmSync(folder, { force: true });
			mkdirSync(folder, { recursive: true });
		} else if (stat && !stat.isDirectory()) {
			return { ok: false, reason: "not-a-folder", file };
		} else if (!stat) {
			mkdirSync(folder, { recursive: true });
		}

		writeFileSync(file, childGuardText(guardPath), { mode: 0o600 });
		chmodSync(file, 0o600);
		return { ok: true, file };
	} catch {
		return { ok: false, reason: "cannot-be-written", file };
	}
}

/**
 * Puts the file back when it changes or disappears while the engine runs, saying so for each
 * repair. Returns the stop function. Best effort: a file the agent can write is a race it can
 * always win, and this is defense in depth, not the boundary.
 */
export function watchChildGuard(
	agentHome: string,
	guardPath: string,
	log: (line: string) => void,
	onCannotWrite?: () => void,
): () => void {
	const file = childGuardFile(agentHome);
	const expected = childGuardText(guardPath);
	let stopped = false;
	/** One report per episode: the poll runs every 250ms and must not shout each time. */
	let reported = false;

	const repair = () => {
		if (stopped) return;
		try {
			const intact = existsSync(file) && readFileSync(file, "utf8") === expected;
			if (intact) {
				reported = false;
				return;
			}
			const install = installChildGuardFile(agentHome, guardPath);
			if (install.ok) {
				reported = false;
				log(`[Daemon] Child guard put back: ${install.file}`);
				return;
			}
			if (install.reason === "cannot-be-written" && !reported) {
				reported = true;
				log(`[Daemon] The child guard folder cannot be written (${install.file}), subagents are off`);
				onCannotWrite?.();
			}
		} catch {
			// keep watching; the next event tries again
		}
	};

	let watcher: ReturnType<typeof watch> | null = null;
	try {
		watcher = watch(join(agentHome, "extensions"), { persistent: false }, repair);
	} catch {
		watcher = null;
	}
	// A deletion can be reported on the file itself even when the folder watcher misses it.
	const poll = setInterval(repair, 250);

	return () => {
		stopped = true;
		clearInterval(poll);
		watcher?.close();
	};
}
