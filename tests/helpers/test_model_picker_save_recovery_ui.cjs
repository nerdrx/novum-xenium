// Hidden-browser coverage for model picker save failures and concurrent picks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE ||
  '/home/nerdrx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
  <div id="toast"></div><div id="scroll-bottom-btn"></div><textarea id="message"></textarea>
  <div id="model-picker-wrap"><button id="model-picker-btn"><span id="model-picker-label"></span></button>
    <div id="model-picker-menu" class="model-picker-menu hidden">
      <div class="model-picker-search-row"><input id="model-picker-search"></div>
      <button id="model-picker-refresh-btn"></button><div id="model-picker-list"></div>
    </div>
  </div>
  <script type="module">
    import { initModelPicker, updateModelPicker } from '/static/js/modelPicker.js';
    let currentSessionId = 's1';
    window.sessions = [{ id: 's1', model: 'old-model', endpoint_url: 'http://old', name: 'Chat' },
      { id: 's2', model: 'other-model', endpoint_url: 'http://other', name: 'Other' }];
    window.__odysseusLastPickedRoute = { model: 'old-model', endpoint_url: 'http://old', endpoint_id: 'old-ep',
      display: 'Old', picked_at: Date.now() };
    window.modelsModule = {
      getCachedItems: () => [{ endpoint_id: 'ep', endpoint_name: 'Fixture', url: 'http://fixture',
        models: ['alpha-model', 'beta-model'], models_display: ['Alpha', 'Beta'] }],
      refreshModels: async () => new Promise(resolve => setTimeout(resolve, 35)),
    };
    initModelPicker({ getCurrentSessionId: () => currentSessionId, getSessions: () => window.sessions,
      getPendingChat: () => null, setPendingChat() {}, async createDirectChat() {} });
    window.setCurrentSession = id => { currentSessionId = id; updateModelPicker(); };
    window.fixtureReady = true;
  </script>
</body>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); return res.end('{}'); }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

