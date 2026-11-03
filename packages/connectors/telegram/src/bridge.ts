import { type Bot, type Context, InlineKeyboard } from "grammy";
import {
	type AgentState,
	type Ask,
	type AttachmentRef,
	type ClientMessage,
	MAX_VOICE_AUDIO,
	type ServerMessage,
	type UploadedFile,
} from "./protocol.js";
import { UploadRefused } from "./uploads.js";

/** Telegram's longest text message. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** Telegram keeps a draft for 30 s; refresh it well before that. */
const DRAFT_REFRESH_MS = 20_000;

const BUSY_STATES: AgentState[] = ["thinking", "working", "needs_you"];

/** Daemon errors that refuse a `send` (gentle-dot `bridge.ts` run/dispatch); others leave the turn open. */
const SEND_REFUSALS = new Set(["no_account", "agent_unavailable", "command_failed", "unsupported"]);

/** The largest file the Bot API lets a bot download. */
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

/** Telegram allows 100 inline buttons; one is Cancel. */
const MAX_CHOICES = 99;

const UNREACHABLE = "Gentle Dot is not reachable right now. Is it running?";

/** Every message relayed to the daemon is tagged with this so the assistant always knows its origin. */
const SOURCE_LABEL = "🌹 [Rosita · Telegram] ";

/** One-tap actions: each button sends a ready-made prompt to the assistant (the intelligence stays agent-side). */
const MENU_ACTIONS: Record<string, string> = {
	"📊 Estado del sistema":
		"Run a quick health check of my ecosystem: the daemon, Syncthing, and the Rosita bridge service, then reply with a compact one-screen status report in Spanish.",
	"🗂️ Bóveda: resumen":
		"Give me a compact summary of my Obsidian vault at /run/media/bladimir/Datos/Datos/.obs/belzebuth: total notes, its main folders, and the 3 most recently modified notes. Reply briefly in Spanish.",
	"📝 Nota rápida":
		"Quick note mode: my NEXT message is the note content. When it arrives, create a note in the vault's 00-Bandeja folder (frontmatter: tipo: nota, fecha: today) using the first 6-8 words as the filename, then confirm briefly in Spanish. If my next message is not note content, treat it as a normal conversation instead.",
	"🔍 Buscar en bóveda":
		"Vault search mode: my NEXT message is a search query. Search it across the notes of my Obsidian vault and reply in Spanish with the matching notes and a snippet of each match. If my next message is not a search, treat it normally.",
	"📋 Pendientes":
		"Summarize my current pending items from our recent work together (check your task list and memory) as a short checklist in Spanish.",
};

/** The persistent reply keyboard that makes the actions one tap away. */
const MENU_KEYBOARD = {
	keyboard: [
		[{ text: "📊 Estado del sistema" }, { text: "🗂️ Bóveda: resumen" }],
		[{ text: "📝 Nota rápida" }, { text: "🔍 Buscar en bóveda" }],
		[{ text: "📋 Pendientes" }],
	],
	resize_keyboard: true,
	is_persistent: true,
};

const HELP = [
	"Soy Rosita — tu puente directo a Gentle Dot, tu asistente.",
	"",
	"Escribime lo que quieras, mandame una nota de voz, un archivo, foto, video o audio (hasta 20 MB); el caption va como tu mensaje.",
	"/menu vuelve a mostrar el teclado de acciones. /stop detiene la tarea en curso; el botón de stop en el estado en vivo hace lo mismo.",
	"Las acciones que envían o cambian algo en tus cuentas se aprueban en la app de escritorio de Gentle Dot.",
].join("\n");

export interface DaemonConnection {
	/** False when the message could not be sent (no connection). */
	send(message: ClientMessage): boolean;
}

export interface BridgeOptions {
	bot: Bot;
	daemon: DaemonConnection;
	allowedUsers: Set<number>;
	log(message: string): void;
	draftRefreshMs?: number;
	/** Downloads a Telegram file by its `file_path`; the default uses the Bot API file endpoint. */
	download?(filePath: string): Promise<Buffer>;
	/** Uploads a file to the daemon (`POST /upload`); without it, files are refused. */
	upload?(file: Upload): Promise<UploadedFile>;
}

