const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8">
<div id="models"></div><div id="toast"></div><div id="scroll-bottom-btn"></div>
<textarea id="message"></textarea>
<div id="model-picker-wrap"><button id="model-picker-btn"><span id="model-picker-label"></span></button>
  <div id="model-picker-menu" class="model-picker-menu hidden">
    <div class="model-picker-search-row"><input id="model-picker-search"></div>
    <button id="model-picker-refresh-btn"></button><button id="model-picker-add-models-btn"></button>
    <div id="model-picker-list"></div>
  </div>
</div>
<style>.hidden{display:none}</style>
<script type="module">
import modelsModule from '/static/js/models.js';
modelsModule.init(location.origin);
window.modelsModule = modelsModule;
window.fixtureClock = { base: Date.now(), offset: 0 };
window.fixtureReady = true;
</script>`;

let requestCount = 0;
const heldResponses = new Map();
const initialItem = (model, display = model) => ({
  endpoint_id: 'fixture-endpoint', endpoint_name: 'Fixture endpoint', url: 'http://fixture',
  category: 'local', models: [model], models_display: [display], offline: false,
});
const initialData = { items: [initialItem('initial-model', 'Initial Model')] };
const retryData = { items: [initialItem('retry-model', 'Retry Model')] };
const coalescedData = { items: [initialItem('coalesced-model', 'Coalesced Model')] };
const newerData = { items: [initialItem('newer-model', 'Newer Model')] };
const staleData = { items: [initialItem('stale-model', 'Stale Model')] };
const finalData = { items: [initialItem('final-model', 'Final Model')] };

function sendResponse(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(html);
  }
  if (url.pathname === '/api/models') {
    const id = ++requestCount;
    if (id === 1 || id === 3) return sendResponse(res, 503, { detail: 'synthetic catalog failure' });
    if (id === 2) return sendResponse(res, 200, initialData);
    if (id === 4) return sendResponse(res, 200, retryData);
    if (id > 4) {
      heldResponses.set(id, (status, data) => sendResponse(res, status, data));
      return;
    }
    return sendResponse(res, 500, { detail: 'unexpected synthetic request' });
  }
  if (url.pathname === '/api/model-endpoints/probe-local') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{}');
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  const type = file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'text/plain';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(file).pipe(res);
});

const waitForRequest = async (id) => {
  for (let i = 0; i < 100 && !heldResponses.has(id); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(heldResponses.has(id), `synthetic request ${id} reached loopback server`);
};

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady);

    const coldResult = await page.evaluate(() => modelsModule.refreshModels(true));
    const coldFailure = await page.evaluate(() => ({
      text: document.getElementById('models').textContent.trim(),
      rows: document.querySelectorAll('#models .models-row').length,
    }));
    assert.equal(coldResult, false);
    assert.match(coldFailure.text, /scan failed/);
    assert.equal(coldFailure.rows, 0);

    await page.evaluate(() => modelsModule.refreshModels(true));
    await page.waitForFunction(() => document.querySelector('#models .models-row[data-model-id="initial-model"]'));
    const cachedFailureResult = await page.evaluate(() => modelsModule.refreshModels(true));
    const cachedFailure = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('#models .models-row')].map(row => row.dataset.modelId),
      hint: document.querySelector('#models .models-refresh-error')?.textContent || '',
      cache: modelsModule.getCachedItems().map(item => item.models[0]),
    }));
    assert.equal(cachedFailureResult, false);
    assert.deepEqual(cachedFailure.rows, ['initial-model']);
    assert.match(cachedFailure.hint, /Could not refresh model list/);
    assert.deepEqual(cachedFailure.cache, ['initial-model']);

    await page.evaluate(() => modelsModule.refreshModels(true));
    await page.waitForFunction(() => document.querySelector('#models .models-row[data-model-id="retry-model"]'));
    const retried = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('#models .models-row')].map(row => row.dataset.modelId),
      hint: !!document.querySelector('#models .models-refresh-error'),
    }));
    assert.deepEqual(retried.rows, ['retry-model']);
    assert.equal(retried.hint, false);

    await page.evaluate(() => {
      fixtureClock.offset += 31000;
      const baseNow = fixtureClock.base;
      Date.now = () => baseNow + fixtureClock.offset;
      window.coalescedA = modelsModule.refreshModels(false);
      window.coalescedB = modelsModule.refreshModels(false);
    });
    await waitForRequest(5);
    const coalescedCount = requestCount;
    assert.equal(coalescedCount, 5, 'two callers share one pending fetch');
    heldResponses.get(5)(200, coalescedData);
    await page.evaluate(() => Promise.all([window.coalescedA, window.coalescedB]));
    await page.waitForFunction(() => document.querySelector('#models .models-row[data-model-id="coalesced-model"]'));

    await page.evaluate(() => {
      fixtureClock.offset += 31000;
      window.staleFailure = modelsModule.refreshModels(false);
      window.newSuccess = modelsModule.refreshModels(true);
    });
    await waitForRequest(6);
    await waitForRequest(7);
    heldResponses.get(7)(200, newerData);
    await page.evaluate(() => window.newSuccess);
    await page.waitForFunction(() => document.querySelector('#models .models-row[data-model-id="newer-model"]'));
    heldResponses.get(6)(503, { detail: 'late stale failure' });
    const staleFailureResult = await page.evaluate(() => window.staleFailure);
    assert.equal(staleFailureResult, undefined, 'stale failure does not report a current refresh failure');
    const staleFailureAfterSuccess = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('#models .models-row')].map(row => row.dataset.modelId),
      hint: !!document.querySelector('#models .models-refresh-error'),
      cache: modelsModule.getCachedItems().map(item => item.models[0]),
    }));
    assert.deepEqual(staleFailureAfterSuccess.rows, ['newer-model']);
    assert.equal(staleFailureAfterSuccess.hint, false);
    assert.deepEqual(staleFailureAfterSuccess.cache, ['newer-model']);

    await page.evaluate(() => {
      fixtureClock.offset += 31000;
      window.staleSuccess = modelsModule.refreshModels(false);
      window.newFailure = modelsModule.refreshModels(true);
    });
    await waitForRequest(8);
    await waitForRequest(9);
    heldResponses.get(9)(503, { detail: 'latest failure' });
    const latestFailureResult = await page.evaluate(() => window.newFailure);
    assert.equal(latestFailureResult, false, 'latest failure preserves the established false return contract');
    const latestFailure = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('#models .models-row')].map(row => row.dataset.modelId),
      hint: document.querySelector('#models .models-refresh-error')?.textContent || '',
      cache: modelsModule.getCachedItems().map(item => item.models[0]),
    }));
    assert.deepEqual(latestFailure.rows, ['newer-model']);
    assert.match(latestFailure.hint, /Could not refresh model list/);
    assert.deepEqual(latestFailure.cache, ['newer-model']);
    heldResponses.get(8)(200, staleData);
    await page.evaluate(() => window.staleSuccess);
    const staleSuccessAfterFailure = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('#models .models-row')].map(row => row.dataset.modelId),
      hint: document.querySelector('#models .models-refresh-error')?.textContent || '',
      cache: modelsModule.getCachedItems().map(item => item.models[0]),
    }));
    assert.deepEqual(staleSuccessAfterFailure.rows, ['newer-model']);
    assert.match(staleSuccessAfterFailure.hint, /Could not refresh model list/);
    assert.deepEqual(staleSuccessAfterFailure.cache, ['newer-model']);

    await page.evaluate(() => {
      fixtureClock.offset += 31000;
      window.olderFailure = modelsModule.refreshModels(false);
      window.pendingNewest = modelsModule.refreshModels(true);
    });
    await waitForRequest(10);
    await waitForRequest(11);
    heldResponses.get(10)(503, { detail: 'stale failure before latest completion' });
    const olderFailureResult = await page.evaluate(() => window.olderFailure);
    assert.equal(olderFailureResult, undefined);
    const countBeforeJoin = requestCount;
    await page.evaluate(() => { window.joinNewest = modelsModule.refreshModels(false); });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(requestCount, countBeforeJoin, 'stale finalizer keeps newer inflight request joinable');
    heldResponses.get(11)(200, finalData);
    await page.evaluate(() => Promise.all([window.pendingNewest, window.joinNewest]));
    await page.waitForFunction(() => document.querySelector('#models .models-row[data-model-id="final-model"]'));

    assert.deepEqual(pageErrors, []);
    const evidence = {
      coldFailure,
      cachedFailure,
      retried,
      coalescedCount,
      staleFailureAfterSuccess,
      latestFailure,
      staleSuccessAfterFailure,
      finalRows: await page.evaluate(() => [...document.querySelectorAll('#models .models-row')].map(row => row.dataset.modelId)),
      requestCount,
      pageErrors,
    };
    if (process.env.EVIDENCE_DIR) {
      fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'models-refresh-ownership-ui.json'), JSON.stringify(evidence, null, 2));
      await page.screenshot({ path: path.join(process.env.EVIDENCE_DIR, 'models-refresh-ownership-ui.png') });
    }
    console.log(JSON.stringify({ mode: 'models-refresh-ownership', ...evidence }, null, 2));
    await page.close();
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
