# land-74-75-and-evidence

Feature: actualizar los PR varados #74/#75 del fork contra upstream, publicar la evidencia verificada en las issues y cerrar la suite roja de WhatsApp.
Branch de trabajo: las ramas de PR del fork (`fix/workspace-git-boundary`, `feat/turn-timeout`) + `feat/gentle-dot` para el suite.

## Specs

S1. "Proceder con tu recomendación" — la recomendación aceptada, en este orden: "primero **aterrizar #74 y #75** (son los de mayor valor y están varados hace tres semanas), después publicar los comentarios de evidencia en #51 y #52 con todo lo verificado arriba, y recién entonces el verde de WhatsApp".

S2. Aterrizar = rebasar la rama del PR sobre `upstream/main` actual, correr la suite que ese PR toca hasta verde, y empujar con `--force-with-lease` para que el PR vuelva a ser mergeable. No se squash-ea (la política del repo pide preservar SHAs que la doc referencia).

S3. Los comentarios de evidencia van a `Gentleman-Programming/gentle-dot` issues #51 y #52, con `path:line` propios y mediciones, sin inventar datos ni atribuirnos lo ajeno.

S4. La suite de WhatsApp queda verde (26/26) sin debilitar aserciones: si la aserción está mal, se corrige la aserción; si el bridge está mal, se corrige el bridge y se dice cuál fue.

S5. Nada de `git reset --hard`, `git clean`, ni force-push sobre ramas ajenas a estos PR; los cambios sin commitear del usuario (`.gitignore`, `tsconfig.tsbuildinfo`, el test de WhatsApp) sobreviven intactos.

## Tasks

- T1 · #51 · rebasar `pr51-git-boundary` (PR #74 + fix Windows 8.3) sobre `upstream/main`, `isolation.test.ts` verde, push con lease · commit: rebase
- T2 · #52 · rebasar `feat/turn-timeout` (PR #75) sobre `upstream/main`, sus 3 suites verdes + typecheck · commit: rebase
- T3 · evidencia · comentario en #51 y en #52 con lo verificado · sin commit (gh)
- T4 · WhatsApp · 26/26 verde · commit en `feat/gentle-dot`

## Log

