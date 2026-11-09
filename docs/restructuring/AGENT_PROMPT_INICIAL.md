# Prompt Inicial para Agente: Reestructuración gentle-dot

---

## 🎯 Objetivo General

**Reestructurar gentle-dot** de múltiples daemons (5+ puertos) a **Single Daemon en puerto 4317** con **4 conectores/bridges** que se conectan vía WebSocket (Bridge Protocol v1). El daemon spawnea **Gentle Shell en modo RPC** sin modificarlo. Los conectores usan **MCP servers** donde existan (Gmail, Discord, WhatsApp Meta Cloud) y bridges nativos donde no (Telegram, WhatsApp Baileys).

---

## 📚 Documentación de Referencia (15 documentos en `/docs/restructuring/`)

| # | Documento | Descripción |
| --- | ----------- | ------------- |
| 00 | `00-INDICE.md` | Índice maestro |
| 01 | `01-ARQUITECTURA.md` | Arquitectura objetivo |
| 02 | `02-FASE-1-DAEMON-PRINCIPAL.md` | Daemon + Gentle Shell RPC + Engram global |
| 03 | `03-FASE-2-CONECTORES.md` | 4 conectores via MCP + BaseBridge |
| 04 | `04-FASE-3-INTEGRACION.md` | MCP Proxy (S25.4) + Native Approvals (S25.3) |
| 05 | `05-FASE-4-TESTING.md` | RED/GREEN + E2E + Chaos + Migración |
| 06 | `06-CONECTOR-TELEGRAM.md` | Bridge nativo + nickname store |
| 07 | `07-CONECTOR-GMAIL.md` | MCP Oficial + OAuth + Webhook |
| 08 | `08-CONECTOR-DISCORD.md` | MCP Community + Slash Commands + Permisos |
| 09 | `09-CONECTOR-WHATSAPP.md` | Baileys (bridge) + Meta Cloud (MCP) |
| 10 | `10-PROTOCOLO-BRIDGE-DAEMON.md` | Bridge Protocol v1 completo |
| 11 | `11-CONFIGURACION.md` | `connectors.yaml` unificado |
| 12 | `12-TESTING-PLAN.md` | RED/GREEN + E2E + Chaos |
| 13 | `13-MIGRACION-DESPLIEGUE.md` | Migración legacy + Docker + Rollback |
| 14 | `14-CHECKLIST-AGENTE.md` | Checklist por fase + red flags |
| 15 | `15-REGLAS-ORO.md` | 27 reglas inquebrantables |

**Ubicación**: `/docs/restructuring/` en el repo gentle-dot

---

## 🏗️ Arquitectura Objetivo

```text
┌─────────────────────────────────────────────────────────────┐
│                    SINGLE DAEMON (puerto 4317)              │
├─────────────────────────────────────────────────────────────┤
│  • WebSocket Server (Bridge Protocol v1)                    │
│  • Connector Registry (memoria)                             │
│  • Config Loader (connectors.yaml + hot reload)             │
│  • MCP Proxy (S25.4) - filtra tools por modo               │
│  • App Channel (S25.1) - Unix socketpair heredado          │
│  • Gentle Shell RPC Spawner                                 │
│    └── spawn gentle-shell --mode rpc --home ~/.gentle-dot/agent │
│    └── ENGRAM_PROJECT=gentle-dot                           │
│    └── --append-system-prompt (identidad sanitizada)        │
└─────────────────────────────────────────────────────────────┘
                            │
              WebSocket (Bridge Protocol v1)
                            ▼
┌──────────────┬──────────────┬──────────────┬──────────────────┐
│   TELEGRAM   │    GMAIL     │   DISCORD    │    WHATSAPP      │
│  (Bridge)    │  (MCP Proxy) │  (MCP Proxy) │  (Baileys+Meta)  │
│  • Telegraf  │  • OAuth     │  • Discord.js│  • Baileys       │
│  • Nickname  │  • Webhook   │  • Slash     │  • Meta Cloud    │
│  • Multi-chat│  • Watch     │  • Permisos  │    (MCP Proxy)   │
└──────────────┴──────────────┴──────────────┴──────────────────┘
```

---

## 🔑 Decisiones Arquitectónicas Clave (Inmutables)

