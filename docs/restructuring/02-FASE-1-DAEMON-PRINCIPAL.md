# 🚀 Fase 1: Daemon Principal Unificado (Puerto 4317)

## 🎯 Objetivo

Crear un **único daemon principal en puerto 4317** que reemplace los 5+ daemons actuales, actuando como orquestador central. **No modifica Gentle Shell** - lo spawnea en modo RPC.

---

## 📦 Entregables

| # | Entregable | Descripción |
| --- | --- | --- |
| 1 | `packages/daemon/src/cli.ts` | Entry point con flags CLI |
| 2 | `packages/daemon/src/ws-server.ts` | WebSocket Server (Bridge Protocol v1) |
| 3 | `packages/daemon/src/connector-registry.ts` | Registry en memoria de conectores |
| 4 | `packages/daemon/src/config-loader.ts` | Carga `connectors.yaml` |
| 5 | `packages/daemon/src/daemon.ts` | Orquestador principal + spawn Gentle Shell RPC |
| 6 | `packages/daemon/connectors.yaml` | Config central (ver 11-CONFIGURACION.md) |
| 7 | Tests unitarios + integración | Cobertura >80% |

---

## 🏗️ Arquitectura Interna

```text
Daemon Principal (puerto 4317)
├── CLI Entry Point
├── Config Loader → connectors.yaml
├── WebSocket Server (Bridge Protocol v1)
│   ├── /ws endpoint
│   ├── Handshake: hello → ready
│   ├── Heartbeat: ping/pong
│   └── Message routing
├── Connector Registry (memoria)
│   ├── register(connectorId, type)
│   ├── unregister(connectorId)
│   ├── get(connectorId)
│   └── list()
├── Event Bus Interno
│   ├── channel_notify → broadcast
│   ├── connector_event → log + forward
│   └── command_result → response
└── Gentle Shell RPC Spawner
    ├── spawn gentle-shell --mode rpc --home ~/.gentle-dot/agent
    ├── ENGRAM_PROJECT=gentle-dot
    └── --append-system-prompt (identidad sanitizada)
```

---

## ⚙️ Configuración CLI

```typescript
// packages/daemon/src/cli.ts
interface DaemonFlags {
  port: number;           // default: 4317
  host: string;           // default: "127.0.0.1"
  config: string;         // path a connectors.yaml
  dataDir: string;        // default: ~/.gentle-dot
  workspace: string;      // default: ~/.gentle-dot/workspace
  logLevel: 'debug'|'info'|'warn'|'error';
  noAutoSetup: boolean;   // GENTLE_SHELL_NO_AUTO_SETUP=1
}
```

---

## 🔌 WebSocket Server (Bridge Protocol v1)

### Endpoints

| Endpoint | Protocolo | Descripción |
| ---------- | ----------- | ------------- |
| `ws://host:4317/ws` | WebSocket | Bridge connection |
| `http://host:4317/health` | HTTP GET | Health check |
| `http://host:4317/ready` | HTTP GET | Readiness probe |

### Handshake Flow

```text
Bridge                    Daemon
  │                         │
  ├── hello {token, protocol:1, capabilities[]} ──►│
  │                         │
  │◄── ready {sessionId, agentState, features} ───┤
  │                         │
  ├── ping {seq, ts} ──────►│
  │◄── pong {seq} ──────────┤
  │                         │
  ├── channel_notify ──────►│
  │◄── connector_event ────┤
```

### Tipos de Mensajes (ver 10-PROTOCOLO-BRIDGE-DAEMON.md)

---

## 📋 Connector Registry

```typescript
// packages/daemon/src/connector-registry.ts
interface ConnectorInfo {
  connectorId: string;
  type: 'telegram' | 'gmail' | 'discord' | 'whatsapp';
  status: 'connecting' | 'ready' | 'disconnected' | 'error';
  connectedAt: number;
  lastPing: number;
  capabilities: string[];
  metadata: Record<string, any>;
}

class ConnectorRegistry {
  private connectors = new Map<string, ConnectorInfo>();

  register(info: ConnectorInfo): void;
  unregister(connectorId: string): void;
  get(connectorId: string): ConnectorInfo | undefined;
  list(): ConnectorInfo[];
  updateHeartbeat(connectorId: string): void;
  getByType(type: ConnectorInfo['type']): ConnectorInfo[];
}
```

