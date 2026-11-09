# ⚙️ Configuración Central: connectors.yaml

## 🎯 Objetivo
Archivo único de configuración para daemon y todos los conectores.

---

## 📁 Ubicación

```
~/.gentle-dot/connectors.yaml
# O path custom via CLI:
# --config /path/to/connectors.yaml
```

---

## 📋 Estructura Completa

```yaml
# ============================================
# CONFIGURACIÓN DAEMON PRINCIPAL
# ============================================
daemon:
  port: 4317                    # Puerto WebSocket/HTTP
  host: "127.0.0.1"            # Bind address (0.0.0.0 para público)
  data_dir: "~/.gentle-dot"    # Datos persistentes
  workspace: "~/.gentle-dot/workspace"  # Espacio trabajo
  log_level: "info"            # debug|info|warn|error
  token: "${DAEMON_TOKEN}"     # Token autenticación bridges
  token_env: "DAEMON_TOKEN"    # O leer de env var
  
  # Health checks
  health_check_interval: 30    # segundos
  health_check_timeout: 5      # segundos
  
  # Heartbeat
  heartbeat_interval: 30       # segundos
  heartbeat_timeout: 90        # segundos (3 pings)
  
  # Rate limiting
  max_message_size: 1048576    # 1MB
  max_concurrent_connections: 100
  rate_limit_messages_per_sec: 30
  
  # Hot reload
  config_watch: true           # Recargar automáticamente
  config_watch_debounce: 1000  # ms

# ============================================
# CONECTORES
# ============================================
connectors:
  # ------------------------------------------
  # TELEGRAM
  # ------------------------------------------
  telegram:
    enabled: true
    mode: "read_write"              # read_only|read_write|write_only
    nickname_required: true         # Requiere /nickname para operar
    long_polling: true              # true=long-polling, false=webhook
    webhook_url: ""                 # URL webhook (vacío = long-polling)
    webhook_secret_env: ""          # Env var para secret webhook
    allowed_updates: []             # [] = todos, o lista: ["message", "callback_query"]
    max_concurrent_chats: 1000
    command_prefix: "/"             # Prefijo comandos legacy

  # ------------------------------------------
  # GMAIL
  # ------------------------------------------
  gmail:
    enabled: true
    mode: "read_write"
    oauth_scopes:
      - "https://www.googleapis.com/auth/gmail.readonly"
      - "https://www.googleapis.com/auth/gmail.send"
      - "https://www.googleapis.com/auth/gmail.modify"
    webhook_secret_env: "GMAIL_WEBHOOK_SECRET"
    webhook_url: ""                 # URL pública para Pub/Sub push
    watch_renewal_hours: 144        # Renovar watch cada 6 días (max 7 días)
    max_history_batch: 100          # Max emails por batch history
    poll_interval_seconds: 60       # Fallback polling si webhook falla

  # ------------------------------------------
  # DISCORD
  # ------------------------------------------
  discord:
    enabled: true
    mode: "read_write"
    bot_token_env: "DISCORD_BOT_TOKEN"
    client_id_env: "DISCORD_CLIENT_ID"
    slash_commands: true            # Registrar slash commands
    guild_id_env: ""                # Guild ID para deploy instantáneo (dev)
    intents:
      - "Guilds"
      - "GuildMessages"
      - "MessageContent"
      - "DirectMessages"
      - "GuildMembers"              # Para roles/permisos
    permissions:
      admin_role_ids: []            # Role IDs con acceso admin
      operator_role_ids: []         # Role IDs operadores
      viewer_role_ids: []           # Role IDs solo lectura
      allowed_channels: []          # Channel IDs permitidos (vacío = todos)
      allowed_guilds: []            # Guild IDs permitidos (vacío = todos)
      owner_id_env: "DISCORD_OWNER_ID"  # User ID owner (admin total)
    presence:
      status: "online"              # online|idle|dnd|invisible
      activity: "Gentle System"     # Texto "Playing..."

  # ------------------------------------------
  # WHATSAPP (2 MODOS)
  # ------------------------------------------
  whatsapp:
    enabled: true
    mode: "read_write"
    modes:
      # ---- MODO 1: BAILEYS ----
      baileys:
        enabled: true
        multi_device: true
        session_store: "sqlite"          # sqlite|leveldb
        session_store_path: "~/.gentle-dot/whatsapp-sessions"
        qr_refresh_interval: 3600        # Segundos entre QR refresh
        auto_reconnect: true
        reconnect_attempts: 10
        reconnect_delay_ms: 5000
        max_reconnect_delay_ms: 60000
        qr_timeout_seconds: 60
        link_preview: true
        max_message_length: 4096
        emit_own_messages: false
        default_query_timeout_ms: 30000
        
      # ---- MODO 2: META CLOUD API ----
      meta_cloud:
        enabled: true
        phone_number_id_env: "WHATSAPP_PHONE_ID"
        access_token_env: "WHATSAPP_ACCESS_TOKEN"
        app_secret_env: "WHATSAPP_APP_SECRET"
        webhook_verify_token_env: "WHATSAPP_WEBHOOK_VERIFY"
        template_namespace: "whatsapp:hsm:xxxx"
        api_version: "v18.0"
        webhook_url: ""                  # URL pública para webhook
        
        # Rate limiting (Meta Cloud)
        rate_limits:
          messages: { count: 1000, window_seconds: 60 }
          template_messages: { count: 250, window_seconds: 60 }
          media_upload: { count: 50, window_seconds: 60 }
          contacts: { count: 100, window_seconds: 60 }
        
        # Media
        media:
          max_size_mb: 16
          allowed_mime_types:
            - "image/jpeg"
            - "image/png"
            - "image/gif"
            - "video/mp4"
            - "video/3gpp"
            - "audio/mpeg"
            - "audio/ogg"
            - "audio/amr"
            - "application/pdf"
            - "application/msword"
            - "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        
        # Templates
        template_sync_interval_hours: 24
        default_language: "es_AR"
        fallback_language: "en_US"

# ============================================
# LOGGING
# ============================================
logging:
  level: "info"                       # debug|info|warn|error
  format: "json"                      # json|pretty
  output: "stdout"                    # stdout|file|both
  file_path: "~/.gentle-dot/logs/daemon.log"
  max_files: 10
  max_size_mb: 100
  redact_fields:                      # Campos a ofuscar en logs
    - "token"
    - "password"
    - "secret"
    - "access_token"
    - "refresh_token"
    - "webhook_secret"

# ============================================
# STORAGE
# ============================================
storage:
  # SQLite para daemon registry
  daemon_db: "~/.gentle-dot/daemon.db"
  
  # Connector-specific (cada connector gestiona el suyo)
  # Ver config de cada connector

# ============================================
# METRICS (Opcional)
# ============================================
metrics:
  enabled: false
  port: 9090
  path: "/metrics"
  interval_seconds: 60
```