const waitUntil = async (fn, timeoutMs = 3000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for fixture state');
};

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    async function newPage() {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.stack || error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(() => window.fixtureReady);
      return { page, errors };
    }
    async function choose(page, modelName) {
      await page.locator('#model-picker-btn').click();
      await page.locator('.model-switch-item').filter({ hasText: modelName }).click();
    }

    // A failed PATCH must leave both the confirmed session model and picker label intact.
    {
      const { page, errors } = await newPage();
      await page.route('**/api/session/s1', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"fixture failure"}' }));
      await choose(page, 'Alpha');
      await page.waitForFunction(() => !window.__odysseusModelSwitchPromise);
      assert.equal(await page.locator('#model-picker-label').textContent(), 'old-model');
      assert.equal(await page.evaluate(() => window.sessions[0].model), 'old-model');
      assert.equal(await page.evaluate(() => window.__odysseusLastPickedRoute.model), 'old-model');
      assert.match(await page.locator('#toast').textContent(), /previous selection kept.*retry/i);
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Two quick picks for one session are written in interaction order; stale A cannot repaint over B.
    {
      const { page, errors } = await newPage();
      const calls = [];
      let releaseA;
      const firstResponse = new Promise(resolve => { releaseA = resolve; });
      await page.route('**/api/session/s1', async route => {
        const body = route.request().postData() || '';
        const model = body.match(/name="model"\r\n\r\n([^\r]+)/)?.[1] || '';
        calls.push(model);
        if (calls.length === 1) { await firstResponse; await route.fulfill({ status: 200, body: '{}' }); }
        else await route.fulfill({ status: 200, body: '{}' });
      });
      await choose(page, 'Alpha');
      await waitUntil(() => calls.length === 1);
      await page.waitForFunction(() => document.querySelector('#model-picker-menu').classList.contains('hidden'));
      await choose(page, 'Beta');
      await page.waitForTimeout(80);
      assert.deepEqual(calls, ['alpha-model'], 'B waits for A instead of racing its PATCH');
      assert.equal(await page.locator('#model-picker-label').textContent(), 'old-model', 'pending picks keep last confirmed label');
      releaseA();
      await waitUntil(() => calls.length === 2);
      await page.waitForFunction(() => !window.__odysseusModelSwitchPromise);
      assert.deepEqual(calls, ['alpha-model', 'beta-model']);
      assert.equal(await page.evaluate(() => window.sessions[0].model), 'beta-model');
      assert.equal(await page.locator('#model-picker-label').textContent(), 'beta-model');
      assert.equal(await page.evaluate(() => window.__odysseusLastPickedRoute.model), 'beta-model');
      assert.deepEqual(errors, []);
      await page.close();
    }

    // A completion for a session left behind updates only that session, not the newly selected chat.
    {
      const { page, errors } = await newPage();
      let release;
      const held = new Promise(resolve => { release = resolve; });
      await page.route('**/api/session/s1', async route => { await held; await route.fulfill({ status: 200, body: '{}' }); });
      await choose(page, 'Alpha');
      await page.waitForTimeout(40);
      await page.evaluate(() => window.setCurrentSession('s2'));
      assert.equal(await page.locator('#model-picker-label').textContent(), 'other-model');
      release();
      await page.waitForFunction(() => !window.__odysseusModelSwitchPromise);
      assert.equal(await page.evaluate(() => window.sessions[0].model), 'alpha-model');
      assert.equal(await page.evaluate(() => window.sessions[1].model), 'other-model');
      assert.equal(await page.locator('#model-picker-label').textContent(), 'other-model');
      assert.equal(await page.evaluate(() => window.__odysseusLastPickedRoute.model), 'old-model',
        'a successful save for the inactive chat must not replace the active send route');
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Duplicate auto-select events racing their inventory refresh produce one persisted pick.
    {
      const { page, errors } = await newPage();
      const calls = [];
      await page.evaluate(() => { window.sessions[0].model = ''; });
      await page.route('**/api/session/s1', async route => { calls.push(route.request().postData() || ''); await route.fulfill({ status: 200, body: '{}' }); });
      await page.evaluate(() => {
        const detail = { endpointId: 'ep', modelId: 'alpha-model', url: 'http://fixture' };
        document.dispatchEvent(new CustomEvent('odysseus:auto-select-model', { detail }));
        document.dispatchEvent(new CustomEvent('odysseus:auto-select-model', { detail }));
      });
      await waitUntil(() => calls.length > 0);
      await page.waitForFunction(() => !window.__odysseusModelSwitchPromise);
      await page.waitForTimeout(100);
      assert.equal(calls.length, 1);
      assert.equal(await page.evaluate(() => window.sessions[0].model), 'alpha-model');
      assert.equal(await page.evaluate(() => window.__odysseusLastPickedRoute.model), 'alpha-model');
      assert.deepEqual(errors, []);
      await page.close();
    }

    // An auto-select begun for one chat cannot apply after navigation during inventory refresh.
    {
      const { page, errors } = await newPage();
      const calls = [];
      await page.route('**/api/session/**', async route => { calls.push(route.request().url()); await route.fulfill({ status: 200, body: '{}' }); });
      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('odysseus:auto-select-model', {
          detail: { endpointId: 'ep', modelId: 'alpha-model', url: 'http://fixture' },
        }));
        window.setCurrentSession('s2');
      });
      await page.waitForTimeout(100);
      assert.deepEqual(calls, [], 'auto-selection is discarded when its captured chat is no longer active');
      assert.equal(await page.evaluate(() => window.sessions[0].model), 'old-model');
      assert.equal(await page.evaluate(() => window.sessions[1].model), 'other-model');
      assert.equal(await page.locator('#model-picker-label').textContent(), 'other-model');
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: model picker failed-save recovery, serialized choices, navigation ownership, and duplicate auto-select');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
