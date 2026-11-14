/**
 * Linear Connector Main Entry Point
 * Boots the bridge and handles Linear MCP connection
 */

import { homedir } from "node:os";
import { LinearBridge, type LinearBridgeOptions } from './linear-bridge.js';
import { type Config, loadConfig, ConfigError } from './config.js';

const log = (message: string) => console.error(`[gentle-linear] ${message}`);

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

  // Create bridge
  const bridgeOptions: LinearBridgeOptions = { config, log };
  const bridge = new LinearBridge(bridgeOptions);

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
  log(`listening; provider: linear-mcp`);
}

void main();