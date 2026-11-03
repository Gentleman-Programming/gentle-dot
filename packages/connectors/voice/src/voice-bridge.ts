/**
 * Voice Bridge - Extends BaseBridge from @gentle-dot/bridges-base
 * Connects to local voice transcription via voice-tools (Parakeet TDT + sherpa-onnx)
 */

import { spawn, ChildProcess } from "node:child_process";
import { BaseBridge, type BridgeConfig, type BridgeStatus, type HelloPayload, type ReadyPayload, type ChannelNotifyPayload, type ConnectorEventPayload, type CommandPayload, type CommandResultPayload } from '@gentle-dot/bridges-base';
import { type Config, loadConfig, type ConfigError } from './config.js';

const SOURCE_LABEL = "🎙️ [Voice] ";
const UNREACHABLE = "Gentle Dot no está disponible ahora.";
const MAX_AUDIO_BASE64 = 960_000; // ~1MB base64 limit

interface Turn {
  buffer: string;
  requestId: string;
}

interface PendingAsk {
  ask: {
    requestId: string;
    method: string;
    title: string;
    message?: string;
    options?: string[];
  };
  from: string;
}

export interface VoiceBridgeOptions {
  config: Config;
  log(message: string): void;
}

interface TranscriptionRequest {
  file: string;
}

interface TranscriptionResponse {
  text?: string;
  error?: string;
}

export class VoiceBridge extends BaseBridge {
  private transcriberProcess: ChildProcess | null = null;
  private options: VoiceBridgeOptions;
  private logFn: (message: string) => void;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private connected = false;
  private transcriberReady = false;

  constructor(options: VoiceBridgeOptions) {
    const bridgeConfig: BridgeConfig = {
      daemonUrl: options.config.daemonUrl,
      connectorId: (options.config as any).connectorId ?? 'voice',
      connectorType: 'voice',
      token: '',
      capabilities: [
        'channel_notify',
        'message_send',
        'connector_command',
        'voice_transcription',
      ],
      metadata: {
        version: '1.0.0',
        provider: 'voice-tools',
        features: ['transcribe', 'local_model', 'parakeet_tdt'],
      },
    };

    super(bridgeConfig);

    this.options = options;
    this.logFn = options.log;
  }

  // ============ BaseBridge Abstract Methods ============

  async onReady(): Promise<void> {
    this.logFn('Voice bridge ready - starting transcriber');
    this.connected = true;
    await this.startTranscriber();
  }

  async onStop(): Promise<void> {
    this.logFn('Voice bridge stopping');
    this.connected = false;
    await this.stopTranscriber();
  }

  // ============ BaseBridge Overrides ============

  protected override sendHello(): void {
    const payload: HelloPayload = {
      token: this.config.token,
      protocol: 1,
      capabilities: this.config.capabilities,
      connectorType: this.config.connectorType,
      connectorId: this.config.connectorId,
      metadata: this.config.metadata,
    };
    this.send('hello', payload);
  }

