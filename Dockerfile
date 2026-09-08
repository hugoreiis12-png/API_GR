# Dockerfile para API_GR: Node 20 + Chromium do sistema (via playwright-core).
# Node 20+ e obrigatorio: o Playwright (>=1.50) recusa rodar no Node 18.
# Base bookworm (Debian 12): o pacote chromium do bullseye e instavel e o
# apt-get install falha com frequencia (exit 100). No bookworm ele instala limpo.
FROM node:20-bookworm

WORKDIR /app

# Fuso do container (afeta o horario do scheduler e os timestamps dos logs).
ENV TZ=America/Sao_Paulo
# Navegador que o Playwright (playwright-core) usa dentro do container.
ENV CHROME_PATH=/usr/bin/chromium

# Chromium do sistema + tzdata. Usamos o chromium do sistema via playwright-core,
# entao NAO baixamos os navegadores do Playwright (build mais leve).
# --no-install-recommends evita puxar dezenas de pacotes opcionais (build menor
# e menos chance de uma dependencia recomendada quebrar o apt).
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    tzdata \
    ca-certificates \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

# Dependencias Node (browsers ja vem do sistema).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json ./
RUN npm ci --omit=dev

# Codigo da aplicacao + entrypoint.
COPY fuzzing.js sync-api.js scheduler.js entrypoint.sh ./
# Normaliza CRLF -> LF (o entrypoint.sh pode vir do Windows) para nao quebrar o sh.
RUN sed -i 's/\r$//' /app/entrypoint.sh

# Porta do sync-api (uso interno; exposta para debug/health).
EXPOSE 3005

# Sobe sync-api (n8n + Bubble com JWT) em background + scheduler em foreground.
# O fuzzing vai pela rota do sync-api, entao o Bubble sai assinado -- igual ao local.
CMD ["sh", "/app/entrypoint.sh"]
