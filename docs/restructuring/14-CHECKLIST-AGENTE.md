# ✅ Checklist para el Agente

## 🎯 Uso
Este checklist debe completarse **antes de cada commit** y **al finalizar cada fase**.

---

## 📋 Pre-Commit (Obligatorio)

### Code Quality
- [ ] `pnpm lint` pasa sin errores
- [ ] `pnpm typecheck` pasa sin errores
- [ ] `pnpm test:unit` pasa (>85% coverage)
- [ ] No `console.log` / `debugger` en código
- [ ] No `any` types sin justificación
- [ ] Imports ordenados (externos → internos → relativos)
- [ ] Nombres descriptivos (no `a`, `b`, `data`, `temp`)

### Tests
- [ ] Tests nuevos para funcionalidad añadida
- [ ] Tests existentes pasan
- [ ] Edge cases cubiertos (empty, null, error, timeout)
- [ ] Mocks correctos (no network real en unit tests)

### Documentación
- [ ] JSDoc en funciones públicas
- [ ] README actualizado si cambio API
- [ ] CHANGELOG.md actualizado
- [ ] Docs en `/docs/restructuring/` sincronizadas

### Git
- [ ] Branch name: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`
- [ ] Commit message: Conventional Commits (`feat:`, `fix:`, `docs:`, etc.)
- [ ] Un commit por cambio lógico
- [ ] No commits WIP / fixup en historia final

---

## ✅ Post-Commit / Pre-PR

### CI/CD
- [ ] GitHub Actions pasan (unit, integration, lint, typecheck)
- [ ] Coverage no bajó (>85% unit, >75% integration)
- [ ] Bundle size no aumentó significativamente
- [ ] No nuevas vulnerabilidades (npm audit)

### Revisión
- [ ] Self-review completado
- [ ] Archivos cambiados revisados en diff
- [ ] Breaking changes documentados
- [ ] Migration guide si aplica

---

## 🚀 Por Fase

### Fase 1: Daemon Principal
#### Desarrollo
- [ ] `packages/daemon/src/cli.ts` - flags, help, version
- [ ] `packages/daemon/src/config-loader.ts` - load, validate, watch, hot-reload
- [ ] `packages/daemon/src/ws-server.ts` - handshake, routing, heartbeat, broadcast
- [ ] `packages/daemon/src/connector-registry.ts` - register, unregister, list, cleanup
- [ ] `packages/daemon/src/daemon.ts` - start, stop, signals, lifecycle
- [ ] `packages/daemon/src/event-bus.ts` - emit, subscribe, routing
- [ ] `packages/daemon/connectors.yaml` - config template

#### Tests
- [ ] Unit: config-loader (load, validate, watch, merge)
- [ ] Unit: connector-registry (register, unregister, list, heartbeat)
- [ ] Unit: ws-server (handshake, routing, heartbeat, disconnect)
- [ ] Unit: daemon (start, stop, signals, graceful shutdown)
- [ ] Integration: handshake hello→ready, ping/pong, reconnect
- [ ] Integration: multi-bridge concurrent connections

#### Deploy
- [ ] Dockerfile daemon
- [ ] docker-compose.yml (daemon + bridges)
- [ ] Health check endpoint `/health`
- [ ] Connectors endpoint `/connectors`
- [ ] Config validation CLI

### Fase 2: Conectores Nativos
#### Telegram
- [ ] `packages/connectors/telegram/src/index.ts`
- [ ] `packages/connectors/telegram/src/telegram-bridge.ts`
- [ ] `packages/connectors/telegram/src/bot/bot.ts`
- [ ] `packages/connectors/telegram/src/commands/nickname.ts`
- [ ] `packages/connectors/telegram/src/commands/status.ts`
- [ ] `packages/connectors/telegram/src/commands/help.ts`
- [ ] `packages/connectors/telegram/src/storage/nickname-store.ts`
- [ ] `packages/connectors/telegram/src/handlers/message.ts`
- [ ] Tests: nickname-store, commands, handlers

#### Gmail
- [ ] `packages/connectors/gmail/src/index.ts`
- [ ] `packages/connectors/gmail/src/gmail-bridge.ts`
- [ ] `packages/connectors/gmail/src/auth/oauth.ts`
- [ ] `packages/connectors/gmail/src/api/gmail-client.ts`
- [ ] `packages/connectors/gmail/src/api/watch.ts`
- [ ] `packages/connectors/gmail/src/webhook/handler.ts`
- [ ] Tests: oauth, webhook, send, token refresh

#### Discord
- [ ] `packages/connectors/discord/src/index.ts`
- [ ] `packages/connectors/discord/src/discord-bridge.ts`
- [ ] `packages/connectors/discord/src/bot/client.ts`
- [ ] `packages/connectors/discord/src/commands/status.ts`
- [ ] `packages/connectors/discord/src/commands/send.ts`
- [ ] `packages/connectors/discord/src/commands/connector.ts`
- [ ] `packages/connectors/discord/src/permissions/checker.ts`
- [ ] Tests: permissions, commands, events

#### WhatsApp (Baileys + Meta Cloud)
- [ ] `packages/connectors/whatsapp/src/index.ts` (selector modo)
- [ ] `packages/connectors/whatsapp/src/unified-api.ts`
- [ ] Baileys: session-store, qr-handler, multi-device, connection-manager
- [ ] Meta Cloud: webhook-handler, template-manager, media-handler, rate-limiter
- [ ] Tests: session-store, qr-handler, webhook, templates, rate-limiter

### Fase 3: Integración
- [ ] Handshake completo (hello → ready → ping/pong)
- [ ] Channel notify E2E (Gmail → Telegram)
- [ ] Command routing (Daemon → Bridge → WhatsApp)
- [ ] Multi-bridge concurrent (4 bridges + daemon)
- [ ] Reconexión auto (daemon reinicia → bridges reconectan)
- [ ] Hot reload config (cambio yaml → recarga sin restart)
- [ ] Graceful shutdown (SIGTERM → cierra WS + guarda estado)
- [ ] Error handling (malformed → daemon responde error)

### Fase 4: Testing + Migración + Deploy
- [ ] Unit tests >85% coverage todos paquetes
- [ ] Integration tests 8 escenarios críticos
- [ ] E2E tests 10 flujos críticos
- [ ] Performance tests k6 (load, stress, soak)
- [ ] Chaos tests 5 escenarios
- [ ] CI/CD pipeline completo
- [ ] Docker compose prod
- [ ] Rollback plan probado
- [ ] Migración legacy → nuevo (zero-downtime)
- [ ] Monitoreo post-deploy 24h

---

## 🔍 Code Review Checklist

### Arquitectura
- [ ] Respeta Single Daemon + Bridges
- [ ] Usa BaseBridge para nuevos conectores
- [ ] Protocolo Bridge v1 seguido exactamente
- [ ] Config centralizada en `connectors.yaml`
- [ ] No hardcoded ports/tokens/urls

### Seguridad
- [ ] Tokens en env vars (no hardcoded)
- [ ] Validación input en todos endpoints
- [ ] Rate limiting implementado
- [ ] Secrets ofuscados en logs
- [ ] HTTPS/TLS en producción

### Performance
- [ ] No blocking sync en event loop
- [ ] Connection pooling donde aplica
- [ ] Memory leaks checked (heap snapshots)
- [ ] Bundle size razonable

### Mantenibilidad
- [ ] Código autodocumentado
- [ ] Complejidad ciclomática <10
- [ ] Funciones <50 líneas
- [ ] DRY - no duplicación

---

## 📦 Release Checklist

### Pre-Release
- [ ] Version bump (semver)
- [ ] CHANGELOG.md actualizado
- [ ] Migración DB si aplica
- [ ] Docs actualizadas
- [ ] Todos tests pasan en CI

### Release
- [ ] Tag git: `git tag -a v1.2.3 -m "Release v1.2.3"`
- [ ] GitHub Release creado
- [ ] Docker images pushed
- [ ] Deploy staging → smoke tests
- [ ] Deploy production (canary → full)

### Post-Release
- [ ] Monitoreo 24h
- [ ] Rollback plan verificado
- [ ] Comunicación a stakeholders
- [ ] Métricas baseline actualizadas

---

## 🚨 Red Flags (Detener y Revisar)

| Señal | Acción |
|-------|--------|
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

## 📚 Referencias
- [Reglas de Oro](./15-REGLAS-ORO.md)
- [Protocolo Bridge](./10-PROTOCOLO-BRIDGE-DAEMON.md)
- [Configuración](./11-CONFIGURACION.md)
- [Testing](./12-TESTING-PLAN.md)
- [Migración](./13-MIGRACION-DESPLIEGUE.md)