import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cli = fileURLToPath(new URL("./release.mjs", import.meta.url));
const bytes = Buffer.from("native package fixture");
const hash = createHash("sha256").update(bytes).digest("hex");
const pair = () =>
	generateKeyPairSync("ed25519", {
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
const keys = pair();
const manifest = () => ({
	schemaVersion: 1,
	version: "1.2.3",
	artifacts: [
		{
			platform: "linux-amd64",
			format: "deb",
			url: "https://github.com/Gentleman-Programming/gentle-dot/releases/download/v1.2.3/gentle-dot_1.2.3_amd64.deb",
			sha256: hash,
			size: bytes.length,
		},
	],
});
function envelope(value) {
	const payload = Buffer.from(JSON.stringify(value));
	return {
		schemaVersion: 1,
		payload: payload.toString("base64"),
		signature: sign(null, payload, keys.privateKey).toString("base64"),
	};
}
function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "gentle-release-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const put = (name, value) =>
		writeFileSync(
			join(dir, name),
			typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value),
		);
	put("manifest", manifest());
	put("envelope", envelope(manifest()));
	put("private", keys.privateKey);
	put("public", keys.publicKey);
	put("artifact", bytes);
	const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8" });
	const verify = (...args) =>
		run(
			"verify",
			"--envelope",
			"envelope",
			"--public-key",
			"public",
			"--platform",
			"linux-amd64",
			"--current-version",
			"1.2.2",
			...args,
		);
	const snapshot = () =>
		Object.fromEntries(
			readdirSync(dir)
				.sort()
				.map((name) => [name, readFileSync(join(dir, name)).toString("base64")]),
		);
	const reject = (invoke, error) => {
		const before = snapshot();
		const result = invoke();
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, `Error: ${error}\n`);
		assert.deepEqual(snapshot(), before);
	};
	return { put, run, verify, reject };
}

test("CLI signs, verifies real signatures and package bytes; public API agrees", async (t) => {
	const f = fixture(t);
	const raw = `${JSON.stringify(manifest(), null, 2)}\n`;
	f.put("manifest", raw);
	const signed = f.run("sign", "--manifest", "manifest", "--private-key", "private");
	assert.equal(signed.status, 0);
	assert.equal(signed.stderr, "");
	assert.equal(Buffer.from(JSON.parse(signed.stdout).payload, "base64").toString("utf8"), raw);
	f.put("envelope", signed.stdout);
	const result = f.verify("--artifact", "artifact");
	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	const expected = { schemaVersion: 1, version: "1.2.3", artifact: manifest().artifacts[0] };
	assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
	const api = await import("./release.mjs");
	assert.deepEqual(
		api.verifyRelease(JSON.parse(signed.stdout), keys.publicKey, {
			platform: "linux-amd64",
			currentVersion: "1.2.2",
		}),
		expected,
	);
	assert.equal(api.verifyArtifact(bytes, expected.artifact), true);
	assert.throws(
		() => api.verifyArtifact(Buffer.from("changed"), expected.artifact),
		/Artifact size mismatch/,
	);
});

test("CLI help is explicit and side-effect free", (t) => {
	const f = fixture(t);
	const r = f.run("--help");
	assert.equal(r.status, 0);
	assert.equal(r.stderr, "");
	assert.match(r.stdout, /sign --manifest FILE --private-key FILE/);
	assert.match(
		r.stdout,
		/verify --envelope FILE --public-key FILE --platform PLATFORM --current-version X.Y.Z/,
	);
});

