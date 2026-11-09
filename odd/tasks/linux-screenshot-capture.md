# Linux screenshot capture via xdg-desktop-portal

Backend Linux de captura de pantalla (solo captura, sin entrada) para el módulo `computer`, vía portal Screenshot de xdg-desktop-portal, apuntado a Hyprland. Mismo patrón que el backend Windows: un módulo nuevo que implementa el trait `Desktop` compartido.

Branch: `feat/linux-distribution` · Test runner: `cargo test` (`apps/desktop`), validación `scripts/package/linux-check.mjs`

## Specs

- **S1 — Sin tocar Windows ni macOS.** User: "no habiamos mergeado ya??" / decisión registrada: "si nadie lo valido, no lo toquemos... si modificamos los otros que tienen que ver con linux". "no quiero mandar al repo cosas q puedan romper los demas sistemas operativos."
  - Acceptance: `git diff` del feature no modifica archivos de macOS (`macos.rs`, `app.rs` partes macOS) ni de Windows (`win*.rs`, `winput.rs`, `daemon/windows*.rs`); solo módulos nuevos `computer/linux*` y los mínimos puntos de enganche en `mod.rs`/`app.rs` tras gates `#[cfg(target_os = "linux")]`.
  - Checks: revisión de diff por tarea; los 551+ tests existentes siguen pasando en contenedor Linux.
- **S2 — Captura puntual por portal Screenshot.** User (elección): "Screenshot puntual (recomendado)".
  - Acceptance: `Desktop::capture()` en Linux obtiene una imagen vía `org.freedesktop.portal.Screenshot` (D-Bus), hyprland backend, y la devuelve como `Capture` en la geometría que `coords.rs` espera. Sin PipeWire ni stream continuo.
  - Checks: test RED de las partes puras (parseo de respuesta del portal, mapeo de URI→píxeles) que corre en todas las plataformas (`any(linux, test)` según convención del repo); integración real manual en Hyprland (T9).
- **S3 — Permiso refleja el grant real del portal.** Establecido en la investigación de portales (obs 2737): "Capture permission must reflect actual portal grant/revocation, not hardcoded true."
  - Acceptance: `Desktop::permissions()` deriva de la respuesta real del portal (grant/revocación/error), nunca `true` fijo. Si el usuario niega en el dialog del portal, `capture()` devuelve la negativa como error descriptivo y la UI lo muestra.
  - Checks: test de unidad con respuestas simuladas del portal (otorgada, denegada, cancelada, error).
- **S4 — Solo Hyprland, con detección de capacidad.** User (elección): "Solo Hyprland (recomendado)".
  - Acceptance: el endpoint de computer control se habilita en Linux solo si el portal responde con soporte Screenshot (capacidad detectada); en otros escritorios el comportamiento es el actual (`endpoint: None`). La entrada (`post`, `post_typed`, `keyboard_refusal`) se rechaza con mensaje descriptivo — sin ydotool, sin uinput, sin inyección.
  - Checks: test de la detección (mock del portal sin Screenshot → endpoint None); `platform.rs` de Hyprland no se degrada.
- **S5 — Reusar la maquinaria de seguridad compartida (salvo overlay).** User: "vemos la implementación de lo q dijimos" (captura reusando permisos/stop ya existentes).
  - Acceptance: el backend Linux se enchufa por `start()` en `computer/app.rs` con el mismo `server`, `session`, `risk`, `rate` que macOS/Windows; los checks de permisos de `mcp.rs` y el recipient guard funcionan sin código nuevo. El overlay visual de "working" (rings) queda **fuera de alcance** en esta fase: Linux mantiene su comportamiento actual sin preparación (`NoPreparation`).
  - Checks: los tests existentes de `mcp.rs` sobre permisos y recipient guards pasan contra el backend Linux en `test` cfg (fake), sin modificaciones de semántica.

## Tasks

