# 🚀 PROMPT INICIAL PARA EL AGENTE - FASE 2: INTEGRACIÓN DE CONECTORES

---

## 🎯 OBJETIVO PRINCIPAL

**Integrar todos los conectores existentes como Bridges MCP en la arquitectura Single Daemon (puerto 4317)**, moviendo los repos `dot-*` existentes a `packages/connectors/` y creando los bridges MCP faltantes.

---

## 🏗️ ARQUITECTURA OBJETIVO

```
┌─────────────────────────────────────────────────────────────┐
│                    DAEMON (puerto 4317)                     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           MCP PROXY (S25.4) - YA IMPLEMENTADO       │   │
│  │  • Filtra tools por modo (read_only / read_write)   │   │
│  │  • Pide approval nativo para operaciones write      │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
              WebSocket (Bridge Protocol v1)
                            ▼
┌──────────┬──────────┬──────────┬──────────┬──────────┬────────┐
│ LINEAR   │  NOTION  │  GMAIL   │  SLACK   │ ATLASSIAN│ VOICE  │
│ @linear/ │ @notionhq│  Google  │ @slack/  │@atlassian│ Native │
│  mcp     │ /mcp     │  APIs    │ mcp      │  /mcp    │ Bridge │
└──────────┴──────────┴──────────┴──────────┴──────────┴────────┘
                            │
                    ┌───────┴───────┐
                    │   DISCORD     │
                    │  (Community)  │
                    │  discord.js   │
                    └───────────────┘
```

---

## 📋 CONECTORES A IMPLEMENTAR (Orden de prioridad)

| # | Conector | Tipo | Fuente | Destino | Estado |
|---|----------|------|--------|---------|--------|
| 1 | **Telegram** | Bridge nativo (Telegraf) | `/run/media/.../dot-telegram/` | `packages/connectors/telegram/` | ✅ Repo existe |
| 2 | **WhatsApp** | Baileys + Meta Cloud | `/run/media/.../dot-whatsapp/` | `packages/connectors/whatsapp/` | ✅ Repo existe |
| 3 | **Gmail** | MCP Oficial | `/run/media/.../dot-gmail/` | `packages/connectors/gmail/` | ✅ Repo existe |
| 4 | **Discord** | MCP Community | `/run/media/.../dot-discord/` | `packages/connectors/discord/` | ✅ Repo existe |
| 5 | **Linear** | MCP Oficial `@linear/mcp` | — | `packages/connectors/linear/` | ❌ Crear |
| 6 | **Notion** | MCP Oficial `@notionhq/mcp` | — | `packages/connectors/notion/` | ❌ Crear |
| 7 | **Atlassian** | MCP Oficial `@atlassian/mcp` | — | `packages/connectors/atlassian/` | ❌ Crear |
| 8 | **Slack** | MCP Oficial `@slack/mcp` | — | `packages/connectors/slack/` | ❌ Crear |
| 9 | **Voice** | Bridge nativo | `packages/daemon/voice-tools/` | `packages/connectors/voice/` | ⚠️ Adaptar |

---

## 📍 UBICACIONES REALES (Verificadas)

| Repo | Ruta Absoluta |
|------|---------------|
| **Repo Principal (Fork)** | `/run/media/bladimir/Datos/Datos/proyectos/work/gentleman/gentle-dot/` |
| **dot-telegram** | `/run/media/bladimir/Datos/Datos/proyectos/work/gentleman/dot-telegram/` |
| **dot-whatsapp** | `/run/media/bladimir/Datos/Datos/proyectos/work/gentleman/dot-whatsapp/` |
| **dot-gmail** | `/run/media/bladimir/Datos/Datos/proyectos/work/gentleman/dot-gmail/` |
| **dot-discord** | `/run/media/bladimir/Datos/Datos/proyectos/work/gentleman/dot-discord/` |
| **Daemon Principal** | `/run/media/bladimir/Datos/Datos/proyectos/work/gentleman/gentle-dot/` |
| **Docs Reestructuración** | `/run/media/bladimir/Datos/Datos/proyectos/work/gentleman/docs/restructuring/` |

---

## 🏗️ ESTADO ACTUAL (Post-Rollback + Sync)

