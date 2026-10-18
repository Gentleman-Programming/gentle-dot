# Native Linux desktop control

Implement a native Rust backend on stock Niri using advertised Wayland protocols.
Explicit desktop-global consent; no compositor patches and no external MCP server.

## Specs

- S1: "no hay una opcion nativa para wayland? para no andar con mcp sino qye sea nativa como la version de mac y asi le pondemos lo de yolo y los 30min para controlarlo. Podrias ser algo parecido a lo que hace o las tools del mcp pero ya nativas."
- S2: "Niri nativo completo (recomendado)". Initial functional target is stock Niri; preserve the existing native tool catalog, with truthful unsupported-capability errors.
- S3: "revisa igual los cambios que llevamos ver que solucion o cosa que implementamos es solo para niri y que es para linux en general o extrapolable a otras distros (y ve si se puso asi, sin romper otras). lo mismo para este cambio nuevo". Detect protocol capabilities; do not activate an incompatible backend or alter other platforms.
- S4: "no sirve, no podemos modificar niri, no es solucion". No compositor patches, forks or installation changes.
- S5: "/home/jona/mnt/sv-home/dev/upstream/wlroots-bridge bien, ahi et lodeje para ervisar con codegraph u demas como referencia. Acepto el model oque planteas". Explicitly accepted desktop-global 30-minute authorization, app-owned Yolo and Stop, without promising reliable per-application blocking.
- S6: "cuando este me avisas para probar". Build and report a test package before publishing native-control changes.

## Design boundaries

- Global desktop control is an explicit backend policy, not a fabricated target identity. Keep macOS target checks and native permission behavior unchanged.
- Session expiry, Stop, approval and Yolo belong to the app. Reference bridge session no-ops are not an implementation.
- Capture/input use supported Wayland protocols without root, uinput, ydotool or an external MCP server. The existing internal MCP transport may remain.
- No silent focus fallback, reliable-blocklist claim, or unsupported GNOME/KDE/X11 claim. Portal backends are future scope, not this implementation.
- Unsupported capabilities fail closed with truthful labels/reasons. Reference reuse requires license attribution and bounded waits, correct output geometry and held-input cleanup.

## Tasks

- T1 [S1-S6] route=parent commit=056abb6 done: reconcile design and inspect local bridge/application seams.
- T2 [S3-S5] route=worker commit=056abb6 done: explicit desktop-global policy and truthful permissions/consent, preserving native macOS mode; deterministic RED/GREEN checks.
- T3a [S1-S4] route=worker commit=5093697 done: Linux-only Wayland dependencies, bounded connection/registry dispatch and capability discovery; no live input or production startup.
- T3b1 [S1-S4] route=worker commit=ec05a96,23c50fb done: output geometry and coordinate/transform validation using bounded dispatch.
- T3b2 [S1-S4] route=worker commit=330b0d6 done: capture buffers and encoding using bounded transport and validated output geometry.
- T4a [S1-S5] route=worker commit=pending: bounded virtual-pointer actions and owned button cleanup, no production startup.
- T4b [S1-S5] route=worker commit=pending: virtual-keyboard/keymap input and owned modifier cleanup, no production startup.
- T5 [S1-S5] route=worker commit=pending: app integration, tool catalog, session lifecycle, Stop, Yolo and truthful UI.
- T6 [S3-S6] route=verify commit=pending: independent safety/portability verification, docs and functional checks.
- T7 [S6] route=parent commit=pending: build package and await user test; no native-control publication before approval.

## Log

- **L1** — "no hay una opcion nativa para wayland? para no andar con mcp sino qye sea nativa como la version
  de mac y asi le pondemos lo de yolo y los 30min para controlarlo. Podrias ser algo parecido a lo que hace
  o las tools del mcp pero ya nativas. investiga opciones, tienes el repo de niri ahi, ademas puede traer
  repos para revisar en /home/jona/mnt/sv-home/dev/upstream como el del mcp u otros mcp o repos para ello
  que sirvan de guia/ejemplo"
