# Gentle Dot — Windows port: anuncio para Discord y datos de la PR

Material de trabajo para pedir ayuda en el canal de Gentle Dot. El mensaje va en **español neutro**; los issues y el repositorio, en **inglés** (convención del proyecto).

---

## 1. Mensaje para pegar en Discord

> Hola 👋 Estamos avanzando con el port nativo de Gentle Dot a Windows 10/11 en la PR #57 y ya hay bastante para mostrar, así que vengo a pedir una mano.
>
> **Listo** (en la rama, verde en `windows-latest`): la capa de plataforma (panel, tray, atajo `Ctrl+Shift+Space`), el daemon corriendo nativo, el almacén seguro con DPAPI, el staging del runtime y el instalador autocontenido (NSIS 75.6 MB / MSI 120.1 MB con el runtime incluido), el canal privado app↔daemon como named pipe con verificación de PID, el árbol de procesos por Job Object, la memoria privada como ajuste y el bloqueo de carpeta de datos del daemon.
>
> **En progreso:** nada abierto en este momento.
>
> **Pendiente, y es lo más grande:** voz en Windows (WASAPI + Parakeet) y control de computadora (UI Automation, `SendInput`, Windows Graphics Capture). Son los dos backends que hoy solo existen para macOS; la interfaz ya está definida, falta escribir el backend.
>
> **Todavía sin medir:** instalar el MSI, ejecutar una copia instalada de la app, correr `cargo test` del lado Linux en la punta de la rama, y ver el `EPERM` real de symlink sin Developer Mode.
>
> **Ya hay issues abiertos para reclamar una tarea:** #85 voz · #86 control de computadora · #87 herencia de handles en Windows · #88 las cuatro verificaciones pendientes (estas no llevan código, son de horas).
>
> **Cómo ayudar sin pisarnos:** elige UNA fila del tablero (`odd/tasks/windows-port.md`), avisa en el issue cuál antes de empezar, y trabaja en una rama nueva desde la punta de `feat/windows-port` — no sobre una tuya antigua. Lo que gane entra como unidad revisable y con crédito en el commit. No toquemos el canal app↔daemon (W7) ni el ciclo de vida del daemon: ahí vive la credencial.
>
> Estos días estoy con la universidad, así que voy a estar mirando poco, pero la revisión se hace igual. ¡Gracias! 🙌

### Versión corta (si el canal está ruidoso)

> Hola 👋 El port nativo de Gentle Dot a Windows ya está avanzado en la PR #57: plataforma, daemon, almacén seguro, instalador autocontenido, canal app↔daemon y memoria privada funcionando, con la suite verde en `windows-latest`. Falta voz (WASAPI + Parakeet) y control de computadora (UI Automation, `SendInput`, WGC) — los dos backends que hoy solo existen para macOS — más cuatro verificaciones sin medir (instalar el MSI, ejecutar una copia instalada, `cargo test` en Linux, `EPERM` de symlink).
>
> Issues para reclamar: #85 · #86 · #87 · #88 (los cuatro de #88 no llevan código, son de horas). Elige una fila de `odd/tasks/windows-port.md`, avisa en el issue y trabaja en una rama nueva desde la punta de `feat/windows-port`. No toquemos el canal app↔daemon (W7) ni el ciclo de vida. Estoy con la universidad estos días, así que voy a estar mirando poco. ¡Gracias! 🙌

---

## 2. Datos para responder preguntas en el canal

### La PR

