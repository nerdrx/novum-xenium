const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const calls = [];
const plannedStatuses = [];
let savedName = 'Synthetic photo';
const html = `<!doctype html><meta charset="utf-8"><body><div id="toast"></div>
<script type="module">
  import ui from '/static/js/ui.js?v=20260916largetoolscroll1';
  import * as gallery from '/static/js/gallery.js';
  window.fixture = { toasts: [], errors: [], ready: false };
  ui.showToast = text => window.fixture.toasts.push(String(text));
  ui.showError = text => window.fixture.errors.push(String(text));
  window.gallery = gallery;
  gallery.openGallery();
  window.fixture.ready = true;
</script></body>`;
function send(res, status, value, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(value) : value);
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') return send(res, 200, html, 'text/html');
  if (url.pathname === '/__state') return send(res, 200, { calls, savedName });
  if (url.pathname === '/__plan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { plannedStatuses.push(...JSON.parse(body).statuses); res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === '/api/gallery/albums') return send(res, 200, { albums: [] });
  if (url.pathname === '/api/gallery/library') return send(res, 200, {
    items: [{ id: 'synthetic-photo', url: '/fixture.svg', filename: 'synthetic.svg', prompt: savedName, model: 'Synthetic', created_at: '2026-01-01T00:00:00Z' }],
    total: 1, total_tagged: 0, tags: [], models: ['Synthetic'],
  });
  if (url.pathname === '/fixture.svg') return send(res, 200, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#584577"/></svg>', 'image/svg+xml');
  if (url.pathname === '/api/gallery/synthetic-photo/rename' && req.method === 'POST') {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const payload = JSON.parse(raw);
      const status = plannedStatuses.length ? plannedStatuses.shift() : 200;
      calls.push({ ...payload, status });
      if (status < 400) savedName = payload.name;
      send(res, status, status < 400 ? { ok: true, name: payload.name } : { detail: 'Synthetic save failed' });
    });
    return;
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(path.join(repo, 'static') + path.sep) || !fs.existsSync(file)) return send(res, 404, {});
  const type = file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(7000);
    const pageErrors = [];
    let externalRequests = 0;
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin !== origin) {
        externalRequests++;
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.fixture?.ready);
    const card = page.locator('.gallery-card-open[data-id="synthetic-photo"]');
    await card.waitFor();
    await card.click();
    const input = page.locator('#gallery-detail-name-input');
    await input.waitFor({ state: 'visible' });
    const state = () => page.evaluate(async () => fetch('/__state').then(r => r.json()));

    await input.fill('Enter rename');
    await input.press('Enter');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).calls.length === 1);
    await page.waitForFunction(() => window.fixture.toasts.filter(text => text === 'Renamed').length === 1);
    await page.waitForLoadState('networkidle');
    let snapshot = await state();

    assert.deepEqual(snapshot.calls.slice(0, 1), [{ name: 'Enter rename', status: 200 }]);
    assert.equal(snapshot.savedName, 'Enter rename');

    await input.fill('Blur-only control');
    await input.press('Tab');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).calls.length === 2);
    await page.waitForFunction(() => window.fixture.toasts.filter(text => text === 'Renamed').length === 2);
    snapshot = await state();
    assert.deepEqual(snapshot.calls[1], { name: 'Blur-only control', status: 200 });
    assert.equal(snapshot.savedName, 'Blur-only control');

    const callCountBeforeUnchanged = snapshot.calls.length;
    await input.focus();
    await input.fill('Blur-only control');
    await input.press('Enter');
    await page.waitForLoadState('networkidle');
    snapshot = await state();
    assert.equal(snapshot.calls.length, callCountBeforeUnchanged, 'unchanged value does not POST');
    assert.equal((await page.evaluate(() => window.fixture.toasts.filter(text => text === 'Renamed').length)), 2, 'unchanged value does not toast');

    await page.evaluate(() => fetch('/__plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ statuses: [503, 200] }) }));
    await input.focus();
    await input.fill('Retry rename');
    await input.press('Tab');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).calls.length === 3);
    await page.waitForFunction(() => window.fixture.errors.includes('Failed to rename'));
    assert.equal(await input.inputValue(), 'Retry rename', 'failed save preserves typed value for retry');
    await input.focus();
    await input.press('Tab');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).calls.length === 4);
    await page.waitForFunction(() => window.fixture.toasts.filter(text => text === 'Renamed').length === 3);
    snapshot = await state();
    assert.deepEqual(snapshot.calls.slice(2), [{ name: 'Retry rename', status: 503 }, { name: 'Retry rename', status: 200 }]);
    assert.equal(snapshot.savedName, 'Retry rename');
    assert.deepEqual(pageErrors, []);
    assert.equal(externalRequests, 0, 'fixture blocked any request outside its loopback origin');
    console.log(JSON.stringify({
      enter: { posts: snapshot.calls.slice(0, 1), successToasts: 1 },
      blurOnlyControl: { posts: [snapshot.calls[1]], successToasts: 1 },
      unchangedValue: { posts: 0, toasts: 0 },
      failureAndRetry: { posts: snapshot.calls.slice(2), errors: 1, finalSavedName: snapshot.savedName, typedValuePreserved: true },
      pageErrors,
      externalRequests,
      pass: true,
    }, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
