# 🚀 Migración y Despliegue

## 🎯 Objetivo
Migrar de 5+ daemons legacy a Single Daemon (puerto 4317) + 4 conectores nativos, con zero-downtime y rollback plan.

---

## 📦 Estado Actual (Legacy)

### Daemons Existentes
| Daemon | Puerto | Repositorio | Estado |
|--------|--------|-------------|--------|
| telegram-bot | 4318 | gentle-dot/telegram-bridge | 🟢 Activo |
| gmail-bridge | 4319 | gentle-dot/gmail-bridge | 🟢 Activo |
| discord-bot | 4320 | gentle-dot/discord-bridge | 🟢 Activo |
| whatsapp-baileys | 4321 | gentle-dot/whatsapp-bridge | 🟢 Activo |
| whatsapp-meta | 4322 | gentle-dot/whatsapp-cloud-bridge | 🟢 Activo |

### Configuración Actual
- 5 archivos config separados
- 5 systemd services
- 5 puertos en firewall
- 5 codebases con código duplicado

---

## 🗺️ Plan de Migración

### Fase 0: Preparación (Semana 1)
```bash
# 1. Crear branch migración
git checkout -b migration/single-daemon

# 2. Inventario completo
./scripts/inventory.sh > legacy-inventory.json

# 3. Backup configs
cp -r /etc/gentle-dot /backup/gentle-dot-$(date +%Y%m%d)

# 4. Documentar variables env
printenv | grep -E 'TELEGRAM|GMAIL|DISCORD|WHATSAPP' > legacy-env.txt
```

### Fase 1: Desarrollo Nuevo Sistema (Semanas 2-6)
| Semana | Entregable |
|--------|------------|
| 2 | Daemon principal + WS Server + Registry |
| 3 | BaseBridge + Bridge Protocol v1 |
| 4 | Conector Telegram + Gmail |
| 5 | Conector Discord + WhatsApp (Baileys) |
| 6 | WhatsApp Meta Cloud + Integración completa |

### Fase 2: Testing Paralelo (Semana 7)
```bash
# Desplegar nuevo sistema en staging
docker compose -f docker-compose.staging.yml up -d

# Ejecutar tests paralelos
pnpm test:integration
pnpm test:e2e

# Comparar comportamiento
./scripts/compare-behavior.sh legacy staging > comparison-report.md
```

### Fase 3: Migración Canary (Semana 8)
```bash
# 1. Desplegar nuevo sistema en prod (puerto 4317)
docker compose -f docker-compose.prod.yml up -d

# 2. Health checks
for i in {1..30}; do
  curl -sf http://localhost:4317/health && break
  sleep 2
done

# 3. Iniciar bridges
pnpm start:bridges

# 4. Verificar 4 conectores registrados
CONNECTORS=$(curl -s http://localhost:4317/connectors | jq length)
if [ "$CONNECTORS" -ne 4 ]; then
  echo "❌ Rollback: esperados 4, encontrados $CONNECTORS"
  ./scripts/rollback.sh
  exit 1
fi

# 5. Smoke tests
pnpm test:e2e -- --grep smoke
```

### Fase 4: Cutover (Semana 9)
```bash
# 1. Cambiar DNS/Load Balancer a puerto 4317
#    (Traffic shift 100% → nuevo daemon)

# 2. Detener legacy daemons (orden inverso dependencias)
systemctl stop whatsapp-meta
systemctl stop whatsapp-baileys
systemctl stop discord-bot
systemctl stop gmail-bridge
systemctl stop telegram-bot

# 3. Deshabilitar systemd legacy
systemctl disable whatsapp-meta whatsapp-baileys discord-bot gmail-bridge telegram-bot

# 4. Remover puertos legacy firewall
ufw delete allow 4318
ufw delete allow 4319
ufw delete allow 4320
ufw delete allow 4321
ufw delete allow 4322

# 5. Monitoreo 24h
watch -n 60 'curl -s http://localhost:4317/health | jq .status'
```

### Fase 5: Limpieza (Semana 10)
```bash
# 1. Remover código legacy
rm -rf /opt/gentle-dot/{telegram-bot,gmail-bridge,discord-bot,whatsapp-bridge,whatsapp-cloud-bridge}

# 2. Remover configs legacy
rm -rf /etc/gentle-dot/{telegram,gmail,discord,whatsapp}*.yaml

# 3. Remover systemd units legacy
rm /etc/systemd/system/gentle-dot-{telegram,gmail,discord,whatsapp}*.service

# 4. Actualizar docs
git add docs/restructuring/
git commit -m "docs: migración completada a Single Daemon v1.0"

# 5. Tag release
git tag -a v1.0.0-migration -m "Single Daemon migration complete"
git push origin v1.0.0-migration
```

