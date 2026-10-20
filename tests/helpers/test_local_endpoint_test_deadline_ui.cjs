const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
<select id="adm-epProvider"><option value="">Generic URL</option></select>
<input id="adm-epUrl"><select id="adm-epKind"><option value="api">API</option><option value="proxy">Proxy</option></select>
<input id="adm-epApiKey"><select id="adm-epType"><option value="llm">LLM</option><option value="image">Image</option></select>
<button id="adm-epApiTestBtn">Test</button><button id="adm-epApiCancelTestBtn">Cancel</button>
<button id="adm-epAddBtn">Add</button><div id="adm-epApiMsg"></div>
<input id="adm-epLocalUrl"><input id="adm-epLocalApiKey">
<select id="adm-epLocalType"><option value="llm">LLM</option><option value="embedding">Embedding</option></select>
<button id="adm-epLocalTestBtn"><svg></svg>Test</button><button id="adm-epLocalAddBtn"><svg></svg>Add</button>
<div id="adm-epLocalMsg"></div><div id="adm-epList-local"></div><div id="adm-epList-api"></div>
<script type="module">import '/static/js/admin.js'; window.fixtureReady = true;</script></body>`
let mode = 'normal';
const pending = new Map();
let requestId = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/') return res.end(html);
  if (u.pathname === '/__mode') { mode = u.searchParams.get('value'); res.writeHead(204); return res.end(); }
  if (u.pathname === '/__state') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ pending: [...pending.keys()] })); }
  if (u.pathname === '/api/model-endpoints' && req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); return res.end('[]'); }
  if (u.pathname === '/api/model-endpoints/test' && req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      const id = ++requestId;
      const sendBody = () => {
        if (!res.destroyed) res.end(JSON.stringify({ online: true, status: 'ok', models: ['synthetic-model'] }));
        pending.delete(id);
      };
      if (mode === 'headers') {
        pending.set(id, () => {
          if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ online: true, models: ['synthetic-model'] })); }
          pending.delete(id);
        });
      } else if (mode === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders();
        pending.set(id, sendBody);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }); sendBody();
      }
      res.on('close', () => pending.delete(id));
    });
    return;
  }
  const file = path.resolve(repo, `.${u.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'text/plain');
  if (u.pathname === '/static/js/admin.js') return res.end(fs.readFileSync(file, 'utf8').replace(
    '/* ═══════════════════════════════════════════\n   PUBLIC API',
    'window.__testInitEndpointForm = initEndpointForm;\n/* ═══════════════════════════════════════════\n   PUBLIC API'));
  if (u.pathname === '/static/js/settings.js') return res.end('export default { refreshAiModelEndpoints() {}, initIntegrations() {}, open() {}, close() {} };');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.addInitScript(() => {
      const originalSetTimeout = window.setTimeout.bind(window);
      const originalClearTimeout = window.clearTimeout.bind(window);
      const active = new Set();
      window.__testActiveDeadlineTimers = active;
      window.setTimeout = (callback, delay, ...args) => {
        if (delay !== 60000) return originalSetTimeout(callback, delay, ...args);
        let id;
        id = originalSetTimeout(() => { active.delete(id); callback(...args); }, 400);
        active.add(id);
        return id;
      };
      window.clearTimeout = id => { active.delete(id); return originalClearTimeout(id); };
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let loopbackOnly = true;
    const errors = [];
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== origin) { loopbackOnly = false; return route.abort(); }
      return route.continue();
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') loopbackOnly = false; });
    await page.goto(origin);
    await page.waitForFunction(() => window.fixtureReady && window.__testInitEndpointForm);
    await page.evaluate(() => window.__testInitEndpointForm());
    const mode = async value => { await page.request.get(`${origin}/__mode?value=${value}`); };
    const startTest = async value => {
      await mode(value);
      await page.locator('#adm-epLocalTestBtn').click();
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending.length > 0 || !document.querySelector('#adm-epLocalTestBtn').disabled);
      if (value !== 'normal') await page.waitForFunction(() => window.__testActiveDeadlineTimers.size === 1);
    };
    const waitTimedOut = async () => page.waitForFunction(() => !document.querySelector('#adm-epLocalTestBtn').disabled && document.querySelector('#adm-epLocalMsg').textContent.includes('Test timed out.'));

    await page.locator('#adm-epLocalUrl').fill('http://127.0.0.1:19001/v1');
    await startTest('headers');
    await waitTimedOut();
    assert.equal(await page.locator('#adm-epLocalMsg').textContent(), 'Test timed out. Check the provider and try again.');
    assert.equal(await page.evaluate(() => window.__testActiveDeadlineTimers.size), 0);
    const headersTimeout = true;

    await page.locator('#adm-epLocalMsg').evaluate(el => { el.textContent = ''; });
    await startTest('body');
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending.length > 0);
    await waitTimedOut();
    assert.equal(await page.locator('#adm-epLocalMsg').textContent(), 'Test timed out. Check the provider and try again.');
    assert.equal(await page.evaluate(() => window.__testActiveDeadlineTimers.size), 0);
    const bodyTimeout = true;

    await page.locator('#adm-epLocalMsg').evaluate(el => { el.textContent = ''; });
    await startTest('normal');
    await page.waitForFunction(() => !document.querySelector('#adm-epLocalTestBtn').disabled && document.querySelector('#adm-epLocalMsg').textContent.includes('synthetic-model'));
    assert.match(await page.locator('#adm-epLocalMsg').textContent(), /synthetic-model/);
    assert.equal(await page.evaluate(() => window.__testActiveDeadlineTimers.size), 0);
    await page.waitForTimeout(450);
    assert.match(await page.locator('#adm-epLocalMsg').textContent(), /synthetic-model/);
    const successTimerCleared = true;
    const retrySuccess = bodyTimeout && successTimerCleared;

    await page.locator('#adm-epLocalMsg').evaluate(el => { el.textContent = ''; });
    await startTest('body');
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending.length > 0);
    assert.equal(await page.evaluate(() => window.__testActiveDeadlineTimers.size), 1);
    await page.locator('#adm-epLocalUrl').fill('http://127.0.0.1:19002/v1');
    await page.waitForFunction(() => !document.querySelector('#adm-epLocalTestBtn').disabled);
    assert.equal(await page.locator('#adm-epLocalMsg').textContent(), '');
    assert.equal(await page.evaluate(() => window.__testActiveDeadlineTimers.size), 0);
    const staleDraftTimeoutSuppressed = true;

    assert.deepEqual(errors, []);
    assert.equal(loopbackOnly, true);
    console.log(JSON.stringify({ headersTimeout, bodyTimeout, successTimerCleared, retrySuccess, staleDraftTimeoutSuppressed, pageErrors: errors.length, loopbackOnly }));
  } finally {
    try { if (browser) await browser.close(); }
    finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
