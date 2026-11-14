/**
 * CLI Entry Point - Gentle Dot Daemon
 * Single daemon on port 4317 with Bridge Protocol v1
 *
 * Three things happen before the daemon starts, and each one is a promise to the user:
 * the access key is created and named (never printed), server mode refuses to run as a user that
 * cannot keep it (the engine must run as its own user), and a daemon launched by the desktop app
 * takes the app's end of its pipe so it can stop when the app goes.
 */

import { program } from 'commander';
import { createDaemon, type DaemonOptions } from './daemon.ts';
import { Socket, createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

// Server mode runs the engine as its own user, which only a privileged daemon can do. Saying so
// and leaving is better than starting something that cannot keep its promise.
if (process.env['GENTLE_DOT_VPS'] === '1' && (process.getuid?.() ?? 0) !== 0) {
  console.error('failed to start: Server mode needs to run as root, so the engine can run as its own user');
  process.exit(1);
}

// Build daemon options
const dataDir = options.dataDir ?? process.env['GENTLE_DOT_DATA_DIR'] ?? path.join(homedir(), '.gentle-dot');
const daemonOptions: DaemonOptions = {
  port: options.port,
  host: options.host,
  configPath: options.config,
  dataDir,
  workspace: options.workspace,
  logLevel: options.logLevel,
  noAutoSetup: options.noAutoSetup,
};

// A host may name the engine binary and its arguments instead of relying on PATH (the tests point
// them at a stand-in engine, and a container may pin an exact build).
const agentBin = process.env['GENTLE_DOT_AGENT_BIN'];
if (agentBin) {
  let agentArgs: string[] = [];
  try {
    const parsed: unknown = JSON.parse(process.env['GENTLE_DOT_AGENT_ARGS'] ?? '[]');
    if (Array.isArray(parsed)) agentArgs = parsed.map(String);
  } catch {
    agentArgs = [];
  }
  daemonOptions.engineCommand = [agentBin, ...agentArgs];
}

// Default config path
if (!daemonOptions.configPath) {
  daemonOptions.configPath = path.join(__dirname, '..', 'connectors.yaml');
}

/**
 * The access key: created on first run, read back afterwards, and never printed. The output only
 * says where it is, so a redirected log cannot leak what authenticates every window and connector.
 */
function ensureAccessKey(): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'token');
  const existing = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  const key = existing !== '' ? existing : randomBytes(32).toString('base64url');
  if (existing === '') writeFileSync(file, key, { mode: 0o600 });
  // The WebSocket server, the uploads endpoint and the bridges all read the same key.
  if (!process.env['BRIDGE_AUTH_TOKEN']) process.env['BRIDGE_AUTH_TOKEN'] = key;
  return file;
}

/** The desktop app hands its end of a pipe as fd 3; anywhere else there is no channel. */
function appChannel(): Socket | undefined {
  if (process.env['GENTLE_DOT_NO_APP_CHANNEL'] === '1') return undefined;
  try {
    const socket = new Socket({ fd: 3 });
    if (socket.destroyed) return undefined;
    // The channel's own errors are the daemon's to handle; this keeps a vanished app from
    // becoming an uncaught exception that exits with a failure code.
    socket.on('error', () => {});
    return socket;
  } catch {
    return undefined;
  }
}

// Port 0 means "whichever is free": the config loader only takes a real port, so it is resolved
// here and pinned for the loader as well.
const requestedPort = options.port ?? Number(process.env['GENTLE_DOT_PORT'] ?? NaN);
if (requestedPort === 0) {
  const free = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
    probe.on('error', reject);
  });
  daemonOptions.port = free;
  process.env['GENTLE_DOT_PORT'] = String(free);
}

const keyFile = ensureAccessKey();
const channel = appChannel();

console.log('Starting Gentle Dot Daemon...');
console.log(`Config: ${daemonOptions.configPath}`);
console.log(`Port: ${daemonOptions.port || 4317}`);
console.log(`Host: ${daemonOptions.host || '127.0.0.1'}`);

// Start daemon
const starting = createDaemon({ ...daemonOptions, ...(channel ? { appChannel: channel } : {}) });

starting
  .then(async (daemon) => {
    console.log('Gentle Dot is running');
    console.log(`the access key is in ${keyFile}`);
    // With the app's channel, the daemon stops when the app goes; the process follows it.
    await daemon.closed;
    process.exit(0);
  })
  .catch((error) => {
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
