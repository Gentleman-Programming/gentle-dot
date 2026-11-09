# 📡 Protocolo Bridge ↔ Daemon v1

## 🎯 Objetivo
Definir el contrato de comunicación WebSocket entre Bridges (conectores) y el Daemon Principal.

---

## 🔌 Conexión

### Endpoint
```
ws://host:4317/ws
```

### Headers Requeridos
```http
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: <base64>
```

### Subprotocolo
```
Sec-WebSocket-Protocol: bridge-protocol-v1
```

---

## 🤝 Handshake

### 1. Bridge → Daemon: HELLO
```json
{
  "type": "hello",
  "token": "bridge-auth-token-123",
  "protocol": 1,
  "capabilities": [
    "channel_notify",
    "message_send",
    "connector_command",
    "connector_register"
  ],
  "connectorId": "telegram-1",
  "connectorType": "telegram",
  "metadata": {
    "version": "1.0.0",
    "features": ["nickname_management", "multi_chat"]
  }
}
```

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| type | string | ✅ | "hello" |
| token | string | ✅ | Token autenticación (configurado en daemon) |
| protocol | number | ✅ | Versión protocolo (1) |
| capabilities | string[] | ✅ | Capabilities del bridge |
| connectorId | string | ✅ | ID único del conector |
| connectorType | string | ✅ | "telegram" \| "gmail" \| "discord" \| "whatsapp" |
| metadata | object | ❌ | Info adicional |

