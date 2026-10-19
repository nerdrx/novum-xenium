import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const enginePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/engines.js');

test('image engine preserves action ownership, settings drafts, and stop access', async t => {
  const html = `<!doctype html><meta charset="utf-8"><main id="image-engine-panel">
    <select id="image-engine-mode"><option value="auto">Auto</option><option value="vulkan">Vulkan</option><option value="cpu">CPU</option></select>
    <input id="image-engine-idle" type="number" value="300"><input id="image-engine-auto-start" type="checkbox" checked>
    <p id="image-engine-status"></p><p id="image-engine-error" hidden></p><p id="image-engine-loaded"></p>
    <p id="image-engine-generation"></p><p id="image-engine-models"></p><p id="image-engine-pending" hidden></p>
    <button id="image-engine-configure">Configure</button><button id="image-engine-start">Start</button>
    <button id="image-engine-stop">Stop</button><button id="image-engine-refresh">Refresh</button></main>
    <script>
      window.setInterval = (callback, delay) => { if (delay === 10000) window.__poll = callback; return 1; };
    </script>
    <script type="module">
      import { initImageEngine } from '/engines.js';
      window.__calls = [];
      window.__status = { available: true, running: false, healthy: false, state: 'stopped', mode: 'vulkan', effective_mode: 'vulkan', auto_start: true, idle_seconds: 300, models: [], pending: [] };
      window.__ready = { ...window.__status, running: true, healthy: true, state: 'ready', loaded_model: 'new-model' };
      window.__deferStatus = false;
      window.__pendingStatus = null;
      window.__actionResults = {};
      window.__actionErrors = {};
      const invoke = async (command, args) => {
        window.__calls.push({ command, args });
        if (command === 'image_engine_status') {
          if (window.__deferStatus) {
            window.__deferStatus = false;
            return new Promise((resolve, reject) => {
              window.__pendingStatus = {
                resolve: value => { window.__pendingStatus = null; resolve(structuredClone(value)); },
                reject: message => { window.__pendingStatus = null; reject(new Error(message)); },
              };
            });
          }
          return structuredClone(window.__status);
        }
        if (command === 'image_engine_action') {
          const action = args.action.action;
          if (window.__actionErrors[action]) throw new Error(window.__actionErrors[action]);
          if (window.__actionResults[action]) return structuredClone(window.__actionResults[action]);
          if (action === 'start') return structuredClone(window.__ready);
          if (action === 'stop') return structuredClone({ ...window.__status, running: false, healthy: false, state: 'stopped', loaded_model: null });
          return structuredClone(window.__status);
        }
        throw new Error('Unexpected fake IPC: ' + command);
      };
      initImageEngine(invoke);
      window.__initialized = true;
    </script>`;
  const server = http.createServer(async (req, res) => {
    if (new URL(req.url, 'http://127.0.0.1').pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    } else if (new URL(req.url, 'http://127.0.0.1').pathname === '/engines.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(await fs.readFile(enginePath));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__initialized && !document.getElementById('image-engine-start').disabled);

  await page.evaluate(() => { window.__deferStatus = true; window.__poll(); });
  await page.waitForFunction(() => !!window.__pendingStatus);
  await page.locator('#image-engine-start').click();
  await page.waitForFunction(() => document.getElementById('image-engine-status').textContent === 'Ready · Vulkan');
  assert.equal(await page.locator('#image-engine-loaded').textContent(), 'Loaded: new-model');
  await page.evaluate(() => window.__pendingStatus.resolve(window.__status));
  await page.waitForTimeout(25);
  assert.equal(await page.locator('#image-engine-status').textContent(), 'Ready · Vulkan');
  assert.equal(await page.locator('#image-engine-loaded').textContent(), 'Loaded: new-model');
  assert.equal(await page.locator('#image-engine-start').isDisabled(), true);
  assert.equal(await page.locator('#image-engine-stop').isEnabled(), true);

  await page.evaluate(() => {
    window.__deferStatus = true;
    window.__actionResults.refresh = { ...window.__ready, loaded_model: 'fresh-success' };
    window.__poll();
  });
  await page.waitForFunction(() => !!window.__pendingStatus);
  await page.locator('#image-engine-refresh').click();
  await page.waitForFunction(() => document.getElementById('image-engine-loaded').textContent === 'Loaded: fresh-success');
  await page.evaluate(() => window.__pendingStatus.reject('stale poll failure after success'));
  await page.waitForTimeout(25);
  assert.equal(await page.locator('#image-engine-error').isHidden(), true, 'stale poll failure cannot replace newer action success');
  assert.equal(await page.locator('#image-engine-status').textContent(), 'Ready · Vulkan');

  await page.evaluate(() => {
    window.__deferStatus = true;
    window.__actionErrors.refresh = 'newer action failed';
    window.__poll();
  });
  await page.waitForFunction(() => !!window.__pendingStatus);
  await page.locator('#image-engine-refresh').click();
  await page.waitForFunction(() => document.getElementById('image-engine-error').textContent === 'newer action failed');
  await page.evaluate(() => window.__pendingStatus.reject('stale poll failure after action error'));
  await page.waitForTimeout(25);
  assert.equal(await page.locator('#image-engine-error').textContent(), 'newer action failed');
  assert.equal(await page.locator('#image-engine-status').textContent(), 'Ready · Vulkan');

  await page.evaluate(() => {
    delete window.__actionErrors.refresh;
    window.__actionResults.refresh = { ...window.__status, mode: 'cpu', effective_mode: 'cpu', idle_seconds: 300, auto_start: false };
    window.__deferStatus = true;
    window.__poll();
  });
  await page.waitForFunction(() => !!window.__pendingStatus);
  await page.locator('#image-engine-idle').focus();
  await page.locator('#image-engine-idle').evaluate(input => { input.value = '600'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => window.__pendingStatus.resolve(window.__actionResults.refresh));
  await page.waitForTimeout(25);
  assert.equal(await page.locator('#image-engine-idle').inputValue(), '600', 'input-only draft survives status before blur');
  assert.equal(await page.locator('#image-engine-mode').inputValue(), 'vulkan');

  await page.evaluate(() => {
    window.__actionResults.refresh = { available: false, running: true, healthy: false, state: 'running', mode: 'vulkan', effective_mode: 'vulkan', models: [], pending: [] };
  });
  await page.locator('#image-engine-refresh').click();
  await page.waitForFunction(() => document.getElementById('image-engine-status').textContent === 'running · Vulkan');
  assert.equal(await page.locator('#image-engine-start').isDisabled(), true);
  assert.equal(await page.locator('#image-engine-stop').isEnabled(), true, 'an owned running engine remains stoppable when its binary is unavailable');
  await page.evaluate(() => {
    window.__actionResults.stop = { available: false, running: false, healthy: false, state: 'stopped', mode: 'vulkan', effective_mode: 'vulkan', models: [], pending: [] };
  });
  await page.locator('#image-engine-stop').click();
  await page.waitForFunction(() => document.getElementById('image-engine-status').textContent === 'stopped · Vulkan');
  assert.ok(await page.evaluate(() => window.__calls.some(call => call.command === 'image_engine_action' && call.args.action.action === 'stop')));
  assert.deepEqual(errors, []);
});
