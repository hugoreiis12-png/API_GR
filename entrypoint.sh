#!/bin/bash
set -e

LOG=/var/log/cron-fuzzing.log
mkdir -p /var/log
touch "$LOG"

# O daemon do cron NAO herda o ambiente do container. Sem isto, a coleta agendada
# rodaria sem DUMP_DIR/credenciais: gravaria o dump em /app (nao no volume
# /app/data) e o sync-api nunca acharia o arquivo -> nada iria aos webhooks.
# Solucao: gerar o crontab em runtime injetando as envs vivas do container como
# linhas NAME=value (o cron as aplica a cada job). Assim o run agendado usa o
# MESMO ambiente do sync-api e da execucao manual -> mesmo resultado.
{
  printenv | grep -E '^(GRSA_|JWT_|N8N_|BUBBLE_|SYNC_API_URL|SYNC_PORT|DUMP_DIR|CHROME_PATH|TZ|PATH)=' || true
  echo "59 11 * * * flock -n /tmp/fuzzing.lock -c \"cd /app && node fuzzing.js >> $LOG 2>&1\""
} > /app/crontab.txt
crontab /app/crontab.txt
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] crontab instalado (coleta diaria 11:59 ${TZ:-UTC})."

# sync-api em background (herda o ambiente do container: DUMP_DIR, webhooks, JWT_SECRET).
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Iniciando sync-api..."
node /app/sync-api.js &

# Execucao opcional ao subir o container (alem do cron). Reproduz a validacao
# manual sem esperar as 11:59. Espera ~5s para o sync-api ligar, roda em
# background e NAO derruba o container se a coleta falhar.
if [ "${RUN_ON_START:-false}" = "true" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] RUN_ON_START=true -> coleta inicial em ~5s..."
  ( sleep 5; cd /app && node fuzzing.js >> "$LOG" 2>&1 || echo "[on-start] fuzzing.js falhou (ver log acima)" ) &
fi

# Espelha o log do cron no stdout do container para aparecer no docker logs / Portainer.
tail -F "$LOG" &

# cron em foreground: mantem o container vivo. Se o cron sair, o container finaliza.
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Iniciando cron daemon..."
exec cron -f
