# Convergencia de daemons — un solo daemon para todo

## Contexto

La reestructuración dejó dos daemons conviviendo:
- **Viejo (producción, 4317)**: supervisor completo — app de escritorio, ventanas,
  conversaciones, asks, voice, uploads, perfiles. Sin conectores v2.
- **Nuevo (repo, phase2-clean → main)**: WS de bridges v2, engine RPC (chat
  bidireccional verificado con nan), appChannel, registro de conectores,
  dockerización. Sin supervisor ni UI.

**Meta**: un solo daemon que haga todo. Rosita, la app de escritorio y los
nuevos servicios (Linear/Notion/Atlassian/Slack) contra el mismo proceso.

## Tareas (orden de ejecución)

### T1 — E2E chat real con Rosita (primer cierre visible)
- Pausar el bridge Telegram de producción (mismo token → conflicto 409).
- Daemon nuevo (4318) + conector telegram con `TELEGRAM_BOT_TOKEN_ROSITA`.
- Conversar desde el celular; el engine (nan) responde al chat.
- **Criterio**: respuesta real del asistente en el teléfono.
- Reanudar Rosita de producción al terminar.

#### Estado T1 (2026-11-04)

Capa técnica **verificada de punta a punta**, sin tocar el canal del usuario:
cliente sintético contra `ws://127.0.0.1:4318/ws` → `ready` → prompt → 3
`message_delta` → `message_done` con texto correcto en 4.1s, engine
`nan/deepseek-v4-flash`. El conector real también conectó y quedó
`listening as @rosita_dot_bot` (sin 409) cuando se pausó producción.

Fallos encontrados y corregidos en el camino (en `main`):

- `1def3cb` — `BaseBridge.connect()` nunca resolvía el handshake: `start()`
  colgaba eternamente aunque todo estuviera bien.
- `d532891` — el conector mandaba el token del bot como credencial del daemon
  (1008). Ahora lee `GENTLE_DOT_TOKEN_FILE` y falla cerrado.
- `f582149` — el timeout de readiness del engine era fijo en 30s y el primer
  arranque provisiona paquetes gentle-ai durante minutos; el daemon mataba al
  engine a mitad del provisioning y reiniciaba en bucle. Nuevo
  `GENTLE_DOT_ENGINE_READY_TIMEOUT_MS`.
- mount del agent home en `docker-compose.dev.yml`: `${HOME}` del shell del
  asistente apuntaba a un directorio vacío → engine sin API key. Stack de dev
  debe levantarse con `HOME=<home real>` explícito.

Pendiente para cerrar T1 en el canal real: una ventana acordada para tomar el
bot de Rosita (el intento del 2026-11-04 dejó el chat en loop porque el engine
moría y el conector reconectaba en círculo). Alternativa sin riesgo:
validar con un bot de prueba y tocar Rosita recién en el cutover de T5.

### T2 — Portar el Bridge de UI al daemon nuevo
- Los clientes de la app/ventanas (WebSocket del navegador) conectan al daemon
  nuevo: `message_delta`, `message_done`, `ask`, `agent_state` hacia las ventanas.
- **Criterio**: la app de escritorio muestra la conversación en vivo.

### T3 — Portar el supervisor (lifecycle del agente)
- Prompts con historial de sesión, asks de aprobación, steering/followUp,
  abort, rotación, Compaction.
- Sobre el RPC client del spawner (ya verificado: prompt/set_model/abort).
- **Criterio**: un prompt desde la app produce la misma secuencia de eventos
  que en producción.

### T4 — Features incrementales
- Uploads HTTP (attachments de Telegram ya los envían como base64/refs).
- Voice (transcribe/speak) contra el engine.
- Perfiles y modelo por UI (GENTLE_DOT_ENGINE_MODEL → dinámico).
- Conversaciones múltiples (list/open).

### T5 — Cutover: apagar el daemon viejo
- Producción 100% en el daemon nuevo (4317): Rosita, la app y los servicios.
- El viejo queda solo como rollback.

### T6 — Docker hardening + deploy
- Engine como usuario `dot` (S25.8) en el contenedor; endpoint `/health`.
- `build:runtime` del daemon nuevo → actualización del runtime instalado.

## Reglas

- Un commit por tarea/trozo (Conventional), tests cuando apliquen.
- Producción (4317) no se toca hasta T5; todo en 4318/4318-dev.
- Si T1 rompe Rosita más de lo esperado, rollback inmediato y T2 primero.