test("rejects signature, key, payload and byte tampering without modifying inputs", (t) => {
	const f = fixture(t);
	const e = envelope(manifest());
	e.signature = Buffer.alloc(64).toString("base64");
	f.put("envelope", e);
	f.reject(() => f.verify(), "Invalid release signature");
	const changed = manifest();
	changed.version = "1.2.4";
	const altered = envelope(manifest());
	altered.payload = Buffer.from(JSON.stringify(changed)).toString("base64");
	f.put("envelope", altered);
	f.reject(() => f.verify(), "Invalid release signature");
	f.put("envelope", envelope(manifest()));
	f.put("public", pair().publicKey);
	f.reject(() => f.verify(), "Invalid release signature");
	f.put(
		"public",
		generateKeyPairSync("rsa", {
			modulusLength: 2048,
			publicKeyEncoding: { type: "spki", format: "pem" },
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
		}).publicKey,
	);
	f.reject(() => f.verify(), "Expected Ed25519 key");
	f.put("public", "invalid key");
	f.reject(() => f.verify(), "Invalid key");
	f.put("public", keys.publicKey);
	f.put("artifact", Buffer.alloc(bytes.length));
	f.reject(() => f.verify("--artifact", "artifact"), "Artifact SHA-256 mismatch");
	f.put("artifact", "short");
	f.reject(() => f.verify("--artifact", "artifact"), "Artifact size mismatch");
});

test("rejects rollback, unsupported selection, invalid CLI and missing files", (t) => {
	const f = fixture(t);
	for (const version of ["1.2.3", "2.0.0"]) {
		f.reject(
			() =>
				f.run(
					"verify",
					"--envelope",
					"envelope",
					"--public-key",
					"public",
					"--platform",
					"linux-amd64",
					"--current-version",
					version,
				),
			"Release must be newer than current version",
		);
	}
	for (const platform of ["windows-amd64", "darwin-arm64"]) {
		f.reject(
			() =>
				f.run(
					"verify",
					"--envelope",
					"envelope",
					"--public-key",
					"public",
					"--platform",
					platform,
					"--current-version",
					"1.0.0",
				),
			platform.startsWith("windows")
				? "Unsupported platform or format"
				: "No artifact for platform and format",
		);
	}
	f.reject(() => f.verify("--unknown", "x"), "Invalid command or options");
	f.reject(() => f.verify("--platform", "linux-arm64"), "Invalid command or options");
	f.reject(() => f.run("sign"), "Invalid command or options");
	f.reject(() => f.verify("--format", "exe"), "Unsupported platform or format");
	f.reject(
		() =>
			f.run(
				"verify",
				"--envelope",
				"envelope",
				"--public-key",
				"public",
				"--platform",
				"linux-amd64",
				"--current-version",
				"1.0",
			),
		"Invalid version",
	);
	f.reject(
		() =>
			f.run(
				"verify",
				"--envelope",
				"missing",
				"--public-key",
				"public",
				"--platform",
				"linux-amd64",
				"--current-version",
				"1.0.0",
			),
		"Cannot read input file",
	);
});

test("signing and verification both reject invalid metadata", (t) => {
	const f = fixture(t);
	const cases = [
		[
			(m) => {
				m.extra = true;
			},
			"Invalid manifest",
		],
		[
			(m) => {
				m.schemaVersion = 2;
			},
			"Invalid manifest",
		],
		[
			(m) => {
				m.artifacts[0].extra = true;
			},
			"Invalid artifact",
		],
		[
			(m) => {
				m.version = "01.2.3";
			},
			"Invalid version",
		],
		[
			(m) => {
				m.version = "1.2.3-beta";
			},
			"Invalid version",
		],
		[
			(m) => {
				m.version = "9007199254740992.0.0";
			},
			"Invalid version",
		],
		[
			(m) => {
				m.artifacts = [];
			},
			"Invalid artifacts",
		],
		[
			(m) => {
				m.artifacts.push(m.artifacts[0]);
			},
			"Duplicate artifact",
		],
		[
			(m) => {
				m.artifacts[0].platform = "windows-amd64";
			},
			"Unsupported platform or format",
		],
		[
			(m) => {
				m.artifacts[0].format = "dmg";
			},
			"Unsupported platform or format",
		],
		[
			(m) => {
				m.artifacts[0].sha256 = hash.toUpperCase();
			},
			"Invalid artifact integrity metadata",
		],
		...[0, -1, 1.5, 2147483648, "22"].map((size) => [
			(m) => {
				m.artifacts[0].size = size;
			},
			"Invalid artifact integrity metadata",
		]),
		...[
			"http://github.com/x",
			"https://evil.example/x",
			"https://github.com@evil.example/x",
			"https://github.com/Gentleman-Programming/other/releases/download/v1.2.3/gentle-dot_1.2.3_amd64.deb",
			"https://github.com/Gentleman-Programming/gentle-dot/releases/download/v1.2.2/gentle-dot_1.2.3_amd64.deb",
			"https://github.com/Gentleman-Programming/gentle-dot/releases/download/v1.2.3/gentle-dot_1.2.3_arm64.deb",
			`${manifest().artifacts[0].url}?download=1`,
			`${manifest().artifacts[0].url}#x`,
			`${manifest().artifacts[0].url}/../evil.deb`,
		].map((url) => [
			(m) => {
				m.artifacts[0].url = url;
			},
			"Invalid artifact URL",
		]),
	];
	for (const [mutate, error] of cases) {
		const m = manifest();
		mutate(m);
		f.put("manifest", m);
		f.put("envelope", envelope(m));
		f.reject(() => f.run("sign", "--manifest", "manifest", "--private-key", "private"), error);
		f.reject(() => f.verify(), error);
	}
});

