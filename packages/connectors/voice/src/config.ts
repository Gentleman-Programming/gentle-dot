import { join } from "node:path";
import { homedir } from "node:os";

/** Voice connector configuration */
export interface Config {
  /** Unique identifier for this connector instance. */
  connectorId?: string;
  /** Path to the voice-tools transcriber script. */
  transcriberScript: string;
  /** Path to the voice model directory. */
  modelDir: string;
  /** The daemon's WebSocket address. */
  daemonUrl: string;
  /** File holding the daemon's access key. */
  tokenFile: string;
  /** Maximum audio duration in seconds. */
  maxDurationSec: number;
  /** Supported audio formats. */
  supportedFormats: string[];
}

/** A configuration problem; the message names the variable and never repeats its value. */
export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>, home: string): Config {
  const transcriberScript = env.GENTLE_DOT_VOICE_TRANSCRIBER_SCRIPT?.trim() || join(home, ".dot-voice", "transcriber.js");
  const modelDir = env.GENTLE_DOT_VOICE_MODEL?.trim() || join(homedir(), ".local/share/dev.gentleman.gentle-dot/models/parakeet-tdt-0.6b-v3-int8");
  const daemonUrl = env.GENTLE_DOT_URL?.trim() || "ws://127.0.0.1:4317/ws";
  if (!/^wss?:\/\//.test(daemonUrl)) throw new ConfigError("GENTLE_DOT_URL must start with ws:// or wss://.");

  const tokenFile = env.GENTLE_DOT_TOKEN_FILE?.trim() || join(home, ".gentle-dot", "token");

  const maxDurationRaw = env.GENTLE_DOT_VOICE_MAX_DURATION_SEC?.trim() || "300";
  const maxDurationSec = Number(maxDurationRaw);
  if (!Number.isInteger(maxDurationSec) || maxDurationSec <= 0) {
    throw new ConfigError("GENTLE_DOT_VOICE_MAX_DURATION_SEC must be a positive integer.");
  }

  const supportedFormats = (env.GENTLE_DOT_VOICE_SUPPORTED_FORMATS ?? "ogg,webm,wav,mp4,mpeg,mp3,x-wav,m4a,x-m4a,aac,flac")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  return {
    connectorId: env.DOT_VOICE_CONNECTOR_ID?.trim() || 'voice',
    transcriberScript,
    modelDir,
    daemonUrl,
    tokenFile,
    maxDurationSec,
    supportedFormats,
  };
}