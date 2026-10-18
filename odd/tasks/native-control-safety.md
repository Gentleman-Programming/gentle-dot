# Native Niri input safety and consent

Repair the native-control live failures on stock Niri, preserving macOS behavior.
Do not publish, install, modify compositor/config, or inject input into the user's active desktop.

## Specs

- S1: "hay que ver eso, buscar una alternativa para que no pida permiso a cada rato, ver altenativa accesibility o sacar, que funcione como en mac. no tiene sentido que pida permiso a cada rato, se pierde lo agentico y proposito asi. Esto es critico."
- S2: "tambien hay que recuperar el yolo mode, que se vea en niri ahora que lo integramos en niri."
- S3: "arrelgar igual lo del alerta de permiso que tenia el titulo duplicado, el cuadro de permisos."
- S4: "type con PRUEBA-NATIVA-OK" / "La tool respondió done — 16 caracteres enviados." / "El texto no apareció en el editor: cayó en la caja de chat de la app."
- S5: "drag devolvió done pero sin efecto visible verificable. key funcionó en mi prueba, pero arrastra el mismo problema de targeting."
- S6: "scroll rechaza más de 40 ticks por operación" / "dx es obligatorio en scroll, incluso para scroll puramente vertical — el schema lo exige."
- S7: "Se niegan en vez de fingir. Es el comportamiento correcto, pero deja dos agujeros funcionales."
- S8: "implementata todo primero. Cuando este dime para probar, no publiques hasta que lo pida"
- S9: "Autorizar input normal durante la sesión (recomendado)" — human selected option 1: no repeated unknown-target click/drag confirmations after the 30-minute global grant; detected risks may still ask and Yolo may skip those. Focus validation and Stop remain mandatory.

## Tasks

