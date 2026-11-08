# Slice: alineación de la capa MCP con la arquitectura de upstream

Rama: `slice/mcp-alignment` (base: `32a23b8`). Regla de oro: ~400 líneas por PR, encadenados si
hace falta, 1 commit por unidad.

## Por qué este slice

`McpProxy` es el spine del producto (S25.4: todo acceso a conectores —incluidos los subagentes—
pasa por el proxy con gate). Upstream mantiene su `McpProxy` con la API que nuestros 30 tests
especifican (`rotateKey/handle/sync`) y la llevó más adelante: el flujo de aprobación quedó como
callback inyectado con preview completo. Nuestro endpoint in-process en `ws-server` fue la
desviación. Reconverger = ruido cero contra la arquitectura de Alan + trabajo PR-able upstream.

## Mapa de adopción (verificado contra `upstream/main` b141d30)

### ADOPTAR (el diseño de upstream, 552 líneas)

1. **`McpProxyOptions` — inyección de dependencias**: el proxy no posee el store; recibe
   callbacks que el daemon cablea:
   - `connector(id): ProxiedConnector | undefined` — **leído en cada request** (sin cache drift)
   - `prepare?(id)` — corre antes de leer estado (secretos desde la app)
   - `credentials(id): Promise<UpstreamCredentials>` — headers/env/authProvider por request
   - **`approve(preview: ApprovalPreview, signal): Promise<boolean>`** — la joya: preview
     completo de lo que se va a enviar (connector, tool, argumentos) antes de forwardear una
     acción de escritura; `false` o fallo rechaza; el signal aborta cuando el engine se rinde
   - `transport?` — streamable HTTP o stdio, por conector
   - `env`/`cwd`/`stdio?: { user, home }` — **aislamiento S25.8**: los servidores stdio corren
     como otro usuario, fuera del alcance del engine y del daemon
2. **`ProxiedConnector`** rico: `readOnlyTools` curados, `server: {url} | {command,args,cwd}`,
   `revision` (reconexión cuando cambia), `unavailable?` (razón segura para mostrar).
3. **`UpstreamCredentials`** por request — los secretos nunca viven en el proxy.

### CONSERVAR (nuestro aporte, compatible)

- La **clave por arranque** (`rotateKey()` existe en ambos ✓) — el endpoint de ws-server la
  entrega; el nuevo proxy la consume vía `authorized(header)`.
- El endpoint `/mcp` de `ws-server` sigue siendo la puerta HTTP; pasa las requests a
  `proxy.handle(req, res)` (misma firma que la API vieja ✓).

### RE-CABLEAR (nuestras piezas que cambian de forma)

- **EventEmitter → `log` callback**: nuestro proxy emitía eventos; el de upstream reporta por
  `options.log`. Los 2 tests que hacen `proxy.on(...)` se reescriben contra el log inyectado.
- **Aprobación**: la nuestra vivía dentro (requestApproval + timeout 30s + approvalTools); la de
  upstream la inyecta el daemon (que pregunta a la ventana con su propio timeout). El test de
  aprobación se reescribe contra el callback.
- **El endpoint de ws-server**: hoy construye list/call él mismo; pasa a delegar en
  `proxy.handle`.

### Divergencias a documentar (no adoptar hoy)

- `stdio?: { user, home }` — requiere usuario OS dedicado (S25.8 server mode); en nuestro camino
  local se pasa `undefined` y queda por defecto. Documentar como seguimiento del modo server.

## Plan en commits (regla de oro)

1. **Adoptar el archivo** de upstream entero (552 líneas, mecánico) + compilar. Los 30 tests
   quedan rojos a sabiendas (la API cambió).
2. **Cablear el daemon**: los callbacks de `McpProxyOptions` contra `ConnectorStore`/`Manager`
   (adapter para el descriptor rico: readOnlyTools/revision/unavailable), `GENTLE_PI_CONFIG_HOME`
   etc. sin cambios.
3. **Re-hogar el endpoint**: `ws-server` delega en `proxy.handle`; la clave por arranque sigue.
4. **Los 30 tests** como suite de aceptación: verdes o con su decisión por test (los `.on(` ×2 →
   log; el de aprobación → callback).

## Verificación

- `tsc --noEmit` limpio por commit.
- `mcp-proxy.test.ts` verde al final del slice (los 30, con sus adaptaciones documentadas).
- `connectors-gateway` (8) + `app-ws-gateway` (2) siguen verdes (el endpoint /mcp cambia de
  proveedor interno).
- Suite completa ≥ yardstick vigente (531/90 de 639) con varianza conocida.

## Notas de cableado (sondeo del 2026-11-08, sesión de arranque)

Lo verificado al intentar el commit 1 — el contrato cambia de forma y estas son las piezas:

1. **Un endpoint por conector**: `serve()` extrae el id de la URL (`pathname.slice(MCP_PREFIX)`)
   → el engine habla MCP real contra `/mcp/<connectorId>`, tools sin prefijo. El naming del guard
   sobrevive: el engine nombra cada servidor por el id del conector (el `mcp.json` del store
   lleva `mcpServers: { <id>: { url: .../mcp/<id> } }`).
2. **`writeMcp` del store**: pasa de una URL única a URLs por conector (`/mcp/<id>`).
3. **Sitios de uso en daemon.ts** a reemplazar: `new McpProxy()` → `new McpProxy(options)`;
   `.on('approval_requested'|'server_ready'|'server_error')` ×3 → el callback `approve` +
   `options.log`; `proxiedTools()`/`callProxiedTool()` → desaparecen (el proxy sirve el
   protocolo completo: initialize/tools/list/tools/call/resources/prompts con `readsAllowed`).
4. **ws-server**: `mcpEndpoint` pasa de `{key, list, call}` a `{key, handle}` y delega en
   `proxy.handle(req, res)` — el proxy valida su propia key (`authorized(header)` + `rotateKey`).
5. **El gate de aprobación ya está en su callTool**: `refuseHidden` + `isReadOnlyTool` +
   `options.approve(preview, signal)` con preview completo y REFUSED si no se pudo preguntar
   ("Nothing was sent").
6. Los 30 tests se reescriben contra la clase nueva (mismos métodos públicos, constructor con
   options; los 2 `.on(` → `log`).

Estado del arranque: el swap del archivo se probó (tsc marcó los 12 sitios) y se revirtió para
no dejar el árbol rojo; esta rama queda con el mapa + notas, lista para ejecutar los 4 commits
en la sesión siguiente.
