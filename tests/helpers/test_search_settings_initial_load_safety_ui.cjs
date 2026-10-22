// Exercise Search settings loading and writes through the actual application UI.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
const sourceHashes = {};
for (const file of ['static/index.html', 'static/js/settings.js']) {
  sourceHashes[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex');
}

const savedSettings = {
  default_endpoint_id: 'fixture-a', default_model: 'chat-a',
  utility_endpoint_id: 'fixture-a', utility_model: 'utility-a', utility_model_fallbacks: [],
  vision_enabled: true, vision_model: 'vision-a', vision_model_fallbacks: [],
  research_endpoint_id: 'fixture-a', research_model: 'research-a',
  research_max_tokens: 4096, research_extraction_timeout_seconds: 90,
  research_extraction_concurrency: 3, research_run_timeout_seconds: 3600,
  search_provider: 'searxng', search_fallback_chain: ['duckduckgo', 'brave'],
  search_result_count: 5, tts_provider: 'disabled', stt_provider: 'disabled',
};
const endpoints = [{ id: 'fixture-a', name: 'Fixture A', is_enabled: true, online: true,
  models: ['chat-a', 'utility-a', 'vision-a', 'research-a'], model_type: 'chat' }];
const models = { items: [{ endpoint_id: 'fixture-a', offline: false,
  models: ['chat-a', 'utility-a', 'vision-a', 'research-a'], models_metadata: {} }] };

let mode = 'normal';
let serverSettings;
let settingsReads;
let pendingInitial;
let pendingRefresh;
let refreshCount;
let posts;
let searchQueries;
let externalRequests = [];
let pageErrors = [];

function reset(nextMode, chain) {
  mode = nextMode;
  serverSettings = structuredClone(savedSettings);
  if (chain === 'missing') delete serverSettings.search_fallback_chain;
  else serverSettings.search_fallback_chain = structuredClone(chain);
  settingsReads = [];
  pendingInitial = null;
  pendingRefresh = null;
  refreshCount = 0;
  posts = [];
  searchQueries = [];
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(staticRoot, 'index.html'), 'utf8').replaceAll('{{CSP_NONCE}}', 'fixture-nonce'));
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'GET') {
    const caller = req.headers['x-fixture-caller'] || 'unattributed';
    const entry = { caller, status: null, ended: false, closed: false, snapshot: structuredClone(serverSettings) };
    settingsReads.push(entry);
    res.on('close', () => { entry.closed = true; });
    if (caller === 'search-init') {
      if (mode === 'headers-timeout') { pendingInitial = res; return; }
      if (mode === 'body-timeout') {
        entry.status = 200;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        pendingInitial = res;
        return;
      }
      if (mode === 'read-503') { entry.status = 503; entry.ended = true; return sendJson(res, { detail: 'synthetic load failure' }, 503); }
      if (mode === 'malformed-json') { entry.status = 200; entry.ended = true; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{'); }
      if (mode === 'null-settings') { entry.status = 200; entry.ended = true; return sendJson(res, null); }
      if (mode === 'array-settings') { entry.status = 200; entry.ended = true; return sendJson(res, []); }
      if (mode === 'invalid-chain') { entry.status = 200; entry.ended = true; return sendJson(res, { ...entry.snapshot, search_fallback_chain: 'duckduckgo' }); }
    }
    if (caller === 'search-refresh') {
      refreshCount += 1;
      if (mode === 'refresh-failure' && refreshCount > 1) {
        entry.status = 503; entry.ended = true; return sendJson(res, { detail: 'synthetic refresh failure' }, 503);
      }
      if (mode === 'hold-refresh' && refreshCount === 1) {
        entry.status = 200;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        pendingRefresh = { res, entry };
        return;
      }
    }
    entry.status = 200;
    entry.ended = true;
    return sendJson(res, entry.snapshot);
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      posts.push(parsed);
      Object.assign(serverSettings, parsed);
      sendJson(res, { ok: true });
    });
    return;
  }
  if (url.pathname === '/api/search/query' && req.method === 'POST') {
    searchQueries.push(true);
    return sendJson(res, { results: [{ title: 'Synthetic result', url: 'http://fixture.invalid/' }] });
  }
  if (url.pathname === '/api/auth/status') return sendJson(res, { username: 'synthetic', is_admin: true, privileges: {} });
  if (url.pathname === '/api/auth/features') return sendJson(res, {});
  if (url.pathname === '/api/model-endpoints') return sendJson(res, endpoints);
  if (url.pathname === '/api/models') return sendJson(res, models);
  if (url.pathname === '/api/sessions') return sendJson(res, []);
  if (url.pathname === '/api/presets') return sendJson(res, { custom_revision: 0, custom_save_revision_guard: false, custom_template_autosave: false, presets: [] });
  if (url.pathname === '/api/presets/templates') return sendJson(res, []);
  if (url.pathname === '/api/usage') return sendJson(res, { days: 7, start_date: '2026-10-01', end_date: '2026-10-07', totals: {}, daily: [], models: [], recent_sessions: [], insights: {} });
  if (url.pathname === '/api/default-chat') return sendJson(res, {});
  if (url.pathname.startsWith('/api/')) return sendJson(res, {});

  const relative = decodeURIComponent(url.pathname.replace(/^\/static\//, ''));
  const file = path.resolve(staticRoot, relative);
  if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('fixture not found');
  }
  const ext = path.extname(file);
  const mime = ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' })[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

async function waitPage(page, predicate, label) {
  await page.waitForFunction(predicate, null, { timeout: 15000 }).catch(error => {
    throw new Error(`Timed out waiting for ${label}: ${error.message}`);
  });
}
async function waitNode(predicate, label) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 15000) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function openSearch(browser, origin, virtualClock = false) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const nativeJson = Response.prototype.json;
    const callerByResponse = new WeakMap();
    window.__settingsFetches = [];
    Response.prototype.json = function() {
      const entry = callerByResponse.get(this);
      if (!entry) return nativeJson.apply(this, arguments);
      entry.jsonState = 'pending';
      return nativeJson.apply(this, arguments).then(value => {
        entry.jsonState = 'done'; return value;
      }, error => { entry.jsonState = 'failed'; throw error; });
    };
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/auth/settings') && (!init || !init.method || init.method === 'GET')) {
        const stack = new Error().stack || '';
        const caller = stack.includes('at refreshStatus (') ? 'search-refresh'
          : stack.includes('at initSearchSettings (') ? 'search-init'
          : ['initUtilityModel', 'initVisionSettings', 'initResearchSettings', 'initResearchSearchSettings']
            .find(name => stack.includes(`at ${name} (`)) || 'other';
        const entry = { caller, status: null, fetchState: 'pending', jsonState: 'unused', signal: init && init.signal };
        window.__settingsFetches.push(entry);
        const headers = new Headers(init && init.headers || {});
        headers.set('X-Fixture-Caller', caller);
        return nativeFetch(input, { ...(init || {}), headers }).then(response => {
          entry.status = response.status;
          entry.fetchState = 'complete';
          callerByResponse.set(response, entry);
          return response;
        }, error => { entry.fetchState = 'failed'; throw error; });
      }
      return nativeFetch(input, init);
    };
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { externalRequests.push(url.href); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  if (virtualClock) await page.clock.install();
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window._isAdmin === true);
  await page.locator('#user-bar-settings').click();
  await page.locator('#settings-modal:not(.hidden)').waitFor({ state: 'attached' });
  await page.locator('[data-settings-tab="search"]').click();
  return { page, context };
}

