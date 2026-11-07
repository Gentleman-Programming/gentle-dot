import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceDeviceRuntime } from "../src/voice-device-runtime.ts";
import { createVoiceDevices } from "../src/voice-devices.ts";
import { createVoiceChecks, validateNativeDiagnostic } from "../src/voice-diagnostics.ts";

const metadata = { route: "native", stage: "load-failed", pcmSamples: 37, sampleRate: 16000 };
function rig() {
	const calls = [];
	let observer;
	let release;
	const retired = new Promise((resolve) => {
		release = resolve;
	});
	const driver = {
		input(o) {
			calls.push("input");
			observer = o;
			return {
				stop() {
					calls.push("stop");
				},
				cancel() {
					calls.push("cancel");
					return retired;
				},
			};
		},
		output(o) {
			calls.push("output");
			observer = o;
			return {
				stop() {
					calls.push("output-stop");
				},
				async cancel() {
					calls.push("output-cancel");
				},
			};
		},
	};
	const devices = createVoiceDevices({
		storage: {
			getItem() {
				calls.push("storage-read");
				return null;
			},
			setItem() {
				calls.push("storage-write");
			},
			removeItem() {
				calls.push("storage-remove");
			},
		},
	});
	const runtime = createVoiceDeviceRuntime({
		devices,
		nativeDevices: async () => {
			calls.push("catalog");
			return { supported: false, devices: [] };
		},
		startNative: async () => {
			calls.push("native");
		},
		getUserMedia: async () => {
			calls.push("media");
		},
	});
	runtime.registerChecks(driver);
	return {
		checks: runtime.checks,
		calls,
		get observer() {
			return observer;
		},
		release,
	};
}
test("delayed old native dispatch cannot contaminate the next check through its public observer", async () => {
	const h = rig();
	let changes = 0;
	h.checks.subscribe(() => changes++);
	h.checks.start("input");
	const old = { ...metadata, diagnosticToken: h.observer.diagnosticToken };
	const cleanup = h.checks.cancel();
	h.release();
	await cleanup;
	h.checks.start("input");
	h.observer.metadata({
		route: "native",
		stage: "recording",
		pcmSamples: null,
		sampleRate: null,
		compressedBytes: null,
	});
	const before = structuredClone(h.checks.read());
	const count = changes;
	const calls = [...h.calls];
	// Actual event delivery uses the current observer, not the callback from the old check.
	h.observer.metadata(old);
	assert.deepEqual(h.checks.read(), before, "old failure/count must not reach the new check");
	assert.equal(changes, count);
	assert.deepEqual(h.calls, calls);
});

