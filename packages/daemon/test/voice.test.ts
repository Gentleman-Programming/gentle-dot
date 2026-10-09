import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_VOICE_AUDIO, MAX_VOICE_TEXT, type ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createModelAuthRuntime } from "../src/auth.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { SPEECH_URL, TRANSCRIBE_URL, VoiceService } from "../src/voice.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const KEY = "sk-voice-test-key-not-real-1234";
const AUDIO = Buffer.from("fake opus bytes").toString("base64");

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

/** `key: null` means no key is connected. */
function service(reply: (call: Call) => Response | Promise<Response>, key: string | null = KEY) {
	const logs: string[] = [];
	const fake = fakeFetch(reply);
	const voice = new VoiceService({
		apiKey: async () => key ?? undefined,
		fetch: fake.fetch,
		log: (line) => logs.push(line),
	});
	return { voice, logs, calls: fake.calls };
}

const header = (call: Call | undefined, name: string) => new Headers(call?.init.headers).get(name);

describe("VoiceService capability", () => {
	it("is off until an OpenAI API key is found, and on for both directions once it is", async () => {
		const { voice } = service(() => new Response());
		expect(voice.capability()).toEqual({ transcribe: false, speak: false });
		expect(await voice.refresh()).toEqual({ transcribe: true, speak: true });
		expect(voice.capability()).toEqual({ transcribe: true, speak: true });
	});

	it("stays off without a key, and when reading the key fails", async () => {
		expect(await service(() => new Response(), null).voice.refresh()).toEqual({
			transcribe: false,
			speak: false,
		});
		const failing = new VoiceService({
			apiKey: async () => {
				throw new Error("locked");
			},
			fetch: fakeFetch(() => new Response()).fetch,
		});
		expect(await failing.refresh()).toEqual({ transcribe: false, speak: false });
	});
});

describe("VoiceService.transcribe", () => {
	it("posts the recording as multipart to OpenAI with the transcribe model and the key in the header", async () => {
		const { voice, calls } = service(() => Response.json({ text: "hello from voice" }));
		expect(await voice.transcribe("audio/webm;codecs=opus", AUDIO)).toEqual({
			ok: true,
			text: "hello from voice",
		});
		const call = calls[0];
		expect(call?.url).toBe(TRANSCRIBE_URL);
		expect(TRANSCRIBE_URL).toBe("https://api.openai.com/v1/audio/transcriptions");
		expect(call?.init.method).toBe("POST");
		expect(header(call, "authorization")).toBe(`Bearer ${KEY}`);
		const body = call?.init.body as FormData;
		expect(body).toBeInstanceOf(FormData);
		expect(body.get("model")).toBe("gpt-4o-mini-transcribe");
		expect(body.get("response_format")).toBe("json");
		const file = body.get("file") as File;
		expect(file.name).toBe("recording.webm");
		expect(file.type).toBe("audio/webm");
		expect(Buffer.from(await file.arrayBuffer()).toString()).toBe("fake opus bytes");
	});

	it("names the file after the audio type so OpenAI can read it", async () => {
		const { voice, calls } = service(() => Response.json({ text: "ok" }));
		await voice.transcribe("audio/mp4", AUDIO);
		const body = calls[0]?.init.body as FormData;
		expect((body.get("file") as File).name).toBe("recording.mp4");
	});

	it("says nothing was heard when the transcript is empty", async () => {
		const { voice } = service(() => Response.json({ text: "  " }));
		expect(await voice.transcribe("audio/webm", AUDIO)).toEqual({
			ok: false,
			reason: "I didn't catch anything. Try again.",
		});
	});

	it("refuses a recording over the size cap without calling OpenAI", async () => {
		const { voice, calls } = service(() => Response.json({ text: "never" }));
		const result = await voice.transcribe("audio/webm", "A".repeat(MAX_VOICE_AUDIO + 4));
		expect(result).toEqual({ ok: false, reason: "That recording is too long. Keep it under a minute." });
		expect(calls).toHaveLength(0);
	});

	it("explains how to turn voice on when no API key is connected, without calling OpenAI", async () => {
		const { voice, calls } = service(() => Response.json({ text: "never" }), null);
		expect(await voice.transcribe("audio/webm", AUDIO)).toEqual({
			ok: false,
			reason: "Voice through the assistant needs an OpenAI API key. Connect one in Accounts.",
		});
		expect(calls).toHaveLength(0);
	});
});

