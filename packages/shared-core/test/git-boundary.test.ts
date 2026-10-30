import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ensureGitBoundary } from "../src/git-boundary.js";
import { directAccess } from "../daemon/src/engine-access.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "gentle-dot-test-"));
}

function spawnGit(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function gitOut(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git failed: ${result.stderr}`);
	return String(result.stdout).trim();
}

const canonical = (path: string) => realpathSync.native(path);

describe("ensureGitBoundary", () => {
	it("creates a git repo in the workspace so git never resolves upward to the user's HOME (#51)", () => {
		const outer = tempDir();
		spawnGit(outer, ["init", "-q"]);
		const workspace = join(outer, ".gentle-dot", "workspace");
		mkdirSync(workspace, { recursive: true });
		ensureGitBoundary(workspace);
		// git rev-parse from the workspace now stops at the workspace, not at the parent repo.
		const top = gitOut(["rev-parse", "--show-toplevel"], workspace);
		expect(canonical(top)).toBe(canonical(workspace));
	});

	it("leaves an existing workspace repo as it is", () => {
		const workspace = tempDir();
		spawnGit(workspace, ["init", "-q"]);
		writeFileSync(join(workspace, ".git", "sentinel"), "keep me");
		ensureGitBoundary(workspace);
		expect(readFileSync(join(workspace, ".git", "sentinel"), "utf8")).toBe("keep me");
	});

	it("writes a minimal .git when no git binary is available", () => {
		const outer = tempDir();
		spawnGit(outer, ["init", "-q"]);
		const workspace = join(outer, "workspace");
		mkdirSync(workspace, { recursive: true });
		ensureGitBoundary(workspace, directAccess, () => {
			throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
		});
		expect(readFileSync(join(workspace, ".git", "HEAD"), "utf8")).toContain("refs/heads/");
		const top = gitOut(["rev-parse", "--show-toplevel"], workspace);
		expect(canonical(top)).toBe(canonical(workspace));
	});

	it("runs under custom access so the repo belongs to the engine user (S25.8)", () => {
		let accessUser: string | undefined;
		const customAccess: typeof directAccess = (fn) => {
			accessUser = process.getuid?.()?.toString() ?? "root";
			return fn();
		};
		const workspace = tempDir();
		ensureGitBoundary(workspace, customAccess);
		expect(accessUser).toBeDefined();
		expect(existsSync(join(workspace, ".git"))).toBe(true);
	});
});