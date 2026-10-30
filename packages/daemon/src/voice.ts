import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_VOICE_AUDIO, MAX_VOICE_TEXT, type VoiceCapability } from "@gentle-dot/protocol";

/**
 * Speech to text and text to speech (S30.2) without an OpenAI dependency:
 *
 * - Transcription runs **locally** through the voice-tools transcriber server
 *   (NVIDIA Parakeet TDT 0.6B v3 via sherpa-onnx-node), the same model the
 *   desktop mic button uses. The daemon spawns it once per process and keeps
 *   it alive so the model stays warm.
 * - Speech synthesis uses the hosted NVIDIA magpie-tts-multilingual endpoint
 *   with the user's NVIDIA API key.
 *
 * The key stays here: it goes only into the `Authorization` header of speech
 * requests to NVIDIA, and neither logs nor replies carry it or NVIDIA's error
 * bodies. Local transcription never leaves the machine.
 */

export const DEFAULT_SPEECH_URL =
	"https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize";
export const SPEECH_URL = process.env.GENTLE_DOT_SPEECH_URL || DEFAULT_SPEECH_URL;
const SPEECH_LANGUAGE = process.env.GENTLE_DOT_SPEECH_LANGUAGE || "es-US";
const SPEECH_VOICE = process.env.GENTLE_DOT_SPEECH_VOICE || "Magpie-Multilingual.ES-US.Isabela";
const TRANSCRIBE_TIMEOUT_MS = 45_000;
const SPEECH_TIMEOUT_MS = 60_000;
/** Installs sherpa-onnx-node into the data dir's voice-tools with npm (default installDeps). */
function npmInstallDeps(voiceToolsDir: string): Promise<void> {
	const npm = process.env.GENTLE_DOT_NPM || "npm";
	return new Promise((resolve, reject) => {
		const child = spawn(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], {
			cwd: voiceToolsDir,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("npm install timed out"));
		}, 300_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`voice: npm install failed (${code}): ${stderr.trim().split("\n").pop() ?? ""}`));
		});
	});
}

/**
 * Returns the voice-tools asset source directory, checking in order:
 * 1. GENTLE_DOT_VOICE_TOOLS_PATH (explicit override)
 * 2. GENTLE_DOT_VOICE_TOOLS_SOURCE (test override)
 * 3. Relative to this module: ../../voice-tools (source) or ../voice-tools (packaged)
 */
function voiceToolsSource(): string | undefined {
	if (process.env.GENTLE_DOT_VOICE_TOOLS_PATH) return process.env.GENTLE_DOT_VOICE_TOOLS_PATH;
	if (process.env.GENTLE_DOT_VOICE_TOOLS_SOURCE) return process.env.GENTLE_DOT_VOICE_TOOLS_SOURCE;
	const here = fileURLToPath(import.meta.url);
	for (const relative of ["../../voice-tools", "../voice-tools"]) {
		const candidate = join(here, "..", relative);
		if (existsSync(join(candidate, "transcriber.js"))) return candidate;
	}
	return undefined;
}

export type VoiceResult<T> = ({ ok: true } & T) | { ok: false; reason: string };

export interface VoiceServiceOptions {
	/** The connected NVIDIA API key, read on each request; speech synthesis only. */
	apiKey: () => Promise<string | undefined>;
	/** The daemon data dir; the local transcriber lives under `voice-tools/`. */
	dataDir: string;
	/**
	 * Installs the transcriber's npm dependency into `<dataDir>/voice-tools`.
	 * Defaults to `npm install`; tests inject a fake.
	 */
	installDeps?: () => Promise<void>;
	/** How often provisioning logs "still installing" progress. Default 15s. */
	progressIntervalMs?: number;
	fetch?: typeof fetch;
	log?: (line: string) => void;
	timeoutMs?: number;
}

const REASONS = {
	noTranscriber:
		"The local transcription server is not installed yet. It installs itself the next time a voice note arrives; try again in a minute.",
	noModel: "The local voice model is not downloaded yet. Download it from the app settings and try again.",
	noKey: "Voice replies need an NVIDIA API key. Connect one in Accounts.",
	tooLong: "That recording is too long. Keep it under a minute.",
	empty: "I didn't catch anything. Try again.",
	noText: "There is nothing to read aloud.",
	unauthorized: "NVIDIA did not accept the API key. Check it in Accounts.",
	forbidden: "This NVIDIA key is not allowed to use speech. Check its project and permissions.",
	limited: "NVIDIA is limiting requests or the account is out of credit. Try again later.",
	failed: "NVIDIA could not handle the voice request. Try again.",
	offline: "Could not reach NVIDIA. Check the internet connection.",
	transcribeFailed: "The local transcription did not answer. Try again.",
} as const;

/** File extensions the transcriber accepts, by audio type (ffmpeg converts). */
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

/** What the local transcription needs, versus what is in place. */
export interface TranscriberAvailability {
	script: boolean;
	model: boolean;
}

