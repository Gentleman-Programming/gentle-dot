import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies the HMAC signature of a Gmail webhook request.
 * Gmail sends an X-Goog-Signature header with an HMAC-SHA256 of the raw body, keyed by the
 * webhook secret. The signature travels as `sha256=<base64>`.
 */
export function verifyGmailSignature(
  body: string | Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const separator = signatureHeader.indexOf('=');
  if (separator === -1) return false;
  const algorithm = signatureHeader.slice(0, separator);
  const signature = signatureHeader.slice(separator + 1);
  if (algorithm !== 'sha256' || !signature) return false;

  const expectedSignature = createHmac('sha256', secret).update(body).digest('base64');

  const signatureBuffer = Buffer.from(signature, 'base64');
  const expectedBuffer = Buffer.from(expectedSignature, 'base64');

  if (signatureBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(signatureBuffer, expectedBuffer);
}

/**
 * Extracts the notification from a Gmail Pub/Sub push envelope:
 * `{ message: { data: base64(JSON.stringify({ emailAddress, historyId })) } }`.
 * Returns null on any malformed input — the webhook answers 400 and Gmail retries.
 */
export function parseGmailNotification(envelope: unknown): {
  emailAddress: string;
  historyId: string;
} | null {
  try {
    const message = (envelope as { message?: { data?: unknown } }).message;
    if (typeof message?.data !== 'string') return null;

    const decoded = Buffer.from(message.data, 'base64').toString('utf-8');
    const notification = JSON.parse(decoded) as {
      emailAddress?: unknown;
      historyId?: unknown;
    };
    if (typeof notification.emailAddress !== 'string' || typeof notification.historyId !== 'string') {
      return null;
    }
    return { emailAddress: notification.emailAddress, historyId: notification.historyId };
  } catch {
    return null;
  }
}

/** Extracts one header from a Gmail message payload, case-insensitively. */
function header(message: { payload?: { headers?: Array<{ name?: string; value?: string }> } }, name: string): string | undefined {
  const header = message.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value;
}

/**
 * Formats the email fields the channel_notify carries (S25.4: the daemon notifies, the engine
 * narrates). Unknown senders are safe to show.
 */
export function formatEmailNotification(message: {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: Array<{ name?: string; value?: string }> };
}): {
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
  threadId: string;
  messageId: string;
} {
  const from = header(message, 'From') ?? 'Unknown';
  const toHeader = header(message, 'To') ?? '';
  const internalDate = message.internalDate ?? '';

  return {
    from,
    to: toHeader.split(',').map((e) => e.trim()).filter(Boolean),
    subject: header(message, 'Subject') ?? '(No subject)',
    snippet: message.snippet ?? '',
    date: internalDate ? new Date(parseInt(internalDate)).toLocaleString() : '',
    labels: message.labelIds ?? [],
    threadId: message.threadId ?? '',
    messageId: message.id ?? '',
  };
}
