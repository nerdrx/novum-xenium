const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8">
<div id="models"></div><div id="toast"></div><div id="scroll-bottom-btn"></div><textarea id="message"></textarea>
<div id="model-picker-wrap"><button id="model-picker-btn"><span id="model-picker-label"></span></button>
  <div id="model-picker-menu" class="model-picker-menu hidden">
    <div class="model-picker-search-row"><input id="model-picker-search"></div>
    <button id="model-picker-refresh-btn" aria-label="Refresh model picker"></button>
    <button id="model-picker-add-models-btn" aria-label="Add model endpoints"></button>
    <div id="model-picker-list"></div>
  </div>
</div>
<style>.hidden{display:none}</style>
<script type="module">
import modelsModule from '/static/js/models.js';
import { initModelPicker } from '/static/js/modelPicker.js';
modelsModule.init(location.origin);
const sessions = [{id:'fixture-session', model:'existing-model', endpoint_url:'http://fixture'}];
let pending = null;
initModelPicker({
  getCurrentSessionId: () => 'fixture-session',
  getSessions: () => sessions,
  getPendingChat: () => pending,
  setPendingChat: value => { pending = value; },
  createDirectChat: async () => {},
});
window.fixtureState = { sessions, get pending() { return pending; } };
window.fixtureReady = true;
</script>`;

let modelStatus = 503;
let modelItems = [];
const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, {'content-type': 'text/html'});
    return res.end(html);
  }
  if (url.pathname === '/api/models') {
    requests.push({status: modelStatus, url: req.url});
    res.writeHead(modelStatus, {'content-type': 'application/json'});
    return res.end(JSON.stringify(modelStatus === 200 ? {items: modelItems} : {detail: 'synthetic catalog failure'}));
  }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(200, {'content-type': 'application/json'});
    return res.end('{}');
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  const type = file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'text/plain';
  res.writeHead(200, {'content-type': type});
  fs.createReadStream(file).pipe(res);
});

const waitUntil = (page, predicate) => page.waitForFunction(predicate, null, {timeout: 5000});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 844}});
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await waitUntil(page, () => window.fixtureReady === true);
    await page.locator('#model-picker-btn').click();
    await waitUntil(page, () => document.getElementById('model-picker-search').placeholder === 'Model list unavailable');
    const coldFailure = await page.evaluate(() => ({
      placeholder: document.getElementById('model-picker-search').placeholder,
      message: document.getElementById('model-picker-list').textContent.trim(),
      rows: document.querySelectorAll('#model-picker-list .mp-select-model').length,
    }));
    assert.match(coldFailure.message, /Could not load models\. Use Refresh to retry\./);
    assert.equal(coldFailure.rows, 0);

    await page.locator('#model-picker-search').fill('fixture');
    const coldFailureAfterSearch = await page.evaluate(() => ({
      placeholder: document.getElementById('model-picker-search').placeholder,
      message: document.getElementById('model-picker-list').textContent.trim(),
      rows: document.querySelectorAll('#model-picker-list .mp-select-model').length,
    }));
    assert.equal(coldFailureAfterSearch.placeholder, 'Model list unavailable');
    assert.match(coldFailureAfterSearch.message, /Could not load models\. Use Refresh to retry\./);
    assert.equal(coldFailureAfterSearch.rows, 0);

    modelStatus = 200;
    modelItems = [{
      endpoint_id: 'fixture-endpoint', endpoint_name: 'Healthy fixture', url: 'http://fixture',
      category: 'local', models: ['fixture-model'], models_display: ['Fixture Model'], offline: false,
    }];
    await page.locator('#model-picker-search').fill('');
    await page.locator('#model-picker-refresh-btn').click();
    await waitUntil(page, () => [...document.querySelectorAll('#model-picker-list .mp-select-model')]
      .some(button => button.textContent.includes('Fixture Model')));
    const loadedRows = await page.locator('#model-picker-list .mp-select-model').count();
    assert.equal(loadedRows, 1);

    modelStatus = 503;
    await page.locator('#model-picker-refresh-btn').click();
    await waitUntil(page, () => document.getElementById('model-picker-list').textContent.includes('Showing cached models.'));
    const cachedFailure = await page.evaluate(() => ({
      message: document.getElementById('model-picker-list').textContent.trim(),
      models: [...document.querySelectorAll('#model-picker-list .mp-select-model')].map(button => button.textContent.trim()),
    }));
    assert.match(cachedFailure.message, /Could not refresh the model list\. Showing cached models\./);
    assert.equal(cachedFailure.models.length, 1);
    assert.match(cachedFailure.models[0], /Fixture Model/);

    await page.locator('#model-picker-search').fill('Fixture Model');
    const cachedFailureAfterSearch = await page.evaluate(() => ({
      message: document.getElementById('model-picker-list').textContent.trim(),
      models: [...document.querySelectorAll('#model-picker-list .mp-select-model')].map(button => button.textContent.trim()),
    }));
    assert.match(cachedFailureAfterSearch.message, /Could not refresh the model list\. Showing cached models\./);
    assert.equal(cachedFailureAfterSearch.models.length, 1);
    assert.match(cachedFailureAfterSearch.models[0], /Fixture Model/);
    assert.equal(await page.evaluate(() => window.fixtureState.pending), null, 'catalog recovery never picks a model or starts a chat');
    assert.deepEqual(pageErrors, []);

    const evidence = {coldFailure, coldFailureAfterSearch, loadedRows, cachedFailure, cachedFailureAfterSearch, requests, pageErrors};
    if (process.env.EVIDENCE_DIR) {
      fs.mkdirSync(process.env.EVIDENCE_DIR, {recursive: true});
      fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'model-picker-catalog-recovery.json'), JSON.stringify(evidence, null, 2));
      await page.screenshot({path: path.join(process.env.EVIDENCE_DIR, 'model-picker-catalog-recovery.png')});
    }
    console.log(JSON.stringify({mode: 'model-catalog-failure-recovery', ...evidence}, null, 2));
    await page.close();
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
