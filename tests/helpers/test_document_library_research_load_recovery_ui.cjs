const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = process.env.SOURCE_ROOT || path.resolve(__dirname, '../..');
const browserExecutable = process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome';
const appHtml = `<!doctype html><meta charset="utf-8"><body>
  <button id="tool-doclib-btn"></button>
  <script type="module">
    import {initLibrary,openLibrary,closeLibrary} from '/static/js/documentLibrary.js';
    import ui from '/static/js/ui.js?v=20260916largetoolscroll1';
    window.feedback=[];
    ui.showToast=m=>feedback.push({kind:'toast',message:String(m)});
    ui.showError=m=>feedback.push({kind:'error',message:String(m)});
    ui.styledConfirm=async()=>true;
    initLibrary({apiBase:'',esc:s=>String(s??''),getDocs:()=>new Map(),isOpen:()=>false,
      createDocument:()=>{},newDocument:()=>{},loadDocument:()=>{},prepareDocumentOpen:()=>{},
      switchToDoc:()=>{},openPanel:()=>{},addDocToTabs:()=>{},syncDocIndicator:()=>{}});
    window.openLibrary=openLibrary;
    window.closeLibrary=closeLibrary;
    window.setResearchBatch=value=>{window.__researchBatch=value;};
    window.__researchBatch='seed';
    const nativeFetch=window.fetch.bind(window);
    window.__researchObserver={requests:[],responses:[],jsonStarted:[],jsonDone:[],aborted:[]};
    window.fetch=async(input,init={})=>{
      const url=new URL(input,location.href);
      if(url.pathname==='/api/research/library'){
        const batch=window.__researchBatch;
        const headers=new Headers(init.headers||{});
        headers.set('x-research-load-batch',batch);
        const signal=init.signal;
        const observer=window.__researchObserver;
        observer.requests.push(batch);
        signal?.addEventListener('abort',()=>observer.aborted.push(batch),{once:true});
        const response=await nativeFetch(url.href,{...init,headers});
        observer.responses.push(batch);
        const nativeJson=response.json.bind(response);
        response.json=async(...args)=>{
          observer.jsonStarted.push(batch);
          try{return await nativeJson(...args);}
          finally{observer.jsonDone.push(batch);}
        };
        return response;
      }
      return nativeFetch(input,init);
    };
    openLibrary({tab:'research'});
    window.ready=true;
  </script>
</body>`;

const requests = [];
const seen = new Map();
const waiters = [];
const held = new Map();
const heldHeaders = new Map();
const closed = new Set();
const closeWaiters = new Map();
const unexpected = [];
const external = [];
const pageErrors = [];
let server;
let browser;

function notifySeen(batch) {
  seen.set(batch, (seen.get(batch) || 0) + 1);
  for (let i = waiters.length - 1; i >= 0; i--) {
    const waiter = waiters[i];
    if ((seen.get(waiter.batch) || 0) >= waiter.count) {
      waiters.splice(i, 1);
      waiter.resolve();
    }
  }
}
function waitSeen(batch, count = 1) {
  if ((seen.get(batch) || 0) >= count) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for request ${batch}`)), 8000);
    waiters.push({ batch, count, resolve: () => { clearTimeout(timer); resolve(); } });
  });
}
function waitClosed(batch) {
  if (closed.has(batch)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for request close ${batch}`)), 8000);
    const list = closeWaiters.get(batch) || [];
    list.push(() => { clearTimeout(timer); resolve(); });
    closeWaiters.set(batch, list);
  });
}
function finishHeld(batch, value) {
  const entry = held.get(batch);
  if (!entry) throw new Error(`No held response for ${batch}`);
  held.delete(batch);
  entry.res.end(typeof value === 'string' ? value : JSON.stringify(value));
}
function releaseHeaders(batch, status = 200) {
  const entry = heldHeaders.get(batch);
  if (!entry) throw new Error(`No held headers for ${batch}`);
  heldHeaders.delete(batch);
  entry.res.writeHead(status, { 'content-type': 'application/json' });
  entry.res.flushHeaders();
  held.set(batch, { res: entry.res });
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function researchResponse(batch, res) {
  if (batch === 'body-timeout') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    held.set(batch, { res });
    return;
  }
  if (batch === 'stale-delayed-headers') {
    heldHeaders.set(batch, { res });
    return;
  }
  if (batch === '503-held-body') {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.flushHeaders();
    held.set(batch, { res });
    return;
  }
  if (batch === 'same-old' || batch === 'detached-old') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    held.set(batch, { res });
    return;
  }
  if (batch === 'http-503') return json(res, 503, { detail: 'SYNTHETIC PRIVATE DETAIL' });
  if (batch === 'malformed-shape') return json(res, 200, { research: { invalid: true } });
  if (batch === 'invalid-row') return json(res, 200, { research: [{ query: 'missing id' }] });
  if (batch === 'valid-empty') return json(res, 200, { research: [] });
  if (batch === 'legacy-array') return json(res, 200, [{ id: 'legacy-row', query: 'Legacy list' }]);
  if (batch === 'retry-success') return json(res, 200, { research: [{ id: 'retry-row', query: 'Recovered report' }] });
  if (batch === 'stale-owner-new') return json(res, 200, { research: [{ id: 'stale-owner-new-row', query: 'New owner result' }] });
  if (batch === 'same-new') return json(res, 200, { research: [{ id: 'same-new-row', query: 'Newer same grid' }] });
  if (batch === 'detached-new') return json(res, 200, { research: [{ id: 'detached-new-row', query: 'Reopened grid' }] });
  if (batch === 'detached-reopen') return json(res, 200, { research: [{ id: 'reopened-row', query: 'Reopened library' }] });
  if (batch === 'empty-object') return json(res, 200, {});
  return json(res, 200, { research: [{ id: 'seed-row', query: 'Last good report', source_count: 1 }] });
}

