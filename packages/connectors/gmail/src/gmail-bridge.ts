/**
 * Gmail Bridge - Extends BaseBridge from @gentle-dot/bridges-base
 * Uses Gmail API with OAuth2 for real-time email notifications via history polling
 */

import { readFileSync } from "node:fs";
import {
	BaseBridge,
	type BridgeConfig,
	type CommandPayload,
	type CommandResultPayload,
} from "@gentle-dot/bridges-base";
import {
	createOAuth2Client,
	exchangeCodeForTokens,
	GmailTokenStore,
	generateAuthUrl,
	getValidAccessToken,
} from "./auth/token-store.js";
import { extractTextFromMessage, GmailClient, getHeader } from "./gmail-client.js";

const SOURCE_LABEL = "📧 [Gmail] ";
const MAX_NOTIFY_TEXT = 4000;

// Watch expires after 7 days (604800 seconds), renew at 6 days (518400 seconds)
const WATCH_EXPIRATION_SECONDS = 604800;
const WATCH_RENEWAL_SECONDS = 518400;

export interface GmailBridgeOptions {
	config: Config;
	log(message: string): void;
}

export class GmailBridge extends BaseBridge {
	private gmailClient: GmailClient;
	private tokenStore: GmailTokenStore;
	private oauth2Client: ReturnType<typeof createOAuth2Client>;
	private options: GmailBridgeOptions;
	private logFn: (message: string) => void;

	// State
	private historyId: string | null = null;
	private pollInterval: NodeJS.Timeout | null = null;
	private connected = false;
	private shouldPoll = true;

	// Watch renewal timer
	private watchRenewalInterval: NodeJS.Timeout | null = null;
	private watchExpiration: number | null = null;

	constructor(options: GmailBridgeOptions) {
		// Read daemon's access token from token file for WebSocket authentication
		const tokenFile = options.config.tokenFile;
		let daemonToken = "";
		try {
			daemonToken = readFileSync(tokenFile, "utf8").trim();
		} catch {
			// logFn not available yet, will log after super()
		}

		const bridgeConfig: BridgeConfig = {
			daemonUrl: options.config.daemonUrl,
			connectorId: options.config.connectorId ?? "gmail",
			connectorType: "gmail",
			token: daemonToken,
			capabilities: ["channel_notify", "message_send", "connector_command", "gmail_watch"],
			metadata: {
				version: "1.0.0",
				provider: "gmail-api",
				features: ["history_polling", "send_message", "watch_labels"],
			},
		};

		super(bridgeConfig);

		this.options = options;
		this.logFn = options.log;
		this.tokenStore = new GmailTokenStore(options.config.tokenPath);
		this.oauth2Client = createOAuth2Client({
			clientId: options.config.oauth.clientId,
			clientSecret: options.config.oauth.clientSecret,
			redirectUri: options.config.oauth.redirectUri,
		});
		this.gmailClient = new GmailClient(
			{
				clientId: options.config.oauth.clientId,
				clientSecret: options.config.oauth.clientSecret,
				redirectUri: options.config.oauth.redirectUri,
			},
			this.tokenStore,
		);

		if (!daemonToken) {
			this.logFn(`Warning: could not read daemon token from ${tokenFile}`);
		}
	}

	// ============ BaseBridge Abstract Methods ============

	async onReady(): Promise<void> {
		this.logFn("Gmail bridge ready - starting history polling");
		this.connected = true;
		await this.startHistoryPolling();
		// Set up Gmail push notifications watch if webhook URL is configured
		if (this.options.config.webhookUrl) {
			await this.setupWatch();
			this.startWatchRenewalTimer();
		}
	}

	async onStop(): Promise<void> {
		this.logFn("Gmail bridge stopping");
		this.connected = false;
		this.shouldPoll = false;
		this.stopHistoryPolling();
		this.stopWatchRenewalTimer();
	}

	// ============ BaseBridge Overrides ============

	protected override sendHello(): void {
		const payload: HelloPayload = {
			token: this.config.token,
			protocol: 1,
			capabilities: this.config.capabilities,
			connectorType: this.config.connectorType,
			connectorId: this.config.connectorId,
			metadata: this.config.metadata,
		};
		this.send("hello", payload);
	}

	protected override handleConnectorMessage(message: BridgeMessage): void {
		this.dispatch(message);
	}

	private dispatch(message: { type: string; payload: unknown }): void {
		this.logFn(`dispatch: type=${message.type}`);
		switch (message.type) {
			case "ready": {
				const ready = message.payload as ReadyPayload;
				this.logFn(`Daemon ready, session: ${ready.sessionId}`);
				break;
			}
			case "agent_state": {
				break;
			}
			case "channel_notify": {
				break;
			}
			case "command": {
				const payload = message.payload as CommandPayload;
				this.logFn(`dispatch: command action=${payload.action}, id=${payload.commandId}`);
				void this.handleCommand(payload).catch((e) => {
					this.logFn(`handleCommand error: ${(e as Error).message}`);
				});
				break;
			}
			case "error": {
				const payload = message.payload as { code: string; message: string };
				if (payload.code === "unauthorized") {
					this.logFn("Daemon rejected token, attempting re-auth");
					// Re-auth: clean reconnect re-hello after the daemon cleaned up the old registration.
					void this.disconnect().then(() => this.connect());
				}
				break;
			}
			default:
				return;
		}
	}