```
gentle-dot/
├── packages/
│   ├── daemon/ ✅ COMPLETO (Phase 1 DONE)
│   │   ├── src/ (9 archivos core)
│   │   ├── connectors.yaml ✅ (4 conectores configurados)
│   │   ├── mcp-proxy.ts ✅ (MCP Proxy S25.4)
│   │   ├── app-channel.ts ✅ (App Channel S25.1)
│   │   ├── gentle-shell-spawner.ts ✅ (Gentle Shell RPC)
│   │   ├── connectors.yaml ✅ (4 conectores base)
│   │   └── package.json / tsconfig.json ✅
│   ├── bridges/
│   │   └── base/ ✅ (BaseBridge YA EXISTE)
│   ├── connectors/ 🔄 VACÍO - CREAR
│   ├── voice-tools/ ✅ (ya existe - adaptar)
│   └── protocol/ ✅ (Bridge Protocol v1)
├── docs/restructuring/ ✅ (15 docs de referencia)
└── AGENT_PROMPT_INICIAL.md ✅
```

---

## 📚 DOCUMENTOS DE REFERENCIA (Orden de lectura)

| # | Documento | Qué contiene |
|---|-----------|--------------|
| 1 | `docs/restructuring/03-FASE-2-CONECTORES.md` | **Guía principal Fase 2** - Implementación 4 conectores |
| 2 | `docs/restructuring/10-PROTOCOLO-BRIDGE-DAEMON.md` | Bridge Protocol v1 completo |
| 3 | `docs/restructuring/11-CONFIGURACION.md` | `connectors.yaml` completo |
| 4 | `docs/restructuring/10-PROTOCOLO-BRIDGE-DAEMON.md` | Bridge Protocol v1 |
| 5 | `docs/restructuring/15-REGLAS-ORO.md` | **27 Reglas Inquebrantables** |
| 6 | `docs/restructuring/12-TESTING-PLAN.md` | Testing Plan |
| 7 | `docs/restructuring/13-MIGRACION-DESPLIEGUE.md` | Migración + Deploy |
| 8 | `docs/restructuring/14-CHECKLIST-AGENTE.md` | Checklist por fase |

---

## 🏆 REGLAS DE ORO (INQUEBRANTABLES)

| # | Regla | Descripción |
|---|-------|-------------|
| **#1** | **Single Daemon Only** | Un solo daemon en puerto 4317 |
| **#2** | **Bridges, no Daemons** | Conectores = clientes WebSocket, NO daemons propios |
| **#3** | **Config Unificada** | `connectors.yaml` único |
| **#4** | **Registry en Memoria** | Map/Object, NO base de datos |
| **#5** | **Handshake Obligatorio** | `hello` → `ready` con token auth |
| **#6** | **Tipos de Mensaje Fijos** | No inventar tipos, seguir Bridge Protocol v1 |
| **#7** | **Capabilities Declarativas** | En `hello`, daemon rutea basado en capabilities |
| **#8** | **Tokens en Env Vars** | Nunca hardcodeados, solo `process.env` |
| **#9** | **Validación Estricta** | Schema validation (zod) en boundary |
| **#10** | **Rate Limiting** | Daemon: 30 msg/s por bridge |
| **#11** | **TypeScript Strict** | `strict: true`, `noUncheckedIndexedAccess: true` |
| **#12** | **Async/Await Only** | NUNCA `.then/.catch` chains |
| **#13** | **No Blocking Sync** | Solo async versions (`fs.promises`) |
| **#14** | **Error Handling Explícito** | Error classes tipadas, logging estructurado |
| **#15** | **Resource Cleanup** | `finally` / `using` para WS, DB, timers |
| **#16** | **Tests First (TDD)** | Bug fix → Test fallando → Fix → Test pasa |
| **#17** | **Cobertura Mínima** | Unit >85%, Integration >75%, E2E: 10-15 flujos |
| **#18** | **Tests Determinísticos** | Sin flaky tests, mocks en unit tests |
| **#19** | **Deps Mínimas** | Audit antes de añadir, preferir stdlib |
| **#20** | **Version Pinning** | Exact versions, lockfile commiteado |
| **#21** | **Zero-Downtime Deploy** | Health checks, graceful shutdown, rollback <5min |
| **#22** | **Observabilidad** | Structured logging, metrics, tracing |
| **#23** | **Rollback Plan** | Script probado mensualmente, rollback <5min |
| **#24** | **Docs as Code** | `/docs/restructuring/` (markdown) |
| **#25** | **ADR para Decisiones** | Architecture Decision Records |
| **#26** | **Code Review Obligatorio** | 1 approval mínimo, CI debe pasar |
| **#27** | **Knowledge Sharing** | Pair programming, post-mortem blameless |

