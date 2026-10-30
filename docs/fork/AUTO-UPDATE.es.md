# Actualización autónoma — requisito de esta entrega

Estado: pendiente de implementación y prueba end-to-end. El workflow macOS
actual genera el DMG verificado; todavía NO instala actualizaciones desde la app.
No anunciar autoactualización disponible hasta cerrar los criterios siguientes.

## Comportamiento requerido

- Consultar al iniciar y cada 24 horas sin bloquear el chat; botón Buscar
  actualizaciones para reintentar manualmente.
- Comparar SemVer de la app instalada con la publicación del canal seleccionado.
  Una compilación QA solo consulta QA; estable solo consulta estable.
- Mostrar versión, notas y acción Instalar y reiniciar / Más tarde.
- Descargar en segundo plano, validar firma criptográfica antes de instalar,
  rechazar versiones anteriores, firmas inválidas, truncados y arquitectura errónea.
- Detener captura y control del equipo; esperar o pedir confirmar el cierre de
  tareas activas; cerrar el daemon de forma ordenada antes de reiniciar.
- Conservar conversaciones, preferencias, autenticación y memoria. Fallos de red,
  proxy o verificación no deben inutilizar la instalación actual.

## Implementación indicada para el agente que continúe en el PC

Usar tauri-plugin-updater v2, mecanismo nativo de Tauri ya usado por el escritorio.
No ejecutar un instalador arbitrario sugerido por el agente ni desactivar TLS.
Referencia: https://v2.tauri.app/plugin/updater/ .

1. Añadir dependencia Rust y actualizar Cargo.lock. Registrar el plugin nativo;
   preferir comandos internos del shell y diálogos nativos, sin exponer a mensajes
   del modelo capacidades para cambiar endpoint, clave o aprobar instalación.
2. Generar una clave de firma del actualizador desde el PC del propietario.
   La clave privada y su contraseña van a Secrets de GitHub; solo la pública se
   integra en la app. No crear ni publicar claves privadas en el repositorio.
3. Separar canales con manifiestos de actualización QA/estable y URL HTTPS fija.
   QA requiere endpoint propio porque releases/latest no selecciona prereleases.
4. Activar createUpdaterArtifacts en el build Tauri. CI debe generar el archivo
   de actualización .app.tar.gz y su .sig, además del DMG. Una release actualizable
   debe fallar si falta la firma; no degradar a checksum como autenticación.
5. Publicar el manifiesto del canal solo después de comprobar los artefactos
   firmados y publicar su release. Enlazar versión, URL y firma exactas.
6. Añadir máquina de estados: checking, available, downloading, verifying,
   ready, installing, error; límites de tiempo y protección contra concurrencia.
7. Revisar la limpieza en shell.rs: el daemon se detiene en RunEvent::Exit.
   Confirmar que el camino de reinicio también realiza esa limpieza y cancela voz
   y control; no dar por hecho que restart ejecuta los mismos callbacks.

## Criterios de aceptación

Instalar versión A en un Mac real; publicar B con firma correcta y comprobar
A → B, conservación de datos y un solo daemon tras reiniciar. Repetir con
firma incorrecta, archivo incompleto, versión anterior, sin red, canal equivocado,
Más tarde y tarea activa. Ningún caso inválido debe reemplazar la aplicación.
La firma de actualización es independiente de codesign/notarización Apple.
