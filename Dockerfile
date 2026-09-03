# Dockerfile para API_GR com Node.js, Playwright e crontab
# Node 20+ e obrigatorio: o Playwright (>=1.50) recusa rodar no Node 18.
FROM node:20-bullseye

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
RUN npm ci

# O crontab NAO e criado aqui: ele e gerado em runtime pelo entrypoint.sh, que
# injeta o ambiente vivo do container (DUMP_DIR, credenciais, webhooks) — o cron
# nao herda essas envs sozinho. Ver entrypoint.sh. Coleta diaria 11:59, com
# flock para nao sobrepor execucoes.

# Criar diretório de logs
RUN mkdir -p /var/log && touch /var/log/cron-fuzzing.log

# Copiar script de inicialização
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Portar 3005 para o sync-api
EXPOSE 3005

ENTRYPOINT ["/entrypoint.sh"]
