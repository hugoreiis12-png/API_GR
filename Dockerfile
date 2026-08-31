# Dockerfile para API_GR com Node.js, Playwright e crontab
FROM node:18-bullseye

WORKDIR /app

# Fuso do container (afeta o horario do cron e os timestamps dos logs).
ENV TZ=America/Sao_Paulo
# Navegador que o Playwright (playwright-core) usa dentro do container.
ENV CHROME_PATH=/usr/bin/chromium

# Instalar dependências do sistema (util-linux traz o flock usado no lock do cron).
RUN apt-get update && apt-get install -y \
    cron \
    curl \
    wget \
    tzdata \
    util-linux \
    chromium \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

# Copiar arquivos do projeto
COPY package*.json ./
COPY fuzzing.js ./
COPY sync-api.js ./

# Instalar dependências Node. Usamos o chromium do sistema via playwright-core,
# entao pulamos o download dos navegadores do Playwright (build mais leve).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install

# Crontab do coletor (formato user-crontab, sem campo de usuario).
# - PATH/TZ explicitos: o daemon do cron nao herda o ambiente do container.
# - Todo dia 11:57 (dia-da-semana = *). O envio ao n8n acontece em cadeia: fuzzing.js -> sync-api -> webhook.
# - flock -n: se a execucao anterior ainda roda, o cron pula (evita sobreposicao).
RUN printf '%s\n' \
    'PATH=/usr/local/bin:/usr/bin:/bin' \
    'TZ=America/Sao_Paulo' \
    'CHROME_PATH=/usr/bin/chromium' \
    '57 11 * * * flock -n /tmp/fuzzing.lock -c "cd /app && node fuzzing.js >> /var/log/cron-fuzzing.log 2>&1"' \
    > /app/crontab.txt \
    && crontab /app/crontab.txt

# Criar diretório de logs
RUN mkdir -p /var/log && touch /var/log/cron-fuzzing.log

# Copiar script de inicialização
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Portar 3005 para o sync-api
EXPOSE 3005

ENTRYPOINT ["/entrypoint.sh"]
