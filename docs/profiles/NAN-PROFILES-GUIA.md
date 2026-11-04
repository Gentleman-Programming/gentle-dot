# 🧠 Perfiles NaN — Guía de Instalación y Configuración

> **Fuente:** suscripción NaN con los modelos GLM 5.3, DeepSeek V4 Flash, GLM 5.3 Flash,
> Qwen 3.8 Flash, MiMo V2.6 Flash, Gemma 4 y Qwen 3.6.
> **Formato:** store nativo del engine (`gentle-pi.agent_model_profiles` v1) — el mismo
> formato que `profiles.json` de Gentle Shell y el que el daemon de Gentle Dot
> importa, aplica y visualiza.

---

## 1. Los 3 perfiles y su diseño

### ⭐ `nan-full-power` — Perfil recomendado como **ORQUESTADOR**

Diseñado para el trabajo ODD completo: planificar fuerte, ejecutar rápido, verificar barato.

| Rol | Modelo | Thinking | Por qué |
|---|---|---|---|
| **orchestrator** (Asistente principal) | `nan/glm-5.3` | high | El flagship razona mejor: fases ODD (autorizar→explorar→clasificar→implementar), delegación, decisiones de producto. |
| gentle-ai-explore (Investigador) | `nan/glm-5.3-flash` | low | Exploración read-only masiva: velocidad > profundidad. |
| gentle-ai-worker (Constructor) | `nan/deepseek-v4-flash` | medium | DeepSeek es fuerte en código; el worker escribe la mayoría de diff. |
| gentle-ai-verify (Verificador) | `nan/qwen-3.8-flash` | low | Corre tests/builds y reporta veredicto: barato y suficiente. |
| review-refuter (RDD: desafiante) | `nan/deepseek-v4-flash` | high | El refuter busca agujeros en el diff: necesita rigor y familia distinta al validator. |
| review-validator (RDD: validador) | `nan/glm-5.3` | high | Cierra la revisión RDD: el modelo más capaz confirma. |
| jd-judge-a | `nan/deepseek-v4-flash` | medium | Judgment Day: familia distinta a judge-b para sesgo cruzado. |
| jd-judge-b | `nan/qwen-3.8-flash` | medium | Segunda opinión con familia distinta. |
| jd-fix-agent | `nan/glm-5.3-flash` | medium | Correcciones acotadas post-judgment. |

### 🔒 `nan-review-hard` — RDD reforzado (código sensible)

El trabajo se escribe con el modelo más capaz y la revisión es la más dura.
Úsalo para: seguridad, credenciales, migraciones, integraciones de pago.

| Rol | Modelo | Thinking |
|---|---|---|
| orchestrator | `nan/glm-5.3` | medium |
| gentle-ai-explore | `nan/qwen-3.8-flash` | low |
| gentle-ai-worker | `nan/glm-5.3` | medium |
| gentle-ai-verify | `nan/qwen-3.8-flash` | low |
| review-refuter | `nan/glm-5.3` | **high** |
| review-validator | `nan/deepseek-v4-flash` | **high** |
| jd-judge-a | `nan/mimo-v2.6-flash` | medium |
| jd-judge-b | `nan/gemma-4` | medium |
| jd-fix-agent | `nan/qwen-3.6` | medium |

Los jueces usan 3 familias distintas (Zhipu/Xiaomi/Google) para maximizar diversidad de opinión.

### 💸 `nan-eco-flash` — Presupuesto (todo Flash)

Para sesiones largas de chat, exploración y tareas mecánicas. Todos los roles
usan variantes Flash con thinking bajo o apagado.

| Rol | Modelo | Thinking |
|---|---|---|
| orchestrator | `nan/glm-5.3-flash` | medium |
| gentle-ai-explore | `nan/qwen-3.8-flash` | off |
| gentle-ai-worker | `nan/deepseek-v4-flash` | low |
| gentle-ai-verify | `nan/mimo-v2.6-flash` | off |
| review-refuter | `nan/glm-5.3-flash` | low |
| review-validator | `nan/qwen-3.6` | low |
| jd-judge-a | `nan/mimo-v2.6-flash` | off |
| jd-judge-b | `nan/gemma-4` | off |
| jd-fix-agent | `nan/qwen-3.8-flash` | low |

**Regla de oro aplicada:** el orchestrator nunca es el modelo más barato disponible
cuando hay decisiones de producto en juego; en `nan-eco-flash` aceptamos ese
trade-off explícitamente porque el perfil es para trabajo mecánico.

