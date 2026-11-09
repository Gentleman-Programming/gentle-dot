# 🧪 Fase 4: Testing + Migración + Deploy

## 🎯 Objetivo

Testing exhaustivo, migración de daemons legacy, y despliegue a producción. **Single PR delivery** - feature + tests coherentes. **RED/GREEN methodology**.

---

## 📊 Estrategia de Testing

### Pirámide de Testing

```text
                    ┌─────────────┐
                    │   E2E       │  ← 10%  (10-15 tests críticos)
                    │  Critical   │
                ┌───┤   Flows     │───┐
                │   └─────────────┘   │
            ┌───┴─────────────────────┴───┐
            │    Integration Tests        │  ← 20%  (50-100 tests)
            │  (Bridge↔Daemon, MCP Proxy) │
        ┌───┴─────────────────────────────┴───┐
        │         Unit Tests                  │  ← 70%  (300-500 tests)
        │  (Pure functions, isolated logic)   │
        └─────────────────────────────────────┘
```

### Cobertura Mínima por Tipo

| Tipo | Cobertura | Herramienta | Ubicación |
| ------ | ----------- | ------------- | ----------- |
| Unit | >85% | Vitest | `packages/*/test/unit/` |
| Integration | >75% | Vitest + Testcontainers | `packages/*/test/integration/` |
| E2E | 10-15 flujos | Vitest + Playwright | `test/e2e/` |
| Contract | 100% Bridge Protocol | Pact/TypeSpec | `test/contract/` |
| Performance | Baselines | k6 | `test/perf/` |
| Chaos | 5 escenarios | Chaos Mesh | `test/chaos/` |

---

## 🔬 Unit Tests (por Paquete)

### Daemon (`packages/daemon`)

```bash
pnpm --filter daemon test:unit
```

| Módulo | Tests | Cobertura Objetivo |
| -------- | ------- | ------------------- |
| `config-loader` | load, validate, watch, merge | 95% |
| `connector-registry` | register, unregister, list, heartbeat, cleanup | 90% |
| `ws-server` | handshake, routing, broadcast, disconnect | 85% |
| `daemon` | start, stop, signals, graceful shutdown | 80% |
| `event-bus` | emit, subscribe, unsubscribe, dead letter | 90% |
| `mcp-proxy` | register, proxy, filter tools, approval | 85% |
| `app-channel` | auth, approval flow, connector actions | 80% |
| `gentle-shell-spawner` | spawn, IPC, health check, stop | 85% |

### BaseBridge (`packages/bridges/base`)

```bash
pnpm --filter @gentle-dot/bridge-base test:unit
```

| Módulo | Tests |
| -------- | ------- |
| `reconnection` | exponential backoff, max attempts, jitter |
| `message-serialization` | JSON, binary, compression |
| `heartbeat` | ping/pong, timeout detection, auto-reconnect |
| `error-handling` | malformed, timeout, network errors |

### Conector Telegram (`packages/connectors/telegram`)

```bash
pnpm --filter @gentle-dot/connector-telegram test:unit
```

| Módulo | Tests |
| -------- | ------- |
| `nickname-store` | CRUD, unicidad, case-insensitive, SQLite |
| `commands/nickname` | validación, reservados, longitud, caracteres |
| `commands/status` | formato, uptime, memoria, daemon status |
| `commands/help` | lista completa, descripciones |
| `bot/middleware` | logging, error handling, rate limit |

### Conector Gmail (`packages/connectors/gmail`)

```bash
pnpm --filter @gentle-dot/connector-gmail test:unit
```

| Módulo | Tests |
| -------- | ------- |
| `auth/oauth` | token refresh, expiry buffer, persist, scopes |
| `webhook/handler` | signature verification, parsing, channel_notify |
| `storage/token-store` | save, load, delete, list, expiry |

### Conector Discord (`packages/connectors/discord`)

```bash
pnpm --filter @gentle-dot/connector-discord test:unit
```

| Módulo | Tests |
| -------- | ------- |
| `bot/client` | intents, partials, event registration |
| `commands/status` | embed format, daemon status, permissions |
| `commands/send` | validation, connector routing, response |
| `commands/connector` | list, status, restart, permissions |
| `permissions/roles` | admin/operator/viewer, owner, guild config |
| `permissions/checker` | owner bypass, role hierarchy, channel/guild allowlist |

### Conector WhatsApp (`packages/connectors/whatsapp`)

```bash
pnpm --filter @gentle-dot/connector-whatsapp test:unit
```

