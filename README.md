# API_GR — Coleta de AFs (GRSA) e Sincronização com n8n + Bubble

Pipeline que faz login no e-commerce da GRSA, coleta as Autorizações de
Fornecimento (AFs) não-canceladas dentro de uma janela de datas paginando a API
interna, gera o arquivo `af_full_dump.json` e o envia para dois destinos em
paralelo: um workflow do **n8n** e um workflow do **Bubble** (assinado com JWT).

```
                                        ┌─►  webhook n8n
fuzzing.js  ──►  af_full_dump.json  ──►  sync-api.js  ─┤
 (coleta)          (dump gerado)         (POST paralelo)  └─►  webhook Bubble (JWT)
```

A coleta pode ser disparada de duas formas:

- **Manual / desktop** — você roda `sync-api.js` e `fuzzing.js` à mão (Windows).
- **Automatizada / container** — o `scheduler.js` dispara o `fuzzing.js` de
  todo dia (seg a dom) no horário configurado, dentro do Docker (Portainer).

---

## 1. Arquitetura e fluxo

### `fuzzing.js` — coletor (Playwright)

1. Abre o Chrome (headless) e faz **login** em `ecommerce.grsa.com.br`.
2. Captura o `OAuth-Token` e o `User-Id` das requisições da própria página.
3. Pagina o endpoint interno `/backend/index.php/autoForne` (via `fetch` na
   sessão do browser) aplicando o **filtro** de data + status não-cancelada.
4. Grava tudo em `af_full_dump.json` (dump + amostra + sessão capturada).
5. Notifica o destino conforme o modo (ver abaixo).

**Dois modos de envio no `fuzzing.js`:**

| Modo | Condição | Comportamento |
| ---- | -------- | ------------- |
| **via sync-api** (desktop) | `N8N_WEBHOOK_URL` **não** definida | Chama `POST /dump-ready` no `sync-api`, que cuida do envio ao n8n **e** ao Bubble (com JWT). |
| **direto** (container) | `N8N_WEBHOOK_URL` definida | Envia o dump direto ao n8n **e** ao Bubble, sem passar pelo `sync-api`. |

> No Docker o `entrypoint.sh` entrega o `N8N_WEBHOOK_URL` ao **sync-api** e o
> **remove** do ambiente do `fuzzing`, para que a coleta sempre passe pela rota
> do `sync-api` (onde o envio ao Bubble sai assinado com JWT). Ou seja: mesmo no
> container o caminho efetivo é o "via sync-api".

### `sync-api.js` — despachante (servidor HTTP na porta 3005)

- Lê o `af_full_dump.json` e faz **POST em paralelo** para n8n e Bubble
  (`Promise.allSettled` — a falha de um não aborta o outro; só lança erro se
  **os dois** falharem).
- **Assina com JWT (HS256)** usando `JWT_SECRET`:
  - **n8n** recebe o payload puro, sem headers extras.
  - **Bubble** recebe o header `Authorization: Bearer <jwt>`, mais dois campos no
    corpo: `jwt` (o segredo em texto, usado pela condição *Only when* do
    workflow) e `jwtAssinado` (o token HS256 para validação da assinatura).
- **Fallback do n8n**: se a URL de produção (`/webhook/`) responder **404**
  (workflow inativo) ou falhar a conexão, ele reenvia automaticamente para a URL
  de teste (`/webhook-test/`).
- **Observa a pasta** do dump (`fs.watch`): sempre que `af_full_dump.json` é
  recriado, dispara o envio sozinho (com debounce de ~800ms e cooldown de 5s
  para não duplicar quando o `fuzzing` já avisou via `/dump-ready`).

### `scheduler.js` — agendador (Node puro, usado no container)

- Dispara o `fuzzing.js` **todo dia (seg a dom)** no horário `CRON_HOUR:CRON_MINUTE`
  (default **11:59**), respeitando o fuso `TZ`.
- Sem dependência de cron externo; calcula o próximo horário útil e reagenda.
- `RUN_ON_START=1` executa uma vez assim que o container sobe (para testar).

---

## 2. Pré-requisitos

- **Node.js 20+** (o Playwright ≥ 1.50 recusa rodar no Node 18).
- **Google Chrome / Chromium**:
  - Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`.
  - Container: `chromium` do sistema (via `CHROME_PATH=/usr/bin/chromium`).
- **n8n** acessível na rede (ex.: `http://192.168.0.231:5678`).
- Acesso à rede/VPN que alcança `https://ecommerce.grsa.com.br`.

---

## 3. Arquivos do projeto