/**
 * The local transcriber as a persistent child process. Requests are
 * serialized over line-delimited JSON on stdio; the model loads once and
 * stays warm. If the child dies mid-request it is respawned on the next
 * call, so a cold start costs one extra load.
 */
class TranscriberServer {
	private child?: ChildProcess;
	private stdoutBuffer = "";
	private current?: {
		resolve: (text: string) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	};
	private waiters: Array<() => void> = [];
	private readonly dir: string;
	private readonly script: string;
	private readonly model: string;
	private readonly log?: (line: string) => void;
	private readonly installDeps: () => Promise<void>;
	private readonly progressIntervalMs: number;
	private provisioning?: Promise<void>;

	constructor(
		dataDir: string,
		log?: (line: string) => void,
		installDeps?: () => Promise<void>,
		progressIntervalMs?: number,
	) {
		this.dir = join(dataDir, "voice-tools");
		this.script = join(this.dir, "transcriber.js");
		this.model =
			process.env.GENTLE_DOT_VOICE_MODEL ||
			join(
				process.env.HOME || tmpdir(),
				".local/share/dev.gentleman.gentle-dot/models/parakeet-tdt-0.6b-v3-int8",
			);
		this.log = log;
		this.installDeps = installDeps ?? (() => npmInstallDeps(this.dir));
		this.progressIntervalMs = progressIntervalMs ?? 15_000;
	}

	/**
	 * Installs the transcriber under `<dataDir>/voice-tools` (script, package.json,
	 * then npm install of sherpa-onnx-node) the first time it is needed. Serialized:
	 * concurrent callers share one attempt, and a failed attempt can be retried later.
	 */
	provision(): Promise<void> {
		// A script left in place counts as installed (it may predate this feature); a
		// failed install deletes it so a later voice note retries from scratch.
		if (existsSync(this.script)) return Promise.resolve();
		this.provisioning ??= (async () => {
			const source = voiceToolsSource();
			if (!source) {
				throw new Error("voice: the voice-tools assets are not bundled with this install");
			}
			this.log?.("voice: installing the local transcriber");
			const startedAt = Date.now();
			const progress = setInterval(() => {
				this.log?.(
					`voice: still installing the local transcriber (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`,
				);
			}, this.progressIntervalMs);
			try {
				await mkdir(this.dir, { recursive: true });
				await copyFile(join(source, "transcriber.js"), this.script);
				await copyFile(join(source, "package.json"), join(this.dir, "package.json"));
				await this.installDeps();
				this.log?.("voice: local transcriber installed");
			} catch (error) {
				await rm(this.script, { force: true });
				throw error;
			} finally {
				clearInterval(progress);
			}
		})().finally(() => {
			// Keep the in-flight promise while it settles; a settled failure allows a retry.
			this.provisioning = undefined;
		});
		return this.provisioning;
	}

	availability(): TranscriberAvailability {
		return {
			script: existsSync(this.script),
			model: existsSync(join(this.model, "encoder.int8.onnx")) && existsSync(join(this.model, "tokens.txt")),
		};
	}

	available(): boolean {
		const { script, model } = this.availability();
		return script && model;
	}

	async transcribe(file: string): Promise<string> {
		await this.ensureChild();
		return this.request(file);
	}

	private request(file: string): Promise<string> {
		if (this.current) {
			// One note at a time; everyone else waits for the current answer.
			return new Promise<void>((resolve) => this.waiters.push(resolve)).then(() => this.request(file));
		}
		return new Promise<string>((resolve, reject) => {
			const child = this.child;
			if (!child?.stdin || !child.stdout) {
				reject(new Error("transcriber is not running"));
				return;
			}
			const timer = setTimeout(() => {
				this.fail(new Error("transcription timed out"));
			}, TRANSCRIBE_TIMEOUT_MS);
			this.current = { resolve, reject, timer };
			child.stdin.write(`${JSON.stringify({ file })}\n`);
		});
	}

	private answer(text: string): void {
		if (!this.current) return;
		const { resolve, timer } = this.current;
		clearTimeout(timer);
		this.current = undefined;
		resolve(text);
		this.wake();
	}

	private fail(error: Error): void {
		if (!this.current) return;
		const { reject, timer } = this.current;
		clearTimeout(timer);
		this.current = undefined;
		reject(error);
		this.wake();
	}

	private wake(): void {
		const next = this.waiters.shift();
		if (next) next();
	}

