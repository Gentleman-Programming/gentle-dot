import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentState,
	APP_REQUIRED,
	type Ask,
	type ClientMessage,
	type ConnectorDraft,
	type ConnectorInfo,
	type Features,
	isAppCommand,
	isPinCommand,
	isThinkingLevel,
	type MessageQueue,
	type ModelGroup,
	type ModelRef,
	PIN_REQUIRED,
	parseClientMessage,
	parseQueue,
	type RoleRoute,
	type ServerPayload,
	type VoiceCapability,
} from "@gentle-dot/protocol";
import { APPROVAL_WAIT_MS, type AppApproval, type AppLink } from "./app-channel.ts";
import type { AuthManager } from "./auth.ts";
import type { ConnectorManager, ConnectorRefusal } from "./connectors.ts";
import {
	conversationIdOf,
	type HistoryPage,
	listConversations,
	pageHistory,
	resolveConversation,
} from "./conversations.ts";
import { directAccess, type EngineAccess } from "./engine-access.ts";
import { DRAFT_STATUS_KEY } from "./extensions/approval-guard.ts";
import { DEFAULT_REQUEST_BUDGET, REQUEST_BUDGET_ENV } from "./extensions/screenshot-context.ts";
import { limitsFile, noteModel, recordCeiling } from "./limits.ts";
import { describeTool, textOf } from "./presentation.ts";
import { writePrivateFile } from "./private-file.ts";
import {
	LiveModelSwitch,
	ProfileError,
	type ProfileStore,
	type SwitchOutcome,
	splitModel,
	toModelChoices,
	toModelOptions,
} from "./profiles.ts";
import { DEFAULT_ROTATION, type RotationLimits, SessionRotator, sessionFileBytes } from "./rotation.ts";
import type { AgentRecord, AgentSupervisor, SupervisorEvent } from "./supervisor.ts";
import {
	composePrompt,
	omittedAttachmentsToast,
	type StoredFile,
	splitAttachments,
	type UploadStore,
} from "./uploads.ts";
import type { VoiceService } from "./voice.ts";
import type { PinGate } from "./web-pin.ts";
import { isBlockedInput, presentText, shouldShowToast } from "./white-label.ts";

export interface BridgeClient {
	send(payload: ServerPayload): void;
}

export interface BridgeOptions {
	dataDir: string;
	log?: (line: string) => void;
	auth?: AuthManager;
	profiles?: ProfileStore;
	connectors?: ConnectorManager;
	/** Speech to text and text to speech with an OpenAI API key (S30.2). */
	voice?: VoiceService;
	/** Files the user uploaded for their messages (S31). */
	uploads?: UploadStore;
	/**
	 * The desktop app that launched the daemon, over its private channel (S25.1): the only source of
	 * connector changes and the only place approvals are answered. Without it they fail closed.
	 */
	app?: AppLink;
	/**
	 * A server without the desktop app (S25.8): the web page makes connector changes and allows
	 * sending actions with this PIN instead. Never set together with `app`.
	 */
	pin?: PinGate;
	/** How long a PIN approval waits for an answer. Default 130 s, like the app's. */
	approvalWaitMs?: number;
	/**
	 * How the engine's session and upload files are read and written; in server mode as the engine's
	 * user (S25.8, B1), since the engine can plant links there. Default: as the daemon is.
	 */
	engineAccess?: EngineAccess;
	/** How long switching conversations waits for a running answer to stop. Default 10 s. */
	stopTimeoutMs?: number;
	/** Optional parts of the app; by default one continuous chat. */
	features?: Features;
	/** When the open session is replaced by a fresh one (docs/design.md §7). */
	rotation?: RotationLimits;
	/** How many messages `history` and each `get_earlier` page carry. Default 100. */
	historyPage?: number;
}

type ProfileCommand = Extract<
	ClientMessage,
	{
		type:
			| "profile_save"
			| "profile_rename"
			| "profile_duplicate"
			| "profile_delete"
			| "profile_apply"
			| "profile_import"
			| "profile_save_current";
	}
>;

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const WAITING_IN_APP = "Waiting for your answer in the Gentle Dot app.";
const DECLINED = { code: "declined", message: "Nothing was changed." } as const;

/**
 * An open dialog; `options` keeps the agent's original option strings for the answer. An `app` ask
 * only shows that the desktop app is asking; windows cannot answer it.
 */
type PendingAsk = {
	ask: Ask;
	options?: string[];
	timer?: NodeJS.Timeout;
};
const REMEMBERED_REQUEST_IDS = 500;
const READY_TIMEOUT_MS = 60_000;
const ANSWER_FAILED = "Something went wrong while answering. Please try again.";
const HISTORY_PAGE = 100;

/** One image as the engine receives it and sends it back in its own user message. */
type PromptImage = { type: "image"; mimeType: string; data: string };
/** A prompt as the engine receives it, images inlined, so it can be sent again unchanged. */
type SentPrompt = { message: string; images?: PromptImage[] };
/**
 * A prompt handed to the engine. Its identity is what a refusal is attributed to, so a message sent
 * later can neither inherit that failure nor spend the recovery this one already used.
 */
type SentTurn = {
	prompt: SentPrompt;
	/** This prompt already used its one automatic recovery; a second failure is the real one. */
	recovered: boolean;
	/**
	 * The refused request's chat size and model, once it is sent again: an answer to that re-send is
	 * the evidence a ceiling is learned from, and a failure teaches nothing.
	 */
	refused?: { bytes: number; model: string | undefined };
};

/** A prompt the engine has not reported its own user message for yet. */
type AwaitingTurn = {
	turn: SentTurn;
	/** This prompt is a recovery's copy of a message the window already shows. */
	resend: boolean;
};

/**
 * The images of the engine's own user message, in order. `[]` when it carries none, `undefined` when
 * the event does not carry content this daemon can read: an incomplete event must not be used to rule
 * a prompt in or out.
 */
function userMessageImages(message: unknown): PromptImage[] | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return [];
	if (!Array.isArray(content)) return undefined;
	const images: PromptImage[] = [];
	for (const block of content) {
		const part = block as { type?: unknown; mimeType?: unknown; data?: unknown };
		if (part?.type !== "image") continue;
		if (typeof part.mimeType !== "string" || typeof part.data !== "string") return undefined;
		images.push({ type: "image", mimeType: part.mimeType, data: part.data });
	}
	return images;
}

/** True when two prompts carry the same images, in the same order. */
function sameImages(a: PromptImage[] | undefined, b: PromptImage[] | undefined): boolean {
	const left = a ?? [];
	const right = b ?? [];
	return (
		left.length === right.length &&
		left.every((image, i) => image.mimeType === right[i]?.mimeType && image.data === right[i]?.data)
	);
}

/**
 * The wording a request refused as too large carries. The engine formats the provider's status and
 * body into one string, with no fields to read, so this list is the detection by wording — kept
 * narrow on purpose: a network, auth, or rate limit failure must not start a recovery, which is why
 * a bare `500` never matches here (the bridge retries that once only when the session itself is
 * large). `413` alone does: it means Content Too Large and nothing else. The provider's real ceiling
 * is unknown and varies by model, so nothing here claims to be one.
 */
const SIZE_LIMIT_PHRASES = [
	"request entity too large",
	"payload too large",
	"entity too large",
	"content too large",
	"request too large",
	"body too large",
	"too large",
	"input too long",
	"prompt is too long",
	"prompt too long",
	"too many tokens",
	"maximum number of tokens",
	"context length",
	"maximum context",
	"max context",
	"context window",
	"context_length_exceeded",
	"reduce the length of the messages",
];
/** A size, not merely a limit: "rate limit exceeded" and "context deadline exceeded" stay out. */
const SIZE_WORD = /\b(?:size|bytes?|length|tokens?)\b/i;
const OVERFLOW_WORD = /\b(?:exceed(?:s|ed|ing)?|overflow|too (?:many|long|large|big))\b/i;
const SIZE_STATUS = /(?:^|\D)(?:422|500)(?:\D|$)/;

/**
 * Half of the request budget (`applyRequestBudget`). A live session past this floor carries a whole
 * request large enough that the provider may have refused it for size without saying so, and the
 * file is larger than the request (entry ids, timestamps, framing), so the floor is conservative.
 * Tied to the same setting, so the two never drift; a starting point like the budget, not a claim
 * about the provider's real ceiling.
 */
const RECOVERY_FLOOR_RATIO = 0.5;

/** The live session size past which a refusal the provider did not name is retried once. */
export function recoveryFloorBytes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[REQUEST_BUDGET_ENV]?.trim();
	const configured = raw ? Number(raw) : Number.NaN;
	const budget =
		Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_REQUEST_BUDGET;
	return Math.floor(budget * RECOVERY_FLOOR_RATIO);
}

