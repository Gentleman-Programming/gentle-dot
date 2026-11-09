# 🏆 Reglas de Oro - No Romper

## 🎯 Principio Fundamental
> **Estas reglas son inquebrantables. Violar una = blocker inmediato.**

---

## 🏗️ Arquitectura

### 1. Single Daemon Only
```
✅ UN daemon en puerto 4317
❌ Múltiples daemons
❌ Daemons en puertos distintos
❌ Forks/workers para paralelismo
```
**Por qué:** Simplicidad operativa, debugging, resource management.

### 2. Conectores = Bridges, No Daemons
```
✅ Conectores = clientes WebSocket (bridges)
✅ Se conectan a daemon:4317/ws
❌ Conectores con sus propios puertos
❌ Conectores con HTTP servers propios
❌ Conectores que forkean procesos
```

### 3. Config Centralizada Única
```
✅ UN archivo: connectors.yaml
✅ Variables de entorno para secrets
❌ Configs dispersos
❌ Hardcoded values en código
❌ Múltiples fuentes de verdad
```

### 4. Registry en Memoria
```
✅ Estado conectores en Map/Object en daemon
✅ Persistencia solo para datos usuario (nicknames, tokens)
❌ Base de datos para registry runtime
❌ Archivos JSON para estado conectores
```

---

## 🔌 Protocolo Bridge v1

### 5. Handshake Obligatorio
```typescript
// SIEMPRE este flujo:
// 1. Bridge → Daemon: hello {token, protocol: 1, capabilities[]}
// 2. Daemon → Bridge: ready {sessionId, agentState, features}
// 3. Heartbeat: ping/pong cada 30s
```
**Nunca:** Saltar handshake, usar protocolo distinto, inventar campos.

### 6. Tipos de Mensaje Fijos
```typescript
// Bridge → Daemon: hello, channel_notify, ping, connector_register, connector_event, message_send, connector_command
// Daemon → Bridge: ready, pong, connector_event, command_result, error
```
**Nunca:** Inventar nuevos tipos, omitir campos requeridos, cambiar estructura.

### 7. Capabilities Declarativas
```typescript
// En hello, SIEMPRE declarar capabilities:
// ['channel_notify', 'message_send', 'connector_command', ...]
```
**Por qué:** Daemon rutea basado en capabilities. Sin declarar = no rutear.

---

## 🔐 Seguridad

### 8. Tokens en Env Vars Only
```
✅ DAEMON_TOKEN, TELEGRAM_BOT_TOKEN, etc. en .env
✅ Leídos via process.env en runtime
❌ Tokens hardcodeados en código
❌ Tokens en configs commiteados
❌ Tokens en logs
```

### 9. Validación Estricta
```typescript
// SIEMPRE validar entrada:
// - Schema validation (zod/joi) en boundary
// - Sanitización antes de usar
// - Rechazar payloads > 1MB
// - Timeout comandos: 30s max
```

### 10. Rate Limiting
```typescript
// SIEMPRE rate limiting:
// - Daemon: 30 msg/s por bridge
// - Bridges: según API externa (Meta: 1000/min, Discord: 50/s)
// - Backoff exponencial en reconexión
```

---

## 💻 Código

### 11. TypeScript Strict
```json
// tsconfig.json SIEMPRE:
{
  "strict": true,
  "noImplicitAny": true,
  "strictNullChecks": true,
  "noUncheckedIndexedAccess": true
}
```
**Nunca:** `any` sin justificación comentada, `ts-ignore` sin razón.

### 12. Async/Await Only
```typescript
// SIEMPRE async/await
// NUNCA .then/.catch chains
// NUNCA callbacks estilo node
// SIEMPRE try/catch en async functions
```

### 13. No Blocking Sync
```typescript
// NUNCA fs.readFileSync, JSON.parse grande, crypto sync en event loop
// SIEMPRE versiones async: fs.promises, worker_threads para CPU-intensive
```

### 14. Error Handling Explícito
```typescript
// SIEMPRE:
// - try/catch en async
// - Error classes tipadas (AppError, ValidationError, NotFoundError)
// - Logging estructurado con context
// - Nunca swallow errors sin logging
```

### 15. Resource Cleanup
```typescript
// SIEMPRE cleanup en finally / using:
// - WebSocket connections
// - DB connections
// - File handles
// - Timers/intervals (clearInterval)
// - Event listeners (removeListener)
```

---

## 🧪 Testing

### 16. Tests First (TDD cuando aplica)
```
✅ Bug fix → Test fallando primero → Fix → Test pasa
✅ Feature nueva → Tests antes/paralelo a implementación
❌ Tests después de "terminar"
❌ Tests solo happy path
```

### 17. Cobertura Mínima
```
✅ Unit: >85%
✅ Integration: >75%
✅ E2E: 10-15 flujos críticos
❌ Cobertura 0% en módulos nuevos
```

### 18. Tests Determinísticos
```
✅ Sin flaky tests (fix inmediato si flaky)
✅ Sin network real en unit tests (mocks)
✅ Sin timers reales (fake timers)
✅ Sin random sin seed fijo
```

---

## 📦 Dependencias