---

## 🚫 LO QUE NO SE TOCA (Prohibido)

| ❌ No Tocar | Razón |
|-------------|-------|
| `packages/daemon/src/` | **Ya completado Fase 1** - Ya compila y funciona |
| `packages/bridges/base/` | **BaseBridge ya existe** - Solo extender |
| `packages/daemon/connectors.yaml` | Ya configurado con 4 conectores base |
| `packages/daemon/src/` (archivos core) | `cli.ts`, `ws-server.ts`, `connector-registry.ts`, `config-loader.ts`, `daemon.ts`, `gentle-shell-spawner.ts`, `mcp-proxy.ts`, `app-channel.ts`, `config-loader.ts` |
| `packages/bridges/base/base-bridge.ts` | BaseBridge ya implementado |
| `packages/daemon/connectors.yaml` | Ya tiene 4 conectores configurados |
| **Windows native** | Sin entorno → NO TOCAR |
| **MacOS native** | Sin entorno → NO TOCAR |

---

## ✅ LO QUE SÍ SE TOCA (Fase 2)

| Qué | Acción |
|-----|--------|
| `packages/connectors/` | **Crear estructura** para 9 conectores |
| `packages/connectors/telegram/` | Integrar `dot-telegram` → adaptar a BaseBridge |
| `packages/connectors/whatsapp/` | **Mover** dot-whatsapp → adaptar Baileys + Meta Cloud |
| `packages/connectors/gmail/` | **Mover** dot-gmail → MCP Oficial |
| `packages/connectors/discord/` | **Mover** dot-discord → MCP Community |
| `packages/connectors/linear/` | **Crear** bridge MCP `@linear/mcp` |
| `packages/connectors/notion/` | **Crear** bridge MCP `@notionhq/mcp` |
| `packages/connectors/atlassian/` | **Crear** bridge MCP `@atlassian/mcp` |
| `packages/connectors/slack/` | **Crear** bridge MCP `@slack/mcp` |
| `packages/connectors/voice/` | **Adaptar** `voice-tools/` existente |
| `packages/bridges/base/` | Verificar/Completar `BaseBridge` |

---

## 📋 ORDEN DE EJECUCIÓN (Fase 2)

```bash
# 1. Crear estructura base
mkdir -p packages/connectors/{telegram,whatsapp,gmail,discord,linear,notion,atlassian,slack,voice}
mkdir -p packages/bridges/base  # ya existe

# 2. INTEGRAR dot-telegram (Bridge nativo - Telegraf)
cp -r /run/media/bladimir/Datos/Datos/proyectos/work/gentleman/dot-telegram/src packages/connectors/telegram/
# → Crear package.json, tsconfig.json
# → Adaptar a BaseBridge (handshake, heartbeat, connector_event)

# 3. INTEGRAR dot-whatsapp (Baileys + Meta Cloud)
cp -r /run/media/bladimir/Datos/Datos/proyectos/work/gentleman/dot-whatsapp/src packages/connectors/whatsapp/
# Modo 1: Baileys (bridge nativo)
# Modo 2: Meta Cloud (MCP Oficial)

# 4. INTEGRAR dot-gmail (MCP Oficial Google)
cp -r /run/media/bladimir/Datos/Datos/proyectos/work/gentleman/dot-gmail/src packages/connectors/gmail/
# - OAuth + Webhook + Google APIs

# 5. Integrar dot-discord
cp -r /run/media/bladimir/Datos/Datos/proyectos/work/gentleman/dot-discord/src packages/connectors/discord/
# - Discord.js + Slash Commands + MCP Community

# 6. CREAR bridges MCP Oficial (Linear, Notion, Atlassian, Slack)
# - linear: @linear/mcp
# - notion: @notionhq/mcp
# - atlassian: @atlassian/mcp
# - slack: @slack/mcp

# 6. Voice: adaptar voice-tools/ existente
cp -r packages/daemon/voice-tools packages/connectors/voice/

# 7. Adaptar TODOS a Bridge Protocol v1
# - Extender BaseBridge
# - Handshake hello → ready
# - Heartbeat ping/pong 30s
# - Eventos: connector_event, channel_notify
# - Comandos: connector_command, message_send

# 7. Actualizar connectors.yaml con 10 conectores
# 8. Verificar: pnpm --filter daemon build && pnpm test
```

