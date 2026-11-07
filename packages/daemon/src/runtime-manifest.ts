const IMPORTER = "packages/daemon";

/** Exact daemon importer pins; workspace links are not installed into the runtime. */
export function lockedDependenciesFromLock(lockfile: string): Record<string, string> {
	const versions: Record<string, string> = {};
	let section: "importer" | "dependencies" | undefined;
	let name: string | undefined;
	for (const line of lockfile.split("\n")) {
		if (/^ {2}\S/.test(line)) section = line.trim() === `${IMPORTER}:` ? "importer" : undefined;
		else if (section && /^ {4}\S/.test(line))
			section = line.trim() === "dependencies:" ? "dependencies" : "importer";
		else if (section === "dependencies" && /^ {6}\S/.test(line))
			name = line.trim().slice(0, -1).replace(/^'|'$/g, "");
		else if (section === "dependencies" && name && /^ {8}version: /.test(line)) {
			const version = line.trim().slice("version: ".length).split("(")[0] ?? "";
			if (!version.startsWith("link:")) versions[name] = version;
		}
	}
	if (Object.keys(versions).length === 0) throw new Error(`No ${IMPORTER} dependencies in the lockfile.`);
	return versions;
}

const SDK = "@earendil-works/pi-coding-agent";
const CODEMODE = "@earendil-works/pi-codemode";

/** Read one key in pnpm's indentation-based lock format, not arbitrary YAML. */
function entry(lines: string[], indent: number, key: string) {
	const prefixes = [key, `'${key}'`, `"${key}"`].map((name) => `${" ".repeat(indent)}${name}:`);
	const matches = lines.flatMap((line, index) => {
		const prefix = prefixes.find((candidate) => line.startsWith(candidate));
		if (!prefix) return [];
		const value = line.slice(prefix.length);
		if (value && !value.startsWith(" ")) return [];
		return [{ index, value: value.trim() }];
	});
	if (matches.length !== 1) throw new Error(`Missing or ambiguous lock entry: ${key}`);
	const { index, value } = matches[0]!;
	let end = index + 1;
	while (end < lines.length) {
		const line = lines[end]!;
		if (line.trim() && line.search(/\S/) <= indent) break;
		end++;
	}
	return { value, lines: lines.slice(index + 1, end) };
}

function block(lines: string[], indent: number, key: string): string[] {
	const found = entry(lines, indent, key);
	if (
		(found.value !== "" && found.value !== "{}") ||
		(found.value === "{}" && found.lines.some((line) => line.trim()))
	)
		throw new Error(`Unsupported lock block: ${key}`);
	return found.lines;
}

function scalar(lines: string[], indent: number, key: string): string {
	const { value, lines: children } = entry(lines, indent, key);
	if (children.some((line) => line.trim())) throw new Error(`Unsupported lock scalar: ${key}`);
	return value.replace(/^(['"])(.*)\1$/, "$2");
}

/** Strip only well-formed pnpm peer annotations from an exact npm version. */
function exactVersion(reference: string): string {
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?/.exec(
			reference,
		);
	if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part)))
		throw new Error(`Malformed resolved version: ${reference}`);
	const suffix = reference.slice(match[0].length);
	let depth = 0;
	for (const char of suffix) {
		if (char === "(") depth++;
		else if (char === ")" && depth > 0) depth--;
		else if (depth === 0 || !/[\da-zA-Z@/_.+-]/.test(char))
			throw new Error(`Malformed resolved version: ${reference}`);
	}
	if (depth !== 0 || suffix.includes("()")) throw new Error(`Malformed resolved version: ${reference}`);
	return match[0];
}

/**
 * The public npm manifest shared by all platforms. Pin only the demonstrated
 * SDK/codemode contract; this is not a full transitive npm lock conversion.
 */
export function runtimeManifest(lockfile: string, dependencies: Readonly<Record<string, string>>) {
	const locked = lockedDependenciesFromLock(lockfile);
	if (
		Object.keys(locked).length !== Object.keys(dependencies).length ||
		Object.entries(locked).some(([name, version]) => dependencies[name] !== version)
	)
		throw new Error("Runtime dependencies disagree with the locked daemon importer.");
	const lines = lockfile.split("\n");
	const importers = block(lines, 0, "importers");
	const daemon = block(importers, 2, IMPORTER);
	const direct = block(daemon, 4, "dependencies");
	const sdkReference = scalar(block(direct, 6, SDK), 8, "version");
	const sdkVersion = exactVersion(sdkReference);
	if (sdkVersion !== dependencies[SDK]) throw new Error("SDK snapshot disagrees with the direct pin.");
	const snapshots = block(lines, 0, "snapshots");
	const sdk = block(snapshots, 2, `${SDK}@${sdkReference}`);
	const codemodeReference = scalar(block(sdk, 4, "dependencies"), 6, CODEMODE);
	const codemodeVersion = exactVersion(codemodeReference);
	block(snapshots, 2, `${CODEMODE}@${codemodeReference}`);
	// pnpm source records omit peer context; require the selected versions only.
	const packages = block(lines, 0, "packages");
	block(packages, 2, `${SDK}@${sdkVersion}`);
	block(packages, 2, `${CODEMODE}@${codemodeVersion}`);
	return {
		name: "gentle-dot-runtime",
		private: true,
		type: "module",
		dependencies: { ...dependencies },
		overrides: { [CODEMODE]: codemodeVersion },
	};
}
