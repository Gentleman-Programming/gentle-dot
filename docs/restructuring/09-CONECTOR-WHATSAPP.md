# 📱 Conector WhatsApp - Especificación Completa (2 Modos)

## 🎯 Objetivo

Conector para WhatsApp con **dos modos de operación**:

1. **Baileys** - WebSocket auto-hosted, multi-device, QR login
2. **Meta Cloud API** - Business API oficial con webhooks y plantillas HSM

> **Nota**: Según S18, WhatsApp usa **MCP server para Meta Cloud API** (oficial). Baileys es bridge nativo (no hay MCP oficial). El daemon proxyea MCP para Meta Cloud (S25.4).

---

## 📦 Información del Paquete

| Campo | Valor |
| ------- | ------- |
| Nombre | `@gentle-dot/connector-whatsapp` |
| Versión | 1.0.0 |
| Entry Point | `src/index.ts` (selector de modo) |
| Runtime | Node.js 20+ |
| Dependencias Baileys | `@whiskeysockets/baileys`, `sqlite3`/`level` |
| Dependencias Meta | `axios`, `express` (webhook) |
| MCP Server Meta | Oficial de Meta (`@meta/whatsapp-mcp`) |

---

## 🏗️ Arquitectura Dual

```text
packages/connectors/whatsapp/
├── src/
│   ├── index.ts                    # Entry point → modo selector
│   ├── whatsapp-bridge.ts          # Extends BaseBridge (común)
│   ├── unified-api.ts              # Interfaz común ambos modos
│   ├── config.ts                   # Config validation
│   ├── modes/
│   │   ├── baileys/
│   │   │   ├── baileys-bridge.ts   # Baileys implementation
│   │   │   ├── session-store.ts    # SQLite/LevelDB sessions
│   │   │   ├── qr-handler.ts       # QR login periódico
│   │   │   ├── multi-device.ts     # Hasta 4 dispositivos
│   │   │   ├── message-handler.ts  # Incoming/outgoing
│   │   │   └── connection-manager.ts # Reconnection logic
│   │   └── meta-cloud/
│   │       ├── meta-bridge.ts      # Meta Cloud implementation
│   │       ├── webhook-handler.ts  # Express webhook server
│   │       ├── template-manager.ts # HSM templates
│   │       ├── media-handler.ts    # Upload/download media
│   │       └── rate-limiter.ts     # Rate limiting
│   └── types.ts                    # Shared types
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

> **Nota**: Según S18, Meta Cloud usa **MCP server oficial de Meta**. Baileys es bridge nativo (no hay MCP oficial). El daemon proxyea MCP para Meta Cloud (S25.4).

---

## ⚙️ Configuración Dual

### connectors.yaml

```yaml
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
      qr_refresh_interval: 3600        # segundos
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
```

### Variables de Entorno

#### Baileys

```bash
# Obligatorias
WHATSAPP_BAILEYS_SESSION_STORE=sqlite  # o leveldb
WHATSAPP_BAILEYS_QR_REFRESH=3600

# Opcionales
WHATSAPP_BAILEYS_MULTI_DEVICE=true
WHATSAPP_BAILEYS_AUTO_RECONNECT=true
LOG_LEVEL=info
DAEMON_URL=ws://localhost:4317
WHATSAPP_BRIDGE_TOKEN=whatsapp-bridge-token
```

#### Meta Cloud API

```bash
# Obligatorias
WHATSAPP_PHONE_ID=xxx
WHATSAPP_ACCESS_TOKEN=xxx
WHATSAPP_APP_SECRET=xxx
WHATSAPP_WEBHOOK_VERIFY=xxx
WHATSAPP_TEMPLATE_NAMESPACE=whatsapp:hsm:xxxx

