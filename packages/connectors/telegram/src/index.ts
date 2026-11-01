/**
 * Telegram Connector Entry Point
 * Bridge nativo para Telegram usando grammY
 */

import { TelegramBridge } from './telegram-bridge';
import { loadTelegramConfig, TelegramConnectorConfig } from './config';
import { DaemonClient } from './daemon-client';

const log = (message: string) => console.error(`[telegram] ${message}`);

function main(): void {
  let config: TelegramConnectorConfig;
  try {
    config = loadTelegramConfig();
  } catch (error) {
    if (error instanceof Error && 'ConfigError' in error) {
      log(error.message);
      process.exit(1);
    }
    throw error;
  }

  process.on('unhandledRejection', (error) => log(`unexpected error: ${(error as Error)?.message ?? String(error)}`));

  const bridge = new TelegramBridge({
    config,
    log,
    // upload will be set by DaemonClient
    upload: async () => {
      throw new Error('upload not configured yet');
    },
  });

  let failed = false;
  const daemon = new DaemonClient({
    url: config.daemonUrl,
    tokenFile: config.tokenFile,
    log,
    onMessage: (message) => void bridge.handleDaemon(message),
    onConnection: (connected) => {
      log(connected ? 'connected to Gentle Dot' : 'disconnected from Gentle Dot, retrying');
      if (!connected) void bridge.connectionLost();
    },
    onFatal: (reason) => {
      failed = true;
      log(reason);
      void bridge.stop().finally(() => process.exit(1));
    },
  });

  // Set upload function now that daemon is created
  bridge.setUploadFn(daemonUploader({ daemonUrl: config.daemonUrl, tokenFile: config.tokenFile }));

  const shutdown = () => {
    daemon.stop();
    void bridge.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  daemon.start();
  if (failed) return;
  void bridge.start().catch((error) => {
    log(`Telegram bridge failed: ${error.message}`);
    daemon.stop();
    process.exit(1);
  });
}

/** Uploads a file to the daemon (`POST /upload`). */
function daemonUploader(options: { daemonUrl: string; tokenFile: string }) {
  const fetch = globalThis.fetch;
  return async (file: { name: string; data: Buffer }): Promise<{ uploadId: string; name: string }> => {
    const httpUrl = options.daemonUrl.replace(/^ws/, 'http');
    const token = await readTokenFile(options.tokenFile);
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(file.data)]);
    formData.append('file', blob, file.name);

    const response = await fetch(`${httpUrl}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Upload failed' }));
      throw new Error(error.message || 'Upload refused');
    }

    return response.json();
  };
}

async function readTokenFile(path: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  return readFileSync(path, 'utf8').trim();
}

main();