describe("VoiceService.speak", () => {
	it("asks OpenAI for mp3 speech with the speech model and a default voice, and returns it in base64", async () => {
		const mp3 = Buffer.from("ID3 fake mp3");
		const { voice, calls } = service(() => new Response(mp3, { headers: { "content-type": "audio/mpeg" } }));
		expect(await voice.speak("Hi! Here is the answer.")).toEqual({
			ok: true,
			mime: "audio/mpeg",
			data: mp3.toString("base64"),
		});
		const call = calls[0];
		expect(call?.url).toBe(SPEECH_URL);
		expect(SPEECH_URL).toBe("https://api.openai.com/v1/audio/speech");
		expect(call?.init.method).toBe("POST");
		expect(header(call, "authorization")).toBe(`Bearer ${KEY}`);
		expect(header(call, "content-type")).toBe("application/json");
		expect(JSON.parse(String(call?.init.body))).toEqual({
			model: "gpt-4o-mini-tts",
			voice: "alloy",
			input: "Hi! Here is the answer.",
			response_format: "mp3",
		});
	});

	it("refuses empty text and text over the speech limit without calling OpenAI", async () => {
		const { voice, calls } = service(() => new Response("x"));
		expect((await voice.speak(" ")).ok).toBe(false);
		expect((await voice.speak("a".repeat(MAX_VOICE_TEXT + 1))).ok).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

describe("VoiceService errors", () => {
	const cases: [string, () => Response | Promise<Response>, string][] = [
		[
			"401",
			() => new Response(`{"error":{"message":"Incorrect API key provided: ${KEY}"}}`, { status: 401 }),
			"OpenAI did not accept the API key. Check it in Accounts.",
		],
		[
			"403",
			() => new Response(`{"error":"forbidden for ${KEY}"}`, { status: 403 }),
			"This OpenAI key is not allowed to use voice. Check its project and permissions.",
		],
		[
			"429",
			() => new Response(`{"error":"quota for ${KEY}"}`, { status: 429 }),
			"OpenAI is limiting requests or the account is out of credit. Try again later.",
		],
		[
			"500",
			() => new Response(`oops ${KEY}`, { status: 500 }),
			"OpenAI could not handle the voice request. Try again.",
		],
		[
			"network",
			() => Promise.reject(new TypeError(`fetch failed for ${KEY}`)),
			"Could not reach OpenAI. Check the internet connection.",
		],
	];

	for (const [name, reply, reason] of cases) {
		it(`maps ${name} to a readable reason and never shows or logs the key`, async () => {
			const { voice, logs } = service(reply);
			const results = [await voice.transcribe("audio/webm", AUDIO), await voice.speak("hello")];
			for (const result of results) expect(result).toEqual({ ok: false, reason });
			expect(JSON.stringify(results)).not.toContain(KEY);
			expect(logs.length).toBeGreaterThan(0);
			expect(logs.join("\n")).not.toContain(KEY);
		});
	}
});

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function startWith(apiKey: string | undefined, reply: (call: Call) => Response | Promise<Response>) {
	const auth = fakeAuthRuntime();
	auth.runtime.openAIApiKey = async () => apiKey;
	const fake = fakeFetch(reply);
	const logs: string[] = [];
	const dataDir = tempDir();
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
	return { messages, send, find, logs, calls: fake.calls };
}

describe("voice through the daemon", () => {
	it("reports voice in the accounts list and transcribes a recording with the key kept in the daemon", async () => {
		const { send, find, messages, logs, calls } = await startWith(KEY, () =>
			Response.json({ text: "what's on my calendar" }),
		);
		await find("ready");
		send({ type: "auth_list" });
		expect((await find("auth_providers")).voice).toEqual({ transcribe: true, speak: true });
		send({ type: "voice_transcribe", requestId: "v1", mime: "audio/webm", data: AUDIO });
		expect(await find("voice_transcript")).toMatchObject({ requestId: "v1", text: "what's on my calendar" });
		expect(header(calls[0], "authorization")).toBe(`Bearer ${KEY}`);
		expect(JSON.stringify(messages)).not.toContain(KEY);
		expect(logs.join("\n")).not.toContain(KEY);
	});

	it("speaks a reply and returns the audio to the window that asked", async () => {
		const { send, find } = await startWith(KEY, () => new Response(Buffer.from("mp3")));
		await find("ready");
		send({ type: "voice_speak", requestId: "s1", text: "Done." });
		expect(await find("voice_speech")).toMatchObject({
			requestId: "s1",
			mime: "audio/mpeg",
			data: Buffer.from("mp3").toString("base64"),
		});
	});

	it("has voice off with only a ChatGPT sign-in, and says why a request did not work", async () => {
		const { send, find, calls } = await startWith(undefined, () => Response.json({ text: "never" }));
		expect((await find("ready")).voice).toEqual({ transcribe: false, speak: false });
		send({ type: "voice_transcribe", requestId: "v2", mime: "audio/webm", data: AUDIO });
		expect(await find("voice_unavailable")).toMatchObject({
			requestId: "v2",
			reason: "Voice through the assistant needs an OpenAI API key. Connect one in Accounts.",
		});
		expect(calls).toHaveLength(0);
	});
});

describe("createModelAuthRuntime openAIApiKey (offline)", () => {
	const withoutEnvKey = async (run: () => Promise<void>) => {
		const saved = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			await run();
		} finally {
			if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
		}
	};

	it("returns a stored OpenAI API key", () =>
		withoutEnvKey(async () => {
			const home = tempDir();
			const runtime = await createModelAuthRuntime(home, home);
			await runtime.login("openai", "api_key", { prompt: async () => KEY, notify: () => {} });
			expect(await (await createModelAuthRuntime(home, home)).openAIApiKey?.()).toBe(KEY);
		}));

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