/** The daemon's marker for recoveries that were started and never finished. */
export const PENDING_RECOVERY_FILE_NAME = "pending-recovery.json";
/** The only marker content this daemon writes; anything else on disk is never acted on. */
const PENDING_RECOVERY_KIND = "too_large";
/** What a startup says about a recovery the last run did not finish. */
const LOST_RECOVERY_NOTICE =
	"Your last message could not be answered because the request was too large. You can send it again.";

/** The marker's path under the daemon's state folder, next to `state.json` and `provider-limits.json`. */
export function pendingRecoveryFile(dataDir: string): string {
	return join(dataDir, PENDING_RECOVERY_FILE_NAME);
}

/**
 * The marker as on disk: the recoveries that still owe the user a notice. Each one owns its own id
 * and removes only that id, so the first to finish cannot silence a later recovery still in flight.
 * `legacy` is a marker written before owners existed: it is still owed, but no run can remove it, so
 * only a startup clears it.
 */
type RecoveryMarker = { owners: string[]; legacy: boolean };

function readMarker(file: string): RecoveryMarker | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const marker = parsed as { kind?: unknown; pending?: unknown };
	if (marker.kind !== PENDING_RECOVERY_KIND) return undefined;
	if (marker.pending === undefined) return { owners: [], legacy: true };
	if (!Array.isArray(marker.pending)) return undefined;
	return {
		owners: marker.pending.filter((id): id is string => typeof id === "string" && id !== ""),
		legacy: false,
	};
}

/**
 * True when the state folder still holds the marker of a recovery that did not finish: the message
 * was refused for size, its failure was hidden from the chat, and it was never sent again. A missing,
 * torn, or foreign file reads false, so a startup never acts on anything it did not write.
 */
export function readPendingRecovery(file: string): boolean {
	const marker = readMarker(file);
	if (!marker) return false;
	return marker.legacy || marker.owners.length > 0;
}

/** Adds `id` as an owner of the marker; the file is rewritten whole, as `limits.ts` does its own. */
function addRecoveryOwner(file: string, id: string): void {
	const owners = [...(readMarker(file)?.owners ?? []), id];
	writePrivateFile(file, `${JSON.stringify({ kind: PENDING_RECOVERY_KIND, pending: owners })}\n`);
}

/** Removes only `id`'s ownership: the marker stays while any other recovery still owns a notice. */
function removeRecoveryOwner(file: string, id: string): void {
	const marker = readMarker(file);
	if (!marker || marker.legacy) return;
	const owners = marker.owners.filter((owner) => owner !== id);
	if (owners.length === marker.owners.length) return;
	if (owners.length === 0) rmSync(file, { force: true });
	else writePrivateFile(file, `${JSON.stringify({ kind: PENDING_RECOVERY_KIND, pending: owners })}\n`);
}

/** True when the engine's formatted provider error says the request itself was too large. */
export function isSizeLimitError(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	const text = errorMessage.toLowerCase();
	// Content Too Large by definition, whatever the body says or omits.
	if (/(?:^|\D)413(?:\D|$)/.test(text)) return true;
	if (SIZE_LIMIT_PHRASES.some((phrase) => text.includes(phrase))) return true;
	if (SIZE_WORD.test(text) && OVERFLOW_WORD.test(text)) return true;
	return SIZE_STATUS.test(text) && SIZE_WORD.test(text);
}

/**
 * Translates between protocol v1 clients and the supervised agent: it keeps
 * the derived agent state, the pending asks, and the streaming message ids,
 * and broadcasts every agent event to all connected clients.
 */
export class DotBridge {
	private readonly clients = new Set<BridgeClient>();
	/** Each window's id, for the app's commands on its behalf. */
	private readonly clientIds = new Map<string, BridgeClient>();
	private readonly asks = new Map<string, PendingAsk>();
	/** The answer each open PIN approval waits for, by request id (S25.8). */
	private readonly pinWaiters = new Map<string, (allowed: boolean) => void>();
	/** Connector changes a window confirmed with the PIN: their own confirmation is not asked again. */
	private readonly pinConfirmed = new WeakSet<ClientMessage>();
	/** Told to every window that connects during this run (a connectors file set aside at start). */
	private readonly notices: ServerPayload[] = [];
	private readonly runningTools = new Set<string>();
	private readonly seenRequestIds: string[] = [];
	private readonly sessionDir: string;
	private readonly supervisor: AgentSupervisor;
	private readonly options: BridgeOptions;
	private state: AgentState = "starting";
	private interrupted = false;
	private nextMessage = 0;
	private assistantId: string | undefined;
	private restartPending = false;
	private restarting = false;
	private restartAgain = false;
	/** The running answer is being stopped on purpose, so its end is not an error. */
	private stopRequested = false;
	/** The conversation switch in progress; messages sent meanwhile wait for it. */
	private switching: Promise<void> = Promise.resolve();
	/** Messages waiting for the agent, as shown to the user. */
	private queue: MessageQueue = { steering: [], followUp: [] };
	/** Messages on their way to the agent; the session is never rotated under them. */
	private sending = 0;
	/**
	 * The prompt of the run being answered. A refusal is attributed to it, never to a message sent
	 * later, so it is the identity carried into `pendingRecovery` and the one-recovery guard.
	 */
	private turn: SentTurn | undefined;
	/**
	 * Every prompt handed to the engine whose own user message it has not reported yet, oldest first:
	 * normal sends and recovery re-sends in one ordered registry. That order is the dispatch order, so
	 * each engine event is matched to the right prompt and shown at most once — a recovery's copy, which
	 * the window already shows, is the only one suppressed.
	 */
	private readonly awaiting: AwaitingTurn[] = [];
	/** A tool ran since the user's message; sending it again would repeat its side effects. */
	private toolInTurn = false;
	/** The refused answer waiting for a decision, taken up once the run settles; `id` is its marker. */
	private pendingRecovery:
		| { id: string | undefined; failed: { messageId: string; text: string }; turn: SentTurn }
		| undefined;
	/** A conversation switch is in progress: the session is not rotated under it. */
	private switchingNow = false;
	/** A run settled while a message was still on its way; check for rotation once it arrived. */
	private rotationDeferred = false;
	private readonly features: Features;
	private readonly rotator: SessionRotator;
	private readonly liveSwitch: LiveModelSwitch;

	constructor(supervisor: AgentSupervisor, options: BridgeOptions) {
		this.supervisor = supervisor;
		this.options = options;
		this.liveSwitch = new LiveModelSwitch(supervisor, (line) => this.log(line));
		this.sessionDir = join(options.dataDir, "sessions");
		this.features = options.features ?? { conversations: false };
		this.rotator = new SessionRotator(supervisor, {
			limits: options.rotation ?? DEFAULT_ROTATION,
			canRotate: () =>
				supervisor.state === "ready" && !supervisor.busy && this.asks.size === 0 && this.sending === 0,
			...(options.engineAccess ? { access: options.engineAccess } : {}),
			log: (line) => this.log(line),
		});
		supervisor.onEvent((event) => this.onAgentEvent(event));
		if (options.auth) options.auth.onCredentialsChanged = () => this.afterCredentialsChange();
		if (options.connectors) {
			options.connectors.onChanged = (restart) => this.afterConnectorsChange(restart);
			options.connectors.onBlocked = () => this.connectorChangeBlocked();
			options.connectors.onSetAside = (notice) => this.connectorsSetAside(notice);
			options.connectors.imagesSupported = () => supervisor.modelImages;
		}
		this.state = this.deriveState();
		this.reportLostRecovery();
	}

	get agentState(): AgentState {
		return this.state;
	}

	/**
	 * Asks the user in the desktop app's native dialog (S25.3); windows only see that it waits there.
	 * Resolves true only when the user allows it; declining, no answer, `signal`, or the app quitting
	 * resolve false. Rejects when there is no app to ask (fail closed).
	 */
	askInApp(request: AppApproval, signal?: AbortSignal): Promise<boolean> {
		const app = this.options.app;
		if (!app?.connected && this.options.pin) return this.askWithPin(request, signal);
		if (!app?.connected) return Promise.reject(new Error(APP_REQUIRED));
		const requestId = `app-${randomUUID()}`;
		const ask: Ask = {
			requestId,
			method: "app",
			title: presentText(request.title ?? `Allow ${request.connector} to ${request.action}?`),
			message: WAITING_IN_APP,
		};
		this.asks.set(requestId, { ask });
		this.broadcast({ type: "ask", ask });
		this.refreshState();
		return app.approve(request, signal).finally(() => this.resolveAsk(requestId));
	}

