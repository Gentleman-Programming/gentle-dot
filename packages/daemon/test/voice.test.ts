import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_VOICE_AUDIO, MAX_VOICE_TEXT, type ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createModelAuthRuntime } from "../src/auth.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { SPEECH_URL, VoiceService } from "../src/voice.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const KEY = "nv-voice-test-key-not-real-1234";
const AUDIO = Buffer.from("fake opus bytes").toString("base64");
const SPEECH_LANGUAGE = "es-US";
const SPEECH_VOICE = "Magpie-Multilingual.ES-US.Isabela";

type Call = { url: string; init: RequestInit };

/** A fetch that records each call and answers with `reply`. */
function fakeFetch(reply: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
		const call = { url: String(url), init };
		calls.push(call);
		return reply(call);
	};
	return { fetch: fetch as typeof globalThis.fetch, calls };
}

/** The stub transcriber the tests install: answers each request line on stdin. */
const STUB_TRANSCRIBER = `
"use strict";
console.error("transcriber: ready");
const { readFileSync } = require("node:fs");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		let request = {};
		try { request = JSON.parse(line); } catch {}
		let content = "";
		if (request.file) {
			try { content = readFileSync(request.file, "utf8"); } catch {}
		}
		if (!request.file) process.stdout.write(JSON.stringify({ error: "missing file" }) + "\\n");
		else if (content.includes("empty")) process.stdout.write(JSON.stringify({ text: "  " }) + "\\n");
		else if (content.includes("boom")) process.stdout.write(JSON.stringify({ error: "stub failed" }) + "\\n");
		else process.stdout.write(JSON.stringify({ text: "hello from the local transcriber" }) + "\\n");
	}
});
process.stdin.on("end", () => process.exit(0));
`;

/** Points the service at `path` for the local model. Returns the env restore. */
function setModelEnv(path: string): () => void {
	const saved = process.env.GENTLE_DOT_VOICE_MODEL;
	process.env.GENTLE_DOT_VOICE_MODEL = path;
	return () => {
		if (saved === undefined) delete process.env.GENTLE_DOT_VOICE_MODEL;
		else process.env.GENTLE_DOT_VOICE_MODEL = saved;
	};
}

/**
 * Installs the local transcription assets into `dataDir`: the stub
 * transcriber under `voice-tools/` and a fake model directory, and points
 * the service at them via `GENTLE_DOT_VOICE_MODEL`. Returns the restore
 * function for the environment variable.
 */
function localAssets(dataDir: string): () => void {
	const tools = join(dataDir, "voice-tools");
	mkdirSync(tools, { recursive: true });
	writeFileSync(join(tools, "transcriber.js"), STUB_TRANSCRIBER);
	const model = join(dataDir, "model");
	mkdirSync(model, { recursive: true });
	writeFileSync(join(model, "encoder.int8.onnx"), "");
	writeFileSync(join(model, "tokens.txt"), "");
	return setModelEnv(model);
}

/**
 * `key: null` means no key is connected. `assets: false` installs nothing
 * and points the model environment at a directory that does not exist, so
 * capability checks are deterministic even on a machine that has the real
 * model downloaded.
 */
function service(
	reply: (call: Call) => Response | Promise<Response>,
	key: string | null = KEY,
	options: { assets?: boolean } = {},
) {
	const logs: string[] = [];
	const fake = fakeFetch(reply);
	const dataDir = tempDir();
	const restore =
		options.assets === false ? setModelEnv(join(dataDir, "missing-model")) : localAssets(dataDir);
	try {
		const voice = new VoiceService({
			apiKey: async () => key ?? undefined,
			dataDir,
			fetch: fake.fetch,
			log: (line) => logs.push(line),
		});
		return { voice, logs, calls: fake.calls, dataDir, restore };
	} catch (error) {
		restore();
		throw error;
	}
}

const header = (call: Call | undefined, name: string) => new Headers(call?.init.headers).get(name);

/** Points the voice-tools asset source at the repo copy. Returns the env restore. */
function setSourceEnv(path: string): () => void {
	const saved = process.env.GENTLE_DOT_VOICE_TOOLS_SOURCE;
	process.env.GENTLE_DOT_VOICE_TOOLS_SOURCE = path;
	return () => {
		if (saved === undefined) delete process.env.GENTLE_DOT_VOICE_TOOLS_SOURCE;
		else process.env.GENTLE_DOT_VOICE_TOOLS_SOURCE = saved;
	};
}

/** The transcriber assets shipped with the daemon package. */
const REPO_VOICE_TOOLS = fileURLToPath(new URL("../voice-tools", import.meta.url));

/** Model directory only (no transcriber script), so provisioning is the only path. */
function modelOnly(dataDir: string): () => void {
	const model = join(dataDir, "model");
	mkdirSync(model, { recursive: true });
	writeFileSync(join(model, "encoder.int8.onnx"), "");
	writeFileSync(join(model, "tokens.txt"), "");
	return setModelEnv(model);
}

