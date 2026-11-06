import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from "node:crypto";
import { open } from "node:fs/promises";

const PAYLOAD_LIMIT = 16384;
const ENVELOPE_LIMIT = 24576;
const SIZE_LIMIT = 2147483647;
const BASE = "https://github.com/Gentleman-Programming/gentle-dot/releases/download/";
const FORMATS = {
	"darwin-arm64": ["dmg"],
	"linux-amd64": ["deb", "pkg.tar.zst"],
	"linux-arm64": ["deb", "pkg.tar.zst"],
};
const fail = (message) => {
	throw new Error(message);
};
const exact = (value, fields) =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.keys(value).sort().join(",") === fields.split(",").sort().join(",");
function json(bytes) {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		fail("Invalid JSON");
	}
}
function version(value) {
	if (
		typeof value !== "string" ||
		value.length > 32 ||
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
	)
		fail("Invalid version");
	const parts = value.split(".").map(Number);
	if (!parts.every(Number.isSafeInteger)) fail("Invalid version");
	return parts;
}
function selection(platform, format) {
	if (!Object.hasOwn(FORMATS, platform) || !FORMATS[platform].includes(format))
		fail("Unsupported platform or format");
}
function integrity(artifact) {
	if (
		!Number.isInteger(artifact.size) ||
		artifact.size < 1 ||
		artifact.size > SIZE_LIMIT ||
		typeof artifact.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(artifact.sha256)
	)
		fail("Invalid artifact integrity metadata");
}
function validateManifest(m) {
	if (!exact(m, "schemaVersion,version,artifacts") || m.schemaVersion !== 1) fail("Invalid manifest");
	version(m.version);
	if (!Array.isArray(m.artifacts) || m.artifacts.length < 1 || m.artifacts.length > 5)
		fail("Invalid artifacts");
	const seen = new Set();
	for (const a of m.artifacts) {
		if (!exact(a, "platform,format,url,sha256,size")) fail("Invalid artifact");
		selection(a.platform, a.format);
		integrity(a);
		const id = `${a.platform}/${a.format}`;
		if (seen.has(id)) fail("Duplicate artifact");
		seen.add(id);
		const arch = a.platform.split("-")[1];
		let filename;
		if (a.format === "dmg") filename = `Gentle%20Dot_${m.version}_aarch64.dmg`;
		else if (a.format === "deb") filename = `gentle-dot_${m.version}_${arch}.deb`;
		else {
			// Arch pkgrel is part of the existing package filename, not the app version.
			const suffix = arch === "amd64" ? "x86_64" : "aarch64";
			const prefix = `${BASE}v${m.version}/gentle-dot-${m.version}-`;
			if (typeof a.url !== "string" || !a.url.startsWith(prefix)) fail("Invalid artifact URL");
			const rest = a.url.slice(prefix.length);
			if (!new RegExp(`^[1-9][0-9]{0,5}-${suffix}\\.pkg\\.tar\\.zst$`).test(rest))
				fail("Invalid artifact URL");
			filename = `gentle-dot-${m.version}-${rest}`;
		}
		// Exact strings forbid credentials, alternate hosts, queries, escapes and traversal.
		if (a.url !== `${BASE}v${m.version}/${filename}`) fail("Invalid artifact URL");
	}
	return m;
}
function key(input, privateKey = false) {
	let result;
	try {
		result =
			input instanceof KeyObject ? input : privateKey ? createPrivateKey(input) : createPublicKey(input);
	} catch {
		fail("Invalid key");
	}
	if (result.asymmetricKeyType !== "ed25519") fail("Expected Ed25519 key");
	if (result.type !== (privateKey ? "private" : "public")) fail("Invalid key");
	return result;
}
function base64(value, max) {
	if (typeof value !== "string" || value.length > max) fail("Invalid envelope");
	const bytes = Buffer.from(value, "base64");
	if (!bytes.length || bytes.toString("base64") !== value) fail("Invalid envelope");
	return bytes;
}

/** Sign exact UTF-8 bytes (Buffer/Uint8Array/string), or compact JSON for an object. */
export function signManifest(manifest, privateKey) {
	const payload =
		typeof manifest === "string" || manifest instanceof Uint8Array
			? Buffer.from(manifest)
			: Buffer.from(JSON.stringify(manifest));
	if (payload.length > PAYLOAD_LIMIT) fail("Manifest too large");
	validateManifest(json(payload));
	return {
		schemaVersion: 1,
		payload: payload.toString("base64"),
		signature: sign(null, payload, key(privateKey, true)).toString("base64"),
	};
}

