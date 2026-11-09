# 🏗️ Arquitectura Objetivo: Single Daemon + Conectores Nativos

## 🎯 Visión General

Transformar `gentle-dot` de **múltiples daemons** a **un único daemon principal (puerto 4317)** con **conectores nativos** para todos los servicios.

---

## 🏗️ Arquitectura Actual vs Objetivo

### ❌ ARQUITECTURA ACTUAL (Problemática)

- **5+ daemons independientes** cada uno en su propio puerto
- **5+ archivos de configuración** dispersos
- **Acoplamiento fuerte** - fallo de uno afecta a todos
- **Código duplicado** en bridges (5 codebases separadas)
- **Puertos múltiples** difíciles de gestionar y monitorizar

---

### 🏗️ Estructura del Daemon Principal (Puerto 4317)

```text
~/.gentle-dot/
├── data/                 # Datos persistentes
├── workspace/            # Espacio de trabajo
├── connectors.yaml       # Configuración central
└── connectors/           # Registry en memoria (runtime)
```

---

### 🔌 Comunicación: WebSocket (Bridge Protocol v1)

```text
┌─────────────────────────────────┐
│ PUERTO 4317: DAEMON PRINCIPAL  │
│ ~/.gentle-dot/                  │
├── data/                         │
│ ├── workspace/                  │
│ ├── connectors.yaml             │
│ └── connectors/ (registry)      │
└──────────────┬──────────────────┘
               │
       WebSocket (Bridge Protocol v1)
               ▼
┌─────────────┬─────────────┬─────────────┬────────────────┐
│  TELEGRAM   │   GMAIL     │  DISCORD    │   WHATSAPP     │
│  CONNECTOR  │  CONNECTOR  │  CONNECTOR  │  CONNECTOR     │
├─────────────┼─────────────┼─────────────┼────────────────┤
│ • Nickname  │ • OAuth2    │ • Slash     │ MODO 1:        │
│   por user  │ + Webhook   │ Commands    │ BAILEYS (WS)   │
│ • Multi-chat│ + Push      │ • Events    │ (WebSocket)    │
│             │ + Send      │             │                │
└─────────────┴─────────────┴─────────────┴────────────────┘
               │
       ┌───────┴───────┐
       │    MODO 2     │
       │ META CLOUD    │
       │  API (Business)│
       └───────────────┘
```

---

### 🔌 Flujo de Comunicación

```text
┌──────────────┐  WebSocket (Bridge Protocol v1)  ┌──────────────┐
│   BRIDGE     │ ◄────────────────────────────────► │    DAEMON    │
│ (connector)  │                                    │ (puerto 4317)│
└──────────────┘                                    └──────────────┘
       │                                                  │
       │ Bridge → Daemon:                                │
       │ • hello {token, protocol:1, capabilities[]}     │
       │ • channel_notify {channelId, text, requestId?}  │
       │ • ping {seq, timestamp}                         │
       │ • connector_register {connectorId, type}        │
       │ • connector_event {connectorId, event}          │
       │ • message_send {connectorId, message}           │
       │ • connector_command {connectorId, command}      │
       │                                                  │
       │ Daemon → Bridge:                                │
       │ • ready {sessionId, agentState, features}       │
       │ • pong {seq}                                    │
       │ • connector_event {connectorId, event}          │
       │ • command_result {requestId, success, data?}    │
       ▼                                                  ▼
```

---

### 📋 Resumen Visual Simplificado

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        ARQUITECTURA FINAL                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────┐   │
│ │ DAEMON PRINCIPAL (Puerto 4317)                              │   │
│ │ ~/.gentle-dot/                                              │   │
│ │ ├── data/                 # Datos persistentes              │   │
│ │ ├── workspace/            # Espacio de trabajo              │   │
│ │ ├── connectors.yaml       # Configuración central           │   │
│ │ └── connectors/           # Registry en memoria (runtime)   │   │
│ └──────────────┬────────────────────────────────────────────┘   │
│                │                                                 │
│        WebSocket (Bridge Protocol v1)                            │
│                ▼                                                 │
│ ┌───────────┬───────────┬───────────┬──────────────────────┐   │
│ │ TELEGRAM  │  GMAIL    │  DISCORD  │ WHATSAPP (2 modos)   │   │
│ │ CONNECTOR │  CONNECTOR│  CONNECTOR│ CONNECTOR            │   │
│ ├───────────┼───────────┼───────────┼──────────────────────┤   │
│ │ • Nickname│ • OAuth2  │ • Slash   │ MODO 1: Baileys      │   │
│ │   por user│ + Webhook │ Commands  │ (WebSocket)          │   │
│ │ • Multi-chat│ + Push  │ • Events  │                      │   │
│ │           │ + Send    │           │ MODO 2: Meta Cloud   │   │
│ └───────────┴───────────┴───────────┴──────────────────────┘   │
│                                                                     │
│ MODO 1: Baileys (WebSocket auto-hosted, multi-device, QR)        │
│ MODO 2: Meta Cloud API (Business API oficial, webhooks, plantillas)│
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🔑 Principios Arquitectónicos

