import assert from "node:assert/strict";
import { test } from "node:test";
import { guessLanguage, speakableText } from "../src/speech.ts";
import { createVoiceOutput } from "../src/voice-output.ts";

function harness(overrides = {}) {
	let voices = [{ lang: "en-US", default: true }];
	const spoken = [],
		errors = [],
		states = [],
		timers = new Map(),
		listeners = new Set(),
		players = [];
	const synthesis = {
		getVoices: () => voices,
		speak: (utterance) => spoken.push(utterance),
		cancel() {},
		addEventListener: (_name, fn) => listeners.add(fn),
		removeEventListener: (_name, fn) => listeners.delete(fn),
	};
	const output = createVoiceOutput({
		synthesis,
		utterance: (text) => ({ text }),
		language: "en-US",
		audio: () => {
			const player = {
				play: () => Promise.resolve(),
				pause() {
					player.paused = true;
				},
			};
			players.push(player);
			return player;
		},
		onSpeaking: (value) => states.push(value),
		onError: (message) => errors.push(message),
		clock: {
			after: (ms, fn) => {
				timers.set(fn, ms);
				return () => timers.delete(fn);
			},
		},
		...overrides,
	});
	return {
		output,
		spoken,
		errors,
		states,
		timers,
		listeners,
		players,
		voices: (next) => {
			voices = next;
		},
		changed: () => {
			for (const fn of [...listeners]) fn();
		},
		timeout: () => {
			for (const fn of [...timers.keys()]) fn();
		},
	};
}

test("delayed voices select Spanish and remove readiness work", () => {
	const h = harness();
	h.voices([]);
	h.output.sayLocal("¡Hola! Gracias por la ayuda.");
	assert.equal(h.spoken.length, 0);
	assert.deepEqual([...h.timers.values()], [1500]);
	const staleReady = [...h.listeners][0];
	h.voices([{ lang: "en-US" }, { lang: "es-MX" }]);
	h.changed();
	staleReady();
	assert.equal(h.spoken.length, 1);
	assert.equal(h.spoken[0].voice.lang, "es-MX");
	assert.equal(h.spoken[0].lang, "es");
	assert.equal(h.listeners.size + h.timers.size, 0);
});

test("empty voices time out honestly without queuing an unverified default", () => {
	const h = harness();
	h.voices([]);
	h.output.sayLocal("Hello");
	h.changed();
	h.timeout();
	assert.equal(h.spoken.length, 0);
	assert.match(h.errors[0], /no system voices/i);
	assert.equal(h.states.at(-1), false);
	assert.equal(h.listeners.size + h.timers.size, 0);
});

test("missing synthesis reports unavailable, not speaking", () => {
	const h = harness({ synthesis: undefined });
	h.output.sayLocal("Hello");
	assert.match(h.errors[0], /unavailable/i);
	assert.equal(h.states.at(-1), false);
});

test("stop cancels readiness and stale voiceschanged cannot speak", () => {
	const h = harness();
	h.voices([]);
	h.output.sayLocal("Hello");
	assert.equal(h.listeners.size, 1);
	const stale = [...h.listeners][0];
	h.output.stop();
	h.voices([{ lang: "en-US" }]);
	stale();
	h.timeout();
	assert.equal(h.spoken.length, 0);
	assert.equal(h.listeners.size + h.timers.size, 0);
	assert.equal(h.states.at(-1), false);
});

test("utterance error releases speaking and stale end cannot finish a newer reply", () => {
	const h = harness();
	h.output.sayLocal("Hello");
	const old = h.spoken[0];
	assert.ok(old);
	const staleEnd = old.onend;
	old.onerror({ error: "synthesis-failed" });
	assert.match(h.errors[0], /system speech failed/i);
	assert.equal(h.states.at(-1), false);
	h.output.sayLocal("Hello again");
	staleEnd();
	assert.equal(h.states.at(-1), true);
	h.spoken[1].onend();
	assert.equal(h.states.at(-1), false);
});

test("synchronous synthesis failure is an honest settled error", () => {
	const h = harness({
		utterance: () => {
			throw new Error("not supported");
		},
	});
	h.output.sayLocal("Hello");
	assert.match(h.errors[0], /system speech failed/i);
	assert.equal(h.states.at(-1), false);
});

