# Windows runner temp admission diagnostic
One inert hosted run, isolated on `qa/windows-runner-temp-44810128936` from `49096b1`; Windows x64 QA and approved download page are not changed.

## Specs
- S1: «listo de una monta la weg con la instaldor y probemoslo»; selected «GitHub Actions y web local de descarga»: «Validar primero el instalador en CI y, si pasa, probar una página de descarga local, sin publicar un release.»
- S2: selected «Sí, correr solo el diagnóstico»: «Una ejecución en una rama de diagnóstico, sin recompilar, instalar ni publicar un release. La web sigue pendiente.» Diagnostic question: «¿Autorizás una prueba nueva y acotada en GitHub Actions para identificar qué chequeo de la carpeta temporal frena el diagnóstico antes de abrir la app?»

## Tasks
- T1 | S2 | test-first inert runner temp discriminator and isolated pipeline; independent verification | local checks and static correction recheck complete | diagnostic source commit
- T2 | S2 | one normal push of exact diagnostic ref and observe exact SHA | pending | n/a
- T3 | S1 | local download preview only after unmodified native acceptance passes | pending, prerequisite unavailable | n/a

## Log
- L1: «listo de una monta la weg con la instaldor y probemoslo»
- L2: Selected «GitHub Actions y web local de descarga», then selected «Sí, correr solo el diagnóstico». This does not authorize repeating T25, accepting failed installer gates, or publishing a prerelease.
- L3: Current preview run 44794993333 compiled x64 but failed both native acceptance gates. Diagnostic runs 44807338245 and 44810128936 both stopped at scratch-refused before opening the desktop. New hypothesis: PowerShell and Node runner-temp admission disagree, especially in-process DriveInfo vs Node's restricted Windows PowerShell child. Separately project host-metadata, wrapper path/drive/ancestry, builder path/ancestry/canonical identity/outside checkout/drive child outcome. Use exact source conditions under the new narrowly scoped host identity and only a closed result vocabulary. No artifacts, dependencies, payloads, file mutation by the probe, application launch, release or gate edits. Preserve primary and approved web WIP. Don't replay if inconclusive. Latest historical evidence: other worktree `odd/tasks/windows-installer-preview-release.md` L65.
- L4: Risk item 5 (CI delivery/environment) and item 2 (runner admission/paths). No native application proof is attempted. Dedicated exact push workflow, sole Windows job, read permissions; exclude this exact branch from any generic push workflow to honor the one-run scope. Preserve existing behavior for other branches. Verify actual push/run by exact SHA and name.
- L5: Paused on «freana por un momento deja en memora donde vas», then resumed on «ya podemos seguir aqui». Node cache correction prefers regular preinstalled Windows x64 Node 24.14.1, otherwise the highest eligible stable 24.x x64. It verifies the running binary's version/architecture projection and rejects unexpected stderr. No download or PATH fallback. Writer observed RED 5 pass / 1 fail and GREEN 6 pass; runner-cache PowerShell contracts RED then GREEN in three groups. Earlier seven-branch/tag workflow differential unchanged by the cache correction.
- L6: Same independent verifier's correction-only static recheck found no blocker (mwtbo5jq-1-pluc). The earlier independent executable setup was not replayed. Parent spot check: Node 6/6, PowerShell 5 three contract groups, PowerShell AST and diff checks all exit 0. PowerShell 7 and actual hosted cache remain unproven. A static pass permits spending the single observation, not interpreting it as Windows installer acceptance.