| Principio | Descripción |
| ----------- | ------------- |
| **Single Daemon** | Un solo proceso en puerto 4317 |
| **Conectores Nativos** | Cada servicio = conector, no daemon |
| **Config Centralizada** | `connectors.yaml` único |
| **Registry en Memoria** | Estado de conectores en daemon |
| **WebSocket Bridge Protocol v1** | Comunicación estándar |
| **Aislamiento por Conector** | Fallo de uno no afecta a otros |
| **Ciclo de Vida Independiente** | Conectores se inician/detienen independientemente |

---

## 🔌 Protocolo Bridge ↔ Daemon (v1)

### Bridge → Daemon

```typescript
type BridgeToDaemon =
  | { type: "hello"; token: string; protocol: 1; capabilities: string[] }
  | { type: "channel_notify"; channelId: string; text: string; requestId?: string }
  | { type: "ping"; seq: number; timestamp: number }
  | { type: "connector_register"; connectorId: string; type: ConnectorType }
  | { type: "connector_event"; connectorId: string; event: ConnectorEvent }
  | { type: "message_send"; connectorId: string; message: UnifiedMessage }
  | { type: "connector_command"; connectorId: string; command: ConnectorCommand }

type DaemonToBridge =
  | { type: "ready"; sessionId: string; agentState: string; features: Features }
  | { type: "pong"; seq: number }
  | { type: "connector_event"; connectorId: string; event: ConnectorEvent }
  | { type: "command_result"; requestId: string; success: boolean; data?: any }
```

---

### 📦 Estructura de Repositorio Final

```text
gentle-dot/
├── packages/
│ ├── daemon/              # Daemon principal (puerto 4317)
│ │ ├── src/
│ │ │ ├── cli.ts                 # Entry point
│ │ │ ├── connector-registry.ts  # Registry de conectores
│ │ │ ├── ws-server.ts           # WebSocket server
│ │ │ └── config-loader.ts       # Carga connectors.yaml
│ │ └── connectors.yaml          # Config central
│ │
│ ├── connectors/
│ │ ├── telegram/        # Conector Telegram
│ │ ├── gmail/           # Conector Gmail
│ │ ├── discord/         # Conector Discord
│ │ └── whatsapp/        # Conector WhatsApp (2 modos)
│ │
│ ├── bridges/
│ │ └── base/            # BaseBridge class reutilizable
│ │
│ ├── protocol/          # Tipos compartidos (bridge-protocol)
│ │
│ └── ui/                # Frontend (sin cambios)
│
├── connectors.yaml      # Config global
├── package.json
└── tsconfig.json
```

---

## 🔌 Conectores: Especificaciones por Servicio

### 📱 TELEGRAM - Connector "telegram"

| Característica | Implementación |
| ---------------- | ---------------- |
| Nickname por usuario | Cada usuario configura su nickname único |
| Multi-chat | Soporte múltiples chats/grupos |
| API | Telegram Bot API (webhook o long-polling) |
| Comandos | /nickname, /status, /help |
| Persistencia | SQLite/JSON para nicknames por usuario |

---

### 📧 GMAIL - Connector "gmail"

| Característica | Implementación |
| ---------------- | ---------------- |
| Auth | OAuth 2.0 + Refresh token automático |
| Webhook | Push notifications (Gmail API watch) |
| Envío | Gmail API send |
| Scopes | gmail.readonly, gmail.send, gmail.modify |
| Push | Webhook a daemon → Bridge → Discord/Telegram |

---

### 🎮 DISCORD - Connector "discord"

| Característica | Implementación |
| ---------------- | ---------------- |
| Bot | Discord.js v14+ |
| Slash Commands | /gentle-status, /gentle-send, /gentle-connector |
| Eventos | messageCreate, interactionCreate, ready |
| Permisos | Roles/permisos configurables |
| Webhook | Opcional para notificaciones |

---

### 📱 WHATSAPP - Connector "whatsapp" (2 Modos)

#### Modo 1: Baileys (WebSocket - Auto-hosted)

**Características:**

- Multi-device (hasta 4 dispositivos vinculados)
- Auto-hosted (WebSocket directo a WhatsApp Web)
- QR code login periódico
- Sesiones persistentes (SQLite/LevelDB)
- Sin costos Meta

#### Modo 2: Meta Cloud API (Business API Oficial)

**Características:**

- ✅ Webhooks oficiales Meta
- ✅ Plantillas aprobadas (HSM)
- ✅ Media support (imagen, video, doc, audio)
- ⚠️ Costos por conversación (24h window)
- ⚠️ Verificación Meta Business requerida
- ⚠️ Rate limits estrictos

#### Configuración Dual