---

## 🔄 Rollback Plan

### Trigger Conditions
| Condición | Acción |
|-----------|--------|
| Health check falla >5 min | Rollback automático |
| >5% error rate en bridges | Rollback manual |
| Latencia P99 >2s | Rollback manual |
| Conectores no registrados | Rollback automático |

### Rollback Script
```bash
#!/bin/bash
# scripts/rollback.sh

set -e

echo "🔴 INICIANDO ROLLBACK..."

# 1. Detener nuevo sistema
docker compose -f docker-compose.prod.yml down

# 2. Restaurar configs legacy
cp -r /backup/gentle-dot-$(date +%Y%m%d)/* /etc/gentle-dot/

# 3. Iniciar legacy daemons (orden dependencias)
systemctl start telegram-bot
systemctl start gmail-bridge
systemctl start discord-bot
systemctl start whatsapp-baileys
systemctl start whatsapp-meta

# 4. Verificar legacy saludable
for port in 4318 4319 4320 4321 4322; do
  for i in {1..10}; do
    curl -sf http://localhost:$port/health && break
    sleep 2
  done
done

# 5. Restaurar DNS/Load Balancer a puertos legacy
# (Ejecutar script DNS rollback)

# 6. Notificar
./scripts/notify.sh "🔴 ROLLBACK COMPLETADO - Sistema legacy restaurado"

echo "✅ Rollback completado en $(date)"
```

### Rollback Manual (Si script falla)
```bash
# 1. Parar contenedores nuevos
docker stop $(docker ps -q --filter "name=gentle-dot")

# 2. Verificar puertos legacy libres
netstat -tlnp | grep -E '431[8-9]|432[0-2]'

# 3. Iniciar systemd legacy manualmente
systemctl start telegram-bot gmail-bridge discord-bot whatsapp-baileys whatsapp-meta

# 4. Verificar logs
journalctl -u telegram-bot -f
```

---

## 🐳 Docker Compose (Producción)

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  daemon:
    image: ${REGISTRY}/gentle-dot/daemon:${VERSION}
    ports:
      - "4317:4317"
    environment:
      - DAEMON_PORT=4317
      - DAEMON_HOST=0.0.0.0
      - CONFIG_PATH=/config/connectors.yaml
      - LOG_LEVEL=info
      - NODE_ENV=production
      - DAEMON_TOKEN=${DAEMON_TOKEN}
    volumes:
      - ./config:/config:ro
      - daemon-data:/data
      - daemon-workspace:/workspace
      - daemon-logs:/logs
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4317/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: '1.0'
        reservations:
          memory: 512M
          cpus: '0.5'

  bridge-telegram:
    image: ${REGISTRY}/gentle-dot/connector-telegram:${VERSION}
    environment:
      - DAEMON_URL=ws://daemon:4317/ws
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}
      - LOG_LEVEL=info
    depends_on:
      daemon:
        condition: service_healthy
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: '0.25'

  bridge-gmail:
    image: ${REGISTRY}/gentle-dot/connector-gmail:${VERSION}
    environment:
      - DAEMON_URL=ws://daemon:4317/ws
      - GMAIL_CLIENT_ID=${GMAIL_CLIENT_ID}
      - GMAIL_CLIENT_SECRET=${GMAIL_CLIENT_SECRET}
      - GMAIL_REFRESH_TOKEN=${GMAIL_REFRESH_TOKEN}
      - GMAIL_WEBHOOK_SECRET=${GMAIL_WEBHOOK_SECRET}
      - GMAIL_WEBHOOK_URL=${GMAIL_WEBHOOK_URL}
      - LOG_LEVEL=info
    depends_on:
      daemon:
        condition: service_healthy
    restart: unless-stopped

  bridge-discord:
    image: ${REGISTRY}/gentle-dot/connector-discord:${VERSION}
    environment:
      - DAEMON_URL=ws://daemon:4317/ws
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
      - DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID}
      - DISCORD_GUILD_ID=${DISCORD_GUILD_ID}
      - DISCORD_OWNER_ID=${DISCORD_OWNER_ID}
      - LOG_LEVEL=info
    depends_on:
      daemon:
        condition: service_healthy
    restart: unless-stopped

  bridge-whatsapp:
    image: ${REGISTRY}/gentle-dot/connector-whatsapp:${VERSION}
    environment:
      - DAEMON_URL=ws://daemon:4317/ws
      - WHATSAPP_MODE=both
      - WHATSAPP_PHONE_ID=${WHATSAPP_PHONE_ID}
      - WHATSAPP_ACCESS_TOKEN=${WHATSAPP_ACCESS_TOKEN}
      - WHATSAPP_APP_SECRET=${WHATSAPP_APP_SECRET}
      - WHATSAPP_WEBHOOK_VERIFY=${WHATSAPP_WEBHOOK_VERIFY}
      - WHATSAPP_TEMPLATE_NAMESPACE=whatsapp:hsm:xxxx
      - WHATSAPP_WEBHOOK_URL=${WHATSAPP_WEBHOOK_URL}
      - LOG_LEVEL=info
    depends_on:
      daemon:
        condition: service_healthy
    restart: unless-stopped
    ports:
      - "3000:3000"  # Webhook Meta Cloud

