const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = process.env.SOURCE_ROOT || path.resolve(__dirname, '../..');
const browserExecutable = process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome';
const seed = [
  { id: 'fixture-A', query: 'Synthetic A', source_count: 0, completed_at: 1, archived: false },
  { id: 'fixture-B', query: 'Synthetic B', source_count: 0, completed_at: 2, archived: false },
];
let records = [];
let failures = new Map();
const heldKeys = new Set();
const heldReplies = new Map();
const heldWaiters = new Map();
const calls = [];
const unexpected = [];
const external = [];
const pageErrors = [];
const html = `<!doctype html><meta charset="utf-8"><body>
  <button id="tool-doclib-btn"></button>
  <script type="module">
    import {initLibrary,openLibrary} from '/static/js/documentLibrary.js';
    import ui from '/static/js/ui.js?v=20260916largetoolscroll1';
    window.feedback=[];
    ui.showToast=m=>feedback.push({kind:'toast',message:String(m)});
    ui.showError=m=>feedback.push({kind:'error',message:String(m)});
    const confirm=async()=>true;
    ui.styledConfirm=window.styledConfirm=confirm;
    window.setConfirm=fn=>{ui.styledConfirm=window.styledConfirm=fn;};
    window.holdConfirm=()=>{
      window.confirmMessages=[]; window.confirmResolvers=[];
      window.setConfirm(message=>new Promise(resolve=>{
        window.confirmMessages.push(String(message)); window.confirmResolvers.push(resolve);
      }));
    };
    window.resolveConfirm=answer=>window.confirmResolvers.shift()?.(answer);
    initLibrary({apiBase:'',esc:s=>String(s??''),getDocs:()=>new Map(),isOpen:()=>false,
      createDocument:()=>{},newDocument:()=>{},loadDocument:()=>{},prepareDocumentOpen:()=>{},
      switchToDoc:()=>{},openPanel:()=>{},addDocToTabs:()=>{},syncDocIndicator:()=>{}});
    openLibrary({tab:'research'}); window.ready=true;
  </script>
</body>`;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function requestKey(method, pathname, search = '') { return `${method} ${pathname}${search}`; }
function waitForHeldResponse(key) {
  if (heldReplies.has(key)) return Promise.resolve(heldReplies.get(key));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { heldWaiters.delete(key); reject(new Error(`Timed out waiting for ${key}`)); }, 5000);
    heldWaiters.set(key, release => { clearTimeout(timer); heldWaiters.delete(key); resolve(release); });
  });
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname.startsWith('/api/')) calls.push({ method: req.method, path: url.pathname, search: url.search });
  if (url.pathname === '/api/research/library') {
    const archived = url.searchParams.get('archived') === 'true';
    return json(res, 200, { research: records.filter(record => record.archived === archived) });
  }
  if (url.pathname.startsWith('/api/research/detail/')) {
    return json(res, 200, { id: url.pathname.split('/').at(-1), result: 'Synthetic report only', sources: [] });
  }
  const mutation = url.pathname.match(/^\/api\/research\/(fixture-[AB])(?:\/archive)?$/);
  if (mutation) {
    const key = requestKey(req.method, url.pathname, url.search);
    const outcome = failures.get(key);
    if (outcome === 'network') { res.destroy(); return; }
    if (Number.isInteger(outcome)) return json(res, outcome, { detail: 'synthetic private response body' });
    if (req.method === 'DELETE') records = records.filter(record => record.id !== mutation[1]);
    else if (req.method === 'POST') {
      const record = records.find(item => item.id === mutation[1]);
      if (record) record.archived = url.searchParams.get('archived') === 'true';
    } else unexpected.push({ method: req.method, path: url.pathname });
    if (heldKeys.has(key)) {
      const release = () => json(res, 200, { ok: true });
      heldReplies.set(key, release);
      heldWaiters.get(key)?.(release);
      return;
    }
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/documents/library') return json(res, 200, { documents: [], languages: {}, total: 0, session_count: 0 });
  if (url.pathname === '/api/sessions/archived') return json(res, 200, { sessions: [] });
  if (['/api/prefs/theme', '/api/auth/settings', '/api/prefs/custom-themes', '/api/tts/stats'].includes(url.pathname)) return json(res, 200, {});
  if (url.pathname === '/api/auth/status') return json(res, 200, { authenticated: false });
  if (url.pathname === '/api/tools') return json(res, 200, []);
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url.pathname.startsWith('/api/')) { unexpected.push({ method: req.method, path: url.pathname }); return json(res, 404, {}); }
  const disk = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!disk.startsWith(repo + path.sep) || !fs.existsSync(disk) || !fs.statSync(disk).isFile()) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', /\.(?:js|mjs)$/.test(disk) ? 'text/javascript' : disk.endsWith('.css') ? 'text/css' : 'text/plain');
  fs.createReadStream(disk).pipe(res);
});

