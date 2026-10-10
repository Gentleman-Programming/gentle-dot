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