| Módulo | Tests |
| -------- | ------- |
| `modes/baileys/session-store` | SQLite/LevelDB, save/load/list/delete |
| `modes/baileys/qr-handler` | generation, refresh, expiration, daemon notify |
| `modes/baileys/multi-device` | link, unlink, primary, device list |
| `modes/baileys/connection-manager` | reconnect, backoff, QR refresh |
| `modes/meta-cloud/webhook-handler` | signature, parsing, message/status events |
| `modes/meta-cloud/template-manager` | CRUD, send, params interpolation |
| `modes/meta-cloud/media-handler` | upload, download, validate, delete |
| `modes/meta-cloud/rate-limiter` | limits, consume, remaining, window reset |

---

## 🔗 Integration Tests

```bash
pnpm test:integration
```

### Escenarios Críticos

| # | Escenario | Descripción | Timeout |
| --- | ----------- | ------------- | --------- |
| 1 | **Handshake Completo** | Bridge conecta → hello → ready → ping/pong | 10s |
| 2 | **Channel Notify E2E** | Gmail recibe email → notifica Telegram | 30s |
| 3 | **Command Routing** | Daemon → Bridge → WhatsApp envía mensaje | 15s |
| 4 | **Multi-Bridge** | 4 bridges concurrentes + daemon | 60s |
| 5 | **Reconexión Auto** | Daemon reinicia → bridges se reconectan | 90s |
| 6 | **Hot Reload Config** | Cambio yaml → daemon recarga sin reiniciar | 20s |
| 7 | **Graceful Shutdown** | SIGTERM → cierra WS + guarda estado | 30s |
| 8 | **Error Handling** | Bridge envía malformed → daemon responde error | 10s |
| 9 | **Concurrent Commands** | 100 comandos paralelos → daemon | 30s |
| 10 | **Large Message** | Mensaje 1MB → routing correcto | 15s |
| 11 | **MCP Proxy read-only** | Bridge solo ve read tools | 15s |
| 12 | **MCP Proxy read-write + approval** | Write tool → approval nativo | 30s |
| 13 | **Native Approval Flow** | connector_command write → dialog nativo | 30s |
| 14 | **App Channel Auth** | Unix socketpair heredado del desktop app | 20s |
| 14 | **Gentle Shell RPC Spawn** | Daemon spawnea gentle-shell --mode rpc | 20s |
| 15 | **Engram Project** | ENGRAM_PROJECT=gentle-dot en child process | 10s |

### Testcontainers (Servicios Externos)

```typescript
// test/integration/setup.ts
import { GenericContainer, StartedTestContainer } from 'testcontainers';

export async function startPostgres(): Promise<StartedTestContainer> {
  return new GenericContainer('postgres:16')
    .withEnvironment({ POSTGRES_DB: 'test', POSTGRES_PASSWORD: 'test' })
    .withExposedPorts(5432)
    .start();
}

export async function startRedis(): Promise<StartedTestContainer> {
  return new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();
}

export async function startRabbitMQ(): Promise<StartedTestContainer> {
  return new GenericContainer('rabbitmq:3-management')
    .withExposedPorts(5672, 15672)
    .start();
}
```

---

## 🎭 E2E Tests (Flujos Críticos)

```bash
pnpm test:e2e
```

### Flujos Obligatorios

| # | Flujo | Descripción | Verificación |
| --- | ------- | ------------- | -------------- |
| 1 | **Email → Telegram Push** | Gmail webhook → channel_notify → Telegram recibe | ✅ Notificación llega |
| 2 | **Usuario → WhatsApp Send** | Usuario cmd → daemon → WhatsApp bridge → Meta API | ✅ Mensaje entregado |
| 3 | **Comando /status** | Usuario Discord → /gentle-status → embed response | ✅ Embed correcto |
| 4 | **Nickname Telegram** | Usuario /nickname → único → persistido → usado en msgs | ✅ Único + persistido |
| 5 | **OAuth Gmail Refresh** | Token expira → auto-refresh → API calls funcionan | ✅ Sin error 401 |
| 6 | **Multi-Bridge Broadcast** | Daemon broadcast → todos bridges reciben | ✅ 4 bridges OK |
| 7 | **Reconexión Daemon** | Daemon down/up → bridges reconectan automático | ✅ Sesión nueva |
| 8 | **WhatsApp Baileys QR** | Bridge inicia → QR → scan → sesión persistida | ✅ Sesión válida |
| 9 | **Meta Cloud Template** | Send template → params interpolados → delivery | ✅ Template OK |
| 10 | **Permisos Discord** | Usuario sin rol → /gentle-send → denied | ✅ 403 response |
| 11 | **MCP Proxy read-only** | Bridge solo ve read tools | ✅ Tools filtradas |
| 12 | **MCP Proxy read-write + approval** | Write tool → approval nativo | ✅ Approval funciona |
| 13 | **Native Approval Flow** | connector_command write → dialog nativo | ✅ Dialog nativo |
| 14 | **App Channel Auth** | Unix socketpair heredado del desktop app | ✅ Auth funciona |
| 15 | **Gentle Shell RPC Spawn** | Daemon spawnea gentle-shell --mode rpc | ✅ Spawn OK |
| 16 | **Engram Project** | ENGRAM_PROJECT=gentle-dot en child process | ✅ Project correcto |