(async () => {
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:/);
    browser = await chromium.launch({ headless: true, executablePath: browserExecutable, args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('requestfailed', request => {
      if (request.url().startsWith(origin) && request.url().includes('/api/research/fixture-A')) return;
      if (request.url().startsWith(origin)) unexpected.push({ failed: request.url() });
    });
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) {
        external.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });

    const row = id => page.locator(`#doclib-research-grid .doclib-research-card[data-research-id="${id}"]`);
    const reset = async ({ archived = [] } = {}) => {
      records = seed.map(record => ({ ...record, archived: archived.includes(record.id) }));
      failures = new Map();
      heldKeys.clear(); heldReplies.clear();
      await page.goto(origin, { waitUntil: 'load' });
      await page.waitForFunction(() => window.ready && document.querySelectorAll('#doclib-research-grid .doclib-research-card').length === 2);
    };
    const select = async (...ids) => {
      if (!(await page.locator('#doclib-research-select-btn').evaluate(node => node.classList.contains('active')))) {
        await page.locator('#doclib-research-select-btn').click();
      }
      for (const id of ids) await row(id).locator('._res-cb').check();
    };
    const setFailure = (method, id, status, search = '') => failures.set(requestKey(method, `/api/research/${id}${method === 'POST' ? '/archive' : ''}`, search), status);
    const feedback = () => page.evaluate(() => window.feedback);
    const waitError = async () => page.waitForFunction(() => window.feedback.some(item => item.kind === 'error'));
    const clickMenuAction = async (id, label) => {
      await row(id).locator('.doclib-research-delete').click();
      const action = page.locator('._lib-dd .dropdown-item-compact').filter({ hasText: label });
      await action.click();
    };

    // Preview delete: HTTP failure retains the report and hides private response text; retry succeeds.
    await reset();
    await row('fixture-A').click();
    setFailure('DELETE', 'fixture-A', 403);
    await row('fixture-A').locator('.doclib-chat-delete-btn').click();
    await waitError();
    let state = await feedback();
    assert.equal(await row('fixture-A').count(), 1);
    assert.equal(records.some(record => record.id === 'fixture-A'), true);
    assert.equal(state.some(item => item.kind === 'toast'), false);
    assert.equal(JSON.stringify(state).includes('private response body'), false);
    failures.clear();
    await row('fixture-A').locator('.doclib-chat-delete-btn').click();
    await page.waitForFunction(() => !document.querySelector('#doclib-research-grid [data-research-id="fixture-A"]'));
    assert.equal(records.some(record => record.id === 'fixture-A'), false);
    const previewDeleteRetry = true;

    // Preview archive: failed POST keeps the item; a real successful retry moves it.
    await reset();
    await row('fixture-A').click();
    setFailure('POST', 'fixture-A', 503, '?archived=true');
    await row('fixture-A').locator('.doclib-chat-archive-btn').click();
    await waitError();
    assert.equal(await row('fixture-A').count(), 1);
    assert.equal(records.find(record => record.id === 'fixture-A').archived, false);
    state = await feedback();
    assert.equal(state.some(item => item.kind === 'toast'), false);
    failures.clear();
    await row('fixture-A').locator('.doclib-chat-archive-btn').click();
    await page.waitForFunction(() => !document.querySelector('#doclib-research-grid [data-research-id="fixture-A"]'));
    assert.equal(records.find(record => record.id === 'fixture-A').archived, true);
    const previewArchiveRetry = true;

    // Row-menu Archive and Delete both require HTTP success; failures undo their exit animation.
    await reset();
    setFailure('POST', 'fixture-A', 503, '?archived=true');
    await clickMenuAction('fixture-A', 'Archive');
    await waitError();
    assert.equal(await row('fixture-A').count(), 1);
    assert.equal(await row('fixture-A').evaluate(node => getComputedStyle(node).opacity), '1');
    failures.clear();
    await clickMenuAction('fixture-A', 'Archive');
    await page.waitForFunction(() => !document.querySelector('#doclib-research-grid [data-research-id="fixture-A"]'));
    assert.equal(records.find(record => record.id === 'fixture-A').archived, true);
    const menuArchiveRetry = true;

    await reset();
    setFailure('DELETE', 'fixture-A', 503);
    await clickMenuAction('fixture-A', 'Delete');
    await waitError();
    assert.equal(await row('fixture-A').count(), 1);
    assert.equal(await row('fixture-A').evaluate(node => getComputedStyle(node).opacity), '1');
    failures.clear();
    await clickMenuAction('fixture-A', 'Delete');
    await page.waitForFunction(() => !document.querySelector('#doclib-research-grid [data-research-id="fixture-A"]'));
    assert.equal(records.some(record => record.id === 'fixture-A'), false);
    const menuDeleteRetry = true;

    // Confirmed bulk delete uses its captured target IDs and leaves a newer selection alone.
    await reset();
    await select('fixture-A');
    await page.evaluate(() => window.holdConfirm());
    await page.locator('#doclib-research-bulk-delete').click();
    await page.waitForFunction(() => window.confirmResolvers?.length === 1);
    await page.locator('#doclib-research-bulk-cancel').click();
    await select('fixture-B');
    await page.evaluate(() => window.resolveConfirm(true));
    await page.waitForFunction(() => !document.querySelector('#doclib-research-grid [data-research-id="fixture-A"]'));
    assert.equal(records.some(record => record.id === 'fixture-A'), false);
    assert.equal(records.some(record => record.id === 'fixture-B'), true);
    assert.equal(await row('fixture-B').locator('._res-cb').isChecked(), true);
    const heldConfirmTargetsAAndPreservesB = true;

    // A response that arrives after the user changes selection still removes only the confirmed target.
    await reset();
    await select('fixture-A');
    const heldDeleteKey = requestKey('DELETE', '/api/research/fixture-A');
    heldKeys.add(heldDeleteKey);
    await page.locator('#doclib-research-bulk-delete').click();
    const releaseDelete = await waitForHeldResponse(heldDeleteKey);
    await select('fixture-B');
    releaseDelete();
    await page.waitForFunction(() => !document.querySelector('#doclib-research-grid [data-research-id="fixture-A"]'));
    assert.equal(records.some(record => record.id === 'fixture-A'), false);
    assert.equal(records.some(record => record.id === 'fixture-B'), true);
    assert.equal(await row('fixture-B').locator('._res-cb').isChecked(), true);
    const heldResponsePreservesNewSelection = true;

    // Partial bulk results remove confirmed successes only and retain failed/newer selections.
    await reset();
    await select('fixture-A', 'fixture-B');
    setFailure('DELETE', 'fixture-A', 403);
    await page.locator('#doclib-research-bulk-delete').click();
    await page.waitForFunction(() => !document.querySelector('#doclib-research-grid [data-research-id="fixture-B"]'));
    assert.equal(records.some(record => record.id === 'fixture-A'), true);
    assert.equal(records.some(record => record.id === 'fixture-B'), false);
    assert.equal(await row('fixture-A').locator('._res-cb').isChecked(), true);
    state = await feedback();
    assert.match(state.at(-1).message, /Deleted 1; Could not confirm deletion of 1 research report/);
    assert.match(state.at(-1).message, /HTTP 403/);
    assert.equal(JSON.stringify(state).includes('private response body'), false);
    const partialBulkDeletePreservesFailure = true;

    // Bulk archive captures its direction before the animation delay and preserves partial selection.
    await reset();
    await select('fixture-A', 'fixture-B');
    setFailure('POST', 'fixture-A', 503, '?archived=true');
    await page.locator('#doclib-research-bulk-archive').click();
    await page.waitForFunction(() => window.feedback.some(item => item.kind === 'error'));
    assert.equal(records.find(record => record.id === 'fixture-A').archived, false);
    assert.equal(records.find(record => record.id === 'fixture-B').archived, true);
    assert.equal(await row('fixture-A').locator('._res-cb').isChecked(), true);
    const partialBulkArchivePreservesFailure = true;

    // Tidy reports confirmed deletions, preserves a failed row, and restores its spinner.
    await reset();
    setFailure('DELETE', 'fixture-A', 503);
    await page.locator('#doclib-research-tidy-btn').click();
    await page.waitForFunction(() => window.feedback.some(item => item.kind === 'error'));
    assert.equal(await row('fixture-A').count(), 1);
    assert.equal(await row('fixture-B').count(), 0);
    assert.equal(records.some(record => record.id === 'fixture-A'), true);
    assert.equal(records.some(record => record.id === 'fixture-B'), false);
    assert.equal(await page.locator('#doclib-research-tidy-btn').isDisabled(), false);
    state = await feedback();
    assert.match(state.at(-1).message, /Deleted 1; Could not confirm deletion of 1 research report/);
    const tidyPartial = true;

    // Tidy may remove rows that were never selected; this must not cancel an empty Select mode.
    await reset();
    await page.locator('#doclib-research-select-btn').click();
    await page.locator('#doclib-research-tidy-btn').click();
    await page.waitForFunction(() => !document.querySelector('#doclib-research-grid .doclib-research-card'));
    assert.equal(await page.locator('#doclib-research-select-btn').evaluate(node => node.classList.contains('active')), true);
    assert.equal(await page.locator('#doclib-research-bulk').evaluate(node => node.classList.contains('hidden')), false);
    assert.equal(await page.locator('#doclib-research-grid ._res-cb:checked').count(), 0);
    const tidyKeepsEmptySelectMode = true;

    // A held completion for an old selected row must not cancel a newly re-entered empty Select mode.
    await reset();
    await select('fixture-A');
    const heldEmptyModeKey = requestKey('DELETE', '/api/research/fixture-A');
    heldKeys.add(heldEmptyModeKey);
    await page.locator('#doclib-research-bulk-delete').click();
    const releaseEmptyModeDelete = await waitForHeldResponse(heldEmptyModeKey);
    assert.equal(records.some(record => record.id === 'fixture-A'), false);
    await page.locator('#doclib-research-bulk-cancel').click();
    await page.locator('#doclib-research-select-btn').click();
    assert.equal(await page.locator('#doclib-research-select-btn').evaluate(node => node.classList.contains('active')), true);
    assert.equal(await page.locator('#doclib-research-grid ._res-cb:checked').count(), 0);
    releaseEmptyModeDelete();
    await page.waitForFunction(() => !document.querySelector('#doclib-research-grid .doclib-research-card[data-research-id="fixture-A"]'));
    assert.equal(await page.locator('#doclib-research-select-btn').evaluate(node => node.classList.contains('active')), true);
    assert.equal(await page.locator('#doclib-research-bulk').evaluate(node => node.classList.contains('hidden')), false);
    assert.equal(await page.locator('#doclib-research-grid ._res-cb:checked').count(), 0);
    const heldCompletionKeepsReenteredEmptySelectMode = true;

    // A network failure is reported as uncertain without exposing any response body or removing the row.
    await reset();
    failures.set(requestKey('DELETE', '/api/research/fixture-A'), 'network');
    await clickMenuAction('fixture-A', 'Delete');
    await waitError();
    assert.equal(await row('fixture-A').count(), 1);
    state = await feedback();
    assert.match(state.at(-1).message, /Could not confirm deletion of 1 research report/);
    assert.doesNotMatch(state.at(-1).message, /HTTP/);

    // Canceling the confirmation sends no DELETE and preserves the selected row.
    await reset();
    await select('fixture-A');
    await page.evaluate(() => window.setConfirm(async () => false));
    const beforeCancel = calls.length;
    await page.locator('#doclib-research-bulk-delete').click();
    assert.equal(calls.slice(beforeCancel).filter(call => call.method === 'DELETE').length, 0);
    assert.equal(await row('fixture-A').count(), 1);
    assert.equal(await row('fixture-A').locator('._res-cb').isChecked(), true);
    const cancelSendsNothing = true;

    // All-success bulk operations retain truthful success counts.
    await reset();
    await select('fixture-A', 'fixture-B');
    await page.locator('#doclib-research-bulk-delete').click();
    await page.waitForFunction(() => !document.querySelector('#doclib-research-grid .doclib-research-card'));
    assert.equal(records.length, 0);
    state = await feedback();
    assert.deepEqual(state, []); // Bulk delete had no success toast before this fix.
    const bulkSuccess = true;

    assert.deepEqual(unexpected, []);
    assert.deepEqual(external, []);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({
      result: 'confirmed',
      previewDeleteRetry,
      previewArchiveRetry,
      menuArchiveRetry,
      menuDeleteRetry,
      heldConfirmTargetsAAndPreservesB,
      heldResponsePreservesNewSelection,
      partialBulkDeletePreservesFailure,
      partialBulkArchivePreservesFailure,
      tidyPartial,
      tidyKeepsEmptySelectMode,
      heldCompletionKeepsReenteredEmptySelectMode,
      cancelSendsNothing,
      bulkSuccess,
      syntheticOnly: true,
      requests: calls.length,
      unexpected,
      external,
      pageErrors,
    }));
  } finally {
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
