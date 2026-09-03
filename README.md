# API_GR — Coleta de AFs (GRSA) e Sincronização com n8n

Pipeline que faz login no e-commerce da GRSA, coleta todas as Autorizações de
Fornecimento (AFs) não-canceladas paginando a API interna, gera o arquivo
`af_full_dump.json` e o envia para um workflow do **n8n** via webhook.

```
fuzzing.js  ──►  af_full_dump.json  ──►  sync-api.js  ──►  webhook n8n
 (coleta)          (dump gerado)         (envia POST)      (processa)
```

---

## 1. Pré-requisitos

- **Node.js 20+** (usa `URL`, `fetch` no browser e módulo `http` nativo; Playwright >=1.50 recusa Node 18)
- **Google Chrome** instalado em `C:\Program Files\Google\Chrome\Application\chrome.exe`
- **n8n** rodando e acessível na rede (ex.: `http://192.168.0.231:5678`)
- Acesso à VPN/rede que alcança `https://ecommerce.grsa.com.br`

---

## 2. Instalação

Na pasta do projeto (`C:\Users\JFC\Desktop\API_GR`):

```powershell
npm install
```

Isso instala o `playwright` / `playwright-core` (controle do Chrome).

---

## 3. Arquivos do projeto

| Arquivo               | Função                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| `fuzzing.js`          | Faz login, pagina a API `autoForne`, gera `af_full_dump.json` e avisa o `sync-api`. |
| `sync-api.js`         | Servidor HTTP (porta 3005) que lê o dump e faz o POST para o webhook do n8n. |
| `af_full_dump.json`   | Saída gerada pelo `fuzzing.js` (~1 MB).                                 |
| `all_n8n_fluxo.json`  | Workflow do n8n a ser importado (contém o nó **Webhook Trigger**).     |

---

## 4. Configuração (variáveis de ambiente)

Nenhuma variável é obrigatória — há defaults. Para sobrescrever, defina antes de rodar:

| Variável            | Onde         | Default                                                        |
| ------------------- | ------------ | ------------------------------------------------------------- |
| `N8N_WEBHOOK_URL`   | `sync-api.js`| `http://192.168.0.231:5678/webhook-test/af-dump-trigger`      |
| `SYNC_PORT`         | `sync-api.js`| `3005`                                                        |
| `SYNC_API_URL`      | `fuzzing.js` | `http://localhost:3005/dump-ready`                            |

Exemplo (PowerShell):

```powershell
$env:N8N_WEBHOOK_URL = "http://192.168.0.231:5678/webhook/af-dump-trigger"
```

> ⚠️ Use o **IP real** da máquina do n8n (ex.: `192.168.0.231`). Nunca use
> `0.0.0.0` como destino — é apenas o endereço de *bind* que o n8n exibe, não um
> host acessível.

---

## 5. Configurar o webhook no n8n

1. Abra o n8n e importe o workflow **`all_n8n_fluxo.json`**
   (menu → *Import from File*).
2. Localize o nó **Webhook Trigger** (path: `af-dump-trigger`, método `POST`).

O n8n expõe **duas URLs diferentes** para o mesmo webhook:

| Modo          | URL                                                        | Quando usar                                                       |
| ------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| **Teste**     | `http://<ip>:5678/webhook-test/af-dump-trigger`            | Uso pontual. Registra **só após clicar "Execute workflow"** e vale **1 chamada** (janela ~120s). |
| **Produção**  | `http://<ip>:5678/webhook/af-dump-trigger`                 | Uso recorrente/automatizado. Exige o workflow **Active** (toggle no canto superior direito). |

### Recomendado para automação: modo Produção

1. Ative o toggle **Active** no canto superior direito do workflow (fica verde).
2. Aponte `N8N_WEBHOOK_URL` para a URL `/webhook/af-dump-trigger`.
3. Os dados de cada execução aparecem na aba **Executions** (workflow ativo roda
   em background e não mostra o resultado no canvas).

> O `sync-api.js` tem fallback: se a URL de produção responder **404** (workflow
> inativo), ele reenvia automaticamente para a URL `/webhook-test/`.

---

## 6. Como rodar

### Passo 1 — Subir o sync-api

```powershell
node sync-api.js
```

Saída esperada:

```
sync-api listening on http://localhost:3005
watched file: ...\af_full_dump.json
n8n webhook: http://192.168.0.231:5678/webhook-test/af-dump-trigger
```

O `sync-api` também **observa** a pasta: sempre que `af_full_dump.json` é
recriado, ele dispara o envio ao n8n automaticamente.

### Passo 2 — Rodar a coleta

Em outro terminal:

```powershell
node fuzzing.js
```

Fluxo: login → paginação das AFs → grava `af_full_dump.json` → chama o
`sync-api` (`POST /dump-ready`) → o `sync-api` envia ao n8n.

> Se estiver em **modo teste** no n8n, clique **"Execute workflow"** logo antes
> de rodar, pois a URL de teste só aceita 1 chamada por vez.

---

## 7. Endpoints do sync-api

| Método | Rota          | Descrição                                                        |
| ------ | ------------- | ---------------------------------------------------------------- |
| `GET`  | `/health`     | Status do serviço (arquivo e webhook configurados).             |
| `POST` | `/dump-ready` | Chamado pelo `fuzzing.js`; envia o dump indicado ao n8n.        |
| `POST` | `/trigger`    | Dispara manualmente o envio do `af_full_dump.json` atual.       |

Disparo manual:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3005/trigger
```

---

## 8. Solução de problemas

| Sintoma                                                        | Causa provável / solução                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `404 "webhook not registered"`                                | Modo teste expirou (clique "Execute workflow" antes) **ou** workflow não está **Active**. |
| POST some / connection refused                                | IP/porta errados. Confira o IP real do n8n e se a porta 5678 está acessível na rede.     |
| `Arquivo não encontrado`                                       | `af_full_dump.json` ainda não foi gerado — rode o `fuzzing.js` primeiro.                 |
| Login falha no `fuzzing.js`                                    | Cookie/sessão expirados ou fora da rede que alcança `ecommerce.grsa.com.br`.             |
| Nenhum dado no n8n com workflow **Active**                    | Normal — veja a aba **Executions**, não o canvas.                                        |

---

## 9. Segurança

O `fuzzing.js` contém **credenciais e cookie de sessão** em texto claro. Não
versione nem compartilhe este arquivo. Prefira mover credenciais para variáveis
de ambiente antes de subir para qualquer repositório.