| Arquivo               | Função                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| `fuzzing.js`          | Login + paginação da API `autoForne`, gera `af_full_dump.json` e dispara o envio. |
| `sync-api.js`         | Servidor HTTP (porta 3005): lê o dump e faz POST para n8n + Bubble (JWT). |
| `scheduler.js`        | Agendador (todo dia, horário configurável) que roda o `fuzzing.js`.    |
| `entrypoint.sh`       | Entrypoint do container: sobe o `sync-api` (background) + `scheduler` (foreground). |
| `Dockerfile`          | Imagem Node 20 + Chromium do sistema.                                  |
| `docker-compose.yml`  | Stack para deploy no Portainer.                                        |
| `af_full_dump.json`   | Saída gerada pelo `fuzzing.js` (~1 MB; ignorado pelo git).             |
| `all_n8n_fluxo.json`  | Workflow do n8n a importar (contém o nó **Webhook Trigger**).          |

---

## 4. Configuração (variáveis de ambiente)

Nenhuma é obrigatória para a coleta básica — há defaults. O **`JWT_SECRET`** é
necessário para o envio assinado ao Bubble.

| Variável            | Usada em            | Default                                                        |
| ------------------- | ------------------- | ------------------------------------------------------------- |
| `N8N_WEBHOOK_URL`   | `sync-api`/`fuzzing`| `http://192.168.0.231:5678/webhook/af-dump-trigger`           |
| `BUBBLE_WEBHOOK_URL`| `sync-api`/`fuzzing`| `https://comprover.bubbleapps.io/api/1.1/wf/chave_gr`         |
| `JWT_SECRET`        | `sync-api`          | *(vazio — sem ele o Bubble vai sem JWT)*                       |
| `JWT_EXPIRY_HOURS`  | `sync-api`          | `12`                                                          |
| `SYNC_PORT`         | `sync-api`          | `3005`                                                        |
| `DUMP_DIR`          | `sync-api`          | raiz do projeto (usar volume no Docker)                       |
| `SYNC_API_URL`      | `fuzzing`           | `http://localhost:3005/dump-ready`                            |
| `CHROME_PATH`       | `fuzzing`           | Chrome local (Win) / chromium (Linux)                         |
| `GR_EMAIL` / `GR_PASS` | `fuzzing`        | credenciais de login (mova para env — ver Segurança)          |
| `RANGE_START`       | `fuzzing`           | hoje (`DD/MM/YYYY`)                                            |
| `RANGE_DAYS`        | `fuzzing`           | `6` (janela = hoje + 6 dias = 7 dias corridos)                |
| `DATE_FORMAT`       | `fuzzing`           | `br` (`DD/MM/YYYY`) — ou `iso` (`YYYY-MM-DD`)                  |
| `DATE_OPERATOR`     | `fuzzing`           | `BETWEEN`                                                     |
| `CRON_HOUR` / `CRON_MINUTE` | `scheduler` | `11` / `59`                                                  |
| `RUN_ON_START`      | `scheduler`         | *(vazio; `1` roda uma vez ao subir)*                          |
| `TZ`                | container           | `America/Sao_Paulo`                                           |

Exemplo (PowerShell):

```powershell
$env:JWT_SECRET = "meu-segredo"
$env:N8N_WEBHOOK_URL = "http://192.168.0.231:5678/webhook/af-dump-trigger"
```

> ⚠️ Use o **IP real** da máquina do n8n (ex.: `192.168.0.231`). Nunca use
> `0.0.0.0` como destino — é apenas o endereço de *bind* que o n8n exibe, não um
> host acessível.

### Filtro de datas

O `fuzzing.js` coleta AFs no campo `DTPROGENTAF` entre `RANGE_START` e
`RANGE_START + RANGE_DAYS`. Com os defaults, é uma **janela deslizante de 7 dias
a partir de hoje**. Além da data, o filtro exige status não-cancelada
(`STATUS=N`, `IDSITUATENDIMENTOAF=N`, `AFCANCELADA=N`).

---

## 5. Como rodar (local / desktop)

Instale as dependências uma vez:

```powershell
npm install
```

### Passo 1 — Subir o sync-api

```powershell
$env:JWT_SECRET = "meu-segredo"   # necessário para assinar o envio ao Bubble
node sync-api.js
```

Saída esperada:

```
sync-api listening on http://localhost:3005
watched file: ...\af_full_dump.json
n8n webhook: http://192.168.0.231:5678/webhook/af-dump-trigger
bubble webhook: https://comprover.bubbleapps.io/api/1.1/wf/chave_gr
```

O `sync-api` também **observa** a pasta: sempre que `af_full_dump.json` é
recriado, ele dispara o envio automaticamente.