```yaml
# connectors.yaml
whatsapp:
  enabled: true
  modes:
    baileys:
      enabled: true
      multi_device: true
      session_store: "sqlite"  # o "leveldb"
      qr_refresh_interval: 3600  # segundos
    meta_cloud:
      enabled: true
      phone_number_id_env: "WHATSAPP_PHONE_ID"
      access_token_env: "WHATSAPP_ACCESS_TOKEN"
      webhook_verify_token_env: "WHATSAPP_WEBHOOK_VERIFY"
      template_namespace: "whatsapp:hsm:xxxx"
```

---

### 🔌 Configuración Central: connectors.yaml

## ~/.gentle-dot/connectors.yaml

```yaml
daemon:
  port: 4317
  host: "127.0.0.1"
  data_dir: "~/.gentle-dot"
  workspace: "~/.gentle-dot/workspace"

connectors:
  telegram:
    enabled: true
    mode: "read_write"
    nickname_required: true
    long_polling: true
    webhook_url: ""  # opcional

  gmail:
    enabled: true
    mode: "read_write"
    oauth_scopes:
      - "https://www.googleapis.com/auth/gmail.readonly"
      - "https://www.googleapis.com/auth/gmail.send"
      - "https://www.googleapis.com/auth/gmail.modify"
    webhook_secret_env: "GMAIL_WEBHOOK_SECRET"

  discord:
    enabled: true
    mode: "read_write"
    bot_token_env: "DISCORD_BOT_TOKEN"
    client_id_env: "DISCORD_CLIENT_ID"
    slash_commands: true
    intents:
      - "Guilds"
      - "GuildMessages"
      - "MessageContent"
      - "DirectMessages"

  whatsapp:
    enabled: true
    mode: "read_write"
    modes:
      baileys:
        enabled: true
        multi_device: true
        session_store: "sqlite"  # o "leveldb"
        qr_refresh_interval: 3600  # segundos
        auto_reconnect: true
      meta_cloud:
        enabled: true
        phone_number_id_env: "WHATSAPP_PHONE_ID"
        access_token_env: "WHATSAPP_ACCESS_TOKEN"
        webhook_verify_token_env: "WHATSAPP_WEBHOOK_VERIFY"
        template_namespace: "whatsapp:hsm:xxxx"
```

---

## 🔌 Bridge Protocol v1 (Resumen)

### Bridge → Daemon

| Tipo | Payload | Descripción |
| ------ | --------- | ------------- |
| `hello` | `{token, protocol: 1, capabilities[]}` | Handshake inicial |
| `channel_notify` | `{channelId, text, requestId?}` | Notificación proactiva |
| `ping` | `{seq, timestamp}` | Heartbeat |
| `connector_register` | `{connectorId, type}` | Registro conector |
| `connector_event` | `{connectorId, event}` | Evento del conector |
| `message_send` | `{connectorId, message}` | Enviar mensaje |
| `connector_command` | `{connectorId, command}` | Comando admin |

---

### Daemon → Bridge

| Tipo | Payload | Descripción |
| ------ | --------- | ------------- |
| `ready` | `{sessionId, agentState, features}` | Handshake confirmado |
| `pong` | `{seq}` | Heartbeat response |
| `connector_event` | `{connectorId, event}` | Evento del conector |
| `command_result` | `{requestId, success, data?}` | Resultado de comando |

---

### 🔄 Flujo de Datos Típico

**Gmail → Usuario (Push)**

```text
Gmail API (watch) → Webhook → Daemon → Bridge Gmail → channel_notify → Daemon → Usuario
```

**Usuario → WhatsApp (Envío)**

```text
Usuario → Daemon → Bridge WhatsApp → Meta Cloud API / Baileys → WhatsApp
```

**Usuario → Telegram (Comando)**

```text
Usuario → Telegram Bot API → Connector Telegram → Daemon → Bridge → Respuesta
```

---

### 📋 Matriz de Puertos Final

| Servicio | Puerto | Protocolo | Descripción |
| ---------- | -------- | ----------- | ------------- |
| Daemon Principal | 4317 | HTTP + WS | Único daemon, health + WS bridges |
| Telegram Bridge | Dinámico | WS Client | Conecta a daemon 4317 |
| Gmail Bridge | Dinámico | WS Client | Conecta a daemon 4317 |
| Discord Bridge | Dinámico | WS Client | Conecta a daemon 4317 |
| WhatsApp Bridge | Dinámico | WS Client | Conecta a daemon 4317 |

---

### 📋 Resumen de Cambios Clave

| Antes | Después |
| ------- | --------- |
| 5+ daemons | 1 daemon (4317) |
| 5+ puertos | 1 puerto (4317) |
| 5 config files | 1 connectors.yaml |
| 5 codebases bridges | 4 conectores + 1 base |
| Acoplamiento fuerte | Desacoplado por WebSocket |
| Fallo total = todo cae | Fallo aislado por conector |

> **Documento vivo** - Actualizar conforme avanza implementación
