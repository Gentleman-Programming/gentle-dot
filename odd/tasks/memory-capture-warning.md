# Warning en el canal del usuario: captura de memoria sobre una sesión cerrada

**Estado**: en cola (diagnosticado, sin arreglar).
**Síntoma**: el usuario recibe por Telegram y WhatsApp, cada ~30-60 s, el mensaje:

```
⚠️ [memory] background capture to /sessions failed: assistant session is closing
```

Se repite en tandas, una por cada operación que hace el asistente (cada salida de herramienta
dispara un intento de captura).

## Causa raíz

1. La sesión del engine se **finalizó** con `mem_session_finalize` en medio del trabajo (se usó
   como si fuera "guardar y cerrar", cuando cierra el registro de forma definitiva).
2. El proveedor de memoria sigue agendando capturas en segundo plano para esa sesión. Al
   encontrarla cerrada, la captura falla con `assistant session is closing`.
3. Ese fallo se emite como **aviso visible** y el daemon lo reenvía al canal del usuario, porque
   hoy cualquier evento de UI del engine viaja al conector de origen.
4. No se puede reabrir: `mem_session_start` responde `session has already ended`.

## Arreglos propuestos (en orden de valor)

1. **El proveedor no debe avisar por esto**: una captura sobre una sesión terminada es esperable
   (el usuario cerró, o la sesión se compactó). Debe descartarla en silencio, o marcarla como
   `skipped` sin emitir aviso al usuario.
2. **Deduplicar y limitar**: si un aviso de memoria se repite, emitirlo una vez por sesión y
   después callar. Hoy se emite uno por intento.
3. **El daemon no debería reenviar bookkeeping interno al canal del usuario**: los eventos de tipo
   `notify` con origen en el subsistema de memoria no son información del asistente; corresponde
   filtrarlos o mandarlos al canal de la app, no a Telegram/WhatsApp.
4. **Ciclo de vida**: al finalizar una sesión, el proveedor debe **cancelar** las capturas
   pendientes y no agendar nuevas.
5. **Documentación del contrato**: dejar explícito que `mem_session_finalize` es para el cierre
   real del proceso, y que para "guardar" se usa `mem_session_summary`.

## Mitigación inmediata (sin código)

- Abrir una conversación nueva (engine nuevo, sesión nueva): el loop muere con la vieja.
- No llamar `mem_session_finalize` en medio de una sesión; usar `mem_session_summary`.
