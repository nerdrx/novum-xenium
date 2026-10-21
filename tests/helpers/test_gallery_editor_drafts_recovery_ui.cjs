'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = process.env.SOURCE_ROOT || path.resolve(__dirname, '../..');
const galleryPath = path.join(repo, 'static/js/gallery.js');
const gallerySource = fs.readFileSync(galleryPath, 'utf8');
const sourceHash = crypto.createHash('sha256').update(gallerySource).digest('hex');
const originalDraftLoader = 'async function _renderEditorDrafts() {';
const instrumentedDraftLoader = 'async function _renderEditorDraftsImpl() {';
if (gallerySource.split(originalDraftLoader).length !== 2) throw new Error('Expected one editor-drafts loader declaration');
const galleryForTest = gallerySource
  .replace(originalDraftLoader, instrumentedDraftLoader)
  .replace('// Re-render only the grid (and bulk bar) from cached drafts + search +', `function _renderEditorDrafts() {
  const pending = _renderEditorDraftsImpl();
  window.__galleryDraftLoads ||= [];
  window.__galleryDraftLoads.push(pending);
  return pending;
}

// Re-render only the grid (and bulk bar) from cached drafts + search +`);
if (galleryForTest === gallerySource) throw new Error('Test-only draft promise wrapper was not inserted');
const instrumentedSourceHash = crypto.createHash('sha256').update(galleryForTest).digest('hex');
const { withAppStyles } = require('./app_styles.cjs');
let drafts = [{ id: 'draft-a', name: 'Saved project A', width: 320, height: 240 }];
let mode = 'normal';
let holdNext = false;
let heldResponse = null;
let heldClosedResolve;
let heldClosed = new Promise(resolve => { heldClosedResolve = resolve; });
let reads = 0;
let pending = 0;
const externalRequests = [];
const html = `<!doctype html><meta charset="utf-8"><!-- APP_STYLESHEET_LINKS --><body>
<script type="module">
  import ui from '/static/js/ui.js';
  import gallery from '/static/js/gallery.js';
  window.fixture = { ready: false, errors: [] };
  ui.styledConfirm = async () => false;
  ui.styledPrompt = async () => null;
  ui.showToast = () => {};
  ui.showError = text => { window.fixture.errors.push(String(text)); };
  window.gallery = gallery;
  gallery.openGallery();
  const modal = document.getElementById('gallery-modal');
  modal.classList.remove('hidden', 'modal-minimized');
  modal.style.setProperty('display', 'flex', 'important');
  window.fixture.ready = true;
</script></body>`;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
function setDraftState(res) {
  json(res, 200, { reads, pending, mode, held: Boolean(heldResponse) });
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { withAppStyles(html).then(styled => res.end(styled)); return; }
  if (url.pathname === '/__state') { setDraftState(res); return; }
  if (url.pathname === '/__mode' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const value = JSON.parse(body);
      mode = value.mode;
      if (Array.isArray(value.drafts)) drafts = value.drafts;
      json(res, 200, { ok: true });
    });
    return;
  }
  if (url.pathname === '/__hold-next' && req.method === 'POST') { holdNext = true; json(res, 200, { ok: true }); return; }
  if (url.pathname === '/__release-held' && req.method === 'POST') {
    if (heldResponse) heldResponse.destroy();
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/editor-drafts' && req.method === 'GET') {
    reads++;
    pending++;
    let settled = false;
    const settle = () => { if (!settled) { settled = true; pending--; } };
    res.once('finish', settle);
    res.once('close', settle);
    if (holdNext) {
      holdNext = false;
      heldResponse = res;
      heldClosed = new Promise(resolve => { heldClosedResolve = resolve; });
      res.once('close', () => {
        heldResponse = null;
        heldClosedResolve();
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      res.write('{"drafts":');
      return;
    }
    if (mode === 'network-error') { req.socket.destroy(); return; }
    if (mode === 'http-error') { json(res, 503, { detail: 'Synthetic service unavailable' }); return; }
    if (mode === 'malformed') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"drafts":'); return; }
    json(res, 200, { drafts });
    return;
  }
  if (url.pathname === '/api/gallery/albums') { json(res, 200, { albums: [] }); return; }
  if (url.pathname === '/api/gallery/library') { json(res, 200, { items: [], total: 0, tags: [], models: [] }); return; }
  if (url.pathname === '/api/tasks/notification-logs' && req.method === 'POST') { req.resume(); req.on('end', () => json(res, 200, { ok: true })); return; }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  if (file === galleryPath) {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(galleryForTest);
    return;
  }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

let browser;
let page;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (!origin.startsWith('http://127.0.0.1:')) throw new Error('Fixture origin guard rejected navigation');
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.setDefaultTimeout(8000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/')) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.fixture?.ready);
  const card = id => page.locator(`.gallery-editor-draft-card[data-draft-id="${id}"]`);
  const state = () => page.evaluate(() => fetch('/__state').then(r => r.json()));
  const setMode = value => page.evaluate(({ mode, drafts }) => fetch('/__mode', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, drafts }),
  }), value);
  const openEditor = async () => {
    await page.locator('.gallery-tab[data-tab="images"]').click();
    await page.locator('.gallery-tab[data-tab="editor"]').click();
  };
  const waitStable = async () => {
    let previous = -1;
    let stable = 0;
    let latest;
    while (stable < 3) {
      latest = await state();
      if (latest.pending === 0 && latest.reads === previous) stable++;
      else { previous = latest.reads; stable = 0; }
      await page.waitForTimeout(100);
    }
    return latest;
  };
  const errorBox = page.locator('#gallery-editor-drafts .gallery-editor-drafts-load-error');
  const assertRetryTargetAt390 = async () => {
    const metrics = await errorBox.locator('button').evaluate(button => {
      const rect = button.getBoundingClientRect();
      const row = button.closest('[role="alert"]');
      return {
        width: rect.width,
        height: rect.height,
        margin: getComputedStyle(button).margin,
        opacity: getComputedStyle(button).opacity,
        rowOverflow: row.scrollWidth > row.clientWidth,
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    assert.ok(metrics.width >= 44, `Retry width should be at least 44px: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.height >= 44, `Retry height should be at least 44px: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.margin, '0px', 'Retry has no inherited toolbar offset');
    assert.equal(metrics.opacity, '1', 'Retry and its local alert row retain full opacity');
    assert.equal(metrics.rowOverflow, false, 'Retry row fits its available width');
    assert.equal(metrics.documentOverflow, false, 'Retry does not introduce horizontal document overflow');
  };

  await page.locator('.gallery-tab[data-tab="editor"]').click();
  await card('draft-a').waitFor({ state: 'visible' });
  await waitStable();
  assert.equal(await card('draft-a').locator('.gallery-editor-draft-name').textContent(), 'Saved project A');

  await page.setViewportSize({ width: 390, height: 850 });
  await setMode({ mode: 'network-error' });
  await openEditor();
  await waitStable();
  assert.equal(await card('draft-a').count(), 1);
  assert.match(await errorBox.textContent(), /last loaded list is kept/i);
  await assertRetryTargetAt390();
  await setMode({ mode: 'normal', drafts: [{ id: 'draft-b', name: 'Saved project B', width: 640, height: 480 }] });
  await errorBox.locator('button').click();
  await card('draft-b').waitFor({ state: 'visible' });
  await page.setViewportSize({ width: 1100, height: 850 });

  // Non-2xx and malformed JSON retain last good card and offer explicit retry.
  await setMode({ mode: 'http-error' });
  await openEditor();
  await waitStable();
  assert.equal(await card('draft-b').count(), 1);
  assert.equal(await errorBox.getAttribute('role'), 'alert');
  assert.match(await errorBox.textContent(), /last loaded list is kept/i);
  assert.equal(await errorBox.locator('button').textContent(), 'Retry');
  await setMode({ mode: 'normal', drafts: [{ id: 'draft-c', name: 'Saved project C', width: 800, height: 600 }] });
  await errorBox.locator('button').click();
  await card('draft-c').waitFor({ state: 'visible' });
  assert.equal(await errorBox.count(), 0);

  await setMode({ mode: 'malformed' });
  await openEditor();
  await waitStable();
  assert.equal(await card('draft-c').count(), 1);
  assert.equal(await errorBox.getAttribute('role'), 'alert');
  await setMode({ mode: 'normal', drafts: [{ id: 'draft-d', name: 'Saved project D', width: 400, height: 300 }] });
  await errorBox.locator('button').click();
  await card('draft-d').waitFor({ state: 'visible' });
  assert.equal(await errorBox.count(), 0);

  // A successful empty list remains the only state that hides the section.
  await setMode({ mode: 'normal', drafts: [] });
  await openEditor();
  await waitStable();
  assert.equal(await page.locator('#gallery-editor-drafts').evaluate(node => node.hidden), true);
  assert.equal(await page.locator('.gallery-editor-draft-card').count(), 0);

  // A held stale failure must not replace a newer successful list or its UI.
  await setMode({ mode: 'normal', drafts: [{ id: 'draft-e', name: 'Saved project E', width: 500, height: 300 }] });
  await openEditor();
  await card('draft-e').waitFor({ state: 'visible' });
  await waitStable();
  const staleLoadIndex = await page.evaluate(() => window.__galleryDraftLoads.length);
  await page.evaluate(() => fetch('/__hold-next', { method: 'POST' }));
  const beforeHold = await state();
  await openEditor();
  await page.waitForFunction(async before => {
    const current = await fetch('/__state').then(r => r.json());
    return current.held && current.reads > before.reads;
  }, beforeHold);
  await setMode({ mode: 'normal', drafts: [{ id: 'draft-f', name: 'Saved project F', width: 500, height: 400 }] });
  await openEditor();
  await card('draft-f').waitFor({ state: 'visible' });
  assert.equal(await errorBox.count(), 0);
  await page.evaluate(() => fetch('/__release-held', { method: 'POST' }));
  await heldClosed;
  const staleResult = await page.evaluate(async index => await window.__galleryDraftLoads[index], staleLoadIndex);
  assert.equal(staleResult, false, 'the held stale load completed through its real loader promise');
  assert.equal(await card('draft-f').count(), 1, 'stale error cannot clear or replace the newer list');
  assert.equal(await errorBox.count(), 0, 'stale error cannot show retry UI over newer success');
  const loadingDisplay = await page.locator('#gallery-editor-drafts .gallery-editor-drafts-loading').evaluate(node => node.style.display);
  assert.equal(loadingDisplay, 'none', 'latest successful load owns spinner cleanup');

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(externalRequests, []);
  console.log(JSON.stringify({
    pass: true,
    sourceHash,
    instrumentedSourceHash,
    cases: {
      httpFailureKeepsLastGoodAndRetries: true,
      networkFailureKeepsLastGoodAndRetries: true,
      malformedResponseKeepsLastGoodAndRetries: true,
      successfulEmptyHidesSection: true,
      staleFailureCannotReplaceNewerSuccess: true,
      retryReplacedOldCard: true,
    },
    reads: (await state()).reads,
    pageErrors,
    externalRequests: externalRequests.length,
    limits: 'Actual Gallery module with synthetic draft metadata and loopback responses only. No real drafts, media, account, API, model, provider, or hardware.'
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (heldResponse) heldResponse.destroy();
  await browser?.close().catch(() => {});
  if (server.listening) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
