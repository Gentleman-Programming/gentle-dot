/**
 * Meta Cloud API Transport Implementation
 * Uses Meta's Graph API for WhatsApp Business Cloud API
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelTransport, ChannelInbound, TransportStateEvent, MetaCloudConfig } from "./types.js";

export function createMetaCloudTransport(options: {
  authDir: string;
  allowedNumbers: Set<string>;
  log?(m: string): void;
  meta: MetaCloudConfig;
}): ChannelTransport {
  const log = options.log ?? (() => {});
  const meta = options.meta;
  let handler: ((message: ChannelInbound) => void) | undefined;
  let stateHandler: ((event: TransportStateEvent) => void) | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  const verifySignature = (signature: string, body: string): boolean => {
    const expected = createHmac("sha256", meta.appSecret).update(body).digest("hex");
    const provided = signature.replace("sha256=", "");
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
    } catch {
      return false;
    }
  };

  const sendGraphRequest = async (endpoint: string, body: unknown): Promise<unknown> => {
    const url = `${meta.graphUrl}/${meta.graphVersion}/${endpoint}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${meta.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Graph API ${response.status}: ${errorText}`);
    }
    return response.json();
  };

  return {
    onMessage(h) {
      handler = h;
    },
    onState(h) {
      stateHandler = h;
    },
    async start() {
      // Meta Cloud doesn't need QR pairing - uses webhook verification
      log("Meta Cloud transport starting...");
      stateHandler?.({ kind: "open", number: meta.phoneNumberId });

      // Start webhook server
      server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "", `http://${meta.webhookHost}:${meta.webhookPort}`);
        
        if (req.method === "GET" && url.pathname === "/webhook") {
          // Webhook verification
          const mode = url.searchParams.get("hub.mode");
          const challenge = url.searchParams.get("hub.challenge");
          const verifyToken = url.searchParams.get("hub.verify_token");
          
          if (mode === "subscribe" && verifyToken === meta.verifyToken) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(challenge ?? "");
            log("Webhook verified successfully");
          } else {
            res.writeHead(403);
            res.end("Forbidden");
          }
          return;
        }

        if (req.method === "POST" && url.pathname === "/webhook") {
          let body = "";
          for await (const chunk of req) body += chunk;
          
          const signature = req.headers["x-hub-signature-256"] as string;
          if (!signature || !verifySignature(signature, body)) {
            res.writeHead(403);
            res.end("Invalid signature");
            return;
          }

          try {
            const payload = JSON.parse(body);
            
            // Process WhatsApp messages
            if (payload.object === "whatsapp_business_account") {
              for (const entry of payload.entry) {
                for (const change of entry.changes) {
                  if (change.field === "messages" && change.value.messages) {
                    for (const message of change.value.messages) {
                      if (message.type === "text" && message.text?.body) {
                        const from = message.from; // Already in E.164 format without +
                        if (options.allowedNumbers.has(from)) {
                          handler?.({ from, id: message.id, text: message.text.body });
                        } else {
                          log(`ignored: not allowlisted (…${from.slice(-4)})`);
                        }
                      }
                    }
                  }
                }
              }
            }
            
            res.writeHead(200);
            res.end("OK");
          } catch (error) {
            log(`webhook processing error: ${(error as Error).message}`);
            res.writeHead(500);
            res.end("Error");
          }
          return;
        }

        res.writeHead(404);
        res.end("Not Found");
      });

      await new Promise<void>((resolve) => {
        server!.listen(meta.webhookPort, meta.webhookHost, () => {
          log(`Meta Cloud webhook listening on ${meta.webhookHost}:${meta.webhookPort}/webhook`);
          resolve();
        });
      });
    },
    async sendText(toNumber, text) {
      await sendGraphRequest(`${meta.phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        to: toNumber,
        type: "text",
        text: { body: text },
      });
    },
    async stop() {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    },
  };
}