### 19. Minimal Dependencies
```
✅ Audit antes de añadir: ¿realmente necesario?
✅ Preferir stdlib / paquetes pequeños
✅ Revisar bundle size impact
❌ left-pad style dependencies
❌ Dependencias no mantenidas (>2 años sin updates)
```

### 20. Version Pinning
```
✅ Exact versions en package.json (no ^ ~)
✅ lockfile commiteado
✅ Dependabot/Renovate configurado
❌ Ranges sueltos en production
```

---

## 🚀 Deploy & Ops

### 21. Zero-Downtime Deploy
```
✅ Health checks obligatorios
✅ Graceful shutdown (SIGTERM → 30s max)
✅ Rolling updates (min 1 replica healthy)
✅ Rollback < 5 min
❌ Deploy sin health checks
❌ Kill -9 en producción
```

### 22. Observabilidad
```typescript
// SIEMPRE en producción:
// - Structured logging (JSON)
// - Metrics: latency, errors, throughput
// - Tracing: request IDs propagados
// - Alertas: down, high latency, high errors, memory
```

### 23. Rollback Plan
```
✅ Rollback script probado mensualmente
✅ Rollback < 5 min
✅ Data migration reversible
✅ Documentado en RUNBOOK.md
```

---

## 📚 Documentación

### 24. Docs as Code
```
✅ Docs en /docs/restructuring/ (markdown)
✅ Actualizadas con cada PR
✅ Ejemplos de código compilables
❌ Docs externas desactualizadas
❌ Confluence/Notion como única fuente
```

### 25. ADR para Decisiones Arquitectónicas
```
✅ Architecture Decision Records para:
- Cambios de protocolo
- Nuevas dependencias mayores
- Cambios breaking
- Trade-offs explícitos
```

---

## 👥 Equipo

### 26. Code Review Obligatorio
```
✅ PR requiere 1 approval mínimo
✅ Author no aprueba su propio PR
✅ CI debe pasar (tests, lint, typecheck)
✅ No merge sin review
```

### 27. Knowledge Sharing
```
✅ Pair programming para features complejas
✅ Post-mortem blameless para incidentes
✅ Tech talks mensuales
✅ Onboarding docs actualizadas
```

---

## 🎯 Excepciones (Proceso Formal)

### ¿Cuándo se puede romper una regla?
**Solo si:**
1. **Documentado** en ADR con justificación técnica
2. **Aprobado** por Tech Lead + 1 senior
3. **Temporal** con fecha de expiración
4. **Plan de migración** a compliance documentado

### Template Excepción
```markdown
# EXCEPCIÓN: [Regla #X]
**Justificación:** [Técnica, no "falta de tiempo"]
**Aprobado por:** @techlead @senior1
**Expira:** YYYY-MM-DD
**Plan migración:** [Pasos para volver a compliance]
**Riesgo:** [Qué pasa si no se fixea]
```

---

## ⚡ Quick Reference Card

| # | Regla | Emoji |
|---|-------|-------|
| 1 | Single Daemon Only | 🏗️ |
| 2 | Bridges, no Daemons | 🔌 |
| 3 | Config Unificada | ⚙️ |
| 4 | Registry en Memoria | 🧠 |
| 5 | Handshake Obligatorio | 🤝 |
| 6 | Tipos Mensaje Fijos | 📦 |
| 7 | Capabilities Declarativas | 📋 |
| 8 | Tokens en Env Vars | 🔐 |
| 9 | Validación Estricta | ✅ |
| 10 | Rate Limiting | 🚦 |
| 11 | TypeScript Strict | 📝 |
| 12 | Async/Await Only | ⏳ |
| 13 | No Blocking Sync | ⚡ |
| 14 | Error Handling | 🛡️ |
| 15 | Resource Cleanup | 🧹 |
| 16 | Tests First | 🧪 |
| 17 | Cobertura Mínima | 📊 |
| 18 | Tests Determinísticos | 🎯 |
| 19 | Deps Mínimas | 📦 |
| 20 | Version Pinning | 📌 |
| 21 | Zero-Downtime | 🚀 |
| 22 | Observabilidad | 📈 |
| 23 | Rollback Plan | 🔄 |
| 24 | Docs as Code | 📚 |
| 25 | ADR Decisiones | 📝 |
| 26 | Code Review | 👀 |
| 27 | Knowledge Sharing | 🤝 |

---

## 📋 Auditoría Mensual

### Checklist Auditoría
- [ ] ¿Todas las reglas cumplidas en código nuevo?
- [ ] ¿Exceptions documentadas y vigentes?
- [ ] ¿Tests coverage > thresholds?
- [ ] ¿Deps auditadas (npm audit)?
- [ ] ¿Rollback probado este mes?
- [ ] ¿Docs actualizadas?
- [ ] ¿Team conoce las reglas?

---

> **"La disciplina es el puente entre metas y logros."** — Jim Rohn
>
> **Estas reglas existen para que podamos movernos rápido SIN romper cosas.**
>
> **Si una regla te frena, discútela. No la ignores.**

---

*Versión 1.0 - Enero 2025 - Próxima revisión: Abril 2025*