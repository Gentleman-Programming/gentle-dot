import assert from "node:assert/strict";
import { test } from "node:test";
import { guessLanguage, pickVoice } from "../src/speech.ts";
import { createVoiceOutput } from "../src/voice-output.ts";

const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};
function deferred() {
	let resolve, reject;
	const promise = new Promise((a, b) => {
		resolve = a;
		reject = b;
	});
	return { promise, resolve, reject };
}

// Small valid PCM16 mono WAV for controller playback fixtures.
function wave() {
	const bytes = new Uint8Array(48);
	const view = new DataView(bytes.buffer);
	const tag = (at, text) => {
		for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
	};
	tag(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	tag(8, "WAVEfmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 16000, true);
	view.setUint32(28, 32000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	tag(36, "data");
	view.setUint32(40, 4, true);
	return Array.from(bytes);
}

function harness({
	browser = true,
	voices: initialVoices = [{ lang: "en-US" }],
	supported = true,
	status,
	synthesize,
	play,
	speak,
	native = !browser,
} = {}) {
	let voices = initialVoices;
	let serial = 0;
	const spoken = [],
		errors = [],
		states = [],
		events = [],
		timers = new Map();
	const listeners = new Set(),
		players = [],
		blobs = [],
		created = [],
		revoked = [];
	const requests = [],
		cancellations = [],
		statusCalls = [],
		selections = [];
	const synthesis = {
		getVoices: () => voices,
		speak: (utterance) => {
			spoken.push(utterance);
			events.push("browser-play");
			speak?.(utterance);
		},
		cancel: () => events.push("browser-cancel"),
		addEventListener: (name, fn) => {
			assert.equal(name, "voiceschanged");
			listeners.add(fn);
		},
		removeEventListener: (name, fn) => {
			assert.equal(name, "voiceschanged");
			listeners.delete(fn);
		},
	};
	const output = createVoiceOutput({
		browser: browser
			? {
					synthesis,
					utterance: (text, available) => {
						selections.push([text, available]);
						// Same adapter as today's useVoice: policy remains in speech.ts.
						const lang = guessLanguage(text) ?? "en-US".slice(0, 2).toLowerCase();
						return { text, lang, voice: pickVoice(available, lang, "en-US") };
					},
				}
			: undefined,
		locale: (text) => guessLanguage(text) ?? "en-US",
		requestId: () => `output-${++serial}`,
		native: native
			? {
					status: (args) => {
						statusCalls.push(args);
						return status ? status(args) : Promise.resolve({ supported });
					},
					synthesize: (args) => {
						requests.push(args);
						return synthesize ? synthesize(args) : Promise.resolve(wave());
					},
					cancel: async (args) => {
						cancellations.push(args);
					},
				}
			: undefined,
		audio: (src) => {
			const player = {
				src,
				onended: null,
				onerror: null,
				active: false,
				play() {
					assert.equal(players.filter((p) => p.active).length, 0, "no overlapping playback");
					player.active = true;
					events.push(`play:${src}`);
					return play ? play(player) : Promise.resolve();
				},
				pause() {
					player.active = false;
					events.push(`pause:${src}`);
				},
			};
			players.push(player);
			return player;
		},
		wav: (bytes) => {
			assert.ok(bytes instanceof Uint8Array);
			const blob = { bytes, type: "audio/wav" };
			blobs.push(blob);
			return blob;
		},
		urls: {
			createObjectURL: (blob) => {
				assert.ok(blobs.includes(blob));
				const url = `blob:fixture-${created.length + 1}`;
				created.push(url);
				return url;
			},
			revokeObjectURL: (url) => revoked.push(url),
		},
		clock: {
			after: (ms, fn) => {
				timers.set(fn, ms);
				return () => timers.delete(fn);
			},
		},
		onSpeaking: (value) => states.push(value),
		onError: (message) => errors.push(message),
	});
	return {
		output,
		spoken,
		errors,
		states,
		events,
		timers,
		listeners,
		players,
		blobs,
		created,
		revoked,
		requests,
		cancellations,
		statusCalls,
		selections,
		voices: (next) => {
			voices = next;
		},
		changed: () => {
			for (const fn of [...listeners]) fn();
		},
		deadline: (ms) => {
			const due = [...timers].filter(([, delay]) => delay === ms);
			assert.equal(due.length, 1, `one ${ms}ms deadline`);
			for (const [fn] of due) {
				timers.delete(fn);
				fn();
			}
		},
	};
}
function settledFailure(h, pattern) {
	assert.equal(h.errors.length, 1, "one visible output failure");
	assert.match(h.errors[0], pattern);
	assert.match(h.errors[0], /check|retry|restart|allow|busy/i, "actionable error");
	assert.equal(h.states.at(-1), false);
	assert.equal(h.timers.size + h.listeners.size, 0);
}

// Browser regression: real policy helpers, but no OS voices or browser APIs.
test("browser regression: injected current region/language policy and full text stay unchanged", () => {
	const h = harness({ voices: [{ lang: "en-GB" }, { lang: "en-AU", default: true }, { lang: "en-US" }] });
	const text = "Hello and thanks ".repeat(1000);
	h.output.sayLocal(text);
	assert.equal(h.spoken.length, 1);
	assert.equal(h.spoken[0].text, text);
	assert.equal(h.spoken[0].voice.lang, "en-US");
	assert.equal(h.spoken[0].lang, "en");
	h.voices([{ lang: "es-MX" }, { lang: "es-ES", default: true }]);
	h.output.sayLocal("¡Hola! Gracias por la ayuda.");
	assert.equal(h.spoken[1].voice.lang, "es-MX");
	assert.equal(h.spoken[1].lang, "es");
	assert.equal(h.statusCalls.length, 0, "browser works without native probing");
	assert.equal(h.events[0], "browser-cancel");
	h.output.dispose();
});

test("unsupported native status preserves browser voiceschanged wait1500ms and cleanup", async () => {
	const h = harness({ native: true, supported: false, voices: [] });
	h.output.sayLocal("Hello");
	await flush();
	assert.deepEqual(h.statusCalls, [{}]);
	assert.equal(h.requests.length, 0);
	assert.deepEqual([...h.timers.values()], [1500]);
	assert.equal(h.listeners.size, 1);
	const stale = [...h.listeners][0];
	h.voices([{ lang: "en-US" }]);
	h.changed();
	stale();
	assert.equal(h.spoken.length, 1);
	assert.equal(h.selections.length, 1);
	assert.equal(h.timers.size + h.listeners.size, 0);
	h.output.dispose();
});

test("readiness deadline rechecks voices even without voiceschanged", () => {
	const h = harness({ voices: [] });
	h.output.sayLocal("Hello");
	h.voices([{ lang: "en-US" }]);
	h.deadline(1500);
	assert.equal(h.spoken.length, 1);
	assert.equal(h.statusCalls.length + h.errors.length + h.listeners.size + h.timers.size, 0);
	h.output.dispose();
});

for (const browser of [true, false]) {
	test(`compiled native support selects WAV before browser without mic catalog: browser=${browser}`, async () => {
		const h = harness({ browser, native: true });
		h.output.sayLocal("¡Hola! Gracias.");
		await flush();
		assert.deepEqual(h.statusCalls, [{}]);
		assert.equal(h.requests.length, 1);
		assert.deepEqual(h.requests[0], { requestId: "output-1", text: "¡Hola! Gracias.", locale: "es" });
		assert.equal(h.players.length, 1);
		assert.equal(h.players[0].active, true);
		assert.equal(h.states.at(-1), true);
		assert.equal(h.blobs.length, 1);
		assert.deepEqual([...h.blobs[0].bytes], wave());
		assert.equal(h.spoken.length + h.errors.length + h.listeners.size + h.timers.size, 0);
		h.output.dispose();
	});
}

test("browser without native support or voices settles visibly after readiness deadline", async () => {
	const h = harness({ voices: [] });
	h.output.sayLocal("Hello");
	h.deadline(1500);
	await flush();
	settledFailure(h, /voice|speech|unavailable/i);
	assert.equal(h.players.length + h.spoken.length, 0);
});

test("stop retires readiness; replacement and dispose ignore all late readiness callbacks", () => {
	const h = harness({ voices: [] });
	h.output.sayLocal("first");
	assert.equal(h.listeners.size, 1);
	const oldReady = [...h.listeners][0],
		oldTimer = [...h.timers.keys()][0];
	h.output.stop();
	assert.equal(h.listeners.size + h.timers.size, 0);
	assert.equal(h.states.at(-1), false);
	h.voices([{ lang: "en-US" }]);
	h.output.sayLocal("second");
	const snapshot = [...h.states];
	oldReady();
	oldTimer();
	assert.deepEqual(h.states, snapshot);
	assert.deepEqual(
		h.spoken.map((u) => u.text),
		["second"],
	);
	h.output.dispose();
	const disposedStates = [...h.states];
	oldReady();
	oldTimer();
	h.output.sayLocal("must remain inert");
	assert.deepEqual(h.states, disposedStates);
	assert.equal(h.states.at(-1), false);
	assert.equal(h.spoken.length, 1);
	assert.equal(h.errors.length + h.timers.size + h.listeners.size, 0);
});

for (const failure of ["event", "throw"]) {
	test(`browser ${failure} failure is actionable, never retries a partially spoken reply`, () => {
		const h = harness({
			speak:
				failure === "throw"
					? () => {
							throw Error("engine failed");
						}
					: undefined,
		});
		h.output.sayLocal("Hello");
		assert.equal(h.spoken.length, 1);
		const old = h.spoken[0];
		if (failure === "event") old.onerror({ error: "synthesis-failed" });
		settledFailure(h, /speech|voice/i);
		assert.equal(h.statusCalls.length, 0);
	});
}

test("browser replacement cancels old speech and stale end/error cannot settle the newer reply", () => {
	const h = harness();
	h.output.sayLocal("first");
	assert.equal(h.spoken.length, 1);
	const end = h.spoken[0].onend,
		error = h.spoken[0].onerror;
	h.output.sayLocal("second");
	const snapshot = [...h.states];
	end();
	error();
	assert.deepEqual(h.states, snapshot);
	assert.equal(h.states.at(-1), true);
	assert.equal(h.errors.length, 0);
	assert.equal(h.events.at(-2), "browser-cancel");
	h.spoken[1].onend();
	assert.equal(h.states.at(-1), false);
});

for (const retirement of ["stop", "dispose"]) {
	for (const result of ["resolve", "reject"]) {
		test(`${retirement} cancels exact request before native admission and ignores late status ${result}`, async () => {
			const status = deferred();
			const h = harness({ native: true, status: () => status.promise });
			h.output.sayLocal("first");
			await flush();
			assert.equal(h.statusCalls.length, 1);
			assert.equal(h.spoken.length + h.listeners.size + h.timers.size, 0);
			h.output[retirement]();
			assert.equal(h.states.at(-1), false);
			assert.deepEqual(h.cancellations, [{ requestId: "output-1" }]);
			const snapshot = [...h.states];
			if (result === "resolve") status.resolve({ supported: true });
			else status.reject(Error("late discovery failure"));
			await flush();
			assert.deepEqual(h.states, snapshot);
			assert.equal(h.requests.length + h.players.length + h.errors.length + h.timers.size, 0);
		});
	}
}

for (const result of ["resolve", "reject"]) {
	test(`replacement uses unique bounded request IDs and ignores stale synthesis ${result}`, async () => {
		const first = deferred(),
			second = deferred();
		let count = 0;
		const h = harness({ browser: false, synthesize: () => (++count === 1 ? first : second).promise });
		h.output.sayLocal("first");
		await flush();
		assert.equal(h.requests.length, 1);
		h.output.sayLocal("second");
		await flush();
		assert.equal(h.requests.length, 2);
		assert.equal(h.states.at(-1), true);
		const ids = h.requests.map((r) => r.requestId);
		assert.equal(new Set(ids).size, 2);
		assert.ok(ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128));
		assert.deepEqual(h.cancellations, [{ requestId: ids[0] }]);
		const snapshot = [...h.states];
		if (result === "resolve") first.resolve(wave());
		else first.reject(Error("late synthesis failure"));
		await flush();
		assert.deepEqual(h.states, snapshot);
		assert.equal(h.created.length + h.errors.length, 0);
		second.resolve(wave());
		await flush();
		assert.equal(h.players.length, 1);
		h.output.dispose();
	});
}

for (const completion of ["end", "error", "stop", "dispose", "reject", "replace"]) {
	test(`native WAV URL releases exactly once on ${completion}; stale media callbacks are inert`, async () => {
		const h = harness({
			native: true,
			play: completion === "reject" ? () => Promise.reject(Error("blocked")) : undefined,
		});
		h.output.sayLocal("first");
		await flush();
		assert.equal(h.players.length, 1);
		assert.deepEqual(h.created, ["blob:fixture-1"]);
		const player = h.players[0],
			end = player.onended,
			error = player.onerror;
		if (completion === "end") end();
		if (completion === "error") error();
		if (completion === "stop") h.output.stop();
		if (completion === "dispose") h.output.dispose();
		if (completion === "replace") {
			h.output.sayLocal("second");
			await flush();
			assert.equal(h.players.length, 2);
			assert.equal(player.active, false);
			assert.equal(h.players[1].active, true);
			assert.equal(h.errors.length, 0);
		}
		if (completion === "reject" || completion === "error") {
			settledFailure(h, /speech|audio|play|output/i);
		} else {
			assert.equal(h.errors.length, 0);
		}
		assert.equal(h.states.at(-1), completion === "replace");
		const states = [...h.states],
			errors = [...h.errors];
		// Rejection may already have detached handlers before it is observed here.
		end?.();
		error?.();
		await flush();
		assert.deepEqual(h.states, states);
		assert.deepEqual(h.errors, errors);
		assert.equal(h.revoked.filter((url) => url === "blob:fixture-1").length, 1);
		assert.equal(player.onended, null);
		assert.equal(player.onerror, null);
		assert.equal(player.active, false);
		assert.equal(h.spoken.length, 0, "never retry failed or partial native playback in browser");
		h.output.dispose();
		h.output.dispose();
		assert.deepEqual([...h.revoked].sort(), [...h.created].sort());
	});
}

test("stop retires pending play rejection without changing newer speech state or error", async () => {
	const pending = deferred();
	let count = 0;
	const h = harness({ browser: false, play: () => (++count === 1 ? pending.promise : Promise.resolve()) });
	h.output.sayLocal("first");
	await flush();
	assert.equal(h.players.length, 1);
	h.output.stop();
	h.output.sayLocal("second");
	await flush();
	assert.equal(h.players.length, 2);
	const snapshot = [...h.states];
	pending.reject(Error("late autoplay rejection"));
	await flush();
	assert.deepEqual(h.states, snapshot);
	assert.equal(h.errors.length, 0);
	assert.equal(h.players[1].active, true);
	assert.deepEqual(h.revoked, ["blob:fixture-1"]);
	h.output.dispose();
});

for (const [name, stage, reason, pattern] of [
	["status failure", "status", Error("status discovery failed"), /speech|voice/i],
	["busy", "synthesis", "Speech synthesis is busy", /busy/i],
	["history limit", "synthesis", "Speech request session limit reached; restart the app", /limit.*restart/i],
	["render failure", "synthesis", Error("native rendering failed"), /speech|voice/i],
]) {
	test(`native ${name} is visible without switching to available browser speech`, async () => {
		const h = harness({
			native: true,
			status: stage === "status" ? () => Promise.reject(reason) : undefined,
			synthesize: stage === "synthesis" ? () => Promise.reject(reason) : undefined,
		});
		h.output.sayLocal("Hello");
		await flush();
		settledFailure(h, pattern);
		if (typeof reason === "string") assert.equal(h.errors[0], reason);
		assert.equal(h.created.length + h.players.length + h.spoken.length, 0);
	});
}

test("controller rejects invalid WAV before Blob, URL or playback", async () => {
	const h = harness({ browser: false, synthesize: async () => wave().slice(0, 20) });
	h.output.sayLocal("Hello");
	await flush();
	settledFailure(h, /wav|audio|speech/i);
	assert.equal(h.blobs.length, 0);
	assert.equal(h.created.length, 0);
	assert.equal(h.players.length, 0);
});
