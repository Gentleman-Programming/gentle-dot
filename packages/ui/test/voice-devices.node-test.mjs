import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceDevices, VOICE_DEVICE_KEY } from "../src/voice-devices.ts";

const defaults = { version: 1, nativeInput: null, browserInput: null, browserOutput: null };
function harness(options = {}) {
	const entries = new Map([["unrelated", "keep"]]);
	const calls = { read: 0, write: 0, remove: 0, enumerate: 0, permission: 0, stops: [] };
	const storage = {
		getItem(key) {
			calls.read++;
			return entries.get(key) ?? null;
		},
		setItem(key, value) {
			calls.write++;
			entries.set(key, value);
		},
		removeItem(key) {
			calls.remove++;
			entries.delete(key);
		},
	};
	const media = {
		async enumerateDevices() {
			calls.enumerate++;
			return [
				{ kind: "audioinput", deviceId: "mic", label: "Microphone" },
				{ kind: "audiooutput", deviceId: "speaker", label: "" },
				{ kind: "videoinput", deviceId: "camera", label: "Camera" },
			];
		},
		async getUserMedia(constraints) {
			calls.permission++;
			assert.deepEqual(constraints, { audio: true });
			return {
				getTracks: () =>
					[0, 1].map((i) => ({
						stop() {
							calls.stops.push(i);
						},
					})),
			};
		},
	};
	const service = createVoiceDevices({
		storage,
		media,
		secureContext: true,
		sinkSupported: true,
		...options,
	});
	return { service, entries, calls, storage, media };
}

test("construction and default read/selection are inert and preserve legacy routing", async () => {
	const h = harness();
	assert.deepEqual(h.calls, { read: 0, write: 0, remove: 0, enumerate: 0, permission: 0, stops: [] });
	assert.deepEqual(h.service.read(), { status: "ok", preferences: defaults });
	assert.deepEqual(h.service.currentSelection("browserOutput", []), { status: "default", deviceId: null });
	assert.equal(h.calls.enumerate + h.calls.permission + h.calls.write + h.calls.remove, 0);
	assert.deepEqual([...h.entries], [["unrelated", "keep"]]);
});

test("validated versioned choices persist independently in backend namespaces", () => {
	const h = harness();
	for (const [slot, id] of [
		["nativeInput", "native"],
		["browserInput", "mic"],
		["browserOutput", "speaker"],
	]) {
		assert.equal(h.service.set(slot, id).status, "ok");
	}
	const preferences = { version: 1, nativeInput: "native", browserInput: "mic", browserOutput: "speaker" };
	assert.deepEqual(h.service.read().preferences, preferences);
	assert.deepEqual(JSON.parse(h.entries.get(VOICE_DEVICE_KEY)), preferences);
	assert.equal(h.entries.get("unrelated"), "keep");
	assert.equal(h.calls.permission + h.calls.enumerate, 0);
	const other = createVoiceDevices({ storage: h.storage });
	assert.deepEqual(other.read().preferences, preferences);
});

for (const [rule, slot, id] of [
	["unknown namespace", "input", "x"],
	["wrong type", "browserInput", 4],
	["NUL", "nativeInput", "a\0b"],
	["oversized ID", "browserOutput", "x".repeat(1025)],
	["empty ID", "browserInput", ""],
])
	test(`reject ${rule} without changing preferences or dependencies`, () => {
		const h = harness();
		h.service.set("browserInput", "mic");
		const before = [...h.entries],
			counts = { ...h.calls };
		assert.equal(h.service.set(slot, id).status, "invalid");
		assert.deepEqual([...h.entries], before);
		assert.deepEqual(h.calls, counts);
	});

test("ID limit accepts exactly 1024 and null restores default", () => {
	const h = harness();
	assert.equal(h.service.set("nativeInput", "x".repeat(1024)).status, "ok");
	assert.equal(h.service.set("nativeInput", null).status, "ok");
	assert.deepEqual(h.service.currentSelection("nativeInput", []), { status: "default", deviceId: null });
});

for (const [rule, raw] of [
	["unknown schema", JSON.stringify({ ...defaults, version: 2 })],
	["unknown fields", JSON.stringify({ ...defaults, extra: true })],
	["missing fields", '{"version":1}'],
	["invalid JSON", "{"],
	["invalid stored type", JSON.stringify({ ...defaults, nativeInput: false })],
	["invalid stored ID", JSON.stringify({ ...defaults, browserInput: "a\0b" })],
	["oversized stored value", "x".repeat(7000)],
])
	test(`read rejects ${rule} without erasing stored data`, () => {
		const h = harness();
		h.entries.set(VOICE_DEVICE_KEY, raw);
		const before = [...h.entries];
		assert.deepEqual(h.service.read(), { status: "invalid", preferences: defaults });
		assert.equal(h.service.set("browserInput", "mic").status, "invalid");
		assert.deepEqual([...h.entries], before);
		assert.equal(h.calls.write + h.calls.remove + h.calls.permission + h.calls.enumerate, 0);
	});

test("reset only removes owned key and subscription reports successful changes with unsubscribe", () => {
	const h = harness(),
		events = [];
	const off = h.service.subscribe((value) => events.push(value));
	h.service.set("browserInput", "mic");
	h.service.set("browserInput", "mic");
	assert.deepEqual(events, [{ ...defaults, browserInput: "mic" }]);
	events[0].browserInput = "tampered";
	assert.equal(h.service.read().preferences.browserInput, "mic");
	assert.equal(h.service.reset().status, "ok");
	assert.deepEqual(events.at(-1), defaults);
	assert.deepEqual([...h.entries], [["unrelated", "keep"]]);
	off();
	h.service.set("nativeInput", "endpoint");
	assert.equal(events.length, 2);
});