/** Verify before interpreting metadata. No network or key discovery is performed. */
export function verifyRelease(
	envelope,
	publicKey,
	{ platform, currentVersion, format = platform === "darwin-arm64" ? "dmg" : "deb" },
) {
	if (!exact(envelope, "schemaVersion,payload,signature") || envelope.schemaVersion !== 1)
		fail("Invalid envelope");
	const payload = base64(envelope.payload, Math.ceil(PAYLOAD_LIMIT / 3) * 4);
	const signature = base64(envelope.signature, 88);
	if (payload.length > PAYLOAD_LIMIT || signature.length !== 64) fail("Invalid envelope");
	if (!verify(null, payload, key(publicKey), signature)) fail("Invalid release signature");
	const m = validateManifest(json(payload));
	selection(platform, format);
	const current = version(currentVersion);
	const next = version(m.version);
	const differing = next.findIndex((part, i) => part !== current[i]);
	if (differing < 0 || next[differing] < current[differing])
		fail("Release must be newer than current version");
	const artifact = m.artifacts.find((a) => a.platform === platform && a.format === format);
	if (!artifact) fail("No artifact for platform and format");
	return { schemaVersion: 1, version: m.version, artifact };
}

/** Pass only the artifact returned by verifyRelease. Throws on mismatch. */
export function verifyArtifact(bytes, artifact) {
	integrity(artifact);
	if (!(bytes instanceof Uint8Array) || bytes.byteLength !== artifact.size) fail("Artifact size mismatch");
	if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) fail("Artifact SHA-256 mismatch");
	return true;
}

const HELP = `Free Ed25519 release metadata (Node >=24; no downloads or installation).
Usage:
  node scripts/updates/release.mjs sign --manifest FILE --private-key FILE
  node scripts/updates/release.mjs verify --envelope FILE --public-key FILE --platform PLATFORM --current-version X.Y.Z [--format FORMAT] [--artifact FILE]
  node scripts/updates/release.mjs --help
Platforms: darwin-arm64 (dmg), linux-amd64/linux-arm64 (deb or pkg.tar.zst).
Format defaults to dmg on macOS, deb on Linux. Keys: external PEM Ed25519.
Sign emits an envelope; verify emits verified JSON only on success. Optional
--artifact also checks local bytes. Errors: exit 1, stderr only. No file writes.
Public key must be independently pinned, never downloaded with the release.
Project signatures do not replace OS signing/notarization or remove OS warnings.
`;
async function input(path, limit) {
	let handle;
	try {
		handle = await open(path, "r");
		if (!(await handle.stat()).isFile()) fail("Cannot read input file");
		const bytes = Buffer.alloc(limit + 1);
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > limit) fail("Input file too large");
		return bytes.subarray(0, length);
	} catch (error) {
		if (error.message === "Input file too large") throw error;
		fail("Cannot read input file");
	} finally {
		await handle?.close();
	}
}
async function artifactFile(path, artifact) {
	let handle;
	try {
		handle = await open(path, "r");
	} catch {
		fail("Cannot read input file");
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size !== artifact.size) fail("Artifact size mismatch");
		const hash = createHash("sha256");
		let length = 0;
		for await (const chunk of handle.createReadStream({ autoClose: false })) {
			length += chunk.length;
			if (length > artifact.size) fail("Artifact size mismatch");
			hash.update(chunk);
		}
		if (length !== artifact.size) fail("Artifact size mismatch");
		if (hash.digest("hex") !== artifact.sha256) fail("Artifact SHA-256 mismatch");
	} finally {
		await handle.close();
	}
}
async function main(args) {
	if (args.length === 1 && args[0] === "--help") {
		process.stdout.write(HELP);
		return;
	}
	const [mode, ...rest] = args;
	const required =
		mode === "sign" ? ["manifest", "private-key"] : ["envelope", "public-key", "platform", "current-version"];
	const allowed = mode === "sign" ? required : [...required, "format", "artifact"];
	const options = Object.create(null);
	if (!["sign", "verify"].includes(mode) || rest.length % 2) fail("Invalid command or options");
	for (let i = 0; i < rest.length; i += 2) {
		const name = rest[i].slice(2);
		const value = rest[i + 1];
		if (
			!rest[i].startsWith("--") ||
			!allowed.includes(name) ||
			Object.hasOwn(options, name) ||
			!value ||
			value.startsWith("--")
		)
			fail("Invalid command or options");
		options[name] = value;
	}
	if (!required.every((name) => Object.hasOwn(options, name))) fail("Invalid command or options");
	let result;
	if (mode === "sign")
		result = signManifest(
			await input(options.manifest, PAYLOAD_LIMIT),
			await input(options["private-key"], PAYLOAD_LIMIT),
		);
	else {
		result = verifyRelease(
			json(await input(options.envelope, ENVELOPE_LIMIT)),
			await input(options["public-key"], PAYLOAD_LIMIT),
			{
				platform: options.platform,
				currentVersion: options["current-version"],
				format: options.format,
			},
		);
		if (options.artifact) await artifactFile(options.artifact, result.artifact);
	}
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (import.meta.main) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`Error: ${error.message}\n`);
		process.exitCode = 1;
	});
}
