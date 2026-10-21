'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = process.env.SOURCE_ROOT || path.resolve(__dirname, '../..');
const galleryPath = path.join(repo, 'static/js/gallery.js');
const gallerySource = fs.readFileSync(process.env.GALLERY_SOURCE_FILE || galleryPath, 'utf8');
const sourceHash = crypto.createHash('sha256').update(gallerySource).digest('hex');
const originalLoader = 'async function _renderEditorDrafts() {';
const instrumentedLoader = 'async function _renderEditorDraftsImpl() {';
if (gallerySource.split(originalLoader).length !== 2) throw new Error('Expected one draft loader declaration');
const galleryForTest = gallerySource
  .replace(originalLoader, instrumentedLoader)
  .replace('// Re-render only the grid (and bulk bar) from cached drafts + search +', `function _renderEditorDrafts() {
  const pending = _renderEditorDraftsImpl();
  window.__galleryDraftLoads ||= [];
  window.__galleryDraftLoads.push(pending);
  return pending;
}

// Re-render only the grid (and bulk bar) from cached drafts + search +`);
if (galleryForTest === gallerySource) throw new Error('Test loader wrapper was not installed');
const instrumentedSourceHash = crypto.createHash('sha256').update(galleryForTest).digest('hex');
const { withAppStyles } = require('./app_styles.cjs');
let drafts = [];
let deleteMode = 'success';
let getMode = 'normal';
let deleteAttempts = [];
let heldDelete = null;
let pending = 0;
const externalRequests = [];
const html = `<!doctype html><meta charset="utf-8"><!-- APP_STYLESHEET_LINKS --><body>
<script type="module">
  import ui from '/static/js/ui.js?v=20260916largetoolscroll1';
  import gallery from '/static/js/gallery.js';
  window.fixture = { ready: false, confirms: 0, confirmResolve: null, errors: [], toasts: [] };
  window.__galleryBulkDeleteRuns = [];
  window.__gallerySingleDeleteRuns = [];
  const addEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (type === 'click' && this.id === 'gallery-editor-drafts-bulk-delete') {
      const wrapped = function(...args) {
        const result = listener.apply(this, args);
        window.__galleryBulkDeleteRuns.push(result);
        return result;
      };
      return addEventListener.call(this, type, wrapped, options);
    }
    if (type === 'click' && this.classList?.contains('gallery-editor-draft-delete')) {
      const wrapped = function(...args) {
        const result = listener.apply(this, args);
        window.__gallerySingleDeleteRuns.push(result);
        return result;
      };
      return addEventListener.call(this, type, wrapped, options);
    }
    return addEventListener.call(this, type, listener, options);
  };
  ui.styledConfirm = async () => {
    window.fixture.confirms++;
    if (window.fixture.holdConfirm) return new Promise(resolve => {
      window.fixture.confirmResolve = value => { window.fixture.confirmResolve = null; resolve(value); };
    });
    return window.fixture.confirmResult !== false;
  };
  ui.styledPrompt = async () => null;
  ui.showError = message => window.fixture.errors.push(String(message));
  ui.showToast = message => window.fixture.toasts.push(String(message));
  gallery.openGallery();
  const modal = document.getElementById('gallery-modal');
  modal.classList.remove('hidden', 'modal-minimized');
  modal.style.setProperty('display', 'flex', 'important');
  window.fixture.ready = true;
</script></body>`;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function settle(res) {
  let done = false;
  const finish = () => { if (!done) { done = true; pending--; } };
  res.once('finish', finish);
  res.once('close', finish);
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { withAppStyles(html).then(styled => res.end(styled)); return; }
  if (url.pathname === '/__state') { json(res, 200, { drafts, deleteMode, getMode, deleteAttempts, pending, held: Boolean(heldDelete) }); return; }
  if (url.pathname === '/__configure' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const value = JSON.parse(body);
      drafts = value.drafts;
      deleteMode = value.deleteMode || 'success';
      getMode = value.getMode || 'normal';
      deleteAttempts = [];
      json(res, 200, { ok: true });
    });
    return;
  }
  if (url.pathname === '/__hold-confirm' && req.method === 'POST') { json(res, 200, { ok: true }); return; }
  if (url.pathname === '/__release-confirm' && req.method === 'POST') {
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/__release-held' && req.method === 'POST') {
    if (!heldDelete) { json(res, 409, { error: 'no held delete' }); return; }
    const { response, id } = heldDelete;
    heldDelete = null;
    drafts = drafts.filter(draft => draft.id !== id);
    json(response, deleteMode === 'held-committed-error' ? 503 : 200,
      deleteMode === 'held-committed-error' ? { detail: 'Synthetic uncertain result' } : { ok: true });
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/editor-drafts' && req.method === 'GET') {
    if (getMode === 'server-error') { json(res, 503, { detail: 'Synthetic refresh failure' }); return; }
    json(res, 200, { drafts });
    return;
  }
  if (url.pathname.startsWith('/api/editor-drafts/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.slice('/api/editor-drafts/'.length));
    deleteAttempts.push({ id, mode: deleteMode });
    pending++;
    settle(res);
    if (deleteMode === 'held-success' || deleteMode === 'held-committed-error') { heldDelete = { response: res, id }; return; }
    if (deleteMode === 'committed-error') {
      drafts = drafts.filter(draft => draft.id !== id);
      json(res, 503, { detail: 'Synthetic uncertain result' });
      return;
    }
    if (deleteMode === 'network-error') { req.socket.destroy(); return; }
    if (deleteMode === 'server-error') { json(res, 503, { detail: 'Synthetic unavailable' }); return; }
    if (deleteMode === 'success') {
      drafts = drafts.filter(draft => draft.id !== id);
      json(res, 200, { ok: true });
      return;
    }
    json(res, 500, { detail: 'Unknown fixture mode' });
    return;
  }
  if (url.pathname === '/api/gallery/albums') { json(res, 200, { albums: [] }); return; }
  if (url.pathname === '/api/gallery/library') { json(res, 200, { items: [], total: 0, tags: [], models: [] }); return; }
  if (url.pathname === '/api/tasks/notification-logs' && req.method === 'POST') { req.resume(); req.on('end', () => json(res, 200, { ok: true })); return; }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  if (file === galleryPath) { res.setHeader('Content-Type', 'text/javascript'); res.end(galleryForTest); return; }
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
  const state = () => page.evaluate(() => fetch('/__state', { cache: 'no-store' }).then(response => response.json()));
  const configure = value => page.evaluate(value => fetch('/__configure', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  }), value);
  const bulkRuns = () => page.evaluate(() => window.__galleryBulkDeleteRuns.length);
  const singleRuns = () => page.evaluate(() => window.__gallerySingleDeleteRuns.length);
  const completeRun = (kind, index) => page.evaluate(async ({ kind, index }) => await window[kind][index], { kind, index });
  const waitState = async predicate => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const current = await state();
      if (predicate(current)) return current;
      await page.waitForTimeout(30);
    }
    throw new Error(`Timed out waiting for loopback state: ${JSON.stringify({ state: await state(), runs: await page.evaluate(() => window.__gallerySingleDeleteRuns.length), errors: await page.evaluate(() => window.fixture.errors) })}`);
  };
  const openEditor = async () => {
    await page.locator('.gallery-tab[data-tab="images"]').click();
    const before = await page.evaluate(() => window.__galleryDraftLoads.length);
    await page.locator('.gallery-tab[data-tab="editor"]').click();
    await page.waitForFunction(n => window.__galleryDraftLoads.length > n, before);
    await page.evaluate(async () => await window.__galleryDraftLoads.at(-1));
  };
  const card = id => page.locator(`.gallery-editor-draft-card[data-draft-id="${id}"]`);
  const select = async id => {
    if (await page.locator('#gallery-editor-drafts-select').textContent() !== 'Cancel') await page.locator('#gallery-editor-drafts-select').click();
    await card(id).click();
  };
  await page.locator('.gallery-tab[data-tab="editor"]').click();
  await page.evaluate(async () => await window.__galleryDraftLoads.at(-1));

  if (process.env.EXPECT_PRE_FIX_CONFIRM_SNAPSHOT === '1') {
    await configure({ drafts: [{ id: 'bulk-a', name: 'Bulk A' }, { id: 'bulk-b', name: 'Bulk B' }], deleteMode: 'success' });
    await openEditor();
    await select('bulk-a');
    await page.evaluate(async () => { window.fixture.holdConfirm = true; await fetch('/__hold-confirm', { method: 'POST' }); });
    const before = (await state()).deleteAttempts.length;
    const operationIndex = await bulkRuns();
    await page.locator('#gallery-editor-drafts-bulk-delete').click();
    await page.waitForFunction(() => window.fixture.confirmResolve !== null);
    await card('bulk-b').click();
    await page.evaluate(() => window.fixture.confirmResolve(true));
    await page.evaluate(async () => { window.fixture.holdConfirm = false; await fetch('/__release-confirm', { method: 'POST' }); });
    await waitState(current => current.deleteAttempts.length > before);
    await waitForRun('bulk', operationIndex);
    const deleted = (await state()).deleteAttempts.map(item => item.id);
    assert.deepEqual(deleted, ['bulk-a', 'bulk-b'], 'base source reads mutable selection after confirmation');
    console.log(JSON.stringify({ pass: true, sourceHash, preFixDeletesAfterHeldConfirmation: deleted,
      limits: 'Base source, actual Gallery module, synthetic metadata and loopback only.' }, null, 2));
    return;
  }

  // Single delete checks HTTP failures, preserves the card, and allows explicit retry.
  const singleFailures = [];
  for (const mode of ['server-error', 'network-error']) {
    const id = `single-${mode}`;
    await configure({ drafts: [{ id, name: id }], deleteMode: mode });
    await openEditor();
    const index = await singleRuns();
    await card(id).locator('.gallery-editor-draft-delete').click();
    await waitState(current => current.deleteAttempts.length > 0);
    await waitForRun('single', index);
    assert.equal((await state()).drafts.some(draft => draft.id === id), true);
    assert.equal(await card(id).count(), 1, `${mode}: draft remains visible after reconciliation`);
    assert.match((await page.evaluate(() => window.fixture.errors.at(-1))), /could not confirm/i);
    singleFailures.push({ mode, draftPreserved: true, warningShown: true });
  }
  await configure({ drafts: [{ id: 'single-retry', name: 'Single retry' }], deleteMode: 'server-error' });
  await openEditor();
  let run = await singleRuns();
  await card('single-retry').locator('.gallery-editor-draft-delete').click();
  await waitForRun('single', run);
  await configure({ drafts: [{ id: 'single-retry', name: 'Single retry' }], deleteMode: 'success' });
  run = await singleRuns();
  await card('single-retry').locator('.gallery-editor-draft-delete').click();
  await waitForRun('single', run);
  assert.equal((await state()).drafts.some(draft => draft.id === 'single-retry'), false);

  // Bulk confirmation uses an immutable selection snapshot; cancel sends no DELETE.
  await configure({ drafts: [{ id: 'bulk-a', name: 'Bulk A' }, { id: 'bulk-b', name: 'Bulk B' }], deleteMode: 'success' });
  await openEditor();
  await select('bulk-a');
  await page.evaluate(async () => { window.fixture.holdConfirm = true; await fetch('/__hold-confirm', { method: 'POST' }); });
  const bulkIndex = await bulkRuns();
  const attemptsBeforeConfirm = (await state()).deleteAttempts.length;
  await page.locator('#gallery-editor-drafts-bulk-delete').click();
  await page.waitForFunction(() => window.fixture.confirmResolve !== null);
  await card('bulk-b').click();
  assert.match(await page.locator('#gallery-editor-drafts-bulk-count').textContent(), /2 selected/);
  await page.evaluate(() => window.fixture.confirmResolve(true));
  await page.evaluate(async () => { window.fixture.holdConfirm = false; await fetch('/__release-confirm', { method: 'POST' }); });
  await waitState(current => current.deleteAttempts.length > attemptsBeforeConfirm);
  await waitForRun('bulk', bulkIndex);
  assert.deepEqual((await state()).deleteAttempts.map(item => item.id), ['bulk-a'], 'only the pre-confirmation selection is deleted');
  assert.equal(await card('bulk-b').count(), 1);
  assert.equal((await card('bulk-b').getAttribute('class')).includes('selected'), true, 'newer selection survives');

  // A canceled confirmation performs no delete even if a later choice appears.
  await configure({ drafts: [{ id: 'cancel-a', name: 'Cancel A' }, { id: 'cancel-b', name: 'Cancel B' }], deleteMode: 'success' });
  await openEditor();
  await select('cancel-a');
  await page.evaluate(async () => { window.fixture.holdConfirm = true; await fetch('/__hold-confirm', { method: 'POST' }); });
  const cancelBulk = await bulkRuns();
  await page.locator('#gallery-editor-drafts-bulk-delete').click();
  await page.waitForFunction(() => window.fixture.confirmResolve !== null);
  await page.evaluate(() => window.fixture.confirmResolve(false));
  await page.evaluate(async () => { window.fixture.holdConfirm = false; await fetch('/__release-confirm', { method: 'POST' }); });
  await waitForRun('bulk', cancelBulk);
  assert.equal((await state()).deleteAttempts.length, 0, 'cancel makes no DELETE request');

  // A rejected bulk response preserves the selected ID and shows a warning.
  await configure({ drafts: [{ id: 'bulk-503', name: 'Bulk 503' }], deleteMode: 'server-error' });
  await openEditor();
  await select('bulk-503');
  const failedBulk = await bulkRuns();
  await page.locator('#gallery-editor-drafts-bulk-delete').click();
  await waitForRun('bulk', failedBulk);
  assert.equal(await card('bulk-503').count(), 1);
  assert.equal((await card('bulk-503').getAttribute('class')).includes('selected'), true);
  assert.match((await page.evaluate(() => window.fixture.errors.at(-1))), /could not confirm/i);

  // A non-2xx can follow a committed delete; refresh prunes the final selected ID.
  await configure({ drafts: [{ id: 'uncertain-a', name: 'Uncertain A' }, { id: 'remaining-b', name: 'Remaining B' }], deleteMode: 'committed-error' });
  await openEditor();
  await select('uncertain-a');
  const uncertainRun = await bulkRuns();
  await page.locator('#gallery-editor-drafts-bulk-delete').click();
  await waitForRun('bulk', uncertainRun);
  assert.equal(await card('uncertain-a').count(), 0, 'valid refresh shows the uncertainly deleted draft is absent');
  assert.equal(await card('remaining-b').count(), 1);
  assert.equal((await card('remaining-b').getAttribute('class')).includes('select-mode'), false,
    'last-ID pruning repaints cards after exiting select mode');
  assert.equal((await card('remaining-b').getAttribute('aria-label')).startsWith('Resume project'), true);
  assert.equal(await page.locator('#gallery-editor-drafts-select').textContent(), 'Select');

  // A failed list refresh retains a still-listed failed ID and its selection.
  await configure({ drafts: [{ id: 'failed-refresh-a', name: 'Failed refresh A' }], deleteMode: 'success' });
  await openEditor();
  await select('failed-refresh-a');
  await configure({ drafts: [{ id: 'failed-refresh-a', name: 'Failed refresh A' }], deleteMode: 'server-error', getMode: 'server-error' });
  const refreshFailureRun = await bulkRuns();
  await page.locator('#gallery-editor-drafts-bulk-delete').click();
  await waitForRun('bulk', refreshFailureRun);
  assert.equal(await card('failed-refresh-a').count(), 1);
  assert.equal((await card('failed-refresh-a').getAttribute('class')).includes('selected'), true);
  assert.equal(await page.locator('#gallery-editor-drafts-select').textContent(), 'Cancel');

  // Canceling selection while a delete is pending must stay canceled afterward.
  await configure({ drafts: [{ id: 'cancel-pending-a', name: 'Cancel pending A' }, { id: 'cancel-pending-b', name: 'Cancel pending B' }], deleteMode: 'held-committed-error' });
  await openEditor();
  await select('cancel-pending-a');
  const pendingRun = await bulkRuns();
  await page.locator('#gallery-editor-drafts-bulk-delete').click();
  await waitState(current => current.held);
  await page.locator('#gallery-editor-drafts-bulk-cancel').click();
  assert.equal(await page.locator('#gallery-editor-drafts-select').textContent(), 'Select');
  await page.evaluate(() => fetch('/__release-held', { method: 'POST' }));
  await waitForRun('bulk', pendingRun);
  assert.equal((await card('cancel-pending-a').count()), 0);
  assert.equal((await card('cancel-pending-b').getAttribute('class')).includes('selected'), false);
  assert.equal(await page.locator('#gallery-editor-drafts-select').textContent(), 'Select',
    'completion does not resurrect user-canceled selection mode');

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(externalRequests, []);
  console.log(JSON.stringify({
    pass: true,
    sourceHash,
    instrumentedSourceHash,
    singleFailures,
    singleRetrySucceeds: true,
    bulkSnapshotSurvivesHeldConfirmation: true,
    cancelMakesNoDelete: true,
    failedBulkPreservesSelectionAndWarns: true,
    uncertainCommittedDeleteRefreshReconcilesModeAndCards: true,
    failedRefreshPreservesFailedSelectedId: true,
    cancelWhileDeletePendingStaysCanceled: true,
    deleteAttempts: (await state()).deleteAttempts,
    pageErrors,
    externalRequests,
    limits: 'Actual Gallery module with synthetic project metadata and loopback requests only; no real drafts, media, accounts, models, providers, or hardware.'
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (heldDelete?.response) heldDelete.response.destroy();
  if (server.listening) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
  await browser?.close().catch(() => {});
});

async function waitForRun(kind, before) {
  const key = kind === 'single' ? '__gallerySingleDeleteRuns' : '__galleryBulkDeleteRuns';
  await page.waitForFunction(({ key, before }) => window[key].length > before, { key, before });
  await page.evaluate(async ({ key, before }) => await window[key][before], { key, before });
}
