const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(repo, 'static/js/documentLibrary.js'), 'utf8');
const start = source.indexOf('    function _renderLibArchive() {');
const end = source.indexOf('\n    // Inline expand/collapse for an archived DOCUMENT card', start);
assert.ok(start >= 0 && end > start, 'archive loader source boundary');
const loaderSource = source.slice(start, end);
const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
const loaderHash = crypto.createHash('sha256').update(loaderSource).digest('hex');

const routes = {
  sessions: '/api/sessions/archived?limit=100&sort=recent',
  documents: '/api/documents/library?archived=true&limit=50',
  research: '/api/research/library?archived=true',
};
const kindFor = raw => {
  const url = new URL(raw, 'http://127.0.0.1');
  if (url.pathname === '/api/sessions/archived') return 'sessions';
  if (url.pathname === '/api/documents/library') return 'documents';
  if (url.pathname === '/api/research/library') return 'research';
  throw new Error(`unexpected synthetic URL ${url.pathname}`);
};
const makePayload = (prefix, kind) => ({
  [kind]: [{ id: `${prefix}-${kind}`, title: `Synthetic ${prefix} ${kind}` }],
});
const seen = new Map();
const seenWaiters = [];
const heldBodies = new Map();
const holdCloseWaiters = new Map();
const unmatched = [];
const requests = [];
let server;

function notifySeen(batch) {
  seen.set(batch, (seen.get(batch) || 0) + 1);
  for (let i = seenWaiters.length - 1; i >= 0; i--) {
    const waiter = seenWaiters[i];
    if ((seen.get(waiter.batch) || 0) >= waiter.count) {
      seenWaiters.splice(i, 1);
      waiter.resolve();
    }
  }
}
function waitSeen(batch, count = 3) {
  if ((seen.get(batch) || 0) >= count) return Promise.resolve();
  return new Promise(resolve => seenWaiters.push({ batch, count, resolve }));
}
function holdResponse(batch, kind, res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  if (status === 200) res.flushHeaders();
  const key = `${batch}/${kind}`;
  res.on('close', () => {
    heldBodies.delete(key);
    for (const resolve of holdCloseWaiters.get(key) || []) resolve();
    holdCloseWaiters.delete(key);
  });
  heldBodies.set(key, () => res.end(JSON.stringify(body)));
}
function releaseBatch(batch) {
  for (const [key, release] of [...heldBodies]) {
    if (key.startsWith(`${batch}/`)) {
      heldBodies.delete(key);
      release();
    }
  }
}
function waitHeldClosed(batch, kind, ms = 3000) {
  const key = `${batch}/${kind}`;
  if (!heldBodies.has(key)) return Promise.resolve();
  return Promise.race([
    new Promise(resolve => {
      const waiters = holdCloseWaiters.get(key) || [];
      waiters.push(resolve);
      holdCloseWaiters.set(key, waiters);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`held response did not close: ${key}`)), ms)),
  ]);
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
function responseFor(batch, kind) {
  if (batch === 'valid-empty') return { status: 200, body: { [kind]: [] } };
  if (kind === 'documents' && batch === 'missing-row-id') return { status: 200, body: { documents: [{ title: 'Malformed no ID' }] } };
  if (kind === 'documents' && batch === 'empty-row-id') return { status: 200, body: { documents: [{ id: '   ', title: 'Malformed empty ID' }] } };
  if (kind === 'documents' && batch === 'numeric-row-id') return { status: 200, body: { documents: [{ id: 42, title: 'Malformed numeric ID' }] } };
  if (batch === 'status-failure' && kind === 'sessions') return { status: 503, body: { detail: 'PRIVATE SYNTHETIC DETAIL' } };
  if (batch === 'malformed-json' && kind === 'research') return { status: 200, raw: '{ malformed json' };
  if (batch === 'malformed-shape' && kind === 'documents') return { status: 200, body: { documents: 'not-an-array' } };
  if (batch === 'reopen-new') return { status: 200, body: makePayload('reopened', kind) };
  if (batch === 'retry') return { status: 200, body: makePayload('retry', kind) };
  if (batch === 'newer') return { status: 200, body: makePayload('newer', kind) };
  return { status: 200, body: makePayload('last-good', kind) };
}

