# 📚 Índice de Documentación - Reestructuración gentle-dot

## 📁 Estructura de Documentos

| # | Documento | Descripción | Estado |
| --- | ----------- | ------------- | -------- |
| 00 | [INDICE.md](./00-INDICE.md) | Este índice | ✅ |
| 01 | [ARQUITECTURA.md](./01-ARQUITECTURA.md) | Arquitectura objetivo Single Daemon + Conectores | ✅ |
| 02 | [FASE-1-DAEMON-PRINCIPAL.md](./02-FASE-1-DAEMON-PRINCIPAL.md) | Fase 1: Daemon Principal Unificado | ✅ |
| 03 | [FASE-2-CONECTORES.md](./03-FASE-2-CONECTORES.md) | Fase 2: 4 Conectores Nativos | ✅ |
| 04 | [FASE-3-INTEGRACION.md](./04-FASE-3-INTEGRACION.md) | Fase 3: Integración Bridge↔Daemon | ✅ |
| 05 | [FASE-4-TESTING.md](./05-FASE-4-TESTING.md) | Fase 4: Testing + Migración + Deploy | ✅ |
| 06 | [CONECTOR-TELEGRAM.md](./06-CONECTOR-TELEGRAM.md) | Conector Telegram (nickname por usuario) | ✅ |
| 07 | [CONECTOR-GMAIL.md](./07-CONECTOR-GMAIL.md) | Conector Gmail (OAuth + Webhook + MCP Proxy) | ✅ |
| 08 | [CONECTOR-DISCORD.md](./08-CONECTOR-DISCORD.md) | Conector Discord (Slash Commands + MCP Proxy) | ✅ |
| 09 | [CONECTOR-WHATSAPP.md](./09-CONECTOR-WHATSAPP.md) | Conector WhatsApp (2 modos: Baileys + Meta Cloud) | ✅ |
| 10 | [PROTOCOLO-BRIDGE-DAEMON.md](./10-PROTOCOLO-BRIDGE-DAEMON.md) | Protocolo Bridge↔Daemon Unificado | ✅ |
| 11 | [CONFIGURACION.md](./11-CONFIGURACION.md) | Configuración connectors.yaml | ✅ |
| 12 | [TESTING-PLAN.md](./12-TESTING-PLAN.md) | Plan de Testing E2E | ✅ |
| 13 | [MIGRACION-DESPLIEGUE.md](./13-MIGRACION-DESPLIEGUE.md) | Plan de Migración y Despliegue | ✅ |
| 14 | [CHECKLIST-AGENTE.md](./14-CHECKLIST-AGENTE.md) | Checklist para el Agente | ✅ |
| 15 | [REGLAS-ORO.md](./15-REGLAS-ORO.md) | Reglas de Oro - No Romper | ✅ |
| 16 | [RECONCILIACION-2026-11-08.md](./16-RECONCILIACION-2026-11-08.md) | El stack vs. lo mergeado (4.7.0) + contratos nuevos | ✅ |

---

## 📍 Rutas de Archivos

```text
gentle-dot/
├── docs/
│   └── restructuring/
│       ├── 00-INDICE.md
│       ├── 01-ARQUITECTURA.md
│       ├── 02-FASE-1-DAEMON-PRINCIPAL.md
│       ├── 03-FASE-2-CONECTORES.md
│       ├── 04-FASE-3-INTEGRACION.md
│       ├── 05-FASE-4-TESTING.md
│       ├── 06-CONECTOR-TELEGRAM.md
│       ├── 07-CONECTOR-GMAIL.md
│       ├── 08-CONECTOR-DISCORD.md
│       ├── 09-CONECTOR-WHATSAPP.md
│       ├── 10-PROTOCOLO-BRIDGE-DAEMON.md
│       ├── 11-CONFIGURACION.md
│       ├── 12-TESTING-PLAN.md
│       ├── 13-MIGRACION-DESPLIEGUE.md
│       ├── 14-CHECKLIST-AGENTE.md
│       └── 15-REGLAS-ORO.md
```

---

## 🚀 Cómo Usar

1. **Leer en orden**: 00 → 01 → 02 → 03 → 04 → 05 → 06-09 → 10-15
2. **Asignar al agente**: Entregar documento por documento según fase
3. **Supervisión**: Revisar checkpoints en cada fase (ver CHECKLIST-AGENTE.md)
4. **Rollback**: `git stash pop` o restaurar backup si algo falla

---

## 📞 Contacto / Escalación

- **Issues técnicos**: Crear issue en repo con label `restructuring`
- **Bloqueos**: Escalar inmediatamente
- **Decisiones arquitectónicas**: Documentar en ADR (Architecture Decision Records)

---

*Generado automáticamente - Última actualización: 2025-01-15*
