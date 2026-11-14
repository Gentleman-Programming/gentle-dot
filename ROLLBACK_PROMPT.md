# 🔄 PROMPT DE ROLLBACK - Volver al Inicio Antes de la Reestructuración

---

## 🚨 SITUACIÓN ACTUAL

El agente ha hecho **cambios destructivos** en la rama `restructure/single-daemon`:

- **30+ archivos borrados** de `packages/daemon/src/` (auth, bridge, config, connectors, supervisor, voice, whatsapp-bridge, etc.)
- **Archivos modificados** sin control
- **Tests modificados** sin control

---

## 🎯 OBJETIVO: VOLVER AL ESTADO INICIAL (commit base antes de reestructuración)

---

## 🔧 COMANDOS DE ROLLBACK EXACTOS

```bash
cd /run/media/bladimir/Datos/Datos/proyectos/work/gentleman/gentle-dot

# 1. Ver el historial para encontrar el commit base ANTES de la reestructuración
git log --oneline -20

# 2. OPCIÓN A: Reset hard al commit base (RECOMENDADO)
# Buscar el commit ANTES de empezar la reestructuración
# Suponiendo que el commit base es el que está en main/origin antes del branch:
git checkout main
git pull origin main
git branch -D restructure/single-daemon
git checkout -b restructure/single-daemon

# 3. OPCIÓN B: Si quieres mantener el branch y hacer reset hard al commit padre:
# git log --oneline | head -30  # Buscar el commit "chore: ..." o "feat: ..." ANTES de los cambios destructivos
# git reset --hard <commit-hash-base>
# git clean -fd  # Limpiar archivos untracked

# 4. VERIFICAR estado limpio
git status
# Debe mostrar: "nothing to commit, working tree clean"
```

---

## ✅ VERIFICACIÓN POST-ROLLBACK

Después del rollback, verificar que EXISTEN estos archivos clave:

```bash
# Daemon core files (DEBEN EXISTIR)
ls -la packages/daemon/src/
# Debe mostrar: cli.ts, ws-server.ts, connector-registry.ts, config-loader.ts, daemon.ts, 
#               gentle-shell-spawner.ts, mcp-proxy.ts, app-channel.ts, ws-server.ts, 
#               config-loader.ts, connector-registry.ts, cli.ts, index.ts

# Extensions (DEBEN EXISTIR - solo 2 archivos internos)
ls -la packages/daemon/src/extensions/
# Debe mostrar: approval-guard.ts, screenshot-context.ts

# Bridges base
ls -la packages/bridges/base/src/
# Debe mostrar: base-bridge.ts, index.ts

# Config
cat packages/daemon/connectors.yaml

# Tests
ls packages/daemon/test/
# Debe mostrar: auth.test.ts, gateway.test.ts, lifecycle.test.ts

# Package.json y config
cat packages/daemon/package.json
cat packages/daemon/tsconfig.json
```

---

## 📋 CHECKLIST POST-ROLLBACK

- [ ] `git status` → `nothing to commit, working tree clean`
- [ ] `packages/daemon/src/` tiene todos los archivos originales (30+ archivos)
- [ ] `packages/daemon/src/extensions/` tiene `approval-guard.ts` y `screenshot-context.ts`
- [ ] `packages/bridges/base/src/base-bridge.ts` existe
- [ ] `packages/daemon/connectors.yaml` existe y válido
- [ ] `pnpm --filter daemon build` compila sin errores
- [ ] `pnpm --filter daemon test` pasa tests básicos

---

## 🚀 DESPUÉS DEL ROLLBACK: EMPEZAR DESDE CERO

Una vez verificado el rollback, **leer en orden**:

1. `AGENT_PROMPT_INICIAL.md` - Prompt principal
2. `02-FASE-1-DAEMON-PRINCIPAL.md` - Crear daemon (ya tiene base, solo completar)
3. `03-FASE-2-CONECTORES.md` - Integrar dot-* repos como bridges
4. `04-FASE-3-INTEGRACION.md` - MCP Proxy + App Channel
5. `05-FASE-4-TESTING.md` - Testing + Migración

**NO BORRAR NADA. SOLO AGREGAR Y ADAPTAR.**

---

## 📍 UBICACIÓN CORRECTA

```bash
cd /run/media/bladimir/Datos/Datos/proyectos/work/gentleman/gentle-dot
# Trabajar SIEMPRE desde aquí (fork root)
```

---

## ⚠️ REGLA DE ORO

> **NUNCA MÁS BORRAR ARCHIVOS EXISTENTES.**
> Solo: AGREGAR, MOVER, ADAPTAR, EXTENDER.

---

**EJECUTA EL ROLLBACK AHORA Y CONFIRMA CON "ROLLBACK COMPLETADO" ANTES DE CONTINUAR.**