/**
 * WhatsApp Connector Main Entry Point
 * Boots the bridge and admin API
 */

import { homedir } from "node:os";
import { WhatsAppBridge, type WhatsAppBridgeOptions } from "./whatsapp-bridge.js";
import { type Config, loadConfig, ConfigError } from "./config.js";
import { loadAllowlistFile, resolveAllowlist, saveAllowlistFile, maskNumber } from "./allowlist-store.js";

const log = (message: string) => console.error(`[gentle-whatsapp] ${message}`);

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env, homedir());
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    log(error.message);
    process.exit(1);
  }

  process.on("unhandledRejection", (error) =>
    log(`unexpected error: ${(error as Error)?.message ?? String(error)}`),
  );

  // Boot-restore: the allowlist file is the source of truth once it exists
  const stored = loadAllowlistFile(config.allowlistFile);
  const resolved = resolveAllowlist([...config.allowedNumbers], stored);
  config.allowedNumbers.clear();
  for (const number of resolved.numbers) config.allowedNumbers.add(number);
  if (resolved.restored) {
    log(`allowlist restored from file: ${resolved.numbers.length} number(s)`);
  } else {
    saveAllowlistFile(config.allowlistFile, resolved.numbers);
    log(`allowlist seeded from env: ${resolved.numbers.length} number(s)`);
  }

  // Create bridge
  const bridgeOptions: WhatsAppBridgeOptions = { config, log };
  const bridge = new WhatsAppBridge(bridgeOptions);

  // Setup shutdown
  const shutdown = async () => {
    log("shutting down...");
    await bridge.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Start bridge
  await bridge.start();
  log(`listening; ${config.allowedNumbers.size} allowlisted number(s), provider: ${config.meta ? 'meta-cloud' : 'unknown'}`);
}

void main();
