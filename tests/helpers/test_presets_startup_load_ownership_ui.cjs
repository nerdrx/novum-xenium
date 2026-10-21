'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const root = process.env.SOURCE_ROOT || path.resolve(__dirname, '../..');
const staticRoot = path.join(root, 'static');
const sourcePath = path.join(staticRoot, 'js/presets.js');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
const initialA = {
  name: 'A', character_name: 'A', enabled: true, temperature: 0.7, max_tokens: 900,
  system_prompt: 'old A prompt', reasoning_mode: 'auto', thinking_mode: '',
  persona_memory: '', persona_memory_schema: 'general',
};
let server, browser, heldResolve = null, heldSnapshot = null, loadMode = 'hold';
let custom = { ...initialA }, customRevision = 10;
const errors = [], externalRequests = [];
const templates = [{
  id: 'template-A', name: 'A', system_prompt: 'template A', temperature: 1,
  max_tokens: 0, reasoning_mode: 'auto', thinking_mode: '', persona_memory: '',
  persona_memory_schema: 'general',
}];
const html = `<!doctype html><meta charset="utf-8">
<div id="custom-preset-modal" class="modal hidden"><div class="modal-content">
<div class="preset-tab active" data-chartab="character"></div><div class="preset-chartab" data-chartab-panel="character"></div>
<div class="preset-tab" data-chartab="inject"></div><div class="preset-chartab" data-chartab-panel="inject"></div>
<div class="preset-tab" data-chartab="group"></div><div class="preset-chartab" data-chartab-panel="group"></div>
<select id="char-template-select"><option value="__default__">Default</option></select>
<button id="char-delete-template-btn"></button><button id="char-new-btn"></button><div id="char-name-row"></div>
<input id="custom-character-name"><textarea id="custom-system-prompt"></textarea>
<input id="custom-temperature" type="range" value="1"><span id="temp-value"></span>
<input id="custom-max-tokens" type="range" value="8448"><span id="tokens-value"></span>
<select id="custom-reasoning-mode"><option value="auto">auto</option></select>
<select id="custom-thinking-mode"><option value=""></option></select>
<input id="custom-show-persona-name" type="checkbox" checked><input id="inject-prefix"><input id="inject-suffix">
<button id="save-as-template-btn"></button><button id="reset-character-btn"></button><button id="char-expand-btn"></button>
<button id="overflow-preset-btn"></button><button id="character-indicator-btn"><span id="char-indicator-icon"></span><span id="character-indicator-name"></span></button>
<button id="save-custom-preset">Save</button><button id="close-custom-preset"></button><button id="cancel-custom-preset"></button>
</div></div>
<script type="module">
window.__presetDeadlineTimers = [];
window.__presetDeadlineClears = [];
const __nativeSetTimeout = window.setTimeout.bind(window);
const __nativeClearTimeout = window.clearTimeout.bind(window);
window.setTimeout = (callback, delay, ...args) => {
  const id = __nativeSetTimeout(callback, delay, ...args);
  if (delay === 15000) window.__presetDeadlineTimers.push(id);
  return id;
};
window.clearTimeout = id => {
  if (window.__presetDeadlineTimers.includes(id)) window.__presetDeadlineClears.push(id);
  return __nativeClearTimeout(id);
};
import m from '/static/js/presets.js';
window.m = m; window.errors = []; window.styledConfirm = async () => true;
window.uiModule = { showError: x => errors.push(x), showToast: () => {} };
m.init(location.origin);
window.loadPromise = m.loadPresets(uiModule.showError);
window.ready = true;
</script>`;

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function listen() {
  return new Promise(resolve => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (url.pathname.startsWith('/static/')) {
        const file = path.resolve(staticRoot, '.' + url.pathname.slice('/static'.length));
        if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return res.end(fs.readFileSync(file));
      }
      if (url.pathname === '/__state') return json(res, 200, { custom, customRevision, held: !!heldResolve });
      if (url.pathname === '/__release-load') {
        if (!heldResolve) return res.writeHead(409).end('no held load');
        heldResolve(); heldResolve = null;
        return res.writeHead(200).end();
      }
      if (url.pathname === '/api/presets/templates' && req.method === 'GET') return json(res, 200, templates);
      if (url.pathname === '/api/presets') {
        const snapshot = { custom: { ...custom }, custom_revision: customRevision, code_analyze: { name: 'built-in marker' } };
        if (loadMode === 'hold' || loadMode === 'hold-headers') {
          heldSnapshot = snapshot;
          await new Promise(resolveHeld => { heldResolve = resolveHeld; });
          if (!res.destroyed) return json(res, 200, snapshot);
          return;
        }
        if (loadMode === 'hold-body') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.write('{"custom":');
          await new Promise(resolveHeld => { heldResolve = resolveHeld; });
          if (!res.destroyed) {
            res.end(`${JSON.stringify(snapshot.custom)},"custom_revision":${customRevision},"code_analyze":${JSON.stringify(snapshot.code_analyze)}}`);
          }
          return;
        }
        if (loadMode === '503') return json(res, 503, { detail: 'synthetic unavailable' });
        if (loadMode === 'array') return json(res, 200, []);
        if (loadMode === 'bad-custom') return json(res, 200, { custom: 'not-an-object', custom_revision: customRevision });
        if (loadMode === 'legacy-null') return json(res, 200, { custom: null, code_analyze: { name: 'legacy marker' } });
        if (loadMode === 'legacy-absent') return json(res, 200, { code_analyze: { name: 'legacy marker' } });
        return json(res, 200, snapshot);
      }
      if (url.pathname === '/api/presets/custom' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const config = JSON.parse(body);
        custom = { ...config, character_name: config.name };
        customRevision++;
        return json(res, 200, { success: true, custom_revision: customRevision });
      }
      if (url.pathname === '/api/presets/templates' && req.method === 'POST') return json(res, 200, { success: true });
      if (url.pathname.startsWith('/api/presets/templates/') && req.method === 'DELETE') return json(res, 200, { success: true, custom_revision: customRevision });
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', resolve);
  });
}
async function waitFor(page, predicate, description) {
  await page.waitForFunction(predicate, null, { timeout: 8000 }).catch(error => {
    throw new Error(`Timed out waiting for ${description}: ${error.message}`);
  });
}

