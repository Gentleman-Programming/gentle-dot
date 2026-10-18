# Provider limit recovery

Make a provider request failure caused by an oversized request (images or bytes) recover
invisibly: the chat stays one continuous chat and the user never sees the failure.
General daemon/engine behaviour, not platform-specific and not part of the Linux chain.

## Specs

- S1: "Deberiamos implementar un fallback o un detector, por si el proveedor tiene otro limite ya sea por imagenes o bytes geneneral (como paso ahora), que si arroja/detecta este error no lo muestre en el chat, sino qeu directamente actue y haga lo que dices de iniciar nuevo chat o compact, nose que se hacia ahi o que deberia hacer (el chat sigue viendose como unico siempre como dices, la magia es por detras por decirlo asi). Para que no se frene y el usuario ni se entere que paso algo asi. Revisa primero que solucion habria, que mecanismos actuales hay y como funciona para ver como lo afrontamos las limitaciones de proveedor que podrian surgir"
- S2: "sigamos tu recomendacion" — the approved recommendation: option (c) a total budget at the source so images never bloat the request, plus option (b) reactive recovery that rotates or compacts and re-sends the message once, invisibly, only when no tool ran in the failed turn.
- S3: "igual esto es algo general creo, no algo de mac o linux" — a general fix, its own branch and PR, because it affects macOS too.

## Design boundaries

- The user sees one continuous chat. Rotation and compaction happen behind it, never as a new visible conversation and never as an error the user must act on.
- Recovery never repeats side effects: if any tool ran in the failed turn, the failure is shown instead of retried.
- One automatic recovery per user message. A second failure shows the provider's real error; a genuine outage is never masked as a size problem.
- Nothing is deleted: rotation keeps the previous session in its chain, as it does today.
- The provider's real limit is not knowable (the error carries no body and varies by model), so the threshold is learned from observed failures with a margin, never hardcoded as a provider claim.

## Tasks

- T1 [S1-S3] route=parent commit=n/a done: investigate existing mechanisms, image caps and error path (explore mvdireuc-n-muwf).
- T2 [S1,S2] route=worker commit=88b1646: total request budget at the source, so accumulated images cannot bloat the request.
- T3 [S1,S2] route=worker commit=b8fa0cd,37063b3: reactive recovery with one invisible re-send, suppressed error on the first attempt.
- T4 [S1] route=worker commit=pending: learn the observed ceiling per model with a margin instead of guessing.
- T5 [S1-S3] route=verify commit=pending: independent verification with deterministic tests.
- T6 [S1,S3] route=parent commit=pending: own branch and PR, plus an upstream issue with the evidence.

## Log

- **L1** — "Deberiamos implementar un fallback o un detector, por si el proveedor tiene otro limite ya sea por
  imagenes o bytes geneneral (como paso ahora), que si arroja/detecta este error no lo muestre en el chat,
  sino qeu directamente actue y haga lo que dices de iniciar nuevo chat o compact, nose que se hacia ahi o
  que deberia hacer (el chat sigue viendose como unico siempre como dices, la magia es por detras por decirlo
  asi). Para que no se frene y el usuario ni se entere que paso algo asi. Revisa primero que solucion habria,
  que mecanismos actuales hay y como funciona para ver como lo afrontamos las limitaciones de proveedor que
  podrian surgir"
- **L2** — "sigamos tu recomendacion": (c) presupuesto total en origen + (b) recuperación reactiva con reenvío
  único, solo si no corrió ninguna herramienta en el turno fallido.
- **L3** — "igual esto es algo general creo, no algo de mac o linux": rama y PR propios, no capas de la cadena
  de Linux.
