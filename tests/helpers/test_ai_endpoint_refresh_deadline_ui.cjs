const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || '/run/media/nerdrx/Lex/novum-xenium/node_modules/playwright');

const repo = path.resolve(__dirname, '../..');
const settingsSource = fs.readFileSync(path.join(repo, 'static/js/settings.js'), 'utf8');
const endpointList = [
  { id: 'fixture-a', name: 'Fixture A', is_enabled: true, online: true, models: ['chat-a', 'utility-a', 'research-a'], model_type: 'chat' },
];
const expandedEndpointList = [...endpointList, { id: 'fixture-b', name: 'Fixture B', is_enabled: true, online: true, models: ['chat-b'], model_type: 'chat' }];
const settings = {
  default_endpoint_id: 'fixture-a', default_model: 'chat-a',
  teacher_enabled: true, teacher_endpoint_id: 'fixture-a', teacher_model: 'chat-a',
  utility_endpoint_id: 'fixture-a', utility_model: 'utility-a', utility_model_fallbacks: [], utility_reasoning_effort: '',
  vision_enabled: true, vision_endpoint_id: 'fixture-a', vision_model: 'chat-a', vision_model_fallbacks: [],
  research_endpoint_id: 'fixture-a', research_model: 'research-a', research_max_tokens: 4096,
  research_extraction_timeout_seconds: 90, research_extraction_concurrency: 3, research_run_timeout_seconds: 3600,
  research_search_provider: 'searxng', search_provider: 'disabled', search_api_key: '',
  tts_provider: 'disabled', stt_provider: 'disabled',
};
const inventory = { items: [{ endpoint_id: 'fixture-a', offline: false, models: ['chat-a', 'utility-a', 'research-a'], models_metadata: {} }] };
const requests = [];
const requestLog = [];
let relevantPending = 0;
let lastRelevantAt = Date.now();
let heldResponse = null;
let holdNextEndpoint = null;
const externalRequests = [];
const pageErrors = [];
const sendJson = (res, body, status = 200) => {
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requestLog.push(`${req.method} ${url.pathname}${url.search}`);
  const isRelevantRead = req.method === 'GET' && ['/api/auth/settings', '/api/models', '/api/model-endpoints'].includes(url.pathname);
  if (isRelevantRead) {
    relevantPending++;
    lastRelevantAt = Date.now();
    res.on('finish', () => { relevantPending--; lastRelevantAt = Date.now(); });
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8').replaceAll('{{CSP_NONCE}}', 'fixture-nonce'));
  }
  if (url.pathname === '/static/js/settings.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    return res.end(settingsSource);
  }
  if (url.pathname === '/api/auth/status') return sendJson(res, { username: 'synthetic', is_admin: true, privileges: {} });
  if (url.pathname === '/api/auth/features') return sendJson(res, {});
  if (url.pathname === '/api/auth/settings' && req.method === 'GET') return sendJson(res, settings);
  if (url.pathname === '/api/auth/settings' && req.method === 'POST') {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => body += chunk);
    req.on('end', () => sendJson(res, { ok: true }));
    return;
  }
  if (url.pathname === '/api/model-endpoints' && req.method === 'GET') {
    const entry = { res, ended: false, closed: false, headersSent: false, phase: holdNextEndpoint };
    requests.push(entry);
    res.on('finish', () => { entry.ended = true; });
    res.on('close', () => { entry.closed = true; entry.aborted = !entry.ended; });
    if (holdNextEndpoint) {
      holdNextEndpoint = null;
      heldResponse = entry;
      if (entry.phase === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.flushHeaders();
        entry.headersSent = true;
      }
      return;
    }
    return sendJson(res, expandedEndpointList);
  }
  if (url.pathname === '/api/models') return sendJson(res, inventory);
  if (url.pathname === '/api/default-chat') return sendJson(res, {});
  if (url.pathname.startsWith('/api/')) return sendJson(res, {});
  const relative = decodeURIComponent(url.pathname.replace(/^\/static\//, ''));
  const root = path.resolve(repo, 'static');
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('fixture not found'); }
  const type = file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
const waitFor = async (predicate, label, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const waitForPage = async (page, predicate, label, timeout = 5000) => {
  await page.waitForFunction(predicate, null, { polling: 50, timeout });
  return label;
};
const apiIdle = async () => {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    if (relevantPending === 0 && Date.now() - lastRelevantAt >= 350) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Initial settings/inventory reads did not settle: pending=${relevantPending}, requests=${JSON.stringify(requestLog.filter(item => /api\/(auth\/settings|models|model-endpoints)/.test(item)))}`);
};
(async () => {
  let browser;
  let context;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-service-worker'] });
    context = await browser.newContext();
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { externalRequests.push(url.href); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window._isAdmin === true);
    await page.locator('#user-bar-settings').click();
    await page.locator('#settings-modal:not(.hidden)').waitFor({ state: 'visible' });
    await page.locator('[data-settings-tab="ai"]').click();
    await page.waitForFunction(() => document.querySelector('#set-defaultEpSelect')?.value === 'fixture-a' && document.querySelector('#set-defaultModelSelect')?.value === 'chat-a');
    await waitFor(() => requests.length > 0 && requests.every(item => item.ended), 'startup endpoint reads completed');
    await apiIdle();
    const initialRequests = requests.length;
    const before = await page.evaluate(() => ({
      endpoint: document.querySelector('#set-defaultEpSelect').value,
      model: document.querySelector('#set-defaultModelSelect').value,
    }));
    assert.deepEqual(before, { endpoint: 'fixture-a', model: 'chat-a' });
    const settingsModuleRequestsBefore = requestLog.filter(item => item === 'GET /static/js/settings.js').length;
    await page.clock.install();
    const timeoutCases = [];
    for (const phase of ['headers', 'body']) {
      const requestStart = requests.length;
      holdNextEndpoint = phase;
      await page.evaluate(async () => {
        const module = await import('/static/js/settings.js');
        window.__refreshProbe = { firstDone: false, secondDone: false };
        window.__refreshFirst = module.refreshAiModelEndpoints().then(() => { window.__refreshProbe.firstDone = true; });
        window.__refreshSecond = module.refreshAiModelEndpoints().then(() => { window.__refreshProbe.secondDone = true; });
      });
      await waitFor(() => !!heldResponse && heldResponse.phase === phase, `${phase} response held`);
      assert.equal(requests.length, requestStart + 1, 'coalesced calls share exactly one endpoint request');
      assert.equal(heldResponse.headersSent, phase === 'body');
      assert.equal(heldResponse.ended, false);
      const timedOutRequest = heldResponse;
      await page.clock.fastForward(15000);
      await waitForPage(page, () => window.__refreshProbe.firstDone && window.__refreshProbe.secondDone, `${phase} timeout settles both callers`);
      await waitFor(() => timedOutRequest.closed, `${phase} timeout closes the HTTP response`);
      assert.equal(timedOutRequest.ended, false, 'timeout aborts rather than consuming the held response');
      assert.equal(timedOutRequest.aborted, true);
      assert.equal(requests.length, requestStart + 1, 'timeout does not automatically retry');
      assert.deepEqual(await page.evaluate(() => ({ endpoint: document.querySelector('#set-defaultEpSelect').value, model: document.querySelector('#set-defaultModelSelect').value })), before, 'timeout preserves current endpoint/model selection');

      const retryStart = requests.length;
      await page.evaluate(async () => {
        const module = await import('/static/js/settings.js');
        await module.refreshAiModelEndpoints();
      });
      assert.equal(requests.length, retryStart + 1, 'explicit retry starts after timed-out refresh clears its latch');
      await waitFor(() => requests.at(-1).ended, `${phase} explicit retry completes`);
      await waitForPage(page, () => Array.from(document.querySelector('#set-defaultEpSelect').options).some(option => option.value === 'fixture-b'), `${phase} retry applies inventory`);
      assert.deepEqual(await page.evaluate(() => ({ endpoint: document.querySelector('#set-defaultEpSelect').value, model: document.querySelector('#set-defaultModelSelect').value })), before, 'successful retry preserves current endpoint/model');
      timeoutCases.push({ phase, coalescedRequestCount: 1, aborted: timedOutRequest.aborted, explicitRetryStarted: true });
    }
    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join('\n')}`);
    assert.deepEqual(externalRequests, []);
    const scriptRequests = requestLog.filter(item => item === 'GET /static/js/settings.js').length;
    assert.equal(scriptRequests, settingsModuleRequestsBefore, 'same module URL is reused without a query or duplicate network import');
    console.log(JSON.stringify({
      pass: true,
      sourceSha256: crypto.createHash('sha256').update(settingsSource).digest('hex'),
      settingsModuleUrl: '/static/js/settings.js (same URL loaded by static/index.html and relative imports)',
      startupEndpointRequestCount: initialRequests,
      timeoutCases,
      preservedSelection: before,
      retryStartedAfterSettlement: timeoutCases.every(item => item.explicitRetryStarted),
      externalRequests,
      pageErrors,
      settingsSourceRequests: scriptRequests,
      mode: 'ai-endpoint-refresh-deadline',
    }, null, 2));
  } finally {
    if (heldResponse && !heldResponse.res.writableEnded && !heldResponse.res.destroyed) heldResponse.res.end(JSON.stringify(expandedEndpointList));
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
