/**
 * Gmail connector — contract tests (doc 07: OAuth + webhook + token store).
 * Exercises the webhook surfaces over HTTP-shaped payloads, as Gmail's Pub/Sub sends them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyGmailSignature, parseGmailNotification, formatEmailNotification } from '../src/webhook/verification.js';
import { GmailTokenStore, getValidAccessToken } from '../src/auth/token-store.js';

const SECRET = 'test-webhook-secret';

/** Builds a Gmail Pub/Sub push envelope: the notification payload, base64-encoded inside the message. */
function pubsub(data: object): string {
  return JSON.stringify({ message: { data: Buffer.from(JSON.stringify(data)).toString('base64'), messageId: 'msg-1' } });
}

/** Signs a body the way Gmail's push does (HMAC-SHA256 over the raw bytes). */
function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('base64')}`;
}

describe('Gmail webhook verification', () => {
  const body = pubsub({ emailAddress: 'me@gmail.com', historyId: '12345' });

  it('accepts a valid HMAC signature', () => {
    expect(verifyGmailSignature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  it('rejects a signature computed with a different secret', () => {
    expect(verifyGmailSignature(body, sign(body, 'other-secret'), SECRET)).toBe(false);
  });

  it('rejects a tampered body', () => {
    // The signature was computed over the original envelope; the attacker re-encoded the payload
    // with their own address — the signature no longer matches.
    const tampered = pubsub({ emailAddress: 'attacker@gmail.com', historyId: '12345' });
    expect(verifyGmailSignature(tampered, sign(body, SECRET), SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyGmailSignature(body, undefined, SECRET)).toBe(false);
  });

  it('rejects a signature with the wrong algorithm', () => {
    expect(verifyGmailSignature(body, `md5=${sign(body, SECRET).slice('sha256='.length)}`, SECRET)).toBe(false);
  });
});

describe('Gmail webhook notification parsing', () => {
  it('parses a Pub/Sub envelope into emailAddress + historyId', () => {
    const parsed = parseGmailNotification(JSON.parse(pubsub({ emailAddress: 'me@gmail.com', historyId: '12345' })));
    expect(parsed).toEqual({ emailAddress: 'me@gmail.com', historyId: '12345' });
  });

  it('returns null when the envelope carries no data', () => {
    expect(parseGmailNotification({})).toBeNull();
  });

  it('returns null when the payload lacks the required fields', () => {
    expect(parseGmailNotification({ message: { data: Buffer.from(JSON.stringify({ nope: true })).toString('base64') } })).toBeNull();
  });
});

describe('Gmail email notification formatting', () => {
  const message = {
    id: 'msg-1',
    threadId: 'thread-1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Hello there',
    internalDate: '1700000000000',
    payload: {
      headers: [
        { name: 'From', value: 'sender@example.com' },
        { name: 'To', value: 'me@example.com' },
        { name: 'Subject', value: 'Test Subject' },
      ],
      body: { data: Buffer.from('Hello world').toString('base64url') },
    },
  };

  it('formats the fields the channel_notify carries', () => {
    const formatted = formatEmailNotification(message);
    expect(formatted.from).toBe('sender@example.com');
    expect(formatted.to).toEqual(['me@example.com']);
    expect(formatted.subject).toBe('Test Subject');
    expect(formatted.threadId).toBe('thread-1');
    expect(formatted.messageId).toBe('msg-1');
    expect(formatted.labels).toEqual(['INBOX', 'UNREAD']);
  });

  it('falls back to Unknown when the From header is missing', () => {
    const noFrom = { ...message, payload: { headers: [{ name: 'To', value: 'me@example.com' }] } };
    expect(formatEmailNotification(noFrom).from).toBe('Unknown');
  });
});

describe('Gmail token store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-tokens-'));
  const tokenPath = join(dir, 'tokens.json');
  let store: GmailTokenStore;

  const tokens = {
    access_token: 'ya29.test',
    refresh_token: '1//test-refresh',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    token_type: 'Bearer',
    expiry_date: Date.now() + 3_600_000,
  };

  beforeEach(() => {
    store = new GmailTokenStore(tokenPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no tokens were saved', () => {
    expect(store.load()).toBeNull();
  });

  it('saves and loads tokens back', () => {
    store.save(tokens);
    expect(store.load()).toEqual(tokens);
  });

  it('persists tokens with private file modes', async () => {
    store.save(tokens);
    const stat = (await import('node:fs')).statSync(tokenPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('detects expired tokens with a 1-minute buffer', () => {
    const expired = { ...tokens, expiry_date: Date.now() - 1000 };
    expect(store.isExpired(expired)).toBe(true);
    const fresh = { ...tokens, expiry_date: Date.now() + 3_600_000 };
    expect(store.isExpired(fresh)).toBe(false);
  });
});

describe('Gmail token refresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-refresh-'));
  const tokenPath = join(dir, 'tokens.json');

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to refresh without a refresh token', async () => {
    const store = new GmailTokenStore(tokenPath);
    store.save({
      access_token: 'expired',
      refresh_token: '',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      token_type: 'Bearer',
      expiry_date: Date.now() - 1000,
    });
    await expect(getValidAccessToken(store, {} as never)).rejects.toThrow('No refresh token available');
  });

  it('returns the stored access token while it is still valid', async () => {
    const store = new GmailTokenStore(tokenPath);
    const fresh = {
      access_token: 'ya29.valid',
      refresh_token: '1//keep',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      token_type: 'Bearer',
      expiry_date: Date.now() + 3_600_000,
    };
    store.save(fresh);
    expect(await getValidAccessToken(store, {} as never)).toBe('ya29.valid');
  });
});
