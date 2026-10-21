'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = process.env.SOURCE_ROOT || path.resolve(__dirname, '../..');
const sourcePath = path.join(repo, 'static/js/gallery.js');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
let albums = [{ id: 'alpha', name: 'Alpha', count: 0 }];
let createPlans = [];
let listPlans = [];
let createCount = 0;
let externalRequests = [];
const activeHolds = new Set();
const html = `<!doctype html><meta charset="utf-8"><body><div id="toast"></div>
<script type="module">
  import gallery from '/static/js/gallery.js';
  window.fixture = { ready: false };
  window.gallery = gallery;
  gallery.openGallery();
  window.fixture.ready = true;
</script></body>`;

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
function makeListPlan(kind) {
  let seenResolve;
  let closedResolve;
  const seen = new Promise(resolve => { seenResolve = resolve; });
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const plan = { kind, seenResolve, closedResolve, seen, closed, response: null, aborted: false };
  listPlans.push(plan);
  return plan;
}
function releaseList(plan) {
  if (!plan.response) return;
  try { plan.response.end(JSON.stringify(albums) + '}'); } catch (_) {}
  plan.response = null;
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.end(html); return; }
  if (url.pathname === '/api/tasks/notification-logs' && req.method === 'POST') {
    req.resume(); req.on('end', () => json(res, 200, { ok: true })); return;
  }
  if (url.pathname === '/api/gallery/albums' && req.method === 'GET') {
    const plan = listPlans.shift();
    if (plan?.kind === 'hold-body') {
      plan.response = res;
      res.on('close', () => {
        if (!res.writableEnded) { plan.aborted = true; plan.closedResolve(); }
        else plan.closedResolve();
        activeHolds.delete(plan);
      });
      activeHolds.add(plan);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      res.write('{"albums":');
      plan.seenResolve();
      return;
    }
    json(res, 200, { albums }); return;
  }
  if (url.pathname === '/api/gallery/albums' && req.method === 'POST') {
    createCount++;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const plan = createPlans.shift() || { ok: true };
      if (!plan.ok) { json(res, plan.status || 503, { detail: 'Synthetic create failure' }); return; }
      const input = JSON.parse(body);
      const created = { id: plan.id || `created-${createCount}`, name: input.name, count: 0 };
      albums.unshift(created);
      json(res, 200, { ok: true, id: created.id, name: created.name });
    });
    return;
  }
  if (url.pathname === '/api/gallery/library') { json(res, 200, { items: [], total: 0, tags: [], models: [] }); return; }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

