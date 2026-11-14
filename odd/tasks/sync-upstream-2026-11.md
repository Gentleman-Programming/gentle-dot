# Sincronización con upstream (noviembre 2026)

## Qué trae upstream

177 commits que no tenemos; nosotros tenemos 132 que no están allá.
`git diff --shortstat main...upstream/main` → **109 archivos, 18.533 líneas agregadas**.

Reparto por tema (menciones en los asuntos de commit):

| Tema | Menciones |
|---|---|
| Windows | 123 |
| desktop | 61 |
| daemon | 38 |
| channel | 15 |
| docs | 14 |
| engine | 9 |
| connector | 7 |

O sea: **es casi todo compatibilidad con Windows** (canal de la app por pipes con nombre, spawn,
puertos retenidos, close con drain) más actualización del motor empaquetado y arreglos de CI. De
nuestro camino Linux, upstream aporta dos correcciones reales:

1. `connectors.ts`: el registro vacío se firma en su lugar, así el próximo arranque lo verifica en
   vez de reportar un archivo que nunca existió (instalación nueva).
2. `app-channel.ts`: guarda para que un frame en vuelo no se despache cuando el canal ya se cerró.

## Cruce con lo nuestro

Solo **3 archivos** se pisan: `app-channel.ts` (+33), `connectors.ts` (+5), `daemon.ts` (+75).
No toca `ws-server.ts`, `uploads.ts` ni `test/connectors-gateway.test.ts`.

## Estado del merge

Rama `sync/upstream-2026-11`, merge **en curso** (`MERGE_HEAD` presente). `main` intacto en
`ad19496`. Abortable con `git merge --abort`.

Conflictos: **8 archivos, 13 hunks**.

| Archivo | Hunks | Nota |
|---|---|---|
| `packages/daemon/src/app-channel.ts` | 5 | el grueso: `close()` pasa a `Promise`, canales de Windows |
| `packages/daemon/src/cli.ts` | 2 | nuestro `-p 0` + su arranque Windows |
| `packages/daemon/src/daemon.ts` | 2 | guarda de ownership del canal + `openApp` |
| `packages/daemon/test/lifecycle.test.ts` | 1 | nuestro harness vs. su versión |
| `packages/daemon/package.json` | 1 | dependencias nuevas de Windows |
| `scripts/package/stage-runtime.mjs` | 1 | empaquetado |
| `.gitignore` | 1 | combinar: `packages/connectors.json` (nuestro) + salidas `native/*.node` (suyo) |
| `pnpm-lock.yaml` | — | regenerar con `pnpm install` tras resolver `package.json` |

Además **`packages/daemon/test/private-memory.test.ts`**: eliminado por nosotros, modificado por
ellos. Hay que decidir si vuelve (con su evolución) o se queda eliminado.

## Trampa pendiente

La línea del usuario en `.gitignore` está en `git stash` (entrada 0). Hay que hacer
`git stash pop` **después** de resolver, o volver a agregarla.

## Criterio de aceptación

1. `npx tsc --noEmit` en `packages/daemon` sin errores.
2. Suite del daemon ≥ **369 pasan / 114 fallan** (yardstick del 2026-11).
3. Si el total baja, el merge **no** entra a `main`.

## Reanudación

1. `cd packages/daemon && npx tsc --noEmit` para ver qué quedó roto.
2. Resolver de a un archivo con la suite del área (no la suite completa).
3. `pnpm install` para el lockfile, después `tsc` y la suite.
4. `git stash pop` para devolver la línea de `.gitignore`.
5. Commit del merge y, solo si el criterio se cumple, `git switch main && git merge --no-ff`.
