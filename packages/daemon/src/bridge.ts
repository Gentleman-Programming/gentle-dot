import { randomBytes, randomUUID } from "node:crypto";
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
	isThinkingLevel,
	type MessageQueue,
	type ModelGroup,
	type ModelRef,
	parseClientMessage,
	parseQueue,
	type RoleRoute,
	type ServerPayload,
	type VoiceCapability,
} from "@gentle-dot/protocol";
import type { AppApproval, AppLink } from "./app-channel.ts";
import type { AuthManager } from "./auth.ts";
import type { ConnectorManager, ConnectorRefusal } from "./connectors.ts";
import {
	conversationIdOf,
	type HistoryPage,
	listConversations,
	pageHistory,
	resolveConversation,
} from "./conversations.ts";
import { DRAFT_STATUS_KEY } from "./extensions/approval-guard.ts";
import { describeTool, textOf } from "./presentation.ts";
import {
	LiveModelSwitch,
	ProfileError,
	type ProfileStore,
	type SwitchOutcome,
	splitModel,
	toModelChoices,
	toModelOptions,
} from "./profiles.ts";
import { DEFAULT_ROTATION, type RotationLimits, SessionRotator } from "./rotation.ts";
import type { AgentRecord, AgentSupervisor, SupervisorEvent } from "./supervisor.ts";
import { composePrompt, type StoredFile, splitAttachments, type UploadStore } from "./uploads.ts";
import type { VoiceService } from "./voice.ts";
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
			log: (line) => this.log(line),
		});
		supervisor.onEvent((event) => this.onAgentEvent(event));
		if (options.auth) options.auth.onCredentialsChanged = () => this.afterCredentialsChange();
		if (options.connectors) {
			options.connectors.onChanged = (restart) => this.afterConnectorsChange(restart);
			options.connectors.onBlocked = () => this.connectorChangeBlocked();
			options.connectors.imagesSupported = () => supervisor.modelImages;
		}
		this.state = this.deriveState();
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
		});
		if (this.queued()) this.deliver(client, { type: "queue", ...this.queue });
		for (const { ask } of this.asks.values()) this.deliver(client, { type: "ask", ask });
		for (const draft of this.options.connectors?.drafts() ?? [])
			this.deliver(client, { type: "connector_draft", draft });
		if (this.interrupted) this.deliver(client, { type: "interrupted" });
		return () => {
			this.clients.delete(client);
			this.clientIds.delete(clientId);
			this.options.auth?.cancelOwnedBy(client);
			this.options.connectors?.cancelOwnedBy(client);
		};
	}

	/** A window's message. Connector changes come only from the desktop app (S25.2). */
	async handle(client: BridgeClient, message: ClientMessage): Promise<void> {
		if (isAppCommand(message)) {
			this.deliver(client, { type: "error", code: "app_required", message: APP_REQUIRED });
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
				const prompt =
					files.length > 0
						? composePrompt(message.text, files, { images: this.supervisor.modelImages })
						: { message: message.text };
				this.sending += 1;
				try {
					await this.supervisor.request(
						busy ? { type: "prompt", ...prompt, streamingBehavior: "steer" } : { type: "prompt", ...prompt },
					);
					if (message.attachments) this.options.uploads?.consume(message.attachments);
				} finally {
					this.sending -= 1;
					// The run may have settled before the answer to this prompt was handled.
					if (this.sending === 0 && this.rotationDeferred) {
						this.rotationDeferred = false;
						if (!this.supervisor.busy) this.rotateWhenIdle();
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
				const path = resolveConversation(this.sessionDir, message.conversationId);
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
				if (approve && draft && !(await this.confirmChange(client, draftApproval(draft)))) return;
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
				if (plan.choices.length > 0 && !(await this.confirmChange(client, importApproval(plan.choices))))
					return;
				this.deliver(client, {
					type: "connector_imported",
					names: connectors.importServers(message.ids, plan.servers),
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
					...pageHistory(this.chain(), this.pageSize(), message.before),
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
		this.switching = run.catch(() => {});
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
		if (widening && !(await this.confirmChange(client, widening))) return;
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
	private async confirmChange(client: BridgeClient, request: AppApproval): Promise<boolean> {
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
	 * History replaces what a window shows, so it must not be older than the
	 * messages already sent: read it again when one arrived while loading.
	 */
	private async currentHistory(): Promise<HistoryPage> {
		for (let attempt = 0; ; attempt++) {
			const seen = this.nextMessage;
			// The engine writes a message to its session file right after announcing it;
			// one round trip makes sure everything announced so far is on disk.
			await this.supervisor.request({ type: "get_state" });
			const page = pageHistory(this.chain(), this.pageSize());
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
		return { type: "conversations", conversations: listConversations(this.sessionDir), ...this.activeRef() };
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
				if (this.restartPending) this.restartAgent();
				else if (this.sending > 0) this.rotationDeferred = true;
				else this.rotateWhenIdle();
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

	private onMessageStart(event: AgentRecord): void {
		const message = event.message as { role?: string } | undefined;
		if (message?.role === "user") {
			const { text, attachments } = splitAttachments(textOf(message));
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
		if (message?.role !== "assistant") return;
		const messageId = this.assistantId ?? `m${++this.nextMessage}`;
		const text = presentText(textOf(message));
		// The engine ends a stopped answer as "aborted", or as an error when a session switch tore it down.
		if (message.stopReason === "aborted" || (message.stopReason === "error" && this.stopRequested)) {
			this.broadcast({ type: "message_done", messageId, text, stopped: true });
		} else if (message.stopReason === "error") {
			this.log(`assistant error: ${message.errorMessage ?? "unknown"}`);
			this.broadcast({ type: "message_done", messageId, text, error: ANSWER_FAILED });
		} else {
			this.broadcast({ type: "message_done", messageId, text });
		}
	}

	private onTool(event: AgentRecord): void {
		const id = String(event.toolCallId ?? "");
		const started = event.type === "tool_execution_start";
		if (started) this.runningTools.add(id);
		else this.runningTools.delete(id);
		const status = started ? "running" : event.isError ? "failed" : "done";
		// Start and end of one tool call must land on the same message.
		this.assistantId ??= `m${++this.nextMessage}`;
		this.broadcast({
			type: "activity",
			messageId: this.assistantId,
			activity: { id, ...describeTool(String(event.toolName ?? ""), event.args), status },
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
		this.broadcast({ type: "ask_resolved", requestId });
		this.refreshState();
	}

	private clearRun(): void {
		for (const requestId of [...this.asks.keys()]) this.resolveAsk(requestId);
		this.runningTools.clear();
		this.assistantId = undefined;
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