- T1 [S1,S4-S7] route=explore commit=n/a done: source lifecycle map from mveabppf-g-q9cm confirms Linux dialog save/restore is absent and preparation does not hide own windows; deterministic reproduction belongs to T4. AT-SPI bus was observed available, not universal app support. frontApp null is intentional metadata, not causal proof.
- T2 [S2] route=worker commit=506fb5b done: Linux tray Yolo/Stop follow managed Computer.endpoint, not a duplicated startup predicate. Worker observed 9 tray tests and full 942 passed / 6 ignored; parent read back production wiring and setup ordering. Actual GTK/SNI menu rendering remains a T6/T7 check. Native assessment unavailable due to unrelated untracked scope; no native approval claimed.
- T3 [S3] route=worker commit=85cb378 done: native caption/body once; default deny after button registration; explicit GTK destruction proved by unshown-widget destroy/WeakRef/toplevel-count regression. Parent full suite 958 passed / 6 ignored. Actual rendered dialog and literal Return/Escape remain T6/T7 checks; macOS unchanged.
- T4a [S4,S5] route=worker commit=d0d301d done: exact-window dialog restore and positive-owner keyboard guard; same window id and owner rechecked before each text fragment and synthesized Return; partial delivery reported truthfully. Parent full suite 958 passed / 6 ignored. Separate IPC check/post is not atomic, and drag outcome remains T5; no live-user input.
- T4a2 [S4,S8] route=worker commit=9f91540 done: keyboard input binds to the window observed with the latest screenshot (id + captured owner pid, before and after the capture; unknown/own/moved/failed-query binds none while still returning the image); Session.epoch is the single invalidation truth so an explicit Stop or panic always moves it, Control.grant_if_epoch compares and grants under the one session mutex, and a stale Yolo enable is refused while a revocation always commits. Parent read the diff; worker observed 390 focused and 969 full lib passed / 6 ignored before the sibling writer's in-flight module. Residual: the focus check and each individual keyboard post stay separate IPC calls; drag uncovered. No live-user input.
- T8 [S1,S9] route=worker commit=86e9ab3 done: the fabricated blanket confirmation for an unclassifiable global target is gone, so after the 30-minute grant ordinary input posts with no dialog and only a risk the caller actually detected asks (a target chain or the declared intent). `GLOBAL_CONFIRM_REASON` and its dialog-copy test were removed and `GLOBAL_INSTRUCTIONS` states the real contract and its honest limit. The macOS targeted path is byte-identical by construction, since the removed arm was the only global-specific branch. Worker observed RED 407+1 then GREEN 407; parent ran the full barrier at 989 passed / 0 failed / 6 ignored.
- T5a [S7] route=worker commit=8f74e43 done: inventory from Niri's real Windows reply and GIO launch of an installed desktop entry; no shell, no constructed Exec, own entry refused. Parent review found and fixed a real defect: a non-positive pid refused the whole inventory even for an app_id window, contradicting the backend's own unusable-owner rule. Worker observed 49 focused and 185 linux; parent observed 186 linux after the fix. Live Niri session and real installed apps remain unverified; no real app launched.
- T9 [S5,S6] route=parent merged into T11: scroll usability and the drag limits are one reviewable unit in mcp.rs/pointer.rs.
- T11 [S5,S6,S7] route=worker commit=bd451fa done: `dx` optional with default 0 and a truthful schema/description; Linux tick cap 40 to 120 with a deadline/Stop check on every tick and an actionable refusal; the catalog is policy-driven so the desktop-global text names the cap and the real launch/inventory semantics while the macOS wording and its "Open …: done." acknowledgement stay byte-identical. Worker observed 416 focused and 996 full lib; parent re-ran the full lib barrier. Confirmed by the worker and by the parent's read: `drag_pointer` queues every interpolated motion and the release without a flush, so they reach the peer as one burst at the end.
- T12 [S5] route=worker commit=b8bcd38 done: `drag_path` holds the interpolated points and the `DragStep` seam injects check, motion, flush and pause, so the per-step flush is pinned deterministically without a socket. Worker observed RED (cadence without the flush) then GREEN 191 linux / 999 full lib; parent re-ran the full lib barrier. Endpoints, ordering, DRAG_STEPS, DRAG_STEP_MS and the release-on-every-exit guarantee unchanged; the visible effect stays a live check, never a claim.
- T6 [S1-S8] route=verify commit=n/a done: mvecwp3h-x-h1yp audited the post-S9 consent surface and returned PASS on all four items with file:line evidence — every mutating tool reaches the grant gate and the removed blanket was provably not the only gate; Stop/expiry invalidate a pending grant and a stale Yolo enable is refused while a revocation always commits; Yolo skips only the risk confirmation; the keyboard target is the screenshot-observed window with truthful partial delivery. macOS UNAVAILABLE (cannot compile here). Advisories: A1 stale `cancel_all` comments in linux/desktop.rs contradicted the real `app.rs` wiring (fixed); A2 the focus check and each post remain separate IPC calls, inherent to Wayland and documented; A3 on Linux the only detected-risk signal is the declared intent, consistent with S9. Its durable probe strengthened the no-session gate test to all seven mutating tools. No live Niri run, so live Stop-cancels-in-flight, GTK rendering and real focus stay unverified.
- T7 [S8] route=parent commit=n/a done: local integrated test package preserving provider recovery, built on test/native-safety-provider-recovery by merging the safety branch tip into the previous recovery integration (no conflicts). The manifest's daemonCommit equals the merge commit and the staged runtime carries the recovery extensions; merged-tree suites green (Rust 999/0/6, JS 942 passed / 13 skipped). Rebuilt after the Yolo copy fix as c779f64. Nothing installed and nothing published: the human installs and tests, and publication stays blocked until they ask.
- T13 [S3] route=parent commit=c779f64 done: the live user test showed the native Yolo dialog saying "Stop and ⌥⇧Esc still work" on Niri — the Linux dialog re-exported the app-layer text, so the Mac notation leaked into Linux copy. RED observed first (the Linux copy contains ⌥ and does not name the real key), then `GLOBAL_YOLO_TEXT` names Alt+Shift+Escape exactly as the managed snippet writes it, and the Linux dialog asks with it. The panel was already correct through `platform_info.stopShortcut`, and `RESERVED_PANIC` already carried both spellings, so the native dialog was the only leak. Parent observed 1000 passed / 0 failed / 6 ignored.

## Log

### L1 — Original request (verbatim)

Mover el mouse sin Yolo │ Normalmente no pregunta: se considera inocuo │ Pregunta, porque pusimos una confirmación conservadora al no tener Accessibility

hay que ver eso, buscar una alternativa para que no pida permiso a cada rato, ver altenativa accesibility o sacar, que funcione como en mac. no tiene sentido que pida permiso a cada rato, se pierde lo agentico y proposito asi. Esto es critico.

tambien hay que recuperar el yolo mode, que se vea en niri ahora que lo integramos en niri.

arrelgar igual lo del alerta de permiso que tenia el titulo duplicado, el cuadro de permisos.

Tambien lo probe con el agente y este es el reporte, hay que verlos y fixearlos igual:


CachyOS + Niri

11 tools probadas en vivo. Resumen: 7 funcionan, 2 no están soportadas, y hay 1 defecto de fondo que afecta a 3 tools de input.