# Opcionales
WHATSAPP_WEBHOOK_URL=https://dominio.com/webhook/whatsapp
WHATSAPP_API_VERSION=v18.0
LOG_LEVEL=info
DAEMON_URL=ws://localhost:4317
WHATSAPP_BRIDGE_TOKEN=whatsapp-bridge-token
```

---

## 🌐 Modo 1: Baileys (WebSocket Auto-hosted)

### Características Principales

| Feature | Descripción |
| --------- | ------------- |
| **Multi-device** | Hasta 4 dispositivos vinculados simultáneamente |
| **Auto-hosted** | Conexión WebSocket directa a WhatsApp Web (sin servidor intermedio) |
| **QR Login** | Código QR periódico para autenticación |
| **Sesiones Persistentes** | SQLite o LevelDB para credenciales y estado |
| **Sin Costos Meta** | Gratuito, usa protocolo WhatsApp Web |
| **Reconexión Automática** | Exponential backoff + QR refresh |

### Flujo de Conexión

```text
1. Inicio → Verifica session store
   ├── Sesión válida → Conecta WebSocket → Ready
   └── Sin sesión / expirada → Genera QR → Espera scan
2. Usuario escanea QR con WhatsApp móvil
3. WhatsApp Web autentica → Guarda credenciales en store
4. Conexión establecida → Eventos en tiempo real
5. Heartbeat cada 30s + QR refresh cada hora (configurable)
```

### Session Store

#### SQLite (Recomendado)

```typescript
// packages/connectors/whatsapp/src/modes/baileys/session-store.ts
import Database from 'better-sqlite3';

const db = new Database('whatsapp-sessions.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    creds TEXT NOT NULL,
    keys TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
`);
```

#### LevelDB (Alternativa)

```typescript
import level from 'level';
const store = level('./whatsapp-sessions');
```

### QR Handler

```typescript
// packages/connectors/whatsapp/src/modes/baileys/qr-handler.ts
export class QRHandler {
  private qrCode: string | null = null;
  private refreshInterval: NodeJS.Timeout | null = null;
  
  start(refreshIntervalMs: number = 3600000): void {
    this.refreshInterval = setInterval(() => {
      if (this.qrCode) {
        this.emit('qr-refresh', this.qrCode);
        this.notifyDaemonQR(this.qrCode);
      }
    }, refreshIntervalMs);
  }
  
  onQR(code: string): void {
    this.qrCode = code;
    this.emit('qr-new', code);
    this.notifyDaemonQR(code);
  }
  
  private notifyDaemonQR(code: string): void {
    this.bridge.sendConnectorEvent({
      type: 'qr_code',
      code,
      expiresIn: 60 // segundos
    });
  }
}
```

### Multi-Device

```typescript
// packages/connectors/whatsapp/src/modes/baileys/multi-device.ts
interface LinkedDevice {
  id: string;
  name: string;
  platform: string;
  lastSeen: number;
  isPrimary: boolean;
}

export class MultiDeviceManager {
  async getLinkedDevices(): Promise<LinkedDevice[]>;
  async linkNewDevice(qrCode: string): Promise<LinkedDevice>;
  async removeDevice(deviceId: string): Promise<void>;
  async setPrimary(deviceId: string): Promise<void>;
}
```

---

## ☁️ Modo 2: Meta Cloud API (Business API Oficial)

### Características Principales

| Feature | Descripción |
| --------- | ------------- |
| **Webhooks Oficiales** | Recibe mensajes, estados, eventos en tiempo real |
| **Plantillas HSM** | Templates aprobados por Meta (Highly Structured Messages) |
| **Media Support** | Imagen, video, documento, audio, sticker, location, contact |
| **Costos** | ⚠️ Por conversación (ventana 24h) |
| **Verificación** | ⚠️ Meta Business Verification requerida |
| **Rate Limits** | ⚠️ Estrictos (ver docs Meta) |

### Webhook Server

```typescript
// packages/connectors/whatsapp/src/modes/meta-cloud/webhook-handler.ts
import express from 'express';

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Verificación GET
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY) {
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

// Eventos POST
app.post('/webhook/whatsapp', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  if (!verifySignature(req.rawBody, signature, process.env.WHATSAPP_APP_SECRET)) {
    return res.status(401).send('Invalid signature');
  }
  
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  
  if (value?.messages) {
    for (const msg of value.messages) {
      await handleIncomingMessage(msg, value.contacts?.[0]);
    }
  }
  
  if (value?.statuses) {
    for (const status of value.statuses) {
      await handleStatusUpdate(status);
    }
  }
  
  res.status(200).send('OK');
});
```

### Envío de Mensajes

```typescript
// packages/connectors/whatsapp/src/modes/meta-cloud/meta-bridge.ts
interface SendMessageParams {
  to: string; // formato: 54911xxxxxxx
  type: 'text' | 'template' | 'image' | 'video' | 'document' | 'audio' | 'sticker' | 'location' | 'contact' | 'interactive';
  text?: { body: string; preview_url?: boolean };
  template?: { name: string; language: { code: string }; components?: any[] };
  image?: { link: string; caption?: string };
  video?: { link: string; caption?: string };
  document?: { link: string; filename?: string; caption?: string };
  audio?: { link: string };
  sticker?: { link: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contact?: { contacts: any[] };
  interactive?: { type: 'button' | 'list' | 'cta_url' | 'flow'; body: any };
}

async function sendMessage(params: SendMessageParams): Promise<SendResult> {
  const response = await axios.post(
    `https://graph.facebook.com/${API_VERSION}/${PHONE_ID}/messages`,
    { messaging_product: 'whatsapp', to: params.to, ...buildMessage(params) },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
  
  return { messageId: response.data.messages[0].id };
}
```

### Plantillas (HSM)

```typescript
// packages/connectors/whatsapp/src/modes/meta-cloud/template-manager.ts
interface Template {
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  components: TemplateComponent[];
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
}

