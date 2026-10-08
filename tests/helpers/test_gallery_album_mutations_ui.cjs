// Failure recovery for real Gallery album controls with fixture-only HTTP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let albums = [
  { id: 'alpha', name: 'Alpha', count: 0 },
  { id: 'beta', name: 'Beta', count: 0 },
  { id: 'gamma', name: 'Gamma', count: 0 },
  { id: 'delta', name: 'Delta', count: 0 },
];
const plans = new Map();
const calls = [];
const networkFailures = new Set();
const attempts = [];
const html = `<!doctype html><meta charset="utf-8"><body>
<script type="module">
  import ui from '/static/js/ui.js';
  import gallery from '/static/js/gallery.js';
  window.fixture = { errors: [], toasts: [], prompts: [] };
  ui.showError = text => window.fixture.errors.push(String(text));
  ui.showToast = text => window.fixture.toasts.push(String(text));
  ui.styledPrompt = async () => window.fixture.prompts.shift() || null;
  ui.styledConfirm = async () => true;
  window.prompt = () => window.fixture.prompts.shift() || null;
  window.gallery = gallery;
  gallery.openGallery();
  window.fixture.ready = true;
</script></body>`;

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.end(html); return; }
  if (url.pathname === '/__plan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const { key, plan } = JSON.parse(body);
      const list = plans.get(key) || [];
      list.push(plan);
      plans.set(key, list);
      res.writeHead(204); res.end();
    });
    return;
  }
  if (url.pathname === '/__calls') return sendJson(res, 200, { calls });
  if (url.pathname === '/api/gallery/albums' && req.method === 'GET') return sendJson(res, 200, { albums });
  if (url.pathname === '/api/gallery/library') return sendJson(res, 200, { items: [], total: 0, tags: [], models: [] });
  if (url.pathname.startsWith('/api/gallery/albums') && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const key = `${req.method}:${url.pathname}`;
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method: req.method, path: url.pathname, body });
      const list = plans.get(key) || [];
      const plan = list.shift() || {};
      plans.set(key, list);
      if (plan.delay) await new Promise(resolve => setTimeout(resolve, plan.delay));
      if (plan.network) { res.destroy(); return; }
      const albumId = url.pathname.split('/').pop();
      if (req.method === 'POST' && plan.status !== 503) {
        const created = { id: plan.id || `created-${calls.length}`, name: body.name, count: 0 };
        albums.unshift(created);
        return sendJson(res, plan.status || 200, { ok: true, id: created.id, name: created.name });
      }
      if (plan.status && plan.status >= 400) return sendJson(res, plan.status, { detail: 'Fixture mutation failure' });
      if (req.method === 'PUT') {
        albums = albums.map(album => album.id === albumId ? { ...album, name: body.name } : album);
      } else if (req.method === 'DELETE') {
        albums = albums.filter(album => album.id !== albumId);
      }
      res.writeHead(plan.status || 200); res.end();
    });
    return;
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/gallery/albums**', async route => {
      const request = route.request();
      const key = `${request.method()}:${new URL(request.url()).pathname}`;
      attempts.push(key);
      if (networkFailures.delete(key)) return route.abort('failed');
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixture?.ready);
    await page.locator('.gallery-tab[data-tab="albums"]').click();
    await page.locator('.gallery-album-card[data-album="alpha"]').waitFor();
    const plan = (key, value) => page.evaluate(({ key, value }) => fetch('/__plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, plan: value }),
    }), { key, value });
    const state = () => page.evaluate(() => window.fixture);
    const callsFor = async (method, suffix) => (await page.evaluate(async () => (await fetch('/__calls').then(r => r.json())).calls))
      .filter(call => call.method === method && call.path.endsWith(suffix));

    // Create failure is reported; a retry succeeds and appears in the list.
    await plan('POST:/api/gallery/albums', { status: 503 });
    await page.evaluate(() => window.fixture.prompts.push('New album'));
    await page.locator('#gallery-albums-new').click();
    await page.waitForFunction(() => window.fixture.errors.length === 1);
    assert.equal(await page.locator('.gallery-album-card[data-album^="created-"]').count(), 0);
    await plan('POST:/api/gallery/albums', { id: 'created-retry' });
    await page.evaluate(() => window.fixture.prompts.push('New album'));
    await page.locator('#gallery-albums-new').click();
    await page.locator('.gallery-album-card[data-album="created-retry"]').waitFor();
    assert.equal((await state()).toasts.includes('Album created'), true);

    // Rename transport failure leaves the old name; a later retry succeeds.
    networkFailures.add('PUT:/api/gallery/albums/beta');
    await page.evaluate(() => window.fixture.prompts.push('Beta renamed'));
    await page.locator('.gallery-album-menu-btn[data-album="beta"]').click();
    await page.locator('.gallery-album-menu-pop[data-album="beta"] [data-action="rename"]').click();
    await page.waitForFunction(() => window.fixture.errors.length === 2);
    assert.equal(await page.locator('.gallery-album-card[data-album="beta"] .gallery-album-name').textContent(), 'Beta');
    await plan('PUT:/api/gallery/albums/beta', {});
    await page.evaluate(() => window.fixture.prompts.push('Beta renamed'));
    await page.locator('.gallery-album-menu-btn[data-album="beta"]').click();
    await page.locator('.gallery-album-menu-pop[data-album="beta"] [data-action="rename"]').click();
    await page.locator('.gallery-album-card[data-album="beta"] .gallery-album-name').getByText('Beta renamed').waitFor();

    // Single delete transport failure keeps the row and supports retry.
    networkFailures.add('DELETE:/api/gallery/albums/gamma');
    await page.locator('.gallery-album-menu-btn[data-album="gamma"]').click();
    await page.locator('.gallery-album-menu-pop[data-album="gamma"] [data-action="delete"]').click();
    await page.waitForFunction(() => window.fixture.errors.length === 3);
    assert.equal(await page.locator('.gallery-album-card[data-album="gamma"]').count(), 1);
    await plan('DELETE:/api/gallery/albums/gamma', {});
    await page.locator('.gallery-album-menu-btn[data-album="gamma"]').click();
    await page.locator('.gallery-album-menu-pop[data-album="gamma"] [data-action="delete"]').click();
    await page.locator('.gallery-album-card[data-album="gamma"]').waitFor({ state: 'detached' });

    // Bulk deletion isolates each request, keeps failed/new selections and
    // prevents duplicate submits while one captured batch is in flight.
    await page.locator('#gallery-albums-select-btn').click();
    await page.locator('.gallery-album-card[data-album="alpha"]').click();
    await page.locator('.gallery-album-card[data-album="created-retry"]').click();
    await plan('DELETE:/api/gallery/albums/alpha', { delay: 250 });
    await plan('DELETE:/api/gallery/albums/created-retry', { status: 503 });
    await page.locator('#gallery-albums-bulk-delete').click();
    await page.waitForFunction(() => document.getElementById('gallery-albums-bulk-delete')?.disabled);
    await page.locator('.gallery-album-card[data-album="delta"]').click();
    await page.locator('#gallery-albums-bulk-delete').evaluate(button => button.click());
    await page.waitForFunction(() => window.fixture.errors.length === 4);
    await page.locator('.gallery-album-card[data-album="alpha"]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.gallery-album-card[data-album="created-retry"]').count(), 1);
    assert.equal(await page.locator('.gallery-album-card.selected').count(), 2, 'failed and newly selected albums remain selected');
    assert.equal(attempts.filter(key => key === 'DELETE:/api/gallery/albums/alpha').length, 1, 'second click did not duplicate the pending batch');
    assert.equal(attempts.filter(key => key === 'DELETE:/api/gallery/albums/created-retry').length, 1);

    await plan('DELETE:/api/gallery/albums/created-retry', {});
    await plan('DELETE:/api/gallery/albums/delta', {});
    await page.locator('#gallery-albums-bulk-delete').click();
    await page.locator('.gallery-album-card[data-album="created-retry"]').waitFor({ state: 'detached' });
    await page.locator('.gallery-album-card[data-album="delta"]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#gallery-albums-select-btn').textContent(), 'Select');
    assert.deepEqual(errors, []);
    console.log('PASS: create/rename/delete recovery, mixed bulk failure, preserved selections and duplicate guard');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