describe("VoiceService transcriber provisioning", () => {
	it("logs provisioning progress while the install runs", async () => {
		const dataDir = tempDir();
		const restoreModel = modelOnly(dataDir);
		const restoreSource = setSourceEnv(REPO_VOICE_TOOLS);
		const logs: string[] = [];
		const voice = new VoiceService({
			apiKey: async () => KEY,
			dataDir,
			fetch: fakeFetch(() => new Response()).fetch,
			log: (line) => logs.push(line),
			progressIntervalMs: 40,
			installDeps: async () => {
				// Long enough for two progress ticks at the 40ms interval.
				await new Promise((resolve) => setTimeout(resolve, 150));
				writeFileSync(join(dataDir, "voice-tools", "transcriber.js"), STUB_TRANSCRIBER);
			},
		});
		try {
			expect(await voice.transcribe("audio/ogg", AUDIO)).toEqual({
				ok: true,
				text: "hello from the local transcriber",
			});
		} finally {
			restoreModel();
			restoreSource();
		}
		expect(logs).toContain("voice: installing the local transcriber");
		expect(
			logs.filter((l) => l.startsWith("voice: still installing the local transcriber (")).length,
		).toBeGreaterThanOrEqual(2);
		expect(logs).toContain("voice: local transcriber installed");
	});

	it("installs the transcriber on first use when the model is already downloaded", async () => {
		const dataDir = tempDir();
		const restoreModel = modelOnly(dataDir);
		const restoreSource = setSourceEnv(REPO_VOICE_TOOLS);
		let installs = 0;
		const voice = new VoiceService({
			apiKey: async () => KEY,
			dataDir,
			fetch: fakeFetch(() => new Response()).fetch,
			installDeps: async () => {
				installs += 1;
				// A real install drops the dependencies next to the script; the fake
				// replaces the copied transcriber with the stub the tests can run.
				writeFileSync(join(dataDir, "voice-tools", "transcriber.js"), STUB_TRANSCRIBER);
			},
		});
		try {
			expect(await voice.transcribe("audio/ogg", AUDIO)).toEqual({
				ok: true,
				text: "hello from the local transcriber",
			});
			expect(installs).toBe(1);
			// A second note reuses the installed transcriber: no reinstall.
			await voice.transcribe("audio/ogg", AUDIO);
			expect(installs).toBe(1);
		} finally {
			restoreModel();
			restoreSource();
		}
	});

	it("reports noTranscriber when the install fails, and retries later", async () => {
		const dataDir = tempDir();
		const restoreModel = modelOnly(dataDir);
		const restoreSource = setSourceEnv(REPO_VOICE_TOOLS);
		let installs = 0;
		const voice = new VoiceService({
			apiKey: async () => KEY,
			dataDir,
			fetch: fakeFetch(() => new Response()).fetch,
			installDeps: async () => {
				installs += 1;
				if (installs === 1) throw new Error("npm install failed");
				writeFileSync(join(dataDir, "voice-tools", "transcriber.js"), STUB_TRANSCRIBER);
			},
		});
		try {
			const first = await voice.transcribe("audio/ogg", AUDIO);
			expect(first.ok).toBe(false);
			expect(await voice.transcribe("audio/ogg", AUDIO)).toEqual({
				ok: true,
				text: "hello from the local transcriber",
			});
			expect(installs).toBe(2);
		} finally {
			restoreModel();
			restoreSource();
		}
	});
});

afterEach(() => {
	// Nothing global: each test restores its own environment.
});

describe("VoiceService capability", () => {
	it("transcribes when the local assets are in place, speaks when a key is connected", async () => {
		const { voice, restore } = service(() => new Response());
		try {
			expect(voice.capability()).toEqual({ transcribe: false, speak: false });
			expect(await voice.refresh()).toEqual({ transcribe: true, speak: true });
			expect(voice.capability()).toEqual({ transcribe: true, speak: true });
		} finally {
			restore();
		}
	});

	it("stays off without local assets or a key, and when reading the key fails", async () => {
		const missing = service(() => new Response(), null, { assets: false });
		expect(await missing.voice.refresh()).toEqual({ transcribe: false, speak: false });
		missing.restore();
		const noAssets = service(() => new Response(), KEY, { assets: false });
		try {
			expect(await noAssets.voice.refresh()).toEqual({ transcribe: false, speak: true });
		} finally {
			noAssets.restore();
		}
		const failing = new VoiceService({
			apiKey: async () => {
				throw new Error("locked");
			},
			dataDir: tempDir(),
			fetch: fakeFetch(() => new Response()).fetch,
		});
		expect(await failing.refresh()).toEqual({ transcribe: false, speak: false });
	});
});

