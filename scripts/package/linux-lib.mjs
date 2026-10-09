// Pure helpers for the Linux packages (S29.3): `package-linux.mjs` builds them in containers
// and `linux-check.mjs` installs them in clean ones.

/** The architectures a Linux package is built for, with each tool's name for them. */
export const ARCHES = Object.freeze({
	arm64: { platform: "linux/arm64", deb: "arm64", runtime: "linux-arm64", pacman: "aarch64" },
	amd64: { platform: "linux/amd64", deb: "amd64", runtime: "linux-x64", pacman: "x86_64" },
});

/**
 * The clean distributions a package is checked on. The official `archlinux` image exists only
 * for amd64, so the Arch package is built and checked for amd64 alone.
 */
export const DISTROS = Object.freeze({
	debian: { image: "debian:bookworm", format: "deb", arches: ["arm64", "amd64"] },
	ubuntu: { image: "ubuntu:24.04", format: "deb", arches: ["arm64", "amd64"] },
	arch: { image: "archlinux:latest", format: "pacman", arches: ["amd64"] },
});

export const PKGREL = 1;

export const PACKAGE_USAGE =
	"usage: package-linux --arch <arm64|amd64> [--out <dir>] [--engram-version <x.y.z>] [--no-arch-package]";
export const CHECK_USAGE =
	"usage: linux-check --arch <arm64|amd64> [--distro <debian|ubuntu|arch>[,…]] [--out <dir>]";

/** Reads `--name value` pairs and bare switches; throws with `usage` on anything unexpected. */
function readFlags(argv, valued, switches, usage) {
	const args = argv.filter((arg) => arg !== "--");
	const options = {};
	for (let i = 0; i < args.length; i++) {
		if (Object.hasOwn(switches, args[i])) {
			options[switches[args[i]]] = true;
			continue;
		}
		const name = valued[args[i]];
		const value = args[i + 1];
		if (!name || value === undefined || value.startsWith("--"))
			throw new Error(`Unexpected argument ${args[i]}.\n${usage}`);
		options[name] = value;
		i++;
	}
	return options;
}

function checkArch(arch, usage) {
	if (!arch) throw new Error(`Missing --arch.\n${usage}`);
	if (!Object.hasOwn(ARCHES, arch))
		throw new Error(`Unknown architecture ${arch}; expected one of ${Object.keys(ARCHES).join(", ")}.`);
}

/** `package-linux` options: the architecture, and whether to build the Arch package (amd64 only). */
export function parsePackageArgs(argv) {
	const options = readFlags(
		argv,
		{ "--arch": "arch", "--out": "out", "--engram-version": "engramVersion" },
		{ "--no-arch-package": "noArchPackage" },
		PACKAGE_USAGE,
	);
	checkArch(options.arch, PACKAGE_USAGE);
	if (options.engramVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(options.engramVersion))
		throw new Error(`--engram-version must be x.y.z, got ${options.engramVersion}.`);
	const { noArchPackage, ...rest } = options;
	return { ...rest, archPackage: !noArchPackage && DISTROS.arch.arches.includes(options.arch) };
}

/** `linux-check` options: the architecture and the distributions, by default every one it supports. */
export function parseCheckArgs(argv) {
	const options = readFlags(
		argv,
		{ "--arch": "arch", "--distro": "distro", "--out": "out" },
		{},
		CHECK_USAGE,
	);
	checkArch(options.arch, CHECK_USAGE);
	const supported = Object.keys(DISTROS).filter((name) => DISTROS[name].arches.includes(options.arch));
	if (options.distro === undefined) return { arch: options.arch, out: options.out, distros: supported };
	const distros = options.distro.split(",").filter(Boolean);
	for (const name of distros) {
		if (!Object.hasOwn(DISTROS, name))
			throw new Error(`Unknown distribution ${name}; expected one of ${Object.keys(DISTROS).join(", ")}.`);
		if (!supported.includes(name))
			throw new Error(`${name} is checked only on ${DISTROS[name].arches.join(", ")}, not ${options.arch}.`);
	}
	return { arch: options.arch, out: options.out, distros };
}

export function debFileName(version, arch) {
	return `gentle-dot_${version}_${ARCHES[arch].deb}.deb`;
}

export function archPackageFileName(version, arch, pkgrel = PKGREL) {
	return `gentle-dot-${version}-${pkgrel}-${ARCHES[arch].pacman}.pkg.tar.zst`;
}

/** The file `linux-check` installs on `distro`. */
export function packageFileFor(distro, version, arch) {
	return DISTROS[distro].format === "deb" ? debFileName(version, arch) : archPackageFileName(version, arch);
}

export function builderImage(arch) {
	return `gentle-dot-linux-builder:${arch}`;
}

export const ARCH_BUILDER_IMAGE = "gentle-dot-arch-builder:latest";

/** Named volumes that keep downloads and compiled crates between builds, and where they mount. */
export function cacheVolumes(arch) {
	return [
		{ name: `gentle-dot-linux-${arch}-cargo`, target: "/usr/local/cargo/registry" },
		{ name: `gentle-dot-linux-${arch}-target`, target: "/work/apps/desktop/src-tauri/target" },
		{ name: `gentle-dot-linux-${arch}-cache`, target: "/work/.cache" },
		{ name: `gentle-dot-linux-${arch}-pnpm`, target: "/pnpm-store" },
	];
}

/**
 * The repository's PKGBUILD with this build's version, release, and the checksum of the
 * .deb it repackages; throws when a field to fill is missing.
 */
export function fillPkgbuild(pkgbuild, { version, arch, sha256, pkgrel = PKGREL }) {
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Not a SHA-256: ${sha256}`);
	const sums = `sha256sums_${ARCHES[arch].pacman}`;
	const fields = [
		[/^pkgver=.*$/m, `pkgver=${version}`],
		[/^pkgrel=.*$/m, `pkgrel=${pkgrel}`],
		[new RegExp(`^${sums}=.*$`, "m"), `${sums}=('${sha256}')`],
	];
	let filled = pkgbuild;
	for (const [pattern, line] of fields) {
		if (!pattern.test(filled)) throw new Error(`The PKGBUILD has no ${line.split("=")[0]} line.`);
		filled = filled.replace(pattern, line);
	}
	return filled;
}

export function formatSize(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms) {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