| # | Decisión | Documento |
| --- | ---------- | ----------- |
| 1 | **Single Daemon Only** - Puerto 4317 único | Reglas de Oro #1 |
| 2 | **Conectores = Bridges** (WebSocket clients), no daemons | Reglas de Oro #2 |
| 3 | **Config centralizada única** - `connectors.yaml` | Reglas de Oro #3 |
| 4 | **Registry en memoria** (Map/Object), no BD | Reglas de Oro #4 |
| 5 | **Bridge Protocol v1** - Handshake obligatorio hello→ready | Reglas de Oro #5 |
| 6 | **MCP donde exista** (Gmail, Discord, WhatsApp Meta) - Daemon proxyea | Fase 2, Fase 3 |
| 3 | **Baileys = Bridge nativo** (no hay MCP oficial) | Fase 2 |
| 8 | **Gentle Shell NO se modifica** - Solo spawnea `--mode rpc` | Reglas de Oro #1, S3 |
| 9 | **Identidad sanitizada** - System prompt inyectado | Reglas de Oro #4, S4 |
| 10 | **Engram global** - Project `gentle-dot`, todas las projects buscables | Fase 1, S23 |
| 11 | **S25: MCP Proxy + Native Approvals** - Daemon filtra tools, approvals via dialog nativo | Fase 3 |
| 12 | **Solo local** - Bind 127.0.0.1, token auth | Config, S6 |
| 13 | **Single PR delivery** - Feature + tests coherentes | Testing Plan |
| 14 | **RED/GREEN Testing** - Test first, then implement | Reglas de Oro #16 |

---

## 📦 Estructura de Paquetes a Crear

```text
gentle-dot/
├── packages/
│   ├── daemon/                      # Daemon principal
│   │   ├── src/
│   │   │   ├── cli.ts               # Entry point
│   │   │   ├── ws-server.ts         # WebSocket Server
│   │   │   ├── connector-registry.ts # Registry en memoria
│   │   │   ├── config-loader.ts     # Carga connectors.yaml
│   │   │   ├── daemon.ts            # Orquestador + Shell Spawner
│   │   │   ├── mcp-proxy.ts         # MCP Proxy (S25.4)
│   │   │   ├── app-channel.ts       # App Channel (S25.1)
│   │   │   └── gentle-shell-spawner.ts # Spawn Gentle Shell RPC
│   │   ├── connectors.yaml          # Config central
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── connectors/
│   │   ├── telegram/                # Bridge nativo (Telegraf)
│   │   ├── gmail/                   # OAuth + Webhook (MCP Oficial)
│   │   ├── discord/                 # Discord.js + Slash Commands (MCP Community)
│   │   └── whatsapp/                # Baileys + Meta Cloud (MCP Oficial)
│   │
│   └── bridges/
│       └── base/                    # BaseBridge class compartida
│
├── docs/restructuring/              # 15 documentos (ya creados)
└── docker-compose.yml               # Para deploy
```

---

## 🚀 Cómo Empezar (Orden de Ejecución)

### Paso 1: Setup Inicial

```bash
# 1. Clonar repo y crear branch
git checkout -b restructure/single-daemon

# 2. Verificar docs existen
ls docs/restructuring/

# 3. Leer en orden: 00 → 01 → 02 → 03 → 04 → 05 → 06-09 → 10-15
```

### Paso 2: Fase 1 - Daemon Principal (02-FASE-1-DAEMON-PRINCIPAL.md)

```bash
# Crear estructura
mkdir -p packages/daemon/src packages/bridges/base/src

# Implementar en orden:
# 1. connector-registry.ts (Registry en memoria)
# 2. config-loader.ts (Carga connectors.yaml + hot reload)
# 3. ws-server.ts (WebSocket Server + Bridge Protocol v1)
# 4. gentle-shell-spawner.ts (Spawn Gentle Shell RPC)
# 5. mcp-proxy.ts (MCP Proxy - S25.4)
# 5. app-channel.ts (App Channel - S25.1)
# 6. daemon.ts (Orquestador principal)
# 7. cli.ts (Entry point)
# 8. connectors.yaml (Config central)
# 9. package.json + tsconfig.json

# Verificar
pnpm --filter daemon build
pnpm --filter daemon test
curl http://localhost:4317/health  # → {"ok":true}
```

### Paso 3: Fase 2 - Conectores (03-FASE-2-CONECTORES.md)

```bash
# Orden sugerido:
# 1. bridges/base/base-bridge.ts (BaseBridge compartida)
# 2. connectors/telegram/ (Bridge nativo - Telegraf)
# 3. connectors/gmail/ (OAuth + Webhook - MCP Oficial)
# 5. connectors/discord/ (Discord.js + Slash Commands - MCP Community)
# 6. connectors/whatsapp/ (Baileys + Meta Cloud - MCP Oficial para Meta)

# Cada conector:
# - index.ts (Entry point)
# - *-bridge.ts (Extends BaseBridge)
# - Config validation
# - Tests unitarios
```

### Paso 4: Fase 3 - Integración (04-FASE-3-INTEGRACION.md)

