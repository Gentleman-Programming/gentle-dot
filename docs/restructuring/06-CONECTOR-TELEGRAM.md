# 📱 Conector Telegram - Especificación Completa

## 🎯 Objetivo

Conector nativo para Telegram Bot API con nickname único por usuario, multi-chat, y comandos básicos. **Bridge nativo** (no hay MCP oficial de Telegram). Se conecta al daemon vía WebSocket (Bridge Protocol v1).

---

## 📦 Información del Paquete

| Campo | Valor |
| ------- | ------- |
| Nombre | `@gentle-dot/connector-telegram` |
| Versión | 1.0.0 |
| Entry Point | `src/index.ts` |
| Runtime | Node.js 20+ |
| Dependencia Principal | `telegraf` |

---

## 🏗️ Arquitectura

```text
packages/connectors/telegram/
├── src/
│   ├── index.ts              # Entry point → new TelegramBridge()
│   ├── telegram-bridge.ts    # Extends BaseBridge
│   ├── bot/
│   │   ├── bot.ts            # Telegraf instance
│   │   ├── middleware.ts     # Logging, error handling
│   │   └── session.ts        # Session management
│   ├── commands/
│   │   ├── index.ts          # Command registry
│   │   ├── nickname.ts       # /nickname <name>
│   │   ├── status.ts         # /status
│   │   └── help.ts           # /help
│   ├── storage/
│   │   ├── nickname-store.ts # SQLite persistence
│   │   └── schema.sql        # DB schema
│   ├── handlers/
│   │   ├── message.ts        # messageCreate handler
│   │   ├── callback.ts       # callbackQuery handler
│   │   └── error.ts          # Error handler
│   └── types.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## ⚙️ Configuración

### connectors.yaml

```yaml
telegram:
  enabled: true
  mode: "read_write"
  nickname_required: true
  long_polling: true
  webhook_url: ""  # opcional, si vacío usa long-polling
```

### Variables de Entorno

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_WEBHOOK_SECRET=optional-secret
TELEGRAM_WEBHOOK_URL=https://dominio.com/webhook/telegram
DAEMON_URL=ws://localhost:4317
TELEGRAM_BRIDGE_TOKEN=telegram-bridge-token
LOG_LEVEL=info
```

---

## 🔌 Protocolo Bridge ↔ Daemon

### Capabilities Anunciadas

```typescript
const capabilities = [
  'channel_notify',      // Recibe notificaciones de otros bridges
  'message_send',        // Envía mensajes a Telegram
  'connector_command',   // Ejecuta comandos admin
  'nickname_management', // Gestión de nicknames
  'multi_chat'           // Soporta grupos y DMs
];
```

### Eventos Emitidos (Bridge → Daemon)

| Evento | Payload | Descripción |
| -------- | --------- | ------------- |
| `message_received` | `{chatId, userId, text, nickname?}` | Mensaje entrante |
| `command_executed` | `{command, params, result}` | Comando ejecutado |
| `nickname_changed` | `{userId, oldNickname, newNickname}` | Cambio de nickname |
| `user_joined` | `{chatId, userId, nickname}` | Usuario se une a chat |
| `user_left` | `{chatId, userId}` | Usuario sale de chat |

### Comandos Recibidos (Daemon → Bridge)

| Comando | Params | Respuesta |
| --------- | -------- | ----------- |
| `send_message` | `{chatId, text, parseMode?}` | `{messageId, success}` |
| `broadcast` | `{text, excludeChats?}` | `{sentCount, failedChats[]}` |
| `get_chats` | `{}` | `{chats: [{id, title, type}]}` |
| `set_nickname` | `{userId, nickname}` | `{success}` |
| `get_status` | `{}` | `{uptime, chats, users, memory}` |

---

## 💾 Persistencia: Nickname Store

### Esquema SQLite

```sql
-- packages/connectors/telegram/src/storage/schema.sql
CREATE TABLE IF NOT EXISTS nicknames (
  user_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  nickname TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nicknames_chat ON nicknames(chat_id);
CREATE INDEX IF NOT EXISTS idx_nicknames_nickname ON nicknames(nickname);
```

### Operaciones

```typescript
// packages/connectors/telegram/src/storage/nickname-store.ts
interface NicknameStore {
  getByUserId(userId: string): Promise<NicknameRecord | null>;
  getByNickname(nickname: string): Promise<NicknameRecord | null>;
  set(userId: string, chatId: string, nickname: string, meta: UserMeta): Promise<void>;
  isAvailable(nickname: string): Promise<boolean>;
  list(): Promise<NicknameRecord[]>;
  delete(userId: string): Promise<void>;
}
```

