/**
 * Utility functions for Telegram bridge
 */

import { Buffer } from 'node:buffer';

export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

/** Splits text into chunks of at most `limit` characters, at a line break when one is close. */
export function splitMessage(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const breakAt = rest.lastIndexOf('\n', limit);
    const cut = breakAt > limit / 2 ? breakAt : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest !== '') chunks.push(rest);
  return chunks;
}

/**
 * Downloads from the Bot API file endpoint, giving up after `timeoutMs`.
 * Errors never carry the address, which holds the token.
 */
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
      throw new Error(signal.aborted ? 'timed out' : 'network error');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
}

export const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
};