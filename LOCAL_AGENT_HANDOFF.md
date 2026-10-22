> **Historical handoff snapshot:** This Spanish document preserves the original delivery instructions and evidence as written; its branch/CI status and test counts are not the current checkpoint. For current status, limitations, and next work-unit boundaries, see [`docs/windows-native-independent.md`](docs/windows-native-independent.md) and [`odd/tasks/windows-native-independent.md`](odd/tasks/windows-native-independent.md). The active branch now includes published W1–W4; no PR, merge, release, or CI run has occurred.

# Traspaso: Gentle Dot nativo en Windows — implementación independiente

## Pedido de Maicol

Completar el soporte nativo de Gentle Dot en Windows con las funcionalidades actuales,
instalación, captura de pantalla, control de mouse/teclado, voz y CI real de Windows.
Partir de main con implementación propia y lo aprendido en ARISE. NO retomar, fusionar,
copiar ni cherry-pickear la PR #57. Mantener cambios en una rama aparte, sin pasar a main
ni publicar releases sin autorización. No presentar pruebas simuladas como validación nativa.

## Procedencia

- Repositorio: https://github.com/Gentleman-Programming/gentle-dot
- Base exacta: `8cb20ee888c88be2b359258a65499c20b59e2a86`.
- Rama local: `feat/windows-native-independent`.
- Cambios de runtime: `ca630ac`.
- Scripts de instalación/CI: `d3cfe22`.
- Este documento se añade después de esos commits; `DELIVERY.json` identifica el snapshot final.
- No hay rama remota creada por esta sesión: la integración de GitHub rechazó la escritura
  con 403 Resource not accessible by integration. Usar la autenticación local del usuario,
  sin pedirle que pegue tokens en el chat. No modificar permisos del repositorio.

## Lo que realmente está hecho

1. `packages/daemon/src/windows-runtime.ts`: búsqueda Windows de Engram .exe, variables
   case-insensitive, USERPROFILE/HOMEDRIVE/HOMEPATH, espacios, UNC, rechazo de rutas relativas,
   error explícito ante override inválido. Está conectado en runtime.ts e isolation.ts.
2. `scripts/windows/stage.ps1`: preparación de runtime Windows, Node/Engram con checksums,
   dependencias del daemon, UI y wrapper pi.cmd relocatable. NO ejecutado en Windows aún.
3. `scripts/windows/package.ps1` y `tauri.windows.conf.json`: configuración de NSIS por
   usuario y recursos de runtime. NO se ha construido ningún instalador Windows.
4. `runtime-integrity.mjs`: inventario SHA-256 y comparación del árbol instalado, exige
   archivos esenciales, rechaza links y comprueba cabecera MZ (NO validación completa PE).
5. `smoke-install.ps1`: prueba prevista de instalación, arranque hasta agentState=idle,
   integridad, reinstalación con la app cerrada, desinstalación y preservación de un canario.
6. `.github/workflows/windows-native.yml`: jobs obligatorios TypeScript/Rust en paralelo;
   el instalador depende de ambos y solo sube artefacto de QA después del smoke.
7. `docs/windows-native-independent.md`: decisiones y límites de esta primera entrega.

## Verificación realizada

En Linux, Node 24.19.0:

```powershell
node --test scripts/windows/test/*.test.mjs
```

Resultado: 13 pruebas pasadas, 0 omitidas. Casos Windows de rutas usan sondas de archivo
inyectadas; una prueba utiliza el filesystem del host a través del resolver real.
YAML parseado y dependencias entre jobs revisadas. `git diff --check` limpio.

NO ejecutados: PowerShell, instalación, Tauri/Rust, typecheck/Vitest completo, CI remoto,
interfaz Windows, voz, capturas o acciones reales. No afirmar que el ZIP se puede instalar.

## Primeros pasos del agente local

1. Lee este documento y `docs/windows-native-independent.md`. Inspecciona AGENTS.md si
   aparece en el entorno local. Revisa cambios del usuario antes de editar.
2. Prepara un checkout separado desde la base exacta; no mezcles con main ni con PR #57.
   El ZIP contiene `source/` y `independent-windows.patch` para reconstruirlo.
3. Verifica Windows x64, Node 24, pnpm 11.5.0 (packageManager del repo), Rust/MSVC,
   Visual Studio Build Tools con C++, Git, Go y WebView2. No eleves toda la aplicación.
4. Ejecuta las 13 pruebas y parsea los .ps1. Instala dependencias del repo con lockfile,
   ejecuta typecheck y Vitest y registra el primer error nativo. No ocultes errores
   con continue-on-error, skips generales o cambios de permisos globales.
5. Genera el icono Windows desde la identidad existente y compila Rust. Itera sobre
   errores reales antes de intentar construir un instalador.

## Bloqueos conocidos: resolver antes de declarar el port funcional

- `app_channel.rs` importa UnixStream sin alternativa Windows. Implementar un transporte
  autenticado que solo acepte el proceso hijo propio; no usar un puerto sin autenticación
  ni un archivo compartido para sustituir el canal de secretos.
