// Verify endpoint deletion is confirmed before pending-chat route cleanup.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
  <div id="adm-epList-local"></div><div id="adm-epList-api"></div><div id="toast"></div>
  <script type="module">
    import '/static/js/admin.js';
    let pending = { modelId: 'fixture/model-a', endpointId: 'fixture-a' };
    window.dependentRefreshes = 0;
    window.modelsModule = { refreshModels: async () => { window.dependentRefreshes++; }, getCachedItems: () => [] };
    window.sessionModule = { getPendingChat: () => pending, setPendingChat: value => { pending = value; }, updateModelPicker: () => {} };
    window.fixturePending = () => pending;
    window.fixtureReady = true;
  </script>
</body>`;
const endpoints = [
  { id: 'fixture-a', name: 'Dummy A', base_url: 'http://fixture.invalid/a', category: 'api', online: false, is_enabled: true, models: [] },
  { id: 'fixture-b', name: 'Dummy B', base_url: 'http://fixture.invalid/b', category: 'api', online: false, is_enabled: true, models: [] },
  { id: 'fixture-c', name: 'Dummy C', base_url: 'http://fixture.invalid/c', category: 'api', online: false, is_enabled: true, models: [] },
];
let plans = [];
let patchPlan = [];
let failNextList = false;
const held = new Map();
const deleteCounts = {};
const patchCounts = {};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname === '/__plan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const value = JSON.parse(body);
      if (value.deletes) plans = value.deletes;
      if (value.patches) patchPlan = value.patches;
      res.writeHead(204); res.end();
    });
    return;
  }
  if (url.pathname === '/__fail-list' && req.method === 'POST') { failNextList = true; res.writeHead(204); return res.end(); }
  if (url.pathname === '/__state') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ deleteCounts, patchCounts, endpoints: endpoints.map(ep => ep.id) }));
  }
  if (url.pathname.startsWith('/__release/')) {
    held.get(url.pathname.split('/').pop())?.();
    held.delete(url.pathname.split('/').pop());
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/model-endpoints' && req.method === 'GET') {
    if (failNextList) { failNextList = false; res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"detail":"fixture list outage"}'); }
    res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(endpoints));
  }
  if (url.pathname.startsWith('/api/model-endpoints/') && req.method === 'PATCH') {
    const id = url.pathname.split('/').pop();
    patchCounts[id] = (patchCounts[id] || 0) + 1;
    const plan = patchPlan.shift() || { status: 200 };
    if ((plan.status || 200) < 300) {
      const endpoint = endpoints.find(ep => ep.id === id);
      if (endpoint) endpoint.is_enabled = !endpoint.is_enabled;
    }
    res.writeHead(plan.status || 200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(plan.payload || {}));
  }
  if (url.pathname.startsWith('/api/model-endpoints/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    deleteCounts[id] = (deleteCounts[id] || 0) + 1;
    const plan = plans.shift() || { status: 200 };
    const send = () => {
      if ((plan.status || 200) < 300) {
        const index = endpoints.findIndex(ep => ep.id === id);
        if (index >= 0) endpoints.splice(index, 1);
      }
      res.writeHead(plan.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(plan.payload || {}));
    };
    if (plan.hold) { held.set(id, send); return; }
    return send();
  }
  if (url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); return res.end('{}'); }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (url.pathname === '/static/js/admin.js') {
    const source = fs.readFileSync(file, 'utf8').replace(
      '/* ═══════════════════════════════════════════\n   PUBLIC API',
      'window.__testLoadEndpoints = loadEndpoints;\n/* ═══════════════════════════════════════════\n   PUBLIC API',
    );
    return res.end(source);
  }
  if (url.pathname === '/static/js/settings.js') return res.end('export default { refreshAiModelEndpoints() {} };');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && window.__testLoadEndpoints);
    const state = () => page.evaluate(async () => (await (await fetch('/__state')).json()));
    await page.evaluate(() => window.__testLoadEndpoints());
    await page.waitForSelector('[data-adm-del-ep="fixture-a"]');

    await page.evaluate(() => fetch('/__plan', { method: 'POST', body: JSON.stringify({
      deletes: [{ hold: true, status: 503, payload: { detail: 'fixture outage' } }, { status: 200 }],
      patches: [{ status: 503 }, { status: 200 }],
    }) }));
    const initialRefreshes = await page.evaluate(() => window.dependentRefreshes);
    await page.locator('[data-adm-toggle-ep="fixture-b"]').click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).patchCounts['fixture-b'] === 1);
    await page.waitForSelector('[data-adm-ep-toggle-error]');
    assert.equal(await page.evaluate(() => window.dependentRefreshes), initialRefreshes,
      'failed toggle does not refresh dependent model routes');
    assert.equal(await page.locator('[data-adm-toggle-ep="fixture-b"]').textContent(), 'Disable',
      'failed toggle keeps the action label available for retry');
    await page.locator('[data-adm-toggle-ep="fixture-b"]').click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).patchCounts['fixture-b'] === 2);
    await page.waitForFunction(() => document.querySelector('[data-adm-toggle-ep="fixture-b"]')?.textContent === 'Enable');

    await page.locator('[data-adm-del-ep="fixture-a"]').click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).deleteCounts['fixture-a'] === 1);
    assert.equal(await page.locator('[data-adm-del-ep="fixture-a"]').isDisabled(), true,
      'row remains visible and prevents duplicate delete while request is pending');
    await page.locator('[data-adm-del-ep="fixture-a"]').dispatchEvent('click');
    assert.equal((await state()).deleteCounts['fixture-a'], 1, 'a duplicate click cannot issue another DELETE');
    await page.evaluate(() => fetch('/__release/fixture-a'));
    await page.waitForSelector('[data-adm-ep-delete-error]');
    assert.deepEqual(await page.evaluate(() => window.fixturePending()),
      { modelId: 'fixture/model-a', endpointId: 'fixture-a' }, 'failed DELETE preserves pending chat route');
    assert.equal(await page.locator('[data-adm-del-ep="fixture-a"]').isDisabled(), false,
      'failed delete is retryable');

    await page.locator('[data-adm-del-ep="fixture-a"]').click();
    await page.waitForFunction(async () => !(await (await fetch('/__state')).json()).endpoints.includes('fixture-a'));
    assert.equal(await page.locator('[data-adm-del-ep="fixture-a"]').count(), 0,
      'successful retry removes the row');
    assert.equal(await page.evaluate(() => window.fixturePending()), null,
      'successful delete clears only its pending endpoint route');

    await page.evaluate(() => window.__testLoadEndpoints());
    await page.waitForSelector('[data-adm-del-ep="fixture-b"]');
    await page.evaluate(() => fetch('/__fail-list', { method: 'POST' }));
    await page.evaluate(() => window.sessionModule.setPendingChat({ modelId: 'fixture/model-c', endpointId: 'fixture-c' }));
    await page.locator('[data-adm-del-ep="fixture-c"]').click();
    await page.waitForSelector('[data-adm-endpoint-load-error]');
    assert.equal(await page.locator('[data-adm-del-ep="fixture-c"]').count(), 0,
      'confirmed delete remains removed when the follow-up list refresh fails');
    assert.equal(await page.locator('[data-adm-ep-delete-error]').count(), 0,
      'a list refresh error is not reported as a failed delete');
    assert.equal(await page.evaluate(() => window.fixturePending()), null,
      'confirmed delete clears its matching pending route even if list refresh fails');
    await page.evaluate(() => window.__testLoadEndpoints());
    await page.waitForSelector('[data-adm-del-ep="fixture-b"]');

    await page.evaluate(() => fetch('/__plan', { method: 'POST', body: JSON.stringify({ deletes: [{ hold: true, status: 200 }] }) }));
    await page.evaluate(() => window.sessionModule.setPendingChat({ modelId: 'fixture/model-b', endpointId: 'fixture-b' }));
    await page.locator('[data-adm-del-ep="fixture-b"]').click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).deleteCounts['fixture-b'] === 1);
    await page.evaluate(() => window.sessionModule.setPendingChat({ modelId: 'fixture/newer', endpointId: 'newer-route' }));
    await page.evaluate(() => fetch('/__release/fixture-b'));
    await page.waitForFunction(async () => !(await (await fetch('/__state')).json()).endpoints.includes('fixture-b'));
    assert.deepEqual(await page.evaluate(() => window.fixturePending()),
      { modelId: 'fixture/newer', endpointId: 'newer-route' }, 'delete completion cannot clear a newer route');
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log('PASS: endpoint delete preserves failed state, blocks duplicates, retries, and protects newer routes');
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.closeAllConnections?.(); server.close(); process.exitCode = 1; });