| Dato | Valor |
| :--- | :--- |
| PR | [#57 — feat(desktop): native Windows 10+ port, staged slices](https://github.com/Gentleman-Programming/gentle-dot/pull/57) |
| Repo / fork | `Gentleman-Programming/gentle-dot` · head `Row0902/gentle-dot:feat/windows-port` |
| Punta actual | `5f8806e` (sólo agrega la fila W29 al plan sobre `3514671`) |
| Tamaño | ~91 archivos, +7.6k / −550 contra `main`, 144 commits |
| Plan y bitácora | `odd/tasks/windows-port.md` (specs SW1–SW11, filas W1–W29, Log L1–L77) |
| Checklist de pruebas | `docs/windows-testing.md` |
| Instalación y requisitos | `docs/install.md` |
| Diseño | `docs/design.md` (S24, S25, S28, S35) |

### Estado real de la suite (punta `3514671`, runs `39151219356` y `39151682250`)

- `pnpm test` en `windows-latest`: **Test Files 89 passed | 6 skipped (95)**, **Tests 892 passed | 42 skipped (934)**, 0 fallos.
- `cargo test` en `windows-latest`: **407 passed; 0 failed; 4 ignored**.
- Los 6 archivos y 42 tests que se omiten son sujetos que Windows no tiene (fd 3 heredado, `setuid`/`setegid` de modo servidor) más fixtures de directorio no escribible, y **cada omisión se anuncia en stderr** con una línea propia.

### Requisitos para levantar el proyecto en Windows

- Windows 10 22H2+ o Windows 11, sobre NTFS (nada de WSL para compilar).
- Node 24, pnpm 11, Rust estable con toolchain `x86_64-pc-windows-msvc`, Visual Studio Build Tools, y **Go ≥ 1.25.10** (el postinstall de `gentle-pi` compila `gentle-ai.exe` desde la fuente en Windows).
- 7-Zip, sólo para `pnpm package:windows --check` (extrae ambos payloads para compararlos; tarda ~26 min).
- Developer Mode si vas a correr los tests que crean symlinks de archivo.

### Comandos

```bash
pnpm install
pnpm typecheck
pnpm test                                   # vitest, suites de daemon/UI/protocolo
cd apps/desktop/src-tauri && cargo test --lib   # suite Rust del shell
pnpm package:windows --check                # instalador + comparación de payloads (necesita 7-Zip)
```

### Cómo se trabaja una fila (la regla, para que nadie se pise)

1. Elige **una fila entera** de `odd/tasks/windows-port.md` (no media fila, no dos).
2. Reclámala en su issue comentando que la tomas.
3. Rama **nueva** creada desde la punta de `feat/windows-port`; **nunca** merge o rebase sobre una rama vieja — se pierde lo que ya está hecho y se mezcla todo con 144 commits ajenos.
4. PR contra `feat/windows-port`, con tests y docs junto al cambio, y mensaje de commit convencional.
5. Cada fila lleva su síntoma medido y el comando que lo verifica: si no podés medirlo en tu máquina, decilo como `blocked: needs Windows` en lugar de reportarlo como pasado.

### Qué no tocar (para no romper la seguridad del proyecto)

- **W7, el canal app↔daemon**: la credencial del canal (PID contra el hijo retenido) vive ahí y tiene sus propios tests.
- **El ciclo de vida del daemon**: Job Object, `stop_child`, `process_started`/`stop_orphan`, claim de carpeta.
- **El almacén seguro** (`secure_store`): es donde viven los secretos de los conectores.

### Trampas conocidas (ya documentadas, para ahorrar tiempo)

- **CRLF en un checkout existente:** si cambias de rama en un clon viejo de Windows, los archivos idénticos a `main` conservan CRLF y aparecen ~178 errores de biome. Se arregla renormando los archivos versionados (equivalente a `git add --renormalize`) y verificando que `git diff --stat` quede vacío. Un clon nuevo ya está sano por `.gitattributes`.
- **`HOME` no existe en Windows:** el app resuelve `USERPROFILE`; si lanzas desde un shell MSYS/Git Bash, `HOME` existe y oculta el problema. Prueba desde Explorer para ver el camino real.
- **Variables de Engram de gentle-shell:** si lanzas el app desde una sesión de gentle-shell, `ENGRAM_BIN`, `ENGRAM_URL` y `ENGRAM_STARTUP_POLICY` se filtran y el guard rechaza la memoria — parece un defecto del producto y no lo es.
- **`/mnt/d` (9p/drvfs) en WSL:** reporta modo `777` para todo archivo y hace fallar la única aserción de modo POSIX. Usa un filesystem nativo para el lado Linux.
- **Un mount no es un test roto:** ante una duda así, primero reproduce; el proyecto documenta cada omisión en lugar de esconderla.

### Issues abiertos para esta convocatoria

| Issue | Qué es | Dificultad |
| :--- | :--- | :--- |
| [#85](https://github.com/Gentleman-Programming/gentle-dot/issues/85) | W12 — backend de captura WASAPI y camino de Parakeet en Windows | días, API de audio |
| [#86](https://github.com/Gentleman-Programming/gentle-dot/issues/86) | W13 — control de computadora (UI Automation, `SendInput`, WGC, `WindowFromPoint`, DPI) | días, la más grande |
| [#87](https://github.com/Gentleman-Programming/gentle-dot/issues/87) | W29 — medir y restringir qué handles hereda el daemon en Windows | horas/día, requiere Windows |
| [#88](https://github.com/Gentleman-Programming/gentle-dot/issues/88) | Cuatro verificaciones nunca observadas: MSI, copia instalada, `cargo test` en Linux, `EPERM` real | horas, **sin código** |

---

## 3. Qué contestar si preguntan

- **"¿Ya funciona en Windows?"** Sí, la app corre nativa: panel, tray, atajo, chat, conectores con secretos guardados por DPAPI y aprobaciones nativas. Lo que no existe todavía es voz y control de computadora, y las dos se rechazan de forma limpia en lugar de fallar.
- **"¿Puedo instalarlo?"** Sí: `pnpm package:windows`, o `pnpm build`. Ninguno de los dos instaladores está firmado, así que SmartScreen va a advertir.
- **"¿Por qué no lo mergean?"** Porque la revisión de un diff de ~91 archivos es trabajo real y el objetivo es una versión que funcione completa, no una rama que se pudra. La convocatoria es justamente para que las filas que faltan puedan avanzar en paralelo.
- **"¿Puedo tomar dos filas?"** Una a la vez, y avisando. Dos filas simultáneas en 91 archivos se pisan en los mismos archivos.
- **"¿Dónde pregunto?"** En el issue de la fila, no por DM: las respuestas quedan buscables y sirven al siguiente.
