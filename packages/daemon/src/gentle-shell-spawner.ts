/**
 * Gentle Shell Spawner - Spawns Gentle Shell in RPC mode
 * Implements Regla de Oro #1, #8: No modificar Gentle Shell, solo spawnear en modo RPC
 * Implements Regla de Oro #9: Identidad sanitizada via --append-system-prompt
 * Implements Regla de Oro #10: Engram global project "gentle-dot"
 */

import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';

/** Id del comando get_state usado como sonda de readiness del engine (protocolo RPC de pi). */
const RPC_PROBE_ID = 'gentle-shell-ready-probe';

export interface ShellConfig {
  home: string;           // ~/.gentle-dot/agent
  engramProject: string;  // gentle-dot
  mode: 'rpc';            // siempre RPC
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  noAutoSetup?: boolean;  // GENTLE_SHELL_NO_AUTO_SETUP=1
}

export interface ShellSpawnOptions {
  config: ShellConfig;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onMessage?: (message: unknown) => void;
}

export const IDENTITY_PROMPT = `Eres Gentle Dot, un asistente personal que vive en el escritorio del usuario.
Nunca menciones Gentle Shell, Gentle AI, Pi, ODD, Engram, ni el Gentleman.
Eres un asistente personal directo y cálido.`;

export class GentleShellSpawner extends EventEmitter {
  private shellProcess: ChildProcess | null = null;
  private config: ShellConfig | null = null;
  private ready = false;
  private startPromise: Promise<void> | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((error: Error) => void) | null = null;