---

## 🔧 Variables de Entorno Requeridas

### Daemon
```bash
# Obligatoria
DAEMON_TOKEN=secure-random-token-32-chars-min

# Opcionales
DAEMON_PORT=4317
DAEMON_HOST=127.0.0.1
DAEMON_LOG_LEVEL=info
DAEMON_CONFIG=~/.gentle-dot/connectors.yaml
GENTLE_SHELL_NO_AUTO_SETUP=1
```

### Conectores

#### Telegram
```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_WEBHOOK_SECRET=optional-secret
TELEGRAM_WEBHOOK_URL=https://dominio.com/webhook/telegram
```

#### Gmail
```bash
GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=xxx
GMAIL_REFRESH_TOKEN=xxx
GMAIL_WEBHOOK_SECRET=xxx
GMAIL_WEBHOOK_URL=https://dominio.com/webhook/gmail
```

#### Discord
```bash
DISCORD_BOT_TOKEN=xxx
DISCORD_CLIENT_ID=xxx
DISCORD_GUILD_ID=xxx          # Para deploy commands dev
DISCORD_OWNER_ID=xxx          # User ID owner
DISCORD_WEBHOOK_URL=https://dominio.com/webhook/discord
```

#### WhatsApp (Baileys)
```bash
WHATSAPP_BAILEYS_SESSION_STORE=sqlite
WHATSAPP_BAILEYS_QR_REFRESH=3600
WHATSAPP_BAILEYS_MULTI_DEVICE=true
```

