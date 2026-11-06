import { createPublicKey, KeyObject } from "node:crypto";
import { verifyRelease, verifyArtifact } from "./release.mjs";

const fail = (message) => { throw new Error(message); };
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
function pinnedKey(input) {
	try {
		let key;
		if (input instanceof KeyObject) key = input;
		else {
			if (typeof input !== "string" && !Buffer.isBuffer(input)) throw new Error();
			// createPublicKey also accepts private PEM: forbid that implicit derivation.
			if (!input.toString().trimStart().startsWith("-----BEGIN PUBLIC KEY-----")) throw new Error();
			key = createPublicKey(input);
		}
		if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error();
		return createPublicKey({ key: key.export({ type: "spki", format: "der" }),
			type: "spki", format: "der" });
	} catch {
		fail("Invalid downloader public key");
	}
}
function cancel(body) {
	try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Best effort teardown. */ }
}

/** Host-only factory. No key discovery, filesystem operations or installation. */
export function createReleaseDownloader(options = {}) {
	if (!options || typeof options !== "object" || Array.isArray(options)) fail("Invalid downloader options");
	const { publicKey, platform, currentVersion, maxBytes,
		format = platform === "darwin-arm64" ? "dmg" : "deb",
		fetch: transport = globalThis.fetch, timeoutMs = 30000 } = options;
	const key = pinnedKey(publicKey);
	const formats = { "darwin-arm64": ["dmg"], "linux-amd64": ["deb", "pkg.tar.zst"],
		"linux-arm64": ["deb", "pkg.tar.zst"] };
	if (Object.keys(options).some(name => !["publicKey", "platform", "currentVersion", "format",
		"maxBytes", "fetch", "timeoutMs"].includes(name)) ||
		!positiveInteger(maxBytes) || !positiveInteger(timeoutMs) || timeoutMs > 2147483647 ||
		typeof transport !== "function" || typeof platform !== "string" || typeof format !== "string" ||
		!Object.hasOwn(formats, platform) ||
		!formats[platform].includes(format) || typeof currentVersion !== "string" ||
		currentVersion.length > 32 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(currentVersion) ||
		!currentVersion.split(".").map(Number).every(Number.isSafeInteger)) fail("Invalid downloader options");

	return async function download(envelope) {
		const release = verifyRelease(envelope, key, { platform, currentVersion, format });
		const { artifact } = release;
		if (artifact.size > maxBytes) fail("Artifact exceeds download budget");
		const controller = new AbortController();
		let reader;
		let timer;
		const expired = new Promise((resolve, reject) => {
			timer = setTimeout(() => {
				reject(new Error("Download timed out"));
				controller.abort();
				cancel(reader);
			}, timeoutMs);
		});
		try {
			return await Promise.race([expired, (async () => {
				const response = await transport(artifact.url, {
					redirect: "manual", credentials: "omit", signal: controller.signal,
				});
				// A host transport may resolve even after abort; close its late body too.
				if (controller.signal.aborted) {
					cancel(response?.body);
					fail("Download timed out");
				}
				if (response?.body && typeof response.body.getReader === "function") reader = response.body.getReader();
				if (response?.status !== 200 || response.redirected !== false) fail("Download response rejected");
				if (!reader) fail("Invalid download body");
				const bytes = new Uint8Array(artifact.size);
				let length = 0;
				while (true) {
					const { done, value } = await reader.read();
					if (controller.signal.aborted) fail("Download timed out");
					if (done) break;
					if (!(value instanceof Uint8Array)) fail("Invalid download body");
					if (value.byteLength > Math.min(artifact.size, maxBytes) - length)
						fail("Artifact exceeds download bounds");
					bytes.set(value, length);
					length += value.byteLength;
				}
				verifyArtifact(bytes.subarray(0, length), artifact);
				return { release, bytes };
			})()]);
		} finally {
			clearTimeout(timer);
			controller.abort();
			cancel(reader);
		}
	};
}
