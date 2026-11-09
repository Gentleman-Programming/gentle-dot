# 16 · RECONCILIACIÓN 2026-11-08 — el stack vs. lo que se mergeó hoy

Este documento reconcilia el stack (00-15) con el estado real tras el sync del 8/11: merge de
upstream `main` (pin **Gentle Shell 4.7.0** / **gentle-pi 4.7.0**), los contratos nuevos de esta
sesión, y la entrega por partes. Lo que dice cada doc sigue vigente salvo lo que se marca acá.

## Estado por documento

| Doc | Estado tras el merge | Nota |
|---|---|---|
| 00 ÍNDICE | ✅ + este doc | Se agrega 16 a la lectura |
| 01 ARQUITECTURA | 🟡 actualizar | La capa MCP converge al diseño inyectado de upstream: **un endpoint MCP real por conector** (`/mcp/<id>`, protocolo completo), no un endpoint único con prefijos. El daemon inyecta `connector/credentials/approve` al proxy. |
| 02 FASE-1 | ✅ cumplida | El daemon unificado existe y está medido (suite 549/72 de 639, tag `yardstick-549`). Los contratos nuevos de seguridad de abajo se suman a esta fase. |
| 03 FASE-2 | 🟡 en curso | Telegram ✓ (30 tests) y WhatsApp ✓ (28, Baileys+Meta Cloud) cumplen el doc. **Gmail y Discord: paquetes sin tests** — son los próximos slices (docs 07/08). |
| 04 FASE-3 | 🟡 en curso | El contrato de canal vive en `bridges/base` (`brandInbound`/`createEchoGuard`); falta la integración E2E por conector (doc 12). |
| 05 FASE-4 | 🔴 pendiente | E2E (doc 12) y migración/despliegue (doc 13) sin ejecutar. La suite unit/integración está medida; el E2E no. |
| 06 TELEGRAM | ✅ vigente | 30/30 tests. El eco por message-id y el guard de canal ya están (PR de referencia en el fork). |
| 07 GMAIL | 🟡 adaptar | El "MCP Proxy" del doc es hoy el `McpProxy` inyectado de upstream con endpoint por conector (`/mcp/gmail`). El OAuth + webhook siguen siendo el alcance pendiente (0 tests). |
| 08 DISCORD | 🟡 adaptar | Ídem: slash commands pendientes; upstream merged la prep de Discord en Windows (#201) — nuestro slice es el camino Linux (doc 08) sin pisar eso. |
| 09 WHATSAPP | ✅ vigente | Baileys + Meta Cloud con 28 tests; el eco por message-id (`MessageEchoGuard`) y el shutdown pineado ya están. El issue #224 upstream documenta el alcance. |
| 10 PROTOCOLO | 🟡 actualizar | Códigos de cierre del protocolo ahora aplicados de verdad: `unauthorized: 4401`, `badProtocol: 4400`; un primer frame que no sea hello cierra 4401. **Origin veto**: los upgrades de `/ws` exigen Origin same-origin o allowlist (`tauri://localhost`, `https://tauri.localhost` + `GENTLE_DOT_ALLOWED_ORIGINS`). |
| 11 CONFIGURACIÓN | ✅ vigente | `connectors.yaml` + `renderMcpJson` escribe **URLs por conector** (`…/mcp/<id>`) con Bearer por arranque. |
| 12 TESTING-PLAN | 🟡 en curso | Unit/integración medidas (549/72). El E2E del doc es el pendiente. Los tests de arranque de daemon usan timeout 20s (el aislado crea el árbol home/). |
| 13 MIGRACIÓN-DESPLIEGUE | 🔴 pendiente | Sin cambios hoy. |
| 14 CHECKLIST | ✅ vigente | + la regla de verificación anti-duplicados antes de cada issue/PR upstream. |
| 15 REGLAS-ORO | 🟡 +2 reglas nuevas | (1) **Aislamiento del engine**: el engine corre con `HOME=<dataDir>/home`, XDG remapeado, sin secretos del daemon (`isolatedAgentEnv` — nunca el HOME del usuario). (2) **Entrega**: PRs ~400 líneas, mayores encadenados, 1 commit por unidad, no acumular (estrategia `reviewable-slices`, reemplaza single-pr). |

## Contratos nuevos de esta sesión (no estaban en el stack)

1. **El proxy MCP inyectado** (S25.4): `McpProxy` con opciones (`connector/credentials/approve/
   prepare`); el daemon cablea al store; la aprobación pide a las ventanas con preview completo
   (conector, tool, argumentos) y "Nothing was sent" si falla el pedido. Endpoint por conector.
2. **Aislamiento del engine**: `isolatedAgentEnv` cableado al arranque (HOME/XDG propios, Engram y
   git identity del usuario conservados, secretos del daemon fuera). Verificado contra el engine
   de producción en `/proc`.
3. **Origin veto en upgrades**: mismo origen o allowlist; 403 antes del handshake.
4. **Entrega por partes**: unidad revisable = fila T con su evidencia; PRs encadenados; corte de
   slice registrado en `0fdf37e`; regla anti-duplicados antes de proponer upstream.

## Referencias

- PR paraguas de la referencia: [#226 upstream](https://github.com/Gentleman-Programming/gentle-dot/pull/226)
  (declara que la rama lleva la línea completa; el port fino a main pide los 3 hooks).
- Issues con verificación cruzada: #222 (workspace — main ya lo hace bien), #223 (auth — nuestro
  bridges), #224 (whatsapp — feature proposal).
- Punto medido: tag `yardstick-549` (549 pasan / 72 fallan de 639, tsc limpio).