server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(appHtml);
  }
  if (url.pathname === '/api/research/library') {
    const batch = String(req.headers['x-research-load-batch'] || '');
    requests.push({ batch, method: req.method, path: url.pathname, search: url.search });
    notifySeen(batch);
    return researchResponse(batch, res);
  }
  if (url.pathname === '/api/documents/library') return json(res, 200, { documents: [], languages: {}, total: 0, session_count: 0 });
  if (url.pathname === '/api/sessions') return json(res, 200, { sessions: [] });
  if (url.pathname === '/api/sessions/archived') return json(res, 200, { sessions: [] });
  if (['/api/prefs/theme', '/api/auth/settings', '/api/prefs/custom-themes', '/api/tts/stats'].includes(url.pathname)) return json(res, 200, {});
  if (url.pathname === '/api/auth/status') return json(res, 200, { authenticated: false });
  if (url.pathname === '/api/tools') return json(res, 200, []);
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url.pathname.startsWith('/api/')) {
    unexpected.push({ method: req.method, path: url.pathname });
    return json(res, 404, {});
  }
  const file = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    unexpected.push({ file: url.pathname });
    res.writeHead(404); return res.end();
  }
  res.setHeader('content-type', /\.(?:js|mjs)$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});
server.on('request', (req, res) => {
  if (!new URL(req.url, 'http://127.0.0.1').pathname.startsWith('/api/research/library')) return;
  const batch = String(req.headers['x-research-load-batch'] || '');
  res.on('close', () => {
    closed.add(batch);
    for (const resolve of closeWaiters.get(batch) || []) resolve();
    closeWaiters.delete(batch);
    held.delete(batch);
    heldHeaders.delete(batch);
  });
});

