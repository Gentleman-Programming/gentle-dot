#!/usr/bin/env node
// Native Windows packaging. All executable policy is shared with inert CLI fixtures.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File, treeSize } from "./lib.mjs";
import { runWindowsCli } from "./windows-runtime-policy.mjs";

export { runWindowsCli };

function isKind(path, kind) {
	try {
		return statSync(path)[kind]();
	} catch {
		return false;
	}
}

/** Regular files only: no symlink traversal, as in the prior payload checker. */
function filesIn(dir, prefix = "") {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) return filesIn(join(dir, entry.name), relative);
		return entry.isFile() ? [relative] : [];
	});
}

function nativeIO() {
	return {
		platform: process.platform,
		arch: process.arch,
		node: process.execPath,
		repo: fileURLToPath(new URL("../..", import.meta.url)),
		cwd: process.env.INIT_CWD ?? process.cwd(),
		env: process.env,
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		readJson: (path) => {
			try {
				return JSON.parse(readFileSync(path, "utf8"));
			} catch (cause) {
				throw new Error(`Cannot read packaging metadata: ${path}`, { cause });
			}
		},
		isFile: (path) => isKind(path, "isFile"),
		isDirectory: (path) => isKind(path, "isDirectory"),
		exists: existsSync,
		spawn: spawnSync,
		// Load platform compatibility only after argument/host/stage admission.
		applyConsole: async (runtime, options) => {
			const { applyWindowsConsole } = await import("./windows-console.mjs");
			return applyWindowsConsole(runtime, options);
		},
		filesIn,
		directoriesIn: (dir) =>
			readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name),
		size: (path) => statSync(path).size,
		treeSize,
		sha256File,
		makeScratch: () => mkdtempSync(join(tmpdir(), "gentle-dot-windows-check-")),
		mkdir: (path) => mkdirSync(path, { recursive: true }),
		removeScratch: (path) => rmSync(path, { recursive: true, force: true }),
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await runWindowsCli(process.argv.slice(2), nativeIO());
}
