const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = process.env.SOURCE_ROOT || '/tmp/novum-pass296-gallery-progress';
const state = { mode: '', requests: [], held: null, pageErrors: [], externalRequests: [] };
const html = `<!doctype html><meta charset="utf-8"><body><div id="toast"></div>
<script type="module">
  window.__uploadJsonCount = 0;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (new URL(args[0], location.href).pathname === '/api/gallery/upload') {
      const nativeJson = response.json.bind(response);
      response.json = async (...jsonArgs) => {
        try { return await nativeJson(...jsonArgs); }
        finally { window.__uploadJsonCount++; }
      };
    }
    return response;
  };
  import gallery from '/static/js/gallery.js';
  const nativeClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function() {
    if (this.type === 'file') {
      document.querySelector('#fixture-file-input')?.remove();
      this.id = 'fixture-file-input'; document.body.appendChild(this); return;
    }
    return nativeClick.call(this);
  };
  gallery.openGallery();
  window.fixtureReady = true;
</script></body>`;
let resolveHeld;
let heldReady;
function armHeldWait() { heldReady = new Promise(resolve => { resolveHeld = resolve; }); }

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/api/gallery/albums') return json(res, 200, { albums: [] });
  if (url.pathname === '/api/gallery/library') return json(res, 200, { items: [], total: 0, tags: [], models: [] });
  if (url.pathname === '/api/tasks/notification-logs' && req.method === 'POST') { req.resume(); return json(res, 200, { ok: true }); }
  if (url.pathname === '/api/gallery/upload') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const filename = Buffer.concat(chunks).toString('utf8').match(/filename="([^"]+)"/)?.[1] || '';
    state.requests.push({ mode: state.mode, filename });
    const hold = (state.mode === 'timer-race' && filename === 'timer-b.png') ||
      (state.mode === 'worker-race' && filename === 'worker-a.png');
    if (hold) { state.held = { res, filename }; resolveHeld(state.held); return; }
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__release') {
    if (!state.held) return json(res, 409, { error: 'nothing held' });
    const held = state.held;
    state.held = null;
    json(held.res, 200, { ok: true });
    return json(res, 200, { released: held.filename });
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  const staticRoot = path.join(repo, 'static') + path.sep;
  if (!file.startsWith(staticRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, {});
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

async function startPage(browser, mode) {
  state.mode = mode;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(7000);
  page.on('pageerror', e => state.pageErrors.push(e.stack || e.message));
  page.on('request', req => { if (new URL(req.url()).hostname !== '127.0.0.1') state.externalRequests.push(req.url()); });
  await page.route('**/*', route => new URL(route.request().url()).hostname !== '127.0.0.1' ? route.abort() : route.continue());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.fixtureReady && document.querySelector('#gallery-upload-tile'));
  return page;
}

async function pick(page, names) {
  await page.locator('#gallery-upload-tile').click();
  const input = page.locator('#fixture-file-input');
  await input.waitFor();
  await input.setInputFiles(names.map(name => ({ name, mimeType: 'image/png', buffer: Buffer.from('synthetic fixture bytes') })));
}

async function snapshot(page) {
  return page.evaluate(() => ({
    status: document.getElementById('gallery-upload-status')?.textContent || '',
    progress: document.getElementById('gallery-upload-progress')?.style.width || '',
    barDisplay: document.getElementById('gallery-upload-bar')?.style.display || '',
  }));
}

(async () => {
  let browser;
  let page;
  const result = {};
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });

    armHeldWait();
    page = await startPage(browser, 'timer-race');
    await page.clock.install();
    await pick(page, ['timer-a.png']);
    await page.waitForFunction(() => document.getElementById('gallery-upload-status')?.textContent === '1 imported');
    result.timerBatchAComplete = await snapshot(page);
    await pick(page, ['timer-b.png']);
    await Promise.race([heldReady, new Promise((_, reject) => setTimeout(() => reject(new Error('held B upload did not arrive')), 7000))]);
    result.timerBatchBPendingBeforeAHide = await snapshot(page);
    await page.clock.fastForward(3000);
    result.timerBatchBPendingAfterAHide = await snapshot(page);
    await fetch(`http://127.0.0.1:${server.address().port}/__release`);
    await page.waitForFunction(() => window.__uploadJsonCount === 2 && document.getElementById('gallery-upload-status')?.textContent === '1 imported');
    result.timerBatchBAfterRelease = await snapshot(page);
    await page.close(); page = null;

    state.held = null;
    armHeldWait();
    page = await startPage(browser, 'worker-race');
    await pick(page, ['worker-a.png']);
    await Promise.race([heldReady, new Promise((_, reject) => setTimeout(() => reject(new Error('held A upload did not arrive')), 7000))]);
    await pick(page, ['worker-b1.png', 'worker-b2.png']);
    await page.waitForFunction(() => document.getElementById('gallery-upload-status')?.textContent === '2 imported');
    result.batchBCompletedWhileAStillPending = await snapshot(page);
    await fetch(`http://127.0.0.1:${server.address().port}/__release`);
    await page.waitForFunction(() => window.__uploadJsonCount === 3);
    await page.clock.runFor(16);
    result.afterOlderBatchACompletes = await snapshot(page);

    await page.close(); page = null;
    armHeldWait();
    page = await startPage(browser, 'normal');
    await page.clock.install();
    await pick(page, ['normal.png']);
    await page.waitForFunction(() => document.getElementById('gallery-upload-status')?.textContent === '1 imported');
    result.normalBatchBeforeHide = await snapshot(page);
    await page.clock.fastForward(3000);
    result.normalBatchAfterHide = await snapshot(page);

    assert.equal(result.timerBatchBPendingBeforeAHide.barDisplay, '');
    assert.equal(result.timerBatchBPendingBeforeAHide.status, '0/1');
    assert.equal(result.timerBatchBPendingBeforeAHide.progress, '0%');
    assert.equal(result.timerBatchBPendingAfterAHide.barDisplay, '', 'A timer must not hide B progress while B upload is pending');
    assert.equal(result.timerBatchBAfterRelease.barDisplay, '', 'B progress remains visible until B timer expires');
    assert.equal(result.batchBCompletedWhileAStillPending.status, '2 imported');
    assert.equal(result.afterOlderBatchACompletes.status, '2 imported', 'late A worker must not overwrite B status/progress summary');
    assert.equal(result.afterOlderBatchACompletes.progress, '100%');
    assert.equal(result.normalBatchBeforeHide.status, '1 imported');
    assert.equal(result.normalBatchBeforeHide.barDisplay, '');
    assert.equal(result.normalBatchAfterHide.barDisplay, 'none');
    assert.deepEqual(state.pageErrors, []);
    assert.deepEqual(state.externalRequests, []);
    result.requests = state.requests;
    result.pageErrors = state.pageErrors;
    result.externalRequests = state.externalRequests;
    result.pass = true;
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (state.held?.res) state.held.res.destroy();
    if (server.listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