---

## 🤖 Bot Commands

### /nickname <nombre>

```typescript
// Establece nickname único para el usuario
// Validaciones:
// - 3-32 caracteres
// - Alphanumérico + _ -
// - Único globalmente
// - No palabras reservadas (admin, system, bot, etc.)
```

### /status

```typescript
// Respuesta ejemplo:
// 🤖 Gentle Bot Status
// ⏱️ Uptime: 2h 34m
// 💬 Chats: 12 (5 grupos, 7 DMs)
// 👥 Usuarios: 47
// 🧠 Memoria: 45MB / 512MB
// 🔗 Daemon: Conectado (session: abc-123)
```

### /help

```typescript
// Lista comandos disponibles con descripción
```

---

## 📡 Flujo de Mensajes

### Entrante (Telegram → Daemon)

```text
Usuario → Telegram API → Bot → Bridge → 
  1. Parse message
  2. Resolve nickname (o userId)
  3. Emit connector_event {type: 'message_received', ...}
  4. Daemon recibe → procesa → respuesta
  5. Daemon → Bridge: connector_command {send_message}
  6. Bridge → Telegram API → Usuario
```

### Saliente (Daemon → Telegram)

```text
Daemon → Bridge: connector_command {send_message} →
  1. Validate chatId existe
  2. Telegram API sendMessage
  3. Emit connector_event {type: 'command_executed', command: 'send_message', result}
  4. Daemon recibe confirmación
```

---

## ✅ Checklist Implementación

| Componente | Archivo | Tests | Estado |
| ------------ | --------- | ------- | -------- |
| Entry point | `src/index.ts` | ⬜ | ⬜ |
| TelegramBridge | `src/telegram-bridge.ts` | ⬜ | ⬜ |
| Bot setup | `src/bot/bot.ts` | ⬜ | ⬜ |
| Nickname store | `src/storage/nickname-store.ts` | ⬜ | ⬜ |
| Comando /nickname | `src/commands/nickname.ts` | ⬜ | ⬜ |
| Comando /status | `src/commands/status.ts` | ⬜ | ⬜ |
| Comando /help | `src/commands/help.ts` | ⬜ | ⬜ |
| Handler mensajes | `src/handlers/message.ts` | ⬜ | ⬜ |
| Handler callbacks | `src/handlers/callback.ts` | ⬜ | ⬜ |
| Handler errores | `src/handlers/error.ts` | ⬜ | ⬜ |
| Schema DB | `src/storage/schema.sql` | ⬜ | ⬜ |
| Config validation | `src/config.ts` | ⬜ | ⬜ |

---

## 🧪 Tests Clave

```typescript
// test/nickname-store.test.ts
describe('NicknameStore', () => {
  it('set/get nickname único', async () => {
    await store.set('user1', 'chat1', 'juan', { first_name: 'Juan' });
    const record = await store.getByUserId('user1');
    expect(record.nickname).toBe('juan');
  });
  
  it('rechaza nickname duplicado', async () => {
    await store.set('user1', 'chat1', 'juan', {});
    await expect(store.set('user2', 'chat1', 'juan', {}))
      .rejects.toThrow('Nickname already taken');
  });
  
  it('nickname case-insensitive', async () => {
    await store.set('user1', 'chat1', 'Juan', {});
    expect(await store.isAvailable('JUAN')).toBe(false);
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
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11

# Opcionales
TELEGRAM_WEBHOOK_URL=https://dominio.com/webhook/telegram
TELEGRAM_WEBHOOK_SECRET=xxx
LOG_LEVEL=info
DAEMON_URL=ws://localhost:4317
TELEGRAM_BRIDGE_TOKEN=telegram-bridge-token
```

---

## 📚 Referencias

- [Bridge Protocol v1](./10-PROTOCOLO-BRIDGE-DAEMON.md)
- [Configuración Central](./11-CONFIGURACION.md)
- [Testing Plan](./12-TESTING-PLAN.md)
- [Reglas de Oro](./15-REGLAS-ORO.md)
- [gentle-dot Philosophy](./gentle-dot.md) - S3: Gentle Shell unchanged, S4: Identity sanitized, S12: Assistant brings own instance, S18: Connectors via MCP, S23: Engram global project `gentle-dot`, S25: Connector enforcement outside agent
