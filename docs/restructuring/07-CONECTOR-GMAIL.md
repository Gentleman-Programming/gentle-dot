# 📧 Conector Gmail - Especificación Completa

## 🎯 Objetivo

Conector para Gmail via **MCP Server Oficial** (S18). El daemon proxyea el tráfico MCP (S25.4). El bridge solo maneja OAuth 2.0 y webhook push notifications.

---

## 📦 Información del Paquete

| Campo | Valor |
| ------- | ------- |
| Nombre | `@gentle-dot/connector-gmail` |
| Versión | 1.0.0 |
| Entry Point | `src/index.ts` |
| Runtime | Node.js 20+ |
| Dependencias Principales | `googleapis`, `google-auth-library` |
| MCP Server | Oficial de Google (`@google/gmail-mcp`) |

---

## 🏗️ Arquitectura

```text
packages/connectors/gmail/
├── src/
│   ├── index.ts                 # Entry point → new GmailBridge()
│   ├── gmail-bridge.ts          # Extends BaseBridge (OAuth + webhook únicamente)
│   ├── auth/
│   │   ├── oauth.ts             # OAuth 2.0 flow + token refresh
│   │   ├── token-store.ts       # Persistencia refresh token
│   │   └── scopes.ts            # Definición de scopes
│   ├── webhook/
│   │   ├── handler.ts           # Express handler para webhook
│   │   ├── verification.ts      # Verificación webhook
│   │   └── parser.ts            # Parse notification
│   ├── storage/
│   │   └── token-store.ts       # SQLite/JSON para tokens
│   └── types.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

> **Nota**: Según S18, Gmail usa **MCP server oficial de Google**. El daemon proxyea el tráfico MCP (S25.4). El bridge solo maneja OAuth 2.0 + webhook push. El envío de emails se hace via `connector_command` → daemon → MCP proxy.

---

## ⚙️ Configuración

### connectors.yaml

```yaml
gmail:
  enabled: true
  mode: "read_write"
  oauth_scopes:
    - "https://www.googleapis.com/auth/gmail.readonly"
    - "https://www.googleapis.com/auth/gmail.send"
    - "https://www.googleapis.com/auth/gmail.modify"
  webhook_secret_env: "GMAIL_WEBHOOK_SECRET"
  webhook_url: ""                 # URL pública para Pub/Sub push
  watch_renewal_hours: 144        # Renovar watch cada 6 días (máx 7 días)
  max_history_batch: 100          # Max emails por batch history
  poll_interval_seconds: 60       # Fallback polling si webhook falla
```

### Variables de Entorno

```bash
# OAuth Credentials (Google Cloud Console)
GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=xxx
GMAIL_REDIRECT_URI=http://localhost:4317/oauth2callback

# Token persistido (se genera en primer auth)
GMAIL_REFRESH_TOKEN=xxx

# Webhook
GMAIL_WEBHOOK_SECRET=xxx  # Para verificación Pub/Sub
GMAIL_WEBHOOK_URL=https://dominio.com/webhook/gmail
```

---

## 🔐 OAuth 2.0 Flow

### Flujo Inicial

```text
1. Usuario visita /auth/gmail
2. Redirect a Google OAuth consent screen
3. Usuario autoriza scopes
4. Google redirect a /oauth2callback?code=xxx
5. Intercambia code por access_token + refresh_token
6. Guarda refresh_token en storage
7. Access_token se usa para API calls (expira 1h)
8. Refresh automático antes de expiración
```

### Scopes Requeridos

| Scope | Propósito |
| ------- | ----------- |
| `gmail.readonly` | Leer emails, labels, threads |
| `gmail.send` | Enviar emails |
| `gmail.modify` | Marcar leído/no leído, mover a papelera, labels |

### Token Refresh Automático

```typescript
// packages/connectors/gmail/src/auth/oauth.ts
class OAuthManager {
  private oauth2Client: any;
  private tokenStore: TokenStore;

  async ensureValidTokens(): Promise<void> {
    const emails = await this.tokenStore.list();
    for (const email of emails) {
      const tokens = await this.tokenStore.load(email);
      if (tokens && this.isExpired(tokens)) {
        await this.refreshToken(email, tokens.refresh_token);
      }
    }
  }

  private isExpired(tokens: any): boolean {
    return !tokens.expiry_date || tokens.expiry_date < Date.now() + 60000; // 1 min buffer
  }

