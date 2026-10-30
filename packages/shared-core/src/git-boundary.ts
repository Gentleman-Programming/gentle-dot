import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Runs `fn` with the current permissions. */
export type EngineAccess = (fn: () => void) => void;

/** The default access that runs `fn` directly. */
export const directAccess: EngineAccess = (fn) => fn();

/**
 * Gives the workspace its own git repository (#51). Without one, git commands from the
 * workspace resolve the repository root upward; when the user's HOME is itself a repo
 * (dotfiles), the engine's startup preflight snapshots the whole HOME, exceeds its time
 * budget, and the daemon's 30 s `switch_session` handshake times out so the agent is
 * SIGKILLed in a loop. A workspace `.git` stops the resolution at the workspace boundary.
 * Prefers `git init`; without a git binary (some containers), writes the minimal
 * repository skeleton (HEAD, config, refs, objects) that git rev-parse accepts.
 */
export function ensureGitBoundary(
	workspace: string,
	access: EngineAccess = directAccess,
	runGit: (workspace: string) => void = defaultGitInit,
): void {
	if (existsSync(join(workspace, ".git"))) return;
	// spawnSync runs synchronously, so it is safe under access(): with a switched engine user,
	// the initialized repository belongs to the engine, never to the daemon (S25.8).
	try {
		access(() => runGit(workspace));
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	access(() => {
		const git = join(workspace, ".git");
		mkdirSync(git, { recursive: true, mode: 0o700 });
		mkdirSync(join(git, "refs", "heads"), { recursive: true, mode: 0o700 });
		mkdirSync(join(git, "objects"), { recursive: true, mode: 0o700 });
		writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(
			join(git, "config"),
			"[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n",
		);
	});
}

function defaultGitInit(workspace: string): void {
	const result = spawnSync("git", ["init", "-q", "--initial-branch=main", "."], { cwd: workspace });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`git init failed: ${result.stderr}`);
}