/** A file on its way to the daemon. */
export interface Upload {
	name: string;
	data: Buffer;
	uploadId?: string;
}

/** A file in a Telegram message, as the bridge passes it on. */
interface IncomingFile {
	fileId: string;
	name: string;
	size?: number;
}

/** Extensions for audio sent without a file name, by MIME type. */
const AUDIO_EXTENSIONS: Record<string, string> = {
	"audio/mpeg": "mp3",
	"audio/mp4": "m4a",
	"audio/ogg": "ogg",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/flac": "flac",
};

/** An ask shown in Telegram and not answered yet. */
interface PendingAsk {
	ask: Ask;
	chatId: number;
	/** The message carrying its buttons, when it has any. */
	messageId?: number;
}

/** `head` then `suffix` in one Telegram message, shortening `head` with "…" when needed. */
function fitMessage(head: string, suffix: string): string {
	if (head.length + suffix.length <= TELEGRAM_TEXT_LIMIT) return head + suffix;
	return `${head.slice(0, TELEGRAM_TEXT_LIMIT - suffix.length - 1)}…${suffix}`;
}

interface Turn {
	chatId: number;
	draftId: number;
	draftText: string;
	/** The assistant was seen busy since this turn started, so the next idle ends it. */
	sawBusy: boolean;
	refresh: NodeJS.Timeout;
}

/** Relays one private Telegram chat to the Gentle Dot daemon and back. */
export class Bridge {
	private readonly options: BridgeOptions;
	private readonly bot: Bot;
	/** Where daemon events go: the allowed chat that wrote last. */
	private chatId: number;
	private turn: Turn | undefined;
	/** Asks by a short key, since Telegram's callback data holds at most 64 bytes. */
	private readonly asks = new Map<number, PendingAsk>();
	private nextAskKey = 1;
	/** The input or editor ask the next text message answers. */
	private awaitingInput: number | undefined;
	private agentState: AgentState = "idle";
	/** The daemon can transcribe voice notes (local Parakeet transcription). */
	private canTranscribe = false;
	/** Transcriptions this bridge asked for, by request id, with the chat they came from. */
	private readonly transcriptions = new Map<string, number>();
	private nextVoiceId = 1;

	constructor(options: BridgeOptions) {
		this.options = options;
		this.bot = options.bot;
		this.chatId = [...options.allowedUsers][0] ?? 0;
		this.bot.use((ctx, next) => (this.allowed(ctx) ? next() : undefined));
		this.bot.command(["start", "help"], (ctx) => this.showMenu(ctx.chat!.id, HELP));
		this.bot.command("menu", (ctx) => this.showMenu(ctx.chat!.id, "Tu menú de acciones:"));
		this.bot.command("stop", (ctx) => this.stop(ctx.chat!.id));
		this.bot.command("cancel", (ctx) => this.cancelInput(ctx.chat!.id));
		this.bot.callbackQuery(/^a:(\d+):(y|n|c|\d+)$/, (ctx) =>
			this.onButton(ctx, Number(ctx.match![1]), String(ctx.match![2])),
		);
		this.bot.on("message:text", (ctx) => this.onText(ctx.chat!.id, ctx.message!.text));
		this.bot.on("message:voice", (ctx) => this.onVoice(ctx.chat!.id, ctx.message!.voice.file_id));
		this.bot.on("message:document", (ctx) => {
			const { document } = ctx.message!;
			const name = document.file_name || `file-${document.file_unique_id}`;
			return this.onFile(ctx.chat!.id, { fileId: document.file_id, name, size: document.file_size }, ctx.message!.caption);
		});
		this.bot.on("message:photo", (ctx) => {
			const photo = ctx.message!.photo.at(-1);
			if (!photo) return;
			const name = `photo-${photo.file_unique_id}.jpg`;
			return this.onFile(ctx.chat!.id, { fileId: photo.file_id, name, size: photo.file_size }, ctx.message!.caption);
		});
		this.bot.on("message:video", (ctx) => {
			const { video } = ctx.message!;
			const name = video.file_name || `video-${video.file_unique_id}.mp4`;
			return this.onFile(ctx.chat!.id, { fileId: video.file_id, name, size: video.file_size }, ctx.message!.caption);
		});
		this.bot.on("message:audio", (ctx) => {
			const { audio } = ctx.message!;
			const extension = AUDIO_EXTENSIONS[audio.mime_type ?? ""] ?? "audio";
			const name = audio.file_name || `audio-${audio.file_unique_id}.${extension}`;
			return this.onFile(ctx.chat!.id, { fileId: audio.file_id, name, size: audio.file_size }, ctx.message!.caption);
		});
		this.bot.on("stopped_message_generation", (ctx) => {
			const stopped = ctx.update.stopped_message_generation;
			if (stopped && this.turn?.draftId === stopped.draft_id) this.options.daemon.send({ type: "abort" });
		});
		this.bot.catch((error) => this.options.log(`telegram update failed: ${(error.error as Error).message}`));
	}