server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><meta charset="utf-8"><body><div id="doclib-arc-grid"></div><div id="doclib-arc-chips"></div></body>');
  }
  if (!url.pathname.startsWith('/api/')) {
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    unmatched.push(url.pathname);
    res.writeHead(404); return res.end();
  }
  const batch = String(req.headers['x-archive-proof-batch'] || '');
  const kind = kindFor(req.url);
  requests.push({ batch, kind, method: req.method });
  notifySeen(batch);
  if (batch === 'older-detached' || batch === 'older-reopen') {
    const failed = batch === 'older-reopen';
    return holdResponse(batch, kind, res, failed ? 503 : 200,
      failed ? { detail: 'PRIVATE STALE RESPONSE DETAIL' } : makePayload('stale', kind));
  }
  if (batch === 'headers-timeout' && kind === 'documents') {
    const key = `${batch}/${kind}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    res.on('close', () => {
      heldBodies.delete(key);
      for (const resolve of holdCloseWaiters.get(key) || []) resolve();
      holdCloseWaiters.delete(key);
    });
    heldBodies.set(key, () => res.end(JSON.stringify(makePayload('late-body', kind))));
    return;
  }
  const result = responseFor(batch, kind);
  if (result.raw !== undefined) {
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    return res.end(result.raw);
  }
  json(res, result.status, result.body);
});

function boundedCloseServer() {
  return new Promise(resolve => {
    server.close(resolve);
    const timer = setTimeout(() => { server.closeAllConnections?.(); resolve(); }, 1000);
    timer.unref?.();
  });
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.match(origin, /^http:\/\/127\.0\.0\.1:/);
  if (!process.env.BROWSER_EXECUTABLE) throw new Error('BROWSER_EXECUTABLE is required for this opt-in browser proof');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const externalRequests = [];
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    await page.route('**/*', route => {
      const requested = new URL(route.request().url());
      if (requested.origin !== origin) {
        externalRequests.push(requested.href);
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(origin, { waitUntil: 'load', timeout: 10000 });
    await page.evaluate(({ origin, loaderSource }) => {
      window.fixtureMetrics = { responses: [], json: [], finished: [], external: [] };
      window.currentArchiveBatch = '';
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (raw, init = {}) => {
        const url = new URL(raw, location.href);
        if (url.origin !== origin) {
          window.fixtureMetrics.external.push(url.href);
          throw new Error('non-loopback request blocked');
        }
        const batch = window.currentArchiveBatch;
        const headers = new Headers(init.headers || {});
        headers.set('x-archive-proof-batch', batch);
        try {
          const response = await nativeFetch(url.href, { ...init, headers });
          window.fixtureMetrics.responses.push(batch);
          const json = response.json.bind(response);
          response.json = async () => {
            try { return await json(); }
            finally { window.fixtureMetrics.json.push(batch); }
          };
          return response;
        } finally {
          window.fixtureMetrics.finished.push(batch);
        }
      };
      const create = new Function('API_BASE', 'spinnerModule', `
        let _arcSessions = [], _arcDocs = [], _arcResearch = [];
        let _arcSearch = '', _arcSort = 'recent', _arcSelectMode = false;
        const _arcSelected = new Set();
        let _arcSelectionRevision = 0, _arcModelFilter = '', _arcTypeFilter = '';
        let _arcLoadGeneration = 0;
        function _renderArcGrid() {
          const grid = document.getElementById('doclib-arc-grid');
          const state = { sessions: _arcSessions.map(x => x.id), documents: _arcDocs.map(x => x.id), research: _arcResearch.map(x => x.id) };
          const count = Number(grid.dataset.renderCount || 0) + 1;
          grid.dataset.renderCount = String(count);
          grid.dataset.state = JSON.stringify(state);
          grid.replaceChildren();
          const rows = [..._arcSessions, ..._arcDocs, ..._arcResearch];
          if (!rows.length) {
            const empty = document.createElement('div'); empty.className = 'doclib-empty'; empty.textContent = 'No archived items'; grid.appendChild(empty);
          } else {
            rows.forEach(row => { const item = document.createElement('div'); item.className = 'archive-row'; item.textContent = row.id; grid.appendChild(item); });
          }
        }
        function _renderArcChips() {
          const chips = document.getElementById('doclib-arc-chips');
          chips.dataset.count = String(_arcSessions.length + _arcDocs.length + _arcResearch.length);
        }
        ${loaderSource}
        return {
          render: _renderLibArchive,
          state: () => ({ sessions: _arcSessions.map(x => x.id), documents: _arcDocs.map(x => x.id), research: _arcResearch.map(x => x.id) }),
          setBatch: value => { window.currentArchiveBatch = value; },
        };
      `);
      window.archiveHarness = create(origin, { createLoadingRow: label => { const row = document.createElement('div'); row.textContent = label; return row; } });
    }, { origin, loaderSource });

    async function begin(batch) { await page.evaluate(value => { window.archiveHarness.setBatch(value); window.archiveHarness.render(); }, batch); }
    async function waitForSeen(batch) { await waitSeen(batch, 3); }
    async function waitState(prefix, grid = '#doclib-arc-grid') {
      await page.waitForFunction(({ prefix, grid }) => {
        const element = document.querySelector(grid);
        if (!element?.dataset.state) return false;
        const state = JSON.parse(element.dataset.state);
        return [...state.sessions, ...state.documents, ...state.research].every(id => id.startsWith(prefix));
      }, { prefix, grid }, { timeout: 8000 });
    }
    async function flushBrowserTasks() { await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0))); }
    const result = {};

    await begin('last-good'); await waitForSeen('last-good'); await waitState('last-good');
    const lastGood = await page.evaluate(() => window.archiveHarness.state());
    assert.deepEqual(lastGood, { sessions: ['last-good-sessions'], documents: ['last-good-documents'], research: ['last-good-research'] });
    result.validStringIdControl = lastGood.documents.every(id => typeof id === 'string' && id.trim());

    await begin('status-failure'); await waitForSeen('status-failure');
    await page.waitForSelector('#doclib-arc-grid [role="alert"]', { timeout: 5000 });
    const failedState = await page.evaluate(() => ({
      state: window.archiveHarness.state(),
      alert: document.querySelector('#doclib-arc-grid [role="alert"]')?.textContent.trim(),
      retry: (() => { const button = document.querySelector('#doclib-arc-grid button'); const rect = button?.getBoundingClientRect(); return { label: button?.textContent, width: rect?.width, height: rect?.height }; })(),
    }));
    assert.deepEqual(failedState.state, lastGood, 'one failed category preserves all three last-good arrays');
    assert.equal(failedState.alert, 'Could not load archived items.Retry');
    assert.ok(failedState.retry.width >= 44 && failedState.retry.height >= 44);
    assert.equal(failedState.retry.label, 'Retry');
    result.status_failure = failedState;

    await page.evaluate(() => window.archiveHarness.setBatch('retry'));
    await page.locator('#doclib-arc-grid button[aria-label="Retry loading archived items"]').click();
    await waitForSeen('retry'); await waitState('retry');
    assert.deepEqual(await page.evaluate(() => window.archiveHarness.state()), { sessions: ['retry-sessions'], documents: ['retry-documents'], research: ['retry-research'] });
    result.retry = true;

    for (const batch of ['malformed-json', 'malformed-shape', 'missing-row-id', 'empty-row-id', 'numeric-row-id']) {
      await begin(batch); await waitForSeen(batch);
      await page.waitForSelector('#doclib-arc-grid [role="alert"]', { timeout: 5000 });
      assert.deepEqual(await page.evaluate(() => window.archiveHarness.state()), { sessions: ['retry-sessions'], documents: ['retry-documents'], research: ['retry-research'] }, `${batch} preserves all cached categories`);
    }
    result.malformedAndInvalidShapePreserveCache = true;

    await begin('valid-empty'); await waitForSeen('valid-empty');
    await page.waitForFunction(() => document.querySelector('#doclib-arc-grid')?.dataset.state === JSON.stringify({ sessions: [], documents: [], research: [] }));
    assert.equal(await page.locator('#doclib-arc-grid .doclib-empty').textContent(), 'No archived items');
    assert.equal(await page.locator('#doclib-arc-grid [role="alert"]').count(), 0);
    result.validEmpty = true;

    await begin('older-detached'); await waitForSeen('older-detached');
    await page.evaluate(() => document.getElementById('doclib-arc-grid').remove());
    releaseBatch('older-detached');
    await page.waitForFunction(() => window.fixtureMetrics.json.filter(batch => batch === 'older-detached').length === 3, undefined, { timeout: 5000 });
    await flushBrowserTasks();
    assert.deepEqual(await page.evaluate(() => window.archiveHarness.state()), { sessions: [], documents: [], research: [] }, 'detached old grid cannot mutate archive cache');
    result.detachedOldGridIgnored = true;

    await page.evaluate(() => { const grid = document.createElement('div'); grid.id = 'doclib-arc-grid'; document.body.appendChild(grid); });
    await begin('older-reopen'); await waitForSeen('older-reopen');
    await page.evaluate(() => { const old = document.getElementById('doclib-arc-grid'); old.remove(); const grid = document.createElement('div'); grid.id = 'doclib-arc-grid'; document.body.appendChild(grid); });
    await begin('reopen-new'); await waitForSeen('reopen-new'); await waitState('reopened');
    releaseBatch('older-reopen');
    await page.waitForFunction(() => window.fixtureMetrics.finished.filter(batch => batch === 'older-reopen').length === 3, undefined, { timeout: 5000 });
    await flushBrowserTasks();
    assert.deepEqual(await page.evaluate(() => window.archiveHarness.state()), { sessions: ['reopened-sessions'], documents: ['reopened-documents'], research: ['reopened-research'] });
    assert.equal(await page.locator('#doclib-arc-grid [role="alert"]').count(), 0, 'stale failure cannot replace reopened grid');
    result.reopenedGridIgnoresStaleFailure = true;

    const timeoutStarted = Date.now();
    await begin('headers-timeout'); await waitForSeen('headers-timeout');
    await waitHeldClosed('headers-timeout', 'documents', 20000);
    await page.waitForSelector('#doclib-arc-grid [role="alert"]', { timeout: 5000 });
    const elapsed = Date.now() - timeoutStarted;
    // The operation's 15-second native timer aborts a response whose headers arrived but JSON body never did.
    assert.deepEqual(await page.evaluate(() => window.archiveHarness.state()), { sessions: ['reopened-sessions'], documents: ['reopened-documents'], research: ['reopened-research'] });
    assert.ok(elapsed >= 14000 && elapsed < 21000, `expected native 15s deadline, elapsed=${elapsed}`);
    result.headersThenHeldJsonAborted = { elapsedMs: elapsed };
    await page.evaluate(() => window.archiveHarness.setBatch('retry'));
    await page.locator('#doclib-arc-grid button[aria-label="Retry loading archived items"]').click();
    await waitForSeen('retry'); await waitState('retry');
    result.retryAfterTimeout = true;

    const browserState = await page.evaluate(() => ({ external: window.fixtureMetrics.external, requests: window.fixtureMetrics.responses }));
    assert.deepEqual(browserState.external, []);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(unmatched, []);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ pass: true, sourceHash, loaderHash, result, requestCount: requests.length, browserState, externalRequests, unmatched, pageErrors }, null, 2));
  } finally {
    await browser.close();
  }
})().finally(async () => {
  for (const release of heldBodies.values()) release();
  heldBodies.clear();
  server.closeAllConnections?.();
  await boundedCloseServer();
}).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
