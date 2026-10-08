// Verify endpoint inventory failures never render as an empty configuration.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
  <div id="adm-epList-local"></div><div id="adm-epList-api"></div>
  <script type="module">
    import '/static/js/admin.js';
    window.fixtureReady = true;
  </script>
</body>`;
let plans = [];
let heldResponse = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/__plan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { plans = JSON.parse(body); res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === '/__release') {
    heldResponse?.(); heldResponse = null; res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/model-endpoints') {
    const plan = plans.shift() || { payload: [] };
    const send = () => {
      res.writeHead(plan.status || 200, { 'Content-Type': 'application/json' });
      res.end(plan.raw || JSON.stringify(plan.payload));
    };
    if (plan.hold) { heldResponse = send; return; }
    return send();
  }
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
  if (url.pathname === '/static/js/settings.js') {
    return res.end('export default { refreshAiModelEndpoints() { window.fixtureRefreshes++; } };');
  }
  fs.createReadStream(file).pipe(res);
});

const endpoint = (name, id = 'fixture') => ({
  id, name, base_url: 'https://fixture.invalid/v1', category: 'api', online: false,
  is_enabled: true, models: [],
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
    page.on('pageerror', e => errors.push(e.stack || e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && window.__testLoadEndpoints);
    await page.evaluate(() => { window.fixtureRefreshes = 0; });
    const setPlans = async list => page.evaluate(plans => fetch('/__plan', {
      method: 'POST', body: JSON.stringify(plans),
    }), list);
    const load = () => page.evaluate(() => window.__testLoadEndpoints());

    await setPlans([{ status: 503, payload: { detail: 'fixture outage' } }]);
    await load();
    assert.match(await page.locator('[data-adm-endpoint-load-error]').first().textContent(), /Failed to load endpoints/);
    assert.equal(await page.locator('#adm-epList-local').getByText('None').count(), 0,
      'initial failure must not look like a valid empty inventory');
    assert.equal(await page.evaluate(() => window.fixtureRefreshes), 0,
      'failed reads must not refresh dependent model pickers');

    await setPlans([{ raw: '{not json' }]);
    await page.locator('[data-adm-endpoint-load-error] button').first().click();
    await page.waitForTimeout(25);
    await page.waitForFunction(() => document.querySelector('[data-adm-endpoint-load-error]'));
    assert.equal(await page.locator('#adm-epList-local').getByText('None').count(), 0,
      'malformed JSON stays an error');
    await setPlans([{ payload: { detail: 'not an endpoint array' } }]);
    await page.locator('[data-adm-endpoint-load-error] button').first().click();
    await page.waitForTimeout(25);
    await page.waitForFunction(() => document.querySelector('[data-adm-endpoint-load-error]'));
    assert.equal(await page.locator('#adm-epList-local').getByText('None').count(), 0,
      'a successful but malformed payload stays an error');
    assert.equal(await page.locator('[data-adm-endpoint-load-error][role="alert"]').count(), 2,
      'endpoint load failure is announced as an alert');
    await setPlans([{ payload: [{}] }]);
    await page.locator('[data-adm-endpoint-load-error] button').first().click();
    await page.waitForTimeout(25);
    assert.equal(await page.locator('#adm-epList-local').getByText('None').count(), 0,
      'rows without a usable id stay an error instead of creating invalid controls');

    await setPlans([{ payload: [] }]);
    await page.locator('[data-adm-endpoint-load-error] button').first().click();
    await page.waitForFunction(() => document.querySelector('#adm-epList-local')?.textContent.trim() === 'None');
    assert.equal(await page.locator('[data-adm-endpoint-load-error]').count(), 0,
      'a successful empty list clears the error');
    assert.equal(await page.evaluate(() => window.fixtureRefreshes), 1,
      'valid reads refresh dependent model pickers');

    await setPlans([{ payload: [endpoint('Last good endpoint')] }]);
    await load();
    assert.match(await page.locator('#adm-epList-api').textContent(), /Last good endpoint/);
    await setPlans([{ status: 503, payload: { detail: 'temporary outage' } }]);
    await load();
    assert.match(await page.locator('#adm-epList-api').textContent(), /Last good endpoint/,
      'failed refresh preserves last successful rows');
    assert.equal(await page.locator('[data-adm-endpoint-load-error] button').count(), 2,
      'both endpoint panes offer retry');
    await setPlans([{ payload: [endpoint('Recovered endpoint', 'recovered')] }]);
    await page.locator('[data-adm-endpoint-load-error] button').first().click();
    await page.waitForFunction(() => document.querySelector('#adm-epList-api')?.textContent.includes('Recovered endpoint'));
    assert.equal(await page.locator('[data-adm-endpoint-load-error]').count(), 0);

    await setPlans([
      { hold: true, status: 503, payload: { detail: 'old failure' } },
      { payload: [endpoint('Newest endpoint', 'newest')] },
    ]);
    await page.evaluate(() => { window.oldLoad = window.__testLoadEndpoints(); window.newLoad = window.__testLoadEndpoints(); });
    await page.evaluate(() => window.newLoad);
    await page.evaluate(() => fetch('/__release'));
    await page.evaluate(() => window.oldLoad);
    assert.match(await page.locator('#adm-epList-api').textContent(), /Newest endpoint/,
      'an old failed request cannot replace the newer inventory');
    assert.equal(await page.locator('[data-adm-endpoint-load-error]').count(), 0);
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log('PASS: endpoint errors preserve inventory, retry recovers, and stale failures are ignored');
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