	/**
	 * On a server (S25.8): every window shows the approval with its full preview, and it is allowed
	 * only with the PIN (`pin_approve`). Declining, no answer in time, `signal`, or the run ending
	 * resolve false.
	 */
	private askWithPin(request: AppApproval, signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return Promise.resolve(false);
		const requestId = `pin-${randomUUID()}`;
		const preview = request.preview.map(
			({ name, value }) => `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
		);
		const ask: Ask = {
			requestId,
			method: "pin",
			title: presentText(request.title ?? `Allow ${request.connector} to ${request.action}?`),
			message: presentText(
				[
					request.summary ?? `The assistant wants to ${request.action} in ${request.connector}.`,
					...preview,
				].join("\n\n"),
			),
		};
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(
				() => this.resolveAsk(requestId),
				this.options.approvalWaitMs ?? APPROVAL_WAIT_MS,
			);
			this.pinWaiters.set(requestId, resolve);
			signal?.addEventListener("abort", () => this.resolveAsk(requestId), { once: true });
			this.asks.set(requestId, { ask, timer });
			this.broadcast({ type: "ask", ask });
			this.refreshState();
		});
	}

	/** A window's PIN message on a server (S25.8); without server mode they open nothing. */
	private async pinMessage(
		client: BridgeClient,
		message: Extract<ClientMessage, { type: "pin_set" | "pin_command" | "pin_approve" }>,
	): Promise<void> {
		const pin = this.options.pin;
		if (!pin || this.options.app?.connected) {
			this.deliver(client, { type: "error", code: "app_required", message: APP_REQUIRED });
			return;
		}
		if (message.type === "pin_set") {
			const outcome = await pin.set(message.pin);
			if (outcome.ok) this.broadcast({ type: "pin_status", pin: pin.status() });
			else this.deliver(client, { type: "error", code: outcome.code, message: outcome.message });
			return;
		}
		if (message.type === "pin_approve" && this.asks.get(message.requestId)?.ask.method !== "pin") {
			this.deliver(client, {
				type: "error",
				code: "ask_not_found",
				message: "That question is no longer open.",
			});
			return;
		}
		const outcome = await pin.verify(message.pin);
		if (!outcome.ok) {
			this.deliver(client, { type: "error", code: outcome.code, message: outcome.message });
			if (outcome.code === "pin_locked") this.broadcast({ type: "pin_status", pin: pin.status() });
			return;
		}
		if (message.type === "pin_approve") {
			const waiter = this.pinWaiters.get(message.requestId);
			this.pinWaiters.delete(message.requestId);
			waiter?.(true);
			this.resolveAsk(message.requestId);
			return;
		}
		if (!isPinCommand(message.command)) return;
		this.pinConfirmed.add(message.command);
		await this.run(client, message.command);
	}

	attach(client: BridgeClient): () => void {
		this.clients.add(client);
		const clientId = randomBytes(18).toString("base64url");
		this.clientIds.set(clientId, client);
		this.deliver(client, {
			type: "ready",
			agentState: this.state,
			clientId,
			...this.conversationRef(),
			...(this.supervisor.model ? { model: this.supervisor.model } : {}),
			features: this.features,
			...(this.options.voice ? { voice: this.options.voice.capability() } : {}),
			...(this.options.pin && !this.options.app?.connected ? { pin: this.options.pin.status() } : {}),
		});
		if (this.queued()) this.deliver(client, { type: "queue", ...this.queue });
		for (const { ask } of this.asks.values()) this.deliver(client, { type: "ask", ask });
		for (const draft of this.options.connectors?.drafts() ?? [])
			this.deliver(client, { type: "connector_draft", draft });
		if (this.interrupted) this.deliver(client, { type: "interrupted" });
		for (const notice of this.notices) this.deliver(client, notice);
		return () => {
			this.clients.delete(client);
			this.clientIds.delete(clientId);
			this.options.auth?.cancelOwnedBy(client);
			this.options.connectors?.cancelOwnedBy(client);
		};
	}

	/** A window's message. Connector changes come only from the desktop app (S25.2). */
	async handle(client: BridgeClient, message: ClientMessage): Promise<void> {
		if (message.type === "pin_set" || message.type === "pin_command" || message.type === "pin_approve") {
			await this.pinMessage(client, message);
			return;
		}
		if (isAppCommand(message)) {
			// On a server the PIN stands in for the app (S25.8); the computer helper is the desktop's only.
			if (this.options.pin && !this.options.app?.connected && isPinCommand(message))
				this.deliver(client, { type: "error", code: "pin_required", message: PIN_REQUIRED });
			else this.deliver(client, { type: "error", code: "app_required", message: APP_REQUIRED });
			return;
		}
		await this.run(client, message);
	}

	/**
	 * A connector change from the desktop app's channel, on behalf of the window with `clientId`: its
	 * sign-in steps and refusals go to that window. Throws when there is no such window or it is not
	 * an app command.
	 */
	async handleFromApp(clientId: string, raw: unknown): Promise<void> {
		const client = this.clientIds.get(clientId);
		if (!client) throw new Error("That window is not connected to the assistant any more.");
		const message = parseClientMessage(JSON.stringify(raw ?? null));
		if (!message || !isAppCommand(message)) throw new Error("Only connector changes come from the app.");
		await this.run(client, message);
	}

	private async run(client: BridgeClient, message: ClientMessage): Promise<void> {
		try {
			await this.dispatch(client, message);
		} catch (error) {
			this.log(`command ${message.type} failed: ${(error as Error).message}`);
			if (this.supervisor.state !== "ready") {
				this.deliver(client, {
					type: "error",
					code: "agent_unavailable",
					message: "The assistant is restarting. Try again in a moment.",
				});
			} else if (message.type === "send" && !(await this.hasAccount())) {
				this.deliver(client, {
					type: "error",
					code: "no_account",
					message: "Connect an AI account first: open Accounts or type /login.",
				});
			} else {
				this.deliver(client, {
					type: "error",
					code: "command_failed",
					message: "That did not work. Please try again.",
				});
			}
		}
	}

	/** True when an account is connected, or when that cannot be told. */
	private async hasAccount(): Promise<boolean> {
		if (!this.options.auth) return true;
		return this.options.auth.hasAccount().catch(() => true);
	}

	private async dispatch(client: BridgeClient, message: ClientMessage): Promise<void> {
		switch (message.type) {
			case "hello":
				return;
			case "send": {
				if (isBlockedInput(message.text)) {
					this.deliver(client, {
						type: "error",
						code: "unsupported",
						message: "I can't run that command here.",
					});
					return;
				}
				if (message.requestId && this.alreadySeen(message.requestId)) return;
				const files = message.attachments ? this.attachedFiles(client, message.attachments) : [];
				if (!files) return;
				// Slash commands are typed alone; a message with files always goes to the assistant.
				if (files.length === 0 && (await this.openScreen(client, message.text))) return;
				await this.switching;
				this.interrupted = false;
				const busy = this.supervisor.busy;
				let prompt: SentPrompt;
				if (files.length > 0) {
					const composed = composePrompt(message.text, files, {
						images: this.supervisor.modelImages,
						// The stored file may have been swapped for a link since: read it as the engine.
						read: (path) => this.engine(() => readFileSync(path)),
					});
					const { omitted, ...sent } = composed;
					// The chip of every file is still shown, so a file the request could not carry must be said
					// out loud; the message itself goes out with the attachments that fit.
					if (omitted && omitted.length > 0) {
						this.broadcast({ type: "toast", level: "warning", message: omittedAttachmentsToast(omitted) });
					}
					prompt = sent;
				} else {
					prompt = { message: message.text };
				}
				// Stash the prompt with its identity before it is sent: a refused one is sent again
				// exactly as it was, and only its own refusal may start that recovery.
				const turn: SentTurn = { prompt, recovered: false };
				this.awaiting.push({ turn, resend: false });
				this.toolInTurn = false;
				this.sending += 1;
				try {
					await this.supervisor.request(
						busy ? { type: "prompt", ...prompt, streamingBehavior: "steer" } : { type: "prompt", ...prompt },
					);
					if (message.attachments) this.options.uploads?.consume(message.attachments);
				} catch (error) {
					// The prompt never reached a turn: drop it rather than let it claim a later one.
					const index = this.awaiting.findIndex((entry) => entry.turn === turn);
					if (index >= 0) this.awaiting.splice(index, 1);
					throw error;
				} finally {
					this.sending -= 1;
					// The run may have settled before the answer to this prompt was handled.
					if (this.sending === 0 && this.rotationDeferred) {
						this.rotationDeferred = false;
						if (!this.supervisor.busy) this.afterRunSettled();
					}
				}
				return;
			}
			case "steer":
				await this.supervisor.request({ type: "steer", message: message.text });
				return;
			case "abort":
				if (this.supervisor.busy) this.stopRequested = true;
				await this.supervisor.request({ type: "abort" });
				return;
			case "ui_response": {
				const pending = this.asks.get(message.requestId);
				if (!pending) {
					this.deliver(client, {
						type: "error",
						code: "ask_not_found",
						message: "That question is no longer open.",
					});
					return;
				}
				const { requestId } = message;
				if (pending.ask.method === "app") {
					this.deliver(client, { type: "error", code: "app_required", message: WAITING_IN_APP });
					return;
				}
				// Allowing needs the PIN (`pin_approve`); declining narrows nothing, so any window may.
				if (pending.ask.method === "pin") {
					if (message.confirmed === false || message.cancelled) this.resolveAsk(requestId);
					else this.deliver(client, { type: "error", code: "pin_required", message: PIN_REQUIRED });
					return;
				}
				const answer: Record<string, unknown> = {};
				if (message.cancelled) answer.cancelled = true;
				else if (message.confirmed !== undefined) answer.confirmed = message.confirmed;
				else if (message.value !== undefined) {
					// Options are shown rewritten; answer with the agent's original string.
					const index = pending.ask.options?.indexOf(message.value) ?? -1;
					answer.value = index >= 0 ? (pending.options?.[index] ?? message.value) : message.value;
				}
				this.supervisor.send({ type: "extension_ui_response", id: requestId, ...answer });
				this.resolveAsk(requestId);
				return;
			}
			case "new_conversation":
				if (!this.conversationsOn(client)) return;
				await this.changeConversation(async () => {
					await this.switchAfterStop(() => this.supervisor.request({ type: "new_session" }));
					this.afterConversationChange();
				});
				return;
			case "list_conversations":
				this.deliver(client, this.conversationsPayload());
				return;
			case "open_conversation": {
				if (!this.conversationsOn(client)) return;
				const path = this.engine(() => resolveConversation(this.sessionDir, message.conversationId));
				if (!path) {
					this.deliver(client, {
						type: "error",
						code: "conversation_not_found",
						message: "That conversation does not exist.",
					});
					return;
				}
				await this.changeConversation(async () => {
					await this.switchAfterStop(() =>
						this.supervisor.request({ type: "switch_session", sessionPath: path }),
					);
					this.afterConversationChange(await this.currentHistory());
				});
				return;
			}
			case "auth_list":
				await this.sendProviders(client);
				return;
			case "auth_login": {
				const refused = this.requireAuth().start(client, message.providerId, message.method, (payload) =>
					this.deliver(client, payload),
				);
				if (refused) this.deliver(client, { type: "error", ...refused });
				return;
			}
			case "auth_reply":
				if (
					this.options.connectors?.owns(message.flowId)
						? !this.options.connectors.reply(client, message.flowId, message)
						: !this.requireAuth().reply(client, message.flowId, message)
				) {
					this.deliver(client, {
						type: "error",
						code: "auth_flow_not_found",
						message: "That sign-in is no longer active.",
					});
				}
				return;
			case "voice_transcribe":
			case "voice_speak": {
				const { requestId } = message;
				const voice = this.options.voice;
				if (!voice) {
					this.deliver(client, {
						type: "voice_unavailable",
						requestId,
						reason: "Voice is not available here.",
					});
					return;
				}
				if (message.type === "voice_transcribe") {
					const result = await voice.transcribe(message.mime, message.data);
					this.deliver(
						client,
						result.ok
							? { type: "voice_transcript", requestId, text: result.text }
							: { type: "voice_unavailable", requestId, reason: result.reason },
					);
					return;
				}
				const result = await voice.speak(message.text);
				this.deliver(
					client,
					result.ok
						? { type: "voice_speech", requestId, mime: result.mime, data: result.data }
						: { type: "voice_unavailable", requestId, reason: result.reason },
				);
				return;
			}
			case "auth_logout": {
				const refused = await this.requireAuth().logout(message.providerId);
				if (refused) this.deliver(client, { type: "error", ...refused });
				return;
			}
			case "profiles_list":
				await this.sendProfiles(client);
				return;
			case "models_list":
				this.deliver(client, await this.modelsPayload());
				return;
			case "model_set":
				await this.setModel(client, message);
				return;
			case "connectors_list":
				this.deliver(client, { type: "connectors", connectors: this.requireConnectors().list() });
				return;
			case "connector_connect":
			case "connector_signin":
			case "connector_setup":
			case "connector_disconnect":
			case "connector_mode":
			case "connector_remove":
				await this.connectorCommand(client, message);
				return;
			case "connector_draft_reply": {
				const emit = (payload: ServerPayload) => this.deliver(client, payload);
				const { draftId, approve } = message;
				const draft = this.options.connectors?.drafts().find((d) => d.draftId === draftId);
				if (approve && draft && !(await this.confirmChange(client, draftApproval(draft), message))) return;
				const refused = this.requireConnectors().decideDraft(client, draftId, approve, emit);
				if (refused) this.deliver(client, { type: "error", ...refused });
				else this.broadcast({ type: "connector_draft_resolved", draftId, approved: approve });
				return;
			}
			case "connectors_scan":
				this.deliver(client, { type: "connector_imports", found: this.requireConnectors().scan() });
				return;
			case "computer_register":
				this.requireConnectors().registerComputer(client, { url: message.url, token: message.token });
				return;
			case "computer_unregister":
				this.requireConnectors().unregisterComputer(client);
				return;
			case "connector_import": {
				const connectors = this.requireConnectors();
				// The confirmed plan is what gets imported, whatever a later scan finds.
				const plan = connectors.importPlan(message.ids);
				if (
					plan.choices.length > 0 &&
					!(await this.confirmChange(client, importApproval(plan.choices), message))
				)
					return;
				this.deliver(client, {
					type: "connector_imported",
					names: await connectors.importServers(message.ids, plan.servers),
				});
				return;
			}
			case "profile_save":
			case "profile_rename":
			case "profile_duplicate":
			case "profile_delete":
			case "profile_apply":
			case "profile_import":
			case "profile_save_current":
				await this.profileCommand(client, message);
				return;
			case "get_history":
				// Windows ask for history as soon as they connect, often while the agent starts.
				await this.whenReady();
				this.deliver(client, {
					type: "history",
					...this.conversationRef(),
					...(await this.currentHistory()),
				});
				return;
			case "get_earlier":
				this.deliver(client, {
					type: "earlier",
					before: message.before,
					...this.engine(() => pageHistory(this.chain(), this.pageSize(), message.before)),
				});
				return;
		}
	}

	/** `/login`, `/profiles`, and `/connectors` open their screen instead of reaching the assistant. */
	private async openScreen(client: BridgeClient, text: string): Promise<boolean> {
		if (/^\s*\/login\s*$/i.test(text)) {
			await this.sendProviders(client, true);
			return true;
		}
		if (/^\s*\/profiles\s*$/i.test(text)) {
			await this.sendProfiles(client, true);
			return true;
		}
		if (/^\s*\/connectors\s*$/i.test(text)) {
			this.deliver(client, { type: "connectors", connectors: this.requireConnectors().list(), open: true });
			return true;
		}
		return false;
	}

	/** The uploaded files a message sends; undefined (and an error for the window) when one is not available. */
	private attachedFiles(
		client: BridgeClient,
		refs: NonNullable<Extract<ClientMessage, { type: "send" }>["attachments"]>,
	): StoredFile[] | undefined {
		const found = this.options.uploads?.resolve(refs) ?? {
			ok: false as const,
			code: "attachment_not_found",
			message: "Files cannot be sent here.",
		};
		if (found.ok) return found.files;
		this.deliver(client, { type: "error", code: found.code, message: found.message });
		return undefined;
	}

	/** With the conversations list off there is one chat; starting or opening another is refused. */
	private conversationsOn(client: BridgeClient): boolean {
		if (this.features.conversations) return true;
		this.deliver(client, {
			type: "error",
			code: "conversations_off",
			message: "This assistant keeps one continuous chat.",
		});
		return false;
	}

	/** Runs a conversation switch; a message sent meanwhile goes to the new conversation, after its history. */
	private changeConversation(change: () => Promise<void>): Promise<void> {
		const run = change();
		this.switchingNow = true;
		this.switching = run
			.catch(() => {})
			.finally(() => {
				this.switchingNow = false;
			});
		return run;
	}

	/**
	 * The engine aborts a running answer when it switches sessions, and its end
	 * would land in the new conversation. Stop it first and wait (bounded) for
	 * the run to settle, then switch; that stop is intentional, not an error.
	 */
	private async switchAfterStop(switchTo: () => Promise<unknown>): Promise<void> {
		if (!this.supervisor.busy) {
			await switchTo();
			return;
		}
		this.stopRequested = true;
		try {
			const settled = this.nextSettle(this.options.stopTimeoutMs ?? 10_000);
			await this.supervisor.request({ type: "abort" });
			if (!(await settled)) this.log("the running answer did not stop in time; switching anyway");
			await switchTo();
		} finally {
			this.stopRequested = false;
		}
	}

	/** Resolves true when the run settles or the agent goes away, false after `timeoutMs`. */
	private nextSettle(timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const finish = (settled: boolean) => {
				clearTimeout(timer);
				off();
				resolve(settled);
			};
			const timer = setTimeout(() => finish(false), timeoutMs);
			const off = this.supervisor.onEvent((event) => {
				if (event.type === "agent_settled") finish(true);
				else if (event.type === "supervisor_state" && event.state !== "ready") finish(true);
			});
		});
	}

	/** Waits until the agent can take commands; gives up after a minute or when it stopped. */
	private whenReady(): Promise<void> {
		if (this.supervisor.state === "ready") return Promise.resolve();
		return new Promise((resolve, reject) => {
			const finish = (error?: Error) => {
				clearTimeout(timer);
				off();
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(() => finish(new Error("the agent did not start in time")), READY_TIMEOUT_MS);
			timer.unref();
			const off = this.supervisor.onEvent((event) => {
				if (event.type !== "supervisor_state") return;
				if (event.state === "ready") finish();
				else if (event.state === "stopped") finish(new Error("the agent stopped"));
			});
		});
	}

	private requireAuth(): AuthManager {
		if (!this.options.auth) throw new Error("sign-in is not available");
		return this.options.auth;
	}

	private async sendProviders(client: BridgeClient, open = false): Promise<void> {
		const providers = await this.requireAuth().providers();
		this.deliver(client, {
			type: "auth_providers",
			providers,
			...(open ? { open: true } : {}),
			...(await this.voiceCapability()),
		});
	}

	/** The voice capability, checked now, for the accounts list. */
	private async voiceCapability(): Promise<{ voice?: VoiceCapability }> {
		const voice = this.options.voice;
		return voice ? { voice: await voice.refresh() } : {};
	}

	private requireConnectors(): ConnectorManager {
		if (!this.options.connectors) throw new Error("connectors are not available");
		return this.options.connectors;
	}

	/** Runs one connector change; a sign-in's steps go only to the window that started it. */
	private async connectorCommand(
		client: BridgeClient,
		message: Extract<ClientMessage, { connectorId: string }>,
	): Promise<void> {
		const connectors = this.requireConnectors();
		const emit = (payload: ServerPayload) => this.deliver(client, payload);
		const widening = wideningApproval(connectors.list(), message);
		if (widening && !(await this.confirmChange(client, widening, message))) return;
		let refused: ConnectorRefusal | undefined;
		switch (message.type) {
			case "connector_connect":
				refused = connectors.connect(client, message.connectorId, emit);
				break;
			case "connector_signin":
				refused = connectors.signIn(client, message.connectorId, emit);
				break;
			case "connector_setup":
				refused = connectors.setup(client, message.connectorId, emit);
				break;
			case "connector_disconnect":
				refused = connectors.disconnect(message.connectorId);
				break;
			case "connector_mode":
				refused = connectors.setMode(message.connectorId, message.mode);
				break;
			case "connector_remove":
				refused = await connectors.remove(message.connectorId);
				break;
		}
		if (refused) this.deliver(client, { type: "error", ...refused });
	}

	/**
	 * A change that widens what the assistant can reach, confirmed in the app's native dialog even
	 * though the app sent it (S25.3). False, with a note for the window, when it was not allowed.
	 */
	private async confirmChange(
		client: BridgeClient,
		request: AppApproval,
		message: ClientMessage,
	): Promise<boolean> {
		// The PIN the user typed for this very change confirms it (S25.8).
		if (this.pinConfirmed.has(message)) return true;
		const allowed = await this.askInApp(request).catch(() => undefined);
		if (allowed === undefined) {
			this.deliver(client, { type: "error", code: "app_required", message: APP_REQUIRED });
			return false;
		}
		if (!allowed) this.deliver(client, { type: "error", ...DECLINED });
		return allowed;
	}

	/**
	 * A connector the assistant drafted with `propose_connector`. It reaches the daemon on the
	 * engine's own output, and every window shows it as a card; nothing changes until the user answers.
	 */
	private onConnectorDraft(text: unknown): void {
		const draft = typeof text === "string" ? this.options.connectors?.propose(text) : undefined;
		if (!draft) {
			this.log("ignored a malformed connector draft");
			return;
		}
		this.log(`the assistant drafted a connector: ${draft.name}`);
		this.broadcast({ type: "connector_draft", draft });
	}

	/**
	 * A `connectors.json` changed while the daemon was down was set aside (S25.6), usually before any
	 * window is open: every window of this run is told once, when it connects.
	 */
	private connectorsSetAside(message: string): void {
		const notice: ServerPayload = { type: "toast", level: "warning", message };
		this.notices.push(notice);
		this.broadcast(notice);
		this.broadcast({ type: "connectors", connectors: this.requireConnectors().list() });
	}

	/** The connector files were changed outside the Connectors screen and put back. */
	private connectorChangeBlocked(): void {
		this.broadcast({ type: "toast", level: "warning", message: "A change to your connectors was blocked." });
		this.broadcast({ type: "connectors", connectors: this.requireConnectors().list() });
	}

	/** Every window sees the new statuses; a new mcp.json needs an agent restart, once it is idle. */
	private afterConnectorsChange(restart: boolean): void {
		this.broadcast({ type: "connectors", connectors: this.requireConnectors().list() });
		if (!restart) return;
		if (this.supervisor.busy) this.restartPending = true;
		else this.restartAgent();
	}

	private requireProfiles(): ProfileStore {
		if (!this.options.profiles) throw new Error("profiles are not available");
		return this.options.profiles;
	}

	private async sendProfiles(client: BridgeClient, open = false): Promise<void> {
		try {
			this.deliver(client, { ...(await this.profilesPayload()), ...(open ? { open: true } : {}) });
		} catch (error) {
			if (!(error instanceof ProfileError)) throw error;
			this.deliver(client, { type: "error", code: error.code, message: error.message });
		}
	}

	private async profilesPayload(): Promise<Extract<ServerPayload, { type: "profiles" }>> {
		const store = this.requireProfiles();
		const { profiles, active } = store.list();
		const models = await this.supervisor.request({ type: "get_available_models" }).then(
			(response) => toModelOptions(response.data),
			() => [],
		);
		return {
			type: "profiles",
			profiles,
			...(active ? { active } : {}),
			roles: store.roles(),
			models,
			importable: store.importable(),
		};
	}

	/** Runs one profile change; every window gets the new list, errors go to the window that asked. */
	private async profileCommand(client: BridgeClient, message: ProfileCommand): Promise<void> {
		const store = this.requireProfiles();
		try {
			switch (message.type) {
				case "profile_save":
					await store.save(message.name, message.roles);
					// Editing the profile in use takes effect right away.
					if (store.list().active === message.name) await this.applyProfile(message.name);
					break;
				case "profile_rename":
					await store.rename(message.from, message.to);
					break;
				case "profile_duplicate":
					await store.duplicate(message.from, message.to);
					break;
				case "profile_delete":
					await store.remove(message.name);
					break;
				case "profile_apply":
					await this.applyProfile(message.name);
					break;
				case "profile_save_current":
					await store.saveCurrent(message.name, await this.runningRoute());
					break;
				case "profile_import": {
					const providers = await (this.options.auth?.providers() ?? Promise.resolve([])).catch(() => []);
					this.deliver(client, { type: "profiles_imported", ...(await store.import(providers)) });
					break;
				}
			}
		} catch (error) {
			if (!(error instanceof ProfileError)) throw error;
			this.deliver(client, { type: "error", code: error.code, message: error.message });
			return;
		}
		this.broadcast(await this.profilesPayload());
	}

	private async applyProfile(name: string): Promise<void> {
		const orchestrator = await this.requireProfiles().apply(name);
		if (orchestrator) this.reportSwitch(await this.liveSwitch.switchTo(orchestrator));
		// The chat's model picker follows the profile.
		this.broadcastModels();
	}

	/**
	 * The model picker's choice (S32): only a model of a connected account, and a thinking level
	 * it supports. It is saved like a profile's model and switched live; during a reply the switch
	 * waits for the next message instead of stopping the reply.
	 */
	private async setModel(client: BridgeClient, message: Extract<ClientMessage, { type: "model_set" }>) {
		const available = await this.supervisor.request({ type: "get_available_models" });
		const model = toModelChoices(available.data).find(
			(m) => m.provider === message.provider && m.id === message.id,
		);
		if (!model) {
			this.deliver(client, {
				type: "error",
				code: "model_unavailable",
				message: "That model is not available. Connect its account in Accounts first.",
			});
			return;
		}
		if (message.thinking && !model.thinkingLevels?.includes(message.thinking)) {
			this.deliver(client, {
				type: "error",
				code: "thinking_unavailable",
				message: "That model does not support that thinking level.",
			});
			return;
		}
		const route: RoleRoute = { model: `${model.provider}/${model.id}` };
		if (message.thinking) route.thinking = message.thinking;
		await this.options.profiles?.setDefaultModel(route);
		const outcome = await this.liveSwitch.switchTo(route);
		if (outcome === "failed") {
			this.deliver(client, {
				type: "error",
				code: "model_switch_failed",
				message: "That model could not be selected. Try another one.",
			});
		}
		if (outcome === "switched") this.afterModelSwitch();
		else this.broadcastModels();
	}

	/** The current model, the connected accounts' models by account, and the profiles as quick picks. */
	private async modelsPayload(): Promise<Extract<ServerPayload, { type: "models" }>> {
		const [available, running, accounts] = await Promise.all([
			this.supervisor.request({ type: "get_available_models" }),
			this.runningModel(),
			this.accountNames(),
		]);
		const choices = toModelChoices(available.data);
		const groups: ModelGroup[] = [];
		for (const model of choices) {
			let group = groups.find((g) => g.provider === model.provider);
			if (!group) {
				const name = accounts.get(model.provider) ?? model.provider;
				group = { provider: model.provider, name, models: [] };
				groups.push(group);
			}
			group.models.push(model);
		}
		const ref = (provider: string, id: string, thinking?: unknown): ModelRef => {
			const choice = choices.find((m) => m.provider === provider && m.id === id);
			const found: ModelRef = { provider, id, name: choice?.name ?? id };
			if (isThinkingLevel(thinking) && choice?.thinkingLevels) found.thinking = thinking;
			return found;
		};
		const waiting = this.liveSwitch.waiting;
		const target = waiting?.model ? splitModel(waiting.model) : undefined;
		const { profiles, active } = this.savedProfiles();
		return {
			type: "models",
			...(running ? { current: ref(running.provider, running.id, running.thinking) } : {}),
			...(target ? { next: ref(target.provider, target.modelId, waiting?.thinking) } : {}),
			groups,
			profiles: profiles.map(({ name, roles }) => ({ name, ...roles.orchestrator })),
			...(active ? { activeProfile: active } : {}),
		};
	}

	private savedProfiles(): ReturnType<ProfileStore["list"]> {
		try {
			return this.options.profiles?.list() ?? { profiles: [] };
		} catch {
			return { profiles: [] };
		}
	}

	/** Account names by provider id, as the Accounts screen shows them. */
	private async accountNames(): Promise<Map<string, string>> {
		const providers = await (this.options.auth?.providers() ?? Promise.resolve([])).catch(() => []);
		return new Map(providers.map((p) => [p.id, presentText(p.name)]));
	}

	private broadcastModels(): void {
		void this.modelsPayload()
			.then((payload) => this.broadcast(payload))
			.catch((error: Error) => this.log(`could not list models: ${error.message}`));
	}

	/** A new running model: the picker, and the connectors' image note (S24.5), follow it. */
	private afterModelSwitch(): void {
		this.broadcastModels();
		const connectors = this.options.connectors;
		if (connectors) this.broadcast({ type: "connectors", connectors: connectors.list() });
	}

	private reportSwitch(outcome: SwitchOutcome): void {
		if (outcome !== "failed") return;
		this.broadcast({
			type: "toast",
			level: "warning",
			message:
				"Profile applied. The main assistant keeps its current model until that model's account is connected.",
		});
	}

	/** The main assistant's model and thinking level in the running conversation. */
	private async runningRoute(): Promise<RoleRoute | undefined> {
		const running = await this.runningModel();
		if (!running) return undefined;
		const route: RoleRoute = { model: `${running.provider}/${running.id}` };
		if (isThinkingLevel(running.thinking)) route.thinking = running.thinking;
		return route;
	}

	private async runningModel(): Promise<{ provider: string; id: string; thinking?: unknown } | undefined> {
		const response = await this.supervisor.request({ type: "get_state" });
		const state = response.data as { model?: { provider?: unknown; id?: unknown }; thinkingLevel?: unknown };
		if (typeof state?.model?.provider !== "string" || typeof state.model.id !== "string") return undefined;
		return { provider: state.model.provider, id: state.model.id, thinking: state.thinkingLevel };
	}

	/** New credentials: refresh every window, and restart the agent once it is idle so it sees new models. */
	private afterCredentialsChange(): void {
		void this.requireAuth()
			.providers()
			.then(async (providers) =>
				this.broadcast({ type: "auth_providers", providers, ...(await this.voiceCapability()) }),
			)
			.catch((error: Error) => this.log(`could not list providers: ${error.message}`));
		if (this.supervisor.busy) {
			this.restartPending = true;
			return;
		}
		this.restartAgent();
	}

	/** Restarts the engine; changes that arrive during a restart get one more, so the last one is read. */
	private restartAgent(): void {
		this.restartPending = false;
		if (this.restarting) {
			this.restartAgain = true;
			return;
		}
		this.restarting = true;
		this.supervisor
			.restart()
			.catch((error: Error) => this.log(`agent restart failed: ${error.message}`))
			.finally(() => {
				this.restarting = false;
				if (!this.restartAgain) return;
				this.restartAgain = false;
				this.restartAgent();
			});
	}

	/** A profile applied while the assistant was busy switches the model now. */
	private settleModelSwitch(): void {
		void this.liveSwitch.settle().then((outcome) => {
			this.reportSwitch(outcome);
			if (outcome === "switched") this.afterModelSwitch();
		});
	}

	private afterConversationChange(page: HistoryPage = { messages: [], hasEarlier: false }): void {
		this.interrupted = false;
		this.assistantId = undefined;
		this.broadcast({ type: "history", ...this.conversationRef(), ...page });
		this.broadcast(this.conversationsPayload());
	}

	/** After a run settles, replace an oversized session; every window gets the same chat, now marked earlier. */
	private rotateWhenIdle(): void {
		void this.changeConversation(async () => {
			if (!(await this.rotator.maybeRotate())) return;
			this.broadcast({ type: "history", ...this.conversationRef(), ...(await this.currentHistory()) });
		});
	}

	/**
	 * After a run settles: restart if one was asked for, take up a refused request once nothing is on
	 * its way, or rotate an oversized session.
	 */
	private afterRunSettled(): void {
		if (this.restartPending) {
			this.restartAgent();
			return;
		}
		if (this.sending > 0) {
			this.rotationDeferred = true;
			return;
		}
		if (this.pendingRecovery) {
			void this.recoverTurn();
			return;
		}
		// The answer is in: its prompt, and any images it carried, are not needed again.
		this.turn = undefined;
		this.rotateWhenIdle();
	}

	/**
	 * The provider refused the request as too large: continue the same chat in a fresh session and
	 * send the user's message once more, so the answer arrives without the window ever seeing the
	 * failure. Rotation comes first, so the live session holds one copy of the message, and the copy
	 * the window already shows is not sent to it again. One recovery per user message, and none when
	 * that is impossible: the error is shown instead of leaving the chat stalled.
	 */
	private async recoverTurn(): Promise<void> {
		const pending = this.pendingRecovery;
		this.pendingRecovery = undefined;
		if (!pending) return;
		const { id, failed, turn } = pending;
		try {
			// A conversation switch tore the run down: there is nothing left to send again.
			if (this.switchingNow) {
				this.showFailure(failed);
				return;
			}
			// The refused request's chat and model, read before rotation replaces the session: the answer to
			// the re-send is what turns this observation into a ceiling for that model.
			const refused = { bytes: this.sessionBytes(), model: this.supervisor.model };
			this.log("the provider refused the request as too large; continuing the chat in a fresh session");
			if (!(await this.rotator.forceRotate())) {
				this.showFailure(failed);
				return;
			}
			this.broadcast({ type: "history", ...this.conversationRef(), ...(await this.currentHistory()) });
			// Always the refused prompt itself, never a message sent while the rotation was in flight.
			this.awaiting.push({ turn, resend: true });
			turn.refused = refused;
			try {
				await this.supervisor.request({ type: "prompt", ...turn.prompt });
			} catch (error) {
				// Drop only this recovery's own entry: another recovery still in flight keeps its own.
				const index = this.awaiting.findIndex((entry) => entry.turn === turn);
				if (index >= 0) this.awaiting.splice(index, 1);
				turn.refused = undefined;
				this.log(`could not send the message again: ${(error as Error).message}`);
				this.showFailure(failed);
			}
		} finally {
			// Either the message is on its way again or the user was shown the failure: this recovery's own
			// marker is spent. Another recovery still in flight keeps its own.
			this.clearRecovery(id);
		}
	}

	/**
	 * Leaves a marker before the failure is hidden from the chat: a daemon that exits before the
	 * message is sent again would otherwise leave the turn unanswered with nothing to explain it (T9).
	 * The id belongs to this recovery alone, so a later recovery finishing first cannot delete this
	 * notice before it is dispatched. Best effort: a marker that cannot be written means at worst the
	 * old, silent case, never a recovery that is lost because the notice could not be persisted.
	 */
	private markRecovery(): string | undefined {
		const id = randomUUID();
		try {
			addRecoveryOwner(pendingRecoveryFile(this.options.dataDir), id);
			return id;
		} catch (error) {
			this.log(`could not write the recovery marker: ${(error as Error).message}`);
			return undefined;
		}
	}

	/** This recovery reached the engine again, or the user was told: its own marker is spent. */
	private clearRecovery(id: string | undefined): void {
		if (!id) return;
		try {
			removeRecoveryOwner(pendingRecoveryFile(this.options.dataDir), id);
		} catch {
			// Already gone, or not removable: a marker left here only costs one extra warning.
		}
	}

	/**
	 * At startup, a marker the last run left behind means one turn was lost in a window the chat never
	 * saw. The user is told once, through the same channel as every other daemon notice, and every
	 * owner of the marker is dropped so the next run stays silent.
	 */
	private reportLostRecovery(): void {
		const file = pendingRecoveryFile(this.options.dataDir);
		if (!readPendingRecovery(file)) return;
		try {
			rmSync(file, { force: true });
		} catch {
			// Not removable: the next run would warn again, never a lost notice.
		}
		const notice: ServerPayload = { type: "toast", level: "warning", message: LOST_RECOVERY_NOTICE };
		this.notices.push(notice);
		this.broadcast(notice);
	}

	/**
	 * The provider refused a chat of this size for this model and then answered the message sent
	 * again: requests for that model stay under a ceiling a margin below it, which only ever lowers
	 * the configured budget. It is an observation, never a claim about the provider's real limit.
	 */
	private learn(refused: { bytes: number; model: string | undefined }): void {
		const model = refused.model;
		if (!model) return;
		const file = limitsFile(this.options.dataDir);
		// The file can name one model: the one the extension shapes the next request for.
		noteModel(file, this.supervisor.model ?? model);
		const ceiling = recordCeiling(file, model, refused.bytes);
		if (ceiling !== undefined) {
			this.log(
				`learned ceiling for ${model}: requests stay under ${ceiling} bytes (a ${refused.bytes}-byte chat was refused)`,
			);
		}
	}

	private showFailure(failed: { messageId: string; text: string }): void {
		this.broadcast({
			type: "message_done",
			messageId: failed.messageId,
			text: failed.text,
			error: ANSWER_FAILED,
		});
	}

	/**
	 * History replaces what a window shows, so it must not be older than the
	 * messages already sent: read it again when one arrived while loading.
	 */
	private async currentHistory(): Promise<HistoryPage> {
		for (let attempt = 0; ; attempt++) {
			const seen = this.nextMessage;
			// The engine writes a message to its session file right after announcing it;
			// one round trip makes sure everything announced so far is on disk.
			await this.supervisor.request({ type: "get_state" });
			const page = this.engine(() => pageHistory(this.chain(), this.pageSize()));
			if (this.nextMessage === seen || attempt >= 2) return page;
		}
	}

	/** The open chat's session files, oldest first. */
	private chain(): string[] {
		const file = this.supervisor.sessionFile;
		return file ? [...this.supervisor.previousSessions, file] : [];
	}

	private pageSize(): number {
		return this.options.historyPage ?? HISTORY_PAGE;
	}

	private conversationsPayload(): ServerPayload {
		return {
			type: "conversations",
			conversations: this.engine(() => listConversations(this.sessionDir)),
			...this.activeRef(),
		};
	}

	private conversationRef(): { conversationId?: string } {
		const file = this.supervisor.sessionFile;
		return file ? { conversationId: conversationIdOf(this.sessionDir, file) } : {};
	}

	private activeRef(): { activeId?: string } {
		const ref = this.conversationRef();
		return ref.conversationId ? { activeId: ref.conversationId } : {};
	}

	private onAgentEvent(event: SupervisorEvent): void {
		switch (event.type) {
			case "supervisor_state":
				if (event.state !== "ready") {
					this.stopRequested = false;
					this.clearRun();
					this.clearQueue();
				} else {
					this.settleModelSwitch();
					// The engine knows its model only once it is ready; windows that connected
					// earlier (for example while it restarted) would show none until they asked.
					this.broadcastModels();
				}
				break;
			case "interrupted":
				this.interrupted = true;
				this.broadcast({ type: "interrupted" });
				break;
			case "message_start":
				this.onMessageStart(event);
				break;
			case "message_update":
				this.onMessageUpdate(event);
				break;
			case "message_end":
				this.onMessageEnd(event);
				break;
			case "tool_execution_start":
			case "tool_execution_end":
				this.onTool(event);
				break;
			case "queue_update":
				this.onQueueUpdate(event);
				break;
			case "agent_settled":
				// The run may have changed the connector files.
				this.options.connectors?.enforce();
				this.runningTools.clear();
				this.assistantId = undefined;
				this.stopRequested = false;
				// Anything still queued will not be taken by this run.
				this.clearQueue();
				// The title of a new conversation comes from its first message.
				this.broadcast(this.conversationsPayload());
				this.settleModelSwitch();
				this.afterRunSettled();
				break;
			case "extension_ui_request":
				this.onUiRequest(event);
				break;
		}
		this.refreshState();
	}

	/** The engine sends both complete queues on every change. */
	private onQueueUpdate(event: AgentRecord): void {
		const queue = parseQueue(event);
		if (!queue) return;
		const shown = (text: string) => presentText(queuedText(text));
		this.queue = { steering: queue.steering.map(shown), followUp: queue.followUp.map(shown) };
		this.broadcast({ type: "queue", ...this.queue });
	}

	private queued(): boolean {
		return this.queue.steering.length > 0 || this.queue.followUp.length > 0;
	}

	private clearQueue(): void {
		if (!this.queued()) return;
		this.queue = { steering: [], followUp: [] };
		this.broadcast({ type: "queue", ...this.queue });
	}

	/**
	 * The prompt an engine user event belongs to, taken out of the registry so it is attributed once.
	 * The text is the first key; the images the event carries separate prompts that share it. An event
	 * without readable image content only confirms a prompt that carried no images, and a tie is
	 * resolved oldest-first, because that is the order the engine received the prompts — never by
	 * consuming a newer record for an older event. `undefined` means no prompt here matches, so a
	 * legitimate message that merely repeats a recovery's text is not swallowed.
	 */
	private takeAwaiting(raw: string, images: PromptImage[] | undefined): AwaitingTurn | undefined {
		const candidates = this.awaiting.filter((entry) => entry.turn.prompt.message === raw);
		if (candidates.length === 0) return undefined;
		const confirmed =
			images === undefined
				? candidates.filter((entry) => (entry.turn.prompt.images ?? []).length === 0)
				: candidates.filter((entry) => sameImages(entry.turn.prompt.images, images));
		const chosen = confirmed[0];
		if (!chosen) return undefined;
		this.awaiting.splice(this.awaiting.indexOf(chosen), 1);
		return chosen;
	}

	private onMessageStart(event: AgentRecord): void {
		const message = event.message as { role?: string } | undefined;
		// A tool result is a tool in the turn, however the engine reports it.
		if (message?.role === "toolResult") this.toolInTurn = true;
		if (message?.role === "user") {
			// A new user message starts its turn: whatever ran for the previous one is over.
			this.toolInTurn = false;
			const raw = textOf(message);
			// The recovery sends a prompt the window already shows: attribute its failure to that prompt
			// and do not show its message twice. Every other prompt's own message is shown, once.
			const matched = this.takeAwaiting(raw, userMessageImages(message));
			this.turn = matched?.turn;
			if (matched?.resend) return;
			const { text, attachments } = splitAttachments(raw);
			this.broadcast({
				type: "user_message",
				messageId: `u${++this.nextMessage}`,
				text,
				...(attachments.length > 0 ? { attachments } : {}),
			});
		}
		if (message?.role === "assistant") this.assistantId = `m${++this.nextMessage}`;
	}

	private onMessageUpdate(event: AgentRecord): void {
		const update = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
		if (update?.type !== "text_delta" || typeof update.delta !== "string") return;
		this.assistantId ??= `m${++this.nextMessage}`;
		this.broadcast({ type: "message_delta", messageId: this.assistantId, delta: update.delta });
	}

	private onMessageEnd(event: AgentRecord): void {
		const message = event.message as
			| { role?: string; stopReason?: string; errorMessage?: string }
			| undefined;
		if (message?.role === "toolResult") {
			this.toolInTurn = true;
			return;
		}
		if (message?.role !== "assistant") return;
		const messageId = this.assistantId ?? `m${++this.nextMessage}`;
		const text = presentText(textOf(message));
		// The engine ends a stopped answer as "aborted", or as an error when a session switch tore it down.
		if (message.stopReason === "aborted" || (message.stopReason === "error" && this.stopRequested)) {
			// Stopped on purpose: not the answer a ceiling could be learned from.
			if (this.turn !== undefined) this.turn.refused = undefined;
			this.broadcast({ type: "message_done", messageId, text, stopped: true });
		} else if (message.stopReason === "error") {
			this.log(`assistant error: ${message.errorMessage ?? "unknown"}`);
			// A request the provider refused for its size is recovered behind the chat: the window
			// hears nothing until the run settles, and only then when the message can be sent again.
			const turn = this.turn;
			// No failure teaches a ceiling, whether it is the first attempt or the one recovery: only the
			// answer to the message sent again says the refused request was too large for the model.
			if (turn !== undefined) turn.refused = undefined;
			if (turn !== undefined && this.canRecover(turn, message.errorMessage)) {
				turn.recovered = true;
				// The failure is hidden from the chat from here: leave a marker so a restart in the window
				// before the message is sent again still explains what happened (T9). The id belongs to this
				// recovery alone, so a later recovery finishing first cannot delete this notice.
				const id = this.markRecovery();
				this.pendingRecovery = { id, failed: { messageId, text }, turn };
				return;
			}
			this.showFailure({ messageId, text });
		} else {
			// The re-sent message was answered: the request that was refused is too large for this model,
			// so the ceiling it teaches keeps its next requests under it.
			const turn = this.turn;
			if (turn?.refused) {
				this.learn(turn.refused);
				turn.refused = undefined;
			}
			this.broadcast({ type: "message_done", messageId, text });
		}
	}

	/** The one recovery a user message may have, with no tool in the turn. */
	private canRecover(turn: SentTurn, errorMessage: string | undefined): boolean {
		if (this.pendingRecovery !== undefined || turn.recovered || this.toolInTurn) {
			return false;
		}
		// The provider's wording separates size from a plain failure only when it says so. Otherwise the
		// retry is the discriminator: a request whose conversation is already large is sent once more,
		// which succeeds for size and fails for an outage, and that failure is then shown. A small
		// conversation is never retried, so an outage there surfaces immediately and costs nothing.
		return isSizeLimitError(errorMessage) || this.sessionIsLarge();
	}

	/** The live session file's size: larger than the request it carries, so conservative for both uses. */
	private sessionBytes(): number {
		const file = this.supervisor.sessionFile;
		return file ? this.engine(() => sessionFileBytes(file)) : 0;
	}

	/** True when the live session is large enough that its whole request may have been refused. */
	private sessionIsLarge(): boolean {
		return this.sessionBytes() >= recoveryFloorBytes();
	}

	private onTool(event: AgentRecord): void {
		const id = String(event.toolCallId ?? "");
		const started = event.type === "tool_execution_start";
		// A tool ran in this turn: its effects must never be repeated by sending the message again.
		this.toolInTurn = true;
		if (started) this.runningTools.add(id);
		else this.runningTools.delete(id);
		const status = started ? "running" : event.isError ? "failed" : "done";
		// Start and end of one tool call must land on the same message.
		this.assistantId ??= `m${++this.nextMessage}`;
		this.broadcast({
			type: "activity",
			messageId: this.assistantId,
			activity: { id, ...describeTool(String(event.toolName ?? ""), event.args, status), status },
		});
	}

	private onUiRequest(event: AgentRecord): void {
		const method = String(event.method ?? "");
		const requestId = String(event.id ?? "");
		if (method === "notify") {
			const level =
				event.notifyType === "error" ? "error" : event.notifyType === "warning" ? "warning" : "info";
			if (shouldShowToast(level))
				this.broadcast({ type: "toast", level, message: presentText(String(event.message ?? "")) });
			return;
		}
		if (method === "setStatus" && event.statusKey === DRAFT_STATUS_KEY) {
			this.onConnectorDraft(event.statusText);
			return;
		}
		if (!DIALOG_METHODS.has(method) || !requestId) return;
		const ask: Ask = {
			requestId,
			method: method as Ask["method"],
			title: presentText(String(event.title ?? "")),
		};
		const entry: PendingAsk = { ask };
		if (typeof event.message === "string") ask.message = presentText(event.message);
		if (Array.isArray(event.options)) {
			entry.options = event.options.map(String);
			ask.options = entry.options.map(presentText);
		}
		if (typeof event.placeholder === "string") ask.placeholder = presentText(event.placeholder);
		if (typeof event.prefill === "string") ask.prefill = event.prefill;
		if (typeof event.timeout === "number" && event.timeout > 0) {
			ask.timeoutMs = event.timeout;
			// Pi resolves the dialog by itself when it times out; drop it here too.
			entry.timer = setTimeout(() => this.resolveAsk(requestId), event.timeout);
		}
		this.asks.set(requestId, entry);
		this.broadcast({ type: "ask", ask });
	}

	private resolveAsk(requestId: string): void {
		const entry = this.asks.get(requestId);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.asks.delete(requestId);
		// A PIN approval still waiting is refused: declined, timed out, or the run ended.
		this.pinWaiters.get(requestId)?.(false);
		this.pinWaiters.delete(requestId);
		this.broadcast({ type: "ask_resolved", requestId });
		this.refreshState();
	}

	private clearRun(): void {
		for (const requestId of [...this.asks.keys()]) this.resolveAsk(requestId);
		this.runningTools.clear();
		this.assistantId = undefined;
		// No engine left to report these prompts: drop them so a later event cannot match a stale one.
		this.awaiting.length = 0;
	}

	private deriveState(): AgentState {
		switch (this.supervisor.state) {
			case "starting":
				return "starting";
			case "restarting":
				return "restarting";
			case "stopped":
				return "error";
		}
		if (this.asks.size > 0) return "needs_you";
		if (!this.supervisor.busy) return "idle";
		return this.runningTools.size > 0 ? "working" : "thinking";
	}

	private refreshState(): void {
		const next = this.deriveState();
		if (next === this.state) return;
		this.state = next;
		this.broadcast({ type: "agent_state", state: next });
	}

	private alreadySeen(requestId: string): boolean {
		if (this.seenRequestIds.includes(requestId)) return true;
		this.seenRequestIds.push(requestId);
		if (this.seenRequestIds.length > REMEMBERED_REQUEST_IDS) this.seenRequestIds.shift();
		return false;
	}

	private broadcast(payload: ServerPayload): void {
		for (const client of this.clients) this.deliver(client, payload);
	}

	private deliver(client: BridgeClient, payload: ServerPayload): void {
		client.send(payload);
	}

	/** Runs `fn` on the engine's files as the engine's user (server mode). */
	private engine<T>(fn: () => T): T {
		return (this.options.engineAccess ?? directAccess)(fn);
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}

/** A queued message as the user wrote it; files show by name. */
function queuedText(message: string): string {
	const { text, attachments } = splitAttachments(message);
	if (attachments.length === 0) return text;
	const names = `📎 ${attachments.map((a) => a.name).join(", ")}`;
	return text ? `${text}\n${names}` : names;
}

/**
 * The native confirmation for a connector change that widens access, or undefined when it narrows
 * or keeps it (read only, disconnecting, removing, signing in again) or the connector is unknown.
 */
function wideningApproval(
	list: ConnectorInfo[],
	message: Extract<ClientMessage, { connectorId: string }>,
): AppApproval | undefined {
	const info = list.find((c) => c.id === message.connectorId && !c.builtin);
	if (!info) return undefined;
	const name = info.name;
	if (message.type === "connector_mode") {
		if (message.mode !== "read_write" || info.mode === "read_write") return undefined;
		return {
			connector: name,
			action: "read and send",
			title: `Let ${name} read and send?`,
			summary: `The assistant will be able to send, post, and change things in ${name}. It still asks you before each sending action.`,
			preview: [{ name: "Sends", value: info.sends }],
		};
	}
	if ((message.type === "connector_connect" || message.type === "connector_setup") && !info.enabled) {
		return {
			connector: name,
			action: "connect",
			title: `Connect ${name}?`,
			summary: `The assistant will be able to read ${name}. It starts read only.`,
			preview: [{ name: "Reads", value: info.reads }],
		};
	}
	return undefined;
}

/** Approving a connector the assistant drafted: everything that will run or be reached. */
function draftApproval(draft: ConnectorDraft): AppApproval {
	const preview: AppApproval["preview"] = [
		draft.transport === "http"
			? { name: "Address", value: draft.url ?? "" }
			: { name: "Runs on this computer", value: [draft.command, ...(draft.args ?? [])].join(" ") },
		{ name: "Secrets it needs", value: draft.envNames.length > 0 ? draft.envNames.join(", ") : "None" },
	];
	if (draft.description) preview.unshift({ name: "What it does", value: draft.description });
	return {
		connector: draft.name,
		action: "be added",
		title: `Add ${draft.name}?`,
		summary: "The assistant drafted this connector. It starts read only, with all of its tools hidden.",
		preview,
	};
}

/** Importing servers from the user's other apps: each one by name and what it runs. */
function importApproval(chosen: { name: string; summary?: string }[]): AppApproval {
	const count = chosen.length;
	return {
		connector: count === 1 ? (chosen[0]?.name ?? "1 server") : `${count} servers`,
		action: "be imported",
		title: `Import ${count} server${count === 1 ? "" : "s"}?`,
		summary: "They start read only, with all of their tools hidden.",
		preview: chosen.map((c) => ({ name: c.name, value: c.summary ?? "" })),
	};
}
