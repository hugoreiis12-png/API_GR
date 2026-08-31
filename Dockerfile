# Dockerfile para API_GR com Node.js, Playwright e crontab
FROM node:18-bullseye

WORKDIR /app

# Instalar dependências do sistema
RUN apt-get update && apt-get install -y \
    cron \
    curl \
    wget \
    chromium-browser \
    && rm -rf /var/lib/apt/lists/*

# Copiar arquivos do projeto
COPY package*.json ./
COPY fuzzing.js ./
COPY sync-api.js ./

# Instalar dependências Node
RUN npm install

# Criar arquivo de crontab
RUN echo "58 11 * * 0-6 cd /app && node fuzzing.js >> /var/log/cron-fuzzing.log 2>&1" > /etc/cron.d/fuzzing-cron && \
    chmod 0644 /etc/cron.d/fuzzing-cron && \
    crontab /etc/cron.d/fuzzing-cron

# Criar diretório de logs
RUN mkdir -p /var/log && touch /var/log/cron-fuzzing.log

# Copiar script de inicialização
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Portar 3005 para o sync-api
EXPOSE 3005

ENTRYPOINT ["/entrypoint.sh"]