test("native validation accepts exact final PCM and strips non-diagnostic content", () => {
	assert.deepEqual(
		validateNativeDiagnostic({ ...metadata, text: "private", deviceId: "private", error: "private" }),
		{ ...metadata, compressedBytes: null },
	);
	for (const value of [
		null,
		{},
		{ ...metadata, stage: "raw-error" },
		{ ...metadata, route: "browser" },
		{ ...metadata, pcmSamples: -1 },
		{ ...metadata, pcmSamples: 1.5 },
		{ ...metadata, sampleRate: null },
		{ ...metadata, pcmSamples: Number.MAX_SAFE_INTEGER + 1 },
		{ ...metadata, sampleRate: 48000 },
	])
		assert.equal(validateNativeDiagnostic(value), null);
	assert.deepEqual(validateNativeDiagnostic({ ...metadata, pcmSamples: null, sampleRate: null }), {
		...metadata,
		pcmSamples: null,
		sampleRate: null,
		compressedBytes: null,
	});
});
test("construction and subscription are inert; input exposes only bounded latest metadata and ephemeral preview", () => {
	const h = rig();
	let changes = 0;
	const off = h.checks.subscribe(() => changes++);
	assert.deepEqual(h.calls, []);
	assert.equal(h.checks.read().kind, "idle");
	assert.equal(h.checks.start("input"), true);
	assert.deepEqual(h.calls, ["input"]);
	h.observer.level(0.7);
	h.observer.preview("transient");
	const generic = {
		route: "daemon",
		stage: "transcribing",
		pcmSamples: null,
		sampleRate: null,
		compressedBytes: 19,
	};
	h.observer.metadata(generic);
	assert.equal(h.checks.read().level, 0.7);
	assert.equal(h.checks.read().preview, "transient");
	assert.deepEqual(h.checks.read().diagnostic, generic);
	h.observer.complete();
	assert.equal(h.checks.read().kind, "done");
	assert.match(h.checks.read().note, /not.*audible|input/i);
	off();
	assert.ok(changes >= 4);
});
test("Stop uses owned lease; cancel retires callbacks and prevents a newer capture until deferred cleanup", async () => {
	const h = rig();
	h.checks.start("input");
	const old = h.observer;
	h.checks.stop();
	assert.deepEqual(h.calls, ["input", "stop"]);
	const cleanup = h.checks.cancel();
	old.preview("late");
	old.level(1);
	old.error("late");
	old.complete();
	assert.equal(h.checks.start("input"), false);
	assert.equal(h.checks.read().preview, "");
	h.release();
	await cleanup;
	assert.equal(h.checks.start("input"), true);
	old.preview("older");
	assert.equal(h.checks.read().preview, "");
});
test("busy/permission/storage/unsupported failures do not acquire or cancel another recording", () => {
	for (const reason of [
		"Voice input is already recording.",
		"Microphone access was denied.",
		"Could not read voice device preferences.",
		"Selected input is missing or unavailable.",
		"Selected native input is unsupported on this platform.",
		"Voice output is muted.",
		"Speech synthesis is busy",
		"Speech request session limit reached; restart the app",
	]) {
		let cancelled = 0;
		const checks = createVoiceChecks(() => ({
			input() {
				throw Error(reason);
			},
			output() {
				throw Error(reason);
			},
		}));
		assert.equal(checks.start("input"), false);
		assert.equal(checks.read().kind, "failed");
		assert.equal(checks.read().note, reason);
		assert.equal(cancelled, 0);
	}
	const absent = createVoiceChecks(() => undefined);
	assert.equal(absent.start("input"), false);
	assert.match(absent.read().note, /unavailable/i);
});
test("runtime driver registration is inert, unregister retires only its own lease and detaches observers", async () => {
	const devices = createVoiceDevices({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
	const calls = [];
	const runtime = createVoiceDeviceRuntime({
		devices,
		nativeDevices: async () => ({ supported: false, devices: [] }),
		startNative: async () => {
			calls.push("native");
		},
		getUserMedia: async () => {
			calls.push("media");
		},
	});
	let observer;
	const off = runtime.registerChecks({
		input(o) {
			observer = o;
			calls.push("start");
			return {
				stop() {
					calls.push("stop");
				},
				async cancel() {
					calls.push("cancel");
				},
			};
		},
		output() {
			throw Error("not used");
		},
	});
	assert.deepEqual(calls, []);
	runtime.checks.start("input");
	observer.preview("private");
	off();
	await runtime.checks.cancel();
	observer.preview("late");
	assert.deepEqual(calls, ["start", "cancel"]);
	assert.equal(runtime.checks.read().preview, "");
	assert.equal(runtime.checks.start("input"), false);
	assert.match(runtime.checks.read().note, /unavailable/i);
});
test("compressed browser bytes remain distinct from unknown PCM and stale completion cannot overwrite failure", () => {
	const h = rig();
	h.checks.start("input");
	h.observer.metadata({
		route: "daemon",
		stage: "transcribing",
		pcmSamples: null,
		sampleRate: null,
		compressedBytes: 19,
	});
	assert.deepEqual(h.checks.read().diagnostic, {
		route: "daemon",
		stage: "transcribing",
		pcmSamples: null,
		sampleRate: null,
		compressedBytes: 19,
	});
	h.observer.error("Transcription unavailable.");
	h.observer.complete();
	h.observer.preview("late");
	assert.equal(h.checks.read().kind, "failed");
	assert.equal(h.checks.read().preview, "");
	assert.equal(h.checks.read().note, "Transcription unavailable.");
});
for (const order of ["metadata-first", "result-first"]) {
	for (const stage of ["complete", "load-failed", "decode-failed", "worker-failed", "failed"]) {
		test(`native ${stage}: ${order} joins final evidence without trusting stop text`, () => {
			const h = rig();
			let changes = 0;
			h.checks.subscribe(() => changes++);
			h.checks.start("input");
			const o = h.observer;
			o.metadata({
				route: "native",
				stage: "recording",
				pcmSamples: null,
				sampleRate: null,
				compressedBytes: null,
			});
			const event = { ...metadata, stage, diagnosticToken: o.diagnosticToken };
			if (order === "metadata-first") o.metadata(event);
			o.preview("transient result");
			o.complete();
			if (order === "result-first") {
				assert.match(h.checks.read().note, /unknown/);
				assert.equal(h.checks.read().diagnostic.pcmSamples, null);
				o.metadata(event);
			}
			assert.equal(h.checks.read().kind, stage === "complete" ? "done" : "failed");
			assert.equal(h.checks.read().diagnostic.stage, stage);
			assert.equal(h.checks.read().diagnostic.pcmSamples, 37);
			assert.equal(h.checks.read().preview, "transient result");
			assert.equal("diagnosticToken" in h.checks.read().diagnostic, false, "never expose token");
			const before = structuredClone(h.checks.read());
			const count = changes;
			const calls = [...h.calls];
			for (const diagnosticToken of [undefined, "other", "", null, "bad token", "x".repeat(129)])
				o.metadata({ ...event, diagnosticToken, stage: "complete", pcmSamples: 999 });
			o.metadata({ ...event, stage: "loading", pcmSamples: 999 });
			if (stage !== "complete") o.metadata({ ...event, stage: "complete", pcmSamples: 999 });
			assert.deepEqual(h.checks.read(), before);
			assert.equal(changes, count);
			assert.deepEqual(h.calls, calls);
			h.checks.start("input");
			h.observer.metadata({
				route: "native",
				stage: "recording",
				pcmSamples: null,
				sampleRate: null,
				compressedBytes: null,
			});
			const newer = structuredClone(h.checks.read());
			const nextCount = changes;
			// Reusing a formerly valid token is inert even via the new observer.
			h.observer.metadata({ ...event, stage: "load-failed" });
			o.metadata(event);
			o.complete();
			o.error("old");
			assert.deepEqual(h.checks.read(), newer);
			assert.equal(changes, nextCount);
		});
	}
}
test("cancel after stop result isolates retained terminal callbacks and preserves newer failure", async () => {
	const h = rig();
	let changes = 0;
	h.checks.subscribe(() => changes++);
	h.checks.start("input");
	const old = h.observer;
	old.metadata({
		route: "native",
		stage: "recording",
		pcmSamples: null,
		sampleRate: null,
		compressedBytes: null,
	});
	old.complete();
	await h.checks.cancel();
	h.checks.start("input");
	h.observer.error("newer failure");
	const before = structuredClone(h.checks.read());
	const count = changes;
	const calls = [...h.calls];
	old.metadata({ ...metadata, stage: "complete", diagnosticToken: old.diagnosticToken });
	old.complete();
	assert.deepEqual(h.checks.read(), before);
	assert.equal(changes, count);
	assert.deepEqual(h.calls, calls);
});
test("native token validator preserves generic default and rejects invalid tokens without side effects", () => {
	const h = rig();
	const before = structuredClone(h.checks.read());
	for (const token of ["", null, 3, "bad token", "x".repeat(129)])
		assert.equal(validateNativeDiagnostic({ ...metadata, diagnosticToken: token }), null);
	assert.deepEqual(validateNativeDiagnostic({ ...metadata, diagnosticToken: "opaque_123" }), {
		...metadata,
		diagnosticToken: "opaque_123",
		compressedBytes: null,
	});
	assert.deepEqual(h.checks.read(), before);
	assert.deepEqual(h.calls, []);
});

test("output reports completion without claiming audibility and cancellation ignores late callbacks", async () => {
	const h = rig();
	assert.equal(h.checks.start("output"), true);
	h.observer.complete();
	assert.match(h.checks.read().note, /confirm.*hear/i);
	assert.equal(h.checks.read().kind, "done");
	h.checks.start("output");
	const old = h.observer;
	await h.checks.cancel();
	old.complete();
	assert.equal(h.checks.read().kind, "idle");
	assert.equal(h.checks.read().preview, "");
});