- **L2** — "primerp fijate bien las tools/permisos de macs, para ver que falta, como screenshots y demas,
  pero ve todas primero"
- **L3** — Alcance elegido: "Niri nativo completo (recomendado)".
- **L4** — "revisa igual los cambios que llevamos ver que solucion o cosa que implementamos es solo para niri
  y que es para linux en general o extrapolable a otras distros (y ve si se puso asi, sin romper otras).
  lo mismo para este cambio nuevo"
- **L5** — Inventario macOS (11 tools en `computer/mcp.rs:158`): screenshot, click (x,y,button,count), move,
  drag, scroll (dx,dy), type, key, open_app, list_apps, wait, batch (1..20 pasos). Guardas en orden: rate
  limit, permisos, sesión, blocklist, confirmación de riesgo. Cada acción devuelve una captura nueva.
- **L6** — El MCP actual (`wayland_mcp_kurojs-0.5.1`, 10 tools) cubre type/key **dentro de un DSL de strings**
  (`execute_action("chain:click:100,200;type:hello")`), escribe la captura a archivo en vez de devolver la
  imagen, y no tiene sesión, Yolo, blocklist ni rate limit.
- **L7** — niri (verificado en `/home/jona/mnt/sv-home/dev/upstream/niri`): implementa `virtual_pointer` y el
  virtual keyboard de smithay (`niri.rs:2487`), y `client_is_unrestricted` solo excluye clientes con
  security-context (`niri.rs:7123`) → una app normal puede inyectar puntero y teclado. `screencopy.rs`,
  `screencasting/` (PipeWire) e `image_copy_capture` están registrados sin restricción de cliente; el gate
  `is_tty` de `niri.rs:2515` es solo para gamma control.
- **L8** — Límites reales en Linux: el IPC de niri no da geometría absoluta por ventana (`ipc/client.rs:741`
  solo trae la posición en el layout), y **no hay equivalente de Accessibility**, que es lo que alimenta
  `risk.rs` para decidir si un clic es riesgoso.
- **L9** — Auditoría de portabilidad (explore, read-only) sobre lo que ya llevamos. Resultado: las
  superficies niri-only están **bien guardadas y fallan cerrado** (el escritor de KDL solo se llama si
  `is_niri`, el IPC toma el socket de `$NIRI_SOCKET` sin asumir `/run/user/1000`, los scripts de distro usan
  el gestor nativo y fallan ruidosamente, y `docs/` es preciso). Detección centralizada en
  `platform.rs:31-40` (`is_niri`: `NIRI_SOCKET`, o el token exacto en `XDG_CURRENT_DESKTOP`, con substrings
  rechazados por test). **Tres hallazgos**: (F1) `scripts/linux/uninstall.sh:55` borra solo
  `Gentle Dot.desktop` pero la entrada estable es `gentle-dot.desktop` (`autostart.rs:32-42`) → queda un
  autostart fantasma tras desinstalar; (F2) existe un **gemelo débil** de la detección,
  `niri/unit.rs:30` (`niri_route_env`, sin chequeo de socket) usado en `shell.rs:674,699,1273,1303,1593`:
  en una sesión niri sin socket usable el panel se esconde y el reopen cae al fallback en vez de restaurar;
  (F3) `autostart.rs:208-216` ignora `XDG_CONFIG_HOME` (usa `$HOME/.config`), mientras el camino KDL sí lo
  respeta. Además `niri_socket_present()` (`route_gate.rs:205`) da por presente cualquier `$NIRI_SOCKET` no
  vacío sin probar que conecte.
- **L10** — Regla que se desprende para esta feature: **reusar la detección centralizada** (`platform.rs`),
  no agregar un predicado propio ni un gemelo débil, y extenderla con las capacidades (portal, protocolos,
  comandos presentes) en el mismo lugar, con tests sin compositor.