### Playwright (UI/Webhook Testing)

```typescript
// test/e2e/webhook.spec.ts
import { test, expect } from '@playwright/test';

test('Gmail webhook recibe push y notifica', async ({ request }) => {
  const response = await request.post('http://localhost:4317/webhook/gmail', {
    data: mockGmailPush(),
    headers: { 'x-goog-signature': sign(mockGmailPush(), secret) }
  });
  expect(response.status()).toBe(204);
  
  const notify = await waitForTelegramNotify(5000);
  expect(notify.text).toContain('Nuevo email');
});
```

---

## 🔄 Migración de Daemons Legacy

### Mapeo Legacy → Nuevo

| Daemon Legacy | Puerto | Reemplazado Por | Estado |
| --------------- | -------- | ----------------- | -------- |
| telegram-bot | 4318 | @gentle-dot/connector-telegram | ⬜ |
| gmail-bridge | 4319 | @gentle-dot/connector-gmail | ⬜ |
| discord-bot | 4320 | @gentle-dot/connector-discord | ⬜ |
| whatsapp-baileys | 4321 | @gentle-dot/connector-whatsapp (baileys) | ⬜ |
| whatsapp-meta | 4322 | @gentle-dot/connector-whatsapp (meta) | ⬜ |

### Plan de Migración

```bash
# Fase 1: Paralelo (legacy + nuevo)
# 1. Desplegar nuevo daemon + bridges en staging
docker compose -f docker-compose.staging.yml up -d

# 2. Ejecutar tests paralelos
pnpm test:integration
pnpm test:e2e

# 3. Comparar comportamiento
./scripts/compare-behavior.sh legacy staging > comparison-report.md
```

### Fase 2: Cutover

```bash
# 1. Desplegar nuevo sistema en prod (puerto 4317)
docker compose -f docker-compose.prod.yml up -d

# 2. Health checks
for i in {1..30}; do
  curl -sf http://localhost:4317/health && break
  sleep 2
done

# 3. Iniciar bridges
pnpm start:bridges

# 4. Verificar 4 conectores registrados
CONNECTORS=$(curl -s http://localhost:4317/connectors | jq length)
if [ "$CONNECTORS" -ne 4 ]; then
  echo "❌ Rollback: esperados 4, encontrados $CONNECTORS"
  ./scripts/rollback.sh
  exit 1
fi

# 5. Smoke tests
pnpm test:e2e -- --grep smoke
```

### Fase 3: Cutover Legacy

```bash
# 1. Cambiar DNS/Load Balancer a puerto 4317

# 2. Detener legacy daemons (orden inverso dependencias)
systemctl stop whatsapp-meta
systemctl stop whatsapp-baileys
systemctl stop discord-bot
systemctl stop gmail-bridge
systemctl stop telegram-bot

# 3. Deshabilitar systemd legacy
systemctl disable whatsapp-meta whatsapp-baileys discord-bot gmail-bridge telegram-bot

# 4. Remover puertos legacy firewall
ufw delete allow 4318
ufw delete allow 4319
ufw delete allow 4320
ufw delete allow 4321
ufw delete allow 4322

# 5. Monitoreo 24h
watch -n 60 'curl -s http://localhost:4317/health | jq .status'
```

### Fase 4: Limpieza

```bash
# 1. Remover código legacy
rm -rf /opt/gentle-dot/{telegram-bot,gmail-bridge,discord-bot,whatsapp-bridge,whatsapp-cloud-bridge}

# 2. Remover configs legacy
rm -rf /etc/gentle-dot/{telegram,gmail,discord,whatsapp}*.yaml

# 3. Remover systemd units legacy
rm /etc/systemd/system/gentle-dot-{telegram,gmail,discord,whatsapp}*.service

# 4. Actualizar docs
git add docs/restructuring/
git commit -m "docs: migración completada a Single Daemon v1.0"

# 5. Tag release
git tag -a v1.0.0-migration -m "Single Daemon migration complete"
git push origin v1.0.0-migration
```