### 2. Daemon → Bridge: READY
```json
{
  "type": "ready",
  "sessionId": "sess-abc123",
  "agentState": "ready",
  "features": {
    "maxMessageSize": 1048576,
    "supportedTypes": ["text", "media", "template", "interactive"],
    "rateLimits": {
      "messagesPerSecond": 30,
      "concurrentConnections": 100
    }
  },
  "connectors": [
    {"connectorId": "telegram-1", "type": "telegram", "status": "ready"},
    {"connectorId": "gmail-1", "type": "gmail", "status": "ready"}
  ]
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| type | string | "ready" |
| sessionId | string | ID sesión único |
| agentState | string | Estado daemon: "starting" \| "ready" \| "degraded" \| "stopping" |
| features | object | Capacidades del daemon |
| connectors | array | Conectores ya registrados |

### 3. Bridge → Daemon: CONNECTOR_REGISTER (Opcional, si no en hello)
```json
{
  "type": "connector_register",
  "connectorId": "telegram-2",
  "type": "telegram",
  "capabilities": ["channel_notify", "message_send"]
}
```

### 4. Daemon → Bridge: REGISTERED
```json
{
  "type": "connector_registered",
  "connectorId": "telegram-2",
  "success": true
}
```

---

## 💓 Heartbeat

### Bridge → Daemon: PING
```json
{
  "type": "ping",
  "seq": 42,
  "timestamp": 1704067200000
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| type | string | "ping" |
| seq | number | Secuencia incremental |
| timestamp | number | Unix ms |

### Daemon → Bridge: PONG
```json
{
  "type": "pong",
  "seq": 42,
  "timestamp": 1704067200001,
  "daemonTimestamp": 1704067200000
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| type | string | "pong" |
| seq | number | Mismo seq que ping |
| timestamp | number | Tiempo recepción daemon |
| daemonTimestamp | number | Tiempo envío daemon |

### Configuración Heartbeat
- **Intervalo**: 30 segundos
- **Timeout**: 90 segundos (3 pings perdidos = desconexión)
- **Reconexión**: Exponencial backoff (1s, 2s, 4s, 8s, 16s, max 60s)

---

## 📨 Tipos de Mensajes

### Bridge → Daemon

#### CHANNEL_NOTIFY
```json
{
  "type": "channel_notify",
  "channelId": "telegram-user-123",
  "text": "📧 Nuevo email: \"Factura Enero\"",
  "requestId": "req-abc123",
  "metadata": {
    "source": "gmail",
    "priority": "normal",
    "threadId": "thread-456"
  }
}
```

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| type | string | ✅ | "channel_notify" |
| channelId | string | ✅ | ID destino (formato: tipo-identificador) |
| text | string | ✅ | Texto notificación |
| requestId | string | ❌ | Para correlación respuesta |
| metadata | object | ❌ | Info adicional |

#### CONNECTOR_EVENT
```json
{
  "type": "connector_event",
  "event": "message_received",
  "payload": {
    "from": "user-123",
    "text": "Hola",
    "chatId": "chat-456",
    "timestamp": 1704067200000
  },
  "timestamp": 1704067200000
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| type | string | "connector_event" |
| event | string | Tipo evento (ver tabla abajo) |
| payload | object | Datos del evento |
| timestamp | number | Unix ms |

**Eventos por Conector:**

| Conector | Eventos |
|----------|---------|
| Telegram | `message_received`, `command_executed`, `nickname_changed`, `user_joined`, `user_left` |
| Gmail | `email_received`, `email_sent`, `watch_renewed`, `watch_expired`, `oauth_refreshed` |
| Discord | `message_received`, `slash_command`, `button_click`, `modal_submit`, `bot_ready`, `guild_join`, `guild_leave` |
| WhatsApp | `message_received`, `message_sent`, `status_update`, `qr_code`, `device_linked`, `device_removed`, `template_status`, `rate_limit_warning` |

#### MESSAGE_SEND
```json
{
  "type": "message_send",
  "connectorId": "telegram-1",
  "message": {
    "to": "user-123",
    "text": "Respuesta del sistema",
    "parseMode": "Markdown",
    "replyTo": 456
  }
}
```

#### CONNECTOR_COMMAND
```json
{
  "type": "connector_command",
  "connectorId": "whatsapp-1",
  "command": "send_text",
  "params": {
    "to": "54911xxxxxxx",
    "text": "Mensaje desde daemon"
  },
  "requestId": "cmd-789"
}
```

---

### Daemon → Bridge

#### CONNECTOR_EVENT (Reenvío)
```json
{
  "type": "connector_event",
  "connectorId": "telegram-1",
  "event": "message_received",
  "payload": { ... },
  "timestamp": 1704067200000
}
```

#### COMMAND_RESULT
```json
{
  "type": "command_result",
  "requestId": "cmd-789",
  "success": true,
  "data": {
    "messageId": "msg-456",
    "timestamp": 1704067200000
  }
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| type | string | "command_result" |
| requestId | string | ID del comando original |
| success | boolean | Éxito/fallo |
| data | object | Datos respuesta (opcional) |
| error | object | Info error si success=false |

#### ERROR
```json
{
  "type": "error",
  "code": "CONNECTOR_NOT_FOUND",
  "message": "Connector whatsapp-2 not registered",
  "details": { "requestedId": "whatsapp-2" }
}
```

| Código | Descripción |
|--------|-------------|
| AUTH_FAILED | Token inválido/expirado |
| CONNECTOR_NOT_FOUND | ConnectorId no registrado |
| INVALID_MESSAGE | Formato mensaje inválido |
| RATE_LIMITED | Demasiados mensajes |
| CONNECTOR_ERROR | Error interno conector |
| PROTOCOL_ERROR | Violación protocolo |

---

## 🔄 Flujos Completos

### Flujo 1: Notificación Push (Gmail → Telegram)
```text
1. Gmail API detecta email nuevo
2. Gmail Bridge → Daemon: channel_notify {channelId: "telegram-user-123", text: "Nuevo email..."}
3. Daemon → Telegram Bridge: connector_command {command: "send_text", params: {to: "user-123", text: "Nuevo email..."}}
4. Telegram Bridge → Telegram API: sendMessage
5. Telegram Bridge → Daemon: connector_event {event: "message_sent", payload: {messageId: "msg-789"}}
6. Daemon → Gmail Bridge: connector_event {event: "notification_delivered", payload: {requestId: "req-abc"}}
```

### Flujo 2: Usuario envía WhatsApp
```text
1. Usuario → WhatsApp (Meta Cloud): "Hola"
2. Meta Webhook → WhatsApp Bridge: POST /webhook
3. WhatsApp Bridge → Daemon: connector_event {event: "message_received", payload: {from: "54911...", text: "Hola"}}
4. Daemon procesa → genera respuesta
5. Daemon → WhatsApp Bridge: connector_command {command: "send_text", params: {to: "54911...", text: "Respuesta"}}
6. WhatsApp Bridge → Meta API: POST /messages
7. Meta → WhatsApp Bridge: webhook status "sent"
8. WhatsApp Bridge → Daemon: connector_event {event: "status_update", payload: {messageId: "wamid.xxx", status: "sent"}}
```

### Flujo 3: Comando Slash Discord
```text
1. Usuario → Discord: /gentle-status
2. Discord Interaction → Discord Bridge: interactionCreate
3. Discord Bridge → Daemon: connector_event {event: "slash_command", payload: {command: "gentle-status", userId: "123"}}
4. Daemon → Discord Bridge: connector_command {command: "get_status", params: {}}
5. Discord Bridge → Daemon: command_result {success: true, data: {status: "ready", uptime: "2h"}}
6. Discord Bridge → Discord API: interaction.reply(embed)
```

---

## 🛡️ Seguridad

### Autenticación
- Token en handshake `hello` (configurado en `connectors.yaml` y variable env)
- Daemon valida token contra lista permitida
- Tokens rotados periódicamente (configurable)

### Rate Limiting
| Límite | Valor |
|--------|-------|
| Mensajes/segundo por bridge | 30 |
| Conexiones concurrentes | 100 |
| Tamaño máximo mensaje | 1MB |
| Heartbeat interval | 30s |

### Validación
- Schema validation en cada mensaje
- Sanitización de inputs
- Rechazo mensajes > 1MB
- Timeout comandos: 30s

---

## 📦 Serialización

### Formato
- **JSON** (UTF-8)
- Números: IEEE 754
- Timestamps: Unix milliseconds (number)
- Strings: UTF-8

### Compresión (Opcional)
- `permessage-deflate` WebSocket extension
- Activable via config

---

## 🔧 Versionado

| Versión | Fecha | Cambios |
|---------|-------|---------|
| 1.0.0 | 2025-01 | Versión inicial |

### Compatibilidad
- Daemon v1.x ↔ Bridge v1.x
- Cambios breaking → nueva versión mayor
- Cambios additive → versión menor

---

## 📚 Referencias
- [Fase 1: Daemon](./02-FASE-1-DAEMON-PRINCIPAL.md)
- [Fase 2: Conectores](./03-FASE-2-CONECTORES.md)
- [Configuración](./11-CONFIGURACION.md)
- [Testing](./12-TESTING-PLAN.md)
- [gentle-dot Philosophy](./gentle-dot.md) - S3: Gentle Shell unchanged, S25: Connector enforcement outside agent