# Imagem oficial do Playwright: ja traz Node.js + Chromium + todas as libs.
# A tag DEVE bater com a versao do playwright-core (veja package.json).
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

ENV TZ=America/Sao_Paulo \
    NODE_ENV=production
WORKDIR /app

# supercronic: executor de crontab feito para containers. Roda os jobs com o
# ambiente do container (herda as env vars) e loga em stdout -> ideal p/ Portainer.
ARG SUPERCRONIC_VERSION=v0.2.33
RUN curl -fsSL -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
    && chmod +x /usr/local/bin/supercronic

# Instala dependencias (os browsers ja vem na imagem base).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Codigo da aplicacao + crontab.
COPY fuzzing.js sync-api.js crontab ./

# Sobe o supercronic lendo o crontab; ele dispara o fuzzing.js no horario agendado.
CMD ["supercronic", "/app/crontab"]