for (const method of ["getItem", "setItem", "removeItem"])
	test(`storage ${method} failure is bounded and leaves choices/keys unchanged`, () => {
		const h = harness(),
			events = [];
		h.service.set("browserInput", "mic");
		h.service.subscribe((value) => events.push(value));
		h.storage[method] = () => {
			throw new Error("private ID/name");
		};
		const before = [...h.entries];
		const result =
			method === "getItem"
				? h.service.read()
				: method === "setItem"
					? h.service.set("browserInput", "new")
					: h.service.reset();
		assert.equal(result.status, "storage-error");
		assert.ok(!JSON.stringify(result).includes("private"));
		assert.deepEqual([...h.entries], before);
		assert.deepEqual(events, []);
	});

test("metadata enumeration filters to bounded audio metadata without requesting access", async () => {
	const h = harness();
	const before = [...h.entries];
	assert.deepEqual(await h.service.enumerate(), {
		status: "ok",
		devices: [
			{ kind: "audioinput", deviceId: "mic", label: "Microphone" },
			{ kind: "audiooutput", deviceId: "speaker", label: "" },
		],
	});
	assert.equal(h.calls.enumerate, 1);
	assert.equal(h.calls.permission, 0);
	assert.deepEqual(h.calls.stops, []);
	assert.deepEqual([...h.entries], before);
});

test("missing remembered selection stays missing while matching kind/backend resolves available", () => {
	const h = harness();
	h.service.set("browserOutput", "speaker");
	const before = [...h.entries];
	assert.deepEqual(
		h.service.currentSelection("browserOutput", [{ kind: "audioinput", deviceId: "speaker" }]),
		{ status: "missing", deviceId: "speaker" },
	);
	assert.deepEqual(
		h.service.currentSelection("browserOutput", [{ kind: "audiooutput", deviceId: "speaker" }]),
		{ status: "available", deviceId: "speaker" },
	);
	h.service.set("nativeInput", "native");
	assert.deepEqual(h.service.currentSelection("nativeInput", [{ id: "native" }]), {
		status: "available",
		deviceId: "native",
	});
	assert.deepEqual(h.service.currentSelection("browserInput", []), { status: "default", deviceId: null });
	assert.equal(
		h.entries.get(VOICE_DEVICE_KEY),
		JSON.stringify({ ...defaults, browserOutput: "speaker", nativeInput: "native" }),
	);
	assert.equal(before[0][1], h.entries.get("unrelated"));
	assert.equal(h.calls.enumerate + h.calls.permission, 0);
});

test("capability checks expose secure-context and sink limitations without probing hardware", async () => {
	for (const secureContext of [false, true])
		for (const sinkSupported of [false, true]) {
			const h = harness({ secureContext, sinkSupported });
			assert.deepEqual(h.service.capabilities(), {
				enumerate: secureContext,
				permission: secureContext,
				output: secureContext && sinkSupported,
			});
			h.service.set("browserOutput", "speaker");
			if (!secureContext || !sinkSupported)
				assert.equal(h.service.currentSelection("browserOutput", []).status, "unsupported");
			if (!secureContext) {
				assert.equal((await h.service.enumerate()).status, "unsupported");
				assert.equal((await h.service.requestPermission()).status, "unsupported");
			}
			assert.equal(h.calls.enumerate + h.calls.permission, 0);
		}
	const h = harness({ media: undefined });
	assert.deepEqual(h.service.capabilities(), { enumerate: false, permission: false, output: true });
	assert.equal((await h.service.enumerate()).status, "unsupported");
	assert.equal((await h.service.requestPermission()).status, "unsupported");
});

test("explicit permission call alone requests access and stops every temporary track", async () => {
	const h = harness();
	assert.equal(h.calls.permission, 0);
	assert.deepEqual(await h.service.requestPermission(), { status: "ok" });
	assert.equal(h.calls.permission, 1);
	assert.deepEqual(h.calls.stops, [0, 1]);
	assert.equal(h.calls.enumerate + h.calls.write + h.calls.remove, 0);
});

test("permission cleanup continues after a stop failure and exposes only bounded error", async () => {
	const h = harness();
	h.media.getUserMedia = async () => {
		h.calls.permission++;
		return {
			getTracks: () => [
				{
					stop() {
						h.calls.stops.push(0);
						throw new Error("private");
					},
				},
				{
					stop() {
						h.calls.stops.push(1);
					},
				},
			],
		};
	};
	assert.deepEqual(await h.service.requestPermission(), { status: "error" });
	assert.deepEqual(h.calls.stops, [0, 1]);
	assert.equal(h.calls.permission, 1);
});

for (const operation of ["enumerateDevices", "getUserMedia"])
	test(`${operation} rejection stays bounded and does not mutate preferences`, async () => {
		const h = harness();
		h.media[operation] = async () => {
			throw new Error("private device name");
		};
		const before = [...h.entries];
		assert.deepEqual(
			await (operation === "enumerateDevices" ? h.service.enumerate() : h.service.requestPermission()),
			operation === "enumerateDevices" ? { status: "error", devices: [] } : { status: "error" },
		);
		assert.deepEqual([...h.entries], before);
		assert.deepEqual(h.calls.stops, []);
	});