---

## 🚀 Despliegue a Producción

### Docker Compose (Producción)

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  daemon:
    image: ${REGISTRY}/gentle-dot/daemon:${VERSION}
    ports:
      - "4317:4317"
    environment:
      - DAEMON_PORT=4317
      - DAEMON_HOST=0.0.0.0
      - CONFIG_PATH=/config/connectors.yaml
      - LOG_LEVEL=info
      - NODE_ENV=production
      - DAEMON_TOKEN=${DAEMON_TOKEN}
    volumes:
      - ./config:/config:ro
      - daemon-data:/data
      - daemon-workspace:/workspace
      - daemon-logs:/logs
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4317/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: '1.0'
        reservations:
          memory: 512M
          cpus: '0.5'

  bridge-telegram:
    image: ${REGISTRY}/gentle-dot/connector-telegram:${VERSION}
    environment:
      - DAEMON_URL=ws://daemon:4317/ws
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}
      - LOG_LEVEL=info
    depends_on:
      daemon:
        condition: service_healthy
    restart: unless-stopped

  bridge-gmail:
    image: ${REGISTRY}/gentle-dot/connector-gmail:${VERSION}
    environment:
      - DAEMON_URL=ws://daemon:4317/ws
      - GMAIL_CLIENT_ID=${GMAIL_CLIENT_ID}
      - GMAIL_CLIENT_SECRET=${GMAIL_CLIENT_SECRET}
      - GMAIL_REFRESH_TOKEN=${GMAIL_REFRESH_TOKEN}
      - GMAIL_WEBHOOK_SECRET=${GMAIL_WEBHOOK_SECRET}
      - GMAIL_WEBHOOK_URL=${GMAIL_WEBHOOK_URL}
      - LOG_LEVEL=info
    depends_on:
      daemon:
        condition: service_healthy
    restart: unless-stopped

  bridge-discord:
    image: ${REGISTRY}/gentle-dot/connector-discord:${VERSION}
    environment:
      - DAEMON_URL=ws://daemon:4317/ws
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
      - DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID}
      - DISCORD_GUILD_ID=${DISCORD_GUILD_ID}
      - DISCORD_OWNER_ID=${DISCORD_OWNER_ID}
      - LOG_LEVEL=info
    depends_on:
      daemon:
        condition: service_healthy
    restart: unless-stopped

  bridge-whatsapp:
    image: ${REGISTRY}/gentle-dot/connector-whatsapp:${VERSION}
    environment:
      - DAEMON_URL=ws://daemon:4317/ws
      - WHATSAPP_MODE=both
      - WHATSAPP_PHONE_ID=${WHATSAPP_PHONE_ID}
      - WHATSAPP_ACCESS_TOKEN=${WHATSAPP_ACCESS_TOKEN}
      - WHATSAPP_APP_SECRET=${WHATSAPP_APP_SECRET}
      - WHATSAPP_WEBHOOK_VERIFY=${WHATSAPP_WEBHOOK_VERIFY}
      - WHATSAPP_TEMPLATE_NAMESPACE=whatsapp:hsm:xxxx
      - WHATSAPP_WEBHOOK_URL=${WHATSAPP_WEBHOOK_URL}
      - LOG_LEVEL=info
    depends_on:
      daemon:
        condition: service_healthy
    restart: unless-stopped
    ports:
      - "3000:3000"  # Webhook Meta Cloud

volumes:
  daemon-data:
  daemon-workspace:
  daemon-logs:

networks:
  default:
    name: gentle-dot-network
```

### Variables de Entorno (Producción)

```bash
# .env.prod (NO commitear - usar secrets manager)

# Daemon
DAEMON_TOKEN=openssl-rand-base64-32

# Telegram
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_WEBHOOK_SECRET=xxx

# Gmail
GMAIL_CLIENT_ID=xxx
GMAIL_CLIENT_SECRET=xxx
GMAIL_REFRESH_TOKEN=xxx
GMAIL_WEBHOOK_SECRET=xxx
GMAIL_WEBHOOK_URL=https://api.dominio.com/webhook/gmail

# Discord
DISCORD_BOT_TOKEN=xxx
DISCORD_CLIENT_ID=xxx
DISCORD_GUILD_ID=xxx
DISCORD_OWNER_ID=xxx