(async () => {
  let contexts = [];
  try {
    await listen();
    browser = await chromium.launch({
      headless: true,
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
      args: ['--no-sandbox'],
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext(); contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => { if (new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
    await page.goto(origin);
    await waitFor(page, () => window.ready === true, 'module fixture ready');
    await waitFor(page, async () => (await fetch('/__state').then(res => res.json())).held, 'held startup snapshot');
    assert.equal(heldSnapshot.custom.character_name, 'A');
    await waitFor(page, () => window.m.getUserTemplates().some(item => item.id === 'template-A'), 'initial saved template load');

    await page.evaluate(() => window.m.openCustomPresetModal());
    await page.locator('#custom-character-name').fill('B');
    await page.locator('#custom-system-prompt').fill('saved B prompt');
    await page.evaluate(() => { window.savePromise = window.m.saveCustomPreset(uiModule.showToast, uiModule.showError); });
    await page.evaluate(() => window.savePromise);
    assert.equal(custom.character_name, 'B');
    await page.locator('#custom-system-prompt').fill('newer unsaved B draft');
    await page.request.get(`${origin}/__release-load`);
    await page.evaluate(() => window.loadPromise);
    const afterOldLoad = await page.evaluate(() => ({
      custom: window.m.getAllPresets().custom,
      revision: window.m.getAllPresets().custom_revision,
      selected: window.m.getSelectedPreset(),
      form: document.querySelector('#custom-system-prompt').value,
      marker: window.m.getAllPresets().code_analyze,
    }));
    assert.equal(afterOldLoad.custom.character_name, 'B');
    assert.equal(afterOldLoad.custom.system_prompt, 'saved B prompt');
    assert.equal(afterOldLoad.revision, 11);
    assert.equal(afterOldLoad.selected, 'custom');
    assert.equal(afterOldLoad.form, 'newer unsaved B draft');
    assert.equal(afterOldLoad.marker.name, 'built-in marker', 'stale response still loads noncustom presets');

    loadMode = 'normal';
    await page.evaluate(() => window.normalLoad = window.m.loadPresets(uiModule.showError));
    await page.evaluate(() => window.normalLoad);
    const normal = await page.evaluate(() => ({ custom: window.m.getAllPresets().custom.character_name, marker: window.m.getAllPresets().code_analyze.name }));
    assert.deepEqual(normal, { custom: 'B', marker: 'built-in marker' });

    const beforeFailures = await page.evaluate(() => JSON.stringify(window.m.getAllPresets()));
    const errorsBefore = await page.evaluate(() => window.errors.length);
    for (const mode of ['503', 'array', 'bad-custom']) {
      loadMode = mode;
      await page.evaluate(() => window.nextLoad = window.m.loadPresets(uiModule.showError));
      await page.evaluate(() => window.nextLoad);
      assert.equal(await page.evaluate(() => JSON.stringify(window.m.getAllPresets())), beforeFailures, `${mode} preserves cached presets`);
    }
    assert.equal(await page.evaluate(() => window.errors.length), errorsBefore + 3, 'each invalid response uses the existing load error');

    loadMode = 'legacy-null';
    await page.evaluate(() => window.legacyNullLoad = window.m.loadPresets(uiModule.showError));
    await page.evaluate(() => window.legacyNullLoad);
    assert.equal(await page.evaluate(() => window.m.getAllPresets().custom), null, 'legacy custom:null remains accepted');
    loadMode = 'legacy-absent';
    await page.evaluate(() => window.legacyAbsentLoad = window.m.loadPresets(uiModule.showError));
    await page.evaluate(() => window.legacyAbsentLoad);
    assert.equal(await page.evaluate(() => window.m.getAllPresets().custom), undefined, 'legacy missing custom remains accepted');
    assert.equal(await page.evaluate(() => window.errors.length), errorsBefore + 3, 'legacy null/absent shapes do not show errors');
    assert.deepEqual(externalRequests, []);

    const deadlineRuns = [];
    for (const mode of ['hold-headers', 'hold-body']) {
      loadMode = mode;
      const deadlineContext = await browser.newContext(); contexts.push(deadlineContext);
      const deadlinePage = await deadlineContext.newPage();
      deadlinePage.setDefaultTimeout(30000);
      deadlinePage.on('pageerror', error => errs.push(String(error)));
      deadlinePage.on('request', request => { if (new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
      const started = Date.now();
      await deadlinePage.goto(origin);
      await waitFor(deadlinePage, () => window.ready === true, `${mode} fixture ready`);
      await waitFor(deadlinePage, async () => (await fetch('/__state').then(res => res.json())).held, `${mode} request held`);
      await deadlinePage.evaluate(() => window.loadPromise);
      const elapsedMs = Date.now() - started;
      const timedOut = await deadlinePage.evaluate(() => ({
        selected: window.m.getSelectedPreset(),
        cache: window.m.getAllPresets(),
        errors: window.errors.slice(),
        timers: window.__presetDeadlineTimers.length,
        clears: window.__presetDeadlineClears.length,
      }));
      assert(elapsedMs >= 14000, `${mode} must reach the 15-second deadline; elapsed ${elapsedMs}ms`);
      assert.equal(timedOut.selected, null);
      assert.deepEqual(timedOut.cache, {});
      assert.deepEqual(timedOut.errors, ['Failed to load presets']);
      assert.equal(timedOut.timers, 1);
      assert.equal(timedOut.clears, 1, `${mode} clears the deadline timer after abort`);
      await deadlinePage.request.get(`${origin}/__release-load`);
      deadlineRuns.push({ mode, elapsed_ms: elapsedMs });
    }

    loadMode = 'normal';
    const successContext = await browser.newContext(); contexts.push(successContext);
    const successPage = await successContext.newPage();
    successPage.setDefaultTimeout(8000);
    successPage.on('pageerror', error => errs.push(String(error)));
    successPage.on('request', request => { if (new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
    await successPage.goto(origin);
    await waitFor(successPage, () => window.ready === true, 'deadline success control ready');
    await successPage.evaluate(() => window.loadPromise);
    const successTimerState = await successPage.evaluate(() => ({
      selected: window.m.getSelectedPreset(),
      timers: window.__presetDeadlineTimers.length,
      clears: window.__presetDeadlineClears.length,
      errors: window.errors.length,
    }));
    assert.equal(successTimerState.selected, 'custom');
    assert.equal(successTimerState.timers, 1);
    assert.equal(successTimerState.clears, 1, 'success clears the deadline timer');
    assert.equal(successTimerState.errors, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);

    console.log(JSON.stringify({ pass: true, source_sha256: sourceHash, startup_overwrite_preserved: afterOldLoad, normal_control: normal, invalid_load_errors: 3, legacy_null_and_absent_accepted: true, deadline_runs: deadlineRuns, success_timer_cleanup: successTimerState, external_requests: externalRequests }));
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