	// ============ Gmail-Specific Methods ============

	private async startHistoryPolling(): Promise<void> {
		this.shouldPoll = true;

		// Initial history ID fetch
		await this.fetchInitialHistoryId();

		// Start polling
		this.pollInterval = setInterval(() => {
			if (this.shouldPoll && this.connected) {
				void this.pollGmailHistory();
			}
		}, this.options.config.pollIntervalMs);

		// Initial poll
		await this.pollGmailHistory();
	}

	private stopHistoryPolling(): void {
		this.shouldPoll = false;
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async fetchInitialHistoryId(): Promise<void> {
		try {
			const accessToken = await getValidAccessToken(this.tokenStore, this.oauth2Client);
			this.oauth2Client.setCredentials({ access_token: accessToken });
			const gmail = (await import("googleapis")).google.gmail({ version: "v1", auth: this.oauth2Client });

			const profile = await gmail.users.getProfile({ userId: "me" });
			this.historyId = profile.data.historyId || null;

			if (!this.historyId) {
				this.logFn("No history ID available, will start from current");
			} else {
				this.logFn(`Initial historyId: ${this.historyId}`);
			}
		} catch (e) {
			this.logFn(`Failed to fetch initial historyId: ${(e as Error).message}`);
		}
	}

	private async pollGmailHistory(): Promise<void> {
		if (!this.historyId || !this.connected) return;

		try {
			const history = await this.gmailClient.getHistory(this.historyId);

			for (const event of history) {
				if (event.messagesAdded) {
					for (const msgAdded of event.messagesAdded) {
						if (msgAdded.message?.id) {
							await this.handleNewMessage(msgAdded.message.id);
						}
					}
				}
			}

			// Update historyId to latest
			if (history.length > 0) {
				const lastEvent = history[history.length - 1];
				if (lastEvent && "historyId" in lastEvent) {
					this.historyId = lastEvent.historyId as string;
				}
			}
		} catch (e) {
			this.logFn(`Error polling Gmail history: ${(e as Error).message}`);
		}
	}

	private async handleNewMessage(messageId: string): Promise<void> {
		try {
			const message = await this.gmailClient.getMessage(messageId);
			if (!message) {
				this.logFn(`Failed to get message: ${messageId}`);
				return;
			}

			const text = extractTextFromMessage(message);
			const from = getHeader(message, "From") || "Unknown";
			const subject = getHeader(message, "Subject") || "(No subject)";
			const date = new Date(parseInt(message.internalDate, 10)).toLocaleString();

			// Truncate if too long
			const notifyText = text.length > MAX_NOTIFY_TEXT ? `${text.substring(0, MAX_NOTIFY_TEXT)}...` : text;

			const channelNotify = {
				type: "channel_notify",
				channelId: "gmail",
				text: `${SOURCE_LABEL}${from}\n📅 ${date}\n📌 ${subject}\n\n${notifyText}`,
			};

			this.send(channelNotify.type, channelNotify);
			this.logFn(`Sent channel_notify for message: ${messageId}`);
		} catch (e) {
			this.logFn(`Error handling new message: ${(e as Error).message}`);
		}
	}

	// ============ Watch Setup and Renewal ============

	/** Set up Gmail push notifications watch */
	private async setupWatch(): Promise<void> {
		if (!this.options.config.webhookUrl) return;

		try {
			this.logFn(`Setting up Gmail watch for ${this.options.config.watchLabels.join(", ")}`);
			const watchResult = await this.gmailClient.watch(
				this.options.config.webhookUrl,
				this.options.config.watchLabels,
			);
			this.watchExpiration =
				Date.now() + (parseInt(watchResult.expiration, 10) - Date.now()) ||
				Date.now() + WATCH_EXPIRATION_SECONDS * 1000;
			this.logFn(`Gmail watch set up successfully, expires: ${new Date(this.watchExpiration).toISOString()}`);
		} catch (e) {
			this.logFn(`Failed to set up Gmail watch: ${(e as Error).message}`);
		}
	}

	/** Start the watch renewal timer (renew at 6 days) */
	private startWatchRenewalTimer(): void {
		// Check every hour if renewal is needed
		this.watchRenewalInterval = setInterval(
			() => {
				if (
					this.watchExpiration &&
					Date.now() > this.watchExpiration - (WATCH_EXPIRATION_SECONDS - WATCH_RENEWAL_SECONDS) * 1000
				) {
					this.logFn("Gmail watch approaching expiration, renewing...");
					void this.setupWatch();
				}
			},
			60 * 60 * 1000,
		); // Check every hour
	}

	/** Stop the watch renewal timer */
	private stopWatchRenewalTimer(): void {
		if (this.watchRenewalInterval) {
			clearInterval(this.watchRenewalInterval);
			this.watchRenewalInterval = null;
		}
		this.watchExpiration = null;
	}

	// ============ Command Handling ============

	protected async handleCommand(payload: CommandPayload): Promise<void> {
		let result: CommandResultPayload = {
			commandId: payload.commandId,
			success: false,
		};

		try {
			switch (payload.action) {
				case "send_message": {
					const { to, subject, body, threadId, inReplyTo } = payload.params as {
						to: string;
						subject: string;
						body: string;
						threadId?: string;
						inReplyTo?: string;
					};
					const messageId = await this.gmailClient.sendMessage({ to, subject, body, threadId, inReplyTo });
					result = {
						commandId: payload.commandId,
						success: !!messageId,
						result: { messageId },
					};
					break;
				}
				case "list_messages": {
					const { query, maxResults } = payload.params as { query: string; maxResults?: number };
					const messages = await this.gmailClient.listMessages(query, maxResults);
					result = {
						commandId: payload.commandId,
						success: true,
						result: { messages },
					};
					break;
				}
				case "get_message": {
					const { id } = payload.params as { id: string };
					const message = await this.gmailClient.getMessage(id);
					result = {
						commandId: payload.commandId,
						success: !!message,
						result: { message },
					};
					break;
				}
				case "setup_watch": {
					const { webhookUrl, labelIds } = payload.params as { webhookUrl: string; labelIds?: string[] };
					const watchResult = await this.gmailClient.watch(webhookUrl, labelIds);
					result = {
						commandId: payload.commandId,
						success: true,
						result: watchResult,
					};
					break;
				}
				case "webhook_notification": {
					// Trigger a history poll when a webhook notification arrives
					await this.pollGmailHistory();
					result = {
						commandId: payload.commandId,
						success: true,
						result: { polled: true },
					};
					break;
				}
				case "handle_oauth_callback": {
					const { code } = payload.params as { code: string };
					try {
						await this.handleOAuthCallback(code);
						result = {
							commandId: payload.commandId,
							success: true,
							result: { tokens_saved: true },
						};
					} catch (e) {
						result = {
							commandId: payload.commandId,
							success: false,
							error: (e as Error).message,
						};
					}
					break;
				}
				default:
					result = {
						commandId: payload.commandId,
						success: false,
						error: `Unknown action: ${payload.action}`,
					};
			}
		} catch (e) {
			result = {
				commandId: payload.commandId,
				success: false,
				error: (e as Error).message,
			};
		}

		this.send("command_result", result);
	}

	// ============ OAuth2 Helpers ============

	/** Get authorization URL for OAuth2 flow */
	getAuthUrl(): string {
		return generateAuthUrl(this.oauth2Client, this.options.config.oauth.scopes);
	}

	/** Exchange authorization code for tokens */
	async handleOAuthCallback(code: string): Promise<void> {
		const tokens = await exchangeCodeForTokens(this.oauth2Client, code);
		this.tokenStore.save(tokens);
		this.oauth2Client.setCredentials(tokens);
		this.logFn("OAuth tokens saved successfully");
		// Fresh credentials require a clean reconnect: the daemon cleans up the old
		// registration on close, so the next hello registers with the new token.
		if (this.isReady()) {
			await this.disconnect();
			await this.connect();
		}
	}

	// ============ Public API ============

	async start(): Promise<void> {
		// Load existing tokens if any
		const existingTokens = this.tokenStore.load();
		if (existingTokens) {
			this.oauth2Client.setCredentials(existingTokens);
		} else {
			this.logFn("No tokens found. OAuth flow required.");
			this.logFn(`Auth URL: ${this.getAuthUrl()}`);
		}

		// Ensure daemon token is current (read from token file)
		try {
			this.config.token = readFileSync(this.options.config.tokenFile, "utf8").trim();
		} catch {
			this.logFn(`Warning: could not read daemon token from ${this.options.config.tokenFile}`);
		}

		await this.connect();
	}

	async shutdown(): Promise<void> {
		await this.onStop();
		await this.disconnect();
	}

	async getBridgeStatus(): Promise<{
		uptime: number;
		connected: boolean;
		hasTokens: boolean;
		historyId: string | null;
	}> {
		const tokens = this.tokenStore.load();
		return {
			uptime: process.uptime(),
			connected: this.connected,
			hasTokens: !!tokens,
			historyId: this.historyId,
		};
	}

	/** Manually trigger a history poll (for testing) */
	async triggerPoll(): Promise<void> {
		await this.pollGmailHistory();
	}
}