# WhatsApp
WHATSAPP_PHONE_ID=xxx
WHATSAPP_ACCESS_TOKEN=xxx
WHATSAPP_APP_SECRET=xxx
WHATSAPP_WEBHOOK_VERIFY=xxx
WHATSAPP_TEMPLATE_NAMESPACE=whatsapp:hsm:xxxx
WHATSAPP_WEBHOOK_URL=https://api.dominio.com/webhook/whatsapp
WHATSAPP_APP_SECRET=xxx

# Registry
REGISTRY=ghcr.io/usuario
VERSION=v1.0.0
```

---

## 📊 Monitoreo Post-Deploy

### Health Checks

```bash
# Daemon
curl http://localhost:4317/health
# {"status":"ok","uptime":3600,"connectors":4,"memory":"145MB","agentState":"idle"}

# Connectors
curl http://localhost:4317/connectors
# [{"connectorId":"telegram-1","type":"telegram","status":"ready"},...]

# Metrics
curl http://localhost:9090/metrics
```

### Alertas (Prometheus/Grafana)

```yaml
# alerting-rules.yml
groups:
  - name: gentle-dot
    rules:
      - alert: DaemonDown
        expr: up{job="gentle-dot-daemon"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Daemon Gentle caído"

      - alert: ConnectorDisconnected
        expr: gentle_dot_connector_status{status!="ready"} > 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Conector {{ $labels.connectorId }} desconectado"

      - alert: HighErrorRate
        expr: rate(gentle_dot_errors_total[5m]) > 0.05
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Error rate alto: {{ $value }}"

      - alert: HighLatency
        expr: histogram_quantile(0.99, gentle_dot_latency_seconds) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Latencia P99 > 2s"

      - alert: MemoryHigh
        expr: (gentle_dot_memory_bytes / gentle_dot_memory_limit_bytes) > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Memoria > 85%"
```

---

## 📋 Checklist Fase 4

| Categoría | Test | Estado |
| ----------- | ------ | -------- |
| **Unit Tests** | Daemon config-loader | ⬜ |
| | Daemon connector-registry | ⬜ |
| | Daemon ws-server | ⬜ |
| | Daemon mcp-proxy | ⬜ |
| | Daemon app-channel | ⬜ |
| | Daemon gentle-shell-spawner | ⬜ |
| | Bridge base reconnection | ⬜ |
| | Bridge base heartbeat | ⬜ |
| | Telegram nickname-store | ⬜ |
| | Telegram commands | ⬜ |
| | Gmail oauth | ⬜ |
| | Gmail webhook | ⬜ |
| | Discord permissions | ⬜ |
| | Discord commands | ⬜ |
| | WhatsApp Baileys session | ⬜ |
| | WhatsApp Meta Cloud webhook | ⬜ |
| | WhatsApp Meta Cloud templates | ⬜ |
| **Integration** | Handshake hello→ready | ⬜ |
| | Heartbeat ping/pong | ⬜ |
| | Channel notify E2E | ⬜ |
| | Command routing | ⬜ |
| | Multi-bridge | ⬜ |
| | Reconnection | ⬜ |
| | Hot reload config | ⬜ |
| | Graceful shutdown | ⬜ |
| | MCP Proxy read-only | ⬜ |
| | MCP Proxy read-write + approval | ⬜ |
| | Native approval flow | ⬜ |
| | App channel auth | ⬜ |
| **E2E** | Email→Telegram push | ⬜ |
| | Usuario→WhatsApp send | ⬜ |
| | /status command | ⬜ |
| | Nickname Telegram | ⬜ |
| | OAuth refresh | ⬜ |
| | Broadcast multi-bridge | ⬜ |
| | Daemon reconnect | ⬜ |
| | WhatsApp Baileys QR | ⬜ |
| | Meta Cloud template | ⬜ |
| | Discord permissions | ⬜ |
| **Performance** | Load test 100 users | ⬜ |
| | Stress test 200 users | ⬜ |
| | Memory/CPU baselines | ⬜ |
| **Chaos** | Daemon kill | ⬜ |
| | Network partition | ⬜ |
| | Memory pressure | ⬜ |
| | CPU saturation | ⬜ |
| | Disk full | ⬜ |
| **CI/CD** | Unit en PR | ⬜ |
| | Integration en PR | ⬜ |
| | E2E en merge | ⬜ |
| | Perf semanal | ⬜ |
| | Chaos manual | ⬜ |

---

## 🔗 Próximo Paso

→ [06-CONECTOR-TELEGRAM.md](./06-CONECTOR-TELEGRAM.md)
