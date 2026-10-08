// Keyboard checks against the real model picker module in a fixture page.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
  <div class="model-picker-wrap" id="model-picker-wrap">
    <button type="button" id="model-picker-btn"><span id="model-picker-label">Choose model</span></button>
    <div class="model-picker-menu hidden" id="model-picker-menu">
      <div class="model-picker-search-row">
        <input id="model-picker-search" aria-label="Search models">
        <button type="button" id="model-picker-refresh-btn">Refresh</button>
        <button type="button" id="model-picker-add-models-btn">Add models</button>
      </div>
      <div class="model-picker-list" id="model-picker-list"></div>
    </div>
  </div>
  <button type="button" id="outside">Outside</button>
  <div id="toast"></div>
  <script type="module">
    import { initModelPicker } from '/static/js/modelPicker.js';
    let pending = { modelId: 'initial', source: 'manual' };
    window.modelsModule = {
      getCachedItems: () => [{ endpoint_id: 'fixture-ep', endpoint_name: 'Fixture',
        url: 'http://fixture.local/v1', category: 'local',
        models: ['fixture/model-a', 'fixture/model-b'] }],
      refreshModels: async () => {},
    };
    initModelPicker({
      getCurrentSessionId: () => null, getSessions: () => [],
      getPendingChat: () => pending, setPendingChat: value => { pending = value; },
      createDirectChat: async () => {},
    });
    window.fixtureState = () => ({ pending, activeId: document.activeElement?.id || '',
      activeClass: document.activeElement?.className || '' });
    window.fixtureReady = true;
  </script>
</body>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname === '/api/model-endpoints/probe-local') {
    res.setHeader('Content-Type', 'application/json'); return res.end('{}');
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
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
    await page.waitForFunction(() => window.fixtureReady);

    await page.locator('#model-picker-btn').click();
    await page.waitForSelector('.model-switch-item');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'model-picker-search');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#model-picker-menu').classList.contains('hidden'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'model-picker-btn',
      'Escape from search returns focus to the opener');

    await page.locator('#model-picker-btn').click();
    await page.waitForSelector('.model-switch-item');
    await page.keyboard.press('Tab'); // Refresh
    await page.keyboard.press('Tab'); // Add models
    await page.keyboard.press('Tab'); // First favorite button
    assert.match(await page.evaluate(() => document.activeElement.className), /mp-fav-dot/,
      'favorite control is keyboard focusable');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#model-picker-menu').classList.contains('hidden'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'model-picker-btn',
      'Escape from a nested favorite control returns focus to the opener');

    await page.locator('#model-picker-btn').click();
    await page.waitForSelector('.model-switch-item');
    await page.locator('#model-picker-search').fill('model-b');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#model-picker-menu').classList.contains('hidden'));
    assert.equal((await page.evaluate(() => window.fixtureState())).pending.modelId, 'fixture/model-b',
      'ArrowDown and Enter still choose the filtered model');
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'model-picker-btn',
      'model selection retains its existing focus behavior');

    await page.locator('#model-picker-btn').click();
    await page.waitForSelector('.model-switch-item');
    await page.locator('#outside').click();
    await page.waitForFunction(() => document.querySelector('#model-picker-menu').classList.contains('hidden'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'outside',
      'outside-click dismissal does not steal focus');
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log('PASS: picker Escape restores focus; selection, favorite focus, and outside dismissal remain intact');
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.closeAllConnections?.(); server.close(); process.exitCode = 1; });