	private ensureChild(): Promise<void> {
		if (this.child?.stdin && !this.child.killed) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let settled = false;
			const child = spawn(process.execPath, [this.script], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;
			this.stdoutBuffer = "";
			child.on("error", (error) => {
				this.child = undefined;
				if (!settled) {
					settled = true;
					reject(error);
				}
			});
			child.on("exit", () => {
				this.child = undefined;
				this.fail(new Error("transcriber exited"));
				if (!settled) {
					settled = true;
					reject(new Error("transcriber failed to start"));
				}
			});
			child.stdout?.setEncoding("utf8");
			child.stdout.on("data", (chunk) => {
				this.stdoutBuffer += chunk;
				for (
					let index = this.stdoutBuffer.indexOf("\n");
					index !== -1;
					index = this.stdoutBuffer.indexOf("\n")
				) {
					const line = this.stdoutBuffer.slice(0, index).trim();
					this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
					if (!line) continue;
					try {
						const parsed = JSON.parse(line) as { text?: string; error?: string };
						if (parsed.error) this.fail(new Error(String(parsed.error)));
						else this.answer(String(parsed.text ?? ""));
					} catch {
						this.log?.("voice: unreadable transcriber answer");
					}
				}
			});
			child.stderr?.setEncoding("utf8");
			child.stderr.on("data", (line) => {
				if (String(line).includes("transcriber: ready") && !settled) {
					settled = true;
					resolve();
				}
			});
		});
	}

	stop(): void {
		this.child?.kill();
		this.child = undefined;
	}
}

export class VoiceService {
	private current: VoiceCapability = { transcribe: false, speak: false };
	private readonly options: VoiceServiceOptions;
	private readonly transcriber: TranscriberServer;

	constructor(options: VoiceServiceOptions) {
		this.options = options;
		this.transcriber = new TranscriberServer(
			options.dataDir,
			options.log,
			options.installDeps,
			options.progressIntervalMs,
		);
		// When the desktop app already downloaded the local model, provision the
		// transcriber in the background so voice notes work without any setup.
		if (this.transcriber.availability().model && !this.transcriber.availability().script) {
			this.transcriber.provision().catch((error: Error) => {
				options.log?.(`voice: could not install the local transcriber: ${error.message}`);
			});
		}
	}

	/** The capability as last checked. */
	capability(): VoiceCapability {
		return this.current;
	}

	/** Checks what voice can do now: local transcription assets, and the key for speech. */
	async refresh(): Promise<VoiceCapability> {
		const speak = (await this.key()) !== undefined;
		this.current = { transcribe: this.transcriber.available(), speak };
		return this.current;
	}

	async transcribe(mime: string, data: string): Promise<VoiceResult<{ text: string }>> {
		if (data.length > MAX_VOICE_AUDIO) return { ok: false, reason: REASONS.tooLong };
		let availability = this.transcriber.availability();
		if (!availability.model) return { ok: false, reason: REASONS.noModel };
		if (!availability.script) {
			// The model is here but the transcriber is not: install it and answer this note.
			try {
				await this.transcriber.provision();
				availability = this.transcriber.availability();
			} catch {
				return { ok: false, reason: REASONS.noTranscriber };
			}
		}
		if (!availability.script) return { ok: false, reason: REASONS.noTranscriber };
		const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
		const extension = EXTENSIONS[type] ?? "webm";
		const directory = join(tmpdir(), "dot-voice");
		await mkdir(directory, { recursive: true });
		const file = join(directory, `note-${process.pid}-${Date.now()}.${extension}`);
		try {
			await writeFile(file, Buffer.from(data, "base64"));
			const text = await this.transcriber.transcribe(file);
			const transcript = text.trim();
			return transcript ? { ok: true, text: transcript } : { ok: false, reason: REASONS.empty };
		} catch {
			this.log("transcription failed: local transcriber");
			return { ok: false, reason: REASONS.transcribeFailed };
		} finally {
			rm(file, { force: true }).catch(() => {});
		}
	}

	async speak(text: string): Promise<VoiceResult<{ mime: string; data: string }>> {
		if (text.trim() === "" || text.length > MAX_VOICE_TEXT) return { ok: false, reason: REASONS.noText };
		const form = new FormData();
		form.append("text", text);
		form.append("language", SPEECH_LANGUAGE);
		form.append("voice", SPEECH_VOICE);
		const response = await this.post("speech", SPEECH_URL, form);
		if (!response.ok) return response;
		try {
			const audio = Buffer.from(await response.value.arrayBuffer());
			return { ok: true, mime: "audio/wav", data: audio.toString("base64") };
		} catch {
			this.log("speech answer was not readable");
			return { ok: false, reason: REASONS.failed };
		}
	}

	private async post(what: string, url: string, body: FormData): Promise<VoiceResult<{ value: Response }>> {
		const key = await this.key();
		if (!key) return { ok: false, reason: REASONS.noKey };
		const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
		let response: Response;
		try {
			response = await (this.options.fetch ?? fetch)(url, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(this.options.timeoutMs ?? SPEECH_TIMEOUT_MS),
			});
		} catch {
			this.log(`${what} failed: NVIDIA not reachable`);
			return { ok: false, reason: REASONS.offline };
		}
		if (response.ok) return { ok: true, value: response };
		this.log(`${what} failed: NVIDIA answered ${response.status}`);
		await response.body?.cancel().catch(() => {});
		return { ok: false, reason: reasonFor(response.status) };
	}

	private async key(): Promise<string | undefined> {
		try {
			return (await this.options.apiKey()) || undefined;
		} catch {
			this.log("could not read the NVIDIA key");
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
