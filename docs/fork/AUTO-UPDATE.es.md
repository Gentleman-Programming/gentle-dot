# Actualización de Gentle Dot QA

Implementada en `updates.rs` usando tauri-plugin-updater v2. El código necesita
validación nativa y una prueba A → B en macOS antes de considerarse listo para
producción. No hay aún una release firmada de este fork.

## Funcionamiento

Busca al iniciar, cada 24 horas y desde Buscar actualizaciones en el menú.
Consulta las últimas 100 releases del repositorio compilado en la app, descarta
borradores y estables, y considera únicamente tags `macos-qa-vX.Y.Z-N` marcados
como prerelease. Escoge una versión SemVer estrictamente posterior. Para esta
primera entrega el canal es QA; no se implementa actualización estable.

Lee `latest.json` de la release elegida, comprueba versión y origen del archivo,
y descarga mediante Tauri. Se exige firma válida y versión firmada
(`requireSignedVersion: true`), además de TLS. Una firma antigua sin versión
firmada se rechaza: usa una versión de Tauri CLI que incluya la versión en el
trusted comment. Nunca rebajes ese requisito para aceptar un paquete viejo.

Primero ofrece Descargar / Más tarde. Una vez verificado, ofrece Instalar y
reiniciar / Más tarde, avisando que cerrará tareas activas. Tras instalar, cancela
voz y control, detiene el daemon y reinicia. No escribe en conversaciones,
preferencias, llaveros ni memoria. No detecta automáticamente si una tarea tiene
trabajo sin guardar: el diálogo pide guardarlo antes de confirmar.

Solo el shell nativo tiene acceso a este flujo; no se otorgan permisos updater
al webview. Un proceso del agente no puede cambiar el repositorio ni la clave
mediante variables de entorno: se incorporan durante la compilación.

Errores de red automáticos se registran sin bloquear el chat. La búsqueda manual
muestra un error. Si no hay clave pública, no busca ni descarga actualizaciones
y el menú explica que esa compilación no está configurada.

## Configuración inicial del maintainer (en tu PC)

En un checkout con las dependencias instaladas:

```bash
pnpm --filter @gentle-dot/desktop exec tauri signer generate -w ~/.tauri/gentle-dot.key
```

Elige y conserva una contraseña. Guarda la clave privada fuera del repo y una
copia segura: perderla impide actualizar las instalaciones que confían en ella.

En Settings → Secrets and variables → Actions del repositorio correspondiente:

| Tipo | Nombre | Valor |
|---|---|---|
| Variable | GENTLE_DOT_UPDATE_PUBLIC_KEY | Contenido de gentle-dot.key.pub |
| Secret | TAURI_SIGNING_PRIVATE_KEY | Contenido de gentle-dot.key |
| Secret | TAURI_SIGNING_PRIVATE_KEY_PASSWORD | Contraseña de la clave |

No pegues valores privados en chats, issues, commits o logs. El conector no puede
configurar Secrets; esta preparación se hace desde el PC del propietario.
La firma updater no sustituye codesign ni notarización Apple.

CI fija GENTLE_DOT_UPDATE_REPOSITORY al repositorio de ejecución. El código usa
Gentleman-Programming/gentle-dot si se compila sin ese valor; el fork usa su propio
repositorio. Cada repositorio configura su clave por separado. Main no se cambia.

## Publicación

Incrementa `version` en tauri.conf.json, Cargo.toml, Cargo.lock y el package.json
del escritorio. Cada actualización necesita una versión X.Y.Z mayor; cambiar
solo N en el tag no provoca reinstalación de la misma versión.

Un tag `macos-qa-vX.Y.Z-N` construye los artefactos firmados. Sin clave privada o
pública falla. La rama y los PR no reciben claves privadas y generan solo el DMG.
La release queda en borrador con `.app.tar.gz`, `.sig`, `latest.json`, DMG,
BUILD-INFO, licencia y SHA256SUMS. Publica ese borrador como prerelease solo después
de revisar los checks y probar el DMG; desde entonces lo descubrirán las apps.
No requiere una rama/feed mutable ni usa releases/latest para QA.

## Validación pendiente en Mac real

Instalar A con la clave pública; publicar B firmada y comprobar A → B, datos
conservados y un solo daemon al reiniciar. Probar firma incorrecta, versión
firmada diferente, archivo truncado, downgrade, ausencia de red, Más tarde,
canal equivocado y tarea activa. El checksum no sustituye esta verificación.
No se promete rollback tras cualquier fallo del sistema de archivos: el manejo
de sustitución de la app depende del instalador nativo de Tauri.

Referencia: https://v2.tauri.app/plugin/updater/ .