async function assertDisabledAndInert(page) {
  const ids = ['search-provider-btn', 'set-searchProvider', 'set-searchResultCount',
    'set-searchResultCountCustom', 'set-searchUrl', 'set-searchApiKey', 'set-searchCx',
    'set-searchAddFallback', 'set-searchTestBtn'];
  for (const id of ids) assert.equal(await page.locator('#' + id).isDisabled(), true, `${id} remains disabled until a valid settings snapshot`);
  await page.evaluate(() => {
    const fire = (id, eventName) => document.getElementById(id).dispatchEvent(new Event(eventName, { bubbles: true }));
    fire('set-searchProvider', 'change');
    fire('set-searchResultCount', 'change');
    fire('set-searchUrl', 'change');
    fire('set-searchApiKey', 'change');
    fire('set-searchCx', 'change');
    fire('search-provider-btn', 'click');
    fire('set-searchAddFallback', 'click');
    fire('set-searchTestBtn', 'click');
  });
}

async function closePage(context) { await context.close(); }

(async () => {
  let browser;
  const result = { pass: false, source_hashes: sourceHashes, cases: {}, external_requests: externalRequests, page_errors: pageErrors };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-service-worker'] });

    for (const scenario of ['headers-timeout', 'body-timeout']) {
      reset(scenario, ['duckduckgo', 'brave']);
      const { page, context } = await openSearch(browser, origin, true);
      try {
        await waitNode(() => pendingInitial, `${scenario} request held`);
        const before = await page.locator('#set-searchMsg').textContent();
        assert.equal(before.trim(), 'Loading saved Search settings…');
        await assertDisabledAndInert(page);
        assert.equal(posts.length, 0);
        assert.equal(searchQueries.length, 0);
        await page.clock.fastForward(15000);
        await waitPage(page, () => document.querySelector('#set-searchMsg')?.textContent.includes('Reload the page before changing them.'), `${scenario} load failure message`);
        await waitNode(() => settingsReads.find(entry => entry.caller === 'search-init')?.closed, `${scenario} request aborted`);
        await assertDisabledAndInert(page);
        assert.equal(posts.length, 0);
        assert.equal(searchQueries.length, 0);
        const initial = await page.evaluate(() => ({
          signalAborted: window.__settingsFetches.find(entry => entry.caller === 'search-init').signal.aborted,
        }));
        assert.equal(initial.signalAborted, true);
        result.cases[scenario] = { aborted: true, controls_disabled: true, no_posts: true, no_search_query: true };
      } finally { await closePage(context); }
    }

    reset('hold-refresh', ['duckduckgo']);
    const stale = await openSearch(browser, origin);
    try {
      await waitNode(() => pendingRefresh, 'initial successful refresh held after headers');
      await stale.page.clock.install();
      await stale.page.locator('#set-searchAddFallback').click();
      await waitNode(() => posts.length === 1, 'newer Add fallback POST accepted');
      await waitPage(stale.page, () => Array.from(document.querySelectorAll('.settings-fallback-row select')).map(select => select.value).join(',') === 'duckduckgo,brave', 'newer Add fallback rendered');
      assert.deepEqual(posts[0].search_fallback_chain, ['duckduckgo', 'brave']);
      assert.deepEqual(serverSettings.search_fallback_chain, ['duckduckgo', 'brave']);
      const visibleAfterAdd = await stale.page.locator('.settings-fallback-row select').evaluateAll(selects => selects.map(select => select.value));
      const heldSnapshot = pendingRefresh.entry.snapshot.search_fallback_chain.slice();
      pendingRefresh.entry.ended = true;
      pendingRefresh.res.end(JSON.stringify(pendingRefresh.entry.snapshot));
      await waitPage(stale.page, () => window.__settingsFetches.some(entry => entry.caller === 'search-refresh' && entry.jsonState === 'done'), 'stale successful refresh JSON consumed by client');
      const visibleAfterRefresh = await stale.page.locator('.settings-fallback-row select').evaluateAll(selects => selects.map(select => select.value));
      assert.deepEqual(visibleAfterRefresh, ['duckduckgo', 'brave']);
      await stale.page.locator('.settings-fallback-remove').first().click();
      await waitNode(() => posts.length === 2, 'remove first visible fallback after stale refresh');
      const removePayload = posts[1].search_fallback_chain;
      assert.deepEqual(removePayload, ['brave'], 'stale status refresh must not erase newer fallback before remove');
      assert.deepEqual(serverSettings.search_fallback_chain, ['brave']);
      result.cases.stale_success_then_remove_preserves_newer_chain = {
        held_snapshot: heldSnapshot,
        add_payload: posts[0].search_fallback_chain,
        visible_after_add: visibleAfterAdd,
        visible_after_stale_refresh: visibleAfterRefresh,
        remove_payload: removePayload,
        persisted_after_remove: serverSettings.search_fallback_chain,
        client_consumed_refresh_json: true,
      };
    } finally { await closePage(stale.context); }

    reset('normal', ['duckduckgo']);
    const noStale = await openSearch(browser, origin);
    try {
      await waitPage(noStale.page, () => document.querySelector('#set-searchMsg')?.textContent.trim().startsWith('Active: '), 'positive control initial Search status');
      await noStale.page.clock.install();
      await noStale.page.locator('#set-searchAddFallback').click();
      await waitNode(() => posts.length === 1, 'positive control Add POST accepted');
      await waitPage(noStale.page, () => Array.from(document.querySelectorAll('.settings-fallback-row select')).map(select => select.value).join(',') === 'duckduckgo,brave', 'positive control Add fallback rendered');
      await noStale.page.locator('.settings-fallback-remove').first().click();
      await waitNode(() => posts.length === 2, 'positive control remove first visible fallback');
      assert.deepEqual(posts[0].search_fallback_chain, ['duckduckgo', 'brave']);
      assert.deepEqual(posts[1].search_fallback_chain, ['brave']);
      assert.deepEqual(serverSettings.search_fallback_chain, ['brave']);
      result.cases.no_stale_positive_control = { add_payload: posts[0].search_fallback_chain, remove_payload: posts[1].search_fallback_chain, persisted_after_remove: serverSettings.search_fallback_chain };
    } finally { await closePage(noStale.context); }

    for (const scenario of ['read-503', 'malformed-json', 'null-settings', 'array-settings', 'invalid-chain']) {
      reset(scenario, ['duckduckgo', 'brave']);
      const { page, context } = await openSearch(browser, origin);
      try {
        await waitPage(page, () => document.querySelector('#set-searchMsg')?.textContent.includes('Reload the page before changing them.'), `${scenario} load failure message`);
        await assertDisabledAndInert(page);
        assert.equal(posts.length, 0);
        assert.equal(searchQueries.length, 0);
        assert.equal(settingsReads.some(entry => entry.caller === 'search-refresh'), false,
          'refreshStatus cannot recover from or overwrite an unknown initial settings state');
        assert.deepEqual(serverSettings.search_fallback_chain, ['duckduckgo', 'brave']);
        const initialRead = settingsReads.find(entry => entry.caller === 'search-init');
        assert(initialRead && initialRead.ended, `${scenario} initial response reached its failure path`);
        result.cases[scenario] = { initial_status: initialRead.status, controls_disabled: true, no_posts: true, no_search_query: true, initial_chain_preserved: true };
      } finally { await closePage(context); }
    }

    reset('refresh-failure', ['duckduckgo', 'brave']);
    const refreshFailure = await openSearch(browser, origin);
    try {
      await waitPage(refreshFailure.page, () => document.querySelector('#set-searchMsg')?.textContent.trim().startsWith('Active: '), 'normal Search settings and status hydration');
      const initialSignal = await refreshFailure.page.evaluate(() => window.__settingsFetches.find(entry => entry.caller === 'search-init').signal.aborted);
      assert.equal(initialSignal, false);
      await refreshFailure.page.clock.install();
      await refreshFailure.page.locator('#set-searchAddFallback').click();
      await waitNode(() => posts.length === 1, 'normal fallback add');
      await refreshFailure.page.locator('.settings-fallback-remove').last().click();
      await waitNode(() => posts.length === 2, 'normal fallback remove');
      await refreshFailure.page.clock.fastForward(2000);
      await waitNode(() => refreshCount >= 3, 'scheduled status refreshes');
      await waitNode(() => settingsReads.filter(entry => entry.caller === 'search-refresh' && entry.status === 503).length >= 1, 'failed status refresh response sent');
      await waitPage(refreshFailure.page, () => window.__settingsFetches.filter(entry => entry.caller === 'search-refresh' && entry.status === 503).length >= 1, 'failed status refresh response consumed');
      const displayedChain = await refreshFailure.page.locator('.settings-fallback-row select').evaluateAll(selects => selects.map(select => select.value));
      assert.deepEqual(displayedChain, ['duckduckgo', 'brave']);
      assert.deepEqual(serverSettings.search_fallback_chain, ['duckduckgo', 'brave']);
      assert.equal(posts.length, 2);
      result.cases.failed_status_refresh_preserves_known_chain = { failed_refreshes: settingsReads.filter(entry => entry.caller === 'search-refresh' && entry.status === 503).length, displayed_chain: displayedChain, persisted_chain: serverSettings.search_fallback_chain };
    } finally { await closePage(refreshFailure.context); }

    for (const [scenario, chain] of [['loaded-chain', ['duckduckgo', 'brave']], ['empty-chain', []], ['missing-chain', 'missing']]) {
      reset('normal', chain);
      const { page, context } = await openSearch(browser, origin);
      try {
        await waitPage(page, () => document.querySelector('#set-searchMsg')?.textContent.trim().startsWith('Active: '), `${scenario} valid settings hydration`);
        await page.locator('#set-searchAddFallback').click();
        await waitNode(() => posts.length === 1, `${scenario} Add POST`);
        const afterAdd = serverSettings.search_fallback_chain.slice();
        await page.locator('.settings-fallback-remove').last().click();
        await waitNode(() => posts.length === 2, `${scenario} remove POST`);
        assert.deepEqual(serverSettings.search_fallback_chain, chain === 'missing' ? [] : chain);
        result.cases[scenario] = { add_chain: afterAdd, after_remove: serverSettings.search_fallback_chain, writes: posts.length };
      } finally { await closePage(context); }
    }

    reset('normal', ['duckduckgo', 'brave']);
    const normal = await openSearch(browser, origin, true);
    try {
      await waitPage(normal.page, () => document.querySelector('#set-searchMsg')?.textContent.trim().startsWith('Active: '), 'normal load status');
      const reads = await normal.page.evaluate(() => window.__settingsFetches.filter(entry => entry.caller === 'search-init').map(entry => ({ fetch: entry.fetchState, json: entry.jsonState, aborted: entry.signal.aborted })));
      assert.deepEqual(reads, [{ fetch: 'complete', json: 'done', aborted: false }]);
      await normal.page.clock.fastForward(15000);
      assert.equal(await normal.page.evaluate(() => window.__settingsFetches.find(entry => entry.caller === 'search-init').signal.aborted), false,
        'successful settings read clears the deadline timer');
      result.cases.normal_read_timer_cleanup = { fetch: 'complete', json: 'done', signal_aborted_after_15s: false };
    } finally { await closePage(normal.context); }

    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
    result.pass = true;
    result.scope = 'Actual full application served on a synthetic loopback-only server. Search settings, endpoint inventory, auth, and search-query APIs are synthetic; no real account, key, provider, model, or external request is used.';
    result.cleanup = { browser_closed: true, server_closed: true };
    result.external_requests = externalRequests;
    result.page_errors = pageErrors;
    if (process.env.RESULT_PATH) fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (pendingInitial && !pendingInitial.writableEnded) pendingInitial.destroy();
    if (pendingRefresh && !pendingRefresh.res.writableEnded) pendingRefresh.res.destroy();
    if (browser) await browser.close().catch(() => {});
    if (server.listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
