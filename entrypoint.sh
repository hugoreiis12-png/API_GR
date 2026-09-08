#!/bin/sh
# Sobe o sync-api (destinos n8n + Bubble, com o Bubble assinado por JWT) em
# background e depois o scheduler em foreground. O fuzzing, disparado pelo
# scheduler, roda SEM N8N_WEBHOOK_URL para cair na rota do sync-api (localhost:3005)
# -- e assim o envio ao Bubble leva o header Authorization: Bearer <jwt>, igual ao
# fluxo local. O proprio sync-api recebe o destino n8n via N8N_WEBHOOK_URL.
set -e

# sync-api recebe o destino n8n (da env do compose/Portainer ou o default de producao).
N8N_WEBHOOK_URL="${N8N_WEBHOOK_URL:-http://192.168.0.231:5678/webhook/af-dump-trigger}" \
  node /app/sync-api.js &

# Da um instante para o sync-api abrir a porta 3005 antes de um eventual RUN_ON_START.
sleep 2

# Remove a var do ambiente do scheduler -> o fuzzing usa a rota do sync-api (com JWT).
unset N8N_WEBHOOK_URL

exec node /app/scheduler.js
