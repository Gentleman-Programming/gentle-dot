import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as linuxLib from "../linux-lib.mjs";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const readRepo = (rel) => readFileSync(join(REPO, rel), "utf8");

function hostGit(...args) {
	const run = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
	assert.equal(run.status, 0, `git ${args.join(" ")} failed: ${run.stderr}`);
	return run.stdout.trim();
}

describe("linux worktree packaging regression", () => {
	it("mounts the clone's common Git directory so a linked worktree resolves in the container", () => {
		const common = hostGit("rev-parse", "--path-format=absolute", "--git-common-dir");
		const mounts = linuxLib.gitMountArgs({ repoRoot: REPO, gitCommonDir: common });
		assert.deepEqual(mounts, ["-v", `${common}:${common}:ro`]);
		const source = readRepo("scripts/package/package-linux.mjs");
		assert.ok(
			source.includes("gitMountArgs"),
			"package-linux.mjs never adds the common Git directory mount",
		);
		assert.ok(
			source.includes("readGitCommonDir"),
			"package-linux.mjs never discovers the clone's common Git directory",
		);
	});

	it("keeps the normal checkout invocation unchanged (no extra mount inside the repo)", () => {
		assert.deepEqual(
			linuxLib.gitMountArgs({ repoRoot: "/repo", gitCommonDir: "/repo/.git" }),
			[],
		);
		assert.deepEqual(linuxLib.gitMountArgs({ repoRoot: "/repo" }), []);
	});

	it("keeps heavy scratch under the ignored build/ directory, never /tmp", () => {
		const prefix = linuxLib.scratchPrefix(REPO, "amd64");
		assert.ok(
			prefix.startsWith(`${join(REPO, "build")}/`),
			`scratch prefix escapes build/: ${prefix}`,
		);
		const source = readRepo("scripts/package/package-linux.mjs");
		assert.ok(!source.includes("tmpdir"), "package-linux.mjs still stages scratch via tmpdir");
		assert.ok(
			source.includes("scratchPrefix"),
			"package-linux.mjs never builds scratch under build/",
		);
	});

	it("fails fast in build-deb.sh when the copied /work provenance is unusable", () => {
		const script = readRepo("docker/linux-package/build-deb.sh");
		const copied = script.indexOf("cp -a /src/.git /work/.git");
		assert.ok(copied !== -1, "build-deb.sh lost the /src/.git copy");
		assert.ok(
			script.slice(copied).includes("git rev-parse"),
			"build-deb.sh never verifies the copied /work Git provenance",
		);
	});

	it("builds through the public CLI with the worktree mount and build-local scratch", () => {
		const tmp = mkdtempSync(join(REPO, "build", ".tmp-worktree-cli-"));
		try {
			const stubDir = join(tmp, "bin");
			const outDir = join(tmp, "out");
			mkdirSync(stubDir, { recursive: true });
			mkdirSync(outDir, { recursive: true });
			const log = join(tmp, "docker-args.log");
			writeFileSync(
				join(stubDir, "docker"),
				[
					"#!/usr/bin/env bash",
					"set -u",
					'printf \'%s\\n\' "$*" >> "$STUB_LOG"',
					'if [ "$1" = "run" ]; then',
					'  prev=""',
					'  for arg in "$@"; do',
					'    if [ "$prev" = "-v" ]; then',
					'      case "$arg" in',
					"        *:/out)",
					'          dest="${arg%:/out}"',
					'          touch "$dest/stub-package.amd64.deb"',
					'          printf \'{\\"stub\\":true}\\n\' > "$dest/runtime-MANIFEST.json"',
					"          ;;",
					"      esac",
					"    fi",
					'    prev="$arg"',
					"  done",
					"fi",
					"exit 0",
					"",
				].join("\n"),
			);
			chmodSync(join(stubDir, "docker"), 0o755);
			const run = spawnSync(
				"node",
				[
					"scripts/package/package-linux.mjs",
					"--arch",
					"amd64",
					"--no-arch-package",
					"--out",
					outDir,
				],
				{
					cwd: REPO,
					env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, STUB_LOG: log },
					encoding: "utf8",
				},
			);
			assert.equal(run.status, 0, `package-linux failed.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
			const common = hostGit("rev-parse", "--path-format=absolute", "--git-common-dir");
			const logged = readFileSync(log, "utf8");
			assert.ok(
				logged.includes(`${common}:${common}:ro`),
				`docker run missed the worktree mount ${common}:${common}:ro.\nlogged:\n${logged}`,
			);
			assert.ok(
				logged.includes("GENTLE_DOT_KSNI_TRAY") === false,
				`default build must not pass the KSNI opt-in.\nlogged:\n${logged}`,
			);
			const scratch = /^Gentle Dot .*; scratch (\S+)/m.exec(run.stdout)?.[1];
			assert.ok(scratch, `no scratch path in stdout:\n${run.stdout}`);
			assert.ok(
				scratch.startsWith(`${join(REPO, "build")}/`),
				`scratch escapes build/: ${scratch}`,
			);
			assert.ok(!existsSync(scratch), `scratch was not removed: ${scratch}`);
			assert.equal(
				readdirSync(outDir).filter((name) => name.endsWith(".deb")).length,
				1,
				`no .deb landed in ${outDir}: ${readdirSync(outDir).join(", ")}`,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("git works in a container with /src plus the helper's mount (real docker)", async (t) => {
		const image = linuxLib.builderImage("amd64");
		if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status !== 0)
			return t.skip(`no ${image} image; run the Docker smoke manually`);
		const common = hostGit("rev-parse", "--path-format=absolute", "--git-common-dir");
		const head = hostGit("rev-parse", "HEAD");
		const mounts = linuxLib.gitMountArgs({ repoRoot: REPO, gitCommonDir: common });
		const script = [
			"set -e",
			"cd /src && git rev-parse HEAD",
			"mkdir -p /tmp/smoke && cd /src",
			"git ls-files -z --cached --others --exclude-standard -- . ':!:.codegraph' ':!:.atl' | tar --null --files-from=- --ignore-failed-read -cf - 2>/dev/null | tar -xf - -C /tmp/smoke",
			"cp -a /src/.git /tmp/smoke/.git",
			"cd /tmp/smoke && git rev-parse HEAD",
			"",
		].join("\n");
		const run = spawnSync(
			"docker",
			[
				"run",
				"--rm",
				"--platform",
				"linux/amd64",
				"-v",
				`${REPO}:/src:ro`,
				...mounts,
				image,
				"bash",
				"-c",
				script,
			],
			{ encoding: "utf8" },
		);
		assert.equal(run.status, 0, `container git failed.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
		assert.deepEqual(run.stdout.trim().split("\n"), [head, head]);
	});
});