export class TemplateManager {
  async getTemplates(): Promise<Template[]>;
  async getTemplate(name: string): Promise<Template | null>;
  async sendTemplate(to: string, templateName: string, params: Record<string, string>): Promise<SendResult>;
  
  // Helpers para plantillas comunes
  async sendWelcome(to: string, userName: string): Promise<SendResult>;
  async sendOTP(to: string, code: string): Promise<SendResult>;
  async sendOrderConfirmation(to: string, orderId: string): Promise<SendResult>;
}
```

### Media Handler

```typescript
// packages/connectors/whatsapp/src/modes/meta-cloud/media-handler.ts
interface MediaUploadResult {
  id: string;
  mime_type: string;
  sha256: string;
  file_size: number;
}

export class MediaHandler {
  async uploadMedia(file: Buffer, mimeType: string, filename: string): Promise<MediaUploadResult>;
  async downloadMedia(mediaId: string): Promise<Buffer>;
  async deleteMedia(mediaId: string): Promise<void>;
  
  // Validaciones Meta
  validateMedia(file: Buffer, mimeType: string): ValidationResult;
}
```

### Rate Limiter

```typescript
// packages/connectors/whatsapp/src/modes/meta-cloud/rate-limiter.ts
export class RateLimiter {
  private limits = {
    messages: { count: 1000, window: 60000 },      // 1000/min
    template_messages: { count: 250, window: 60000 }, // 250/min
    media_upload: { count: 50, window: 60000 },    // 50/min
    contacts: { count: 100, window: 60000 },       // 100/min
  };
  
  async checkLimit(type: keyof typeof this.limits): Promise<boolean>;
  async consumeLimit(type: keyof typeof this.limits): Promise<void>;
  getRemaining(type: keyof typeof this.limits): number;
}
```

---

## 🔌 Interfaz Unificada

```typescript
// packages/connectors/whatsapp/src/unified-api.ts
type WhatsAppMode = 'baileys' | 'meta-cloud';

interface UnifiedWhatsAppAPI {
  // Connection
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ConnectionStatus;
  
  // Messaging
  sendText(to: string, text: string): Promise<SendResult>;
  sendMedia(to: string, media: MediaMessage): Promise<SendResult>;
  sendTemplate(to: string, template: TemplateMessage): Promise<SendResult>;
  sendInteractive(to: string, interactive: InteractiveMessage): Promise<SendResult>;
  
  // Events
  onMessage(handler: (msg: IncomingMessage) => void): void;
  onStatus(handler: (status: MessageStatus) => void): void;
  onQR(handler: (qr: string) => void): void; // Solo Baileys
  