- **T1** (S1, S2): `computer/linux.rs` — cliente D-Bus mínimo del portal Screenshot + parseo de respuesta (URI → píxeles `Capture`). Parte pura testeable cross-platform. Commit propio.
- **T2** (S3): `permissions()` desde respuestas del portal + tests con las 4 respuestas. Commit propio.
- **T3** (S4, S5): enganche en `app.rs`/`mod.rs` tras detección de capacidad (solo Hyprland/portal con Screenshot); rechazo descriptivo de entrada. Commit propio.
- **T4** (S1): `docs/linux-testing.md` actualizado con la prueba manual de captura. Commit propio.
- **T9** (S2, S3, S4): verificación manual en Hyprland real: el Dot pide screenshot, el portal muestra su dialog, la captura llega al agente; revocar y verificar la negativa.

## Log

- **L1** (2026-11-07): User: "bien, como seguimos?? decime q se hizo en windows y macos como para complememtar nosotros con linex, sin tocar nada". Decisión de producto (2026-11-07, este turno): "¿Qué modo de captura implementamos primero?" → **"Screenshot puntual (recomendado)"**. "¿Para qué escritorio(s) apuntamos primero?" → **"Solo Hyprland (recomendado)"**.
- **L2** (2026-11-07): Contexto previo: feat/linux-distribution sincronizada a `origin/main` `9732fb3`; commit propio `6c0d84a` con fixes Clippy de `computer/`; decisión registrada en memoria (`linux/no-windows-touches`): no tocar archivos Windows hasta validar Windows nativo. `linux-cargo-check` queda rojo por Clippy preexistente de upstream en `daemon/windows*.rs` (aceptado); `package-linux.mjs` + `linux-check.mjs` verdes (Debian/Ubuntu/Arch).
- **L3** (2026-11-08): gentle-dot 0.1.0-1 instalado y corriendo en Hyprland con `GDK_BACKEND=x11`; Dot flotante y panel visibles; puerto 4317 libre (Neko del usuario en 4318, sin colisión).
- **L4** (2026-11-08): Ajuste de S5 tras el reporte de exploración (task mw7h7htw-1-o2p9): el overlay "working" está gated macOS/Windows en `app.rs:87-90`; en esta fase captura-only Linux mantiene `NoPreparation` y el overlay queda fuera de alcance. Datos del contrato: `Capture { data, mime_type, geometry }` (`mod.rs:189-195`), JPEG downscale a `MAX_LONG_EDGE`, geometría vía `for_display(origin, width_pt, ...)` (`coords.rs:53-56`), tamaño lógico del monitor desde `hyprctl monitors -j`; fallback Linux a partir de `app.rs:241-245`; `NativeDialogs` ya es neutral (`app.rs:613-641`); portal Screenshot necesita `dbus` promovido a dependencia real y feature `png` de `image`.
- **L5** (2026-11-08): T1–T3 implementados inline (test-first en las partes puras: RED observado 7/7 y 3/3, GREEN 13/13; suite completa 577/0). `computer/linux.rs` nuevo (portal D-Bus, pipeline PNG→JPEG, `LinuxDesktop` con rechazos de entrada); `app.rs` rama Linux de `start()` con server compartido sin overlay, `GRANT_TEXT` de captura en Linux, `computer_permissions` real, `computer_request_permission` noop; `platform.rs::is_hyprland_compositor()`; Cargo.toml `dbus` + feature `png`. Sin commits: regla del usuario (L6).
- **L6** (2026-11-08): User: "no hagas commit sin consultar". Los commits T1–T4 se proponen como unidades y esperan confirmación explícita.
- **L7** (2026-11-08): T4: sección "Testing screenshots (capture-only Linux backend)" agregada a `docs/linux-testing.md` (5 pasos: conceder, describir, rechazo de input, denegar y revocación, monitor enfocado). T9 pendiente: requiere instalar el build nuevo en Hyprland (decisión del usuario).
- L8 (2026-11-08): T9 verificada manualmente en Hyprland (user): grant del portal aparece, Allow concede por 30 min, el asistente recibe la captura. Fix GDK_SCALE (Omarchy) en fa2ac28; feat en d436124; docs en 5f7cf0f, sin push. Pendiente menor: el diálogo del portal a veces abre chico/cortado (override de systemd usuario aplicado en la máquina de Cinlo).
