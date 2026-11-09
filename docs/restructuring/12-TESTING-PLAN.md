# 🧪 Plan de Testing E2E

## 🎯 Objetivo
Testing exhaustivo: unit, integration, E2E, performance, chaos.

---

## 📊 Pirámide de Testing

```text
                    ┌─────────────┐
                    │   E2E       │  ← 10%  (10-15 tests críticos)
                    │  Critical   │
                ┌───┤   Flows     │───┐
                │   └─────────────┘   │
            ┌───┴─────────────────────┴───┐
            │    Integration Tests        │  ← 20%  (50-100 tests)
            │  (Bridge↔Daemon, Connectors)│
        ┌───┴─────────────────────────────┴───┐
        │         Unit Tests                  │  ← 70%  (300-500 tests)
        │  (Pure functions, isolated logic)   │
        └─────────────────────────────────────┘
```

### Cobertura Mínima por Tipo

| Tipo | Cobertura | Herramienta | Ubicación |
|------|-----------|-------------|-----------|
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
|--------|-------|-------------------|
| `config-loader` | load, validate, watch, merge | 95% |
| `connector-registry` | register, unregister, list, heartbeat, cleanup | 90% |
| `ws-server` | handshake, routing, broadcast, disconnect | 85% |
| `daemon` | start, stop, graceful shutdown, signal handling | 80% |
| `event-bus` | emit, subscribe, unsubscribe, dead letter | 90% |

### BaseBridge (`packages/bridges/base`)
```bash
pnpm --filter @gentle-dot/bridge-base test:unit
```

| Módulo | Tests |
|--------|-------|
| `reconnection` | exponential backoff, max attempts, jitter |
| `message-serialization` | JSON, binary, compression |
| `heartbeat` | ping/pong, timeout detection, auto-reconnect |
| `error-handling` | malformed, timeout, network errors |

### Conector Telegram (`packages/connectors/telegram`)
```bash
pnpm --filter @gentle-dot/connector-telegram test:unit
```

| Módulo | Tests |
|--------|-------|
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
|--------|-------|
| `auth/oauth` | token refresh, expiry buffer, persist, scopes |
| `api/gmail-client` | send, watch, list, get, modify |
| `api/watch` | setup, renew, expiration handling |
| `webhook/handler` | signature verification, parsing, channel_notify |
| `storage/token-store` | save, load, delete, list, expiry |

### Conector Discord (`packages/connectors/discord`)
```bash
pnpm --filter @gentle-dot/connector-discord test:unit
```

| Módulo | Tests |
|--------|-------|
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
|--------|-------|
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
|---|-----------|-------------|---------|
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
|---|-------|-------------|--------------|
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

### Playwright (UI/Webhook Testing)
```typescript
// test/e2e/webhook.spec.ts
import { test, expect } from '@playwright/test';

test('Gmail webhook recibe push y notifica', async ({ request }) => {
  // 1. Setup: daemon + gmail bridge + telegram bridge
  // 2. Simular webhook Gmail
  const response = await request.post('http://localhost:4317/webhook/gmail', {
    data: mockGmailPush(),
    headers: { 'x-goog-signature': sign(mockGmailPush(), secret) }
  });
  expect(response.status()).toBe(204);
  
  // 3. Verificar Telegram recibió notificación
  const notify = await waitForTelegramNotify(5000);
  expect(notify.text).toContain('Nuevo email');
});
```

---

## ⚡ Performance Tests

```bash
pnpm test:perf
```

### k6 Scripts

```javascript
// test/perf/load-test.js
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 50 },   // Ramp up
    { duration: '5m', target: 100 },  // Steady state
    { duration: '2m', target: 200 },  // Stress
    { duration: '2m', target: 0 },    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    ws_connecting: ['p(95)<1000'],
    errors: ['rate<0.01'],
  ],
};

export default function () {
  // Test HTTP health
  const health = http.get('http://localhost:4317/health');
  check(health, { 'health 200': (r) => r.status === 200 });
  
  // Test WebSocket connection
  ws.connect('ws://localhost:4317/ws', {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'hello', token: 'test', protocol: 1, capabilities: [] }));
    });
    socket.on('message', (msg) => {
      const data = JSON.parse(msg);
      check(data, { 'ready received': (d) => d.type === 'ready' });
      socket.close();
    });
  });
  
  sleep(1);
}
```

### Métricas Objetivo

| Métrica | Target | Crítico |
|---------|--------|---------|
| Latencia handshake | <500ms | ⬜ |
| Latencia channel_notify | <200ms | ⬜ |
| Latencia command routing | <300ms | ⬜ |
| Throughput mensajes | >1000 msg/s | ⬜ |
| Conexiones concurrentes | >500 | ⬜ |
| Uso memoria daemon | <512MB | ⬜ |
| CPU idle | <10% | ⬜ |
| Error rate | <0.1% | ⬜ |
| Reconnect time | <5s | ⬜ |

---

## 🌪️ Chaos Testing

```bash
pnpm test:chaos
```

### Escenarios

| # | Escenario | Herramienta | Verificación |
|---|-----------|-------------|--------------|
| 1 | **Daemon Kill** | `kill -9` | Bridges reconectan <30s |
| 2 | **Network Partition** | `tc qdisc add delay 5s` | Heartbeat timeout → reconnect |
| 3 | **Memory Pressure** | `stress --vm 2 --vm-bytes 80%` | Daemon no OOM, GC funciona |
| 4 | **CPU Saturation** | `stress --cpu 4` | Latencia <2x normal |
| 5 | **Disk Full** | `dd if=/dev/zero of=/tmp/fill bs=1G count=10` | Logs rotan, no crash |

---

## 📋 CI/CD Pipeline

```yaml
# .github/workflows/test.yml
name: Test Suite

on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:unit --coverage
      - uses: codecov/codecov-action@v3

  integration:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_DB: test, POSTGRES_PASSWORD: test }
        ports: [5432:5432]
      redis:
        image: redis:7-alpine
        ports: [6379:6379]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:integration

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: docker compose -f docker-compose.test.yml up -d
      - run: pnpm test:e2e

  perf:
    runs-on: ubuntu-latest
    if: github.event_name == 'schedule'
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test:perf
      - uses: actions/upload-artifact@v3
        with: { name: perf-results, path: test/perf/results/ }

  chaos:
    runs-on: [self-hosted, chaos]
    if: github.event_name == 'workflow_dispatch'
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test:chaos
```

---

## 📋 Checklist Testing

| Categoría | Test | Estado |
|-----------|------|--------|
| **Unit** | Daemon config-loader | ⬜ |
| | Daemon connector-registry | ⬜ |
| | Daemon ws-server | ⬜ |
| | Daemon event-bus | ⬜ |
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

## 📚 Referencias
- [Fase 4: Testing](./05-FASE-4-TESTING.md)
- [Protocolo Bridge](./10-PROTOCOLO-BRIDGE-DAEMON.md)
- [Configuración](./11-CONFIGURACION.md)
- [Migración](./13-MIGRACION-DESPLIEGUE.md)