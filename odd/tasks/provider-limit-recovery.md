# Provider limit recovery

Make a provider request failure caused by an oversized request (images or bytes) recover
invisibly: the chat stays one continuous chat and the user never sees the failure.
General daemon/engine behaviour, not platform-specific and not part of the Linux chain.

## Specs

- S1: "Deberiamos implementar un fallback o un detector, por si el proveedor tiene otro limite ya sea por imagenes o bytes geneneral (como paso ahora), que si arroja/detecta este error no lo muestre en el chat, sino qeu directamente actue y haga lo que dices de iniciar nuevo chat o compact, nose que se hacia ahi o que deberia hacer (el chat sigue viendose como unico siempre como dices, la magia es por detras por decirlo asi). Para que no se frene y el usuario ni se entere que paso algo asi. Revisa primero que solucion habria, que mecanismos actuales hay y como funciona para ver como lo afrontamos las limitaciones de proveedor que podrian surgir"
- S2: "sigamos tu recomendacion" — the approved recommendation: option (c) a total budget at the source so images never bloat the request, plus option (b) reactive recovery that rotates or compacts and re-sends the message once, invisibly, only when no tool ran in the failed turn.
- S3: "igual esto es algo general creo, no algo de mac o linux" — a general fix, its own branch and PR, because it affects macOS too.
- S4: "implementata todo primero. Cuando este dime para probar, no publiques hasta que lo pida"

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
- T4 [S1] route=worker commit=a9112e3: learn the observed ceiling per model with a margin instead of guessing.
- T5 [S1-S3] route=verify commit=pending: independent verification with deterministic tests.
- T7 [S1,S2] route=worker commit=42fa84b: a total cap for the user's own attachments, so one message cannot carry more images than a request may hold.
- T8 [S1,S2] route=worker commit=0e7b38d done: omitted image names/reasons shown via warning toast; metadata excluded from engine prompt.
- T9 [S1,S2] route=worker commit=0e7b38d done: pre-dispatch restart marker with per-recovery owners; ordered per-send attribution prevents concurrent resend duplicates. Parent focused 72 passed; worker daemon 552 passed / 13 skipped.
- T10 [S1-S3] route=worker commit=ee95d83 done: stage transitive dependencies; independent mve8kacm-d-f00t PASS, 7 tests and isolated staged-import smoke without source symlinks. Node 24 and Windows not exercised.
- T11 [S1-S3] route=worker commit=0c65a73 done: document request budgeting, omitted attachments, bounded recovery and configuration without claiming an exact provider limit or confirmed incident cause.
- T6 [S1,S3,S4] route=parent commit=pending blocked: own branch and PR, plus an upstream issue with the evidence; waiting for explicit user publication request.
- T12 [S1-S4] route=parent commit=pending: prepare a local integrated test package preserving native Linux control; no install or publication.

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
- **L10** — El usuario eligió, ante la pregunta de qué hacer con la feature: "Cerrar primero el tope de adjuntos"
  (opción 2), y publicar después. El hueco que motiva T7: `uploads.ts` limita cada imagen
  (`MAX_IMAGE_BYTES=3_750_000`) pero no la suma, y `ATTACHMENT_LIMITS` permite 10 archivos y 50 MB por mensaje,
  así que un solo mensaje puede llevar decenas de MB en imágenes que el presupuesto de T2 no puede recortar
  porque nunca toca los mensajes del usuario.

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

- **L9** — Bloqueante de la verificación independiente corregido en 2c63443. El fallo se atribuía a
  `lastPrompt`, que cualquier envío posterior sobrescribía, así que un fallo viejo llegado durante la
  recuperación se reatribuía al mensaje nuevo y lo enviaba **dos veces** en silencio (y duplicaba el efecto de
  una herramienta en ese turno). Ahora cada prompt es un `SentTurn` con identidad propia, emparejado con el
  evento de usuario del motor y con la guarda de una-por-mensaje viviendo en el registro; el reenvío siempre
  manda el turno rechazado, nunca uno más nuevo. RED reproducido antes del arreglo (`['other','other']`),
  después 20/20 focalizadas y 507 del daemon en verde, con las 17 pruebas previas intactas. Límite conocido:
  solo puede haber una recuperación en vuelo, así que un mensaje nuevo que falle mientras otra rota muestra su
  error real en esa ventana angosta (seguro, no invisible). Sigue sin verificar la muerte del daemon entre el
  fallo silenciado y el reenvío.

- **L11** — T7 en 42fa84b: `composePrompt` suma los bytes de imagen en orden de adjunto y deja de adjuntar al
  llegar al tope (`attachmentBudgetBytes` = mitad del presupuesto de petición, 4 MiB por defecto, derivado del
  mismo constante que el reescritor y el piso de recuperación para que no se desincronicen). Cada imagen que
  queda afuera mantiene su chip y lleva el motivo en el prompt. 31 pruebas del archivo y 515 del daemon en
  verde. **Hueco de honestidad**: el motivo lo ve el modelo, no el usuario, porque `AttachmentInfo` no tiene
  campo de nota y `splitAttachments` arma el chip sin motivo; el mismo hueco ya existía para una imagen
  individual demasiado grande. Arreglo acordado: avisar al usuario con un `toast` de advertencia que nombre
  cuántos adjuntos quedaron afuera y por qué, reutilizando el canal que ya existe en el protocolo; se
  implementa junto con la ventana de reinicio porque ambos tocan `bridge.ts`.

- **L12** — T4 en a9112e3: `limits.ts` guarda los techos observados en `provider-limits.json` del directorio de
  estado; el supervisor le pasa `GENTLE_DOT_PROVIDER_LIMITS_FILE` al motor en cada arranque y publica el modelo
  seleccionado; el reescritor usa `min(presupuesto configurado, techo aprendido)`, y el techo se registra solo
  cuando el reenvío **es contestado**, con margen 0,75 sobre el tamaño de la sesión rechazada. Nunca sube el
  presupuesto, es por modelo, y sin archivo o con archivo corrupto queda el presupuesto configurado. 53 pruebas
  focalizadas y 533 del daemon en verde, con mutaciones que confirman cada regla. Límites conocidos: en modo
  servidor el archivo puede ser ilegible para el usuario del motor (queda fail-closed), los subagentes heredan
  el techo del modelo padre, y el tamaño medido es el del archivo de sesión (mayor que la petición), de ahí el
  margen.
