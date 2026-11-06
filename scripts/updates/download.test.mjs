import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { signManifest } from "./release.mjs";
import { createReleaseDownloader } from "./download.mjs";

const keys = generateKeyPairSync("ed25519");
const bytes = Buffer.from("native package fixture");
const artifact = {
	platform: "linux-amd64", format: "deb",
	url: "https://github.com/Gentleman-Programming/gentle-dot/releases/download/v1.2.3/gentle-dot_1.2.3_amd64.deb",
	sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
};
const manifest = { schemaVersion: 1, version: "1.2.3", artifacts: [artifact] };
const envelope = signManifest(manifest, keys.privateKey);
const expected = { schemaVersion: 1, version: "1.2.3", artifact };
const options = (fetch) => ({
	publicKey: keys.publicKey, platform: "linux-amd64", currentVersion: "1.2.2",
	format: "deb", maxBytes: bytes.length, timeoutMs: 1000, fetch,
});
function transport(chunks = [bytes], responseOptions = {}) {
	const calls = [];
	let cancelled = 0;
	const fetch = async (url, init) => {
		calls.push({ url, init });
		let index = 0;
		const body = new ReadableStream({
			pull(controller) {
				if (index < chunks.length) controller.enqueue(chunks[index++]);
				else if (!responseOptions.open) controller.close();
			},
			cancel() { cancelled++; },
		}, { highWaterMark: 0 });
		return {
			status: 200, redirected: false, body,
			headers: new Headers({ "Content-Length": "1" }), ...responseOptions,
		};
	};
	return { fetch, calls, cancellations: () => cancelled };
}
const rejects = (invoke, message) => assert.rejects(invoke, { name: "Error", message });

// Public API only: no filesystem, network, persistent keys or internal probes.
test("chunked success pins configuration, public PEM and transport; repeat is independent", async () => {
	for (const publicKey of [keys.publicKey, keys.publicKey.export({ type: "spki", format: "pem" }),
		Buffer.from(keys.publicKey.export({ type: "spki", format: "pem" }))]) {
		const fake = transport([bytes.subarray(0, 4), bytes.subarray(4)]);
		const config = { ...options(fake.fetch), publicKey };
		const download = createReleaseDownloader(config);
		Object.assign(config, { publicKey: null, platform: "darwin-arm64", format: "dmg",
			currentVersion: "9.0.0", maxBytes: 1, fetch: () => assert.fail("retargeted") });
		if (Buffer.isBuffer(publicKey)) publicKey.fill(0);
		for (let i = 0; i < 2; i++) {
			const result = await download(envelope);
			assert.deepEqual(Object.keys(result), ["release", "bytes"]);
			assert.deepEqual(result.release, expected);
			assert.deepEqual(result.bytes, new Uint8Array(bytes));
			const { url, init } = fake.calls[i];
			assert.equal(url, artifact.url);
			assert.deepEqual(Object.keys(init).sort(), ["credentials", "redirect", "signal"]);
			assert.equal(init.redirect, "manual");
			assert.equal(init.credentials, "omit");
			assert.equal(init.signal.aborted, true);
			result.release.artifact.url = "https://evil.example/";
			result.bytes.fill(0);
		}
		assert.equal(fake.calls.length, 2);
		assert.equal(fake.cancellations(), 0); // Completed streams are already closed.
	}
});

test("constructor rejects missing/private/non-Ed25519 trust and invalid finite options before fetch", () => {
	const fake = transport();
	const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	for (const publicKey of [undefined, null, "invalid", keys.privateKey,
		keys.privateKey.export({ type: "pkcs8", format: "pem" }), other.publicKey]) {
		assert.throws(() => createReleaseDownloader({ ...options(fake.fetch), publicKey }),
			{ name: "Error", message: "Invalid downloader public key" });
	}
	for (const patch of [
		{ maxBytes: undefined }, { maxBytes: 0 }, { maxBytes: -1 }, { maxBytes: 1.5 },
		{ maxBytes: Infinity }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 },
		{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2147483648 },
		{ timeoutMs: 1.5 }, { fetch: null }, { platform: "windows-amd64" },
		{ format: "dmg" }, { currentVersion: "01.2.2" }, { currentVersion: "1.2" },
		{ currentVersion: "9007199254740992.0.0" }, { url: artifact.url },
	]) {
		assert.throws(() => createReleaseDownloader({ ...options(fake.fetch), ...patch }),
			{ name: "Error", message: "Invalid downloader options" });
	}
	assert.equal(fake.calls.length, 0);
});

