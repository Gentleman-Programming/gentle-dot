# Migrar los tests de gateway al harness nuevo

Contexto: el refactor cambió el arranque del daemon y **24 archivos de test** quedaron
llamando `startDaemon`, que ya no existe. Son la causa principal de los 181 tests en rojo.

## El mapeo (una sola vez, en `test/harness.ts`)

| Antes (`startDaemon`) | Ahora |
| --- | --- |
| `startDaemon({ port, host, dataDir, workspace, uiDir })` | `bootDaemon({ port, dataDir, workspace })` |
| `agentCommand: process.execPath, agentArgs: [FAKE_AGENT]` | `engineCommand: [process.execPath, FAKE_AGENT]` (default del harness) |
| `agentHome: <dir>` | `env: { GENTLE_DOT_AGENT_HOME: <dir> }` |
| `agentEnv: { ... }` | `env: { ... }` (se aplica antes del boot y se restaura al parar) |
| `uiDir` | ya no existe: la UI no la sirve el daemon refactorizado |
| `d.close()` | `booted.stop()` |

Detalles que rompen silenciosamente:

- `HOME` tiene que apuntar al home del harness **antes** de importar `daemon.ts`: AppChannel
  resuelve `$HOME/.gentle-dot/app-channel.sock` al cargar el módulo. Por eso el harness usa
  import dinámico y exporta `APP_SOCKET_PATH`.
- `configPath` es obligatorio: el loader resuelve su default contra el cwd y el daemon necesita
  los bloques reales de conectores (`Missing daemon configuration` con un stub).
- `Daemon.stop()` ya no llama `process.exit`.

## Cómo migrar un archivo

1. Borrar el import de `startDaemon` y el de `../src/daemon.ts` si solo se usaba para eso.
2. Reemplazar el helper de setup por `bootDaemon({...})`.
3. `d.close()` → `booted.stop()`.
4. Variables que iban en `agentEnv` → `env:` del harness.
5. Correr ese archivo solo: `npx vitest run test/<archivo>`.

Patrón de referencia verde: `test/delta-mirror.test.ts` (T2.1) y `test/harness.test.ts`.

## Triage: no todo se migra

Algunos tests cubren features que el daemon refactorizado **todavía no tiene**. Migrarlos
crearía tests que pasan sin probar nada. Antes de tocar cada archivo, clasificarlo:

- **MIGRAR**: la superficie existe en el daemon nuevo (bridges/conectores, app channel,
  engine RPC, aislamiento, child guard, auth).
- **PARK**: la feature está en el roadmap pero no existe todavía (uploads y voice → T4;
  perfiles y selector de modelo → T4; server mode / VPS y engine como otro usuario → T6;
  conversaciones múltiples → T4).
- **BORRAR**: la feature se fue con el refactor y no está en el plan (p. ej. la limpieza del
  memory server privado de `private-memory.test.ts`).

Estado por archivo (a confirmar al abrirlo, no de memoria):

| Archivo | Veredicto | Nota |
| --- | --- | --- |
| `delta-mirror.test.ts` | HECHO | patrón de referencia |
| `harness.test.ts` | HECHO | prueba el propio harness |
| `private-memory.test.ts` | BORRAR (probable) | limpieza del Engram privado: no está en el daemon nuevo |
| `gateway.test.ts` | MIGRAR por partes | 4 usos; mezcla el WS base con conversaciones y white-label |
| `app-channel.test.ts` | MIGRAR | AppChannel existe |
| `child-guard.test.ts` | MIGRAR | la extensión corre en el engine |
| `isolation.test.ts` | MIGRAR | aislamiento del engine |
| `auth.test.ts` | MIGRAR | `auth.ts` existe |
| `lifecycle.test.ts` | MIGRAR | ciclo de vida del daemon |
| `real-agent.test.ts` | PARK | necesita el engine de verdad (red + clave) |
| `uploads.test.ts`, `voice.test.ts` | PARK | T4 |
| `profiles-gateway.test.ts`, `models-gateway.test.ts` | PARK | T4 (perfiles/selector) |
| `vps-*.test.ts` (auth-helper, gateway, root) | PARK | server mode / T6 |
| `connectors-*.test.ts`, `connector-*.test.ts` | MIGRAR | registro y proxying de conectores existen |
| `computer.test.ts`, `subagent-probe.test.ts` | MIGRAR | tools del engine |

Regla: si al abrir un archivo la feature no aparece en `src/`, se marca PARK o BORRAR con una
línea de justificación, no se migra a ciegas.

## Medición (2026-11-05)

Conteo por archivo de las opciones que `DaemonOptions` **no** acepta
(`uiDir`, `authRuntime`, `connectorOAuth`, `importHome`, `backoffMs`, `appChannel`):

| Bloqueantes | Archivos |
| --- | --- |
| 0 | `delta-mirror` (hecho) |
| 1 — solo `uiDir` | `child-guard`, `isolation`, `private-memory`, `real-agent` |
| 2 — `uiDir` + `backoffMs` | `attachments-gateway`, `gateway`, `uploads` |
| 3+ — inyectan runtime/OAuth/import home/canal duplex | `auth`, `models-gateway`, `profiles-gateway`, `voice`, `connector-integrity`, `lifecycle`, `subagent-probe`, `connector-secrets`, `connectors-gateway`, `connectors-proxy-gateway`, `vps-gateway`, `app-channel`, `computer`, `connector-drafts` |

Conclusión medida: **la migración no es mecánica**. `uiDir` se descarta, pero el resto pide
costuras que el daemon nuevo no tiene, y esas costuras son features del host, no inventos de
test:

- `log: (line) => void` — capturar las líneas del daemon. `child-guard` lo usa en dos asserts
  reales ("put back", "subagents are off"). Es observabilidad legítima del host.
- `backoffMs` — backoff de reinicio del engine, para que los tests no esperen segundos.
- `authRuntime` / `connectorOAuth` / `importHome` / `appChannel` (duplex fd 3) — sólo tienen
  sentido cuando esas superficies existan en el daemon nuevo (auth de proveedores, OAuth de
  conectores, import de configuración ajena y el canal de la app por fd 3). Hoy el canal de la
  app es un socket unix, así que los tests que inyectan un duplex no se pueden migrar: se
  reescriben contra el socket o esperan.

Orden de trabajo recomendado:

