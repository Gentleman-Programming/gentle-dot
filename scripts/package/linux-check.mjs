#!/usr/bin/env node
// Installs the Linux packages from build/linux/ in clean distribution containers and smoke-tests
// them as a non-root user (S29.4; docker/linux-package/check-package.sh):
// `node scripts/package/linux-check.mjs --arch <arm64|amd64> [--distro debian,ubuntu,arch] [--out <dir>]`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHES, DISTROS, formatDuration, packageFileFor, parseCheckArgs } from "./linux-lib.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const say = (line) => process.stdout.write(`${line}\n`);

function main() {
	const { arch, distros, out: outOption } = parseCheckArgs(process.argv.slice(2));
	const out = resolve(process.env.INIT_CWD ?? process.cwd(), outOption ?? join(REPO, "build", "linux"));
	const version = JSON.parse(
		readFileSync(join(REPO, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
	).version;
	const results = [];
	for (const distro of distros) {
		const file = packageFileFor(distro, version, arch);
		const { image } = DISTROS[distro];
		if (!existsSync(join(out, file))) {
			results.push([distro, `missing ${join(out, file)}; run package-linux --arch ${arch} first`, 0]);
			continue;
		}
		say(`\n=== ${distro} (${image}, linux/${arch}): ${file}`);
		const started = Date.now();
		const result = spawnSync(
			"docker",
			[
				"run",
				"--rm",
				"--name",
				`gentle-dot-linux-check-${distro}-${arch}`,
				"--platform",
				ARCHES[arch].platform,
				"-v",
				`${REPO}:/src:ro`,
				"-v",
				`${out}:/pkg:ro`,
				image,
				"bash",
				"/src/docker/linux-package/check-package.sh",
				`/pkg/${file}`,
			],
			{ stdio: "inherit" },
		);
		results.push([
			distro,
			result.status === 0 ? "passed" : `FAILED (exit ${result.status})`,
			Date.now() - started,
		]);
	}
	say("\nSummary");
	for (const [distro, outcome, ms] of results)
		say(`  ${distro.padEnd(8)} ${outcome}${ms ? ` in ${formatDuration(ms)}` : ""}`);
	process.exit(results.every(([, outcome]) => outcome === "passed") ? 0 : 1);
}

try {
	main();
} catch (error) {
	process.stderr.write(`linux-check: ${error.message}\n`);
	process.exit(1);
}
