#!/usr/bin/env node
// Checks the desktop crate on Linux (S25.7) in a container of the given architecture, from any
// machine with Docker: `node scripts/package/linux-cargo-check.mjs --arch <arm64|amd64>`. It runs
// `cargo test`, `cargo clippy --all-targets -- -D warnings`, the Secret Service store against a real
// GNOME Keyring on a private session bus, and the app channel's fd 3 checks
// (docker/linux-package/cargo-check.sh). The image builds on the package builder
// (`package-linux.mjs`), which it builds first; compiled crates stay in a volume of their own.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ARCHES,
	builderImage,
	cargoCheckVolumes,
	checkImage,
	formatDuration,
	parseCargoCheckArgs,
} from "./linux-lib.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const say = (line) => process.stdout.write(`${line}\n`);

function docker(args) {
	const result = spawnSync("docker", args, { stdio: "inherit" });
	if (result.status !== 0)
		throw new Error(
			`docker ${args.slice(0, 2).join(" ")} failed (${result.error?.message ?? `exit ${result.status}`}).`,
		);
}

function main() {
	const { arch } = parseCargoCheckArgs(process.argv.slice(2));
	const { platform } = ARCHES[arch];
	const context = join(REPO, "docker", "linux-package");
	const started = Date.now();
	say(`\n=== Builder image ${builderImage(arch)}`);
	docker(["build", "--platform", platform, "-t", builderImage(arch), context]);
	say(`\n=== Check image ${checkImage(arch)}`);
	docker([
		"build",
		"--platform",
		platform,
		"--build-arg",
		`BUILDER=${builderImage(arch)}`,
		"-f",
		join(context, "Dockerfile.check"),
		"-t",
		checkImage(arch),
		context,
	]);
	const volumes = cargoCheckVolumes(arch).flatMap(({ name, target }) => ["-v", `${name}:${target}`]);
	say(`\n=== Linux checks of the desktop crate (linux/${arch})`);
	docker([
		"run",
		"--rm",
		"--name",
		`gentle-dot-linux-cargo-check-${arch}`,
		"--platform",
		platform,
		"-v",
		`${REPO}:/src:ro`,
		...volumes,
		checkImage(arch),
		"bash",
		"/src/docker/linux-package/cargo-check.sh",
	]);
	say(`\nLinux checks passed in ${formatDuration(Date.now() - started)}.`);
}

try {
	main();
} catch (error) {
	process.stderr.write(`linux-cargo-check: ${error.message}\n`);
	process.exit(1);
}