- L11: User cancelled the patched-compositor experiment. Niri worktree remains isolated; do not resume it.
- L12: "sigue investigando, investigacion profunda de solucion, tieene el repo de niri igual /home/jona/mnt/sv-home/dev/upstream/niri pero encuentra una solucion, en la web, opensoruce, git, investiga bien"
- L13: "/home/jona/mnt/sv-home/dev/upstream/wlroots-bridge bien, ahi et lodeje para ervisar con codegraph u demas como referencia. Acepto el model oque planteas"
- L14: S5 supersedes the previous unknown-target-refusal policy only for an explicit desktop-global Linux mode. Never claim a resolved per-app target. Earlier assumptions that Act::Other always confirms, windows.rs is Windows OS support, and the core needs no policy seam were incorrect.
- L15: Stock Niri has ScreenCast but no implemented RemoteDesktop/InputCapture/EIS in the reviewed code. Protocol input works globally. Reference bridge app-under-point returns None and session lifecycle is no-op; neither supplies macOS security parity.
- L16 (T2, first policy slice): explicit `BackendPolicy` seam (`computer/mod.rs`: `Targeted` default, `DesktopGlobal`; `GLOBAL_TARGET`, `GLOBAL_CONFIRM_REASON`, `GLOBAL_GRANT_TEXT`). `Helper::with_policy` opts in; default preserves Mac unknown-target refusal and schemas untouched. Global mode names only the Linux desktop (no fabricated pid/app, screenshot `frontApp` null), skips only per-app attribution/blocklist, forces per-action confirmation outside Yolo (AX unavailable), and keeps grant/rate/epoch/Stop/expiry. Linux consent UI pending T5; no backend, no Wayland connection yet. Fake-backend RED/GREEN through the Helper MCP interface; `computer::` suite 183 passed.
- L17 (T2 verifier follow-up): policy-aware `initialize` instructions (`GLOBAL_INSTRUCTIONS`: Linux desktop as a whole, no reliable per-app exclusion, no Mac claims; Targeted text byte-identical) and policy-aware `check_permissions` errors (global names no macOS 14 / Screen Recording / Accessibility). Fixed the `keyboard_target` early-return newline and ordered the new imports locally. Extended fake-backend tests: drag/scroll/open_app ask outside Yolo, declined mutations post nothing (events/opened/captures unchanged), global initialize truthfulness, targeted initialize unchanged. `computer::` suite 188 passed.

- L18: T2 committed as 056abb6; 188 computer tests, full Rust library 757 passed / 6 ignored. Independent verifier findings corrected; native review review-f682b0af8a12e44d approved and acknowledged. Slice 428 diff lines including specification, 345 source/test diff lines. Subsequent work split into T3a transport and T3b capture, each separate reviewable commit. No native-control push before user test.

- L19: T3a committed 5093697 after fake-peer hardening and native review review-94f3bf1462181744 approved/acknowledged. 16 focused tests; full library 773 passed, 6 ignored (worker evidence). 1361 diff-line exception includes protocol fake-peer harness; no safe checks removed. WAYLAND_SOCKET shared-stream adoption refused until exclusive ownership exists. Real compositor sweep pending. Next capture work split into geometry and buffers rather than repeating this oversized slice.

- L20: Geometry committed ec05a96; independent verifier B1-B3 plus parent B4 corrected with observed RED/GREEN. Final17geometry tests, full790pass6ignored(worker).
- L21: Outputs collector committed23c50fb, independent verifier PASS(no blockers),8focused tests exit0, worker full798pass6ignored. Real compositor untested. Native assess blocked by unrelated untracked selection; no native approval asserted. Next T3b2 capture remains nonproduction until checks.

- L22: Capture committed330b0d6. Independent verifier found frame/pool/buffer leaks, postready cancellation/deadline gaps and nominal-vs-actual geometry mismatch; corrections pinned through fake peer. Writer Interrupted caused write_all retry and was replaced by Other. Final22focused/full820passed6ignored(worker evidence). Parent read encoder deadline/cancel/budget/postcheck. No live capture; codec cooperative between writes, not realtime. Native assess unassessable due untracked declaration despite inspect selection; no native approval claimed. Capture slice2417diff lines exceeds target including fake protocol tests; next input split into pointer then keyboard to limit scope.