let browser;
let page;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (!origin.startsWith('http://127.0.0.1:')) throw new Error('Fixture origin guard rejected navigation');
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/')) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.fixture?.ready);
  await page.locator('.gallery-tab[data-tab="albums"]').click();
  await page.locator('.gallery-album-card[data-album="alpha"]').waitFor();
  await page.clock.install({ time: new Date('2026-10-21T10:00:00Z') });

  // Failed POST, then a real headers-arrived/body-held GET exercises json() timeout.
  createPlans.push({ ok: false, status: 503 });
  const firstHold = makeListPlan('hold-body');
  await page.locator('#gallery-albums-new').click();
  await page.locator('#styled-prompt-input').fill('Album after retry');
  await page.locator('#styled-prompt-ok').click();
  await firstHold.seen;
  const firstPending = await page.evaluate(() => ({
    busy: document.getElementById('gallery-albums-container')?.getAttribute('aria-busy'),
    createLocked: document.getElementById('gallery-albums-new')?.getAttribute('aria-disabled'),
    loadError: !!document.getElementById('gallery-albums-load-error'),
    toast: document.querySelector('#toast.error .toast-message')?.textContent || null,
  }));
  assert.equal(firstPending.busy, 'true');
  assert.equal(firstPending.createLocked, 'true');
  assert.equal(firstPending.loadError, false);
  assert.equal(firstPending.toast, null);
  await page.clock.runFor(15001);
  await firstHold.closed;
  await page.waitForFunction(() =>
    !document.getElementById('gallery-albums-container')?.hasAttribute('aria-busy') &&
    !document.getElementById('gallery-albums-new')?.hasAttribute('aria-disabled') &&
    !!document.getElementById('gallery-albums-load-error') &&
    !!document.querySelector('#toast.error .toast-message')?.textContent.includes('Could not confirm album creation')
  );
  assert.equal(firstHold.aborted, true, 'deadline aborts the held response body');
  assert.equal(await page.locator('.gallery-album-card[data-album="alpha"]').count(), 1, 'last successful album row remains available');

  // Retry the failed list load, then retry create successfully and verify cache/list.
  await page.locator('#gallery-albums-load-error button').click();
  await page.locator('#gallery-albums-load-error').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.gallery-album-card[data-album="alpha"]').count(), 1);
  createPlans.push({ ok: true, id: 'created-retry' });
  await page.locator('#gallery-albums-new').click();
  await page.locator('#styled-prompt-input').fill('Album after retry');
  await page.locator('#styled-prompt-ok').click();
  await page.locator('.gallery-album-card[data-album="created-retry"]').waitFor();

  // An older load's timer must not clear a newer reopened Gallery load's busy state.
  createPlans.push({ ok: false, status: 503 });
  const oldHold = makeListPlan('hold-body');
  await page.locator('#gallery-albums-new').click();
  await page.locator('#styled-prompt-input').fill('Another album');
  await page.locator('#styled-prompt-ok').click();
  await oldHold.seen;
  await page.clock.runFor(5000);
  const newHold = makeListPlan('hold-body');
  await page.locator('#gallery-close').click();
  await page.waitForFunction(() => !window.gallery.isGalleryOpen());
  await page.clock.runFor(300);
  await page.evaluate(() => window.gallery.openGallery());
  await newHold.seen;
  assert.equal(await page.locator('#gallery-albums-container').getAttribute('aria-busy'), 'true');
  await page.clock.runFor(10001);
  await oldHold.closed;
  await page.waitForFunction(() => !document.getElementById('gallery-albums-new')?.hasAttribute('aria-disabled'));
  const overlapState = await page.evaluate(() => ({
    currentLoadBusy: document.getElementById('gallery-albums-container')?.getAttribute('aria-busy'),
    currentLoadError: !!document.getElementById('gallery-albums-load-error'),
  }));
  assert.equal(oldHold.aborted, true);
  assert.equal(overlapState.currentLoadBusy, 'true', 'stale request timeout cannot clear newer load busy state');
  assert.equal(overlapState.currentLoadError, false, 'stale timeout cannot replace newer load with an error');
  releaseList(newHold);
  await page.waitForFunction(() => !document.getElementById('gallery-albums-container')?.hasAttribute('aria-busy'));
  assert.equal(await page.locator('.gallery-album-card[data-album="alpha"]').count(), 1);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(externalRequests, []);
  console.log(JSON.stringify({
    pass: true,
    result: 'PASS',
    sourceHash,
    cases: {
      heldBodyTimeoutAfterFailedCreate: { stateBeforeTimeout: firstPending, requestAborted: firstHold.aborted, failureWarningAppeared: true, createUnlocked: true, priorRowRetained: true },
      listRetryAndCreateRetry: { albumListRecovered: true, createdRowVisible: true },
      staleTimerDoesNotClearNewLoadBusy: { oldRequestAborted: oldHold.aborted, newerBusyAfterOldTimeout: overlapState.currentLoadBusy, newerErrorAfterOldTimeout: overlapState.currentLoadError },
    },
    pageErrors,
    externalRequests: externalRequests.length,
    clock: 'Playwright simulated page timers advanced through the 15-second deadline; this is not a 15-second wall-clock timing measurement.',
    cleanup: 'finally releases any held response, closes owned browser, and closes all owned server connections.'
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  for (const hold of activeHolds) releaseList(hold);
  if (browser) await browser.close().catch(() => {});
  if (server.listening) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