	/** Handles one daemon message; resolves once its Telegram calls are done. */
	async handleDaemon(message: ServerMessage): Promise<void> {
		try {
			await this.dispatch(message);
		} catch (error) {
			this.options.log(`ignored a daemon message (${message.type}): ${(error as Error).message}`);
		}
	}

	private async dispatch(message: ServerMessage): Promise<void> {
		const turn = this.turn;
		switch (message.type) {
			case "ready":
				this.agentState = message.agentState;
				this.canTranscribe = message.voice?.transcribe ?? false;
				return;
			case "auth_providers":
				if (message.voice) this.canTranscribe = message.voice.transcribe;
				return;
			case "voice_transcript": {
				const chatId = this.takeTranscription(message.requestId!);
				if (chatId === undefined) return;
				const text = message.text!.trim();
				if (text === "") {
					await this.reply(chatId, "I could not hear anything in that voice note.");
					return;
				}
				await this.reply(chatId, `🎙️ ${text}`);
				await this.onText(chatId, text);
				return;
			}
			case "voice_unavailable": {
				const chatId = this.takeTranscription(message.requestId!);
				if (chatId !== undefined) await this.reply(chatId, message.reason!);
				return;
			}
			case "agent_state":
				this.agentState = message.state;
				if (!turn) return;
				if (BUSY_STATES.includes(message.state)) {
					turn.sawBusy = true;
				} else if (turn.sawBusy && (message.state === "idle" || message.state === "error")) {
					this.endTurn();
				}
				return;
			case "activity":
				if (!turn || message.activity?.status !== "running") return;
				turn.draftText = `${message.activity.title}…`;
				await this.draft(turn);
				return;
			case "message_done": {
				if (!turn) return;
				const text = message.error ?? message.text!;
				if (text.trim() === "") {
					if (message.stopped) await this.reply(turn.chatId, "Stopped.");
					return;
				}
				for (const chunk of splitMessage(text)) await this.reply(turn.chatId, chunk);
				return;
			}
			case "toast":
				if (turn && message.level !== "info") await this.reply(turn.chatId, `⚠️ ${message.message}`);
				return;
			case "error":
				if (!turn) return;
				if (SEND_REFUSALS.has(message.code!) && !BUSY_STATES.includes(this.agentState)) this.endTurn();
				await this.reply(turn.chatId, `⚠️ ${message.message}`);
				return;
			case "ask":
				await this.showAsk(message.ask!);
				return;
			case "ask_resolved":
				await this.resolveAsk(message.requestId!);
				return;
			default:
				return;
		}
	}

	/** The daemon connection dropped: a Telegram turn cannot finish, so it ends here. */
	async connectionLost(): Promise<void> {
		const stale = [...this.asks.values()];
		this.asks.clear();
		this.awaitingInput = undefined;
		this.transcriptions.clear();
		const turn = this.turn;
		this.endTurn();
		for (const pending of stale) await this.removeButtons(pending);
		if (!turn) return;
		await this.reply(
			turn.chatId,
			"Lost the connection to Gentle Dot. It will reconnect on its own; send your message again then.",
		);
	}

