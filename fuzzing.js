// Fuzzing de coleta de  itens via encapsulamento de itens de paginação com filtro exato 
const { chromium } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Caminho do navegador. Default para o Chrome do Windows (dev local); no
// container Docker/Linux, defina CHROME_PATH=/usr/bin/chromium.
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "https://ecommerce.grsa.com.br";
const URL_LOGIN = 'https://ecommerce.grsa.com.br//#/product#Login';
const EMAIL = 'william.silva@grupocampanha.com.br';
const PASS = '1234567890';
const ITEMS_PER_PAGE = 40;
const MAX_PAGES = 500;

// Janela de coleta: so as AFs com data programada de entrega (DTPROGENTAF) entre
// hoje 00:00 e hoje+DIAS_PARA_FRENTE 23:59. O intervalo vai no proprio FILTER da
// API (operator BETWEEN), entao a API ja devolve so o periodo (nao pagina tudo).
const DIAS_PARA_FRENTE = 6;
const CAMPO_DATA = 'DTPROGENTAF';

// Converte "28/09/2026 00:00:00" (DD/MM/YYYY) para Date local. null se invalido.
function parseDataBR(valor) {
  const dia = String(valor || '').split(' ')[0];
  const [d, m, y] = dia.split('/');
  if (!d || !m || !y) return null;
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// Formata um Date como "DD/MM/YYYY" (formato aceito pelo filtro da API).
function formatDataBR(date) {
  const p = n => String(n).padStart(2, '0');
  return `${p(date.getDate())}/${p(date.getMonth() + 1)}/${date.getFullYear()}`;
}

// Calcula a janela [hoje, hoje+DIAS_PARA_FRENTE] uma unica vez (so a data, sem
// hora — a API filtra por DD/MM/YYYY; o horario fica por conta do crontab).
const JANELA_INICIO = new Date(); JANELA_INICIO.setHours(0, 0, 0, 0);
const JANELA_FIM = new Date(JANELA_INICIO);
JANELA_FIM.setDate(JANELA_FIM.getDate() + DIAS_PARA_FRENTE);

// Rede de seguranca: reaplica a janela localmente caso a API ignore o BETWEEN.
function filtrarPorJanela(rows) {
  return rows.filter(r => {
    const dt = parseDataBR(r[CAMPO_DATA]);
    return dt && dt >= JANELA_INICIO && dt <= JANELA_FIM;
  });
}

// ---- filtro exato fornecido (nao-canceladas) + intervalo de data (server-side) ----
const FILTER = [
  { name: CAMPO_DATA, value: [formatDataBR(JANELA_INICIO), formatDataBR(JANELA_FIM)], operator: "BETWEEN", isCustomFilter: true },
  { name: "STATUS", value: ["N"], operator: "IN", isCustomFilter: true },
  { name: "IDSITUATENDIMENTOAF", value: ["N"], operator: "IN", isCustomFilter: true },
  { name: "AFCANCELADA", value: ["N"], operator: "IN", isCustomFilter: true }
];
const SYNC_API_URL = process.env.SYNC_API_URL || 'http://localhost:3005/dump-ready';
const ORIGIN = {
  containerName: "AutorizacaoFornecimento",
  widgetName: "zhFilterPreferencesSelectConditions",
  containerLabel: "Autorização de Fornecimento",
  widgetLabel: "Filtro"
};

function buildBody(page) {
  return JSON.stringify({
    disableLoader: false,
    filter: FILTER,
    page,
    itemsPerPage: ITEMS_PER_PAGE,
    requestType: "FilterData",
    origin: ORIGIN
  });
}

function notifySyncApi(filePath) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      source: 'fuzzing.js',
      filePath,
      generatedAt: new Date().toISOString()
    });

    const url = new URL(SYNC_API_URL);
    const req = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk.toString());
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body });
        } else {
          reject(new Error(`sync-api status ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  // Em container Linux (root) o Chromium precisa de --no-sandbox e de
  // --disable-dev-shm-usage (o /dev/shm padrao do Docker e pequeno demais).
  const containerArgs = process.platform === 'win32' ? [] : ['--no-sandbox', '--disable-dev-shm-usage'];
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', ...containerArgs]
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    locale: 'pt-BR',
    viewport: { width: 1366, height: 768 }
  });
  await context.addCookies([{ name: '__goc_session__', value: 'zgyinkpvxsymcsrgykrpbpojrcnmetap', url: BASE }]);
  const page = await context.newPage();

  // ---- captura token/sessao ----
  let otToken = '', userId = '';
  const realRunRequests = [];
  page.on('request', req => {
    const u = req.url();
    if (!u.includes('/backend/index.php')) return;
    const h = req.headers();
    const g = k => { const kk = Object.keys(h).find(x => x.toLowerCase() === k.toLowerCase()); return kk ? h[kk] : ''; };
    if (!otToken) otToken = g('oauth-token') || '';
    if (!userId) userId = g('user-id') || '';
    if (u.includes('/autoForne')) {
      let body = ''; try { body = req.postData() || ''; } catch (e) {}
      realRunRequests.push({ url: u.replace(BASE, ''), body });
    }
  });

  // ---------- LOGIN ----------
  console.log('=== LOGIN ===');
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 50000 });
  await page.waitForTimeout(2500);
  await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded', timeout: 50000 });
  await page.waitForTimeout(3000);
  await page.locator('input[type=email], input[name*=mail], input[placeholder*=mail i]').first().fill(EMAIL);
  await page.locator('input[type=password]').first().fill(PASS);
  await page.locator('input[type=password]').first().press('Enter');

  // Espera o login concluir: o backend so seta o PHPSESSID quando autentica de
  // fato. Poll ate 30s em vez de delay fixo (que as vezes estoura antes da sessao).
  let phps = '';
  for (let i = 0; i < 30 && !phps; i++) {
    await page.waitForTimeout(1000);
    const cks = await context.cookies();
    phps = (cks.find(c => c.name === 'PHPSESSID') || {}).value || '';
  }
  console.log('  URL p/ login:', page.url());

  const cookies = await context.cookies();
  const goc = (cookies.find(c => c.name === '__goc_session__') || {}).value || '';
  console.log('  oauth-token:', otToken);
  console.log('  user-id:', userId);
  console.log('  PHPSESSID:', phps);
  console.log('  __goc_session__:', goc);

  // navegar para AutorizacaoFornecimento (garantir rota)
  await page.goto('https://ecommerce.grsa.com.br//#/product#AutorizacaoFornecimento', { waitUntil: 'domcontentloaded', timeout: 50000 });
  await page.waitForTimeout(7000);
  console.log('  URL AF:', page.url());

  // TRAVA: sessao valida exige oauth-token E PHPSESSID. Sem qualquer um a API
  // devolve 0 pra tudo -> aborta antes de gravar/enviar um dump inutil.
  for (let i = 0; i < 15 && !otToken; i++) await page.waitForTimeout(1000);
  if (!otToken || !phps) {
    await browser.close();
    throw new Error(`Login incompleto (oauth-token=${otToken ? 'ok' : 'VAZIO'}, PHPSESSID=${phps ? 'ok' : 'VAZIO'}). Abortando sem gravar dump — rode novamente ou verifique credenciais/VPN.`);
  }
  console.log('  sessao confirmada: oauth-token', otToken.slice(0, 8) + '... | PHPSESSID', phps.slice(0, 8) + '...');

  // ---------- REUTILIZACAO: fetch via sessao do browser (igual origem, token) ----------
  console.log('\n=== REUTILIZACAO (fetch na pagina, sessao + token) paginada ===');
  const sessionFinal = {
    oauthToken: otToken,
    userId,
    PHPSESSID: phps,
    gocSession: goc,
    cookies
  };

  const allRows = [];
  let pageNo = 1;
  let totalSemFiltro = null;

  // primeira chamada SEM filtro para comparacao (contagem total da mesma query, sem o filtro de nao-canceladas)
  const totalRes = await page.evaluate(({ body, ot, uid }) => {
    return fetch("/backend/index.php/autoForne", {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'OAuth-Token': ot, 'User-Id': uid },
      body
    }).then(async res => ({ status: res.status, text: await res.text() }));
  }, { body: JSON.stringify({ disableLoader: false, filter: [], page: 1, itemsPerPage: 1, requestType: "FilterData", origin: ORIGIN }), ot: otToken, uid: userId });
  try {
    const j = JSON.parse(totalRes.text);
    if (j.dataset && j.dataset.autoForne) totalSemFiltro = j.dataset.autoForne.length;
  } catch (e) {}

  // paginar com o filtro exato
  while (pageNo <= MAX_PAGES) {
    const bodyStr = buildBody(pageNo);
    const r = await page.evaluate(({ body, ot, uid }) => {
      return fetch("/backend/index.php/autoForne", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'OAuth-Token': ot, 'User-Id': uid },
        body
      }).then(async res => ({ status: res.status, text: await res.text() }));
    }, { body: bodyStr, ot: otToken, uid: userId });
    console.log(`  pagina ${pageNo}: status=${r.status}`);
    if (r.status !== 200) { console.log('  ! status != 200, parando'); break; }
    let j;
    try { j = JSON.parse(r.text); } catch (e) { console.log('  ! JSON invalido, parando'); break; }
    let rows = [];
    try { rows = (j.dataset && j.dataset.autoForne) || []; } catch (e) {}
    allRows.push(...rows);
    if (rows.length === 0 || rows.length < ITEMS_PER_PAGE) {
      console.log(`  ultima pagina (${rows.length} na pagina ${pageNo})`);
      break;
    }
    pageNo++;
  }

  // a API ja filtra por BETWEEN; reaplica a janela local por seguranca
  const afsJanela = filtrarPorJanela(allRows);

  console.log('\n=== RESULTADO ===');
  console.log(`  janela ${CAMPO_DATA}: ${formatDataBR(JANELA_INICIO)} ate ${formatDataBR(JANELA_FIM)}`);
  console.log('  AFs retornadas pela API (ja filtradas):', allRows.length);
  console.log('  AFs apos rede de seguranca local:', afsJanela.length);
  console.log('  paginas percorridas:', pageNo);
  if (totalSemFiltro !== null) console.log('  total SEM filtro (itemsPerPage=1):', totalSemFiltro);

  const dump = {
    geradoEm: new Date().toISOString(),
    endpoint: BASE + '/backend/index.php/autoForne',
    filtro: FILTER,
    janela: { campo: CAMPO_DATA, diasParaFrente: DIAS_PARA_FRENTE },
    itemsPerPage: ITEMS_PER_PAGE,
    paginasPerCorridas: pageNo,
    totalAfColetadas: allRows.length,
    totalAfNaoCanceladas: afsJanela.length,
    totalSemFiltro,
    amostraPrimeiros: afsJanela.slice(0, 20),
    afsCompletas: afsJanela,
    sessao: sessionFinal,
    requestsReaisCapturadosDuranteRuntime: realRunRequests
  };
  const dumpPath = path.join(process.env.DUMP_DIR || __dirname, 'af_full_dump.json');
  fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf8');
  console.log('  FULL DUMP salvo: af_full_dump.json (', fs.statSync(dumpPath).size, 'bytes )');

  try {
    const syncResult = await notifySyncApi(dumpPath);
    console.log('  sync-api ->', syncResult.statusCode, syncResult.body);
  } catch (error) {
    console.warn('  sync-api notify failed:', error.message);
  }

  await browser.close();
})().catch(e => { console.error('ERRO:', e); process.exit(1); });