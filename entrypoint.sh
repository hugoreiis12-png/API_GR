#!/bin/bash
set -e

LOG=/var/log/cron-fuzzing.log
mkdir -p /var/log
touch "$LOG"

# sync-api em background (herda N8N_WEBHOOK_URL/SYNC_PORT do ambiente do container).
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Iniciando sync-api..."
node /app/sync-api.js &

# Espelha o log do cron no stdout do container para aparecer no docker logs / Portainer.
tail -F "$LOG" &

# cron em foreground: mantem o container vivo. Se o cron sair, o container finaliza.
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Iniciando cron daemon..."
exec cron -f