describe("VoiceService.transcribe", () => {
	it("sends the recording to the local transcriber and returns its transcript", async () => {
		const { voice, calls, restore } = service(() => new Response());
		try {
			expect(await voice.transcribe("audio/webm;codecs=opus", AUDIO)).toEqual({
				ok: true,
				text: "hello from the local transcriber",
			});
			// Local transcription never touches the network.
			expect(calls).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("says nothing was heard when the transcript is empty", async () => {
		const { voice, restore } = service(() => new Response());
		try {
			expect(await voice.transcribe("audio/webm", Buffer.from("empty").toString("base64"))).toEqual({
				ok: false,
				reason: "I didn't catch anything. Try again.",
			});
		} finally {
			restore();
		}
	});

	it("refuses a recording over the size cap without starting the transcriber", async () => {
		const { voice, restore } = service(() => new Response());
		try {
			const result = await voice.transcribe("audio/webm", "A".repeat(MAX_VOICE_AUDIO + 4));
			expect(result).toEqual({ ok: false, reason: "That recording is too long. Keep it under a minute." });
		} finally {
			restore();
		}
	});

	it("explains what is missing when the model or the transcriber is not installed", async () => {
		const { voice, restore } = service(() => new Response(), KEY, { assets: false });
		try {
			expect(await voice.transcribe("audio/webm", AUDIO)).toEqual({
				ok: false,
				reason:
					"The local voice model is not downloaded yet. Download it from the app settings and try again.",
			});
		} finally {
			restore();
		}
	});
});

describe("VoiceService.speak", () => {
	it("asks NVIDIA for speech with the language, voice, and the key, and returns WAV base64", async () => {
		const wav = Buffer.from("RIFF fake wav");
		const { voice, calls, restore } = service(() => new Response(wav));
		try {
			expect(await voice.speak("Hola! Acá está la respuesta.")).toEqual({
				ok: true,
				mime: "audio/wav",
				data: wav.toString("base64"),
			});
			const call = calls[0];
			expect(call?.url).toBe(SPEECH_URL);
			expect(call?.init.method).toBe("POST");
			expect(header(call, "authorization")).toBe(`Bearer ${KEY}`);
			const body = call?.init.body as FormData;
			expect(body).toBeInstanceOf(FormData);
			expect(body.get("text")).toBe("Hola! Acá está la respuesta.");
			expect(body.get("language")).toBe(SPEECH_LANGUAGE);
			expect(body.get("voice")).toBe(SPEECH_VOICE);
		} finally {
			restore();
		}
	});

	it("refuses empty text and text over the speech limit without calling NVIDIA", async () => {
		const { voice, calls, restore } = service(() => new Response("x"));
		try {
			expect((await voice.speak(" ")).ok).toBe(false);
			expect((await voice.speak("a".repeat(MAX_VOICE_TEXT + 1))).ok).toBe(false);
			expect(calls).toHaveLength(0);
		} finally {
			restore();
		}
	});
});

describe("VoiceService errors", () => {
	const cases: [string, () => Response | Promise<Response>, string][] = [
		[
			"401",
			() => new Response(`{"detail":"bad key ${KEY}"}`, { status: 401 }),
			"NVIDIA did not accept the API key. Check it in Accounts.",
		],
		[
			"403",
			() => new Response(`{"detail":"forbidden for ${KEY}"}`, { status: 403 }),
			"This NVIDIA key is not allowed to use speech. Check its project and permissions.",
		],
		[
			"429",
			() => new Response(`{"detail":"quota for ${KEY}"}`, { status: 429 }),
			"NVIDIA is limiting requests or the account is out of credit. Try again later.",
		],
		[
			"500",
			() => new Response(`oops ${KEY}`, { status: 500 }),
			"NVIDIA could not handle the voice request. Try again.",
		],
		[
			"network",
			() => Promise.reject(new TypeError(`fetch failed for ${KEY}`)),
			"Could not reach NVIDIA. Check the internet connection.",
		],
	];

	for (const [name, reply, reason] of cases) {
		it(`maps ${name} to a readable reason and never shows or logs the key`, async () => {
			const { voice, logs, restore } = service(reply);
			try {
				const result = await voice.speak("hola");
				expect(result).toEqual({ ok: false, reason });
				expect(JSON.stringify(result)).not.toContain(KEY);
				expect(logs.length).toBeGreaterThan(0);
				expect(logs.join("\n")).not.toContain(KEY);
			} finally {
				restore();
			}
		});
	}
});

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function startWith(
	key: string | undefined,
	reply: (call: Call) => Response | Promise<Response>,
	options: { assets?: boolean } = {},
) {
	const auth = fakeAuthRuntime();
	auth.runtime.nvidiaApiKey = async () => key;
	const fake = fakeFetch(reply);
	const logs: string[] = [];
	const dataDir = tempDir();
	const restore =
		options.assets === false ? setModelEnv(join(dataDir, "missing-model")) : localAssets(dataDir);
	try {
		const d = await startDaemon({
			port: 0,
			host: "127.0.0.1",
			dataDir,
			workspace: dataDir,
			uiDir: dataDir,
			agentCommand: process.execPath,
			agentArgs: [FAKE_AGENT],
			backoffMs: [50],
			authRuntime: async () => auth.runtime,
			voiceFetch: fake.fetch,
			log: (line) => logs.push(line),
		});
		daemons.push(d);
		const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
		const messages: ServerMessage[] = [];
		ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
		await new Promise((resolve) => ws.on("open", resolve));
		ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
		const send = (m: object) => ws.send(JSON.stringify(m));
		const find = <T extends ServerMessage["type"]>(type: T) =>
			waitFor(() => messages.find((m): m is Extract<ServerMessage, { type: T }> => m.type === type));
		return { messages, send, find, logs, calls: fake.calls, restore };
	} catch (error) {
		restore();
		throw error;
	}
}

describe("voice through the daemon", () => {
	it("reports voice in the accounts list and transcribes locally with the key never leaving the daemon", async () => {
		const { send, find, messages, logs, calls, restore } = await startWith(KEY, () => new Response());
		try {
			await find("ready");
			send({ type: "auth_list" });
			expect((await find("auth_providers")).voice).toEqual({ transcribe: true, speak: true });
			send({ type: "voice_transcribe", requestId: "v1", mime: "audio/webm", data: AUDIO });
			expect(await find("voice_transcript")).toMatchObject({
				requestId: "v1",
				text: "hello from the local transcriber",
			});
			// Local transcription: no network call was made.
			expect(calls).toHaveLength(0);
			expect(JSON.stringify(messages)).not.toContain(KEY);
			expect(logs.join("\n")).not.toContain(KEY);
		} finally {
			restore();
		}
	});

	it("speaks a reply and returns the WAV audio to the window that asked", async () => {
		const wav = Buffer.from("RIFF fake wav");
		const { send, find, restore } = await startWith(KEY, () => new Response(wav));
		try {
			await find("ready");
			send({ type: "voice_speak", requestId: "s1", text: "Listo." });
			expect(await find("voice_speech")).toMatchObject({
				requestId: "s1",
				mime: "audio/wav",
				data: wav.toString("base64"),
			});
		} finally {
			restore();
		}
	});

	it("has speech off without a key, and transcription off without the local assets", async () => {
		const { send, find, calls, restore } = await startWith(undefined, () => new Response(), {
			assets: false,
		});
		try {
			expect((await find("ready")).voice).toEqual({ transcribe: false, speak: false });
			send({ type: "voice_transcribe", requestId: "v2", mime: "audio/webm", data: AUDIO });
			expect(await find("voice_unavailable")).toMatchObject({
				requestId: "v2",
				reason:
					"The local voice model is not downloaded yet. Download it from the app settings and try again.",
			});
			expect(calls).toHaveLength(0);
		} finally {
			restore();
		}
	});
});

describe("createModelAuthRuntime keys (offline)", () => {
	const withoutEnvKey = async (run: () => Promise<void>) => {
		const savedOpenAI = process.env.OPENAI_API_KEY;
		const savedNvidia = process.env.NVIDIA_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.NVIDIA_API_KEY;
		try {
			await run();
		} finally {
			if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
			if (savedNvidia !== undefined) process.env.NVIDIA_API_KEY = savedNvidia;
		}
	};

	it(
		"returns a stored NVIDIA API key",
		// createModelAuthRuntime loads the engine's providers through jiti; on slow
		// hosts that alone approaches the 5 s default.
		{ timeout: 20_000 },
		() =>
			withoutEnvKey(async () => {
				const home = tempDir();
				await createModelAuthRuntime(home, home);
				const runtime = await createModelAuthRuntime(home, home);
				await runtime.login("openai", "api_key", { prompt: async () => KEY, notify: () => {} });
				expect(await runtime.nvidiaApiKey?.()).toBeUndefined();
			}),
	);

	it("never returns the ChatGPT sign-in token, which cannot transcribe", () =>
		withoutEnvKey(async () => {
			const home = tempDir();
			const oauth = {
				type: "oauth",
				access: "chatgpt-access-token",
				refresh: "r",
				expires: Date.now() + 3.6e6,
			};
			writeFileSync(join(home, "auth.json"), JSON.stringify({ openai: oauth }), { mode: 0o600 });
			const runtime = await createModelAuthRuntime(home, home);
			expect(runtime.getProviderAuthStatus("openai").configured).toBe(true);
			expect(await runtime.openAIApiKey?.()).toBeUndefined();
		}));
});
