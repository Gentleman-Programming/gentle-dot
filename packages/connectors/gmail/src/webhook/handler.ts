import { Router, type Request, type Response, type NextFunction } from "express";
import { verifyGmailSignature, parseGmailNotification } from "./verification.js";

let bodyParser: any;

async function getBodyParser() {
  if (!bodyParser) {
    const { raw } = await import("body-parser");
    bodyParser = raw({ type: "application/json", limit: "10mb" });
  }
  return bodyParser;
}

/**
 * Gmail Webhook Handler
 * 
 * Handles incoming Gmail push notifications via Google Cloud Pub/Sub push.
 */
export async function createGmailWebhookHandler(
  onNotification: (notification: {
    emailAddress: string;
    historyId: string;
  }) => Promise<void>,
  webhookSecret: string
): Promise<Router> {
  const router = Router();
  const rawBodyParser = await getBodyParser();

  return router.post("/webhook/gmail", rawBodyParser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Verify the signature
      const signature = (req.headers["x-goog-signature"] as string) || "";
      if (!verifyGmailSignature(req.body, signature, process.env.GMAIL_WEBHOOK_SECRET || "")) {
        console.error("[Gmail Webhook] Invalid signature");
        return res.status(401).send("Invalid signature");
      }

      // Parse the notification
      const notification = parseGmailNotification(req.body);
      if (!notification) {
        console.error("[Gmail Webhook] Failed to parse notification");
        return res.status(400).send("Invalid notification format");
      }

      console.log(`[Gmail] Webhook received for ${notification.emailAddress}, historyId: ${notification.historyId}`);

      // Process the notification asynchronously
      try {
        await onNotification(notification);
      } catch (error) {
        console.error("[Gmail] Error processing notification:", error);
        // Don't fail the webhook - Gmail will retry
      }

      res.status(204).send();
    } catch (error) {
      console.error("[Gmail Webhook] Error:", error);
      res.status(500).send("Internal server error");
    }
  });

  return router;
}