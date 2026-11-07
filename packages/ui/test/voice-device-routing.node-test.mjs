import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseVoiceSource, createVoiceDeviceRuntime } from "../src/voice-device-runtime.ts";
import { createVoiceDevices } from "../src/voice-devices.ts";

function harness({ initial = null, supported = true, denied = false } = {}) {
	const calls = [];
	let raw = initial;
	const devices = createVoiceDevices({
		storage: {
			getItem: () => raw,
			setItem: (_k, v) => {
				raw = v;
			},
			removeItem: () => {
				raw = null;
			},
		},
		secureContext: true,
		sinkSupported: true,
		media: {
			enumerateDevices: async () => {
				calls.push("enumerate");
				return [{ kind: "audioinput", deviceId: "browser", label: "Mic" }];
			},
			getUserMedia: async () => {
				calls.push("permission");
				return { getTracks: () => [{ stop: () => calls.push("track-stop") }] };
			},
		},
	});
	const stream = { getTracks: () => [] };
	const runtime = createVoiceDeviceRuntime({
		devices,
		nativeDevices: async () => {
			calls.push("native-catalog");
			return { supported, devices: [{ id: "native", label: "Mic", isDefault: true }] };
		},
		startNative: async (...args) => {
			calls.push(["native-start", ...args]);
		},
		getUserMedia: async (constraints) => {
			calls.push(["media", constraints]);
			if (denied) throw new Error("external media detail");
			return stream;
		},
	});
	return { runtime, devices, calls, stream };
}

for (const [kind, message] of [
	["preferences", "Could not read voice device preferences. Clear saved choices in Settings."],
	["diagnosticToken", "Invalid voice diagnostic token."],
	["cancelled", "Recording was cancelled."],
	["nativeUnsupported", "Selected native input is unsupported on this platform."],
	["nativeMissing", "Selected input is missing or unavailable."],
	["browserMissing", "Selected browser input is missing or unavailable."],
	["microphoneDenied", "Microphone access was denied. Allow it to talk to the assistant."],
])
	test(`owned ${kind} refusal preserves raw errors, saved preferences and exact admission calls`, async () => {
		const h = harness({
			initial: kind === "preferences" ? "{bad" : null,
			supported: kind !== "nativeUnsupported",
			denied: kind === "microphoneDenied",
		});
		if (kind === "nativeUnsupported" || kind === "nativeMissing")
			h.devices.set("nativeInput", kind === "nativeMissing" ? "gone" : "native");
		if (kind === "browserMissing") h.devices.set("browserInput", "gone");
		const before = JSON.stringify(h.devices.read());
		const attempt =
			kind === "browserMissing" || kind === "microphoneDenied"
				? () => h.runtime.openBrowserInput()
				: () =>
						h.runtime.startNativeInput(
							"en",
							() => kind !== "cancelled",
							kind === "diagnosticToken" ? "invalid token!" : undefined,
						);
		await assert.rejects(attempt, (error) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message, message);
			assert.equal(String(error), `Error: ${message}`);
			assert.equal(error.display, kind);
			return true;
		});
		assert.equal(JSON.stringify(h.devices.read()), before);
		assert.equal(h.runtime.captureBusy(), false);
		assert.deepEqual(
			h.calls,
			kind === "nativeUnsupported" || kind === "nativeMissing"
				? ["native-catalog"]
				: kind === "browserMissing"
					? ["enumerate"]
					: kind === "microphoneDenied"
						? [["media", { audio: true }]]
						: [],
		);
	});

test("input priority remains daemon then native, with no global DOM dependency", () => {
	assert.deepEqual(chooseVoiceSource(true, true, { available: true }, true, true), { kind: "daemon" });
	assert.deepEqual(chooseVoiceSource(true, true, { available: true }, true, false), { kind: "native" });
	assert.deepEqual(chooseVoiceSource(false, true, undefined, false, true), {
		kind: "none",
		reason: "Voice needs a secure page (HTTPS or localhost).",
		reasonDisplay: "insecure",
	});
	assert.deepEqual(chooseVoiceSource(true, false, undefined, true, true), { kind: "none" });
});

test("display ownership updates silently without changing raw route notification or capture behavior", () => {
	const h = harness();
	let count = 0;
	h.runtime.subscribe(() => count++);
	const owned = chooseVoiceSource(false, true, undefined, false, true);
	h.runtime.setRoute(owned);
	assert.equal(count, 1);
	assert.equal(h.runtime.route().reasonDisplay, "insecure");
	const raw = { kind: "none", reason: owned.reason };
	h.runtime.setRoute(raw);
	assert.equal(count, 1);
	assert.equal(h.runtime.route().reasonDisplay, undefined);
	assert.equal(h.runtime.route().reason, owned.reason);
	h.runtime.setRoute({ ...raw });
	assert.equal(h.runtime.route(), raw);
	assert.equal(h.runtime.captureBusy(), false);
	assert.deepEqual(h.calls, []);
});

test("construction/read/subscriptions and metadata do not activate hardware", async () => {
	const h = harness();
	const seen = [];
	const off = h.runtime.subscribe(() => seen.push(h.runtime.route()));
	assert.deepEqual(h.calls, []);
	assert.equal(h.runtime.route().kind, "none");
	h.runtime.setRoute({ kind: "native" });
	assert.deepEqual(seen, [{ kind: "native" }]);
	off();
	await h.runtime.catalog();
	assert.deepEqual(h.calls, ["enumerate", "native-catalog"]);
	assert.equal(h.devices.read().preferences.nativeInput, null);
});