test("existing region preference and first matching voice ordering remain unchanged", () => {
	const h = harness();
	h.voices([{ lang: "en-GB" }, { lang: "en-AU", default: true }]);
	h.output.sayLocal("Hello");
	assert.equal(h.spoken[0]?.voice?.lang, "en-GB");
	h.output.sayLocal("Hola gracias");
	assert.equal(h.spoken[1].lang, "es");
	assert.equal(h.spoken[1].voice, undefined);
	h.voices([{ lang: "en-AU", default: true }, { lang: "en-US" }]);
	h.output.sayLocal("Hello");
	assert.equal(h.spoken[2].voice.lang, "en-US");
});

test("audio play rejection falls back locally rather than silently stopping", async () => {
	const h = harness({ audio: () => ({ play: () => Promise.reject(new Error("blocked")), pause() {} }) });
	h.output.sayAudio("Hello", "data:audio/mpeg;base64,QQ==");
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(h.spoken[0]?.text, "Hello");
	assert.equal(h.errors.length, 0);
});

test("audio error falls back once and reports unavailable local output", () => {
	const h = harness({ synthesis: undefined });
	h.output.sayAudio("Hello", "data:audio/mpeg;base64,QQ==");
	const fail = h.players[0]?.onerror;
	assert.equal(typeof fail, "function");
	fail();
	fail();
	assert.equal(h.players[0].paused, true);
	assert.equal(h.errors.length, 1);
	assert.equal(h.states.at(-1), false);
});

test("stop retires audio rejection and stale callbacks without fallback or error", async () => {
	let reject;
	const h = harness({
		audio: () => ({
			play: () =>
				new Promise((_resolve, fail) => {
					reject = fail;
				}),
			pause() {},
		}),
	});
	h.output.sayAudio("Hello", "audio");
	assert.equal(h.states.at(-1), true);
	h.output.stop();
	reject(new Error("late"));
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(h.spoken.length + h.errors.length, 0);
	assert.equal(h.states.at(-1), false);
});

test("successful audio end settles; replacement ignores old audio end", () => {
	const h = harness();
	h.output.sayAudio("Hello", "audio");
	const stale = h.players[0]?.onended;
	assert.equal(typeof stale, "function");
	h.output.sayLocal("Hello again");
	stale();
	assert.equal(h.states.at(-1), true);
	h.spoken[0].onend();
	assert.equal(h.states.at(-1), false);
});

test("deadline discovers voices even without a voiceschanged event", () => {
	const h = harness();
	h.voices([]);
	h.output.sayLocal("Hello");
	h.voices([{ lang: "en-US" }]);
	h.timeout();
	assert.equal(h.spoken.length, 1);
	assert.equal(h.errors.length + h.listeners.size + h.timers.size, 0);
});

test("missing utterance API and throwing speak both settle with errors", () => {
	const missing = harness({ utterance: undefined });
	missing.output.sayLocal("Hello");
	assert.match(missing.errors[0], /unavailable/i);
	const broken = harness({
		synthesis: {
			getVoices: () => [{ lang: "en-US" }],
			cancel() {},
			speak() {
				throw new Error("backend");
			},
		},
	});
	broken.output.sayLocal("Hello");
	assert.match(broken.errors[0], /system speech failed/i);
	assert.equal(broken.states.at(-1), false);
});

const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};
const deferred = () => {
	let resolve, reject;
	const promise = new Promise((a, b) => {
		resolve = a;
		reject = b;
	});
	return { promise, resolve, reject };
};

function routed(overrides = {}) {
	const calls = [],
		sink = deferred(),
		wav = deferred();
	const h = harness({
		routing: { selection: () => "speaker", supported: () => true },
		native: {
			available: async () => true,
			requestId: () => "request-1",
			synthesize: (...args) => {
				calls.push(["synthesize", ...args]);
				return wav.promise;
			},
			cancel: async (id) => {
				calls.push(["cancel", id]);
			},
			wav: (bytes) => {
				calls.push(["wav", bytes]);
				return { src: "blob:wav", release: () => calls.push(["release"]) };
			},
		},
		audio: (src) => {
			calls.push(["audio", src]);
			return {
				setSinkId: (id) => {
					calls.push(["sink", id]);
					return sink.promise;
				},
				play: async () => {
					calls.push(["play"]);
				},
				pause: () => calls.push(["pause"]),
			};
		},
		...overrides,
	});
	return { ...h, calls, sink, wav };
}

