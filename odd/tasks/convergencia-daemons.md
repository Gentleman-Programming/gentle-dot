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

#### Hallazgos (2026-11-04)

El daemon nuevo ya espeja al `appChannel` (socket unix): `agent_state`,
`message_done`, `engine_event`, `approval_requested` y los eventos de conectores.
El hueco concreto:

- `message_delta` **no** se espeja: va solo al conector de origen
  (`daemon.ts:164`), así que una ventana conectada no puede mostrar el texto
  llegando en vivo.
- `AppChannel` es el canal privado por socket; la app de escritorio habla el
  protocolo WS de `packages/protocol` (`hello {token, protocol}`, `send`,
  `message_delta`, `message_done`, `ask`). Falta el gateway de app del lado del
  daemon nuevo: hoy su `ws-server` valida `connectorType` y rechaza un cliente
  que no es conector.

#### Tareas

- **T2.1** Espejar `message_delta` al `appChannel` con `clientId`/`messageId`,
  sin alterar el ruteo al conector de origen. Test: un run produce deltas en
  ambos destinos y conserva el orden.
  **HECHO** (`c532cb7`), verificado E2E contra la imagen dev: el conector recibió
  la respuesta y un cliente crudo en el socket de la app recibió los mismos 4
  deltas (`DEL`, `TA`, `-`, `OK`) más `message_done` con el mismo `messageId`.
  **Test automático HECHO** (`a063709`): el harness volvió con
  `DaemonOptions.engineCommand` ([bin, ...args]) y `stop()` ya no llama
  `process.exit(0)` (`e42910f`); `test/delta-mirror.test.ts` bootea el daemon con
  el agente falso, escucha el socket de la app y verifica que llegan los mismos
  deltas, en el mismo orden y con el mismo `messageId` que al conector.
  **Sigue pendiente**: migrar los 25 archivos de gateway que todavía llaman
  `startDaemon` (fuente de la mayoría de los 181 fallos).
- **T2.2** Gateway WS de app en el daemon nuevo: aceptar el `hello` del
  protocolo v1 (clave del daemon, sin `connectorType`), responder `ready`,
  aceptar `send`/`abort`/`ui_response`, emitir `message_delta`, `message_done`,
  `agent_state` y `ask`. Test de contrato con un cliente sintético.
  **HECHO** (`3ae402d` + test `85fed4d`): un `hello` sin el sobre del bridge se
  reconoce como ventana (misma clave, sin tipo de conector) y se responde con
  `ready` plano con `protocol` y `clientId`. Sus frames entran por
  `onAppMessage` y el daemon los rutea al mismo camino de chat que los
  conectores; `deliver()` entrega los eventos del engine a quien originó el run:
  plano para una ventana, con sobre para un conector. Cubierto por
  `test/app-ws-gateway.test.ts` (ready + deltas planos + done).
  **Asks HECHO** (`41d879a`): `extension_ui_request` del engine ya no se
  ignora. Sólo viajan las preguntas reales (`select`, `confirm`, `input`,
  `editor`) como frame `ask` al origen del run; la respuesta entra por
  `ui_response` desde la ventana o desde un conector y el spawner la escribe
  directamente en stdin (`extension_ui_response`, correlacionado por el id de la
  petición, sin esperar respuesta); `ask_resolved` vuelve a quien respondió.
  Test: la ventana recibe el `ask` con sus opciones, contesta "Blue" y el motor
  sigue con "You chose Blue".
  **Falta**: historial (`get_history`/`get_earlier`), conversaciones múltiples,
  perfiles y el resto del protocolo de cliente.
- **T2.3** Coexistencia de los dos WS (conectores y app) sin confundir
  handshakes: cada uno valida su propia forma de `hello`.
- **T2.4** Verificación E2E: cliente de app sintético → respuesta visible con
  deltas en vivo.

### T3 — Portar el supervisor (lifecycle del agente)

#### Estado (2026-11-05)

Hecho:

- **Sesiones en disco** (`9122ebf`): el spawner pasaba sólo `--home`, `--mode` y el system
  prompt, así que el engine guardaba la conversación en memoria y un reinicio la borraba.
  `ShellConfig.sessionDir` y el daemon lo apunta a `sessions/` dentro de su data dir. Test:
  `test/session-dir.test.ts` verifica el argv real del engine (agente falso).
- **Steering** (`03fe73d`): un mensaje con run activo viaja con `streamingBehavior: steer` en
  vez de descartarse o abrir un segundo run. Ya estaba en el código, pero sin prueba: ahora
  `test/steer.test.ts` lo verifica contra el engine falso.
- **Asks** (hecho en T2.2, `41d879a`): aprobaciones de ida y vuelta por el mismo canal que
  originó el run.
- **Abort**: ya existía (`rpc('abort')`) para ventanas y conectores.

Falta:

- Historial hacia la ventana (`get_history`/`get_earlier`) leyendo los archivos de sesión.
- `followUp` (encolar para después del run) — hoy sólo se usa `steer`.
- Rotación y compaction: en la arquitectura nueva las hace el engine (auto-compaction); hay que
  confirmar los límites por configuración cuando se pruebe con sesiones largas.
- **Extensión de aprobaciones HECHA** (`a186ac0`): `ShellConfig.extensions` se renderiza como
  `-e` y el daemon apunta a su propio `extensions/approval-guard.ts`; antes de arrancar el
  engine reescribe `<agentHome>/extensions/gentle-dot-child-guard.ts` cuando cambió, y un fallo
  ahí se loguea pero nunca impide arrancar. Test: `test/guard-wiring.test.ts`.
- **Subagentes** (`8aaf543`): el engine recibe `GENTLE_PI_AGENTS=1` salvo
  `GENTLE_DOT_SUBAGENTS=off`, para que el interruptor y el child guard viajen juntos.

Falta de la supervisión del child guard (lo que dejan en rojo los 7 tests restantes de
`test/child-guard.test.ts`, ya migrado al harness con 2/9 en verde): proteger el archivo del
guard, reponerlo cuando cambia o desaparece mientras corre, reemplazar una carpeta
`extensions/` que pasó a ser un link sin tocar su destino, y apagarse a subagentes off cuando el
guard no se puede instalar.

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
