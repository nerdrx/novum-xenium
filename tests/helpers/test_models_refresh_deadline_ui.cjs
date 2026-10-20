const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const repo = path.resolve(__dirname, "../..");
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || path.join(repo, 'node_modules/playwright'));
const html = `<!doctype html><meta charset="utf-8"><div id="models"></div><div id="toast"></div>
<div id="scroll-bottom-btn"></div><textarea id="message"></textarea>
<div id="model-picker-wrap"><button id="model-picker-btn"><span id="model-picker-label"></span></button>
<div id="model-picker-menu" class="model-picker-menu hidden"><div class="model-picker-search-row"><input id="model-picker-search"></div>
<button id="model-picker-refresh-btn"></button><button id="model-picker-add-models-btn"></button><div id="model-picker-list"></div></div></div>
<style>.hidden{display:none}</style><script type="module">import models from '/static/js/models.js'; models.init(location.origin); window.modelsModule=models; window.fixtureReady=true;</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, {'content-type':'text/html'}); return res.end(html); }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {'content-type': (file.endsWith('.js') || file.endsWith('.mjs')) ? 'text/javascript' : 'text/plain'});
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage']});
  const evidence = [];
  try {
    for (const phase of ['fetch', 'body']) {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(() => window.fixtureReady);
      await page.evaluate((phase) => {
        const nativeSetTimeout = window.setTimeout.bind(window);
        const nativeClearTimeout = window.clearTimeout.bind(window);
        const timers = new Map();
        let next = 100000;
        window.audit = {phase, timers, records: [], mode: phase, data: null, offset: 0};
        const now = Date.now();
        Date.now = () => now + audit.offset;
        window.setTimeout = (callback, delay, ...args) => {
          if (delay === 30000) {
            const id = next++;
            timers.set(id, () => callback(...args));
            return id;
          }
          return nativeSetTimeout(callback, delay, ...args);
        };
        window.clearTimeout = (id) => {
          if (timers.has(id)) timers.delete(id);
          else nativeClearTimeout(id);
        };
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (url, options = {}) => {
          if (!String(url).includes('/api/models')) return nativeFetch(url, options);
          const record = {signal: options.signal, deadline: [...timers.keys()].at(-1), aborted: false};
          audit.records.push(record);
          const mode = audit.mode, data = audit.data;
          let resolveFetch, rejectFetch, resolveBody, rejectBody;
          const response = {
            ok: true,
            json: () => mode === 'success' ? Promise.resolve(data) : new Promise((resolve, reject) => {
              resolveBody = resolve;
              rejectBody = reject;
              record.bodyWaiting = true;
            }),
          };
          const result = new Promise((resolve, reject) => {
            resolveFetch = resolve;
            rejectFetch = reject;
            if (mode !== 'fetch') resolve(response);
          });
          record.finish = (value) => {
            response.json = () => Promise.resolve(value);
            resolveFetch(response);
            resolveBody?.(value);
          };
          options.signal?.addEventListener('abort', () => {
            record.aborted = true;
            const error = new DOMException('Synthetic catalog abort', 'AbortError');
            rejectFetch(error);
            rejectBody?.(error);
          }, {once: true});
          return result;
        };
        window.catalogData = (model) => ({items: [{endpoint_id: 'fixture', endpoint_name: 'Fixture',
          url: 'http://fixture', category: 'local', models: [model], models_display: [model], offline: false}]});
        window.catalogState = () => ({
          rows: [...document.querySelectorAll('#models .models-row')].map(row => row.dataset.modelId),
          cache: modelsModule.getCachedItems().flatMap(item => item.models),
          warning: !!document.querySelector('#models .models-refresh-error'),
          refreshing: document.getElementById('models').classList.contains('models-refreshing'),
          text: document.getElementById('models').textContent.trim(),
          timers: audit.timers.size,
        });
      }, phase);

      // Cold fetch/body hang: coalesced callers settle and the real spinner disappears.
      await page.evaluate(() => {
        window.cold = modelsModule.refreshModels(true);
        window.coldJoin = modelsModule.refreshModels(false);
      });
      if (phase === 'body') await page.waitForFunction(() => audit.records[0].bodyWaiting);
      const coldBefore = await page.evaluate(() => ({requests: audit.records.length, timers: audit.timers.size}));
      assert.deepEqual(coldBefore, {requests: 1, timers: 1});
      await page.evaluate(() => audit.timers.get(audit.records[0].deadline)());
      const coldResults = await page.evaluate(() => Promise.all([cold, coldJoin]));
      assert.deepEqual(coldResults, [false, false]);
      const coldAfter = await page.evaluate(() => catalogState());
      assert.equal(coldAfter.text, '(scan failed)');
      assert.equal(coldAfter.refreshing, false);
      assert.equal(coldAfter.timers, 0);

      // A retry is a fresh request and installs a real cached row.
      await page.evaluate(() => {
        audit.mode = 'success'; audit.data = catalogData('saved-model');
        return modelsModule.refreshModels(true);
      });
      assert.deepEqual((await page.evaluate(() => catalogState())).rows, ['saved-model']);
      await page.evaluate(() => {
        audit.offset += 31000; audit.mode = audit.phase;
        window.held = modelsModule.refreshModels(false);
        window.heldJoin = modelsModule.refreshModels(false);
      });
      if (phase === 'body') await page.waitForFunction(() => audit.records[2].bodyWaiting);
      assert.equal(await page.evaluate(() => audit.records.length), 3);
      await page.evaluate(() => audit.timers.get(audit.records[2].deadline)());
      assert.deepEqual(await page.evaluate(() => Promise.all([held, heldJoin])), [false, false]);
      const cachedAfter = await page.evaluate(() => catalogState());
      assert.deepEqual(cachedAfter.rows, ['saved-model']);
      assert.deepEqual(cachedAfter.cache, ['saved-model']);
      assert.match(cachedAfter.text, /Could not refresh model list/);
      assert.equal(cachedAfter.refreshing, false);
      assert.equal(cachedAfter.timers, 0);

      // A stale timeout must not abort, clear, or render over a newer forced owner.
      await page.evaluate(() => {
        window.older = modelsModule.refreshModels(false);
        window.newer = modelsModule.refreshModels(true);
      });
      if (phase === 'body') await page.waitForFunction(() => audit.records[4].bodyWaiting);
      assert.equal(await page.evaluate(() => audit.records.length), 5);
      await page.evaluate(() => audit.timers.get(audit.records[3].deadline)());
      assert.equal(await page.evaluate(() => older), undefined);
      const pendingNewer = await page.evaluate(() => ({aborted: audit.records[4].aborted, ...catalogState()}));
      assert.equal(pendingNewer.aborted, false);
      assert.equal(pendingNewer.refreshing, true);
      assert.equal(pendingNewer.timers, 1);
      await page.evaluate(() => { window.newerJoin = modelsModule.refreshModels(false); });
      assert.equal(await page.evaluate(() => audit.records.length), 5, 'stale finalizer leaves current request joinable');
      await page.evaluate(() => audit.records[4].finish(catalogData('newer-model')));
      await page.evaluate(() => Promise.all([newer, newerJoin]));
      const finalState = await page.evaluate(() => catalogState());
      assert.deepEqual(finalState.rows, ['newer-model']);
      assert.deepEqual(finalState.cache, ['newer-model']);
      assert.equal(finalState.refreshing, false);
      assert.equal(finalState.timers, 0);
      assert.doesNotMatch(finalState.text, /Could not refresh model list/);

      // Malformed successful JSON must preserve cached rows and permit retry.
      const catalogValidation = await page.evaluate(async () => {
        const cases = [];
        for (const [name, data] of [
          ['missing-items', {detail:'service unavailable'}],
          ['non-array-items', {items:{unexpected:'object'}}],
        ]) {
          const expectedRows = catalogState().rows;
          audit.offset += 31000;
          audit.mode = 'success'; audit.data = data;
          const rejected = await modelsModule.refreshModels(true);
          const preserved = catalogState();
          audit.data = catalogData(`retry-${name}`);
          await modelsModule.refreshModels(true);
          cases.push({name, expectedRows, rejected, preserved, retried:catalogState()});
        }
        audit.data = {items:[]};
        const emptyResult = await modelsModule.refreshModels(true);
        return {cases, emptyResult, empty:catalogState()};
      });
      for (const item of catalogValidation.cases) {
        assert.equal(item.rejected, false, `${item.name} rejected`);
        assert.deepEqual(item.preserved.rows, item.expectedRows);
        assert.deepEqual(item.preserved.cache, item.expectedRows);
        assert.equal(item.preserved.warning, true);
        assert.deepEqual(item.retried.rows, [`retry-${item.name}`]);
        assert.deepEqual(item.retried.cache, [`retry-${item.name}`]);
        assert.equal(item.retried.warning, false);
      }
      assert.notEqual(catalogValidation.emptyResult, false, 'empty array is valid catalog');
      assert.deepEqual(catalogValidation.empty.rows, []);
      assert.deepEqual(catalogValidation.empty.cache, []);
      assert.equal(catalogValidation.empty.warning, false);
      assert.equal(await page.evaluate(() => audit.records.every(record => !!record.signal)), true);
      assert.deepEqual(pageErrors, []);
      evidence.push({phase, coldBefore, coldResults, coldAfter, cachedAfter, pendingNewer, finalState, catalogValidation, pageErrors});
      await page.close();
    }
    if (process.env.EVIDENCE_DIR) {
      fs.mkdirSync(process.env.EVIDENCE_DIR, {recursive: true});
      fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'models-refresh-deadline-ui.json'), JSON.stringify(evidence, null, 2));
    }
    console.log(JSON.stringify({mode: 'models-refresh-deadline', actualModule: true, syntheticOnly: true, evidence}, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
