/**
 * CLI Entry Point - Gentle Dot Daemon
 * Single daemon on port 4317 with Bridge Protocol v1
 */

import { program } from 'commander';
import { createDaemon, type DaemonOptions } from './daemon.ts';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CliOptions {
  port?: number;
  host?: string;
  config?: string;
  dataDir?: string;
  workspace?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  noAutoSetup?: boolean;
  version?: boolean;
}

program
  .name('gentle-daemon')
  .description('Gentle Dot Daemon - Single daemon on port 4317 with Bridge Protocol v1')
  .version('0.1.0')
  .option('-p, --port <number>', 'Port to listen on', parseInt)
  .option('-H, --host <string>', 'Host to bind to')
  .option('-c, --config <path>', 'Path to connectors.yaml')
  .option('-d, --data-dir <path>', 'Data directory')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-l, --log-level <level>', 'Log level (debug|info|warn|error)')
  .option('--no-auto-setup', 'Disable auto setup (GENTLE_SHELL_NO_AUTO_SETUP=1)')
  .parse(process.argv);

const options = program.opts<CliOptions>();

// Build daemon options
const daemonOptions: DaemonOptions = {
  port: options.port,
  host: options.host,
  configPath: options.config,
  dataDir: options.dataDir,
  workspace: options.workspace,
  logLevel: options.logLevel,
  noAutoSetup: options.noAutoSetup,
};

// Default config path
if (!daemonOptions.configPath) {
  daemonOptions.configPath = path.join(__dirname, '..', 'connectors.yaml');
}

console.log('Starting Gentle Dot Daemon...');
console.log(`Config: ${daemonOptions.configPath}`);
console.log(`Port: ${daemonOptions.port || 4317}`);
console.log(`Host: ${daemonOptions.host || '127.0.0.1'}`);

// Start daemon
createDaemon(daemonOptions).catch((error) => {
  console.error('Failed to start daemon:', error);
  process.exit(1);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});