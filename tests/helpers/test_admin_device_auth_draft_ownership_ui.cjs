const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><style>.hidden{display:none}</style><body>
<div id="adm-provider-picker"><button id="adm-provider-btn"><span class="adm-provider-current"><span class="adm-provider-logo"></span><span class="adm-provider-name"></span></span></button><div id="adm-provider-menu" class="hidden"></div></div>
<select id="adm-epProvider" style="display:none">
<option value="">Custom URL</option><option value="copilot" data-logo="github" data-auth-flow="copilot">Copilot</option>
<option value="chatgpt-subscription" data-logo="openai" data-auth-flow="chatgpt-subscription">ChatGPT Subscription</option>
</select>
<input id="adm-epUrl"><input id="adm-epApiKey"><select id="adm-epKind"><option value="api">API</option><option value="proxy">Proxy</option></select>
<select id="adm-epType"><option value="llm">LLM</option><option value="image">Image</option></select>
<button id="adm-epApiTestBtn">Test</button><button id="adm-epCancelTestBtn">Cancel</button><button id="adm-epAddBtn">Add</button>
<div id="adm-epApiMsg"></div><div id="adm-deviceAuthStatus"></div>
<div id="adm-epList-local"></div><div id="adm-epList-api"></div>
<script>window.__selected=[];document.addEventListener('odysseus:auto-select-model',e=>window.__selected.push(e.detail));</script>
<script type="module">import '/static/js/admin.js';window.fixtureReady=true;</script></body>`;
let pollCount = 0, pollResponses = 0, releaseRequests = 0, releaseFound = false, lastReleaseId = null;
let endpointLoads = 0, holdNextEndpointLoad = false;
let failNextPoll = false;
const startPaths = [];
const pendingPolls = new Map();
const pendingEndpointLoads = new Map();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/') { res.setHeader('Content-Type','text/html'); return res.end(html); }
  if (u.pathname === '/__state') { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({pending:[...pendingPolls.keys()],pendingEndpointLoads:[...pendingEndpointLoads.keys()],endpointLoads,pollCount,pollResponses,releaseRequests,releaseFound,lastReleaseId,startPaths})); }
  if (u.pathname === '/__fail-next-poll') { failNextPoll = true; res.writeHead(204); return res.end(); }
  if (u.pathname === '/__hold-endpoint-load') { holdNextEndpointLoad = true; res.writeHead(204); return res.end(); }
  if (u.pathname === '/__release') {
    releaseRequests++;
    const id = Number(u.searchParams.get('id'));
    lastReleaseId = id;
    const release = pendingPolls.get(id);
    if (release) { releaseFound=true; pendingPolls.delete(id); pollResponses++; release(); }
    else { res.writeHead(409); return res.end('poll not held'); }
    res.writeHead(204); return res.end();
  }
  if (u.pathname === '/api/copilot/device/start' || u.pathname === '/api/chatgpt-subscription/device/start') {
    startPaths.push(u.pathname);
    res.setHeader('Content-Type','application/json');
    return res.end(JSON.stringify({poll_id:`synthetic-poll-${pollCount + 1}`,interval:2,expires_in:120,verification_uri:'/synthetic-verify'}));
  }
  if (u.pathname === '/api/copilot/device/poll' || u.pathname === '/api/chatgpt-subscription/device/poll') {
    const id = ++pollCount;
    const shouldFail = failNextPoll;
    failNextPoll = false;
    pendingPolls.set(id, () => {
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(shouldFail ? {status:'failed',error:'synthetic-denied'} : {status:'authorized',endpoint:{id:`synthetic-endpoint-${id}`,name:'Synthetic endpoint',base_url:'http://127.0.0.1/synthetic',models:[`synthetic-model-${id}`]}}));
    });
    return;
  }
  if (u.pathname === '/api/model-endpoints' && req.method === 'GET') {
    const id = ++endpointLoads;
    const send = () => { res.setHeader('Content-Type','application/json'); res.end('[]'); };
    if (holdNextEndpointLoad) { holdNextEndpointLoad = false; pendingEndpointLoads.set(id, send); return; }
    return send();
  }
  if (u.pathname === '/__release-endpoint-load') { pendingEndpointLoads.get(Number(u.searchParams.get('id')))?.(); pendingEndpointLoads.delete(Number(u.searchParams.get('id'))); res.writeHead(204); return res.end(); }
  const file = path.resolve(repo, `.${u.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'text/plain');
  if (u.pathname === '/static/js/admin.js') {
    const source = fs.readFileSync(file, 'utf8');
    const marker = '/* ═══════════════════════════════════════════\n   PUBLIC API';
    assert(source.includes(marker), 'production module export insertion marker exists');
    return res.end(source.replace(marker, 'window.__testInitEndpointForm = initEndpointForm;\n' + marker));
  }
  if (u.pathname === '/static/js/settings.js') return res.end('export default { refreshAiModelEndpoints() {}, initIntegrations() {}, open() {}, close() {} };');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  let browser;
  let loopbackOnly = true;
  const pageErrors = [];
  const requestedPaths = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args:['--no-sandbox','--disable-gpu']});
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) {
        loopbackOnly = false; return route.abort();
      }
      return route.continue();
    });
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('request', r => { try { requestedPaths.push(new URL(r.url()).pathname); } catch (_) {} });
    await page.goto(origin);
    await page.waitForFunction(() => window.fixtureReady && window.__testInitEndpointForm);
    await page.evaluate(() => window.__testInitEndpointForm());
    const choose = async value => {
      await page.locator('#adm-provider-btn').click();
      await page.locator(`#adm-provider-menu .adm-provider-item[data-value="${value}"]`).click();
    };
    const waitPending = async id => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const state = await (await fetch(`${origin}/__state`)).json();
        if (state.pending.includes(id)) return state;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`poll ${id} was not held by loopback server`);
    };
    const release = async id => page.evaluate(id => fetch(`/__release?id=${id}`), id);
    const startFlow = async (provider, pollId) => {
      await choose(provider);
      await page.locator('#adm-epAddBtn').click();
      const state = await waitPending(pollId);
      assert(state.pending.includes(pollId), `poll ${pollId} is actually held before release: ${JSON.stringify(state)}`);
    };
    const waitCompleted = async id => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const state = await page.evaluate(() => ({connected:document.querySelector('#adm-deviceAuthStatus').textContent.includes('Connected Synthetic endpoint'),addEnabled:!document.querySelector('#adm-epAddBtn').disabled}));
        if (state.connected && state.addEnabled) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`synthetic auth completion not visible for ${id}`);
    };
    const finishFlow = async id => {
      await release(id);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const state = await page.evaluate(() => ({connected:document.querySelector('#adm-deviceAuthStatus').textContent.includes('Connected Synthetic endpoint'),selected:window.__selected.map(x=>x.endpointId)}));
        if (state.connected && state.selected.includes(`synthetic-endpoint-${id}`)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`synthetic auth completion not visible for ${id}`);
    };

    // Copilot response arrives after the live picker moved to ChatGPT and a new label was typed.
    await startFlow('copilot', 1);
    await choose('chatgpt-subscription');
    await page.locator('#adm-epUrl').fill('new-chatgpt-label');
    await release(1);
    await waitCompleted(1);
    const switched = await page.evaluate(() => ({provider:document.querySelector('#adm-epProvider').value,label:document.querySelector('#adm-epUrl').value,selected:window.__selected.map(x=>x.endpointId)}));
    assert.equal(switched.provider, 'chatgpt-subscription');
    assert.equal(switched.label, 'new-chatgpt-label', 'cross-provider response preserves the newer label');
    assert.deepEqual(switched.selected, [], 'cross-provider response does not auto-select its endpoint');

    // A current ChatGPT authorization retains its existing successful behavior: clear its submitted label and select its endpoint.
    await page.evaluate(() => { window.__selected.length = 0; });
    await page.locator('#adm-epUrl').fill('current-chatgpt-label');
    await page.locator('#adm-epAddBtn').click();
    await waitPending(2);
    await finishFlow(2);
    const current = await page.evaluate(() => ({label:document.querySelector('#adm-epUrl').value,selected:window.__selected.map(x=>x.endpointId)}));
    assert.equal(current.label, '');
    assert.deepEqual(current.selected, ['synthetic-endpoint-2']);

    // Same provider is not enough: a newer ChatGPT label typed during polling must remain owned by the user.
    await page.evaluate(() => { window.__selected.length = 0; });
    await page.locator('#adm-epUrl').fill('submitted-chatgpt-label');
    await page.locator('#adm-epAddBtn').click();
    await waitPending(3);
    await page.locator('#adm-epUrl').fill('newer-chatgpt-label');
    await release(3);
    await waitCompleted(3);
    const sameProviderEdit = await page.evaluate(() => ({label:document.querySelector('#adm-epUrl').value,selected:window.__selected.map(x=>x.endpointId)}));
    assert.equal(sameProviderEdit.label, 'newer-chatgpt-label', 'same-provider response preserves the newer label');
    assert.deepEqual(sameProviderEdit.selected, []);

    // A form edit while the authorized endpoint refresh is held also blocks selection/clearing.
    await page.locator('#adm-epUrl').fill('submitted-during-load-label');
    await page.evaluate(() => fetch('/__hold-endpoint-load'));
    await page.locator('#adm-epAddBtn').click();
    await waitPending(4);
    const beforeLoad = await (await fetch(`${origin}/__state`)).json();
    await release(4);
    const loadDeadline = Date.now() + 8000;
    let loadId;
    while (Date.now() < loadDeadline) {
      const state = await (await fetch(`${origin}/__state`)).json();
      if (state.pendingEndpointLoads.length) { loadId = state.pendingEndpointLoads[0]; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(loadId, 'authorized endpoint refresh entered and is held');
    await page.locator('#adm-epUrl').fill('edited-during-endpoint-load');
    await page.evaluate(id => fetch(`/__release-endpoint-load?id=${id}`), loadId);
    await waitCompleted(4);
    const duringLoad = await page.evaluate(() => ({label:document.querySelector('#adm-epUrl').value,selected:window.__selected.map(x=>x.endpointId)}));
    assert.deepEqual(duringLoad, {label:'edited-during-endpoint-load',selected:[]});
    const afterLoad = await (await fetch(`${origin}/__state`)).json();
    assert(afterLoad.endpointLoads > beforeLoad.endpointLoads, 'authorized success always refreshes endpoints');

    // A draft edit while the shared model refresh is held blocks auto-select.
    await page.locator('#adm-epUrl').fill('submitted-during-model-refresh');
    await page.evaluate(() => {
      window.modelsModule = { refreshModels(_force, options) {
        if (options && options.cacheOnly) return Promise.resolve();
        return new Promise(resolve => { window.__releaseModelRefresh = resolve; });
      }};
    });
    await page.locator('#adm-epAddBtn').click();
    await waitPending(5);
    await release(5);
    await page.waitForFunction(() => typeof window.__releaseModelRefresh === 'function');
    await page.locator('#adm-epUrl').fill('edited-during-model-refresh');
    await page.evaluate(() => window.__releaseModelRefresh());
    await waitCompleted(5);
    const duringModelRefresh = await page.evaluate(() => ({label:document.querySelector('#adm-epUrl').value,selected:window.__selected.map(x=>x.endpointId)}));
    assert.deepEqual(duringModelRefresh, {label:'edited-during-model-refresh',selected:[]});
    await page.evaluate(() => { window.modelsModule = undefined; });

    // An old Copilot failure after a provider switch must not expose a Copilot retry under ChatGPT.
    await choose('copilot');
    await page.evaluate(() => fetch('/__fail-next-poll'));
    await page.locator('#adm-epAddBtn').click();
    await waitPending(6);
    await choose('chatgpt-subscription');
    await page.locator('#adm-epUrl').fill('failure-after-switch-label');
    await release(6);
    await page.waitForFunction(() => document.querySelector('#adm-deviceAuthStatus').textContent.includes('Provider changed. Select Add'));
    const staleFailure = await page.evaluate(() => ({
      text:document.querySelector('#adm-deviceAuthStatus').textContent,
      retry:!!document.querySelector('#adm-deviceAuthStatus button'),
      provider:document.querySelector('#adm-epProvider').value,
      label:document.querySelector('#adm-epUrl').value,
    }));
    assert.match(staleFailure.text, /GitHub Copilot/);
    assert.equal(staleFailure.retry, false);
    assert.equal(staleFailure.provider, 'chatgpt-subscription');
    assert.equal(staleFailure.label, 'failure-after-switch-label');

    // If the picker changes after retry is rendered, clicking the stale button removes it and starts no flow.
    await choose('copilot');
    await page.evaluate(() => fetch('/__fail-next-poll'));
    await page.locator('#adm-epAddBtn').click();
    await waitPending(7);
    await release(7);
    await page.getByRole('button', {name:'Try again', exact:true}).waitFor();
    const routesBeforeStaleRetry = (await (await fetch(`${origin}/__state`)).json()).startPaths.length;
    await choose('chatgpt-subscription');
    await page.locator('#adm-epUrl').fill('changed-before-stale-retry-label');
    await page.getByRole('button', {name:'Try again', exact:true}).click();
    await page.waitForFunction(() => !document.querySelector('#adm-deviceAuthStatus button') && document.querySelector('#adm-deviceAuthStatus').textContent.includes('Provider changed. Select Add'));
    const staleRetryState = await page.evaluate(() => ({text:document.querySelector('#adm-deviceAuthStatus').textContent, retry:!!document.querySelector('#adm-deviceAuthStatus button')}));
    const routesAfterStaleRetry = (await (await fetch(`${origin}/__state`)).json()).startPaths.length;
    assert.equal(routesAfterStaleRetry, routesBeforeStaleRetry);
    assert.equal(await page.locator('#adm-epProvider').inputValue(), 'chatgpt-subscription');
    assert.equal(await page.locator('#adm-epUrl').inputValue(), 'changed-before-stale-retry-label');

    // Same-provider retry keeps its normal behavior and can complete successfully.
    await choose('copilot');
    await page.evaluate(() => fetch('/__fail-next-poll'));
    await page.locator('#adm-epAddBtn').click();
    await waitPending(8);
    await release(8);
    await page.getByRole('button', {name:'Try again', exact:true}).waitFor();
    await page.getByRole('button', {name:'Try again', exact:true}).click();
    await waitPending(9);
    await release(9);
    await waitCompleted(9);
    const sameProviderRetry = await page.evaluate(() => ({
      text:document.querySelector('#adm-deviceAuthStatus').textContent,
      starts:window.__selected.map(x=>x.endpointId),
      paths:document.querySelector('#adm-epProvider').value,
    }));
    assert.match(sameProviderRetry.text, /Connected Synthetic endpoint/);
    assert.equal(sameProviderRetry.paths, 'copilot');

    // Replaced controls belong to the new form even while the old request completes.
    await page.evaluate(() => { window.__selected.length = 0; });
    await choose('chatgpt-subscription');
    await page.locator('#adm-epUrl').fill('replace-this-label');
    await page.locator('#adm-epAddBtn').click();
    await waitPending(10);
    await page.evaluate(() => {
      for (const [id, value] of [['adm-epUrl','replacement-label'],['adm-epApiKey','replacement-key'],['adm-epKind','proxy'],['adm-epType','image']]) {
        const old = document.getElementById(id), fresh = old.cloneNode(true);
        fresh.value = value; old.replaceWith(fresh);
      }
    });
    await release(10);
    await waitCompleted(10);
    const replaced = await page.evaluate(() => ({label:document.querySelector('#adm-epUrl').value,key:document.querySelector('#adm-epApiKey').value,kind:document.querySelector('#adm-epKind').value,type:document.querySelector('#adm-epType').value,selected:window.__selected.map(x=>x.endpointId)}));
    assert.deepEqual(replaced, {label:'replacement-label',key:'replacement-key',kind:'proxy',type:'image',selected:[]});

    // Replacing the provider control invalidates an old retry even if its old node still says Copilot.
    await page.goto(origin);
    await page.waitForFunction(() => window.fixtureReady && window.__testInitEndpointForm);
    await page.evaluate(() => window.__testInitEndpointForm());
    await choose('copilot');
    await page.evaluate(() => fetch('/__fail-next-poll'));
    await page.locator('#adm-epAddBtn').click();
    await waitPending(11);
    await release(11);
    await page.getByRole('button', {name:'Try again', exact:true}).waitFor();
    const routesBeforeReplacementRetry = (await (await fetch(`${origin}/__state`)).json()).startPaths.length;
    await page.evaluate(() => {
      const old = document.querySelector('#adm-epProvider');
      const replacement = old.cloneNode(true);
      replacement.value = 'copilot';
      old.replaceWith(replacement);
    });
    await page.getByRole('button', {name:'Try again', exact:true}).click();
    await page.waitForFunction(() => !document.querySelector('#adm-deviceAuthStatus button') && document.querySelector('#adm-deviceAuthStatus').textContent.includes('Provider changed. Select Add'));
    const replacementRetryRoutes = (await (await fetch(`${origin}/__state`)).json()).startPaths.length;
    const replacementRetryGuidance = await page.locator('#adm-deviceAuthStatus').textContent();
    assert.equal(replacementRetryRoutes, routesBeforeReplacementRetry);
    assert.match(replacementRetryGuidance, /Provider changed. Select Add/);

    assert.equal(loopbackOnly, true);
    assert.deepEqual(pageErrors, []);
    process.stdout.write(JSON.stringify({
      crossProviderNewLabelPreserved: switched.label === 'new-chatgpt-label',
      staleCopilotEndpointNotSelected: switched.selected.length === 0,
      currentFlowControlStillClearsAndSelects: current.label === '' && current.selected[0] === 'synthetic-endpoint-2',
      sameProviderEditedLabelPreserved: sameProviderEdit.label === 'newer-chatgpt-label',
      replacementControlsPreserved: replaced.label === 'replacement-label' && replaced.key === 'replacement-key' && replaced.kind === 'proxy' && replaced.type === 'image',
      changedDuringLoadPreserved: duringLoad.label === 'edited-during-endpoint-load' && duringLoad.selected.length === 0,
      changedDuringModelRefreshPreserved: duringModelRefresh.label === 'edited-during-model-refresh' && duringModelRefresh.selected.length === 0,
      endpointRefreshStillRan: afterLoad.endpointLoads > beforeLoad.endpointLoads,
      staleFailureShowsNoWrongProviderRetry: !staleFailure.retry && staleFailure.text.includes('GitHub Copilot') && staleFailure.text.includes('Provider changed. Select Add'),
      staleRenderedRetryStartsNoWrongProvider: routesAfterStaleRetry === routesBeforeStaleRetry && !staleRetryState.retry && staleRetryState.text.includes('Provider changed. Select Add'),
      sameProviderRetryStillWorks: sameProviderRetry.text.includes('Connected Synthetic endpoint') && sameProviderRetry.paths === 'copilot',
      replacedProviderControlBlocksStaleRetry: replacementRetryRoutes === routesBeforeReplacementRetry && replacementRetryGuidance.includes('Provider changed. Select Add'),
      loopbackOnly, pageErrors: pageErrors.length,
    }) + '\n');
  } finally {
    try { if (browser) await browser.close(); }
    finally {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