---

## 🧪 TESTING (Regla #16 - Tests First)

```bash
# Tests requeridos por conector:
# - Unit: >85% coverage
# - Integration: handshake, heartbeat, channel_notify, command routing
# - E2E: 10-15 flujos críticos
# - MCP Proxy: read_only vs read_write + approval flow
```

---

## 🚫 PLATAFORMAS NO SOPORTADAS (No tocar)

| Plataforma | Acción |
|------------|--------|
| Windows native | ❌ Sin entorno → NO TOCAR |
| MacOS native | ❌ Sin entorno → NO TOCAR |
| **Linux (Debian/Ubuntu, Arch, Fedora, Omarchy)** | ✅ **SOLO ESTA PLATAFORMA** |

---

## 📋 CHECKLIST FASE 2 (Ver `14-CHECKLIST-AGENTE.md`)

- [ ] Estructura `packages/connectors/` creada
- [ ] BaseBridge verificado/completado
- [ ] Telegram bridge adaptado
- [ ] WhatsApp bridge (Baileys + Meta Cloud)
- [ ] Gmail bridge (MCP Oficial)
- [ ] Discord bridge (MCP Community)
- [ ] Linear bridge (MCP Oficial)
- [ ] Notion bridge (MCP Oficial)
- [ ] Atlassian bridge (MCP Oficial)
- [ ] Slack bridge (MCP Oficial)
- [ ] Voice bridge (adaptado)
- [ ] connectors.yaml actualizado (10 conectores)
- [ ] Tests unitarios >85% c/ conector
- [ ] Integration tests pasan
- [ ] Build compila sin errores

---

## 📋 COMANDO INICIAL PARA EL AGENTE

```bash
cd /run/media/bladimir/Datos/Datos/proyectos/work/gentleman/gentle-dot

# 1. Verificar estado limpio
git status  # → "nothing to commit, working tree clean"

# 2. Verificar build actual
pnpm --filter daemon build  # ✅ Debe compilar OK

# 3. Leer docs de referencia en orden
cat docs/restructuring/03-FASE-2-CONECTORES.md
cat docs/restructuring/10-PROTOCOLO-BRIDGE-DAEMON.md
cat docs/restructuring/15-REGLAS-ORO.md

# 4. EMPEZAR FASE 2 - Paso 1: Estructura
mkdir -p packages/connectors/{telegram,whatsapp,gmail,discord,linear,notion,atlassian,slack,voice}
mkdir -p packages/bridges/base  # ya existe
```

---

## 📞 ESCALACIÓN

| Situación | Acción |
|-----------|--------|
| Bloqueo técnico > 2h | Escalar inmediatamente |
| Decisión arquitectónica | Documentar en ADR |
| Test flaky persistente | Fix inmediato, no merge |
| Breaking change | Documentar + migrar |

---

## 🎯 PRÓXIMO PASO INMEDIATO

> **Ejecutar en orden:**
> 1. `cd /run/media/bladimir/Datos/Datos/proyectos/work/gentleman/gentle-dot`
> 2. `git status` → verificar limpio
> 3. `pnpm --filter daemon build` → verificar build OK
> 3. Leer `docs/restructuring/03-FASE-2-CONECTORES.md`
> 4. **Ejecutar Paso 1**: `mkdir -p packages/connectors/{telegram,whatsapp,gmail,discord,linear,notion,atlassian,slack,voice}`
> 5. **Ejecutar Paso 2**: Integrar `dot-telegram` → `packages/connectors/telegram/`

---

> **¡LISTO PARA EMPEZAR!** El agente debe leer `docs/restructuring/03-FASE-2-CONECTORES.md` y ejecutar el plan paso a paso. 🚀