// Fuzzing de coleta de  itens via encapsulamento de itens de paginação com filtro exato 
const { chromium } = require('playwright-core');
const fs = require('fs');
const http = require('http');

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "https://ecommerce.grsa.com.br";
const URL_LOGIN = 'https://ecommerce.grsa.com.br//#/product#Login';
const EMAIL = 'william.silva@grupocampanha.com.br';
const PASS = '1234567890';
const ITEMS_PER_PAGE = 40;
const MAX_PAGES = 500;

// ---- filtro exato fornecido (nao-canceladas) ----
const FILTER = [
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
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check']
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
  await page.waitForTimeout(8000);
  console.log('  URL p/ login:', page.url());

  const cookies = await context.cookies();
  const goc = (cookies.find(c => c.name === '__goc_session__') || {}).value || '';
  const phps = (cookies.find(c => c.name === 'PHPSESSID') || {}).value || '';
  console.log('  oauth-token:', otToken);
  console.log('  user-id:', userId);
  console.log('  PHPSESSID:', phps);
  console.log('  __goc_session__:', goc);

  // navegar para AutorizacaoFornecimento (garantir rota)
  await page.goto('https://ecommerce.grsa.com.br//#/product#AutorizacaoFornecimento', { waitUntil: 'domcontentloaded', timeout: 50000 });
  await page.waitForTimeout(7000);
  console.log('  URL AF:', page.url());

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

  console.log('\n=== RESULTADO ===');
  console.log('  AFs nao-canceladas (full dump):', allRows.length);
  console.log('  paginas percorridas:', pageNo);
  if (totalSemFiltro !== null) console.log('  total SEM filtro (itemsPerPage=1):', totalSemFiltro);

  const dump = {
    geradoEm: new Date().toISOString(),
    endpoint: BASE + '/backend/index.php/autoForne',
    filtro: FILTER,
    itemsPerPage: ITEMS_PER_PAGE,
    paginasPerCorridas: pageNo,
    totalAfNaoCanceladas: allRows.length,
    totalSemFiltro,
    amostraPrimeiros: allRows.slice(0, 20),
    afsCompletas: allRows,
    sessao: sessionFinal,
    requestsReaisCapturadosDuranteRuntime: realRunRequests
  };
  const dumpPath = __dirname + '\\af_full_dump.json';
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