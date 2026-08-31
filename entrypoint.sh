#!/bin/bash

# Iniciar o sync-api em background
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando sync-api..."
node /app/sync-api.js &

# Iniciar o cron daemon
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando cron daemon..."
cron -f

# Se cron sair, o container finaliza
exit $?
