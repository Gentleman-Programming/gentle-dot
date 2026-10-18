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

## Tasks

- T1 [S1,S4-S7] route=explore commit=n/a done: source lifecycle map from mveabppf-g-q9cm confirms Linux dialog save/restore is absent and preparation does not hide own windows; deterministic reproduction belongs to T4. AT-SPI bus was observed available, not universal app support. frontApp null is intentional metadata, not causal proof.
- T2 [S2] route=worker commit=pending in_progress: mveafd9z-h-39zs exposes tray Yolo/Stop whenever the native helper exists on Niri; preserve Mac menu and refusal behavior.
- T3 [S3] route=worker commit=pending in_progress: mveag61q-i-rg4h removes duplicate Linux native-dialog heading without changing consent/button safety or macOS behavior.
- T4a [S4,S5] route=worker commit=pending in_progress: mveainaw-j-xvaf reproduces dialog-steals-focus then restores exact Niri window identity and checks before input; no live input and no atomic-injection guarantee.
- T4b [S1] route=worker commit=pending: use actual accessibility capabilities where available and remove blanket per-action unknown-risk prompts for ordinary input, preserving session consent, known-risk confirmations and focus validation; document limits.
- T5 [S6,S7] route=parent commit=pending: determine supported operation contracts and truthful capability gaps; do not invent successful drag/app launch/inventory.
- T6 [S1-S8] route=verify commit=pending: independent security/concurrency verification and isolated functional checks; no live input on user windows.
- T7 [S8] route=parent commit=pending: produce local integrated test package preserving provider recovery; no publication or installation.

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
- Explorer mveabppf-g-q9cm investigates focus lifecycle. No final focus diagnosis yet.
- AT-SPI official EditableText/StateType documentation exposes editable objects and focused state; support is not universal and is not equivalent to atomic per-window input.
- Niri IPC official docs support FocusedWindow and focusing a window by id; no claim of atomic IPC-check plus Wayland-injection safety.
- Exact rfd0.16 GTK backend passes opt.title into both gtk_message_dialog_new primary text and gtk_window_set_title. This explains the duplicated visible heading.
- shell.rs tray gate remains cfg!(target_os = "macos") although Linux helper is now available. This is a confirmed integration omission.