✅ Funcionan (7)

Tool    Resultado    Detalle
screenshot    ✅    1280x720, escala 0.5. Abre la sesión con contador y Stop
move    ✅    punto exacto, responde done
click    ✅    el click aterriza donde se pide
scroll    ✅    ver límite abajo
wait    ✅    espera y devuelve captura
batch    ✅    3/3 pasos (move, wait, move)
key    ✅    ctrl+a + backspace funcionaron
❌ No soportadas (2) — y está bien que se nieguen

Tool    Mensaje
list_apps    "no Accessibility inventory exists to list (refusing instead of returning a faked empty list)"
open_app    "no trusted launcher exists yet (refusing instead of spawning a shell)"
Se niegan en vez de fingir. Es el comportamiento correcto, pero deja dos agujeros funcionales.

⚠️ El defecto de fondo: input a ciegas (type, key, drag)

Acá está el problema serio. Abrí un gnome-text-editor descartable, lo enfoqué (Niri confirmaba focused = TextEditor), y mandé type con PRUEBA-NATIVA-OK.

La tool respondió done — 16 caracteres enviados.
El texto no apareció en el editor: cayó en la caja de chat de la app.
La causa: frontApp viene null en todas las respuestas. Sin inventario de accesibilidad, la app no sabe qué ventana tiene el foco — así que tipea a ciegas sobre lo que sea que lo tenga, y tampoco puede verificar dónde cayó.

Por qué es grave: tipear a ciegas en un terminal, seguido de Enter, ejecuta comandos. No es un detalle cosmético; es un riesgo de ejecución involuntaria en la ventana equivocada.

drag devolvió done pero sin efecto visible verificable. key funcionó en mi prueba, pero arrastra el mismo problema de targeting.

Detalles menores que encontré

scroll rechaza más de 40 ticks por operación: "more than 40 axis ticks in one operation". Con 30 funcionó.
dx es obligatorio en scroll, incluso para scroll puramente vertical — el schema lo exige.
Confirmación por cada acción de input. El permiso de pantalla (la sesión con contador) no cubre mouse/teclado: son permisos separados.
Sobre tu pregunta anterior del mouse

Aparece en tu propio código en prueba:

"Mover el mouse sin Yolo | Normalmente no pregunta; se considera inocuo | Pregunta, porque pusimos una confirmación conservadora al no tener Accessibility"

O sea: no debería preguntar, y pregunta por la limitación de Accessibility. Tu otra sesión ya está en eso.

Dos cosas que te debo

Te inyecté texto en la caja de chat (PRUEBA-NATIVA-OK) al probar type. Ya lo limpié con ctrl+a + backspace — verificado, la caja quedó vacía.
Un Backspace pudo haber caído en tu terminal mientras escribías. No pude confirmarlo. Si te falta un carácter en tus notas, fue eso.
Qué arreglaría, por prioridad

Targeting de ventana para input. Es el bloqueante real. Sin eso, type y key no son confiables ni seguros.
drag sin verificación — no hay forma de saber si el arrastre hizo algo.
Yolo mode en la bandeja (ya detectado en tu sesión: shell.rs:2028 sigue atado a macOS).
Alinear la regla del mouse con macOS: si es inocuo, no debería pedir permiso.
Te dejé abierto el gnome-text-editor descartable (con un carácter suelto adentro, sin valor). Decime si querés que lo cierre.

### L2 — Investigation evidence

- Existing worktree reused for this Niri thread; branch fix/native-control-safety starts at native34ef085. Pre-existing untracked odd/tasks/niri-installed-startup.md is unrelated and must remain untouched.
- Slice boundary: this branch carries the whole native chain (13 commits) plus the safety repairs, so `git commit` reports ~41k authored lines since origin/main. The feature's delivery strategy is the fork chain (tracker #12 as trunk, one layer per unit) with upstream delivery through PR #80; each safety unit below is its own commit so a layer can take it alone.
- Explorer mveabppf-g-q9cm investigates focus lifecycle. No final focus diagnosis yet.
- AT-SPI official EditableText/StateType documentation exposes editable objects and focused state; support is not universal and is not equivalent to atomic per-window input.
- Niri IPC official docs support FocusedWindow and focusing a window by id; no claim of atomic IPC-check plus Wayland-injection safety.
- Exact rfd0.16 GTK backend passes opt.title into both gtk_message_dialog_new primary text and gtk_window_set_title. This explains the duplicated visible heading.
- shell.rs tray gate remains cfg!(target_os = "macos") although Linux helper is now available. This is a confirmed integration omission.
