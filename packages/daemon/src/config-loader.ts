/**
 * Config Loader - Loads and validates connectors.yaml with hot reload support
 * Implements Regla de Oro #3: Config centralizada única
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { watch, FSWatcher } from 'chokidar';

export interface DaemonConfig {
  port: number;
  host: string;
  data_dir: string;
  workspace: string;
  log_level: string;
}

export interface TelegramConfig {
  enabled: boolean;
  mode: 'read_only' | 'read_write';
  nickname_required: boolean;
  long_polling: boolean;
  webhook_url: string;
}

export interface GmailConfig {
  enabled: boolean;
  mode: 'read_only' | 'read_write';
  oauth_scopes: string[];
  webhook_secret_env: string;
}

export interface DiscordConfig {
  enabled: boolean;
  mode: 'read_only' | 'read_write';
  bot_token_env: string;
  client_id_env: string;
  slash_commands: boolean;
  intents: string[];
}

export interface WhatsAppBaileysConfig {
  enabled: boolean;
  multi_device: boolean;
  session_store: string;
  qr_refresh_interval: number;
  auto_reconnect: boolean;
}

export interface WhatsAppMetaCloudConfig {
  enabled: boolean;
  phone_number_id_env: string;
  access_token_env: string;
  webhook_verify_token_env: string;
  template_namespace: string;
}

export interface WhatsAppConfig {
  enabled: boolean;
  mode: 'read_only' | 'read_write';
  modes: {
    baileys: WhatsAppBaileysConfig;
    meta_cloud: WhatsAppMetaCloudConfig;
  };
}

export interface ConnectorsConfig {
  telegram: TelegramConfig;
  gmail: GmailConfig;
  discord: DiscordConfig;
  whatsapp: WhatsAppConfig;
}

export interface AppConfig {
  daemon: DaemonConfig;
  connectors: ConnectorsConfig;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Expand tilde (~) to home directory
 */
function expandTilde(p: string): string {
  if (p.startsWith('~/')) {
    const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
    return path.join(home, p.slice(2));
  }
  return p;
}

/**
 * Validate the loaded configuration
 */
export function validateConfig(config: AppConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate daemon config
  if (!config.daemon) {
    errors.push('Missing daemon configuration');
  } else {
    if (typeof config.daemon.port !== 'number' || config.daemon.port < 1 || config.daemon.port > 65535) {
      errors.push('Invalid daemon port: must be a number between 1 and 65535');
    }
    if (typeof config.daemon.host !== 'string' || config.daemon.host.trim() === '') {
      errors.push('Invalid daemon host: must be a non-empty string');
    }
    if (typeof config.daemon.data_dir !== 'string') {
      errors.push('Invalid daemon data_dir: must be a string');
    }
    if (typeof config.daemon.workspace !== 'string') {
      errors.push('Invalid daemon workspace: must be a string');
    }
  }

  // Validate connectors config
  if (!config.connectors) {
    errors.push('Missing connectors configuration');
  } else {
    const connectorTypes = ['telegram', 'gmail', 'discord', 'whatsapp'] as const;

    for (const type of connectorTypes) {
      const conn = config.connectors[type];
      if (!conn) {
        warnings.push(`Connector ${type} not configured, will be disabled`);
        continue;
      }

      if (typeof conn.enabled !== 'boolean') {
        errors.push(`Connector ${type}.enabled must be a boolean`);
      }

      if (conn.enabled && conn.mode !== 'read_only' && conn.mode !== 'read_write') {
        errors.push(`Connector ${type}.mode must be 'read_only' or 'read_write'`);
      }

      // Type-specific validation
      if (type === 'telegram' && conn.enabled) {
        const t = conn as TelegramConfig;
        if (typeof t.nickname_required !== 'boolean') {
          warnings.push('telegram.nickname_required should be boolean, defaulting to true');
        }
      }

      if (type === 'gmail' && conn.enabled) {
        const g = conn as GmailConfig;
        if (!Array.isArray(g.oauth_scopes) || g.oauth_scopes.length === 0) {
          errors.push('gmail.oauth_scopes must be a non-empty array');
        }
        if (!g.webhook_secret_env || typeof g.webhook_secret_env !== 'string') {
          warnings.push('gmail.webhook_secret_env not set, webhook validation will be skipped');
        }
      }

      if (type === 'discord' && conn.enabled) {
        const d = conn as DiscordConfig;
        if (!d.bot_token_env || typeof d.bot_token_env !== 'string') {
          errors.push('discord.bot_token_env is required');
        }
        if (!d.client_id_env || typeof d.client_id_env !== 'string') {
          errors.push('discord.client_id_env is required');
        }
        if (!Array.isArray(d.intents) || d.intents.length === 0) {
          warnings.push('discord.intents should be a non-empty array');
        }
      }

      if (type === 'whatsapp' && conn.enabled) {
        const w = conn as WhatsAppConfig;
        if (!w.modes) {
          errors.push('whatsapp.modes configuration is required');
        } else {
          if (w.modes.baileys?.enabled && typeof w.modes.baileys.session_store !== 'string') {
            warnings.push('whatsapp.modes.baileys.session_store should be a string');
          }
          if (w.modes.meta_cloud?.enabled) {
            const m = w.modes.meta_cloud;
            if (!m.phone_number_id_env || !m.access_token_env || !m.webhook_verify_token_env) {
              errors.push('whatsapp.modes.meta_cloud requires phone_number_id_env, access_token_env, and webhook_verify_token_env');
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Load configuration from YAML file
 */
export function loadConfig(configPath: string): AppConfig {
  const resolvedPath = path.resolve(expandTilde(configPath));

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
  const parsed = yaml.parse(fileContent);

  if (!parsed) {
    throw new Error('Config file is empty or invalid YAML');
  }

  // Expand tilde in paths
  if (parsed.daemon) {
    parsed.daemon.data_dir = expandTilde(parsed.daemon.data_dir);
    parsed.daemon.workspace = expandTilde(parsed.daemon.workspace);
  }

  return parsed as AppConfig;
}

/**
 * Load and validate configuration
 */
export function loadAndValidateConfig(configPath: string): AppConfig {
  const config = loadConfig(configPath);
  const validation = validateConfig(config);

  if (!validation.valid) {
    throw new Error(`Config validation failed:\n${validation.errors.join('\n')}`);
  }

  if (validation.warnings.length > 0) {
    for (const warning of validation.warnings) {
      console.warn(`[Config] Warning: ${warning}`);
    }
  }

  return config;
}

/**
 * Watch config file for changes and call callback on change
 */
export function watchConfig(
  configPath: string,
  onChange: (config: AppConfig) => void
): FSWatcher {
  const resolvedPath = path.resolve(expandTilde(configPath));
  const watcher = watch(resolvedPath, { ignoreInitial: true });

  watcher.on('change', async () => {
    try {
      const config = loadAndValidateConfig(configPath);
      console.log('[Config] Reloaded configuration');
      onChange(config);
    } catch (error) {
      console.error('[Config] Failed to reload config:', error);
    }
  });

  watcher.on('error', (error) => {
    console.error('[Config] Watcher error:', error);
  });

  return watcher;
}

/**
 * Get default config path
 */
export function getDefaultConfigPath(): string {
  return path.join(process.cwd(), 'packages', 'daemon', 'connectors.yaml');
}