0. **Corrección de la medición**: `log` **no** hace falta como costura de producción. El daemon
   loguea por `console.log` y los tests corren en el mismo proceso, así que
   `vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")))` captura las
   líneas que `child-guard` assertea ("put back" con el shim, "subagents are off") sin agregar
   API nueva al host. Igual `backoffMs`: se puede omitir y dejar que el test espere el backoff
   real si el timeout lo permite; sólo se agrega al host si el tiempo de test se vuelve un
   problema medido, no preventivo.

1. Agregar `log` y `backoffMs` a `DaemonOptions` (con su test) — destraba `child-guard`,
   `isolation`, y deja `attachments-gateway`/`gateway`/`uploads` a un paso.
2. Migrar `child-guard` e `isolation` con esas costuras.
3. `private-memory` → BORRAR (feature ausente). `real-agent` → PARK (red + clave).
4. Todo lo de 3+ bloqueantes queda PARK hasta que la superficie exista (T4 perfiles/voice/
   uploads, T6 VPS), y se migra cuando se implemente esa feature — no antes.

## Aprendizajes de la primera migración (2026-11-05)

Intenté migrar `child-guard.test.ts` y aparecieron tres cosas que hay que resolver antes de
seguir con él y con `isolation`:

1. **`port: 0` cae al puerto del config (4317, producción).** `bootDaemon` ahora resuelve un
   puerto libre y fija `GENTLE_DOT_PORT`/`GENTLE_DOT_HOST`, así que un test no puede tomar el
   puerto de producción. Ya está arreglado y probado en el harness.
2. **`createDaemon` espera al engine listo**, así que cada boot tarda decenas de segundos y el
   default de vitest (5s) no alcanza: los archivos migrados necesitan
   `vi.setConfig({ testTimeout: 180_000 })`.
3. **La config del repo arranca MCP reales** (whatsapp-meta, discord, gmail → npm 404 y
   `Request initialize timed out`), lo que hace lento y ruidoso cada boot. Hace falta una
   config mínima válida para tests. Intento fallido documentado: `daemon:` + `connectors: {}`
   da "Missing daemon configuration"; agregando los bloques `telegram`/`gmail`/`discord`/
   `whatsapp` apagados, el loader falla con `Cannot read properties of undefined (reading
   'startsWith')`. Falta descubrir qué campo exige (revisar `config-loader.ts` zona de
   conectores y defaults) y generarla en el harness.

Estado: `child-guard.test.ts` quedó **como estaba** (revertido) para no dejar un test roto en
`main`; el harness quedó verde con el fix de puerto. Próximo paso concreto: resolver la config
mínima (punto 3), después migrar `child-guard` e `isolation` con timeout de 180s.

## El diagnostico real: el daemon nuevo es un esqueleto (2026-11-05)

Migrar `child-guard` fallo por una razon que no es de harness: el test espera que el daemon
ponga `GENTLE_PI_AGENTS=1` en el engine, y `src/daemon.ts` no toca esa variable ni importa
`child-guard.ts`.

La superficie de imports del daemon nuevo lo dice todo:

```
src/daemon.ts importa: config-loader, ws-server, connector-registry,
                       gentle-shell-spawner, mcp-proxy, app-channel
```

Nada mas. `child-guard`, `isolation`, `auth`, `profiles`, `conversations`, `rotation`,
`engine-access`, `connectors` existen como archivos, pero no estan cableados al daemon.

Consecuencia: la mayoria de los 24 archivos no se puede migrar, porque prueban features que el
daemon refactorizado todavia no invoca. El trabajo real no es "migrar 24 tests" sino
**re-cablear las features**, y cada una trae sus tests.

Veredicto revisado:

| Veredicto | Archivos | Por que |
| --- | --- | --- |
| MIGRABLES hoy | `delta-mirror` (hecho), `harness` (hecho) | tocan solo la superficie cableada |
| MIGRABLE con reescritura | `app-channel` | el canal hoy es un socket, no un duplex fd 3 |
| PARK (feature no cableada) | `child-guard`, `isolation`, `auth`, `lifecycle`, `connectors-*`, `connector-*`, `computer`, `subagent-probe` | el modulo existe, `daemon.ts` no lo usa |
| PARK (feature del roadmap) | `uploads`, `voice`, `profiles-gateway`, `models-gateway`, `vps-*` | T4 / T6 |
| BORRADO | `private-memory` | no esta en el plan |

Los 181 tests en rojo, entonces, no son deuda de migracion: son el inventario de lo que falta
re-cablear. Eso convierte la tarea en algo mucho mas honesto de planificar: por cada feature que
se re-cablee (child guard, isolation, auth, conectores), se migran sus tests en el mismo commit.

## Mapa de rojos por archivo (2026-11-05)

Corrida completa, conteo de tests fallidos por archivo:

| Fallos | Archivo | Veredicto |
| --- | --- | --- |
| 37 | `gateway.test.ts` | PARK parcial: mezcla el WS base con conversaciones/white-label que no existen |
| 30 | `mcp-proxy.test.ts` | **PARK: prueba un diseño anterior del proxy** (`rotateKey`, `handle`, `sync`, `close`); el módulo nuevo expone `registerServer`/`callTool`/`respondToApproval` y `connectors-proxy.test.ts` ya lo cubre |
| 15 | `auth.test.ts` | PARK: `auth.ts` no está cableado |
| 11 + 5 | `vps-gateway`, `vps-auth-helper` | PARK: T6 |
| 9 + 8 | `profiles-gateway`, `models-gateway` | PARK: T4 |
| 9 + 2 | `app-channel`, `app-channel-fd` | PARK: inyectan un duplex fd 3; hoy el canal es un socket |
| 8 | `lifecycle.test.ts` | MIGRABLE (candidato) |
| 8 | `connectors-gateway.test.ts` | PARK: pide authRuntime/importHome |
| 8 | `computer.test.ts` | PARK: server builtin |
| 7 | `uploads.test.ts` | PARK: T4 |
| 4 | `connector-secrets.test.ts` | PARK: secretos cifrados con clave del host |
| 4 | `attachments-gateway.test.ts` | PARK |
| 3 | `voice.test.ts` | PARK: T4 |
| 3 | `runtime-build.test.ts` | MIGRABLE (candidato) |
| 3 | `isolation.test.ts` | PARK hasta cablear `isolation.ts` |
| 3 | `connectors-proxy-gateway.test.ts` | PARK |
| 3 | `connector-integrity.test.ts` | PARK: necesita canal duplex de la app + auth runtime + cableado de integridad |
| 3 | `cli.test.ts` | MIGRABLE (candidato) |
| 1 | `engine-access.test.ts` | MIGRABLE (candidato) |
| 1 | `connector-drafts.test.ts` | PARK |

