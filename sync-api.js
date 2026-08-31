// Sincroniza o arquivo af_full_dump.json com n8n via webhook 
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.SYNC_PORT || 3005);
const FILE_NAME = 'af_full_dump.json';
const FILE_PATH = path.join(__dirname, FILE_NAME);
const N8N_WEBHOOK = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/af-dump-trigger';

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
  const first = await sendJson(url, payload);
  if (first.statusCode >= 200 && first.statusCode < 300) {
    return { statusCode: first.statusCode, body: first.body, url };
  }

  const testUrl = toTestWebhookUrl(url);
  if (first.statusCode === 404 && testUrl !== url) {
    console.warn(`webhook ${url} devolveu 404 (workflow inativo?). Tentando URL de teste ${testUrl}`);
    const second = await sendJson(testUrl, payload);
    if (second.statusCode >= 200 && second.statusCode < 300) {
      return { statusCode: second.statusCode, body: second.body, url: testUrl };
    }
    throw new Error(`n8n webhook falhou. producao ${url} -> ${first.statusCode}; teste ${testUrl} -> ${second.statusCode}: ${second.body}`);
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

  return postToWebhook(N8N_WEBHOOK, payload);
}

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
        respondJson(res, 500, { ok: false, message: error.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/trigger') {
    try {
      const result = await dispatchFileToN8N(FILE_PATH, 'manual-trigger');
      respondJson(res, 200, { ok: true, message: 'Workflow disparado via webhook', result });
    } catch (error) {
      respondJson(res, 500, { ok: false, message: error.message });
    }
    return;
  }

  respondJson(res, 404, { ok: false, message: 'Endpoint não encontrado' });
});

server.listen(PORT, () => {
  console.log(`sync-api listening on http://localhost:${PORT}`);
  console.log(`watched file: ${FILE_PATH}`);
  console.log(`n8n webhook: ${N8N_WEBHOOK}`);

  fs.watch(__dirname, { persistent: true }, async (eventType, filename) => {
    if (filename !== FILE_NAME) return;
    if (eventType !== 'rename' && eventType !== 'change') return;

    // ignora o evento inicial de criação quando o arquivo ainda não está estável
    setTimeout(async () => {
      try {
        if (!fs.existsSync(FILE_PATH)) return;
        const result = await dispatchFileToN8N(FILE_PATH, 'file-watch');
        console.log('dump enviado ao webhook n8n:', result.statusCode);
      } catch (error) {
        console.error('watch trigger failed:', error.message);
      }
    }, 800);
  });
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