test("selected local WAV awaits synthesis and sink, then releases once on stop", async () => {
	const h = routed();
	h.output.sayLocal("Hello");
	await flush();
	assert.deepEqual(h.calls, [["synthesize", "request-1", "Hello", "en"]]);
	h.wav.resolve([82, 73]);
	await flush();
	assert.deepEqual(h.calls.slice(1), [
		["wav", [82, 73]],
		["audio", "blob:wav"],
		["sink", "speaker"],
	]);
	h.sink.resolve();
	await flush();
	assert.deepEqual(h.calls.at(-1), ["play"]);
	h.output.stop();
	h.output.stop();
	assert.equal(h.calls.filter((c) => c[0] === "release").length, 1);
	assert.equal(h.calls.filter((c) => c[0] === "cancel").length, 0);
	assert.equal(h.spoken.length + h.errors.length, 0);
});

test("stop during native synthesis cancels exact ID and ignores late bytes", async () => {
	const h = routed();
	h.output.sayLocal("Hello");
	await flush();
	h.output.stop();
	h.wav.resolve([1]);
	await flush();
	assert.deepEqual(h.calls, [
		["synthesize", "request-1", "Hello", "en"],
		["cancel", "request-1"],
	]);
	assert.equal(h.states.at(-1), false);
	assert.equal(h.errors.length + h.spoken.length, 0);
});

test("stop while sink pending releases WAV and never plays stale audio", async () => {
	const h = routed();
	h.output.sayLocal("Hello");
	await flush();
	h.wav.resolve([1]);
	await flush();
	h.output.stop();
	h.sink.resolve();
	await flush();
	assert.equal(h.calls.filter((c) => c[0] === "release").length, 1);
	assert.equal(h.calls.filter((c) => c[0] === "play").length, 0);
});

test("selected cloud audio awaits sink; rejection never falls back to system speech", async () => {
	const h = routed();
	h.output.sayAudio("Hello", "mp3");
	await flush();
	assert.deepEqual(h.calls, [
		["audio", "mp3"],
		["sink", "speaker"],
	]);
	h.sink.reject(Error("denied"));
	await flush();
	assert.equal(h.calls.filter((c) => c[0] === "play").length, 0);
	assert.equal(h.spoken.length, 0);
	assert.equal(h.errors.length, 1);
	assert.equal(h.states.at(-1), false);
});

test("unsupported explicit output is inert for local and cloud", async () => {
	const h = routed({ routing: { selection: () => "speaker", supported: () => false } });
	h.output.sayLocal("Hello");
	await flush();
	h.output.sayAudio("Hello", "mp3");
	await flush();
	assert.deepEqual(h.calls, []);
	assert.equal(h.spoken.length, 0);
	assert.equal(h.errors.length, 2);
});

test("explicit output with no native synthesis never uses browser speech", async () => {
	const h = routed({ native: undefined });
	h.output.sayLocal("Hello");
	await flush();
	assert.equal(h.calls.length + h.spoken.length, 0);
	assert.equal(h.errors.length, 1);
});

test("native session budget failure stays actionable without falling back", async () => {
	const h = routed();
	h.output.sayLocal("Hello");
	await flush();
	h.wav.reject("Speech request session limit reached; restart the app");
	await flush();
	assert.deepEqual(h.errors, ["Speech request session limit reached; restart the app"]);
	assert.equal(h.spoken.length, 0);
	assert.equal(
		h.calls.some((c) => c[0] === "audio"),
		false,
	);
});

test("replacement retires the old native request but not the new request", async () => {
	const first = deferred(),
		second = deferred();
	let n = 0;
	const calls = [];
	const h = routed({
		native: {
			available: async () => true,
			requestId: () => `r-${++n}`,
			synthesize: (id) => {
				calls.push(["synth", id]);
				return id === "r-1" ? first.promise : second.promise;
			},
			cancel: async (id) => {
				calls.push(["cancel", id]);
			},
			wav: () => {
				throw Error("stale WAV must not be used");
			},
		},
	});
	h.output.sayLocal("first");
	await flush();
	h.output.sayLocal("second");
	await flush();
	first.resolve([1]);
	await flush();
	assert.deepEqual(calls, [
		["synth", "r-1"],
		["cancel", "r-1"],
		["synth", "r-2"],
	]);
	assert.equal(h.states.at(-1), true);
	assert.equal(h.errors.length, 0);
	h.output.stop();
	assert.deepEqual(calls.at(-1), ["cancel", "r-2"]);
	second.resolve([2]);
	await flush();
	assert.equal(h.errors.length, 0);
});