- **L4** — Investigación (mvdireuc-n-muwf). Evidencia: `bridge.ts:124` `ANSWER_FAILED`; `bridge.ts:1290-1302`
  `onMessageEnd` solo lee `{role,stopReason,errorMessage}`, loguea y emite `message_done{error}`, así que el
  daemon decide si el error se muestra; el motor formatea `status`/`body` a un string antes del RPC
  (`normalizeProviderError`), y un 500 sin cuerpo no distingue tamaño de caída. El motor ya compacta con
  recuperación por overflow de tokens (`_runAutoCompaction` con `reason:"overflow"`, omite el intento fallido
  y reintenta) pero no por un 500 de tamaño, y expone `compact` por RPC. Topes existentes: subidas
  `MAX_IMAGE_BYTES=3_750_000` (`uploads.ts`), imágenes del motor 2000px/4.5MB por imagen
  (`image-resize-core.js`), y `screenshot-context.ts:pruneScreenshots` que reemplaza todas las capturas
  `mcp__computer__` menos la última **solo en la petición**. No hay tope de total ni del historial: por eso 18
  imágenes de 1.4-1.9MB (cada una dentro del tope individual) rompieron la petición, con la sesión atrapada en
  16.95 MiB y la rotación en 20 MiB (`rotation.ts:11`) inalcanzable.
- **L5** — Evidencia en vivo del caso que motiva la feature: `opencode-go API error (500): 500 status code (no
  body)` repetido en `~/.gentle-dot/daemon.log`; la sesión del usuario con 16.9 MiB de los cuales 96% son
  imágenes (18 capturas, 16.2 MB en base64), y el chat dejó de responder incluso a "hola?".

- **L6** — T2 en 88b1646: `applyRequestBudget` en `screenshot-context.ts`, compuesto con `pruneScreenshots` en el
  hook de contexto de `approval-guard.ts`. Mide la petición (base64 de imágenes + texto), recorta las imágenes
  más viejas de cualquier herramienta conservando la última, y solo si no alcanza trunca el texto viejo de
  toolResult (>=2000 chars a 500 + marcador). Nunca toca mensajes de usuario ni de asistente; bajo presupuesto
  devuelve el mismo array. Umbral por defecto 8 MiB por `GENTLE_DOT_REQUEST_BUDGET_BYTES`, documentado como
  punto de partida y no como límite del proveedor. 15 pruebas del archivo y 482 del daemon en verde; los 4
  tests previos de `pruneScreenshots` intactos. Hueco conocido: las imágenes que adjunta el usuario no se
  recortan (no se toca su mensaje), así que un mensaje con muchos adjuntos puede seguir superando el
  presupuesto; corresponde limitarlo en la subida.

- **L7** — T3 en b8fa0cd: `isSizeLimitError` en `bridge.ts` más la recuperación (rotar primero con
  `SessionRotator.forceRotate`, reenviar el prompt guardado, suprimir el error en el primer intento, mostrar el
  real si el segundo falla). Guardas: ninguna herramienta en el turno, una recuperación por mensaje, y si no
  puede rotar muestra el error. 26 pruebas focalizadas y 494 del daemon en verde; la mutación que quita la
  guarda de herramienta hace fallar su test. **Hueco crítico**: la detección es por texto y no coincide con el
  error real del incidente (`500 status code (no body)`), así que el caso observado no se recuperaba; y una
  recarga en frío del historial muestra el turno rechazado dos veces (el anterior sigue en la cadena).

- **L8** — Huecos de L7 cerrados en 37063b3. Detección por correlación: `canRecover` acepta la firma de texto
  **o** que la sesión viva supere el piso (`recoveryFloorBytes` = mitad del presupuesto de petición, 4 MiB por
  defecto), siempre con las guardas de ninguna-herramienta y una-por-mensaje; el reintento es el discriminador,
  así que el incidente real se recupera sin que una caída quede tapada y un 500 en una conversación chica sigue
  mostrando el error. Recarga en frío: `chainTurns` en `conversations.ts` descarta de la página el par
  pregunta+respuesta vacía del turno rechazado solo cuando el archivo siguiente abre con ese mismo mensaje; no
  escribe ni borra nada en disco y una respuesta real o un turno con herramientas nunca se descartan. 38
  pruebas focalizadas y 504 del daemon en verde. Sin verificar: el techo real del proveedor (T4) y el
  comportamiento contra un proveedor vivo.