### Passo 2 — Rodar a coleta

Em outro terminal:

```powershell
node fuzzing.js
```

Fluxo: login → paginação das AFs → grava `af_full_dump.json` → chama o
`sync-api` (`POST /dump-ready`) → o `sync-api` envia ao n8n e ao Bubble.

---

## 6. Deploy no Docker / Portainer

O `docker-compose.yml` builda a imagem a partir do `Dockerfile` e sobe um
container que roda **sync-api + scheduler** juntos (via `entrypoint.sh`). A
coleta acontece sozinha todo dia (seg a dom) no horário configurado.

```bash
docker compose up -d --build
```

No **Portainer** (deploy via Git): aponte a stack para este repositório e defina
as variáveis em *Stack → Environment variables* — principalmente **`JWT_SECRET`**
(não commitado). As demais têm defaults no compose (`N8N_WEBHOOK_URL`,
`RANGE_DAYS`, `CRON_HOUR`, `CRON_MINUTE`, `TZ`).

Para testar sem esperar o horário, descomente `RUN_ON_START: "1"` no compose (ele
roda a coleta uma vez ao subir; volte a comentar em produção).

---

## 7. Configurar o webhook no n8n

1. Importe o workflow **`all_n8n_fluxo.json`** (menu → *Import from File*).
2. Localize o nó **Webhook Trigger** (path: `af-dump-trigger`, método `POST`).

O n8n expõe **duas URLs** para o mesmo webhook:

| Modo         | URL                                              | Quando usar |
| ------------ | ------------------------------------------------ | ----------- |
| **Produção** | `http://<ip>:5678/webhook/af-dump-trigger`       | Uso recorrente/automatizado. Exige o workflow **Active**. |
| **Teste**    | `http://<ip>:5678/webhook-test/af-dump-trigger`  | Uso pontual. Registra **só após clicar "Execute workflow"** e vale **1 chamada**. |

Para automação, ative o toggle **Active** e aponte `N8N_WEBHOOK_URL` para a URL
`/webhook/`. Os resultados aparecem na aba **Executions** (workflow ativo roda em
background e não mostra o resultado no canvas). O `sync-api` já cai no
`/webhook-test/` como fallback se a produção responder 404.

---

## 8. Endpoints do sync-api

| Método | Rota          | Descrição                                                        |
| ------ | ------------- | ---------------------------------------------------------------- |
| `GET`  | `/health`     | Status do serviço (arquivo e webhooks configurados).            |
| `POST` | `/dump-ready` | Chamado pelo `fuzzing.js`; envia o dump atual ao n8n + Bubble.  |
| `POST` | `/trigger`    | Dispara manualmente o envio do `af_full_dump.json` atual.       |

> Segurança: o `/dump-ready` **ignora** qualquer `filePath` vindo do cliente e
> sempre lê o dump oficial (evita leitura/exfiltração de arquivos arbitrários).

Disparo manual:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3005/trigger
```

---

## 9. Solução de problemas

| Sintoma                                        | Causa provável / solução                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `404 "webhook not registered"`                 | Workflow não está **Active** (ou modo teste expirou). O sync-api tenta o `/webhook-test/` como fallback. |
| Bubble responde erro de auth                   | `JWT_SECRET` ausente/errado. Confira a env do sync-api e a condição *Only when* do workflow. |
| POST some / connection refused                 | IP/porta errados. Confira o IP real do n8n e se a porta 5678 está acessível na rede.     |
| `Arquivo não encontrado`                       | `af_full_dump.json` ainda não foi gerado — rode o `fuzzing.js` primeiro.                 |
| Login falha no `fuzzing.js`                    | Credenciais/cookie de sessão expirados, ou fora da rede que alcança `ecommerce.grsa.com.br`. |
| Container em loop / Chromium trava             | Confira `shm_size: "1gb"` no compose (o `/dev/shm` padrão de 64MB não basta).            |
| `{"ok":false,"message":""}`                    | Já tratado: o sync-api descreve `AggregateError` (ex.: IPv6 `::1`) com mensagem legível. |

---

## 10. Segurança

- O `fuzzing.js` traz **credenciais e cookie de sessão** com valores default no
  código. Prefira defini-los via `GR_EMAIL` / `GR_PASS` (e remover os defaults)
  antes de versionar ou compartilhar.
- **Nunca commite** o `JWT_SECRET` — defina-o no Portainer/ambiente.
- O `af_full_dump.json` contém a sessão capturada e é ignorado pelo git
  (`.gitignore`); não versione nem compartilhe.