test("non-Windows default routing preserves browser speech and cloud fallback", async () => {
	const h = routed({
		routing: { selection: () => null, supported: () => false },
		native: { available: async () => false },
		audio: () => ({
			play: async () => {
				throw Error("failed");
			},
			pause() {},
		}),
	});
	h.output.sayLocal("Hello");
	await flush();
	assert.equal(h.spoken.length, 1);
	h.output.sayAudio("Hello again", "mp3");
	await flush();
	assert.equal(h.spoken.length, 2);
	assert.equal(h.errors.length, 0);
	h.output.stop();
	assert.equal(h.states.at(-1), false);
});

test("explicit missing sink API and rejected play are settled errors, not fallback", async () => {
	for (const player of [
		{ play: async () => {}, pause() {} },
		{
			setSinkId: async () => {},
			play: async () => {
				throw Error("blocked");
			},
			pause() {},
		},
	]) {
		const h = routed({ audio: () => player });
		h.output.sayAudio("Hello", "mp3");
		await flush();
		assert.equal(h.errors.length, 1);
		assert.equal(h.spoken.length, 0);
		assert.equal(h.states.at(-1), false);
	}
});

test("native WAV URLs release exactly once on play error and natural end", async () => {
	for (const failure of [false, true]) {
		let player;
		const h = routed({
			audio: () =>
				(player = {
					setSinkId: async () => {},
					play: async () => {
						if (failure) throw Error("blocked");
					},
					pause() {},
				}),
		});
		h.output.sayLocal("Hello");
		await flush();
		h.wav.resolve([1]);
		await flush();
		if (!failure) player.onended();
		h.output.stop();
		assert.equal(h.calls.filter((c) => c[0] === "release").length, 1);
		assert.equal(h.errors.length, failure ? 1 : 0);
		assert.equal(h.spoken.length, 0);
	}
});

test("existing text cleaning and language inference remain unchanged", () => {
	assert.equal(speakableText("**Hello** [docs](https://x.dev) `code`\n```js\nsecret\n```"), "Hello docs");
	assert.equal(guessLanguage("¡Hola! Gracias por la ayuda."), "es");
	assert.equal(guessLanguage("Hello and thanks"), "en");
});

for (const [kind, message, display] of [
	["unavailable", "System speech is unavailable in this runtime.", "outputUnavailable"],
	["system", "System speech failed. Check the installed voices and audio output.", "outputSystemFailed"],
	["voices", "No system voices became available. Check the installed speech voices.", "outputNoVoices"],
	[
		"routing",
		"Selected audio output is unavailable. Check output support, permission and device connection.",
		"outputRouting",
	],
	["local", "Local speech failed. Check speech support and the selected output.", "outputLocalFailed"],
])
	test("owned output metadata preserves raw " + kind + " failure and retirement", async () => {
		const errors = [];
		const extra =
			kind === "unavailable"
				? { synthesis: undefined }
				: kind === "routing"
					? { routing: { selection: () => "speaker", supported: () => false } }
					: kind === "local"
						? {
								native: {
									available: async () => {
										throw Error("external availability failure");
									},
								},
							}
						: {};
		const h = harness({ ...extra, onError: (...args) => errors.push(args) });
		if (kind === "voices") h.voices([]);
		h.output.sayLocal("unchanged request");
		if (kind === "system") h.spoken[0].onerror();
		if (kind === "voices") h.timeout();
		await flush();
		assert.deepEqual(errors, [[message, display]]);
		assert.equal(h.states.at(-1), false);
		assert.equal(h.listeners.size + h.timers.size, 0);
		assert.equal(h.players.length, 0);
		h.output.stop();
		h.changed();
		h.timeout();
		await flush();
		assert.deepEqual(errors, [[message, display]]);
	});

for (const reason of ["Speech request session limit reached; restart the app", "Speech synthesis is busy"]) {
	test("native sentinel remains one-argument raw: " + reason, async () => {
		const errors = [];
		const h = routed({ onError: (...args) => errors.push(args) });
		h.output.sayLocal("unchanged request");
		await flush();
		h.wav.reject(reason);
		await flush();
		assert.deepEqual(errors, [[reason]]);
		assert.equal(h.states.at(-1), false);
		assert.equal(h.spoken.length, 0);
		assert.equal(
			h.calls.some((c) => c[0] === "audio"),
			false,
		);
	});
}