  /**
   * Start Gentle Shell in RPC mode
   */
  async start(options: ShellSpawnOptions): Promise<void> {
    if (this.shellProcess) {
      throw new Error('Gentle Shell already running');
    }

    this.config = options.config;

    return new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;

      const args = this.buildArgs(options.config);
      const env = this.buildEnv(options.config);

      console.log('[GentleShellSpawner] Starting gentle-shell with args:', args.join(' '));
      console.log('[GentleShellSpawner] ENGRAM_PROJECT:', env['ENGRAM_PROJECT']);

      const spawnOptions: SpawnOptions = {
        cwd: process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      };

      try {
        this.shellProcess = spawn('gentle-shell', args, spawnOptions);
      } catch (error) {
        this.cleanup();
        reject(new Error(`Failed to spawn gentle-shell: ${error}`));
        return;
      }

      // Readiness probe: pi's RPC mode has no startup banner; a get_state
      // command queued on stdin is answered once the RPC loop is up.
      this.shellProcess.stdin?.write(
        JSON.stringify({ id: RPC_PROBE_ID, type: 'get_state' }) + '\n',
      );

      // Handle stdout: pi RPC mode speaks strict JSONL on stdout.
      let stdoutBuffer = '';
      this.shellProcess.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        let index: number;
        while ((index = stdoutBuffer.indexOf('\n')) !== -1) {
          const line = stdoutBuffer.slice(0, index).replace(/\r$/, '').trim();
          stdoutBuffer = stdoutBuffer.slice(index + 1);
          if (!line) continue;
          console.log('[GentleShellSpawner:stdout]', line);
          // Legacy heuristic kept for older engines, plus the protocol-correct
          // probe: pi answers our get_state with a response repeating its id.
          if (line.includes('ready') || line.includes('RPC server listening')) {
            this.handleReady();
          }
          try {
            const record = JSON.parse(line) as { id?: string; type?: string };
            if (record.id === RPC_PROBE_ID && record.type === 'response') {
              this.handleReady();
            }
          } catch {
            // Non-JSON stdout line: the legacy heuristic result stands.
          }
        }
      });

      // Handle stderr
      this.shellProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          console.error('[GentleShellSpawner:stderr]', output);
        }
      });

      // Handle IPC messages (for RPC communication)
      this.shellProcess.on('message', (message: unknown) => {
        console.log('[GentleShellSpawner:ipc]', message);
        if (message && typeof message === 'object' && 'type' in message) {
          const msg = message as { type: string; [key: string]: unknown };
          if (msg.type === 'ready') {
            this.handleReady();
          }
        }
        options.onMessage?.(message);
      });

      // Handle exit
      this.shellProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        console.log('[GentleShellSpawner] Process exited:', code, signal);
        this.ready = false;
        this.cleanup();
        options.onExit?.(code, signal);
        this.emit('exit', code, signal);
      });

      // Handle error
      this.shellProcess.on('error', (error: Error) => {
        console.error('[GentleShellSpawner] Process error:', error);
        this.cleanup();
        options.onError?.(error);
        this.emit('error', error);
        if (this.startReject) {
          this.startReject(error);
          this.startReject = null;
          this.startResolve = null;
        }
      });

      // Timeout for ready signal
      setTimeout(() => {
        if (!this.ready && this.startReject) {
          this.startReject(new Error('Gentle Shell failed to become ready within 30 seconds'));
          this.startReject = null;
          this.startResolve = null;
        }
      }, 30000);
    });
  }

  /**
   * Build command line arguments
   *
   * The installed gentle-shell is a launcher: its own options come first
   * (--home, --link, --isolated, --package-root) and everything after `--` is
   * forwarded to pi, which accepts --mode rpc and --append-system-prompt.
   * The legacy flags (--log-level, --no-auto-setup) are not pi options and the
   * launcher rejects them.
   */
  private buildArgs(config: ShellConfig): string[] {
    const args = [
      '--home', config.home,
      '--',
      '--mode', config.mode,
      '--append-system-prompt', IDENTITY_PROMPT,
    ];

    return args;
  }

  /**
   * Build environment variables
   */
  private buildEnv(config: ShellConfig): Record<string, string> {
    const env: Record<string, string> = {};

    // Copy all defined env vars
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }

    // Set Engram project (Regla de Oro #10)
    env['ENGRAM_PROJECT'] = config.engramProject;

    // Gentle AI config home
    env['GENTLE_PI_CONFIG_HOME'] = path.join(config.home, 'gentle-ai');

    // Disable auto setup if requested
    if (config.noAutoSetup) {
      env['GENTLE_SHELL_NO_AUTO_SETUP'] = '1';
    }

    return env;
  }

  /**
   * Handle ready signal from shell
   */
  private handleReady(): void {
    if (this.ready) return;

    this.ready = true;
    console.log('[GentleShellSpawner] Gentle Shell is ready');

    if (this.startResolve) {
      this.startResolve();
      this.startResolve = null;
      this.startReject = null;
    }

    this.emit('ready');
  }

  /**
   * Stop Gentle Shell gracefully
   */
  async stop(): Promise<void> {
    if (!this.shellProcess) {
      return;
    }

    console.log('[GentleShellSpawner] Stopping gentle-shell...');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.shellProcess) {
          console.warn('[GentleShellSpawner] Force killing after timeout');
          this.shellProcess.kill('SIGKILL');
        }
      }, 10000);

      this.shellProcess!.once('exit', (code, signal) => {
        clearTimeout(timeout);
        this.cleanup();
        console.log('[GentleShellSpawner] Stopped:', code, signal);
        resolve();
      });

      // Send SIGTERM for graceful shutdown
      this.shellProcess!.kill('SIGTERM');
    });
  }

  /**
   * Check if shell is running and ready
   */
  isReady(): boolean {
    return this.ready && this.shellProcess !== null && !this.shellProcess.killed;
  }

  /**
   * Get the shell process PID
   */
  getPid(): number | null {
    return this.shellProcess?.pid || null;
  }

  /**
   * Send message to shell via IPC
   */
  send(message: unknown): boolean {
    if (!this.shellProcess || this.shellProcess.killed) {
      return false;
    }
    // ChildProcess.send requires Serializable, serialize to JSON string
    return this.shellProcess.send(JSON.stringify(message));
  }

  /**
   * Clean up references
   */
  private cleanup(): void {
    this.shellProcess = null;
    this.config = null;
    this.ready = false;
  }
}

/**
 * Singleton instance for global access
 */
export const gentleShellSpawner = new GentleShellSpawner();