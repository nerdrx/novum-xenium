const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || '/run/media/nerdrx/Lex/novum-xenium/node_modules/playwright');

const repo = path.resolve(__dirname, '../..');
const endpointList = [
  { id: 'fixture-a', name: 'Fixture A', is_enabled: true, online: true, models: ['chat-a', 'utility-a', 'research-a'], model_type: 'chat' },
  { id: 'fixture-b', name: 'Fixture B', is_enabled: true, online: true, models: ['chat-b'], model_type: 'chat' },
];
const settings = {
  default_endpoint_id: 'fixture-b', default_model: 'chat-b',
  utility_endpoint_id: 'fixture-b', utility_model: 'utility-b', utility_model_fallbacks: [], utility_reasoning_effort: '',
  vision_enabled: true, vision_endpoint_id: 'fixture-a', vision_model: 'chat-a', vision_model_fallbacks: [],
  research_endpoint_id: 'fixture-b', research_model: 'research-b', research_max_tokens: 4096,
  research_extraction_timeout_seconds: 90, research_extraction_concurrency: 3, research_run_timeout_seconds: 3600,
  search_provider: 'disabled', search_api_key: '', tts_provider: 'disabled', stt_provider: 'disabled',
};
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes = Object.fromEntries(['static/index.html', 'static/js/settings.js', 'static/js/settings/shell.js', 'static/js/admin.js']
  .map(file => [file, hashFile(path.join(repo, file))]));