test("strict envelope, JSON, base64 and metadata size limits", (t) => {
	const f = fixture(t);
	for (const value of [
		{ ...envelope(manifest()), extra: 1 },
		{ ...envelope(manifest()), schemaVersion: 2 },
		{ ...envelope(manifest()), payload: "!!!" },
		{ ...envelope(manifest()), signature: "AA==" },
	]) {
		f.put("envelope", value);
		f.reject(() => f.verify(), "Invalid envelope");
	}
	for (const raw of [Buffer.from("{bad JSON"), Buffer.from([0xff])]) {
		f.put("manifest", raw);
		f.reject(() => f.run("sign", "--manifest", "manifest", "--private-key", "private"), "Invalid JSON");
		f.put("envelope", {
			schemaVersion: 1,
			payload: raw.toString("base64"),
			signature: sign(null, raw, keys.privateKey).toString("base64"),
		});
		f.reject(() => f.verify(), "Invalid JSON");
	}
	f.put("envelope", "{");
	f.reject(() => f.verify(), "Invalid JSON");
	f.put("envelope", "x".repeat(24577));
	f.reject(() => f.verify(), "Input file too large");
	f.put("manifest", "x".repeat(16385));
	f.reject(() => f.run("sign", "--manifest", "manifest", "--private-key", "private"), "Input file too large");
});

test("all native formats and numeric version comparison", async () => {
	const api = await import("./release.mjs");
	for (const [platform, format, filename] of [
		["darwin-arm64", "dmg", "Gentle Dot_1.2.3_aarch64.dmg"],
		["linux-arm64", "deb", "gentle-dot_1.2.3_arm64.deb"],
		["linux-amd64", "pkg.tar.zst", "gentle-dot-1.2.3-1-x86_64.pkg.tar.zst"],
		["linux-arm64", "pkg.tar.zst", "gentle-dot-1.2.3-2-aarch64.pkg.tar.zst"],
	]) {
		const m = manifest();
		Object.assign(m.artifacts[0], {
			platform,
			format,
			url: `https://github.com/Gentleman-Programming/gentle-dot/releases/download/v1.2.3/${encodeURIComponent(filename)}`,
		});
		const e = api.signManifest(m, keys.privateKey);
		assert.deepEqual(
			api.verifyRelease(e, keys.publicKey, { platform, format, currentVersion: "1.1.99" }).artifact,
			m.artifacts[0],
		);
	}
	const m = manifest();
	m.version = "1.10.0";
	m.artifacts[0].url = m.artifacts[0].url.replaceAll("1.2.3", "1.10.0");
	assert.equal(
		api.verifyRelease(api.signManifest(m, keys.privateKey), keys.publicKey, {
			platform: "linux-amd64",
			currentVersion: "1.9.99",
		}).version,
		"1.10.0",
	);
});