L1. "Proceder con tu recomendación"
L2. Decisión: PR #74 se actualiza con el contenido de `pr51-git-boundary` (que ya incluye el fix 8.3 de `realpathSync.native`), así un solo PR lleva las dos cosas y el PR #2 del fork queda como respaldo hasta el merge.
L3. El harness bloqueó `git push --force-with-lease`. Camino alternativo elegido: merge de `upstream/main` en la rama del PR + cherry-pick del fix 8.3, push fast-forward. La historia no se reescribe; si se quiere historia rebasada, hace falta autorización explícita del force.
L4. T1 cerrado: rama `fix/workspace-git-boundary` en `b16af66` (3 commits, +101/−1 contra `upstream/main`), PR #74 MERGEABLE. `isolation.test.ts` 24/24 dos veces y `tsc --noEmit` limpio. Una primera corrida falló una vez en "Failed to stop agent process" (flake de stop, no reproducible en las dos siguientes).
L5. T2: merge commiteado en `b04ee13`; conflicto resuelto conservando el refactor `start(channel)` de upstream + `turnTimeoutMs`, y los dos grupos de tests en `supervisor.test.ts`. Slice real = 9 archivos, +177/−2 contra `upstream/main` (el aviso de 180 commits compara contra `origin/main`, que está viejo).
L6. Los dos "errores" de `tsc` en `bridge.ts`/`gateway.test.ts` eran `packages/protocol/dist` viejo: `tsc -b packages/protocol` y el typecheck del daemon queda en 0.
L7. T2 cerrado: rama `feat/turn-timeout` en `b04ee13` (3 commits, +177/−2 contra `upstream/main`), PR #75 MERGEABLE. `config` + `supervisor` + `gateway` = 84/84 verdes, `tsc --noEmit` limpio del daemon.
L8. T3 cerrado: comentarios publicados en #51 (https://github.com/Gentleman-Programming/gentle-dot/issues/51#issuecomment-6693193505) y #52 (https://github.com/Gentleman-Programming/gentle-dot/issues/52#issuecomment-6693194102).
L9. T4 cerrado en `e66561a`: el suite nunca corría (dos `it` con `await import` sin async). Al arreglarlo aparecieron 26/26 rojos por cuatro defectos distintos: mock de `RateLimiter` como arrow (no construible), mock config en `baileys` con `meta: null` cuando `src/transport/factory.ts:9` sólo soporta Meta Cloud, aserciones que describían una API vieja (`on`/`once` devuelven el emitter, `getStatus` responde el estado de ciclo de vida, metadata es `meta-cloud`), y un `stop()` que nunca existió (el contrato es `disconnect()`). Resultado: 25 passed, 1 skipped (placeholder de baileys con el motivo), `tsc --noEmit` limpio.
L10. Hallazgo lateral de T4, sin arreglar: el provider WhatsApp no tiene apagado ordenado — `src/main.ts` no engancha SIGTERM/SIGINT ni llama a `disconnect()`.
L11. Slice real de T4: 2 archivos, +33/−21. El aviso de "past the 400-line slice" compara contra `origin/main`, que está 130+ commits atrás; contra `upstream/main` cada PR es 1 slice.
L12. Publicado también el comentario de evidencia en #48 (https://github.com/Gentleman-Programming/gentle-dot/issues/48#issuecomment-6693283587) con las cifras verdes de las dos suites de canales. Cierra el motivo por el que estaba bloqueado.
L13. El usuario autoriza los force push, pero el guard del harness sigue bloqueándolos a nivel de comando (chat no basta). Se preparan las dos ramas rebasadas y el force queda como handoff de una línea para el usuario.
L14. `land-74` = 2 commits limpios sobre `upstream/main` (024aed6, 68cd0b7), árbol byte-idéntico a lo ya pusheado (`git diff land-74 origin/fix/workspace-git-boundary` vacío), por lo que la evidencia 24/24 + tsc sigue valiendo.
L15. `land-75r` = 2 commits limpios sobre `upstream/main` (fbd0f69, cc47b07) vía cherry-pick. Un primer rebase `--onto 8cb20ee` se abortó porque ese base arrastraba commits ajenos (voice-tools). Resoluciones verificadas: `git diff land-75 HEAD` vacío, y el refactor `start(channel)` de upstream conservado en `cli.ts:53`.
L16. Al re-correr `supervisor.test.ts` sobre `land-75r` fallaron 1-2 tests, pero el árbol es byte-idéntico a `land-75` (84/84). Control sobre `upstream/main` limpio (d083c4d, sin el PR): misma pareja de fallos ("a failed restart does not report ready…" y "rejects restart actionably instead of spawning over a child that did not terminate"), 2/2 en una corrida y 0/2 en la siguiente. Conclusión medida: son flakes preexistentes de upstream, ajenos a #75.
L17. El usuario corrió los dos force push con lease. Verificado por `gh`: PR #74 = `68cd0b7`, PR #75 = `cc47b07`, ambos OPEN, MERGEABLE, 2 commits, diffs sin cambios (+101/−1 y +177/−2). Se dejó una nota de historia en cada PR explicando el cambio de SHA y por qué la evidencia previa sigue aplicando (árbol byte-idéntico), más el dato de los dos flakes preexistentes en el PR #75.
L18. El usuario eligió: siguiente slice = contrato de canal; y el hallazgo del secreto por vía de advisory privado. Verificado que el advisory NO es posible: `permissions.admin=false` en upstream, el repo no tiene private vulnerability reporting (`{"enabled":false}`, POST 403) y no hay SECURITY.md.
L19. Corrección de mi propio diagnóstico: el fallback `'gentle-dot-bridge-secret'` NO está en `upstream/main` (sólo en nuestro branch), y `cli.ts:98` genera y setea `BRIDGE_AUTH_TOKEN` cuando falta. O sea: no hay nada que reportar al upstream; es basura defensiva nuestra que conviene cambiar por un fallo cerrado + test.
L20. Slice de contrato commiteado en `be2b1b0`: `packages/bridges/base/src/channel-contract.ts` con `brandInbound` y `createEchoGuard` + 6 tests propios. WhatsApp sale byte-idéntico (`📱 [Gentle Dot] `), Telegram pasa a etiquetar (`📱 [Telegram] `). Suites: bridges/base 6/6, whatsapp 25+1skip, telegram 30/30, tsc limpio en los tres. El guard de eco queda exportado y testeado, sin cablear: `sendText()` no devuelve el id saliente, así que forzarlo sería inventar.
L21. Fallback de `ws-server.ts` → `requireAuthToken()` exportado, leído una vez en `start()`: sin variable, error antes de escuchar; no queda el literal. Test `ws-auth.test.ts` 3/3. Commit `dd17076`. Control ejecutado con el cambio stasheado porque `gateway.test.ts` ya estaba roto en esta rama (37/37, "startDaemon is not a function") antes del cambio: no se puede usar como control de regresión.
L22. Eco por id cableado: `ChannelTransport.sendText()` devuelve el id del provider (meta-cloud lee `messages[0].id`), `RateLimiter.send()` lo propaga, el bridge recuerda cada id enviado en el `MessageEchoGuard` y descarta el inbound que coincide. Tests: eco descartado, id nuevo etiquetado. whatsapp 27+1skip, telegram 30/30. Commit `3aba7dc`.
L23. Corrección de dos afirmaciones mías sobre el shutdown de WhatsApp: `main.ts` SÍ engancha SIGINT/SIGTERM (líneas 49-50) y `WhatsAppBridge.shutdown()` SÍ existe (`whatsapp-bridge.ts:326`, `onStop()` + `disconnect()`). No había bug; lo que faltaba era el test. Commit `ad624d1` (28+1skip).
L24. `GIT_CEILING_DIRECTORIES` en el PR #51: commit `566b070` sobre `land-74`, pusheado fast-forward (PR #74 = 3 commits, +138/−1, MERGEABLE). PRIMER INTENTO DE TEST VACÍO: la aserción de integración pasaba por la razón equivocada porque `isolatedAgentEnv({HOME})` sin `PATH` hacía que `spawnSync("git")` no encontrara el binario. Corregido con control positivo (`toplevel({}).status === 0`) y `PATH` en el base; recién ahí el RED fue honesto (2/2) y el GREEN, 26/26.