### Conectores: estado real

`connectors.test.ts`, `connectors-proxy.test.ts`, `connector-masking.test.ts`,
`connector-probe.test.ts` y `connectors-guided.test.ts` **pasan** (58 tests). El registro, el
proxying y el filtrado por modo ya funcionan en el daemon nuevo. Lo que queda en conectores es la
**integridad firmada con la app** (S25.6) y los tests del diseño viejo del proxy.

Siguiente candidato recomendado: `lifecycle.test.ts` (8), `runtime-build.test.ts` (3),
`cli.test.ts` (3) y `engine-access.test.ts` (1) — son superficies que el daemon nuevo sí tiene.

## Migración de los MIGRABLES (2026-11-05, sesión 2)

### `engine-access.test.ts` — HECHO (7/7)

No fallaba por el harness: un test arquitectónico detectó que `voice.ts` importaba
`copyFile/mkdir/rm/writeFile` de `node:fs/promises`, y S25.8 mantiene el trabajo asíncrono de
archivos fuera del thread pool de libuv (`68bcf03`). Pasó a las llamadas síncronas de `node:fs`
conservando los *yields* de microtask donde el original tenía `await`, porque el instalador
inyectado corre después y espera esos pasos hechos (quitarlos rompía el caso de provisioning).

### `cli.test.ts` — CLI ARREGLADO, 3 comportamientos faltantes (4/7)

El CLI **no arrancaba desde fuente** por tres defectos que el typecheck no veía (`5f97cd6`):
24 imports relativos con `.js` cuando la fuente es `.ts`; una *parameter property* en
`transcript.ts` que el strip-only de node rechaza; y nombres de tipo importados como valores
(`AppConfig`, `ShellConfig`, `ConnectorInfo`, `ConnectorType`, `DaemonOptions`,
`McpServerConfig`, `McpMode`, `ApprovalRequest`, `ApprovalResponse`, `AppMessage`).
Ahora `tsc --verbatimModuleSyntax` da 0 errores y `node src/cli.ts --help` imprime su uso.