async function main() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.match(origin, /^http:\/\/127\.0\.0\.1:/);
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await page.route('**/*', route => {
    const requested = new URL(route.request().url());
    if (requested.origin !== origin) { external.push(requested.href); return route.abort(); }
    return route.continue();
  });
  await page.goto(origin, { waitUntil: 'load', timeout: 10000 });
  const row = id => page.locator(`#doclib-research-grid .doclib-research-card[data-research-id="${id}"]`);
  const alert = page.locator('#doclib-research-grid [role="alert"]');
  const setBatch = value => page.evaluate(batch => window.setResearchBatch(batch), value);
  const waitRequest = async batch => {
    await waitSeen(batch);
    await page.waitForFunction(value => window.__researchObserver.requests.includes(value), batch, { timeout: 8000 });
  };
  const waitJsonStarted = batch => page.waitForFunction(value => window.__researchObserver.jsonStarted.includes(value), batch, { timeout: 8000 });
  const waitJsonDone = batch => page.waitForFunction(value => window.__researchObserver.jsonDone.includes(value), batch, { timeout: 8000 });
  const flushRender = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const switchTo = async tab => page.locator(`[data-doclib-tab="${tab}"]`).click();
  const triggerResearchLoad = async (batch, { from = 'documents' } = {}) => {
    await setBatch(batch);
    await switchTo(from);
    await switchTo('research');
    await waitRequest(batch);
  };
  const result = {};

  await waitRequest('seed');
  await page.waitForFunction(() => document.querySelector('#doclib-research-grid [data-research-id="seed-row"]'), null, { timeout: 8000 });
  result.normalWrappedSuccess = true;

  await triggerResearchLoad('malformed-shape');
  await alert.waitFor({ timeout: 8000 });
  assert.equal(await row('seed-row').count(), 1, 'malformed response leaves last good row visible');
  assert.equal(await alert.locator('button').getAttribute('aria-label'), 'Retry loading research');
  assert.equal(await alert.locator('button').evaluate(button => button.getBoundingClientRect().height >= 44 && button.getBoundingClientRect().width >= 44), true);
  assert.equal(await page.locator('#doclib-research-grid').innerText().then(text => text.includes('SYNTHETIC PRIVATE DETAIL')), false);
  result.malformedKeepsLastGoodAndShowsAccessibleRetry = true;

  await setBatch('retry-success');
  await alert.locator('button').click();
  await waitRequest('retry-success');
  await row('retry-row').waitFor({ timeout: 8000 });
  assert.equal(await alert.count(), 0);
  result.retryRecovers = true;

  await triggerResearchLoad('http-503');
  await alert.waitFor({ timeout: 8000 });
  assert.equal(await row('retry-row').count(), 1, '503 preserves last good result');
  assert.equal(await page.locator('#doclib-research-grid').innerText().then(text => text.includes('SYNTHETIC PRIVATE DETAIL')), false);
  result.http503PreservesCache = true;

  await setBatch('valid-empty');
  await alert.locator('button').click();
  await waitRequest('valid-empty');
  await page.waitForFunction(() => document.querySelector('#doclib-research-grid .hwfit-loading')?.textContent.includes('No research yet'), null, { timeout: 8000 });
  assert.equal(await row('retry-row').count(), 0);
  assert.equal(await alert.count(), 0);
  result.validEmptyRemainsEmptyControl = true;

  await triggerResearchLoad('legacy-array');
  await row('legacy-row').waitFor({ timeout: 8000 });
  result.legacyBareArrayStillLoads = true;

  // The old body has reached response.json before the new request owns the same grid.
  await triggerResearchLoad('same-old');
  await waitJsonStarted('same-old');
  await setBatch('same-new');
  await switchTo('documents'); await switchTo('research'); await waitRequest('same-new');
  await row('same-new-row').waitFor({ timeout: 8000 });
  finishHeld('same-old', { research: [{ id: 'same-old-row', query: 'Stale same-grid row' }] });
  await waitJsonDone('same-old'); await flushRender();
  assert.equal(await row('same-new-row').count(), 1);
  assert.equal(await row('same-old-row').count(), 0);
  result.lateOldLoadCannotOverwriteNewerSameGrid = true;

  await triggerResearchLoad('detached-old');
  await waitJsonStarted('detached-old');
  const oldGrid = await page.locator('#doclib-research-grid').elementHandle();
  await page.evaluate(() => window.closeLibrary());
  await page.waitForFunction(old => !old.isConnected, oldGrid, { timeout: 8000 });
  await setBatch('detached-reopen');
  await page.evaluate(() => window.openLibrary({ tab: 'research' }));
  await waitRequest('detached-reopen');
  const reopenedRow = page.locator('#doclib-research-grid [data-research-id="reopened-row"]');
  await reopenedRow.waitFor({ timeout: 8000 });
  finishHeld('detached-old', { research: [{ id: 'detached-old-row', query: 'Stale detached row' }] });
  await waitJsonDone('detached-old'); await flushRender();
  assert.equal(await reopenedRow.count(), 1);
  assert.equal(await page.locator('#doclib-research-grid [data-research-id="detached-old-row"]').count(), 0);
  result.detachedOldLoadCannotPaintReopenedGrid = true;

  // A held successful HTTP response with a stalled body is bounded by the native deadline.
  const timeoutPage = await browser.newPage();
  timeoutPage.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await timeoutPage.route('**/*', route => {
    const requested = new URL(route.request().url());
    if (requested.origin !== origin) { external.push(requested.href); return route.abort(); }
    return route.continue();
  });
  await timeoutPage.clock.install({ time: new Date('2026-10-21T12:00:00Z') });
  await timeoutPage.goto(origin, { waitUntil: 'load', timeout: 10000 });
  // Wait for the seed request and then start a current held-body request.
  await timeoutPage.waitForFunction(() => document.querySelector('#doclib-research-grid [data-research-id="seed-row"]'), null, { timeout: 8000 });
  await timeoutPage.evaluate(() => window.setResearchBatch('body-timeout'));
  await timeoutPage.locator('[data-doclib-tab="documents"]').click();
  await timeoutPage.locator('[data-doclib-tab="research"]').click();
  await waitSeen('body-timeout');
  await timeoutPage.waitForFunction(() => window.__researchObserver.requests.includes('body-timeout'));
  await timeoutPage.clock.fastForward(15001);
  await timeoutPage.locator('#doclib-research-grid [role="alert"]').waitFor({ timeout: 8000 });
  await waitClosed('body-timeout');
  assert.equal(await timeoutPage.evaluate(() => window.__researchObserver.aborted.includes('body-timeout')), true);
  assert.equal(await timeoutPage.locator('#doclib-research-grid [data-research-id="seed-row"]').count(), 1);
  result.heldJsonDeadlineAbortsNativeRequestAndPreservesCache = true;
  await timeoutPage.close();

  const cleanupPage = await browser.newPage();
  cleanupPage.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await cleanupPage.route('**/*', route => {
    const requested = new URL(route.request().url());
    if (requested.origin !== origin) { external.push(requested.href); return route.abort(); }
    return route.continue();
  });
  await cleanupPage.clock.install({ time: new Date('2026-10-21T12:00:00Z') });
  await cleanupPage.goto(origin, { waitUntil: 'load', timeout: 10000 });
  await cleanupPage.waitForFunction(() => document.querySelector('#doclib-research-grid [data-research-id="seed-row"]'), null, { timeout: 8000 });
  const cleanSignal = batch => cleanupPage.evaluate(value => ({
    aborted: window.__researchObserver.aborted.includes(value),
    responseArrived: window.__researchObserver.responses.includes(value),
    jsonStarted: window.__researchObserver.jsonStarted.includes(value),
  }), batch);
  const staleHeadersBatch = 'stale-delayed-headers';
  await cleanupPage.evaluate(() => window.setResearchBatch('stale-delayed-headers'));
  await cleanupPage.locator('[data-doclib-tab="documents"]').click();
  await cleanupPage.locator('[data-doclib-tab="research"]').click();
  await waitSeen(staleHeadersBatch);
  await cleanupPage.evaluate(() => window.setResearchBatch('stale-owner-new'));
  await cleanupPage.locator('[data-doclib-tab="documents"]').click();
  await cleanupPage.locator('[data-doclib-tab="research"]').click();
  await cleanupPage.waitForFunction(() => window.__researchObserver.jsonDone.includes('stale-owner-new'), null, { timeout: 8000 });
  await cleanupPage.locator('#doclib-research-grid [data-research-id="stale-owner-new-row"]').waitFor({ timeout: 8000 });
  releaseHeaders(staleHeadersBatch);
  await cleanupPage.waitForFunction(value => window.__researchObserver.responses.includes(value), staleHeadersBatch, { timeout: 8000 });
  await waitClosed(staleHeadersBatch);
  const staleSignal = await cleanSignal(staleHeadersBatch);
  assert.equal(staleSignal.aborted, true, 'stale early return aborts unread response body');
  assert.equal(staleSignal.jsonStarted, false, 'stale fetch returned before body parsing');
  assert.equal(held.has(staleHeadersBatch), false);
  assert.equal(await cleanupPage.locator('#doclib-research-grid [data-research-id="stale-owner-new-row"]').count(), 1);
  result.staleEarlyReturnAbortsUnreadBodyAndKeepsNewOwnerUI = true;

  await cleanupPage.evaluate(() => window.setResearchBatch('503-held-body'));
  await cleanupPage.locator('[data-doclib-tab="documents"]').click();
  await cleanupPage.locator('[data-doclib-tab="research"]').click();
  await waitSeen('503-held-body');
  await cleanupPage.locator('#doclib-research-grid [role="alert"]').waitFor({ timeout: 8000 });
  await waitClosed('503-held-body');
  assert.equal((await cleanSignal('503-held-body')).aborted, true);
  assert.equal(held.has('503-held-body'), false);
  assert.equal(await cleanupPage.locator('#doclib-research-grid [data-research-id="stale-owner-new-row"]').count(), 1);
  result.http503EarlyFailureAbortsUnreadBodyAndKeepsCache = true;
  await cleanupPage.close();

  assert.deepEqual(external, []);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ pass: true, result, requests, external, unexpected, pageErrors, scope: 'full documentLibrary.js on synthetic 127.0.0.1 only; browser-native fetch, JSON, timer and AbortController; no real services or content' }));
}

const watchdog = setTimeout(() => {
  console.error('watchdog: aborting owned browser/server after 120s');
  browser?.close().catch(() => {});
  server.closeAllConnections?.();
}, 120000);
watchdog.unref?.();
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(watchdog);
  if (browser) await browser.close().catch(() => {});
  for (const { res } of held.values()) res.destroy();
  held.clear();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});
