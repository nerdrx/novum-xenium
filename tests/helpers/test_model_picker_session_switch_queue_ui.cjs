// Synthetic actual-module check that session-specific model-switch queues remain addressable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

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
    import { initModelPicker, updateModelPicker, getPendingModelSwitch } from '/static/js/modelPicker.js?v=20260909routeidentity1';
    let currentSessionId = 's1';
    window.sessions = [
      { id: 's1', model: 'old-model', endpoint_url: 'http://fixture', name: 'A' },
      { id: 's2', model: 'old-model', endpoint_url: 'http://fixture', name: 'B' },
    ];
    window.modelsModule = { getCachedItems: () => [{ endpoint_id: 'ep', endpoint_name: 'Fixture', url: 'http://fixture', models: ['alpha-model', 'beta-model'], models_display: ['Alpha', 'Beta'] }] };
    initModelPicker({ getCurrentSessionId: () => currentSessionId, getSessions: () => window.sessions,
      getPendingChat: () => null, setPendingChat() {}, async createDirectChat() {} });
    window.setCurrentSession = id => { currentSessionId = id; updateModelPicker(); };
    window.getPendingModelSwitch = getPendingModelSwitch;
    window.fixtureReady = true;
  </script>
</body>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const waitUntil = async (page, predicate) => page.waitForFunction(predicate, null, { timeout: 5000 });

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => {
      window.pendingPatches = {};
      window.fetch = (input, init = {}) => {
        const match = String(input).match(/\/api\/session\/([^/?]+)/);
        if (!match || init.method !== 'PATCH') return Promise.resolve(new Response('{}', { status: 200 }));
        const id = decodeURIComponent(match[1]);
        return new Promise(resolve => { window.pendingPatches[id] = { resolve: status => resolve(new Response('{}', { status })) }; });
      };
    });
    const choose = async label => {
      await page.locator('#model-picker-btn').click();
      await page.locator('.model-switch-item').filter({ hasText: label }).click();
    };
    await choose('Alpha');
    await waitUntil(page, () => !!window.pendingPatches.s1);
    await page.evaluate(() => { window.pendingA = window.getPendingModelSwitch('s1'); window.setCurrentSession('s2'); });
    await choose('Beta');
    await waitUntil(page, () => !!window.pendingPatches.s2);
    const sameQueues = await page.evaluate(() => ({
      globalOwner: window.__odysseusModelSwitchPromise?.sessionId,
      aPresent: !!window.getPendingModelSwitch('s1'),
      bPresent: !!window.getPendingModelSwitch('s2'),
      distinct: window.getPendingModelSwitch('s1') !== window.getPendingModelSwitch('s2'),
      aStable: window.pendingA === window.getPendingModelSwitch('s1'),
    }));
    assert.equal(sameQueues.globalOwner, 's2', 'legacy global points to newest B pick');
    assert.equal(sameQueues.aPresent, true);
    assert.equal(sameQueues.bPresent, true);
    assert.equal(sameQueues.distinct, true);
    assert.equal(sameQueues.aStable, true, 'A send can still await its own in-flight queue');

    await page.evaluate(() => window.pendingPatches.s1.resolve(200));
    await page.waitForTimeout(100);
    const afterA = await page.evaluate(() => ({
      aPending: window.getPendingModelSwitch('s1') !== null,
      bPending: window.getPendingModelSwitch('s2') !== null,
    }));
    assert.deepEqual(afterA, { aPending: false, bPending: true }, 'finishing A releases only A queue');
    await page.evaluate(() => window.pendingPatches.s2.resolve(200));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.getPendingModelSwitch('s2')), null);
    assert.deepEqual(await page.evaluate(() => window.sessions.map(session => session.model)), ['alpha-model', 'beta-model']);
    console.log(JSON.stringify({ pass: true, mode: 'per-session-model-switch-queue', sameQueues }, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
