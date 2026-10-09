#!/usr/bin/env node
// Builds the self-contained Linux packages (S29.3) in Docker, from any machine with Docker:
// `node scripts/package/package-linux.mjs --arch <arm64|amd64> [--out <dir>] [--engram-version <x.y.z>]
// [--no-arch-package]`. It builds the .deb in a Debian 12 container of that architecture (amd64 on an
// Apple Silicon Mac runs emulated) and, for amd64, the Arch package from it. Artifacts land in
// build/linux/; `linux-check.mjs` installs them in clean containers.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ARCH_BUILDER_IMAGE,
	ARCHES,
	archPackageFileName,
	builderImage,
	cacheVolumes,
	debFileName,
	fillPkgbuild,
	formatDuration,
	formatSize,
	parsePackageArgs,
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

/** Runs `step` and records how long it took. */
function timed(timings, label, step) {
	const started = Date.now();
	say(`\n=== ${label}`);
	const value = step();
	timings.push([label, Date.now() - started]);
	return value;
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildDeb({ arch, engramVersion }, scratch, timings) {
	const { platform } = ARCHES[arch];
	timed(timings, `Builder image ${builderImage(arch)}`, () =>
		docker([
			"build",
			"--platform",
			platform,
			"-t",
			builderImage(arch),
			join(REPO, "docker", "linux-package"),
		]),
	);
	const volumes = cacheVolumes(arch).flatMap(({ name, target }) => ["-v", `${name}:${target}`]);
	const env = engramVersion ? ["-e", `ENGRAM_VERSION=${engramVersion}`] : [];
	timed(timings, `.deb for ${arch} (stage the runtime, tauri build)`, () =>
		docker([
			"run",
			"--rm",
			"--name",
			`gentle-dot-linux-build-${arch}`,
			"--platform",
			platform,
			"-v",
			`${REPO}:/src:ro`,
			"-v",
			`${scratch}:/out`,
			...volumes,
			...env,
			builderImage(arch),
			"gentle-dot-build-deb",
		]),
	);
	const built = readdirSync(scratch).filter((name) => name.endsWith(".deb"));
	if (built.length !== 1) throw new Error(`Expected one .deb in ${scratch}, found ${built.length}.`);
	return { deb: join(scratch, built[0]), manifest: join(scratch, "runtime-MANIFEST.json") };
}

function buildArchPackage(deb, version, scratch, timings) {
	const arch = "amd64";
	const work = join(scratch, "arch");
	mkdirSync(work);
	const debName = debFileName(version, arch);
	copyFileSync(deb, join(work, debName));
	const pkgbuild = readFileSync(join(REPO, "packaging", "arch", "PKGBUILD"), "utf8");
	writeFileSync(join(work, "PKGBUILD"), fillPkgbuild(pkgbuild, { version, arch, sha256: sha256(deb) }));
	chmodSync(work, 0o777);
	timed(timings, `Arch builder image ${ARCH_BUILDER_IMAGE}`, () =>
		docker([
			"build",
			"--platform",
			ARCHES[arch].platform,
			"-t",
			ARCH_BUILDER_IMAGE,
			join(REPO, "packaging", "arch"),
		]),
	);
	timed(timings, "Arch package (makepkg)", () =>
		docker([
			"run",
			"--rm",
			"--name",
			"gentle-dot-arch-build",
			"--platform",
			ARCHES[arch].platform,
			"-v",
			`${work}:/build`,
			ARCH_BUILDER_IMAGE,
			"gentle-dot-build-arch",
		]),
	);
	return join(work, archPackageFileName(version, arch));
}

function main() {
	const options = parsePackageArgs(process.argv.slice(2));
	const { arch } = options;
	const out = resolve(process.env.INIT_CWD ?? process.cwd(), options.out ?? join(REPO, "build", "linux"));
	const version = JSON.parse(
		readFileSync(join(REPO, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
	).version;
	// Docker Desktop shares the system temp folder with containers.
	const scratch = mkdtempSync(join(tmpdir(), `gentle-dot-linux-${arch}-`));
	const started = Date.now();
	const timings = [];
	say(`Gentle Dot ${version} for linux/${arch}; scratch ${scratch}`);

	const built = buildDeb(options, scratch, timings);
	mkdirSync(out, { recursive: true });
	const artifacts = [join(out, debFileName(version, arch))];
	copyFileSync(built.deb, artifacts[0]);
	copyFileSync(built.manifest, join(out, `runtime-${ARCHES[arch].runtime}.json`));
	if (options.archPackage) {
		const pkg = buildArchPackage(built.deb, version, scratch, timings);
		artifacts.push(join(out, archPackageFileName(version, arch)));
		copyFileSync(pkg, artifacts[1]);
	} else say(`\nNo Arch package for ${arch} (the archlinux image is amd64-only, or --no-arch-package).`);
	rmSync(scratch, { recursive: true });

	say("\nTimings");
	for (const [label, ms] of timings) say(`  ${formatDuration(ms).padStart(12)}  ${label}`);
	say(`  ${formatDuration(Date.now() - started).padStart(12)}  total`);
	say("\nArtifacts");
	for (const path of artifacts) {
		const { size } = statSync(path);
		say(`  ${path}  ${formatSize(size)} (${size} bytes)  sha256 ${sha256(path)}`);
	}
}

try {
	main();
} catch (error) {
	process.stderr.write(`package-linux: ${error.message}\n`);
	process.exit(1);
}