	private allowed(ctx: Context): boolean {
		const chat = ctx.chat;
		if (chat?.type !== "private" || !this.options.allowedUsers.has(chat.id)) return false;
		if (ctx.from && !this.options.allowedUsers.has(ctx.from.id)) return false;
		this.chatId = chat.id;
		return true;
	}

	private async onText(chatId: number, text: string): Promise<void> {
		if (text.trimStart().startsWith("/")) {
			await this.reply(chatId, "That command is not supported here.");
			return;
		}
		const menuPrompt = MENU_ACTIONS[text];
		if (menuPrompt) {
			await this.sendToAssistant(chatId, menuPrompt);
			return;
		}
		const key = this.awaitingInput;
		const pending = key === undefined ? undefined : this.asks.get(key);
		if (key !== undefined && pending) {
			if (!this.options.daemon.send({ type: "ui_response", requestId: pending.ask.requestId, value: text })) {
				await this.reply(chatId, UNREACHABLE);
				return;
			}
			this.forgetAsk(key);
			return;
		}
		await this.sendToAssistant(chatId, text);
	}

	private async onVoice(chatId: number, fileId: string): Promise<void> {
		if (!this.canTranscribe) {
			await this.reply(chatId, "Voice transcription is unavailable right now; please write instead.");
			return;
		}
		let audio: Buffer;
		try {
			const file = await this.bot.api.getFile(fileId);
			if (!file.file_path) throw new Error("no file path");
			const download = this.options.download ?? telegramDownloader(this.bot.token);
			audio = await download(file.file_path);
		} catch (error) {
			this.options.log(`voice download failed: ${(error as Error).message}`);
			await this.reply(chatId, "I could not download that voice note. Try again.");
			return;
		}
		const data = audio.toString("base64");
		if (data.length > MAX_VOICE_AUDIO) {
			await this.reply(chatId, "That voice note is too long; keep it under about a minute.");
			return;
		}
		const requestId = `telegram-voice-${this.nextVoiceId++}`;
		if (!this.options.daemon.send({ type: "voice_transcribe", requestId, mime: "audio/ogg", data })) {
			await this.reply(chatId, UNREACHABLE);
			return;
		}
		this.transcriptions.set(requestId, chatId);
	}

	/** Downloads a file from Telegram, uploads it to the daemon and sends it with its caption. */
	private async onFile(chatId: number, file: IncomingFile, caption = ""): Promise<void> {
		const upload = this.options.upload;
		if (!upload) {
			await this.reply(chatId, "Files are not supported here.");
			return;
		}
		if (this.awaitingInput !== undefined && this.asks.has(this.awaitingInput)) {
			await this.reply(chatId, "Answer the question with a text message, or /cancel.");
			return;
		}
		if (file.size !== undefined && file.size > TELEGRAM_DOWNLOAD_LIMIT) {
			await this.reply(chatId, "That file is too big: Telegram lets bots download files up to 20 MB.");
			return;
		}
		let data: Buffer;
		try {
			const remote = await this.bot.api.getFile(file.fileId);
			if (!remote.file_path) throw new Error("no file path");
			const download = this.options.download ?? telegramDownloader(this.bot.token, { timeoutMs: 120_000 });
			data = await download(remote.file_path);
		} catch (error) {
			this.options.log(`file download failed: ${(error as Error).message}`);
			await this.reply(chatId, "I could not download that file. Try again.");
			return;
		}
		let stored: UploadedFile;
		try {
			stored = await upload({ name: file.name, data });
		} catch (error) {
			if (error instanceof UploadRefused) {
				await this.reply(chatId, `⚠️ ${error.message}`);
				return;
			}
			this.options.log(`file upload failed: ${(error as Error).message}`);
			await this.reply(chatId, UNREACHABLE);
			return;
		}
		await this.sendToAssistant(chatId, caption, [{ uploadId: stored.uploadId, name: stored.name }]);
	}

	private takeTranscription(requestId: string): number | undefined {
		const chatId = this.transcriptions.get(requestId);
		this.transcriptions.delete(requestId);
		return chatId;
	}

