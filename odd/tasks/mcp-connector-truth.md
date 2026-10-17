# Conectores MCP: decir la verdad y no perder las tools

El badge de conectores dice "Connected" mirando solo la configuración, y el proxy reporta una
cancelación como "Could not reach" matando además el servidor: la sesión pierde las tools hasta un
`/mcp` o un reinicio. Esta feature hace que el proxy hable con la verdad (código de error, salud,
stderr del servidor) y que el panel muestre alcanzabilidad real con un reintento.

## Specs

- **S1** — "me aparecen connected pero a veces ya no andan": el estado que ve el usuario debe reflejar
  alcanzabilidad real, no solo configuración. Hoy `status()` (`packages/daemon/src/connectors.ts:2212`)
  devuelve `connected` con solo estar habilitado y completo.
- **S2** — "no se exponen las tools al agente": una conexión fallida no debe costar las tools de toda
  la sesión. El motor asigna `tools` solo en el camino de éxito y no reintenta por su cuenta; el proxy
  contesta todo fallo como HTTP 200 + JSON-RPC -32000, que el motor no considera transitorio.
- **S3** — "me pasa al recargar que a veces desaaprecen, tira error".
- **S4** — "me conectaba y probamos y tras reinicio se cae, o cuando conecto otro mcp (que lo reinicia
  igual creo), o al hacer /mcp se cae alguno o todos".
- **S5** — el aviso que ve el usuario, textual: "MCP servers need attention: wayland: failed: Could not
  reach wayland right now. Try again in a moment. Run /mcp to fix." Una cancelación no puede producirlo.
- **S6** — alcance decidido por el usuario: "A + B (recomendado)": proxy honesto + badge honesto.
  C (mantener el servidor caliente) queda fuera de esta unidad.

## Tasks

- **T1** — Una cancelación se reporta como cancelación y **no** cierra el servidor; el `stderr` del
  servidor se lee, se loguea y se adjunta al motivo. Specs S5, S4. Commit: 9c5074b
- **T2** — Un fallo de conexión en una petición de solo lectura se responde **503**, para que el
  reintento del motor (250 ms, 1 s) actúe; una llamada a tool sigue con 200 y su mensaje. Specs S2, S4. Commit: 9c5074b
- **T3** — La clave rota por arranque conserva **una generación** de gracia, para que una llamada en
  vuelo, un subagente o un `/mcp` inmediato no queden con 401 permanente. Specs S4. Commit: 9c5074b
- **T4** — El proxy informa alcanzabilidad y el estado del conector la refleja (`unreachable` + motivo,
  se limpia al volver a andar). Specs S1, S3.
- **T5** — Acción de reintento en el panel de conectores, con el motivo visible. Specs S1.

## Log

- **L1** — "revisa bien lo de los mcp, porque sigue el problema que me aparecen connected pero a veces
  ya no andan, no se exponen las tools al agente, me pasa al recargar que a veces desaaprecen, tira error"
- **L2** — "y n oentiend, pues me conectaba y probamso y tras reinicio se cae, o cuando conecto otro mcp
  (que lo reinicia igual creo), o al hacer /mcp se cae alguno o todos"
- **L3** — "aparecen conecte pero no le llegan las tools al agente gentle dot"
- **L4** — Decisión del usuario sobre el alcance: "A + B (recomendado)".
- **L5** — Medición (scratch, `build/mcp-probe/timing.mjs`, entorno aislado del daemon): wayland
  `initialize` 694 ms y `tools/list` 694 ms con 10 tools; context7 207 ms con 2 tools; igual en frío y
  en caliente. **Los servidores están sanos: el defecto está en el proxy y en el contrato de error.**
- **L6** — Evidencia del log del usuario (`~/.gentle-dot/daemon.log`): "could not reach connector
  wayland: MCP request aborted" ×3 y "MCP connection closed" ×6 en el mismo milisegundo. Ese texto lo
  emite la última rama de `rpcError`, así que una cancelación cayó en el camino que mata el upstream.
- **L7** — Mecanismo confirmado: `initialize` lo contesta el propio proxy, y `tools/list` es donde el
  upstream arranca; si esa primera petición falla, el motor queda con `tools = []`, `state = "failed"` y
  sin reintento hasta `/mcp` o reiniciar (`extensions/mcp/runtime.js`).

## Delivery

Esta feature es **una capa de la cadena** (un PR propio sobre `feat/niri-config-backup-prune`, dentro del
stack #34), no un solo commit gigante: el corte de slice es **T1–T3** (proxy: 245 líneas cambiadas,
commit `9c5074b`) y **T4–T5** (alcanzabilidad + reintento, commit siguiente). El aviso de slice del
harness cuenta los 27 commits de toda la cadena desde `origin/main` (24 555 líneas), que es la entrega
ya documentada en el tracker #12: una PR por capa, tracker como tronco.
