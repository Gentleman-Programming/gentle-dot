# PRs encadenados armados (pendientes de envío con aprobación)

## PR 1 — MCP alignment (listo para abrir cuando se apruebe)

- Rama en el fork: `slice/mcp-alignment` (pusheada, commit `35f5bd0`, base `32a23b8`).
- Destino: `Gentleman-Programming/gentle-dot` ← `ipproyectosysoluciones:slice/mcp-alignment`.
- Título: `feat(daemon): wire the connector MCP layer to the injected-proxy design on Linux`
- Cuerpo: `/tmp/pr_mcp_body.md`
- Comando:
  ```bash
  gh pr create -R Gentleman-Programming/gentle-dot \
    --head ipproyectosysoluciones:slice/mcp-alignment \
    --base main \
    --title "feat(daemon): wire the connector MCP layer to the injected-proxy design on Linux" \
    --body-file /tmp/pr_mcp_body.md
  ```
- **Alcance honesto**: la rama lleva nuestra línea completa (base 32a23b8), no solo el slice —
  el port a main pide los 3 hooks (proxyView/credentials/ask) porque los programas difieren.
  El cuerpo del PR lo dice explícitamente.

## PR 2+ — siguientes tandas (no armados aún)

- `app-channel`: API drain/platform de upstream — después del mcp (posible solape).
- `vps-gateway`: revisión contra el modo VPS actual.
- Aislamiento + veto de origin: ya viven en `feat/gentle-dot` (pusheado); el issue #222 tiene la
  verificación publicada; se ofrece port si lo piden.

## Reglas al enviar

1. Verificar duplicados en upstream ANTES de crear (hecho hoy: nada pisa estos temas).
2. El push de ramas nuevas al fork es seguro; el PR contra upstream lo abre el usuario con gh.
3. Cada PR con su medición antes/después en el cuerpo.
