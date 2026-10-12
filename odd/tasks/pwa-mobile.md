# PWA móvil v1 para gentle-dot

Cliente PWA del daemon gentle-dot usable a diario desde el teléfono: layout responsive, instalable, token persistente, gestión de conectores y perfiles de modelo desde el móvil.

## Specs

- **S1** (conectores): "conectar los mcps" — gestionar conectores desde el móvil. El daemon ya soporta `ConnectorDraft`/`ConnectorInfo` y PIN web; la UI existente de settings debe funcionar en viewport de teléfono.
- **S2** (modelos): "keys de modelos" — gestionar perfiles de modelo desde el móvil (chip sobre el input + settings). El protocolo ya trae `ModelGroup`/`ModelRef`/`RoleRoute`.
- **S3** (sesión compartida): "poder compartir sesion con la de escritorio" — la conversación es una sola en el daemon; debe seguir funcionando móvil + escritorio simultáneamente.
- **S4** (alcance elegido por el usuario, opción "Completa"): "Todo lo anterior + gestionar conectores y perfiles de modelo desde el móvil (el protocolo ya lo soporta)" — incluye layout responsive, manifest PWA instalable, persistencia del token, pulido táctil (teclado virtual, scroll del chat, inputs) y manejo de reconexión en móvil.
- **S5** (destino, opción "Fork propio"): fork `jaguilargrupointec/gentle-dot`, rama `feature/pwa-mobile`, `upstream` = `Gentleman-Programming/gentle-dot`.

## Tasks

- **T1** [S4] Layout responsive: chat a pantalla completa en viewport móvil (`packages/ui/src/styles.css`, `App.tsx`). Commit: `feat(ui): responsive mobile layout`
- **T2** [S4] Persistencia del token en `localStorage` además de `sessionStorage` (`packages/ui/src/client.ts` `tokenFromLocation`). Commit: `feat(ui): persistent token`
- **T3** [S4] PWA instalable: manifest + iconos + service worker (`vite-plugin-pwa`). Commit: `feat(ui): installable PWA`
- **T4** [S4] Pulido táctil: teclado virtual, scroll del chat, áreas de toque. Commit: `feat(ui): mobile touch polish`
- **T5** [S4] Reconexión en móvil visible y estable (backoff existente + estado en UI). Commit: `feat(ui): mobile reconnection UX`
- **T6** [S1,S4] Gestión de conectores usable en móvil: verificar flujo completo y corregir responsive de settings. Commit: `feat(ui): connectors on mobile`
- **T7** [S2,S4] Gestión de perfiles de modelo usable en móvil: verificar y corregir responsive. Commit: `feat(ui): model profiles on mobile`
- **T8** [S3] Verificación E2E: móvil y escritorio conectados al mismo daemon ven la misma conversación. Sin commit (verificación).

## Log

- **L1** (pedido original, verbatim): "que opinas quiero realizar la app de gentle dot: https://github.com/Gentleman-Programming/gentle-dot  en un app nativa, por ahora con la funcionalidad de conectar los mcps, las keys de modelos y poder compartir sesion con la de escritorio utilizando expo con react native o dame sugerencias y dime si es posible y si es muy complejo"
- **L2**: Evaluación: la ruta natural es PWA (la web ya es cliente de primera clase del daemon); Expo queda para después. Usuario: "ya arranquemos".
- **L3**: Paso 0 validado: chat, streaming y selector de modelo funcionan desde el teléfono vía WS (fue necesario `GENTLE_DOT_HOST=0.0.0.0` y `GENTLE_DOT_ALLOWED_ORIGINS='["http://192.168.1.8:4317"]'`). Usuario: "ahora si ya funciona".
- **L4**: Decisiones de alcance: v1 "Completa" y "Fork propio". Nodo del entorno: modelo actual no soporta imágenes (OCR vía tesseract.js como fallback).