---

## ⚙️ Config Loader

```typescript
// packages/daemon/src/config-loader.ts
interface DaemonConfig {
  daemon: {
    port: number;
    host: string;
    data_dir: string;
    workspace: string;
  };
  connectors: {
    telegram: ConnectorConfig;
    gmail: ConnectorConfig;
    discord: ConnectorConfig;
    whatsapp: WhatsAppConfig;
  };
}

function loadConfig(path: string): DaemonConfig;
function validateConfig(config: DaemonConfig): ValidationResult;
function watchConfig(path: string, onChange: (config: DaemonConfig) => void): void;
```

---

## 🤖 Gentle Shell RPC Spawner

```typescript
// packages/daemon/src/daemon.ts
import { spawn } from 'child_process';

interface ShellConfig {
  home: string;           // ~/.gentle-dot/agent
  engramProject: string;  // gentle-dot
  mode: 'rpc';            // siempre RPC
}

class GentleShellSpawner {
  private shellProcess: ChildProcess | null = null;

  async start(config: ShellConfig): Promise<void> {
    this.shellProcess = spawn('gentle-shell', [
      '--mode', 'rpc',
      '--home', config.home,
      '--append-system-prompt', IDENTITY_PROMPT  // identidad sanitizada
    ], {
      env: {
        ...process.env,
        ENGRAM_PROJECT: 'gentle-dot',
        GENTLE_PI_CONFIG_HOME: '~/.gentle-dot/gentle-ai'
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    // Health check via IPC
    this.shellProcess.on('message', (msg) => {
      if (msg.type === 'ready') this.onReady();
    });
  }

  async stop(): Promise<void> {
    if (this.shellProcess) {
      this.shellProcess.kill('SIGTERM');
      await this.waitForExit();
    }
  }
}

const IDENTITY_PROMPT = `Eres Gentle Dot, un asistente personal que vive en el escritorio del usuario. 
Nunca menciones Gentle Shell, Gentle AI, Pi, ODD, Engram, ni el Gentleman. 
Eres un asistente personal directo y cálido.`;
```

---

## 📋 Configuración connectors.yaml (ver 11-CONFIGURACION.md)

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
    webhook_url: ""

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
        session_store: "sqlite"
        qr_refresh_interval: 3600
        auto_reconnect: true
      meta_cloud:
        enabled: true
        phone_number_id_env: "WHATSAPP_PHONE_ID"
        access_token_env: "WHATSAPP_ACCESS_TOKEN"
        webhook_verify_token_env: "WHATSAPP_WEBHOOK_VERIFY"
        template_namespace: "whatsapp:hsm:xxxx"
```

---

## ✅ Checklist Fase 1

| Item | Comando Verificación | Estado |
| ------ | --------------------- | -------- |
| Daemon compila | `pnpm --filter daemon build` | ⬜ |
| Tests unitarios pasan | `pnpm --filter daemon test` | ⬜ |
| WebSocket acepta conexiones | `wscat -c ws://localhost:4317/ws` | ⬜ |
| Handshake hello→ready | Ver logs | ⬜ |
| Registry persiste conectores | `curl localhost:4317/connectors` | ⬜ |
| Health check OK | `curl localhost:4317/health` | ⬜ |
| Config hot-reload | Editar yaml → ver logs | ⬜ |
| Lint sin errores | `pnpm --filter daemon lint` | ⬜ |
| Spawn Gentle Shell RPC | Ver logs + `ps aux | grep gentle-shell` | ⬜ |
| Engram project = gentle-dot | Ver env ENGRAM_PROJECT | ⬜ |

---

## 🚫 Reglas de Oro (ver 15-REGLAS-ORO.md)

- **No hardcodear puertos** → usar config
- **No bloquear event loop** → async/await en todo I/O
- **Un solo proceso** → no forks, no workers para paralelismo
- **Registry en memoria** → no BD para estado runtime
- **Graceful shutdown** → SIGTERM cierra WS + guarda estado
- **No modificar Gentle Shell** → solo spawnear en modo RPC
- **Identidad sanitizada** → system prompt inyectado
- **Engram global** → project `gentle-dot`

---

## 🔗 Próximo Paso

→ [03-FASE-2-CONECTORES.md](./03-FASE-2-CONECTORES.md)
