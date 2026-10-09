import { MAX_VOICE_AUDIO, MAX_VOICE_TEXT, type VoiceCapability } from "@gentle-dot/protocol";

export const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
export const SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const SPEECH_MODEL = "gpt-4o-mini-tts";
const SPEECH_VOICE = "alloy";
const TIMEOUT_MS = 60_000;

export type VoiceResult<T> = ({ ok: true } & T) | { ok: false; reason: string };

export interface VoiceServiceOptions {
	/** The connected OpenAI API key, read on each request; never a ChatGPT sign-in token. */
	apiKey: () => Promise<string | undefined>;
	fetch?: typeof fetch;
	log?: (line: string) => void;
	timeoutMs?: number;
}

const REASONS = {
	noKey: "Voice through the assistant needs an OpenAI API key. Connect one in Accounts.",
	tooLong: "That recording is too long. Keep it under a minute.",
	empty: "I didn't catch anything. Try again.",
	noText: "There is nothing to read aloud.",
	unauthorized: "OpenAI did not accept the API key. Check it in Accounts.",
	forbidden: "This OpenAI key is not allowed to use voice. Check its project and permissions.",
	limited: "OpenAI is limiting requests or the account is out of credit. Try again later.",
	failed: "OpenAI could not handle the voice request. Try again.",
	offline: "Could not reach OpenAI. Check the internet connection.",
} as const;

/** File extensions OpenAI recognizes, by audio type. */
const EXTENSIONS: Record<string, string> = {
	"audio/webm": "webm",
	"audio/ogg": "ogg",
	"audio/mp4": "mp4",
	"audio/m4a": "m4a",
	"audio/x-m4a": "m4a",
	"audio/aac": "m4a",
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/flac": "flac",
};

/**
 * Speech to text and text to speech with the user's OpenAI API key (S30.2).
 * The key stays here: it goes only into the `Authorization` header of requests
 * to OpenAI, and neither logs nor replies carry it or OpenAI's error bodies.
 */
export class VoiceService {
	private current: VoiceCapability = { transcribe: false, speak: false };
	private readonly options: VoiceServiceOptions;

	constructor(options: VoiceServiceOptions) {
		this.options = options;
	}

	/** The capability as last checked. */
	capability(): VoiceCapability {
		return this.current;
	}

	/** Checks whether a key is connected now. */
	async refresh(): Promise<VoiceCapability> {
		const on = (await this.key()) !== undefined;
		this.current = { transcribe: on, speak: on };
		return this.current;
	}

	async transcribe(mime: string, data: string): Promise<VoiceResult<{ text: string }>> {
		if (data.length > MAX_VOICE_AUDIO) return { ok: false, reason: REASONS.tooLong };
		const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
		const form = new FormData();
		form.append("model", TRANSCRIBE_MODEL);
		form.append("response_format", "json");
		form.append(
			"file",
			new File([Buffer.from(data, "base64")], `recording.${EXTENSIONS[type] ?? "webm"}`, { type }),
		);
		const response = await this.post("transcription", TRANSCRIBE_URL, form);
		if (!response.ok) return response;
		try {
			const { text } = (await response.value.json()) as { text?: unknown };
			const transcript = typeof text === "string" ? text.trim() : "";
			return transcript ? { ok: true, text: transcript } : { ok: false, reason: REASONS.empty };
		} catch {
			this.log("transcription answer was not readable");
			return { ok: false, reason: REASONS.failed };
		}
	}

	async speak(text: string): Promise<VoiceResult<{ mime: string; data: string }>> {
		if (text.trim() === "" || text.length > MAX_VOICE_TEXT) return { ok: false, reason: REASONS.noText };
		const body = JSON.stringify({
			model: SPEECH_MODEL,
			voice: SPEECH_VOICE,
			input: text,
			response_format: "mp3",
		});
		const response = await this.post("speech", SPEECH_URL, body, "application/json");
		if (!response.ok) return response;
		try {
			const audio = Buffer.from(await response.value.arrayBuffer());
			return { ok: true, mime: "audio/mpeg", data: audio.toString("base64") };
		} catch {
			this.log("speech answer was not readable");
			return { ok: false, reason: REASONS.failed };
		}
	}

	private async post(
		what: string,
		url: string,
		body: FormData | string,
		contentType?: string,
	): Promise<VoiceResult<{ value: Response }>> {
		const key = await this.key();
		if (!key) return { ok: false, reason: REASONS.noKey };
		const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
		if (contentType) headers["Content-Type"] = contentType;
		let response: Response;
		try {
			response = await (this.options.fetch ?? fetch)(url, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS),
			});
		} catch {
			// The error may quote the request; only the fact that it failed is logged.
			this.log(`${what} failed: OpenAI not reachable`);
			return { ok: false, reason: REASONS.offline };
		}
		if (response.ok) return { ok: true, value: response };
		this.log(`${what} failed: OpenAI answered ${response.status}`);
		await response.body?.cancel().catch(() => {});
		return { ok: false, reason: reasonFor(response.status) };
	}

	private async key(): Promise<string | undefined> {
		try {
			return (await this.options.apiKey()) || undefined;
		} catch {
			this.log("could not read the OpenAI key");
			return undefined;
		}
	}

	private log(line: string): void {
		this.options.log?.(`voice: ${line}`);
	}
}

function reasonFor(status: number): string {
	if (status === 401) return REASONS.unauthorized;
	if (status === 403) return REASONS.forbidden;
	if (status === 429) return REASONS.limited;
	return REASONS.failed;
}