  // Management
  getLinkedDevices(): Promise<LinkedDevice[]>;
  logoutDevice(deviceId: string): Promise<void>;
}
```

### Selector de Modo

```typescript
// packages/connectors/whatsapp/src/index.ts
export async function createWhatsAppBridge(config: WhatsAppConfig): Promise<WhatsAppBridge> {
  const modes = [];
  
  if (config.modes.baileys?.enabled) {
    const { BaileysBridge } = await import('./modes/baileys/baileys-bridge');
    modes.push(new BaileysBridge(config.modes.baileys));
  }
  
  if (config.modes.meta_cloud?.enabled) {
    const { MetaCloudBridge } = await import('./modes/meta-cloud/meta-bridge');
    modes.push(new MetaCloudBridge(config.modes.meta_cloud));
  }
  
  if (modes.length === 0) {
    throw new Error('Al menos un modo de WhatsApp debe estar habilitado');
  }
  
  return new WhatsAppBridge(modes, config);
}

// WhatsAppBridge maneja múltiples modos simultáneos
class WhatsAppBridge extends BaseBridge {
  private modes: Map<WhatsAppMode, UnifiedWhatsAppAPI> = new Map();
  
  async sendText(to: string, text: string): Promise<SendResult> {
    // Prioridad: Meta Cloud > Baileys (si ambos activos)
    const primary = this.modes.get('meta-cloud') || this.modes.get('baileys');
    return primary.sendText(to, text);
  }
  
  // Eventos se emiten desde todos los modos activos
}
```

---

## 🔌 Protocolo Bridge ↔ Daemon

### Capabilities (Combinadas)

```typescript
const capabilities = [
  'channel_notify',
  'message_send',
  'connector_command',
  'qr_management',        // Solo Baileys
  'template_management',  // Solo Meta Cloud
  'media_management',     // Solo Meta Cloud
  'multi_device',         // Solo Baileys
  'webhook_events'        // Solo Meta Cloud
];
```

### Eventos Emitidos (Bridge → Daemon)

| Evento | Payload | Modo |
| -------- | --------- | ------ |
| `message_received` | `{from, text, media?, type, timestamp}` | Ambos |
| `message_sent` | `{to, messageId, timestamp}` | Ambos |
| `status_update` | `{messageId, status: sent | delivered | read | failed}` | Meta |
| `qr_code` | `{code, expiresIn}` | Baileys |
| `device_linked` | `{deviceId, name, platform}` | Baileys |
| `device_removed` | `{deviceId}` | Baileys |
| `template_status` | `{name, status, reason?}` | Meta |
| `rate_limit_warning` | `{type, remaining, resetAt}` | Meta |

### Comandos Recibidos (Daemon → Bridge)

| Comando | Params | Modo |
| --------- | -------- | ------ |
| `send_text` | `{to, text}` | Ambos |
| `send_media` | `{to, mediaUrl, mimeType, caption?}` | Meta |
| `send_template` | `{to, templateName, params}` | Meta |
| `send_interactive` | `{to, type, body}` | Meta |
| `get_qr` | `{}` | Baileys |
| `link_device` | `{qrCode}` | Baileys |
| `unlink_device` | `{deviceId}` | Baileys |
| `get_templates` | `{}` | Meta |
| `create_template` | `{template}` | Meta |
| `upload_media` | `{file, mimeType}` | Meta |

---

## ✅ Checklist Implementación

| Componente | Archivo | Tests | Estado |
| ------------ | --------- | ------- | -------- |
| Entry point | `src/index.ts` | ⬜ | ⬜ |
| WhatsAppBridge | `src/whatsapp-bridge.ts` | ⬜ | ⬜ |
| Unified API | `src/unified-api.ts` | ⬜ | ⬜ |
| **Baileys** | | | |
| BaileysBridge | `src/modes/baileys/baileys-bridge.ts` | ⬜ | ⬜ |
| Session Store | `src/modes/baileys/session-store.ts` | ⬜ | ⬜ |
| QR Handler | `src/modes/baileys/qr-handler.ts` | ⬜ | ⬜ |
| Multi-Device | `src/modes/baileys/multi-device.ts` | ⬜ | ⬜ |
| Connection Mgr | `src/modes/baileys/connection-manager.ts` | ⬜ | ⬜ |
| **Meta Cloud** | | | |
| MetaBridge | `src/modes/meta-cloud/meta-bridge.ts` | ⬜ | ⬜ |
| Webhook Handler | `src/modes/meta-cloud/webhook-handler.ts` | ⬜ | ⬜ |
| Template Mgr | `src/modes/meta-cloud/template-manager.ts` | ⬜ | ⬜ |
| Media Handler | `src/modes/meta-cloud/media-handler.ts` | ⬜ | ⬜ |
| Rate Limiter | `src/modes/meta-cloud/rate-limiter.ts` | ⬜ | ⬜ |
| Config | `src/config.ts` | ⬜ | ⬜ |

---

## 🧪 Tests Clave

```typescript
// test/baileys/session-store.test.ts
describe('BaileysSessionStore', () => {
  it('guarda y recupera credenciales', async () => {
    await store.save('session-1', creds);
    const loaded = await store.load('session-1');
    expect(loaded).toEqual(creds);
  });
  
  it('lista sesiones activas', async () => {
    await store.save('s1', creds1);
    await store.save('s2', creds2);
    const sessions = await store.list();
    expect(sessions).toHaveLength(2);
  });
});

