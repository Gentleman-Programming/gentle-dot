# Gentle Dot para macOS — fork de Maicololiveras

Esta rama `ci/macos-distribution` añade CI y distribución de QA al empaquetador
oficial de Gentle Dot. No es una versión oficial de Gentleman Programming.
Conserva su licencia e identidad; no modifica `main` ni publica paquetes npm.

## Para instalar (cuando exista un build exitoso)

Requiere Apple Silicon (M1 o posterior) y macOS 12.3 o posterior según upstream.
Intel no está soportado por el empaquetador actual. CI comprueba macOS 15 ARM64;
no demuestra compatibilidad real con cada versión antigua de macOS.

1. En GitHub → Actions → **macOS QA installer**, abre una ejecución exitosa.
2. Descarga el artefacto `gentle-dot-macos-arm64-<commit>` y extrae el ZIP.
   GitHub requiere iniciar sesión para descargar artefactos. Caducan a los 14 días.
3. Desde esa carpeta, ejecuta `shasum -a 256 -c SHA256SUMS`.
4. Abre el `.dmg`, arrastra Gentle Dot a Aplicaciones y expulsa el disco.
5. En macOS 15+, si se bloquea la primera apertura, usa Ajustes del Sistema →
   Privacidad y seguridad → Abrir igualmente, solo para tu compilación verificada.
   En macOS 12–14: Control-clic en la app → Abrir.
6. Completa el inicio de sesión del proveedor en la aplicación. No pegues tokens
   en issues, logs, este repo ni en un instalador.
7. En Connectors → Computer concede Accesibilidad y Grabación de pantalla
   únicamente si quieres control del equipo. Reinicia la app tras conceder pantalla.

La app incluye Node, motor y Engram. La instalación inicial de componentes puede
necesitar Internet. La firma es ad hoc y no hay notarización de Apple: actualizar
puede obligar a volver a conceder permisos. No desactives Gatekeeper globalmente.
Datos: `~/.gentle-dot`; memorias compartidas: `~/.engram`. No borrar esta última
carpeta al desinstalar si otras aplicaciones también usan Engram.

## Continuar desde tu PC

Si aún no existe el fork, créalo en GitHub usando Fork en
https://github.com/Gentleman-Programming/gentle-dot . Propietario: Maicololiveras;
nombre: gentle-dot. Habilita Actions en el fork si GitHub lo solicita.

Cuando la rama esté subida:

```bash
git clone https://github.com/Maicololiveras/gentle-dot.git
cd gentle-dot
git switch ci/macos-distribution
git remote add upstream https://github.com/Gentleman-Programming/gentle-dot.git
```

El push a esta rama ejecuta la compilación sin tocar main. Puedes seguir el run
con GitHub Actions desde Windows: no necesitas un Mac local para generar el DMG.
El primer workflow_dispatch solo aparece en la UI si el workflow existe en la
rama por defecto; mientras se mantiene aislado, usa push o vuelve a ejecutar un run.

## Actualización desde la app

El requisito de comprobación automática y actualización validada está en
[AUTO-UPDATE.es.md](AUTO-UPDATE.es.md). El código ya está integrado; requiere configurar las claves de firma y
validar A → B en un Mac real antes de distribuirlo como autoactualizable.

## CI y publicación

- Node 24, pnpm fijado por package.json, Rust 1.96.1; runner macOS 15 ARM64.
- Instalación con lockfile congelado, lint, TypeScript, pruebas de empaquetado,
  cargo check/test y `pnpm package:mac --check`.
- El empaquetador verifica firma, archivos y modos del runtime, monta el DMG,
  copia la app y prueba su daemon con HOME limpio y runtime de solo lectura.
  No prueba permisos TCC, dictado físico, GUI ni credenciales de usuario.
- Se conservan DMG, licencia, manifiesto de build y SHA256SUMS.
- PR y builds normales tienen contents:read; solo el job de release tiene
  contents:write. No hay pull_request_target. Los secretos de firma se entregan solo al paso
  de empaquetado de tags; no a builds de PR.
- Node 24 resuelve un parche y Engram se resuelve según upstream al compilar;
  BUILD-INFO registra el runtime efectivo. No se promete reproducción byte a byte.

Para preparar un borrador de release desde un commit revisado de esta rama:

```bash
git switch ci/macos-distribution
git pull --ff-only
# Ejemplo para app 0.1.0: usa un sufijo nuevo en cada intento.
git tag -a macos-qa-v0.1.0-1 -m "macOS QA 0.1.0 build 1"
git push origin macos-qa-v0.1.0-1
```

El fork y el repositorio oficial pueden crear el borrador, y solo después de todas
las comprobaciones. No sobreescribe una release existente ni publica en latest.
Revisa el instalador en un Mac real antes de publicar el borrador como prerelease.
Si falla antes de crear la release, vuelve a ejecutar los jobs fallidos; si ya
existe, revisa ese borrador o usa un tag nuevo, no borres/reutilices tags publicados.

## Build local en Mac

Con Node 24, pnpm 11.5.0, Rust 1.96.1 y Xcode Command Line Tools instalados:

```bash
pnpm install --frozen-lockfile
pnpm package:mac --check
node scripts/package/collect-macos-qa.mjs
```

Salida: `dist/macos-qa`. Si repites la recolección, mueve la salida anterior:
se rechazan carpetas no vacías para no mezclar instaladores.

## Resolver fallos

- Arquitectura incorrecta: usa un runner ARM64, no macOS Intel.
- Proxy o certificados: revisa qué host falla (GitHub assets, npm, Node, Rust).
  Configura la CA/proxy corporativo por los mecanismos oficiales; no deshabilites TLS.
- Lockfile: actualízalo junto a dependencias en una rama revisada; CI nunca instala
  con --no-frozen-lockfile para ocultar discrepancias.
- Rust o tests: conserva el error del job; no suprimas comprobaciones para publicar.
- La prueba del daemon no valida tu login: inicia sesión desde la app ya instalada.

## Fuentes y mantenimiento

Basado en Gentle Dot `4c002060fa66554114b89a119c7669f7b8de35c6`:
[instalación](https://github.com/Gentleman-Programming/gentle-dot/blob/4c002060fa66554114b89a119c7669f7b8de35c6/docs/install.md),
`package-mac.mjs`, `stage-runtime.mjs` y sus pruebas.
Se adopta de [Gentle Shell publish.yml](https://github.com/Gentleman-Programming/gentle-shell/blob/main/.github/workflows/publish.yml)
la separación build → verificación → artefactos → publicación, acciones fijadas
por SHA y permisos mínimos. No se copia su publicación npm porque este producto
se distribuye como aplicación de escritorio.

Para incorporar upstream: fetch upstream, merge upstream/main en una rama de
trabajo y pasar nuevamente CI. No fuerces main ni sobrescribas la rama de QA.