---

## 2. Archivo entregado

```text
gentle-dot/docs/profiles/nan-profiles.json   ← store importable (3 perfiles)
```

---

## 3. Instalación en Gentle Shell

Gentle Shell guarda sus perfiles en:

```text
~/.pi/gentle-ai/profiles.json
```

### Opción A — Merge seguro (RECOMENDADA si ya tenés perfiles)

No sobrescribas: mezclá. Con `python3` (viene en tu sistema):

```bash
python3 - <<'PY'
import json, os, pathlib

src = json.load(open("/run/media/bladimir/Datos/Datos/proyectos/work/gentleman/gentle-dot/docs/profiles/nan-profiles.json"))
dst_path = pathlib.Path(os.path.expanduser("~/.pi/gentle-ai/profiles.json"))
dst_path.parent.mkdir(parents=True, exist_ok=True)

dst = json.load(open(dst_path)) if dst_path.exists() else {"kind": src["kind"], "version": 1, "profiles": {}}
assert dst.get("kind") == "gentle-pi.agent_model_profiles", f"Formato inesperado en {dst_path}"

for name, roles in src["profiles"].items():
    if name in dst["profiles"]:
        print(f"  ! '{name}' ya existe: se omite (borralo a mano si querés reemplazarlo)")
    else:
        dst["profiles"][name] = roles
        print(f"  + '{name}' agregado")

tmp = dst_path.with_suffix(".tmp")
tmp.write_text(json.dumps(dst, indent=2, ensure_ascii=False) + "\n")
tmp.replace(dst_path)
print(f"OK -> {dst_path}")
PY
```

### Opción B — Copia directa (solo si NO tenés perfiles previos)

```bash
mkdir -p ~/.pi/gentle-ai
cp /run/media/bladimir/Datos/Datos/proyectos/work/gentleman/gentle-dot/docs/profiles/nan-profiles.json \
   ~/.pi/gentle-ai/profiles.json
```

### Verificación en Gentle Shell

1. Reiniciá Gentle Shell (o recargá la sesión).
2. En el chat: `/profiles` — deben aparecer `nan-full-power`, `nan-review-hard`, `nan-eco-flash`.
3. Activá el recomendado: `/profiles apply nan-full-power`.

