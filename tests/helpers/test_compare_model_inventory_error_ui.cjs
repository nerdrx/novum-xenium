// Compare must distinguish an API failure from a genuine empty model inventory and retry on reopen.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
<script type="module">
  import { showModelSelector } from '/static/js/compare/selector.js';
  window.openModelSelector = () => { window.selectorResult = showModelSelector(); };
  window.openModelSelector(); window.fixtureReady = true;
</script></body>`;
let modelRequests = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/models') {
    modelRequests++;
    res.setHeader('Content-Type', 'application/json');
    if (modelRequests === 1) {
      res.writeHead(503);
      return res.end(JSON.stringify({ detail: 'fixture inventory unavailable' }));
    }
    return res.end(JSON.stringify({ items: [{
      endpoint_id: 'fixture-endpoint', endpoint_name: 'Fixture', url: 'http://fixture-model',
      models: ['qwen2.5'], models_display: ['qwen2.5'],
    }] }));
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('#compare-model-overlay'));
    const overlay = page.locator('#compare-model-overlay');
    await page.waitForFunction(() => document.querySelector('#compare-model-overlay')?.textContent.includes('Failed to load models'));
    assert.equal(await page.locator('#compare-model-overlay').count(), 1);
    assert.equal(await overlay.locator('text=No models available').count(), 0,
      'HTTP failure must not be shown as a successfully empty inventory');

    await overlay.locator('.close-btn').click();
    await page.waitForFunction(() => !document.querySelector('#compare-model-overlay'));
    await page.evaluate(() => window.openModelSelector());
    await page.waitForFunction(() => document.querySelector('.cmp-model-row'));
    assert.equal(modelRequests, 2, 'closing and reopening retries instead of reusing a cached failure');
    assert.match(await page.locator('#compare-model-overlay').textContent(), /qwen2\.5/);
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    await page.locator('#compare-model-overlay .close-btn').click();
    console.log('PASS: Compare inventory failure state and retry after reopen');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