Siguen fallando tres casos que piden **comportamiento que `cli.ts` no implementa**:
1. negarse a arrancar en server mode (GENTLE_DOT_VPS) como usuario no root (es T6);
2. el archivo de la clave de acceso en la salida redirigida;
3. salir cuando el canal de la app desaparece (S35.2, #22).

### `runtime-build.test.ts` — script desalineado (0/3)

`scripts/build-runtime.ts` ya no tiene `--self-check` ni la lista de externals que el test
espera, y su salida difiere (9 externals vs 7 esperados). Hay que decidir si se restaura el
contrato del script o se reescribe el test; no es migración de harness.

### `lifecycle.test.ts` — HECHO (8/8)

Se implementó lo que faltaba y se migró el archivo:

- **Canal por pipe** (`e907675`): `AppChannel` acepta un `Duplex` además de una config — mismos
  frames JSON por línea, requests correlacionados por id, requests entrantes respondidos por los
  handlers registrados, `connected`/`close()`. `approve()` pregunta a la app y trata canal
  cerrado, timeout o aborto como "sin consentimiento". Un frame mayor que `MAX_FRAME_BYTES`
  **nunca se escribe**: la app cerraría el canal, así que rechazarlo acá lo mantiene abierto.
- **Lifetime** (`1face29`): con el pipe como canal, el daemon se detiene cuando el pipe se cierra
  (una sola vez, logueando el motivo); sin pipe sigue corriendo. `stop()` es idempotente y todos
  los llamadores esperan la misma promesa. El daemon expone `closed`, `close()`, `port` y
  `supervisor` (pid del engine y si sigue vivo).
- **Engine home** (S35.3, #13): un home por defecto fresco se marca como del engine antes del
  primer spawn, con el mismo registro que escribe el engine; un home sobreescrito no se marca. El
  home por defecto pasó a ser `<data dir>/agent`.

### Veredicto de los 4 "MIGRABLES"

Sólo `engine-access` era realmente migrable, y quedó 7/7. Los otros tres revelan otra cosa:
`cli` necesitaba arreglos reales (hecho: corre desde fuente), `runtime-build` es un script
desalineado con su test, y `lifecycle` pide una feature (el canal duplex de la app con su
lifetime). La lista de "migrables" era optimista: el camino real es **implementar features**, no
migrar tests.

## Auth cableado (2026-11-05, sesión 2)

`AuthManager` estaba completo y era inalcanzable: una ventana pidiendo sus cuentas no recibía
nada, así que no se podía iniciar sesión en el daemon nuevo (`f71e16c`).

Ahora el daemon lo construye con el runtime del engine (o uno inyectado en tests) y responde por
el protocolo de cliente: `auth_list` → `auth_providers`, `auth_login` → arranca el flujo y manda
`auth_prompt`/`auth_event`/`auth_done` planos a la ventana que lo pidió, `auth_reply` contesta el
prompt, `auth_logout` cierra sesión y refresca la lista; un rechazo del manager se convierte en un
`toast` claro.

Corregido después (`105dbad`): los rechazos viajan como frames de **error** con el código del
manager (`auth_unsupported`, `auth_busy`, `unknown_provider`); `auth_list` devuelve sólo datos y
el comando **`/login`** abre la pantalla (`open:true`) sin llegar al engine; responder el flujo de
otra ventana da `auth_flow_not_found`; una ventana que se desconecta **cancela** su flujo
(`cancelOwnedBy`); y un prompt que vuelve como **respuesta fallida** (no sólo rechazada) llega como
`no_account` o `command_failed`.

**HECHO: `auth.test.ts` 18 de 18** (`68a14fd`). Lo que faltaba y cómo se resolvió:

1. **Reinicio del engine al cambiar credenciales**: el arranque se extrajo a `startEngine()` (con
   `engineHome` como campo) y `restartEngine()` detiene el spawner, crea uno nuevo (los listeners
   de eventos no se apilan) y vuelve a arrancar.
2. **Reinicio diferido**: con un turno en curso se marca `restartPending` y se reinicia al
   `agent_settled`. **Trampa real**: el handler llamaba al reinicio *antes* de limpiar
   `activeRun`, así que el reinicio se difería a sí mismo para siempre. Se limpia primero.
3. **Mensajes al window**: lista de cuentas refrescada tras `auth_done`; un prompt fallido ahora
   distingue `no_account` (si **no hay ninguna** cuenta conectada) de `command_failed`; y el
   vocabulario de estado dice `thinking` al arrancar el turno y `working` cuando corre una
   herramienta.

## Verificación de módulos (2026-11-05, sesión 2)

Antes de elegir el próximo bloque se comprobó qué módulos existen realmente y cuáles están
cableados en `daemon.ts`:

| Test | Módulo de la feature | Estado |
| --- | --- | --- |
| `computer.test.ts` (8) | **no existe** `src/computer.ts`; 0 menciones de "computer" en `src/` | **PARK**: la feature nunca se portó, hay que construirla |
| `profiles-gateway` (9) + `models-gateway` (8) | `src/profiles.ts` (781 líneas: `ProfileStore`, parse/serialize, escritura atómica, `splitModel`, `defaultImportPath`) | **completo y sin cablear** (`grep profiles src/daemon.ts` = 0). Mismo caso que auth: el trabajo está hecho y es inalcanzable |
| `uploads` (7), `voice` (3), `vps` (16), `conversations` | módulos ausentes o parciales | PARK / T4 / T6 |
| `mcp-proxy` (30), `gateway` (37) | diseños anteriores | PARK |

Conclusión: el próximo paso productivo **no** es perseguir rojos por conteo, sino cablear un
módulo terminado. El mejor candidato es **profiles** (17 tests entre perfiles y selector de
modelo), con el mismo patrón que auth: responder `profiles_*` y `models_*` por el protocolo de
cliente usando `ProfileStore`.

## Alcance real de cablear profiles (2026-11-05, sesion 2)

Antes de empezar se midio el trabajo, y no es "igual que auth":

- `ProfileStore` (781 lineas) pide `ProfileStoreOptions`: `configHome` (`GENTLE_PI_CONFIG_HOME`
  del engine), `agentHome` (el `--home` del engine) e `importPath` (otro setup, solo lectura, para
  la importacion unica). El daemon debe construirlo con esos tres.
- El frame `profiles` que espera el protocolo trae `profiles`, `active?`, `roles`, **`models`**
  (`ModelOption[]` = provider/id/name/reasoning), `importable` y `open?`. El store da perfiles,
  roles e importable, pero **no hay fuente de `models` en el daemon**: `AuthRuntime` expone
  proveedores y estado de sesion, no un catalogo de modelos (hoy solo `get_state` del engine
  devuelve el modelo actual).
- Faltan ocho handlers: `profiles_list`, `profile_save`, `profile_rename`, `profile_duplicate`,
  `profile_delete`, `profile_apply`, `profile_import`, `profile_save_current`, mas el comando
  `/profiles` que abre la pantalla.
- `profile_apply` necesita ademas hablar con el engine (`set_model` por rol) y `models_list` /
  `model_set` un catalogo con grupos.

Conclusion: **no es un cableado de una tarde**. Necesita (1) decidir de donde salen los modelos
(catalogo del engine o de `models.json` del configHome), (2) montar el store, (3) los ocho
handlers y el comando. Conviene encararlo como tarea propia y con sesion fresca, no apurado al
final de una sesion larga.

## Tarea de seguridad pendiente: archivos subidos (uploads)

Los uploads hoy están acotados en lo básico —nombre saneado (sin traversal ni nombres reservados),
detección de tipo por *magic bytes*, permisos 0600/0700, límites por archivo/mensaje/cantidad, y
nada se sirve de vuelta por HTTP— pero falta el bloque de endurecimiento antes de exponerlos más:

1. **Contenido activo**: SVG, HTML y JS no deben tratarse nunca como imágenes visibles. Hoy
   `sniffMime` sólo reconoce PNG/JPEG/GIF/WebP; hay que confirmar que todo lo demás cae a
   `application/octet-stream` y que **nunca** se sirve con un `Content-Type` renderizable.
2. **Poliglotas**: un PNG válido puede llevar un script embebido después del IEND. Mitigación:
   re-encodear la imagen (strip de metadatos/chunks) antes de pasarla al modelo, en vez de
   reenviar los bytes originales.
3. **Servido futuro**: si algún día se sirven los archivos de vuelta al navegador, hacerlo con
   `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` y sin `inline`.
4. **Inyección de prompt desde archivos**: el contenido de un archivo leído por las herramientas
   del engine entra al contexto del modelo; conviene delimitarlo y marcar que es dato, no
   instrucción (mismo criterio que `composePrompt` ya usa para describir adjuntos).
5. **Escaneo**: opcional, un antivirus/`clamav` sobre el archivo antes de exponerlo a herramientas.
6. **Cuotas por usuario/ventana** además de por mensaje, para que un cliente no llene el disco.

Estado: registrado como tarea propia. Los tests de `uploads` (23) cubren lo funcional, no esto.

## Alcance de `connectors-gateway` (2026-11-05)

Medido antes de empezar: `src/connectors.ts` tiene **2590 líneas** con el catálogo, `fillServer`,
secretos por conector y la lógica de mcp.json. Su test (232 líneas, 8 casos) inyecta dos cosas y
espera cuatro comportamientos:

- **`connectorOAuth`** (`oauthOptions(...)`): runner de OAuth por conector (módulo
  `connector-oauth.ts` existe, sin cablear al daemon).
- **`appChannel`** duplex: las cambios de conector los **confirma la app** de escritorio, y el
  test usa `fakeApp([], "allow")`.
- Comportamientos que pide: listar conectores; `/connectors` abre la pantalla; el sign-in va a la
  ventana que lo pidió y **todas** se refrescan; el engine **reinicia con la política nueva**
  esperando al turno en curso; se **restaura un `mcp.json` cambiado** antes de reiniciar; un
  conector apagado **sigue apagado** aunque el asistente edite los archivos; y cancelar el sign-in
  por `auth_reply` con rechazo de conectores desconocidos.

Conclusión: no es un cableado corto — es el subsistema de conectores completo (OAuth + aprobación
por la app + política + mcp.json + reinicio). Merece sesión propia y fresca, empezando por el
runner de OAuth y el frame de lectura (`connectors` + `/connectors`), que es lo que da visibilidad.

## Avance de `connectors-gateway` (2026-11-05, sesión 3)

`2 de 8` y el resto medido con precisión (`bded1bd`).

Hecho:
- El daemon construye `ConnectorStore` (junto a los archivos del engine, con `guardPath` y
  `childGuard: false` porque el daemon ya supervisa el child guard) y `ConnectorManager` encima.
- `connectors_list` y el comando `/connectors` responden el frame con las **seis entradas del
  catálogo en orden** y su `status`, con `open` sólo en el comando.
- **La política del engine ahora sale del store** (`store.policy()`), no del builder casero: lo
  que el guard exige y lo que la pantalla muestra ya no pueden divergir.
- `connector_connect` / `connector_sign_in` / `connector_disconnect` pasan por el manager con el
  **mismo dueño por ventana** que la pantalla de cuentas: los pasos del sign-in van sólo a la
  ventana que lo pidió, un `auth_reply` responde cualquiera de los dos flujos, una ventana que se
  va cancela también su flujo de conector, y un cambio refresca todas las ventanas y **reinicia el
  engine** (nunca en medio de una respuesta).

Falta (lo que dejan rojo los 6 restantes):
1. **Fuente de secretos de la app** (`ConnectorStoreOptions.secrets`): sin ella, un conector que
   necesita secreto falla cerrado (`NO_APP`) y el sign-in no completa. Es el adaptador entre el
   canal de la app y el almacén; `connector-credentials.ts` resuelve valores del engine, no es
   esto. **Es la pieza que destraba el resto.**
2. **Restaurar un `mcp.json` alterado** antes de que el engine arranque de nuevo.
3. **Cambio de modo** (`setMode`) con confirmación nativa de la app, y `remove`.
4. **Reposición de archivos mientras el agente corre** y después de que el turno termina (B1).
5. Conector apagado que sigue apagado aunque el asistente edite los archivos (B1).
6. Cancelación por `auth_reply` y rechazo de conectores desconocidos (códigos del manager).

Orden sugerido para retomar: (1) fuente de secretos → (6) códigos y cancelación → (2) mcp.json →
(3) modos → (4)(5) reposición.

### Incidencia menor: un test deja un archivo en el repo

Despues de correr la suite aparecio un archivo de estado de conectores sin trackear en
`packages/` (el guard de privacidad impide borrarlo desde el agente). Causa probable: alguna
prueba construye `ConnectorStore` con un `dataDir` relativo, asi que escribe en el cwd del
proceso en vez de un temporal. Arreglo: que cada test pase un `dataDir` absoluto y, si hace falta,
que `ConnectorStoreOptions.dataDir` se resuelva contra un directorio explicito. Borrar el archivo
a mano y sumar la ruta al `.gitignore` como red de seguridad.

## El bloqueo real de connectors-gateway: dos transportes (2026-11-05, sesión 3)

Diagnóstico completo (`fe28966` dejó la fuente de secretos cableada; esto es lo que falta):

El test **no manda todo por el WebSocket**. Su helper `sendLikeThePanel(app, clientId, overWebSocket)`
decide por mensaje:

- si `parseClientMessage` + `isAppCommand(...)` dicen que es un **comando de la app** →
  `app.command(clientId, message)`, es decir viaja por el **canal duplex** (fd 3);
- si no, va por el **WebSocket**.

Y las respuestas/eventos que el test espera (`connectors`, `auth_event`, `auth_done`, `profiles`,
`models`) se leen de los mensajes del **WebSocket** (`messages.push` en el `ws.on("message")`).

Cómo se verificó: las trazas (`console.error`) dentro de `connectorAction` **nunca aparecieron**, y
`connector_connect` sí está en el switch de `onAppMessage`. Es decir: el frame no llegaba por ahí.

### Qué hay que hacer

1. **Registrar los handlers del canal** en el daemon, junto a los del WS:
   `this.appChannel.registerHandler(tipo, async (params) => ...)` para los comandos de app
   (`connectors_list`, `connector_connect`, `connector_sign_in`, `connector_disconnect`,
   `profiles_*`, `models_*`, `auth_*`). El `AppChannel` ya sabe responder al frame
   (`answerFrame` escribe `{kind:'response', id, result}`) y ya tiene `send(clientId, type, payload)`.
2. **Reusar los mismos métodos** que hoy sirven al WS (`connectorsScreen`, `connectorAction`,
   `profilesScreen`, `modelsScreen`, `authList`…), en vez de duplicar lógica: el transporte cambia,
   la acción no.
3. **Empujar los eventos por el WebSocket** al `clientId` que llegó en el request
   (`wsServer.deliver(clientId, …)`), porque es de ahí de donde el test los lee. Los eventos del
   sign-in van sólo a esa ventana; el refresh de `connectors`/`profiles`/`models` va a todas
   (`broadcastApps`).
4. **Cancelación**: con el `clientId` del canal, `cancelOwnedBy` debe alcanzar también esos flujos.

Con eso deberían caer los 6 casos restantes: conectar con sign-in, esperar al turno antes de
reiniciar, cancelar y rechazar desconocidos, restaurar `mcp.json`, y las dos de reposición B1.

### Estado al cerrar
`connectors-gateway`: **2 de 8**. Suite: **362 pasan / 121 fallan** (496). Lo demás ya está:
store + manager, pantalla, acciones, política desde el store y fuente de secretos de la app.

## Estado de connectors tras el transporte dual (2026-11-05, sesión 3)

`ad618c7` dejó el transporte arreglado: el panel manda los comandos de ventana por **su canal**
(request `command` con el `clientId`), y el daemon ahora los enruta al mismo `handleAppFrame` que
el WebSocket. Los eventos siguen saliendo por el WebSocket de esa ventana.

Con eso, el sign-in de un conector ya corre **de punta a punta** por el canal:
`auth_event(auth_url)` → `auth_prompt(manual_code)` → `auth_done`, y todas las ventanas reciben el
frame `connectors` refrescado.

También se corrigió el orden: un sign-in **termina mucho después de empezar**, así que el refresh y
el reinicio del engine se hacen al cerrarse el flujo (`auth_done`) y no al iniciar la acción
(reiniciar antes le daba al engine nuevo la política vieja).

### Lo único que falta para ese caso

`restartEngine()` se cuelga en su segunda vuelta: las trazas muestran
`restartEngine → stopping engine → engine stopped` y después **nunca** vuelve de `startEngine()` (ni
error, ni "restart failed"). El `waitFor` del test vence a los 5 s.

Pistas para retomarlo:
1. `stop()` del spawner completa; el cuelgue está en el `start()` del **spawner nuevo**.
2. Sospechas: el `--session-dir` compartido con la sesión anterior; el probe de readiness que no
   recibe respuesta del agente falso en el segundo arranque; o el timeout configurable
   (`GENTLE_DOT_ENGINE_READY_TIMEOUT_MS`) que es mayor que la ventana del test.
3. La condición del test es sólo `pid distinto && state === 'ready'`, y `supervisor.state` hoy es
   `'ready'` salvo que el daemon esté detenido: si el `pid` del hijo nuevo existe apenas se hace
   `spawn`, conviene exponerlo antes de esperar el ready (o marcar `'restarting'` mientras dura).
4. Instrumentar `GentleShellSpawner.start()` en la segunda vuelta (spawn, probe enviado, respuesta
   recibida) es el paso siguiente, no tocar el daemon a ciegas.

Con eso deberían caer el resto: esperar al turno antes de reiniciar, cancelación y rechazos,
restaurar `mcp.json` y las dos de reposición B1 (los códigos del manager y su cancelación ya están
cableados por el mismo `handleAppFrame`).

## El segundo arranque del engine, instrumentado (2026-11-06)

Se instrumentó `GentleShellSpawner.start()` con un contador de arranques y trazas en spawn, probe,
stdout/stderr, exit/error y timeout. Lo que dicen las trazas, en el test que falla:

```
start() called, shellProcess? false
spawner.start bin: <node>
spawned pid 32512 argv: <fake-agent.ts> --home <data>/agent --mode rpc ...
probe sent stdin writable: true
event spawn
child stdout {"type":"response",...,"id":"gentle-shell-ready-probe",...}   <- run 1 responde
...
[reinicio]
start() called, shellProcess? false
spawner.start bin: <node>
spawned pid 32643 argv: <idéntico>
probe sent stdin writable: true
event spawn
(…nada más: ni stdout, ni stderr, ni exit, ni timeout dentro de la ventana)
```

Es decir: en la segunda vuelta el hijo **nace y queda mudo**, y el padre está sano
(`stdout attached, flowing true, paused false`).

Controles hechos para descartar culpables:

| Prueba | Resultado |
| --- | --- |
| El agente falso solo, dos arranques seguidos (`node fake-agent.ts`, probe `get_state`) | **responde en ambos** |
| `GentleShellSpawner` solo, dos arranques seguidos (`start(); stop(); start()`), con `engineCommand` al agente falso | **ready en ~557 ms en ambos** |
| Padre drenando stdout en la segunda vuelta | correcto (`flowing true`, `paused false`) |

Conclusión: no es el agente, no es el spawner y no es el drenaje. **Es algo del contexto del daemon
en el momento del reinicio.** Hipótesis a probar, en orden:

1. **Diferencia de entorno entre los dos spawns del daemon**: volcar las claves (y el tamaño de
   `GENTLE_DOT_CONNECTOR_POLICY`, que en el reinicio ya incluye el conector) antes de cada spawn.
2. **Event loop bloqueado**: el reinicio ocurre dentro del `emit` del flujo de OAuth; si alguna
   promesa de la cadena no se resuelve, el proceso padre igualmente debería drenar… pero conviene
   medir con un `setInterval` que loguee latidos durante el reinicio.
3. **El canal `ipc` del stdio**: probar la segunda vuelta con `['pipe','pipe','pipe']` (sin `ipc`)
   para descartar que el canal del hijo anterior interfiera.

Nota práctica: el guard de privacidad bloquea pasar una política de conectores en un script suelto
(menciona archivos de conectores), así que la reproducción con política hay que hacerla dentro del
repo (por ejemplo, un test temporal) en vez de en `/tmp`.

### Segundo arranque: lo descartado (2026-11-06)

Después de instrumentar, quedaron descartadas estas causas — no repetir el trabajo:

| Hipótesis | Prueba | Resultado |
| --- | --- | --- |
| El agente falso se cuelga en el segundo arranque | dos `spawn` directos seguidos con el probe `get_state` | responde en **ambos** |
| El spawner no soporta reinicio | `start(); stop(); start()` con el mismo código, dos spawners | **ready en ~557 ms en ambos** |
| El padre no drena stdout | `readableFlowing`/`isPaused` en la segunda vuelta | `flowing true`, `paused false` |
| `stop()` resuelve antes del exit del hijo (carrera) | lectura de `stop()` | **espera** el evento `exit` |
| Spawner compartido/diferente | reusar la misma instancia en el reinicio | falla igual |
| Entorno distinto entre spawns | diff de `Object.keys(env)` (109 claves) | **idéntico**, sin agregadas ni quitadas |
| Canal `ipc` del `stdio` | segunda vuelta con `['pipe','pipe','pipe']` | falla igual |

El síntoma exacto, con el daemon: `spawned pid …` + `event spawn` y **nunca** stdout, stderr, exit ni
timeout dentro de la ventana del test. Con el spawner aislado el mismo hijo habla.

Siguientes caminos, distintos de los ya descartados:
1. Reproducir **dentro de un test** un `GentleShellSpawner` que arranque dos veces con el `ShellConfig`
   completo que arma el daemon (con `policy`, `extensions`, `sessionDir`) — el aislamiento de hoy no
   incluía la política porque el guard de comandos bloquea escribirla en `/tmp`.
2. Comparar `process._getActiveHandles()` antes del segundo spawn (¿hay un handle que impide al hijo
   arrancar?).
3. Probar el segundo arranque apuntando a un **agent home y session dir nuevos** (descartar que el
   hijo quede esperando algo del home compartido).
4. Considerar un plazo duro: si el reinicio no está listo en N ms, reiniciar el **daemon** completo en
   vez de sólo el engine (el usuario puede aceptar que la app reinicie).

## Causa raíz encontrada: el event loop del daemon se bloquea en la segunda vuelta (2026-11-06)

Después de siete descartes, la instrumentación dio con el mecanismo real. Con `console.error` en
cada paso del reinicio:

```
[diag] auth_done -> refresco y reinicio
[diag] restartEngine { home: true, restarting: false, run: false }
[diag] stop: begin
[diag] stop: done
[diag] startEngine: begin
[diag] step: home
[diag] step: stores
[diag] step: policy begin          <- última línea; nunca llega "policy done"
```

Y lo decisivo: los `setTimeout` de control programados justo antes **nunca disparan** (ni el de
500 ms ni el de 2500 ms). Eso no es un `await` pendiente: **el event loop está bloqueado**, y por
eso el hijo recién lanzado "nace mudo" — no es que no hable, es que el padre no puede leerlo ni
correr sus timers.

El bloqueo ocurre entre `policy begin` y `policy done`, es decir en
`this.connectorStore.policy()` durante el **segundo** `startEngine()` (después de un sign-in que ya
dejó el conector guardado). `policy()` recorre `ordered(this.saved)`, `specOf(id, saved)` y
`filledServer(...)`; esas funciones son de strings/estado, así que la sospecha principal es un
**bucle infinito** con la forma que deja el sign-in (no una espera de I/O).

Nota de método: `process.stderr` a un pipe es **asíncrono**, así que la última línea antes de un
bloqueo puede perderse; por eso el corte exacto se confirma con los timers de control, no con el
orden de los logs.

### Siguiente paso (concreto)

1. Test unitario de `policy()` con un conector firmado en `saved` (y con `values` reales del
   sign-in) — con timeout, para que un bucle infinito falle rápido en vez de colgar el test.
2. Mirar `ordered()` y `specOf()` con ese estado: buscar recorridos que no avanzan (referencias
   circulares en `saved.base`, listas que se reinsertan, comparadores que no progresan).
3. Recién después, volver al test de conectores: el reinicio debería completarse solo.
4. Como red de seguridad de producto, envolver el reinicio en un perro guardián que no dependa del
   event loop (p. ej. un `Worker` o un proceso aparte) — un bucle infinito en el cálculo de la
   política no debe congelar el daemon entero.

## Corrección del diagnóstico: el reinicio sí funciona (2026-11-06)

La instrumentación anterior mentía por una razón tonta: **`process.stderr` a un pipe es
asíncrono**, así que la última línea escrita antes de un cuelgue se pierde. Al cambiar el
diagnóstico a un log **sincrónico a archivo** (`appendFileSync`), el reinicio se ve completo:

```
restartEngine: start
restartEngine: stopping
restartEngine: stopped
startEngine: start → before home → policy begin → policy done → guard begin → guard done → spawn begin
startEngine: engine ready        (+516 ms)
```

O sea: **el engine nuevo arranca y queda listo**. Los "siete descartes" siguen siendo válidos, pero
la conclusión de "el hijo nace mudo" era un artefacto del diagnóstico: el padre estaba bien; lo que
faltaba era ver la línea siguiente.

### El bloqueo real que queda (y es otro)

Con el reinicio funcionando, el test falla igual porque el estado del conector nunca pasa a
`connected`:

```
connectorsScreen: notion=needs_signin,linear=off,atlassian=off,discord=off,slack=off,gmail=off
```

El flujo de sign-in emite `auth_done`, pero el store **no registra la firma**, así que:
- ninguna ventana recibe un frame `connectors` con `status: "connected"`, y
- la política del engine nuevo sigue vacía (`connectors: {}`).

Además se ordenó el refresco con `connectorStore.settled()` antes de emitir la pantalla y reiniciar
(el store escribe un instante después de que el flujo reporta `done`).

### Siguiente paso

1. Mirar la ruta de éxito de `ConnectorManager.signIn`: ¿llama a `store.saveSignIn(id, state)`? ¿Esa
   escritura necesita la fuente de secretos de la app (`SecretSource`) o el `signinHome`, y falla en
   silencio?
2. Hacer visible ese fallo (log con `console.error`) en vez de dejarlo mudo: hoy el flow dice `done`
   aunque el guardado no ocurra.
3. Con la firma guardada, revisar el orden `settled() → refresh → restart` (ya cableado).

## El sign-in no deja rastro en el store (2026-11-06, continuación)

Con el reinicio ya descartado como problema, el bloqueo real quedó aislado con log sincrónico. En el
momento de `auth_done`, la entrada del conector en el store es:

```
store notion: {"enabled":true,"mode":"read_only"}      <- sin `signIn`
manager:      notion=needs_signin, ...
```

O sea: `connect()` **sí** agrega el conector (enabled) y el flujo emite `auth_done` con `ok: true`,
pero `saveSignIn` **no deja la referencia** `signIn` que `isSignedIn()` necesita. Sin ella el estado
nunca pasa a `connected`, ninguna ventana recibe ese frame y la política del engine queda vacía.

Código relevante (todo en `src/connectors.ts`):

- `ConnectorManager.connect` → si faltan valores pregunta; si no, `save(id, {enabled:true})` y
  `afterSetup(...)` → `startLogin(...)`.
- `ConnectorManager.runLogin` → `startSignIn(...)`, `await store.saveSignIn(id, state)`, después el
  `auth_done`.
- `ConnectorStore.saveSignIn` → `keep(secretId, JSON.stringify(state))` y **sólo si**
  `this.saved.connectors[id] && ...signIn !== secretRef(secretId)` hace
  `update(current => { saved.signIn = secretRef(secretId) })`.

Hipótesis a comprobar, en orden:
1. **`keep()` no persiste o falla en silencio**: es la fuente de secretos de la app
   (`AppSecretSource` → `channel.request('secret_put')`). Si el pedido no se contesta o se rechaza,
   `saveSignIn` corta antes del `update`; conviene loguear ese error con `console.error` en
   `runLogin` en vez de dejarlo mudo.
2. **El camino del código manual** (`finishWithPastedAddress`) puede no llamar a `saveSignIn`: el
   test recibe un `auth_prompt` de tipo `manual_code`, así que vale revisar ambos caminos.
3. **`update()` no está viendo el conector**: el `if` de `saveSignIn` exige que `this.saved` ya
   tenga el conector en el momento de guardar; con `connect()` guardando antes, debería estar, pero
   conviene verificarlo con un log del `id` y de `saved?.signIn` justo antes del `update`.

Con eso debería quedar claro si el fallo es del almacén de secretos, del camino del código manual o
de una carrera con `update()`. Después de eso, el resto del test (frames a todas las ventanas,
política nueva y reinicio) ya está cableado.

## Contradicción abierta: `runLogin` corre pero nunca llega a `saveSignIn` (2026-11-06)

Con log sincrónico dentro de `src/connectors.ts`:

```
startLogin notion
runLogin notion
(…nada más: NO aparece "saveSignIn notion")
```

Y sin embargo la ventana recibe `auth_done` con `ok: true` (el test lo verifica y pasa esa línea).

Lo que dice el código (`runLogin`):

```ts
const state = await flow.signIn.done;
await store.saveSignIn(flow.connectorId, state);   // <- nunca se alcanza
this.log(`signed in to connector ${flow.connectorId}`);
flow.emit({ ...done, ok: true });                  // <- pero esto sí llega
```

Es decir: el `auth_done` con `ok:true` que ve el test **no puede venir de esta rama** (el `saveSignIn`
anterior no se ejecutó). Hay que encontrar quién más emite `auth_done` con `ok:true`:

1. Buscar en `src/connectors.ts` y en el daemon todas las emisiones de `auth_done` (además de
   `runLogin`): `afterSetup`, el camino del código manual (`finishWithPastedAddress`) y cualquier
   `emit({ type: "auth_done", … })`.
2. Verificar si la ventana recibe el `auth_done` del flujo **del conector** o el de la **pantalla de
   cuentas** (`AuthManager`), que también emite `auth_done` con `providerId`. En el test, el
   `providerId` esperado es `"notion"`, así que un `auth_done` de cuentas no serviría… salvo que el
   `find` del test haya matcheado otro frame.
3. Comprobar si `flow.signIn.done` **rechaza** y el `catch` emite `ok:false`, mientras el test ve
   otro `auth_done` con `ok:true` de un segundo flujo (por ejemplo, el que arrancó `connectorAction`
   y otro que arranque `afterSetup`).

Nota: `saveSignIn` no deja la referencia en el store (verificado antes: `{"enabled":true,"mode":"read_only"}`
sin `signIn`), lo que es coherente con que nunca se llame. El bug está en **quién completa el flujo**,
no en el almacén de secretos.

## Causa encontrada: el daemon cancela el flujo a los ~6 s (2026-11-06)

Con log sincrónico dentro de `src/connectors.ts` (los tres puntos del `runLogin` más las dos rutas
de cancelación) el flujo del conector queda así:

```
try-begin notion
cancelOwnedBy called          <- ~6.2 s después
CATCH notion: Sign-in cancelled
```

Es decir: **`saveSignIn` no se llama porque el flujo se cancela antes**, vía
`ConnectorManager.cancelOwnedBy(owner)`. Eso explica todo lo anterior: el `auth_done` con `ok:true`
que ve el test **no** viene de `runLogin` (esa rama emite `ok:false` al cancelarse); viene de
`afterSetup`, que emite `ok:true` cuando ya está firmado o no hay nada que firmar.

### Quién cancela

`cancelOwnedBy` se llama desde dos sitios del daemon:

1. `wsServer.on('onAppDisconnect', …)` — una ventana se desconecta.
2. `Daemon.stop()`/cierre del canal de la app — el daemon se detiene (y al detenerse, el `wsServer`
   cierra todas las ventanas con 1001, lo que vuelve a disparar el punto 1).

Como el flujo muere a los ~6 s y el test no cierra ventanas, la sospecha es que **el canal de la
app se cierra**: en `setup()` el `fakeApp` se pasa como `appChannel` y, o el fake termina su extremo,
o el daemon interpreta un `end`/`close` como "la app se fue" y arranca un `stop()` que después
cancela el flujo.

### Siguiente paso (muy acotado)

1. Loguear en `onAppDisconnect` **el `clientId` y el motivo** (código de cierre) para saber si el
   que se cae es la ventana del test o el canal de la app.
2. Decidir la semántica correcta: **cancelar el sign-in de un conector sólo si se va la ventana que
   lo pidió**, no cuando el daemon cierra por su cuenta (hoy el cierre del daemon cierra las ventanas,
   y eso dispara la cancelación de flujos que estaban por completarse).
3. Con eso, `runLogin` debería llegar a `saveSignIn`, el estado pasaría a `connected` y caerían los
   seis tests de conectores (el resto —frames, política, reinicio— ya está verificado).

## Veredicto sobre gateway.test.ts (2026-11-08)

El intento de migración al harness reveló que el archivo es la especificación del gateway VIEJO,
no del actual. El gateway de hoy (WsServer + daemon absorbiendo el rol de bridge, sin instanciar
`bridge.ts` — código muerto) tiene su spec en `app-ws-gateway.test.ts` (verde).

Reemplazo del objetivo: NO portar los 37; rescatar el cobertura que falta y descartar el que
describe features removidas.

Hallazgo de valor del intento (commiteado en `c761089`): el handshake de ventana cerraba con
1002/1008 genéricos en vez de los códigos del protocolo (`unauthorized: 4401`, `badProtocol:
4400`), y un primer frame que no era hello quedaba colgado. Corregido.

### Cobertura a rescatar (reescribir contra la API actual, ~10 tests)
- Rechazo de origin foráneo y aceptación del origin del app (verificar soporte de origin en WsServer).
- Frames malformados responden error y mantienen la conexión.
- requestId repetido ignorado.
- White-label ×4: identidad al engine, chatter oculto, ask text reescrito, comandos internos rechazados.
- Own instance ×2: home/perfiles propios; HOME/XDG propios conservando PATH, git identity y Engram.
- Claves y permisos ×2: modo del data folder y del archivo de clave (`ensureToken`/`startupMessage`
  ya no existen; reescribir contra `requireAuthToken` + `<dataDir>/token`).

### Cobertura a descartar (~27 tests)
- Streaming con deltas, numeración de mensajes, cola de busy, conversations
  (`list_conversations`/`open_conversation` solo en `bridge.ts`, muerto): el protocolo actual es
  el de `app-ws-gateway.test.ts`.
- Dos pruebas de own instance con `startDaemon` directo: reescribir con `bootDaemon` + `env`.

### Nota técnica
`bootDaemon` sirve de helper; `Daemon` expone `port/close/supervisor`; el token del hello es
`BRIDGE_KEY`. El helper migrado quedó probado (tsc limpio, 4 verdes antes del restore del archivo).
