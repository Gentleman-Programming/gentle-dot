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

/**
 * Cuánto se espera el ready del engine antes de darlo por muerto.
 *
 * Un agent home nuevo hace auto-aprovisionamiento de los companion packages de
 * gentle-ai en el primer arranque, y eso tarda minutos. Con el timeout corto el
 * daemon mata el engine a mitad del provisioning, el trabajo se pierde y el
 * siguiente arranque vuelve a empezar: loop infinito de reinicio. Por eso es
 * configurable (GENTLE_DOT_ENGINE_READY_TIMEOUT_MS) y el default sigue en 30s.
 */
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** Timeout efectivo de readiness, en ms (env inválida o ausente → default). */
export function readyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['GENTLE_DOT_ENGINE_READY_TIMEOUT_MS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_READY_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_READY_TIMEOUT_MS;
}

/** Respuesta correlacionada del protocolo RPC de pi. */
export interface RpcResponse {
  id: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
}

export interface ShellConfig {
  home: string;           // ~/.gentle-dot/agent
  engramProject: string;  // gentle-dot
  mode: 'rpc';            // siempre RPC
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  noAutoSetup?: boolean;  // GENTLE_SHELL_NO_AUTO_SETUP=1
  /** Engine argv override: `[bin, ...args]`. Defaults to `gentle-shell` from PATH. */
  engineCommand?: string[];
  /** Where the engine keeps its session files. Without it the engine starts from nothing. */
  sessionDir?: string;
  /** Agent home for the engine's own state (auth, settings). Defaults to config.home. */
  agentHome?: string;
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
  /** RPC requests en flight, correlacionados por id (protocolo pi). */
  private rpcPending = new Map<string, {
    resolve: (value: RpcResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private rpcSeq = 0;
  private ready = false;
  private startPromise: Promise<void> | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((error: Error) => void) | null = null;
  private spawnOptions: ShellSpawnOptions | null = null;

  /**
   * Start Gentle Shell in RPC mode
   */
  async start(options: ShellSpawnOptions): Promise<void> {
    if (this.shellProcess) {
      throw new Error('Gentle Shell already running');
    }

    this.config = options.config;
    this.spawnOptions = options;

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

      // An explicit engine argv lets a test (or an operator) run a specific engine build
      // without depending on what `gentle-shell` resolves to on PATH.
      const engineCommand = options.config.engineCommand ?? ['gentle-shell'];
      const engineBin = engineCommand[0] ?? 'gentle-shell';
      const fullArgs = [...engineCommand.slice(1), ...args];

      let child: ChildProcess;
      try {
        child = spawn(engineBin, fullArgs, spawnOptions);
      } catch (error) {
        this.cleanup();
        reject(new Error(`Failed to spawn gentle-shell: ${error}`));
        return;
      }
      this.shellProcess = child;

      // Readiness probe: pi's RPC mode has no startup banner; a get_state
      // command queued on stdin is answered once the RPC loop is up.
      child.stdin?.write(
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
            // RPC client: correlated responses resolve pending requests; every
            // parsed record is re-emitted as an engine event for the daemon.
            if (record.id && record.type === 'response' && this.rpcPending.has(record.id)) {
              const pending = this.rpcPending.get(record.id)!;
              this.rpcPending.delete(record.id);
              clearTimeout(pending.timer);
              pending.resolve(record as unknown as { id: string; type: 'response'; command: string; success: boolean; data?: unknown });
            }
            if (record.type) {
              this.emit('engine-event', record);
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
        this.rejectAllRpc('Gentle Shell engine exited');
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

      // Timeout for ready signal (configurable: el primer arranque aprovisiona)
      const readyTimeout = readyTimeoutMs();
      setTimeout(() => {
        if (!this.ready && this.startReject) {
          this.startReject(
            new Error(`Gentle Shell failed to become ready within ${Math.round(readyTimeout / 1000)} seconds`),
          );
          this.startReject = null;
          this.startResolve = null;
        }
      }, readyTimeout);
    });
  }

  /**
   * Answers an `extension_ui_request`. The engine correlates by that request's own id and does
   * not reply, so this writes straight to stdin instead of going through rpc().
   */
  uiRespond(requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): boolean {
    const stdin = this.shellProcess?.stdin;
    if (!stdin?.writable) return false;
    const record: Record<string, unknown> = { type: 'extension_ui_response', id: requestId };
    if (response.value !== undefined) record['value'] = response.value;
    if (response.confirmed !== undefined) record['confirmed'] = response.confirmed;
    if (response.cancelled !== undefined) record['cancelled'] = response.cancelled;
    try {
      stdin.write(JSON.stringify(record) + '\n');
      return true;
    } catch (error) {
      console.error('[GentleShellSpawner] ui response failed:', error);
      return false;
    }
  }

  /**
   * Sends one RPC command to the engine and resolves with its correlated
   * response (pi protocol: strict JSONL, responses repeat the command id).
   * Events arrive separately through 'engine-event'.
   */
  rpc<T = unknown>(type: string, params: Record<string, unknown> = {}, timeoutMs = 180_000): Promise<T> {
    if (!this.shellProcess?.stdin || !this.ready) {
      return Promise.reject(new Error('Gentle Shell engine is not ready'));
    }
    const id = `daemon-${++this.rpcSeq}-${Date.now().toString(36)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcPending.delete(id);
        reject(new Error(`RPC ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.rpcPending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.shellProcess!.stdin!.write(JSON.stringify({ id, type, ...params }) + '\n');
    });
  }

  /** Rejects every pending RPC when the engine dies. */
  private rejectAllRpc(reason: string): void {
    for (const [id, pending] of this.rpcPending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.rpcPending.delete(id);
    }
  }

  /**
   * Build command line arguments
   *
   * Matches the invocation the installed daemon uses (proven in production):
   * the gentle-shell bin is the gentle-pi CLI, which accepts --home, --mode
   * and --append-system-prompt natively. The legacy --log-level and
   * --no-auto-setup flags are rejected by it and must not be passed.
   */
  private buildArgs(config: ShellConfig): string[] {
    const args = [
      '--home', config.agentHome ?? config.home,
      '--mode', config.mode,
      '--append-system-prompt', IDENTITY_PROMPT,
    ];
    // Without a session dir the engine keeps the conversation in memory only: a restart, a
    // crash or a rotation loses everything the user said. Production passes it, so does this.
    if (config.sessionDir) args.push('--session-dir', config.sessionDir);
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
    this.spawnOptions?.onReady?.();
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