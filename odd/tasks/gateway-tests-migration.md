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

### `lifecycle.test.ts` — PARK (8)

No es migrable con el harness: los primeros tres casos prueban el **ciclo de vida del canal
duplex fd 3** del app ("se detiene cuando su canal se cierra", "sin canal sigue corriendo",
"cerrar dos veces para una sola vez") y el cuarto grupo prueba que **no se envían frames que la
app rechazaría** (límite de tamaño, S35.2). El daemon nuevo habla por socket unix con frames
JSON por línea y no tiene ese canal ni esos límites.

### Veredicto de los 4 "MIGRABLES"

Sólo `engine-access` era realmente migrable, y quedó 7/7. Los otros tres revelan otra cosa:
`cli` necesitaba arreglos reales (hecho: corre desde fuente), `runtime-build` es un script
desalineado con su test, y `lifecycle` pide una feature (el canal duplex de la app con su
lifetime). La lista de "migrables" era optimista: el camino real es **implementar features**, no
migrar tests.