  async refreshToken(email: string, refreshToken: string): Promise<void> {
    this.oauth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await this.oauth2Client.refreshAccessToken();
    
    await this.tokenStore.save(email, {
      ...credentials,
      refresh_token: refreshToken // Keep original refresh token
    });
    
    this.emit('oauth_refreshed', { email, expiry: credentials.expiry_date });
  }
}
```

---

## 🔔 Webhook Push Notifications

### Gmail API Watch

```typescript
// packages/connectors/gmail/src/webhook/handler.ts
async function setupWatch(gmailClient: any): Promise<any> {
  return gmailClient.users.watch('me', {
    topicName: `projects/${PROJECT_ID}/topics/gmail-push`,
    labelIds: ['INBOX'], // Solo inbox
    labelFilterAction: 'include'
  });
}

// Renueva cada 7 días (máximo permitido)
setInterval(() => setupWatch(gmailClient), 6 * 24 * 60 * 60 * 1000);
```

### Pub/Sub → Webhook

```text
Gmail API → Google Pub/Sub → Push a webhook URL → Bridge → Daemon
```

### Handler Webhook

```typescript
// packages/connectors/gmail/src/webhook/handler.ts
app.post('/webhook/gmail', express.raw({type: 'application/json'}), async (req, res) => {
  // 1. Verificar signature (GMAIL_WEBHOOK_SECRET)
  const signature = req.headers['x-goog-signature'];
  if (!verifySignature(req.body, signature)) {
    return res.status(401).send('Invalid signature');
  }
  
  // 2. Parse message
  const message = JSON.parse(req.body);
  const notification = parseNotification(message);
  
  // 3. Obtener email completo
  const email = await gmailClient.getMessage(notification.emailAddress, notification.historyId);
  
  // 4. Emitir channel_notify a daemon
  bridge.sendChannelNotify(
    `gmail-${notification.emailAddress}`,
    formatEmailNotification(email),
    notification.historyId
  );
  
  res.status(204).send();
});
```

### Formato Notificación

```typescript
interface EmailNotification {
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
  threadId: string;
  messageId: string;
}
```

---

## 📤 Envío de Emails (via MCP Proxy)

> El envío se hace via `connector_command` → daemon → MCP proxy → Gmail MCP server

### API

```typescript
// packages/connectors/gmail/src/api/send.ts
interface SendEmailParams {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Attachment[];
  threadId?: string; // Responder a thread
  inReplyTo?: string; // Message-ID de referencia
}

