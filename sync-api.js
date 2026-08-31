// Sincroniza o arquivo af_full_dump.json com n8n via webhook 
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.SYNC_PORT || 3005);
const FILE_NAME = 'af_full_dump.json';
// DUMP_DIR permite persistir o dump num volume no Docker; default = raiz do projeto (dev local).
const FILE_PATH = path.join(process.env.DUMP_DIR || __dirname, FILE_NAME);
const N8N_WEBHOOK = process.env.N8N_WEBHOOK_URL || 'http://192.168.0.231:5678/webhook/af-dump-trigger';

// Extrai uma mensagem util de qualquer erro. Em Node moderno, uma falha de
// conexao vem como AggregateError com .message vazio e os erros reais em
// .errors[] (ex.: localhost resolvido para IPv6 ::1 + IPv4 127.0.0.1). Sem
// isto, o sync-api reportava {"ok":false,"message":""} e escondia a causa.
function describeError(err) {
  if (!err) return 'erro desconhecido';
  if (err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length) {
    return err.errors.map(describeError).join('; ');
  }
  const parts = [];
  if (err.code) parts.push(err.code);
  if (err.message) parts.push(err.message);
  if (err.address) parts.push(`${err.address}${err.port ? ':' + err.port : ''}`);
  return parts.length ? parts.join(' ') : String(err);
}

function sendJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => {
        data += chunk.toString();
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Alterna entre a URL de producao (/webhook/) e a de teste (/webhook-test/) do n8n.
function toTestWebhookUrl(url) {
  return url.includes('/webhook-test/')
    ? url
    : url.replace('/webhook/', '/webhook-test/');
}

// Posta o payload; se a URL de producao devolver 404 (webhook nao registrado
// porque o workflow nao esta ativo), tenta automaticamente a URL de teste
// usada pelo botao "Listen for test event" do editor n8n.
async function postToWebhook(url, payload) {
  // Tenta a URL de producao. Uma falha de conexao (n8n fora do ar, host/porta
  // errados, IPv6) rejeita a promise; captura para poder cair no fallback de
  // teste com uma mensagem legivel em vez de estourar com .message vazio.
  let first;
  try {
    first = await sendJson(url, payload);
  } catch (err) {
    first = { statusCode: 0, body: describeError(err) };
  }

  if (first.statusCode >= 200 && first.statusCode < 300) {
    return { statusCode: first.statusCode, body: first.body, url };
  }

  // 404 = workflow inativo; statusCode 0 = falha de conexao. Nos dois casos vale
  // tentar a URL de teste (/webhook-test/) que o editor do n8n mantem ouvindo.
  const testUrl = toTestWebhookUrl(url);
  const shouldRetry = first.statusCode === 404 || first.statusCode === 0;
  if (shouldRetry && testUrl !== url) {
    console.warn(`webhook ${url} falhou (${first.statusCode}: ${first.body}). Tentando URL de teste ${testUrl}`);
    let second;
    try {
      second = await sendJson(testUrl, payload);
    } catch (err) {
      second = { statusCode: 0, body: describeError(err) };
    }
    if (second.statusCode >= 200 && second.statusCode < 300) {
      return { statusCode: second.statusCode, body: second.body, url: testUrl };
    }
    throw new Error(`n8n webhook falhou. producao ${url} -> ${first.statusCode}: ${first.body}; teste ${testUrl} -> ${second.statusCode}: ${second.body}`);
  }

  throw new Error(`n8n webhook status ${first.statusCode} em ${url}: ${first.body}`);
}

// Dispara o envio do arquivo JSON para webhook n8n. Se o arquivo nao existir ou nao for JSON valido 
async function dispatchFileToN8N(filePath = FILE_PATH, source = 'sync-api') {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo não encontrado: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  let data;

  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Arquivo inválido JSON em ${filePath}: ${error.message}`);
  }

  const payload = {
    source,
    fileName: FILE_NAME,
    filePath,
    sizeBytes: stat.size,
    generatedAt: new Date().toISOString(),
    data,
  };

  const result = await postToWebhook(N8N_WEBHOOK, payload);
  lastDispatchAt = Date.now();
  return result;
}

// Marca quando o ultimo envio ao n8n aconteceu (qualquer origem). O watcher usa
// isto para nao reenviar o dump que o fuzzing.js ja notificou via /dump-ready.
let lastDispatchAt = 0;
const WATCH_COOLDOWN_MS = 5000;

function respondJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    respondJson(res, 200, { ok: true, service: 'sync-api', file: FILE_PATH, webhook: N8N_WEBHOOK });
    return;
  }

  if (req.method === 'POST' && req.url === '/dump-ready') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const filePath = parsed.filePath || FILE_PATH;
        const result = await dispatchFileToN8N(filePath, parsed.source || 'fuzzing.js');
        respondJson(res, 200, { ok: true, message: 'Arquivo enviado ao n8n', result });
      } catch (error) {
        respondJson(res, 500, { ok: false, message: describeError(error) });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/trigger') {
    try {
      const result = await dispatchFileToN8N(FILE_PATH, 'manual-trigger');
      respondJson(res, 200, { ok: true, message: 'Workflow disparado via webhook', result });
    } catch (error) {
      respondJson(res, 500, { ok: false, message: describeError(error) });
    }
    return;
  }

  respondJson(res, 404, { ok: false, message: 'Endpoint não encontrado' });
});

server.listen(PORT, () => {
  console.log(`sync-api listening on http://localhost:${PORT}`);
  console.log(`watched file: ${FILE_PATH}`);
  console.log(`n8n webhook: ${N8N_WEBHOOK}`);

  // Debounce: o fs.watch do Windows emite varios eventos (rename+change) para a
  // mesma escrita. Guardamos um unico timer e o reiniciamos a cada evento, para
  // enviar o dump so uma vez, ~800ms depois do arquivo estabilizar.
  let watchTimer = null;
  fs.watch(__dirname, { persistent: true }, (eventType, filename) => {
    if (filename !== FILE_NAME) return;
    if (eventType !== 'rename' && eventType !== 'change') return;

    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(async () => {
      watchTimer = null;
      // Se o fuzzing.js ja disparou via /dump-ready ha pouco, nao reenvia o
      // mesmo dump (evita execucao duplicada e o 2o hit na URL de teste do n8n).
      if (Date.now() - lastDispatchAt < WATCH_COOLDOWN_MS) {
        console.log('watch: envio recente via /dump-ready, pulando reenvio.');
        return;
      }
      try {
        if (!fs.existsSync(FILE_PATH)) return;
        const result = await dispatchFileToN8N(FILE_PATH, 'file-watch');
        console.log('dump enviado ao webhook n8n:', result.statusCode);
      } catch (error) {
        console.error('watch trigger failed:', describeError(error));
      }
    }, 800);
  });
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