const requestLog = [];
const endpointRequests = [];
const pendingRelevant = new Set();
const externalRequests = [];
const pageErrors = [];
let heldTarget = null;
let targetObserved = 0;
let lastNonTargetRelevantAt = Date.now();
let postBodies = [];
let totalPostCount = 0;
let holdEndpointMode = null;
let holdSettingsRead = false;
let heldSettingsRead = null;
let targetCaller = null;
const sendJson = (res, body, status = 200) => {
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requestLog.push(`${req.method} ${url.pathname}${url.search}`);
  const isRelevant = req.method === 'GET' && ['/api/auth/settings', '/api/models', '/api/model-endpoints'].includes(url.pathname);
  const isTargetRead = url.pathname === '/api/model-endpoints' && req.headers['x-fixture-caller'] === targetCaller;
  const id = requestLog.length;
  if (isRelevant) {
    pendingRelevant.add(id);
    if (!isTargetRead) lastNonTargetRelevantAt = Date.now();
    const finishPending = () => {
      pendingRelevant.delete(id);
      if (!isTargetRead) lastNonTargetRelevantAt = Date.now();
    };
    res.on('finish', finishPending);
    res.on('close', finishPending);
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8').replaceAll('{{CSP_NONCE}}', 'fixture-nonce'));
  }
  if (url.pathname === '/api/auth/status') return sendJson(res, { username: 'synthetic', is_admin: true, privileges: {} });
  if (url.pathname === '/api/auth/features') return sendJson(res, {});
  if (url.pathname === '/api/auth/settings' && req.method === 'GET') {
    if (req.headers['x-fixture-caller'] === `${targetCaller}-settings` && holdSettingsRead) {
      holdSettingsRead = false;
      heldSettingsRead = { id, res, ended: false, closed: false };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.flushHeaders();
      res.on('finish', () => { heldSettingsRead.ended = true; });
      res.on('close', () => { heldSettingsRead.closed = true; });
      return;
    }
    return sendJson(res, settings);
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => body += chunk);
    req.on('end', () => { postBodies.push(JSON.parse(body)); sendJson(res, { ok: true }); });
    return;
  }
  if (url.pathname === '/api/model-endpoints' && req.method === 'GET') {
    const target = req.headers['x-fixture-caller'] === targetCaller && !!holdEndpointMode;
    const entry = { id, target, headersSent: false, ended: false, closed: false, aborted: false, res, caller: req.headers['x-fixture-caller'] || null, phase: holdEndpointMode };
    endpointRequests.push(entry);
    res.on('finish', () => { entry.ended = true; });
    res.on('close', () => { entry.closed = true; entry.aborted = !entry.ended; });
    if (target) {
      targetObserved++;
      assert.equal(heldTarget, null, `only one ${targetCaller} endpoint request may be held`);
      heldTarget = entry;
      holdEndpointMode = null;
      if (entry.phase === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.flushHeaders();
        entry.headersSent = true;
      }
      return;
    }
    return sendJson(res, endpointList);
  }
  if (url.pathname === '/api/models') return sendJson(res, { items: [
    { endpoint_id: 'fixture-a', offline: false, models: ['chat-a', 'utility-a', 'research-a'], models_metadata: {} },
  ] });
  if (url.pathname === '/api/default-chat') return sendJson(res, {});
  if (url.pathname.startsWith('/api/')) return sendJson(res, {});
  const relative = decodeURIComponent(url.pathname.replace(/^\/static\//, ''));
  const root = path.resolve(repo, 'static');
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('fixture not found');
  }
  const ext = path.extname(file);
  const type = ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' })[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
const waitFor = async (predicate, label, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}; requests=${JSON.stringify(requestLog)}; endpoint=${JSON.stringify(endpointRequests.map(r => ({ target: r.target, caller: r.caller, ended: r.ended })))}; pending=${JSON.stringify([...pendingRelevant])}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const apiIdleExceptTarget = async () => {
  await waitFor(() => {
    const pending = [...pendingRelevant];
    return heldTarget && pending.length === 1 && pending[0] === heldTarget.id && Date.now() - lastNonTargetRelevantAt >= 350;
  }, 'all unrelated initial settings/model/endpoint reads drained');
};
(async () => {
  let browser;
  let context;
  const proofCases = [];
  let targetTrace = null;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-service-worker'] });
    context = await browser.newContext();
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { externalRequests.push(url.href); return route.abort(); }
      return route.continue();
    });
    await context.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.__modelEndpointFetchTraces = [];
      window.__settingsJsonReads = [];
      window.__settingsFetchTraces = [];
      window.fetch = function(input, init) {
        const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
        const method = (init && init.method) || (input instanceof Request && input.method) || 'GET';
        const stack = new Error().stack || '';
        if (url.pathname === '/api/model-endpoints' && method === 'GET') {
          const caller = window.__fixtureTargetCaller;
          const isTargetInitializer = !!caller && stack.includes(caller) && stack.includes('settings.js');
          window.__modelEndpointFetchTraces.push({ caller: isTargetInitializer ? caller : null, stack });
          if (isTargetInitializer) {
            const headers = new Headers(init && init.headers ? init.headers : (input instanceof Request ? input.headers : undefined));
            headers.set('x-fixture-caller', caller);
            init = { ...(init || {}), headers };
          }
        }
        const caller = window.__fixtureTargetCaller;
        const isTargetSettingsRead = url.pathname === '/api/auth/settings' && method === 'GET'
          && caller && stack.includes(caller) && stack.includes('settings.js');
        if (isTargetSettingsRead) {
          window.__settingsFetchTraces.push({ caller, stack });
          const headers = new Headers(init && init.headers ? init.headers : (input instanceof Request ? input.headers : undefined));
          headers.set('x-fixture-caller', `${caller}-settings`);
          init = { ...(init || {}), headers };
        }
        const response = nativeFetch(input, init);
        if (!isTargetSettingsRead) return response;
        return response.then(res => {
          const nativeJson = res.json.bind(res);
          res.json = async function() {
            const body = await nativeJson();
            const keys = caller === 'initDefaultChat'
              ? ['default_endpoint_id', 'default_model']
              : caller === 'initUtilityModel'
                ? ['utility_endpoint_id', 'utility_model']
                : ['research_endpoint_id', 'research_model'];
            window.__settingsJsonReads.push({
              caller,
              endpoint: body[keys[0]],
              model: body[keys[1]],
            });
            return body;
          };
          return res;
        });
      };
    });
    const launchPage = async () => {
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => pageErrors.push(error.stack || error.message));
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window._isAdmin === true);
      await waitFor(() => pendingRelevant.size === 0, 'ordinary app startup reads completed');
      await page.evaluate(caller => { window.__fixtureTargetCaller = caller; }, targetCaller);
      return page;
    };
    const openAiSettings = async page => {
      await page.locator('#user-bar-settings').click();
      await page.locator('#settings-modal:not(.hidden)').waitFor({ state: 'visible' });
      await page.locator('[data-settings-tab="ai"]').click();
    };
    const resetCase = () => {
      totalPostCount += postBodies.length;
      requestLog.length = 0;
      endpointRequests.length = 0;
      pendingRelevant.clear();
      externalRequests.length = 0;
      pageErrors.length = 0;
      postBodies = [];
      targetObserved = 0;
      heldTarget = null;
      heldSettingsRead = null;
      holdSettingsRead = false;
      lastNonTargetRelevantAt = Date.now();
    };
    // Positive control: inventory starts with A, saved selections choose B.
    targetCaller = '';
    let page = await launchPage();
    await openAiSettings(page);
    await page.waitForFunction(() => document.querySelector('#set-utilityEpSelect')?.value === 'fixture-b'
      && document.querySelector('#set-utilityModelSelect')?.value === 'utility-b'
      && document.querySelector('#set-researchEndpoint')?.value === 'fixture-b'
      && document.querySelector('#set-researchModel')?.value === 'research-b');
    assert.equal(await page.locator('#set-utilityModelSelect option[data-saved-model-option="true"]').textContent(), 'utility-b (saved; not in current list)');
    assert.equal(await page.locator('#set-researchModel option[data-saved-model-option="true"]').textContent(), 'research-b (saved; not in current list)');
    await waitFor(() => pendingRelevant.size === 0, 'normal panel hydration reads completed');
    proofCases.push({ mode: 'normal-hydration', inventoryOrder: ['fixture-a', 'fixture-b'], utility: ['fixture-b', 'utility-b'], research: ['fixture-b', 'research-b'], postCount: 0 });
    assert.deepEqual(postBodies, []);
    await page.close();
    resetCase();

    const panels = {
      initDefaultChat: { endpoint: '#set-defaultEpSelect', model: '#set-defaultModelSelect', storedEndpoint: 'default_endpoint_id', storedModel: 'default_model', expectedModel: 'chat-b' },
      initUtilityModel: { endpoint: '#set-utilityEpSelect', model: '#set-utilityModelSelect', storedEndpoint: 'utility_endpoint_id', storedModel: 'utility_model', expectedModel: 'utility-b' },
      initResearchSettings: { endpoint: '#set-researchEndpoint', model: '#set-researchModel', storedEndpoint: 'research_endpoint_id', storedModel: 'research_model', expectedModel: 'research-b' },
    };

    // A late settings response must not replace a newer explicit endpoint choice.
    for (const caller of Object.keys(panels)) {
      targetCaller = caller;
      holdSettingsRead = true;
      page = await launchPage();
      await openAiSettings(page);
      await waitFor(() => heldSettingsRead, `${caller} saved settings response held`);
      const settingsTrace = await page.evaluate(target => window.__settingsFetchTraces.find(entry => entry.caller === target)?.stack || null, caller);
      assert.ok(settingsTrace && settingsTrace.includes(caller), `${caller} held settings request is stack-identified`);
      const panel = panels[caller];
      await page.locator(panel.endpoint).selectOption('fixture-a');
      if (caller === 'initDefaultChat') {
        await page.waitForFunction(() => document.querySelector('#set-defaultModelSelect').value === 'chat-a');
      }
      await waitFor(() => postBodies.length > 0, `${caller} newer selection sends its normal settings update`);
      const expectedLateSelectionPost = caller === 'initDefaultChat'
        ? { default_endpoint_id: 'fixture-a', default_model: 'chat-a' }
        : caller === 'initUtilityModel'
          ? { utility_endpoint_id: 'fixture-a', utility_model: '', utility_reasoning_effort: '' }
          : { research_endpoint_id: 'fixture-a', research_model: '' };
      assert.deepEqual(postBodies[0], expectedLateSelectionPost, `${caller} keeps its existing sparse user-save payload`);
      heldSettingsRead.res.end(JSON.stringify(settings));
      await page.waitForFunction(target => window.__settingsJsonReads.some(entry => entry.caller === target), caller);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const afterLateSettings = await page.evaluate(({ endpoint, model }) => ({
        endpoint: document.querySelector(endpoint).value,
        model: document.querySelector(model).value,
      }), panel);
      assert.equal(afterLateSettings.endpoint, 'fixture-a', `${caller} newer endpoint choice survives late settings`);
      if (caller === 'initDefaultChat') assert.equal(afterLateSettings.model, 'chat-a');
      proofCases.push({ mode: `${caller}-late-settings-newer-edit`, selected: afterLateSettings, posts: postBodies.length, targetTrace: settingsTrace.split('\n').filter(line => line.includes('settings.js')).slice(0, 5) });
      assert.deepEqual(externalRequests, []);
      assert.deepEqual(pageErrors, []);
      await page.close();
      resetCase();
    }

    // One stack-identified initial request per panel: hold headers and body in turn,
    // let the native 15-second deadline abort, then prove explicit refresh restores B.
    for (const caller of Object.keys(panels)) {
      for (const phase of ['headers', 'body']) {
        targetCaller = caller;
        holdEndpointMode = phase;
        page = await launchPage();
        await page.clock.install();
        const moduleRequestsBefore = requestLog.filter(item => item.startsWith('GET /static/js/settings.js')).length;
        await openAiSettings(page);
        await waitFor(() => heldTarget && heldTarget.phase === phase, `${caller} initial endpoint ${phase} held`);
        await page.waitForFunction(() => window.__modelEndpointFetchTraces.some(entry => entry.caller === window.__fixtureTargetCaller));
        await apiIdleExceptTarget();
        assert.equal(targetObserved, 1, `exactly one direct ${caller} request is held`);
        const initialRequest = heldTarget;
        targetTrace = await page.evaluate(target => window.__modelEndpointFetchTraces.find(entry => entry.caller === target)?.stack || null, caller);
        assert.ok(targetTrace && targetTrace.includes(caller), `${caller} held inventory request is stack-identified`);
        const panel = panels[caller];
        const beforeTimeout = await page.evaluate(({ endpoint, model }) => ({
          endpoint: document.querySelector(endpoint).value,
          model: document.querySelector(model).value,
        }), panel);
        assert.deepEqual(beforeTimeout, { endpoint: '', model: '' }, `${caller} is waiting only on its own inventory`);
        assert.ok(endpointRequests.filter(item => !item.target).every(item => item.ended), 'all unrelated endpoint calls completed');
        await page.clock.fastForward(15000);
        await waitFor(() => initialRequest.closed, `${caller} ${phase} request aborts at deadline`);
        assert.equal(initialRequest.aborted, true);
        await waitFor(() => pendingRelevant.size === 0, `${caller} reads settle after abort`);
        await page.waitForFunction(target => window.__settingsJsonReads.some(entry => entry.caller === target), caller);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const beforeExplicitRefresh = await page.evaluate(({ endpoint, model, storedEndpoint, storedModel }) => ({
          endpoint: document.querySelector(endpoint).value,
          model: document.querySelector(model).value,
          storedEndpoint: window.__settingsJsonReads.find(entry => entry.caller === window.__fixtureTargetCaller)?.endpoint,
          storedModel: window.__settingsJsonReads.find(entry => entry.caller === window.__fixtureTargetCaller)?.model,
        }), panel);
        assert.equal(beforeExplicitRefresh.storedEndpoint, 'fixture-b');
        assert.equal(beforeExplicitRefresh.storedModel, panel.expectedModel);
        const fixtureB = endpointList.find(endpoint => endpoint.id === 'fixture-b');
        fixtureB.is_enabled = false;
        const disabledRefreshStart = endpointRequests.length;
        await page.evaluate(async () => {
          const module = await import('/static/js/settings.js');
          await module.refreshAiModelEndpoints();
        });
        await waitFor(() => endpointRequests.slice(disabledRefreshStart).some(item => item.ended), `${caller} refresh with disabled saved endpoint completes`);
        let afterExplicitRefresh = await page.evaluate(({ endpoint, model }) => ({
          endpoint: document.querySelector(endpoint).value,
          model: document.querySelector(model).value,
          availableEndpoints: Array.from(document.querySelector(endpoint).options).map(option => option.value),
        }), panel);
        const disabledSelection = caller === 'initDefaultChat'
          ? { endpoint: 'fixture-a', model: 'chat-a' }
          : { endpoint: '', model: '' };
        assert.deepEqual({ endpoint: afterExplicitRefresh.endpoint, model: afterExplicitRefresh.model }, disabledSelection, `${caller} does not adopt a disabled saved endpoint`);
        fixtureB.is_enabled = true;
        const refreshStart = endpointRequests.length;
        await page.evaluate(async () => {
          const module = await import('/static/js/settings.js');
          await module.refreshAiModelEndpoints();
        });
        await waitFor(() => endpointRequests.slice(refreshStart).some(item => item.ended), `${caller} later explicit refresh completes`);
        afterExplicitRefresh = await page.evaluate(({ endpoint, model }) => ({
          endpoint: document.querySelector(endpoint).value,
          model: document.querySelector(model).value,
          availableEndpoints: Array.from(document.querySelector(endpoint).options).map(option => option.value),
        }), panel);
        assert.equal(afterExplicitRefresh.endpoint, 'fixture-b', `${caller} restores persisted B endpoint`);
        assert.equal(afterExplicitRefresh.model, panel.expectedModel, `${caller} restores persisted B model`);
        if (caller === 'initUtilityModel' || caller === 'initResearchSettings') {
          const savedOption = await page.locator(`${panel.model} option[data-saved-model-option="true"]`).textContent();
          assert.equal(savedOption, `${panel.expectedModel} (saved; not in current list)`);
        }
        assert.deepEqual(postBodies, [], 'deadline and refresh recovery do not save settings');

        // A subsequent explicit selection of A owns later refreshes.
        const postsBeforeNewerSelection = postBodies.length;
        await page.locator(panel.endpoint).selectOption('fixture-a');
        await waitFor(() => postBodies.length > 0, `${caller} explicit newer A selection is saved normally`);
        const secondRefreshStart = endpointRequests.length;
        await page.evaluate(async () => {
          const module = await import('/static/js/settings.js');
          await module.refreshAiModelEndpoints();
        });
        await waitFor(() => endpointRequests.slice(secondRefreshStart).some(item => item.ended), `${caller} later refresh after A selection completes`);
        afterExplicitRefresh = await page.evaluate(({ endpoint, model }) => ({
          endpoint: document.querySelector(endpoint).value,
          model: document.querySelector(model).value,
        }), panel);
        assert.equal(afterExplicitRefresh.endpoint, 'fixture-a', `${caller} newer A selection wins over saved B`);
        const trace = await page.evaluate(target => window.__modelEndpointFetchTraces.find(entry => entry.caller === target)?.stack || null, caller);
        assert.ok(trace && trace.includes(caller), `held request stack identifies ${caller}`);
        assert.equal(requestLog.filter(item => item.startsWith('GET /static/js/settings.js')).length, moduleRequestsBefore, 'no duplicate module URL was imported');
        assert.equal(requestLog.filter(item => item.startsWith('GET /static/js/settings.js?')).length, 0);
        proofCases.push({
          mode: `${caller}-${phase}-deadline-recovery`, targetRequestAborted: initialRequest.aborted,
          beforeTimeout, beforeExplicitRefresh, disabledRefresh: disabledSelection, recovered: { endpoint: 'fixture-b', model: panel.expectedModel },
          explicitNewerSelection: afterExplicitRefresh, postsForExplicitSelection: postBodies.length - postsBeforeNewerSelection,
          completedUnrelatedEndpointRequests: endpointRequests.filter(item => !item.target && item.ended).length,
          targetTrace: targetTrace.split('\n').filter(line => line.includes('settings.js')).slice(0, 5),
        });
        assert.deepEqual(externalRequests, []);
        assert.deepEqual(pageErrors, []);
        await page.close();
        resetCase();
      }
    }
    console.log(JSON.stringify({
      pass: true,
      sourceHashes,
      cases: proofCases,
      targetTrace: targetTrace && targetTrace.split('\n').filter(line => line.includes('settings.js')).slice(0, 8),
      postCount: totalPostCount + postBodies.length,
      externalRequests,
      pageErrors,
      cleanup: 'browser/server closed in finally',
    }, null, 2));
  } finally {
    if (heldTarget && !heldTarget.res.writableEnded && !heldTarget.res.destroyed) heldTarget.res.end(JSON.stringify(endpointList));
    if (heldSettingsRead && !heldSettingsRead.res.writableEnded && !heldSettingsRead.res.destroyed) heldSettingsRead.res.end(JSON.stringify(settings));
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