test("native/browser starts snapshot only their own namespace; default stays omitted", async () => {
	const h = harness();
	h.devices.set("nativeInput", "native");
	h.devices.set("browserInput", "browser");
	await h.runtime.startNativeInput("en-US");
	assert.deepEqual(h.calls, ["native-catalog", ["native-start", "en-US", "native"]]);
	h.calls.length = 0;
	assert.equal(await h.runtime.openBrowserInput(), h.stream);
	assert.deepEqual(h.calls, ["enumerate", ["media", { audio: { deviceId: { exact: "browser" } } }]]);
	h.calls.length = 0;
	h.devices.set("browserInput", null);
	h.devices.set("nativeInput", null);
	await h.runtime.openBrowserInput();
	await h.runtime.startNativeInput("es");
	assert.deepEqual(h.calls, [
		["media", { audio: true }],
		["native-start", "es", undefined],
	]);
});

test("missing choices reject before capture, never silently default", async () => {
	const h = harness();
	h.devices.set("nativeInput", "gone");
	h.devices.set("browserInput", "gone");
	await assert.rejects(h.runtime.startNativeInput("en"), /missing|unavailable/i);
	await assert.rejects(h.runtime.openBrowserInput(), /missing|unavailable/i);
	assert.deepEqual(h.calls, ["native-catalog", "enumerate"]);
	assert.equal(h.devices.read().preferences.nativeInput, "gone");
});

test("cancel during metadata prevents later capture or permission actions", async () => {
	const h = harness();
	h.devices.set("browserInput", "browser");
	h.devices.set("nativeInput", "native");
	let live = true;
	const browser = h.runtime.openBrowserInput(() => live);
	live = false;
	await assert.rejects(browser, /cancelled/i);
	live = true;
	const native = h.runtime.startNativeInput("en", () => live);
	live = false;
	await assert.rejects(native, /cancelled/i);
	assert.deepEqual(h.calls, ["enumerate", "native-catalog"]);
});

test("unsupported native choice and unreadable preferences are capture-inert", async () => {
	let starts = 0,
		media = 0;
	const devices = createVoiceDevices({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
	const runtime = createVoiceDeviceRuntime({
		devices,
		nativeDevices: async () => ({ supported: false, devices: [] }),
		startNative: async () => {
			starts++;
		},
		getUserMedia: async () => {
			media++;
		},
	});
	const original = devices.read;
	devices.read = () => ({
		status: "storage-error",
		preferences: { version: 1, nativeInput: null, browserInput: null, browserOutput: null },
	});
	await assert.rejects(runtime.startNativeInput("en"), /preferences/i);
	await assert.rejects(runtime.openBrowserInput(), /preferences/i);
	devices.read = () => ({ ...original(), preferences: { ...original().preferences, nativeInput: "native" } });
	await assert.rejects(runtime.startNativeInput("en"), /unsupported/i);
	assert.equal(starts + media, 0);
});

test("default browser permission failure retains the established user-facing reason", async () => {
	const h = harness();
	const runtime = createVoiceDeviceRuntime({
		devices: h.devices,
		nativeDevices: async () => ({ supported: false, devices: [] }),
		startNative: async () => {},
		getUserMedia: async () => {
			throw Error("NotAllowedError");
		},
	});
	await assert.rejects(runtime.openBrowserInput(), {
		message: "Microphone access was denied. Allow it to talk to the assistant.",
	});
	assert.deepEqual(h.calls, []);
});

test("capture admission is shared across hook lifetimes and old cleanup cannot release a newer owner", () => {
	const h = harness();
	assert.equal(h.runtime.captureBusy(), false);
	const first = h.runtime.claimCapture();
	assert.equal(typeof first, "function");
	assert.equal(h.runtime.captureBusy(), true);
	assert.equal(h.runtime.claimCapture(), undefined, "another recording must not commandeer capture");
	first();
	assert.equal(h.runtime.captureBusy(), false);
	const next = h.runtime.claimCapture();
	first();
	assert.equal(h.runtime.captureBusy(), true, "old cleanup must not release a newer recording");
	next();
	assert.equal(h.runtime.captureBusy(), false);
	assert.deepEqual(h.calls, []);
});

test("diagnostic token is additive and invalid admission is storage/observer/capture inert", async () => {
	const calls = [];
	let notifications = 0;
	const devices = createVoiceDevices({
		storage: {
			getItem() {
				calls.push("read");
				return null;
			},
			setItem() {
				calls.push("write");
			},
			removeItem() {
				calls.push("remove");
			},
		},
	});
	const runtime = createVoiceDeviceRuntime({
		devices,
		nativeDevices: async () => {
			calls.push("catalog");
			return { supported: true, devices: [] };
		},
		startNative: async (...args) => {
			calls.push(args);
		},
		getUserMedia: async () => {
			calls.push("media");
		},
	});
	runtime.subscribe(() => notifications++);
	runtime.checks.subscribe(() => notifications++);
	const before = structuredClone(runtime.checks.read());
	for (const token of ["", null, 3, "bad token", "x".repeat(129)]) {
		await assert.rejects(
			runtime.startNativeInput("en", () => true, token),
			/Invalid voice diagnostic token/,
		);
		assert.deepEqual(calls, []);
		assert.equal(notifications, 0);
		assert.deepEqual(runtime.checks.read(), before);
		assert.equal(runtime.captureBusy(), false);
	}
	await runtime.startNativeInput("en", () => true, "opaque_1");
	assert.deepEqual(calls, ["read", ["en", undefined, "opaque_1"]]);
});

test("explicit permission action alone requests media and stops temporary tracks", async () => {
	const h = harness();
	await h.runtime.catalog();
	h.calls.length = 0;
	assert.deepEqual(await h.devices.requestPermission(), { status: "ok" });
	assert.deepEqual(h.calls, ["permission", "track-stop"]);
});
