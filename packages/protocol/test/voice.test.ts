import { describe, expect, it } from "vitest";
import { MAX_VOICE_AUDIO, MAX_VOICE_TEXT, parseClientMessage } from "../src/index.ts";

const parse = (value: object) => parseClientMessage(JSON.stringify(value));
const AUDIO = Buffer.from("fake opus bytes").toString("base64");

describe("voice messages", () => {
	it("accepts a recording to transcribe: request id, audio type, and base64 data", () => {
		expect(
			parse({ type: "voice_transcribe", requestId: "v1", mime: "audio/webm;codecs=opus", data: AUDIO }),
		).toEqual({ type: "voice_transcribe", requestId: "v1", mime: "audio/webm;codecs=opus", data: AUDIO });
		expect(
			parse({ type: "voice_transcribe", requestId: "v2", mime: "audio/mp4", data: AUDIO, extra: 1 }),
		).toEqual({
			type: "voice_transcribe",
			requestId: "v2",
			mime: "audio/mp4",
			data: AUDIO,
		});
	});

	it("refuses recordings that are not audio, not base64, empty, or missing a request id", () => {
		expect(
			parse({ type: "voice_transcribe", requestId: "v", mime: "text/html", data: AUDIO }),
		).toBeUndefined();
		expect(
			parse({ type: "voice_transcribe", requestId: "v", mime: "audio/webm", data: "not base64!" }),
		).toBeUndefined();
		expect(parse({ type: "voice_transcribe", requestId: "v", mime: "audio/webm", data: "" })).toBeUndefined();
		expect(parse({ type: "voice_transcribe", mime: "audio/webm", data: AUDIO })).toBeUndefined();
		expect(
			parse({ type: "voice_transcribe", requestId: "x".repeat(201), mime: "audio/webm", data: AUDIO }),
		).toBeUndefined();
	});

	it("caps the recording so the whole frame stays under the 1 MiB WebSocket limit", () => {
		expect(MAX_VOICE_AUDIO).toBeLessThan(1024 * 1024 - 1024);
		const atCap = "A".repeat(MAX_VOICE_AUDIO);
		expect(parse({ type: "voice_transcribe", requestId: "v", mime: "audio/webm", data: atCap })?.type).toBe(
			"voice_transcribe",
		);
		expect(
			parse({ type: "voice_transcribe", requestId: "v", mime: "audio/webm", data: `${atCap}AAAA` }),
		).toBeUndefined();
	});

	it("accepts text to speak, up to the speech limit, and refuses empty or longer text", () => {
		expect(parse({ type: "voice_speak", requestId: "s1", text: "Hello there" })).toEqual({
			type: "voice_speak",
			requestId: "s1",
			text: "Hello there",
		});
		expect(parse({ type: "voice_speak", requestId: "s1", text: "   " })).toBeUndefined();
		expect(
			parse({ type: "voice_speak", requestId: "s1", text: "a".repeat(MAX_VOICE_TEXT + 1) }),
		).toBeUndefined();
		expect(parse({ type: "voice_speak", text: "hi" })).toBeUndefined();
	});
});