test("rejected signature, signed URL, rollback, target and host budget never fetch or poison later calls", async () => {
	const fake = transport();
	const config = options(fake.fetch);
	const download = createReleaseDownloader(config);
	const before = { ...config };
	const badManifest = structuredClone(manifest);
	badManifest.artifacts[0].url = "http://evil.example/package.deb";
	const payload = Buffer.from(JSON.stringify(badManifest));
	const badURL = { schemaVersion: 1, payload: payload.toString("base64"),
		signature: sign(null, payload, keys.privateKey).toString("base64") };
	for (const [value, error] of [
		[{ ...envelope, signature: Buffer.alloc(64).toString("base64") }, "Invalid release signature"],
		[signManifest(manifest, generateKeyPairSync("ed25519").privateKey), "Invalid release signature"],
		[badURL, "Invalid artifact URL"],
	]) await rejects(() => download(value), error);
	await rejects(() => createReleaseDownloader({ ...config, currentVersion: "1.2.3" })(envelope),
		"Release must be newer than current version");
	await rejects(() => createReleaseDownloader({ ...config, platform: "linux-arm64" })(envelope),
		"No artifact for platform and format");
	await rejects(() => createReleaseDownloader({ ...config, maxBytes: bytes.length - 1 })(envelope),
		"Artifact exceeds download budget");
	assert.equal(fake.calls.length, 0);
	assert.deepEqual(config, before);
	assert.deepEqual(await download(envelope), { release: expected, bytes: new Uint8Array(bytes) });
	assert.equal(fake.calls.length, 1);
});

test("all redirects, auto-follow and non-200 statuses fail closed and cancel bodies", async () => {
	for (const patch of [...[300, 301, 302, 303, 304, 307, 308, 399, 404, 206].map(status => ({ status })),
		{ redirected: true }]) {
		const fake = transport([], { ...patch, open: true,
			headers: new Headers({ Location: "https://cdn.example/package" }) });
		await rejects(() => createReleaseDownloader(options(fake.fetch))(envelope), "Download response rejected");
		assert.equal(fake.calls.length, 1);
		assert.equal(fake.calls[0].url, artifact.url);
		assert.equal(fake.calls[0].init.signal.aborted, true);
		assert.equal(fake.cancellations(), 1);
	}
});

test("truncated, oversized, tampered and invalid chunks never return bytes; failures allow reuse", async () => {
	for (const [chunks, open, message, cancelled] of [
		[[bytes.subarray(1)], false, "Artifact size mismatch", 0],
		[[bytes, new Uint8Array([1])], true, "Artifact exceeds download bounds", 1],
		[[new Uint8Array(bytes.length)], false, "Artifact SHA-256 mismatch", 0],
		[["not bytes"], true, "Invalid download body", 1],
	]) {
		const fake = transport(chunks, { open });
		const good = transport();
		let first = true;
		const download = createReleaseDownloader(options((...args) => {
			if (!first) return good.fetch(...args);
			first = false;
			return fake.fetch(...args);
		}));
		await rejects(() => download(envelope), message);
		assert.equal(fake.calls.length, 1);
		assert.equal(fake.calls[0].init.signal.aborted, true);
		assert.equal(fake.cancellations(), cancelled);
		assert.deepEqual(await download(envelope), { release: expected, bytes: new Uint8Array(bytes) });
	}
});

test("total timeout covers pending fetch, late response and pending body without sleeps", async () => {
	let signal;
	let resolveFetch;
	const late = transport([], { open: true });
	const download = createReleaseDownloader({ ...options((url, init) => {
		signal = init.signal;
		return new Promise(resolve => { resolveFetch = resolve; });
	}), timeoutMs: 5 });
	await rejects(() => download(envelope), "Download timed out");
	assert.equal(signal.aborted, true);
	resolveFetch(await late.fetch(artifact.url, {}));
	await Promise.resolve();
	assert.equal(late.cancellations(), 1);
	const fake = transport([bytes.subarray(0, 2)], { open: true });
	await rejects(() => createReleaseDownloader({ ...options(fake.fetch), timeoutMs: 5 })(envelope),
		"Download timed out");
	assert.equal(fake.calls.length, 1);
	assert.equal(fake.calls[0].init.signal.aborted, true);
	assert.equal(fake.cancellations(), 1);
});

test("standard Response works; transport and reader failures abort and preserve rejection", async () => {
	const result = await createReleaseDownloader(options(async () => new Response(bytes)))(envelope);
	assert.deepEqual(result, { release: expected, bytes: new Uint8Array(bytes) });
	for (const fetch of [async () => { throw new Error("transport failed"); }, async () => ({
		status: 200, redirected: false, body: new ReadableStream({
			pull() { throw new Error("transport failed"); },
		}),
	})]) {
		let signal;
		await rejects(() => createReleaseDownloader(options((url, init) => {
			signal = init.signal;
			return fetch();
		}))(envelope), "transport failed");
		assert.equal(signal.aborted, true);
	}
});