async function sendEmail(params: SendEmailParams): Promise<SendResult> {
  // Forward to daemon via connector_command
  return bridge.sendCommand('send_email', params);
}
```

---

## 🔌 Protocolo Bridge ↔ Daemon

### Capabilities

```typescript
const capabilities = [
  'channel_notify',     // Notificaciones push de emails
  'message_send',       // Envío de emails
  'connector_command',  // Comandos admin (watch, history, labels)
  'oauth_management'    // Refresh token, revoke
];
```

### Eventos Emitidos (Bridge → Daemon)

| Evento | Payload | Descripción |
| -------- | --------- | ------------- |
| `email_received` | `{email: EmailNotification}` | Email nuevo en INBOX |
| `email_sent` | `{messageId, threadId, to}` | Email enviado confirmado |
| `watch_renewed` | `{expiration}` | Watch renovado (cada 6 días) |
| `watch_expired` | `{error}` | Watch expirado, necesita renew |
| `oauth_refreshed` | `{expiry}` | Token refrescado automáticamente |

### Comandos Recibidos (Daemon → Bridge)

| Comando | Params | Respuesta |
| --------- | -------- | ----------- |
| `send_email` | `SendEmailParams` | `{messageId, threadId}` |
| `get_labels` | `{}` | `{labels: Label[]}` |
| `get_threads` | `{query, maxResults}` | `{threads: Thread[]}` |
| `get_message` | `{messageId}` | `{message: Message}` |
| `modify_message` | `{messageId, addLabels[], removeLabels[]}` | `{success}` |
| `renew_watch` | `{}` | `{expiration}` |
| `revoke_token` | `{}` | `{success}` |

---

## 💾 Token Store

### Esquema SQLite

```sql
CREATE TABLE IF NOT EXISTS gmail_tokens (
  email TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expiry INTEGER NOT NULL,
  scopes TEXT NOT NULL, -- JSON array
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### Operaciones

```typescript
interface TokenStore {
  save(email: string, tokens: Tokens): Promise<void>;
  load(email: string): Promise<Tokens | null>;
  delete(email: string): Promise<void>;
  list(): Promise<string[]>; // emails con tokens
}
```

---

## ✅ Checklist Implementación

| Componente | Archivo | Tests | Estado |
| ------------ | --------- | ------- | -------- |
| Entry point | `src/index.ts` | ⬜ | ⬜ |
| GmailBridge | `src/gmail-bridge.ts` | ⬜ | ⬜ |
| OAuth Manager | `src/auth/oauth.ts` | ⬜ | ⬜ |
| Token Store | `src/storage/token-store.ts` | ⬜ | ⬜ |
| Gmail Client | `src/api/gmail-client.ts` | ⬜ | ⬜ |
| Watch API | `src/api/watch.ts` | ⬜ | ⬜ |
| Send API | `src/api/send.ts` | ⬜ | ⬜ |
| Webhook Handler | `src/webhook/handler.ts` | ⬜ | ⬜ |
| Webhook Verification | `src/webhook/verification.ts` | ⬜ | ⬜ |
| Notification Parser | `src/webhook/parser.ts` | ⬜ | ⬜ |
| Schema DB | `src/storage/schema.sql` | ⬜ | ⬜ |
| Config Validation | `src/config.ts` | ⬜ | ⬜ |

---

## 🧪 Tests Clave

```typescript
// test/oauth.test.ts
describe('OAuthManager', () => {
  it('refresh token antes de expiración', async () => {
    oauth.setTokens({ access_token: 'old', expiry: Date.now() + 1000 });
    const token = await oauth.getValidAccessToken();
    expect(token).toBe('new-refreshed-token');
  });
  
  it('persist refresh token', async () => {
    await oauth.refreshAccessToken();
    const stored = await tokenStore.load('user@gmail.com');
    expect(stored.refresh_token).toBeDefined();
  });
});

// test/webhook.test.ts
describe('WebhookHandler', () => {
  it('verifica signature válida', async () => {
    const body = { message: { data: 'base64...' } };
    const sig = signPayload(body, secret);
    const req = mockRequest(body, sig);
    await expect(handler(req, res)).resolves.toBeUndefined();
  });
  
  it('rechaza signature inválida', async () => {
    const req = mockRequest(body, 'invalid-sig');
    await expect(handler(req, res)).rejects.toThrow('Invalid signature');
  });
  
  it('emite channel_notify al daemon', async () => {
    const req = mockRequest(validPubSubMessage);
    await handler(req, res);
    expect(bridge.sendChannelNotify).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Nuevo email'),
      expect.any(String)
    );
  });
});
```

---

## 🚀 Despliegue

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run build
CMD ["node", "dist/index.js"]
```

### Variables Requeridas

```bash
# Obligatorias
GMAIL_CLIENT_ID=xxx
GMAIL_CLIENT_SECRET=xxx
GMAIL_REFRESH_TOKEN=xxx
GMAIL_WEBHOOK_SECRET=xxx

# Opcionales
GMAIL_WEBHOOK_URL=https://dominio.com/webhook/gmail
LOG_LEVEL=info
DAEMON_URL=ws://localhost:4317
GMAIL_BRIDGE_TOKEN=gmail-bridge-token
```

### Cloud Run / Kubernetes

- Configurar Pub/Sub topic `gmail-push`
- Otorgar permisos `pubsub.publisher` a Gmail API
- Configurar webhook URL accesible públicamente

---

## 📚 Referencias

- [Bridge Protocol v1](./10-PROTOCOLO-BRIDGE-DAEMON.md)
- [Configuración Central](./11-CONFIGURACION.md)
- [Testing Plan](./12-TESTING-PLAN.md)
- [Reglas de Oro](./15-REGLAS-ORO.md)
- [gentle-dot Philosophy](./gentle-dot.md) - S3: Gentle Shell unchanged, S4: Identity sanitized, S12: Assistant brings own instance, S18: Connectors via MCP, S23: Engram global project `gentle-dot`, S25: Connector enforcement outside agent, S25.4: MCP proxy filters tools by mode
