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
