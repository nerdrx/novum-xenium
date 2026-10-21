const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = process.env.SOURCE_ROOT || path.resolve(__dirname, '../..');
const record = { cases: [], uploads: [], notificationLogs: [], externalRequests: [], pageErrors: [] };
let currentCase;
const html = `<!doctype html><meta charset="utf-8"><body><div id="toast"></div>
<script type="module">
  const nativeFetch = window.fetch.bind(window);
  window.__notificationLogs = [];
  window.fetch = async (...args) => {
    const res = await nativeFetch(...args);
    if (new URL(args[0], location.href).pathname === '/api/tasks/notification-logs') {
      window.__notificationLogs.push(await res.clone().json());
    }
    return res;
  };
  import gallery from '/static/js/gallery.js';
  window.fixture = { ready: false, xss: false };
  const nativeClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function() {
    if (this.type === 'file') { this.id = 'fixture-file-input'; document.body.appendChild(this); return; }
    return nativeClick.call(this);
  };
  gallery.openGallery();
  window.fixture.ready = true;
</script></body>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  if (url.pathname === '/') return send(200, html, 'text/html');
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/api/gallery/albums') return send(200, { albums: [] });
  if (url.pathname === '/api/gallery/library') return send(200, { items: [], total: 0, tags: [], models: [] });
  if (url.pathname === '/api/tasks/notification-logs' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    record.notificationLogs.push(JSON.parse(body));
    return send(200, { ok: true });
  }
  if (url.pathname === '/api/gallery/upload') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const filename = body.match(/filename="([^"]+)"/)?.[1] || '';
    const plan = currentCase.responses[filename] || currentCase.defaultResponse;
    record.uploads.push({ case: currentCase.name, filename, response: plan.kind });
    if (plan.kind === 'drop') { res.destroy(); return; }
    if (plan.kind === 'malformed') {
      res.writeHead(plan.status, { 'Content-Type': 'application/json' });
      return res.end('{"ok":');
    }
    return send(plan.status, plan.body);
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  const staticRoot = path.join(repo, 'static') + path.sep;
  if (!file.startsWith(staticRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, {});
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

function response(status, body, kind = 'json') { return { status, body, kind }; }

async function runCase(browser, plan) {
  currentCase = plan;
  const logStart = record.notificationLogs.length;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(7000);
  page.on('pageerror', error => record.pageErrors.push(error.stack || error.message));
  page.on('request', request => {
    if (new URL(request.url()).hostname !== '127.0.0.1') record.externalRequests.push(request.url());
  });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname !== '127.0.0.1') return route.abort();
    return route.continue();
  });
  await page.route('**/api/gallery/upload', route => currentCase.name === 'fetch-rejected'
    ? route.abort('failed')
    : route.continue());
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixture?.ready && document.querySelector('#gallery-upload-tile'));
    const pageLogStart = await page.evaluate(() => window.__notificationLogs.length);
    await page.locator('#gallery-upload-tile').click();
    const input = page.locator('#fixture-file-input');
    await input.waitFor();
    await input.setInputFiles(plan.files.map(name => ({ name, mimeType: 'image/png', buffer: Buffer.from('synthetic fixture bytes') })));
    await page.waitForFunction(value => document.getElementById('gallery-upload-status')?.textContent === value, plan.expectedStatus);
    await page.waitForFunction(() => document.getElementById('gallery-upload-bar')?.style.display === 'none', { timeout: 6000 });
    if (plan.expectedLog) await page.waitForFunction(start => window.__notificationLogs.length > start, pageLogStart);
    const visible = await page.evaluate(() => ({
      status: document.getElementById('gallery-upload-status')?.textContent || '',
      toast: document.querySelector('#toast .toast-message')?.textContent || '',
      toastError: document.querySelector('#toast')?.classList.contains('error') || false,
      progressWidth: document.getElementById('gallery-upload-progress')?.style.width || '',
      barDisplay: document.getElementById('gallery-upload-bar')?.style.display || '',
      hasInjectedImage: Boolean(document.querySelector('#toast img')),
      xss: window.fixture?.xss || false,
    }));
    const result = { name: plan.name, files: plan.files, visible, logs: record.notificationLogs.slice(logStart), uploads: record.uploads.filter(item => item.case === plan.name) };
    plan.assert(result);
    record.cases.push(result);
    await page.close();
    return result;
  } catch (error) {
    await page.close().catch(() => {});
    throw new Error(`${plan.name}: ${error.stack || error.message}`);
  }
}

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
    const htmlDetail = `<img src=x onerror=window.fixture.xss=true>${' filler'.repeat(40)}TAILSECRET`;
    const normalizedDetail = htmlDetail.replace(/\s+/g, ' ').trim().slice(0, 160);
    await runCase(browser, {
      name: 'http400-detail', files: ['unsupported.xbm'],
      responses: { 'unsupported.xbm': response(400, { detail: htmlDetail }) }, defaultResponse: response(500, { detail: 'unexpected' }),
      expectedStatus: '0 imported, 1 errors', expectedLog: true,
      assert: result => {
        assert.match(result.visible.toast, /0 imported, 1 errors/);
        assert.ok(result.visible.toast.includes(normalizedDetail));
        assert.ok(!result.visible.toast.includes('TAILSECRET'));
        assert.equal(result.visible.toastError, true);
        assert.equal(result.visible.hasInjectedImage, false);
        assert.equal(result.visible.xss, false);
        assert.deepEqual(result.logs.map(log => log.status), ['error']);
        assert.ok(!result.visible.toast.includes('unsupported.xbm'));
      },
    });
    await runCase(browser, {
      name: 'all-success', files: ['one.png', 'two.png'],
      responses: { 'one.png': response(200, { ok: true }), 'two.png': response(200, { ok: true }) }, defaultResponse: response(500, {}),
      expectedStatus: '2 imported', expectedLog: true,
      assert: result => { assert.equal(result.visible.toast, '2 imported'); assert.equal(result.visible.toastError, false); assert.deepEqual(result.logs.map(log => log.status), ['success']); },
    });
    await runCase(browser, {
      name: 'duplicate', files: ['duplicate.png'],
      responses: { 'duplicate.png': response(200, { ok: false, duplicate: true }) }, defaultResponse: response(500, {}),
      expectedStatus: '0 imported, 1 duplicates skipped', expectedLog: true,
      assert: result => { assert.equal(result.visible.toast, '0 imported, 1 duplicates skipped'); assert.equal(result.visible.toastError, false); assert.deepEqual(result.logs.map(log => log.status), ['success']); },
    });
    await runCase(browser, {
      name: 'mixed-results', files: ['ok.png', 'first-bad.png', 'second-bad.png'],
      responses: {
        'ok.png': response(200, { ok: true }),
        'first-bad.png': response(400, { detail: 'First upload rejected' }),
        'second-bad.png': response(500, { ok: false, duplicate: true, detail: 'Second upload rejected' }),
      }, defaultResponse: response(500, {}),
      expectedStatus: '1 imported, 2 errors', expectedLog: true,
      assert: result => {
        assert.match(result.visible.toast, /^1 imported, 2 errors: (First|Second) upload rejected$/);
        assert.equal(result.visible.toastError, true);
        assert.deepEqual(result.logs.map(log => log.status), ['error']);
      },
    });
    await runCase(browser, {
      name: 'malformed-json', files: ['malformed.png'],
      responses: { 'malformed.png': response(200, null, 'malformed') }, defaultResponse: response(500, {}),
      expectedStatus: '0 imported, 1 errors', expectedLog: true,
      assert: result => { assert.equal(result.visible.toast, '0 imported, 1 errors'); assert.equal(result.visible.toastError, true); assert.deepEqual(result.logs.map(log => log.status), ['error']); },
    });
    await runCase(browser, {
      name: 'fetch-rejected', files: ['dropped.png'],
      responses: { 'dropped.png': { kind: 'drop' } }, defaultResponse: response(500, {}),
      expectedStatus: '0 imported, 1 errors', expectedLog: true,
      assert: result => { assert.equal(result.visible.toast, '0 imported, 1 errors'); assert.equal(result.visible.toastError, true); assert.deepEqual(result.logs.map(log => log.status), ['error']); },
    });
    assert.deepEqual(record.pageErrors, []);
    assert.deepEqual(record.externalRequests, []);
    record.pass = true;
    console.log(JSON.stringify(record, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server.listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