volumes:
  daemon-data:
  daemon-workspace:
  daemon-logs:

networks:
  default:
    name: gentle-dot-network
```

---

## 📋 Variables de Entorno (Producción)

```bash
# .env.prod (NO commitear - usar secrets manager)

# Daemon
DAEMON_TOKEN=openssl-rand-base64-32

# Telegram
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_WEBHOOK_SECRET=xxx

# Gmail
GMAIL_CLIENT_ID=xxx
GMAIL_CLIENT_SECRET=xxx
GMAIL_REFRESH_TOKEN=xxx
GMAIL_WEBHOOK_SECRET=xxx
GMAIL_WEBHOOK_URL=https://api.dominio.com/webhook/gmail

# Discord
DISCORD_BOT_TOKEN=xxx
DISCORD_CLIENT_ID=xxx
DISCORD_GUILD_ID=xxx
DISCORD_OWNER_ID=xxx

# WhatsApp
WHATSAPP_PHONE_ID=xxx
WHATSAPP_ACCESS_TOKEN=xxx
WHATSAPP_APP_SECRET=xxx
WHATSAPP_WEBHOOK_VERIFY=xxx
WHATSAPP_TEMPLATE_NAMESPACE=whatsapp:hsm:xxxx
WHATSAPP_WEBHOOK_URL=https://api.dominio.com/webhook/whatsapp
WHATSAPP_APP_SECRET=xxx

# Registry
REGISTRY=ghcr.io/usuario
VERSION=v1.0.0
```

---

## 📊 Monitoreo Post-Deploy

### Health Checks
```bash
# Daemon
curl http://localhost:4317/health
# {"status":"ok","uptime":3600,"connectors":4,"memory":"145MB"}

# Connectors
curl http://localhost:4317/connectors
# [{"connectorId":"telegram-1","type":"telegram","status":"ready"},...]

# Metrics
curl http://localhost:9090/metrics
```

### Alertas (Prometheus/Grafana)
```yaml
# alerting-rules.yml
groups:
  - name: gentle-dot
    rules:
      - alert: DaemonDown
        expr: up{job="gentle-dot-daemon"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Daemon Gentle caído"

      - alert: ConnectorDisconnected
        expr: gentle_dot_connector_status{status!="ready"} > 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Conector {{ $labels.connectorId }} desconectado"

      - alert: HighErrorRate
        expr: rate(gentle_dot_errors_total[5m]) > 0.05
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Error rate alto: {{ $value }}"

      - alert: HighLatency
        expr: histogram_quantile(0.99, gentle_dot_latency_seconds) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Latencia P99 > 2s"

      - alert: MemoryHigh
        expr: (gentle_dot_memory_bytes / gentle_dot_memory_limit_bytes) > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Memoria > 85%"
```

---

## 📋 Checklist Deploy

| Paso | Comando | Verificación | Estado |
|------|---------|--------------|--------|
| 1 | `docker compose build` | Imágenes creadas | ⬜ |
| 2 | `docker compose up -d` | Containers running | ⬜ |
| 3 | `curl /health` | `{"status":"ok"}` | ⬜ |
| 4 | `curl /connectors` | 4 conectores ready | ⬜ |
| 5 | `pnpm test:e2e --grep smoke` | All pass | ⬜ |
| 6 | `k6 run load-test.js` | <1% errors | ⬜ |
| 7 | DNS switch | Traffic en 4317 | ⬜ |
| 8 | Legacy stop | Puertos 4318-22 libres | ⬜ |
| 9 | 24h monitoring | Sin alertas critical | ⬜ |
| 10 | Cleanup legacy | Código removido | ⬜ |

---

## 📚 Referencias
- [Fase 1: Daemon](./02-FASE-1-DAEMON-PRINCIPAL.md)
- [Fase 2: Conectores](./03-FASE-2-CONECTORES.md)
- [Testing](./12-TESTING-PLAN.md)
- [Checklist](./14-CHECKLIST-AGENTE.md)
- [Reglas de Oro](./15-REGLAS-ORO.md)