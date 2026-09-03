// Sincroniza o arquivo af_full_dump.json postando em dois webhooks (n8n + Bubble)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.SYNC_PORT || 3005);
const FILE_NAME = 'af_full_dump.json';
// DUMP_DIR permite persistir o dump num volume no Docker; default = raiz do projeto (dev local).
const FILE_PATH = path.join(process.env.DUMP_DIR || __dirname, FILE_NAME);
// Dois destinos para o mesmo payload, disparados em paralelo:
//  - n8n: exige o workflow Active. Host 192.168.0.231 (use o IP real do n8n).
//  - Bubble: workflow do Bubble (version-test).
// Cada URL pode ser sobrescrita pela env correspondente.
const N8N_WEBHOOK = process.env.N8N_WEBHOOK_URL || 'http://192.168.0.231:5678/webhook/af-dump-trigger';
const BUBBLE_WEBHOOK = process.env.BUBBLE_WEBHOOK_URL || 'https://comprover.bubbleapps.io/api/1.1/wf/chave_gr';

// Gera um JWT (HMAC-SHA256) usando o JWT_SECRET da env. Claims basicos:
// iss (emissor), iat (emissao), exp (expiracao) + campos extras do payload.
function generateJWT(extraClaims = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET nao definido');

  const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const expiryHours = Number(process.env.JWT_EXPIRY_HOURS || 12);

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: 'api_gr',
    iat: now,
    exp: now + (expiryHours * 3600),
    ...extraClaims,
  };

  const encodedHeader = encode(header);
  const encodedPayload = encode(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

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

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
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

  throw new Error(`webhook status ${first.statusCode} em ${url}: ${first.body}`);
}

// Le o dump JSON e o dispara para os dois webhooks (n8n + Bubble).
// Lanca se o arquivo nao existir ou nao for JSON valido.
async function dispatchDump(filePath = FILE_PATH, source = 'sync-api') {
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

  const result = await dispatchToWebhooks(payload);
  lastDispatchAt = Date.now();
  return result;
}

// Posta o mesmo payload nos dois webhooks (n8n + Bubble) em paralelo. O n8n
// recebe o payload puro; o Bubble recebe dois campos de auth (ver abaixo).
// Cada envio e independente: usa allSettled para que a falha de um nao aborte o outro.
// So lanca erro se TODOS falharem; caso contrario devolve o resumo por destino.
async function dispatchToWebhooks(payload) {
  // Gera o JWT assinado (HS256) uma unica vez por dispatch, com data do dump.
  let jwtToken = null;
  try {
    jwtToken = generateJWT({
      geradoEm: payload.generatedAt || new Date().toISOString(),
      totalAf: payload.data?.totalAfColetadas || 0,
    });
  } catch (err) {
    console.warn('Aviso: JWT_SECRET nao configurado, enviando sem jwt:', err.message);
  }

  // Auth do Bubble (Caminho A): a condicao "Only when" do workflow chave_gr
  // checa `body's jwt contains <JWT_SECRET>`, ou seja, espera o secret em texto
  // no campo `jwt` (um shared secret, nao a validacao da assinatura). Entao o
  // campo `jwt` carrega o secret. O token assinado real segue em `jwtAssinado`
  // para o Caminho B (Bubble passa a validar a assinatura HS256 desse campo).
  const bubbleBody = { ...payload };
  if (process.env.JWT_SECRET) bubbleBody.jwt = process.env.JWT_SECRET;
  if (jwtToken) bubbleBody.jwtAssinado = jwtToken;

  const targets = [
    { name: 'n8n', url: N8N_WEBHOOK, body: payload },
    { name: 'bubble', url: BUBBLE_WEBHOOK, body: bubbleBody },
  ];
  const settled = await Promise.allSettled(
    targets.map(t => postToWebhook(t.url, t.body))
  );
  const results = targets.map((t, i) => {
    const s = settled[i];
    return s.status === 'fulfilled'
      ? { target: t.name, ok: true, statusCode: s.value.statusCode, url: s.value.url }
      : { target: t.name, ok: false, error: describeError(s.reason) };
  });
  if (results.every(r => !r.ok)) {
    throw new Error(`Todos os webhooks falharam: ${results.map(r => `${r.target} -> ${r.error}`).join('; ')}`);
  }
  return results;
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
    respondJson(res, 200, { ok: true, service: 'sync-api', file: FILE_PATH, webhooks: { n8n: N8N_WEBHOOK, bubble: BUBBLE_WEBHOOK } });
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
        // Segurança: ignora qualquer filePath vindo do cliente (evita ler e exfiltrar arquivos arbitrarios)
        const result = await dispatchDump(FILE_PATH, parsed.source || 'fuzzing.js');
        respondJson(res, 200, { ok: true, message: 'Dump enviado aos webhooks', result });
      } catch (error) {
        respondJson(res, 500, { ok: false, message: describeError(error) });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/trigger') {
    try {
      const result = await dispatchDump(FILE_PATH, 'manual-trigger');
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
  console.log(`bubble webhook: ${BUBBLE_WEBHOOK}`);

  // Debounce: o fs.watch do Windows emite varios eventos (rename+change) para a
  // mesma escrita. Guardamos um unico timer e o reiniciamos a cada evento, para
  // enviar o dump so uma vez, ~800ms depois do arquivo estabilizar.
  let watchTimer = null;
  // Observa a pasta real do dump (DUMP DIR quando definido; senao a raiz )
  fs.watch(path.dirname(FILE_PATH), { persistent: true }, (eventType, filename) => {
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
        const result = await dispatchDump(FILE_PATH, 'file-watch');
        console.log('dump enviado aos webhooks:', JSON.stringify(result));
      } catch (error) {
        console.error('watch trigger failed:', describeError(error));
      }
    }, 800);
  });
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
