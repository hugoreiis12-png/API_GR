# Imagem oficial do Playwright: ja traz Node.js + Chromium + todas as libs.
# A tag DEVE bater com a versao do playwright-core (veja package.json).
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

ENV TZ=America/Sao_Paulo \
    NODE_ENV=production
WORKDIR /app

# Instala dependencias (os browsers ja vem na imagem base).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Codigo da aplicacao.
COPY fuzzing.js sync-api.js scheduler.js ./

# Agendador em Node puro (sem binario externo): dispara o fuzzing.js no horario.
CMD ["node", "/app/scheduler.js"]