	private async showAsk(ask: Ask): Promise<void> {
		if (typeof ask?.requestId !== "string" || typeof ask.title !== "string") throw new Error("malformed ask");
		for (const pending of this.asks.values()) if (pending.ask.requestId === ask.requestId) return;
		const chatId = this.turn?.chatId ?? this.chatId;
		const head = ask.message ? `${ask.title}\n\n${ask.message}` : ask.title;
		if (ask.method === "app") {
			await this.reply(chatId, fitMessage(head, "\n\nApprove this in the Gentle Dot desktop app."));
			return;
		}
		if (ask.method === "pin") {
			await this.reply(
				chatId,
				fitMessage(head, "\n\nPIN approvals are not supported from Telegram. Use the Gentle Dot web page."),
			);
			return;
		}
		const options = ask.options ?? [];
		if (!Array.isArray(options) || !options.every((option) => typeof option === "string")) {
			throw new Error("malformed ask options");
		}
		if (options.length > MAX_CHOICES) {
			await this.reply(
				chatId,
				fitMessage(head, "\n\nToo many choices for Telegram; answer it in the Gentle Dot app or web page."),
			);
			return;
		}
		const key = this.nextAskKey++;
		const pending: PendingAsk = { ask, chatId };
		if (ask.method === "input" || ask.method === "editor") {
			const replaced = this.awaitingInput === undefined ? undefined : this.asks.get(this.awaitingInput);
			if (this.awaitingInput !== undefined) this.forgetAsk(this.awaitingInput);
			if (replaced) {
				this.options.daemon.send({ type: "ui_response", requestId: replaced.ask.requestId, cancelled: true });
			}
			if (await this.show(chatId, fitMessage(head, "\n\nReply with your answer, or /cancel."))) {
				this.asks.set(key, pending);
				this.awaitingInput = key;
			}
			return;
		}
		const keyboard = new InlineKeyboard();
		if (ask.method === "confirm") {
			keyboard.text("Allow", `a:${key}:y`).text("Decline", `a:${key}:n`);
		} else {
			options.forEach((option, index) => keyboard.text(option, `a:${key}:${index}`).row());
			keyboard.text("Cancel", `a:${key}:c`);
		}
		const messageId = await this.show(chatId, fitMessage(head, ""), keyboard);
		if (messageId === undefined) return;
		pending.messageId = messageId;
		this.asks.set(key, pending);
	}

	/** Sends a question; its message id, or undefined when Telegram refused it. */
	private async show(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<number | undefined> {
		try {
			const sent = await this.bot.api.sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : {});
			return sent.message_id;
		} catch (error) {
			this.options.log(`showing a question failed: ${(error as Error).message}`);
			return undefined;
		}
	}

	private async onButton(ctx: Context, key: number, choice: string): Promise<void> {
		const pending = this.asks.get(key);
		if (!pending) {
			await this.answerButton(ctx, "This request is no longer pending.");
			return;
		}
		const { requestId, options } = pending.ask;
		let answer: ClientMessage;
		if (choice === "y" || choice === "n") answer = { type: "ui_response", requestId, confirmed: choice === "y" };
		else if (choice === "c") answer = { type: "ui_response", requestId, cancelled: true };
		else {
			const value = options?.[Number(choice)];
			if (value === undefined) {
				await this.answerButton(ctx, "This request is no longer pending.");
				return;
			}
			answer = { type: "ui_response", requestId, value };
		}
		if (!this.options.daemon.send(answer)) {
			await this.answerButton(ctx, UNREACHABLE);
			return;
		}
		await this.answerButton(ctx);
		await this.removeButtons(pending);
		this.forgetAsk(key);
	}

	private async cancelInput(chatId: number): Promise<void> {
		const key = this.awaitingInput;
		const pending = key === undefined ? undefined : this.asks.get(key);
		if (key === undefined || !pending) {
			await this.reply(chatId, "Nothing to cancel.");
			return;
		}
		if (!this.options.daemon.send({ type: "ui_response", requestId: pending.ask.requestId, cancelled: true })) {
			await this.reply(chatId, UNREACHABLE);
			return;
		}
		this.forgetAsk(key);
	}