#### WhatsApp (Meta Cloud)
```bash
WHATSAPP_PHONE_ID=xxx
WHATSAPP_ACCESS_TOKEN=xxx
WHATSAPP_APP_SECRET=xxx
WHATSAPP_WEBHOOK_VERIFY=xxx
WHATSAPP_TEMPLATE_NAMESPACE=whatsapp:hsm:xxxx
WHATSAPP_WEBHOOK_URL=https://dominio.com/webhook/whatsapp
WHATSAPP_APP_SECRET=xxx       # Para verificación signature
```

---

## 🔐 Generación de Tokens

```bash
# Token daemon (32+ chars)
openssl rand -base64 32

# Webhook secrets
openssl rand -hex 32

# Discord webhook secret (si aplica)
openssl rand -hex 32
```

---

## 📂 Estructura de Directorios

```text
~/.gentle-dot/
├── connectors.yaml              # Config principal
├── daemon.db                    # Registry SQLite
├── logs/
│   ├── daemon.log
│   ├── daemon-error.log
│   └── access.log
├── workspace/                   # Espacio temporal
├── whatsapp-sessions/           # Baileys sessions
│   └── sessions.db
└── connectors/                  # Cada connector su storage
    ├── telegram/
    │   └── nicknames.db
    ├── gmail/
    │   └── tokens.db
    ├── discord/
    │   └── permissions.json
    └── whatsapp/
        ├── sessions.db          # Baileys
        └── meta-cloud/          # Media cache, templates
```

---

## 🔄 Hot Reload

### Cambios que recargan automáticamente
- `connectors.*.enabled` (true/false)
- `connectors.*.mode` 
- `daemon.log_level`
- `daemon.rate_limit_*`

### Cambios que REQUIEREN reinicio
- `daemon.port` / `daemon.host`
- `daemon.token`
- `connectors.*.intents` (Discord)
- `connectors.whatsapp.modes.baileys.session_store`
- Cualquier `*_env` (cambio de variable de entorno)

### Forzar recarga
```bash
# Signal SIGHUP
kill -HUP $(cat ~/.gentle-dot/daemon.pid)

# O via HTTP
curl -X POST http://localhost:4317/admin/reload-config
```

---

## ✅ Validación

### Schema (TypeScript)
```typescript
// packages/daemon/src/config/schema.ts
import { z } from 'zod';

export const DaemonConfigSchema = z.object({
  daemon: z.object({
    port: z.number().int().min(1).max(65535).default(4317),
    host: z.string().ip().default("127.0.0.1"),
    data_dir: z.string().default("~/.gentle-dot"),
    // ...
  }),
  connectors: z.object({
    telegram: TelegramConfigSchema.optional(),
    gmail: GmailConfigSchema.optional(),
    discord: DiscordConfigSchema.optional(),
    whatsapp: WhatsAppConfigSchema.optional(),
  }),
  logging: LoggingConfigSchema.default({}),
  storage: StorageConfigSchema.default({}),
  metrics: MetricsConfigSchema.default({}),
});
```

### Validar CLI
```bash
# Validar config
pnpm --filter daemon run validate-config

# Output:
# ✅ Config válida
# ⚠️ Warning: telegram.webhook_url vacío (usará long-polling)
# ❌ Error: discord.bot_token_env no definido
```

---

## 📚 Referencias
- [Arquitectura](./01-ARQUITECTURA.md)
- [Fase 1: Daemon](./02-FASE-1-DAEMON-PRINCIPAL.md)
- [Fase 2: Conectores](./03-FASE-2-CONECTORES.md)
- [Testing](./12-TESTING-PLAN.md)