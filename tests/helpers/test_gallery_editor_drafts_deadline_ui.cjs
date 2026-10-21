'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = process.env.SOURCE_ROOT || path.resolve(__dirname, '../..');
const sourcePath = path.join(repo, 'static/js/gallery.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
const start = 'async function _renderEditorDrafts() {';
const marker = '// Re-render only the grid (and bulk bar) from cached drafts + search +';
assert.equal(source.split(start).length, 2, 'expected one loader definition');
const servedSource = source.replace(start, 'async function _renderEditorDraftsImpl() {')
  .replace(marker, `async function _renderEditorDrafts() {
  const fetchIndexBefore = window.__draftFetches.length;
  const pending = _renderEditorDraftsImpl();
  window.__draftLoads ||= [];
  window.__draftLoads.push({ pending, fetchIndex: window.__draftFetches.length > fetchIndexBefore ? window.__draftFetches.length - 1 : -1 });
  return pending;
}
${marker}`);
assert.notEqual(servedSource, source, 'test-only promise observer was installed');
const { withAppStyles } = require(path.join(repo, 'tests/helpers/app_styles.cjs'));
let drafts = [{ id: 'draft-a', name: 'Saved project A', width: 320, height: 240 }];
let nextPlan = null;
const holds = new Map();
const closedHolds = [];
let nextHoldId = 0;
let reads = 0;
let pending = 0;
const externalRequests = [];
const html = `<!doctype html><meta charset="utf-8"><!-- APP_STYLESHEET_LINKS --><body>
<script type="module">
  import ui from '/static/js/ui.js';
  import gallery from '/static/js/gallery.js';
  window.fixture = { ready: false };
  ui.styledConfirm = async () => false;
  ui.styledPrompt = async () => null;
  ui.showToast = () => {};
  ui.showError = () => {};
  const nativeFetch = window.fetch.bind(window);
  window.__draftFetches = [];
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/editor-drafts') && init?.signal) {
      const record = { id: String(window.__draftFetches.length), aborted: false };
      init.signal.addEventListener('abort', () => { record.aborted = true; }, { once: true });
      window.__draftFetches.push(record);
      return nativeFetch(input, { ...init, headers: { ...init.headers, 'X-Draft-Proof-Id': record.id } });
    }
    return nativeFetch(input, init);
  };
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
function state(res) { json(res, 200, { reads, pending, holds: [...holds.values()].map(({ id, mode, fetchId }) => ({ id, mode, fetchId })), closedHolds }); }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { withAppStyles(html).then(value => res.end(value)); return; }
  if (url.pathname === '/__state') { state(res); return; }
  if (url.pathname === '/__next' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { const value = JSON.parse(body); nextPlan = { mode: value.mode, drafts: value.drafts }; drafts = value.drafts; json(res, 200, { ok: true }); });
    return;
  }
  if (url.pathname === '/__release' && req.method === 'POST') {
    const held = holds.get(url.searchParams.get('id'));
    if (!held) { json(res, 409, { error: 'no held request' }); return; }
    held.released = true;
    if (held.mode === 'headers') json(held.res, 200, { drafts: held.drafts });
    else held.res.end(JSON.stringify(held.drafts) + '}');
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
    const plan = nextPlan;
    nextPlan = null;
    if (plan?.mode === 'headers' || plan?.mode === 'body') {
      const id = `held-${++nextHoldId}`;
      const held = { id, mode: plan.mode, drafts: plan.drafts, fetchId: String(req.headers['x-draft-proof-id']), res, released: false };
      holds.set(id, held);
      res.once('close', () => {
        if (!held.released && !res.writableFinished) closedHolds.push(id);
        holds.delete(id);
      });
      if (plan.mode === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.flushHeaders();
        res.write('{"drafts":');
      }
      return;
    }
    json(res, 200, { drafts });
    return;
  }
  if (url.pathname === '/api/gallery/albums') { json(res, 200, { albums: [] }); return; }
  if (url.pathname === '/api/gallery/library') { json(res, 200, { items: [], total: 0, tags: [], models: [] }); return; }
  if (url.pathname === '/api/tasks/notification-logs' && req.method === 'POST') { req.resume(); req.on('end', () => json(res, 200, { ok: true })); return; }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  if (file === sourcePath) { res.setHeader('Content-Type', 'text/javascript'); res.end(servedSource); return; }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});
let browser;
let page;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (!origin.startsWith('http://127.0.0.1:')) throw new Error('fixture origin guard rejected navigation');
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.setDefaultTimeout(8000);
  const pageErrors = [];
  const failedRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : (externalRequests.push(route.request().url()), route.abort('blockedbyclient')));
  await page.goto(origin);
  await page.waitForFunction(() => window.fixture?.ready).catch(error => {
    console.error(JSON.stringify({ pageErrors, failedRequests, externalRequests }));
    throw error;
  });
  const card = id => page.locator(`.gallery-editor-draft-card[data-draft-id="${id}"]`);
  const stateNow = () => page.evaluate(() => fetch('/__state').then(r => r.json()));
  const setNext = async (mode, value) => page.evaluate(({ mode, drafts }) => fetch('/__next', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, drafts }),
  }), { mode, drafts: value });
  const openEditor = async () => {
    await page.locator('.gallery-tab[data-tab="images"]').click();
    await page.locator('.gallery-tab[data-tab="editor"]').click();
  };
  const loading = page.locator('#gallery-editor-drafts .gallery-editor-drafts-loading');
  const error = page.locator('#gallery-editor-drafts .gallery-editor-drafts-load-error');
  const waitForHold = async (mode, afterReads) => {
    await page.waitForFunction(async ({ mode, afterReads }) => {
      const value = await fetch('/__state').then(response => response.json());
      return value.reads > afterReads && value.holds.some(hold => hold.mode === mode);
    }, { mode, afterReads });
    return (await stateNow()).holds.find(hold => hold.mode === mode);
  };
  const waitClosed = id => page.waitForFunction(async id => (await fetch('/__state').then(response => response.json())).closedHolds.includes(id), id);
  const release = id => page.evaluate(id => fetch(`/__release?id=${encodeURIComponent(id)}`, { method: 'POST' }), id);
  const assertWaitingState = async cachedId => {
    assert.equal(await loading.evaluate(node => getComputedStyle(node).display !== 'none'), true, 'loading overlay remains visible');
    assert.equal(await error.count(), 0, 'no Retry/error is available while the request is pending');
    if (cachedId) assert.equal(await card(cachedId).count(), 1, 'last successful card remains visible under the loading overlay');
  };

  await page.locator('.gallery-tab[data-tab="editor"]').click();
  await card('draft-a').waitFor({ state: 'visible' });
  await setNext('normal', [{ id: 'draft-a', name: 'Saved project A', width: 320, height: 240 }]);
  await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).pending === 0);

  const elapsedCases = [];
  await setNext('headers', [{ id: 'draft-b', name: 'Saved project B', width: 640, height: 480 }]);
  const headerBase = await stateNow();
  await openEditor();
  const headerHold = await waitForHold('headers', headerBase.reads);
  const headerId = headerHold.id;
  await assertWaitingState('draft-a');
  const headerStart = Date.now();
  await page.waitForTimeout(15100);
  const headerElapsed = Date.now() - headerStart;
  await waitClosed(headerId);
  assert.equal(await page.evaluate(id => window.__draftFetches[Number(id)]?.aborted, headerHold.fetchId), true, 'browser AbortController signal fired');
  assert.equal((await stateNow()).pending, 0, 'browser abort closes the held pre-header request');
  assert.equal(await card('draft-a').count(), 1, 'timeout preserves last-good drafts');
  assert.equal(await loading.evaluate(node => getComputedStyle(node).display === 'none'), true, 'timeout clears the loading overlay');
  assert.equal(await error.getAttribute('role'), 'alert');
  assert.match(await error.textContent(), /last loaded list is kept/i);
  assert.equal(await error.locator('button').textContent(), 'Retry');
  elapsedCases.push({ mode: 'before-headers', elapsedMs: headerElapsed, browserAbortObserved: true, loadingCleared: true, retryAvailable: true, lastGoodCardRetained: true });
  await error.locator('button').click();
  await card('draft-b').waitFor({ state: 'visible' });
  assert.equal(await error.count(), 0);
  assert.equal(await loading.evaluate(node => getComputedStyle(node).display === 'none'), true);

  // A newer body request is still loading when the older request's deadline fires.
  await page.clock.install({ time: new Date() });
  await setNext('headers', [{ id: 'draft-stale', name: 'Stale project', width: 200, height: 200 }]);
  const staleBase = await stateNow();
  await openEditor();
  const staleHold = await waitForHold('headers', staleBase.reads);
  const staleId = staleHold.id;
  await page.clock.fastForward(14500);
  await setNext('body', [{ id: 'draft-c', name: 'Saved project C', width: 800, height: 600 }]);
  const bodyBase = await stateNow();
  await openEditor();
  const bodyHold = await waitForHold('body', bodyBase.reads);
  const bodyId = bodyHold.id;
  await page.clock.fastForward(600);
  await waitClosed(staleId);
  const staleElapsedSimulated = 15100;
  assert.equal(await page.evaluate(id => window.__draftFetches[Number(id)]?.aborted, staleHold.fetchId), true, `stale request AbortController signal fired: hold=${JSON.stringify(staleHold)}`);
  assert.ok((await stateNow()).holds.some(hold => hold.id === bodyId), 'new body response remains held after old request aborts');
  await assertWaitingState('draft-b');
  const staleResult = await page.evaluate(async id => {
    const load = window.__draftLoads.find(item => item.fetchIndex === Number(id));
    return load ? load.pending : undefined;
  }, staleHold.fetchId);
  assert.equal(staleResult, false, 'superseded real loader settles as stale');
  await page.clock.fastForward(15100 - 600);
  await waitClosed(bodyId);
  assert.equal(await page.evaluate(id => window.__draftFetches[Number(id)]?.aborted, bodyHold.fetchId), true, 'body request AbortController signal fired');
  assert.equal(await card('draft-b').count(), 1, 'body timeout preserves last-good drafts');
  assert.equal(await loading.evaluate(node => getComputedStyle(node).display === 'none'), true, 'current body timeout clears loading');
  assert.equal(await error.getAttribute('role'), 'alert');
  assert.match(await error.textContent(), /last loaded list is kept/i);
  assert.equal(await error.locator('button').textContent(), 'Retry');
  elapsedCases.push({ mode: 'headers-received-body-incomplete', simulatedElapsedMs: 15100, browserAbortObserved: true, loadingCleared: true, retryAvailable: true, lastGoodCardRetained: true });
  assert.ok(staleElapsedSimulated >= 15000 && staleElapsedSimulated < 15500, `older deadline simulated on schedule: ${staleElapsedSimulated}ms`);
  assert.equal(await loading.evaluate(node => getComputedStyle(node).display !== 'none'), false, 'stale timeout did not leave a loading overlay');
  assert.equal(await error.getAttribute('role'), 'alert', 'current body timeout, not stale header timeout, owns the alert');
  await error.locator('button').click();
  await card('draft-c').waitFor({ state: 'visible' });
  assert.equal(await error.count(), 0, 'Retry recovers from timeout');
  assert.equal(await loading.evaluate(node => getComputedStyle(node).display === 'none'), true);
  assert.equal(await stateNow().then(value => value.pending), 0, 'all held requests settle');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(externalRequests, []);
  console.log(JSON.stringify({
    pass: true,
    sourceHash,
    sourceCommit: '45c07887c3f1a2d5625220ed676a851b02b1ef0a',
    elapsedCases,
    normalRefreshRetryAndStaleTimeoutOwnership: true,
    pageErrors,
    externalRequests: externalRequests.length,
    clock: 'The standalone current-load header timeout uses native browser elapsed time. The stale-header/new-body overlap uses Playwright clock fastForward for the 15-second deadlines; it verifies the real AbortController signal and browser request close.',
    limits: 'Actual Gallery module from isolated pass309 source; synthetic draft metadata and loopback fixture only. No real drafts, account, live API, media, provider, model, GPU, or hardware.'
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  for (const held of holds.values()) held.res.destroy();
  await browser?.close().catch(() => {});
  if (server.listening) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