	private async resolveAsk(requestId: string): Promise<void> {
		for (const [key, pending] of this.asks) {
			if (pending.ask.requestId !== requestId) continue;
			this.forgetAsk(key);
			await this.removeButtons(pending);
		}
	}

	private forgetAsk(key: number): void {
		this.asks.delete(key);
		if (this.awaitingInput === key) this.awaitingInput = undefined;
	}

	private async removeButtons(pending: PendingAsk): Promise<void> {
		if (pending.messageId === undefined) return;
		try {
			await this.bot.api.editMessageReplyMarkup(pending.chatId, pending.messageId);
		} catch (error) {
			this.options.log(`removing buttons failed: ${(error as Error).message}`);
		}
	}

	private async answerButton(ctx: Context, text?: string): Promise<void> {
		try {
			await ctx.answerCallbackQuery(text === undefined ? undefined : { text });
		} catch (error) {
			this.options.log(`answering a button failed: ${(error as Error).message}`);
		}
	}

	private async sendToAssistant(chatId: number, text: string, attachments?: AttachmentRef[]): Promise<void> {
		if (!this.options.daemon.send(attachments ? { type: "send", text, attachments } : { type: "send", text })) {
			await this.reply(chatId, UNREACHABLE);
			return;
		}
		if (this.turn) return;
		const turn: Turn = {
			chatId,
			draftId: 1 + Math.floor(Math.random() * 2_000_000_000),
			draftText: "",
			sawBusy: BUSY_STATES.includes(this.agentState),
			refresh: setInterval(() => void this.draft(turn), this.options.draftRefreshMs ?? DRAFT_REFRESH_MS),
		};
		this.turn = turn;
		await this.draft(turn);
	}

	private async stop(chatId: number): Promise<void> {
		if (!this.options.daemon.send({ type: "abort" })) {
			await this.reply(chatId, UNREACHABLE);
		}
	}

	private endTurn(): void {
		if (!this.turn) return;
		clearInterval(this.turn.refresh);
		this.turn = undefined;
	}

	private async draft(turn: Turn): Promise<void> {
		if (this.turn !== turn) return;
		try {
			await this.bot.api.sendMessageDraft(turn.chatId, turn.draftId, turn.draftText, { can_stop: true });
		} catch (error) {
			this.options.log(`draft failed: ${(error as Error).message}`);
		}
	}

	/** Sends a message with the persistent menu keyboard attached. */
	private async showMenu(chatId: number, text: string): Promise<void> {
		try {
			await this.bot.api.sendMessage(chatId, text, { reply_markup: MENU_KEYBOARD });
		} catch (error) {
			this.options.log(`sending the menu failed: ${(error as Error).message}`);
		}
	}

	/** Greets the allowed user with the menu — called once when the bot starts listening. */
	async hello(): Promise<void> {
		const chatId = this.chatId;
		if (chatId === 0) return;
		await this.showMenu(chatId, "Rosita está despierta ✨\nTu menú de acciones:");
	}

	private async reply(chatId: number, text: string): Promise<void> {
		try {
			await this.bot.api.sendMessage(chatId, text);
		} catch (error) {
			this.options.log(`sending a message failed: ${(error as Error).message}`);
		}
	}
}

/** Downloads from the Bot API file endpoint, giving up after `timeoutMs` (updates are handled one at
 * a time, so a hung download would hold up /stop). Errors never carry the address, which holds the token. */
export function telegramDownloader(
	botToken: string,
	options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): (filePath: string) => Promise<Buffer> {
	const get = options.fetch ?? fetch;
	return async (filePath) => {
		const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
		let response: Response;
		try {
			response = await get(`https://api.telegram.org/file/bot${botToken}/${filePath}`, { signal });
		} catch {
			throw new Error(signal.aborted ? "timed out" : "network error");
		}
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return Buffer.from(await response.arrayBuffer());
	};
}

/** Splits text into chunks of at most `limit` characters, at a line break when one is close. */
export function splitMessage(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const breakAt = rest.lastIndexOf("\n", limit);
		const cut = breakAt > limit / 2 ? breakAt : limit;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest !== "") chunks.push(rest);
	return chunks;
}