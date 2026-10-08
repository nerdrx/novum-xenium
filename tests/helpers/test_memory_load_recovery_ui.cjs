// Verify Memory list load errors, last-good preservation, retry, and stale response ownership.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
  <div id="memory-count-h2"></div><div id="memory-count"></div>
  <div id="memory-category-filters"></div><div id="memory-list"></div>
  <script type="module">
    import memory from '/static/js/memory.js';
    window.memoryModule = memory;
    window.fixtureErrors = [];
    window.fixtureToasts = [];
    window.fixtureReady = true;
  </script>
</body>`;
let plans = [{ status: 503, payload: { detail: 'fixture offline' } }];
let memoryCalls = 0;
const held = new Map();
const reply = (res, plan) => {
  res.writeHead(plan.status || 200, { 'Content-Type': 'application/json' });
  res.end(plan.raw || JSON.stringify(plan.payload ?? { memory: [] }));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname === '/__plan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { plans = JSON.parse(body); res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === '/__state') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ memoryCalls }));
  }
  if (url.pathname.startsWith('/__release/')) {
    const id = decodeURIComponent(url.pathname.slice('/__release/'.length));
    held.get(id)?.(); held.delete(id); res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/memory') {
    memoryCalls++;
    const plan = plans.shift() || { payload: { memory: [] } };
    if (plan.hold) { held.set(plan.id, () => reply(res, plan)); return; }
    return reply(res, plan);
  }
  if (url.pathname.startsWith('/api/prefs/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"value":true}');
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (url.pathname === '/static/js/ui.js') {
    return res.end(`export const autoResize=()=>{}, styledPrompt=async()=>null; export default {esc:s=>String(s??''),emptyStateIcon:()=>'',showError:m=>window.fixtureErrors.push(String(m)),showToast:m=>window.fixtureToasts.push(String(m))};`);
  }
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && window.memoryModule);
    await page.evaluate(() => window.memoryModule.loadMemories());
    await page.waitForSelector('#memory-load-error[role="alert"]');
    assert.match(await page.locator('#memory-load-error').textContent(), /could not be loaded/);
    assert.equal(await page.locator('.memory-item').count(), 0);
    assert.equal(await page.locator('.memory-empty').count(), 0,
      'initial failure must not masquerade as a genuine empty memory list');
    assert.equal(await page.locator('#memory-count-h2').textContent(), 'unavailable');

    const retry = () => page.evaluate(() => fetch('/__plan', {
      method: 'POST', body: JSON.stringify([{ payload: { memory: [{ id: 7, text: 'Last good memory', category: 'fact', source: 'manual', uses: 1 }] } }]),
    }));
    await retry();
    await page.locator('#memory-load-error button').click();
    await page.waitForSelector('.memory-item');
    assert.match(await page.locator('#memory-list').textContent(), /Last good memory/);

    await page.evaluate(() => fetch('/__plan', { method: 'POST', body: JSON.stringify([{ status: 503, payload: { detail: 'fixture outage' } }]) }));
    await page.evaluate(() => window.memoryModule.loadMemories());
    await page.waitForSelector('#memory-load-error[role="alert"]');
    assert.equal(await page.locator('.memory-item').count(), 1, 'HTTP failure preserves the last successful row');
    assert.match(await page.locator('#memory-load-error').textContent(), /last successful list is kept/);

    await page.evaluate(() => fetch('/__plan', { method: 'POST', body: JSON.stringify([{ payload: { memory: { malformed: true } } }]) }));
    await page.evaluate(() => window.memoryModule.loadMemories());
    await page.waitForSelector('#memory-load-error[role="alert"]');
    assert.equal(await page.locator('.memory-item').count(), 1, 'malformed 200 response preserves last good row');
    await page.evaluate(() => fetch('/__plan', { method: 'POST', body: JSON.stringify([{ payload: { memory: [] } }]) }));
    await page.locator('#memory-load-error button').click();
    await page.waitForFunction(() => !document.querySelector('#memory-load-error') && document.querySelector('.memory-empty')?.textContent.includes('No memories yet'));
    assert.equal(await page.locator('.memory-item').count(), 0, 'valid empty response remains a genuine empty state');

    await page.evaluate(() => fetch('/__plan', { method: 'POST', body: JSON.stringify([
      { id: 'obsolete', hold: true, status: 503, payload: { detail: 'obsolete failure' } },
      { payload: { memory: [{ id: 9, text: 'Newest response wins', category: 'fact', source: 'manual' }] } },
    ]) }));
    await page.evaluate(() => { window.obsoleteLoad = window.memoryModule.loadMemories(); });
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).memoryCalls >= 6);
    await page.evaluate(async () => { await window.memoryModule.loadMemories(); });
    await page.waitForFunction(() => document.querySelector('.memory-item')?.textContent.includes('Newest response wins'));
    await page.evaluate(() => fetch('/__release/obsolete'));
    await page.evaluate(() => window.obsoleteLoad);
    assert.match(await page.locator('#memory-list').textContent(), /Newest response wins/);
    assert.equal(await page.locator('#memory-load-error').count(), 0, 'obsolete failure cannot replace newer success');
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log('PASS: Memory initial failure, preservation, malformed payload, retry, valid empty, and stale response recovery');
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.closeAllConnections?.(); server.close(); process.exitCode = 1; });