Al aplicar, el engine distribuye solo:
- `orchestrator` → `settings.json` (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`)
- roles de agentes → `subagents.json` (`model_profiles`) + frontmatter de agentes
- `review-refuter` / `review-validator` → `models.json` (rutas de revisión RDD)

---

## 4. Compartirlo conmigo (Gentle Dot / daemon)

El daemon importa los perfiles de tu store personal en un paso único:

1. El archivo ya está en `~/.pi/gentle-ai/profiles.json` (paso 3).
2. En Gentle Dot: **Perfiles → Importar** (o mensaje `profile_import`).
   El daemon lee exactamente ese path (`GENTLE_PI_CONFIG_HOME || ~/.pi/gentle-ai/profiles.json`),
   copia los perfiles que falten con sufijo `-imported` si hay choque de nombres,
   y te avisa si algún proveedor aún no está conectado.
3. Desde ahí puedo aplicar/cambiar perfiles cuando me lo pidas,
   y el selector de modelos del chat muestra los modelos `nan/*`.

### Requisito previo: la suscripción NaN registrada

Dijiste que ya la ingresaste. Verificá que el proveedor y los IDs coincidan:

1. Abrí el **selector de modelos** del chat en Gentle Dot, o
2. revisá `~/.pi/agent/models.json` (no lo leo yo: contiene tus credenciales)
   y confirmá:
   - **ID del proveedor** — asumí `nan`. Si se registró como `nano`/`nan-gateway`/otro,
     reemplazá `nan/` por el prefijo correcto en los 3 perfiles (buscar y reemplazar).
   - **IDs de modelo** — asumí minúsculas con guiones (`nan/glm-5.3`, `nan/deepseek-v4-flash`…).
     Si el proveedor usa otro formato (ej. `GLM-5.3`, `glm5.3`), ajustá el sufijo del modelo.

```bash
# Ver solo los IDs sin exponer claves:
python3 - <<'PY'
import json, os
m = json.load(open(os.path.expanduser("~/.pi/agent/models.json")))
provs = m.get("providers", m)
if isinstance(provs, dict):
    for pid, p in provs.items():
        models = p.get("models", [])
        ids = [x if isinstance(x, str) else x.get("id") for x in models]
        print(pid, "->", ids)
PY
```

Si los IDs difieren de los asumidos, corré este reemplazo y reinstalá:

```bash
sed -i 's|nan/|TU_PROVEEDOR/|g; s|glm-5.3-flash|ID_REAL|g' nan-profiles.json  # ejemplo
```

---

## 5. Cómo usarlos en el flujo de trabajo

| Situación | Perfil |
|---|---|
| Desarrollo diario ODD (fases, delegación, commits) | `nan-full-power` ⭐ |
| Código sensible: auth, secretos, migraciones, pagos | `nan-review-hard` |
| Sesiones largas, refactors mecánicos, chat extendido | `nan-eco-flash` |

- **Cambio en caliente:** mientras el asistente responde, el cambio espera y se aplica al terminar.
- **RDD:** los roles `review-refuter`/`review-validator` rutean vía `models.json`;
  el interruptor de revisión (RDD) usa estos dos sin tocar los agentes.
- **Judgment Day:** `jd-judge-a/b` están elegidos de familias distintas a propósito.

---

## 6. Referencias

- `packages/daemon/src/profiles.ts` — el store, el import y cómo se aplican.
- `packages/protocol/src/index.ts` — `Profile`, `ProfileRoles`, `THINKING_LEVELS`.
- Roles y etiquetas: `ROLE_LABELS` en `profiles.ts`.

## Fallback entre proveedores (nan → NVIDIA)

Las cadenas de `profile-fallbacks.json` son la salida cuando un modelo primario deja de servir. Hasta ahora todas apuntaban solo a `nan/*`: si nan se quedaba sin cuota, la sesión se cortaba sin alternativa.

**Formato del store** (`gentle-pi.profile_model_fallbacks`, v1): por perfil, por rol (o `"*"` como cadena por defecto de los roles sin cadena propia), una lista ordenada de hasta **8** pasos `{ "model": "provider/model", "thinking"?: "<nivel>" }` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Sin pasos repetidos.

**Qué dispara el cambio** (dentro de la misma sesión, por rol — no hace falta cambiar de perfil):

| Categoría | Origen | Enfriamiento |
|---|---|---|
| `quota` | la respuesta menciona quota/credit/billing/usage limit (la palabra gana antes que el status) | 30 min |
| `auth` | 401 / 403 | 30 min |
| `rate_limit` | 429 | 2 min |
| `provider_unavailable` | 5xx | 2 min |
| `timeout` / `network` | 408, 504, red | 2 min |

No hay fallback para `invalid_request`, `context_length` ni abort manual: ahí el cambio no ayudaría. Ojo con el 402: si el cuerpo **no** trae ninguna de esas palabras, cae en `invalid_request` y **no** cambia de proveedor.

**Regla práctica**: un id que no existe en el catálogo del provider quema el paso en vez de servir un turno — observado como 401 con `nan/glm5.3` (auth ⇒ enfriamiento 30 min). Por eso las cadenas se normalizan a ids vivos y la escalera NVIDIA se agrega al final:

```
nan/deepseek-v4-flash        → primario (vivo)
nan/glm5.3-flash             → vivo, cae por cuota cuando se agota
nvidia/z-ai/glm-5.3-flash    → misma familia, vía NVIDIA
nvidia/deepseek-ai/deepseek-v4.1-flash
nvidia/nvidia/nemotron-3-ultra-550b-a55b
```

Los ids `nvidia/*` deben existir en el catálogo instalado (`pi-ai/dist/providers/data/nvidia.json`) y el provider necesita su key en el `auth.json` del engine (`~/.gentle-dot/agent/auth.json` y `~/.gentle-shell/agent/auth.json` ya la tienen).

**Aplicarlo**: la configuración de modelos es human-controlled — ninguna herramienta de agente puede escribirla. Se corre a mano:

```bash
node scripts/setup/profile-fallbacks-nvidia.mjs --check     # valida sin escribir
node scripts/setup/profile-fallbacks-nvidia.mjs             # aplica (deja .bak)
node scripts/setup/profile-fallbacks-nvidia.mjs --dry-run   # muestra qué cambiaría
```

Toca `~/.gentle-dot/gentle-ai/profile-fallbacks.json` (daemon y app de escritorio) y `~/.gentle-shell/config/gentle-ai/profile-fallbacks.json` (sesión TUI). Es idempotente y después hay que reiniciar el engine para que lea las cadenas.