- `daemon.rs` usa std::os::unix, permisos/fds/señales Unix y paths node/bin/node. Portar
  lanzamiento, identidad de proceso, cierre acotado y runtime Windows; no usar stubs que
  devuelvan éxito. Controlar el árbol propio (p.ej. Job Object) y no matar por nombre.
- La plataforma todavía clasifica lo no-macOS como Linux. Portar selección de plataforma,
  rutas de datos, bandeja, atajos y almacén de secretos Windows sin regresiones Unix.
- El helper nativo de computer control solo inicia en macOS. Implementar backend Windows
  detrás del contrato Desktop y de las comprobaciones existentes: captura nativa,
  coordenadas/DPI, input, ventanas, UI Automation, bloqueos, confirmaciones y overlay.
- Voz Windows no está implementada. Separar errores de dispositivo, transcripción y TTS.
- Revisar build.rs y resolución de herramientas .exe/.cmd: es otra superficie Unix.

## Revisión obligatoria de los scripts nuevos antes de usarlos

Son una primera implementación NO validada en Windows. Verificar sintaxis/quoting y
comportamiento real en PowerShell 5.1 y pwsh, NSIS /D con espacios, salida/timeout del
instalador, rutas de recursos Tauri y hook de inicio del daemon. `stage.ps1` rehúsa un
staging existente: limpiar solo build/windows/runtime generado, nunca carpetas del usuario.
`package.ps1` puede tardar mucho; preservar logs por etapa sin secretos.

Node se fija en 24.14.1 y Engram en 3.4.0; antes de entrega final revisar compatibilidad
con el lockfile actual. Las dependencias directas del runtime se obtienen del lockfile,
pero npm resuelve transitivas al preparar el runtime: falta fijarlas con lockfile de runtime.
No confiar en que un archivo exista o tenga MZ: ejecutar las sondas de versión, verificar
proveniencia/integridad de Gentle AI y probar el motor real con el entorno de usuario normal.

El smoke actual termina el árbol de la app a la fuerza como limpieza de CI: esto NO prueba
cierre ordenado, actualización con la app abierta ni la parada de emergencia. Completar esas
pruebas por separado. El canario prueba preservación de un archivo, no migraciones de chats.
Comprobar que no quedan procesos/servidores propios, también en errores. No cerrar procesos ajenos.
La consulta /health prueba readiness del motor, no una conversación con modelo ni las capacidades
visuales. Los tests de fixtures NO necesitan claves; la prueba de proveedor real requiere una
cuenta configurada por el usuario sin exponer sus credenciales en logs.

## Criterios de entrega

- Instalar en Windows limpio como usuario normal; binarios, dependencias y WebView2
  disponibles o un diagnóstico accionable. No depender del pnpm global del desarrollador.
- Abrir desde Explorer sin HOME; instalador y app usan la misma carpeta de datos/runtime.
- Chat real y sesiones conservadas; dos mensajes, cambio/retorno de chat, subagente y DOCX real.
- Captura en monitores con orígenes negativos y DPI 100/125/150/200%; clic verificado por
  una captura independiente, teclado Unicode, scroll, ventanas y campos protegidos.
- Parada accesible y atajo nativo comprobado; cancela colas y observación, libera teclas/botones,
  invalida autorizaciones antiguas y no reanuda automáticamente.
- Micrófono y salida reales, transcripción sin fragmentar pausas naturales, voz seleccionada
  sin sustituciones silenciosas. No anunciar disponible un backend que no arrancó.
- Upgrade con app abierta cierra solo su árbol y conserva historial/configuración/secretos;
  reinstalar, desinstalar y volver a instalar; no mezclar datos de otros programas.
- CI Windows real verde para el mismo commit del instalador. Sin publicación automática.
- Reporte final: implementado, comprobado, limitaciones y pendientes; nunca «todo perfecto»
  a partir de una compilación o pruebas unitarias.

## Reconstruir rama conservando historial (PowerShell)

Desde la carpeta raíz descomprimida, con Git disponible:

```powershell
git clone https://github.com/Gentleman-Programming/gentle-dot.git gentle-dot-local
if ($LASTEXITCODE -ne 0) { throw 'Clone failed' }
Set-Location gentle-dot-local
git switch -c feat/windows-native-independent 8cb20ee888c88be2b359258a65499c20b59e2a86
if ($LASTEXITCODE -ne 0) { throw 'Branch creation failed' }
git apply --check ..\independent-windows.patch
if ($LASTEXITCODE -ne 0) { throw 'Patch check failed' }
git apply ..\independent-windows.patch
if ($LASTEXITCODE -ne 0) { throw 'Patch application failed' }
node --test scripts/windows/test/*.test.mjs
```

La alternativa sin descarga es trabajar directamente en `source/`: contiene el snapshot
completo pero no .git. Inicializar Git allí crea un historial nuevo; preferir clone + patch
si se va a enviar una PR. No sobrescribir un checkout que ya tenga cambios locales.
