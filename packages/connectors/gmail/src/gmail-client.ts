import { google, gmail_v1 } from "googleapis";
import { getValidAccessToken, createOAuth2Client } from "./auth/token-store.js";

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType: string;
      body: { data?: string };
      parts?: any[];
    }>;
  };
  internalDate: string;
}

export interface SendMessageParams {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
}

export class GmailClient {
  private gmail: gmail_v1.Gmail;
  private oauthConfig: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  private tokenStore: any; // GmailTokenStore

  constructor(
    oauthConfig: { clientId: string; clientSecret: string; redirectUri: string },
    tokenStore: any
  ) {
    this.gmail = google.gmail({ version: "v1" });
    this.oauthConfig = oauthConfig;
    this.tokenStore = tokenStore;
  }

  private async getAuthClient() {
    const accessToken = await getValidAccessToken(this.tokenStore, createOAuth2Client(this.oauthConfig));
    const oauth2Client = createOAuth2Client(this.oauthConfig);
    oauth2Client.setCredentials({ access_token: accessToken });
    return oauth2Client;
  }

  /** List messages matching query */
  async listMessages(query: string, maxResults = 10): Promise<GmailMessage[]> {
    const oauth2Client = await this.getAuthClient();
    const res = await this.gmail.users.messages.list({
      auth: oauth2Client,
      userId: "me",
      q: query,
      maxResults,
    });
    const messageList = res.data.messages || [];

    // Get full message details
    const messages = await Promise.all(
      messageList.map(async (m): Promise<GmailMessage | null> => {
        if (!m.id) return null;
        return this.getMessage(m.id);
      })
    );
    return messages.filter((m): m is GmailMessage => m !== null);
  }

  /** Get a single message by ID */
  async getMessage(id: string): Promise<GmailMessage | null> {
    try {
      const oauth2Client = await this.getAuthClient();
      const res = await this.gmail.users.messages.get({
        auth: oauth2Client,
        userId: "me",
        id,
        format: "full",
      });
      return res.data as GmailMessage;
    } catch (e) {
      console.error(`Failed to get message ${id}:`, e);
      return null;
    }
  }

  /** Send an email message */
  async sendMessage(params: SendMessageParams): Promise<string | null> {
    try {
      const oauth2Client = await this.getAuthClient();

      // Build MIME message
      const messageParts = [
        `To: ${params.to}`,
        `Subject: ${params.subject}`,
        "Content-Type: text/plain; charset=UTF-8",
        "MIME-Version: 1.0",
        "",
        params.body,
      ];

      if (params.inReplyTo) {
        messageParts.splice(2, 0, `In-Reply-To: ${params.inReplyTo}`);
      }
      if (params.threadId) {
        messageParts.splice(2, 0, `References: ${params.threadId}`);
      }

      const message = messageParts.join("\r\n");
      const encodedMessage = Buffer.from(message).toString("base64url");

      const res = await this.gmail.users.messages.send({
        auth: oauth2Client,
        userId: "me",
        requestBody: {
          raw: encodedMessage,
          threadId: params.threadId,
        },
      });

      return res.data.id || null;
    } catch (e) {
      console.error("Failed to send message:", e);
      return null;
    }
  }

  /** Set up Gmail push notifications (watch) */
  async watch(webhookUrl: string, labelIds = ["INBOX"]): Promise<{ expiration: string; historyId: string }> {
    const oauth2Client = await this.getAuthClient();
    const res = await this.gmail.users.watch({
      auth: oauth2Client,
      userId: "me",
      requestBody: {
        topicName: webhookUrl,
        labelIds,
      },
    });
    return {
      expiration: res.data.expiration!,
      historyId: res.data.historyId!,
    };
  }

  /** Get history of changes since historyId */
  async getHistory(historyId: string): Promise<any[]> {
    const oauth2Client = await this.getAuthClient();
    const res = await this.gmail.users.history.list({
      auth: oauth2Client,
      userId: "me",
      startHistoryId: historyId,
    });
    return res.data.history || [];
  }
}

export function extractTextFromMessage(message: GmailMessage): string {
  const payload = message.payload;

  // Try body.data first
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }

  // Check parts
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf8");
      }
      // Recursively check nested parts
      if (part.parts) {
        for (const subPart of part.parts) {
          if (subPart.mimeType === "text/plain" && subPart.body?.data) {
            return Buffer.from(subPart.body.data, "base64url").toString("utf8");
          }
        }
      }
    }
  }

  return message.snippet || "";
}

export function getHeader(message: GmailMessage, name: string): string | undefined {
  return message.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
}