  protected override handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString()) as { type: string; payload: unknown; seq?: number; timestamp: number };
      this.dispatch(msg);
    } catch (e) {
      this.logFn(`Parse error: ${(e as Error).message}`);
    }
  }

  private dispatch(message: { type: string; payload: unknown }): void {
    switch (message.type) {
      case 'ready': {
        const ready = message.payload as ReadyPayload;
        this.logFn(`Daemon ready, session: ${ready.sessionId}`);
        break;
      }
      case 'agent_state': {
        break;
      }
      case 'channel_notify': {
        break;
      }
      case 'command': {
        const payload = message.payload as CommandPayload;
        void this.handleCommand(payload);
        break;
      }
      case 'error': {
        const payload = message.payload as { code: string; message: string };
        if (payload.code === 'unauthorized') {
          this.logFn('Daemon rejected token, attempting re-auth');
          // Re-auth: clean reconnect re-hello after the daemon cleaned up the old registration.
          void this.disconnect().then(() => this.connect());
        }
        break;
      }
      case 'voice_speech': {
        // Handle voice speech synthesis if needed
        break;
      }
      default:
        return;
    }
  }


  // ============ Transcriber Management ============

  private async startTranscriber(): Promise<void> {
    return new Promise((resolve, reject) => {
      const scriptPath = this.options.config.transcriberScript;
      this.logFn(`Starting voice transcriber: ${scriptPath}`);

      this.transcriberProcess = spawn("node", [scriptPath], {
        env: {
          ...process.env,
          GENTLE_DOT_VOICE_MODEL: this.options.config.modelDir,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let buffer = '';
      let ready = false;

      this.transcriberProcess.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        this.processTranscriberBuffer(buffer);
      });

      this.transcriberProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg.includes("transcriber: ready")) {
          ready = true;
          this.transcriberReady = true;
          this.logFn(`Voice transcriber ready`);
          resolve();
        } else {
          this.logFn(`[Voice Transcriber] ${msg}`);
        }
      });

      this.transcriberProcess.on('error', (error) => {
        this.logFn(`Transcriber process error: ${error.message}`);
        this.transcriberReady = false;
        this.connected = false;
        reject(error);
      });

      this.transcriberProcess.on('exit', (code, signal) => {
        this.logFn(`Transcriber exited: code=${code}, signal=${signal}`);
        this.transcriberReady = false;
        this.connected = false;
        this.transcriberProcess = null;
      });

      // Timeout if not ready
      setTimeout(() => {
        if (!ready) {
          reject(new Error("Transcriber failed to start within timeout"));
        }
      }, 30000);
    });
  }

  private processTranscriberBuffer(buffer: string): string {
    const lines = buffer.split('\n');
    const incomplete = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line) as TranscriptionResponse;
        const requestId = this.getOldestPendingRequest();
        if (requestId !== undefined) {
          const { resolve, reject, timeout } = this.pendingRequests.get(requestId)!;
          this.pendingRequests.delete(requestId);
          clearTimeout(timeout);

          if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response.text || "");
          }
        }
      } catch (e) {
        this.logFn(`Transcriber parse error: ${(e as Error).message}`);
      }
    }

    return incomplete;
  }

  private getOldestPendingRequest(): number | undefined {
    for (const [id] of this.pendingRequests.entries()) {
      return id;
    }
    return undefined;
  }

  private async stopTranscriber(): Promise<void> {
    if (this.transcriberProcess) {
      this.transcriberProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        this.transcriberProcess!.once('exit', () => resolve());
        setTimeout(resolve, 5000);
      });
      this.transcriberProcess = null;
    }
    this.transcriberReady = false;
  }

  // ============ Transcription Request/Response ============

  private transcribeFile(filePath: string): Promise<string> {
    if (!this.transcriberReady || !this.transcriberProcess) {
      return Promise.reject(new Error("Transcriber not ready"));
    }

    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("Transcription timed out"));
      }, this.options.config.maxDurationSec * 1000);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const request: TranscriptionRequest = { file: filePath };
      this.transcriberProcess!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  // ============ Command Handling ============

  protected async handleCommand(payload: CommandPayload): Promise<void> {
    let result: CommandResultPayload = {
      commandId: payload.commandId,
      success: false,
    };

    try {
      switch (payload.action) {
        case 'transcribe_file': {
          const { filePath } = payload.params as { filePath: string };
          const text = await this.transcribeFile(filePath);
          result = { commandId: payload.commandId, success: true, result: { text } };
          break;
        }
        case 'transcribe_base64': {
          const { base64, mime, filename } = payload.params as { base64: string; mime: string; filename: string };
          const text = await this.transcribeBase64(base64, mime, filename);
          result = { commandId: payload.commandId, success: true, result: { text } };
          break;
        }
        case 'get_status': {
          result = { commandId: payload.commandId, success: true, result: { ready: this.transcriberReady, model: this.options.config.modelDir } };
          break;
        }
        default:
          result = { commandId: payload.commandId, success: false, error: `Unknown action: ${payload.action}` };
      }
    } catch (e) {
      result = { commandId: payload.commandId, success: false, error: (e as Error).message };
    }

    this.send('command_result', result);
  }

  private async transcribeBase64(base64: string, mime: string, filename: string): Promise<string> {
    // Save base64 to temp file and transcribe
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const crypto = await import("node:crypto");

    const ext = this.getExtensionFromMime(mime) || ".wav";
    const tempFile = path.join(os.tmpdir(), `voice-${crypto.randomUUID()}${ext}`);
    
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > MAX_AUDIO_BASE64) {
      throw new Error(`Audio too large: ${buffer.length} bytes (max ${MAX_AUDIO_BASE64})`);
    }

    fs.writeFileSync(tempFile, buffer);

    try {
      return await this.transcribeFile(tempFile);
    } finally {
      fs.rm(tempFile, { force: true }, () => {});
    }
  }

  private getExtensionFromMime(mime: string): string | null {
    const mimeMap: Record<string, string> = {
      'audio/ogg': '.ogg',
      'audio/webm': '.webm',
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',
      'audio/mp4': '.mp4',
      'audio/mpeg': '.mp3',
      'audio/mp3': '.mp3',
      'audio/m4a': '.m4a',
      'audio/x-m4a': '.m4a',
      'audio/aac': '.aac',
      'audio/flac': '.flac',
    };
    return mimeMap[mime.toLowerCase()] || null;
  }

  // ============ Public API ============

  async start(): Promise<void> {
    try {
      const fs = await import("node:fs");
      const token = fs.readFileSync(this.options.config.tokenFile, "utf8").trim();
      this.config.token = token;
    } catch (e) {
      this.logFn(`Warning: Could not read daemon token file: ${(e as Error).message}`);
    }

    await this.connect();
  }

  async shutdown(): Promise<void> {
    await this.onStop();
    await this.disconnect();
  }

  async getBridgeStatus(): Promise<{
    uptime: number;
    connected: boolean;
    transcriberReady: boolean;
    modelDir: string;
  }> {
    return {
      uptime: process.uptime(),
      connected: this.connected,
      transcriberReady: this.transcriberReady,
      modelDir: this.options.config.modelDir,
    };
  }
}