```bash
# 1. MCP Proxy (mcp-proxy.ts) - Filtra tools por modo, pide approval para write
# 2. App Channel (app-channel.ts) - Unix socketpair heredado del desktop app
# 3. Native Approvals - Dialog nativo del desktop app (S25.3)
# 4. Integración completa: Daemon + 4 Bridges + MCP Proxy
# 5. Tests de integración (handshake, channel_notify, command routing, reconexión)
```

### Paso 5: Fase 4 - Testing + Migración + Deploy (05-FASE-4-TESTING.md + 13-MIGRACION-DESPLIEGUE.md)

```bash
# Tests
pnpm test:unit        # >85% coverage
pnpm test:integration # 15 escenarios críticos
pnpm test:e2e         # 15 flujos críticos
pnpm test:perf        # k6 load/stress
pnpm test:chaos       # 5 escenarios chaos

# Migración Legacy → Nuevo
# 1. Paralelo en staging
# 2. Canary en prod
# 3. Cutover (detener legacy daemons 4318-4322)
# 4. Limpieza legacy

# Deploy
docker compose -f docker-compose.prod.yml up -d
```

---

## ✅ Checklist de Inicio (Ver 14-CHECKLIST-AGENTE.md)

### Pre-Commit (Obligatorio)

- [ ] `pnpm lint` pasa sin errores
- [ ] `pnpm typecheck` pasa sin errores
- [ ] `pnpm test:unit` pasa (>85% coverage)
- [ ] No `console.log` / `debugger` en código
- [ ] No `any` types sin justificación
- [ ] Imports ordenados
- [ ] Nombres descriptivos

### Reglas de Oro (Ver 15-REGLAS-ORO.md)

- **Regla #1**: Single Daemon Only
- **Regla #2**: Bridges, no Daemons
- **Regla #3**: Config Unificada
- **Regla #4**: Registry en Memoria
- **Regla #5**: Handshake Obligatorio
- **Regla #16**: Tests First (TDD)
- **Regla #21**: Zero-Downtime Deploy

---

## 🚨 Red Flags (Detener y Revisar)

| Señal | Acción |
| ------- | -------- |
| Test flaky | Fix inmediato, no merge |
| Coverage baja | Añadir tests antes de continuar |
| Lint error | Fix antes de commit |
| Type error | Fix antes de commit |
| Bundle size +20% | Investigar y optimizar |
| Nueva dependencia sin justificar | Revisar necesidad |
| Breaking change sin docs | Documentar antes de merge |
| Hardcoded config | Mover a connectors.yaml |
| Console.log en prod | Remover |
| Any type sin comentario | Tipar o justificar |

---

## 📞 Escalación

| Situación | Acción |
| ----------- | -------- |
| Bloqueo técnico > 2h | Escalar inmediatamente |
| Decisión arquitectónica | Documentar en ADR |
| Test flaky persistente | Fix inmediato, no merge |
| Breaking change | Documentar + migrar |

---

## 📝 Primer Commit Sugerido

```bash
git add packages/daemon/
git commit -m "feat(daemon): unify daemon on port 4317 with connector registry and WS server

- Add connector-registry.ts for in-memory connector registry
- Add ws-server.ts for WebSocket bridge connections
- Add config-loader.ts for connectors.yaml loading
- Update cli.ts as unified entry point
- Add connectors.yaml with all 4 connectors config
- Add gentle-shell-spawner.ts for RPC mode spawn
- Add mcp-proxy.ts for MCP Proxy (S25.4)
- Add app-channel.ts for App Channel (S25.1)
- Update package.json scripts
"
```

---

## 🎯 Objetivo Final

> **Un solo daemon en puerto 4317** que orquesta 4 bridges/connectores via WebSocket, proxyea MCP servers donde existan, spawnea Gentle Shell en modo RPC con identidad sanitizada, usa Engram global (project `gentle-dot`), y permite migración zero-downtime desde los 5+ daemons legacy.

---

## 📍 Archivos de Referencia Rápida

| Documento | Qué contiene |
| ----------- | -------------- |
| `02-FASE-1-DAEMON-PRINCIPAL.md` | Código completo daemon (5 archivos) |
| `03-FASE-2-CONECTORES.md` | 4 conectores + BaseBridge |
| `04-FASE-3-INTEGRACION.md` | MCP Proxy + App Channel + Native Approvals |
| `05-FASE-4-TESTING.md` | Testing + Migración + Deploy |
| `14-CHECKLIST-AGENTE.md` | Checklist por fase + red flags |
| `15-REGLAS-ORO.md` | 27 reglas inquebrantables |

---

**¿Listo para empezar? Comienza leyendo `02-FASE-1-DAEMON-PRINCIPAL.md` y creando la estructura de `packages/daemon/`.** 🚀