// test/meta-cloud/webhook.test.ts
describe('MetaCloudWebhook', () => {
  it('verifica signature HMAC', async () => {
    const body = { entry: [{ changes: [{ value: { messages: [] } }] }] };
    const sig = hmacSha256(JSON.stringify(body), secret);
    const req = mockRequest(body, `sha256=${sig}`);
    await expect(handler(req, res)).resolves.toBeUndefined();
  });
  
  it('parsea mensaje de texto entrante', async () => {
    const msg = createMockMessage({ type: 'text', text: { body: 'Hola' } });
    await handler(msg);
    expect(bridge.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hola' })
    );
  });
});

// test/unified.test.ts
describe('UnifiedWhatsAppAPI', () => {
  it('usa Meta Cloud como primario si ambos activos', async () => {
    const bridge = new WhatsAppBridge([metaMock, baileysMock]);
    await bridge.sendText('54911xxx', 'test');
    expect(metaMock.sendText).toHaveBeenCalled();
    expect(baileysMock.sendText).not.toHaveBeenCalled();
  });
});
```

---

## 🚀 Despliegue

### Docker (Baileys)

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache sqlite-libs
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run build
# Volume para sesiones
VOLUME ["/app/sessions"]
CMD ["node", "dist/index.js"]
```

### Docker (Meta Cloud)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### Variables Comunes

```bash
# Modo selector
WHATSAPP_MODE=both  # baileys | meta-cloud | both

# Baileys
WHATSAPP_BAILEYS_SESSION_STORE=sqlite
WHATSAPP_BAILEYS_QR_REFRESH=3600

# Meta Cloud
WHATSAPP_PHONE_ID=xxx
WHATSAPP_ACCESS_TOKEN=xxx
WHATSAPP_WEBHOOK_VERIFY=xxx
WHATSAPP_TEMPLATE_NAMESPACE=whatsapp:hsm:xxxx
WHATSAPP_WEBHOOK_URL=https://dominio.com/webhook/whatsapp
```

---

## 📚 Referencias

- [Bridge Protocol v1](./10-PROTOCOLO-BRIDGE-DAEMON.md)
- [Configuración Central](./11-CONFIGURACION.md)
- [Testing Plan](./12-TESTING-PLAN.md)
- [Reglas de Oro](./15-REGLAS-ORO.md)
- [gentle-dot Philosophy](./gentle-dot.md) - S3: Gentle Shell unchanged, S4: Identity sanitized, S12: Assistant brings own instance, S18: Connectors via MCP, S23: Engram global project `gentle-dot`, S25: Connector enforcement outside agent, S25.4: MCP proxy filters tools by mode
- [Baileys Docs](https://github.com/WhiskeySockets/Baileys)
- [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api)
