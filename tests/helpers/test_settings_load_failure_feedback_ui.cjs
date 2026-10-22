const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || '/run/media/nerdrx/Lex/novum-xenium/node_modules/playwright');

const repo = path.resolve(process.env.SOURCE_ROOT || path.join(__dirname, '../..'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes = {
  'static/index.html': hash(path.join(repo, 'static/index.html')),
  'static/js/settings.js': hash(path.join(repo, 'static/js/settings.js')),
  'static/js/settings/shell.js': hash(path.join(repo, 'static/js/settings/shell.js')),
};
const endpoints = [
  { id: 'fixture-a', name: 'Fixture A', is_enabled: true, online: true, models: ['utility-a', 'utility-b', 'research-a', 'research-b', 'chat-a'], model_type: 'chat' },
  { id: 'fixture-b', name: 'Fixture B', is_enabled: true, online: true, models: ['utility-a', 'utility-b', 'research-a', 'research-b', 'chat-b'], model_type: 'chat' },
];
const models = { items: [
  { endpoint_id: 'fixture-a', offline: false, models: ['vision-a', 'vision-b', 'utility-a', 'utility-b', 'research-a', 'research-b'], models_metadata: {} },
  { endpoint_id: 'fixture-b', offline: false, models: ['vision-a', 'vision-b', 'utility-a', 'utility-b', 'research-a', 'research-b'], models_metadata: {} },
] };
const baseSaved = {
  default_endpoint_id: 'fixture-a', default_model: 'chat-a',
  utility_endpoint_id: 'fixture-a', utility_model: 'utility-a', utility_reasoning_effort: '', utility_model_fallbacks: [],
  vision_enabled: true, vision_model: 'vision-a', vision_model_fallbacks: [],
  research_endpoint_id: 'fixture-a', research_model: 'research-a', research_max_tokens: 4096,
  research_extraction_timeout_seconds: 90, research_extraction_concurrency: 3, research_run_timeout_seconds: 3600,
  research_search_provider: 'searxng',
  search_provider: 'disabled', search_api_key: '',
  agent_max_rounds: 3, agent_max_tools: 12,
  tts_provider: 'disabled', stt_provider: 'disabled',
};
let authMode = 'valid';
let authReleased = false;
let heldAuthCallers = new Set();
let authCallerModes = {};
let authSnapshot = structuredClone(baseSaved);
let authReads = [];
let modelsHeld = false;
let modelReads = [];
let modelEndpointReads = 0;
let serverSettings = structuredClone(baseSaved);
let posts = [];
let requestPaths = [];
let postMode = 'valid';
let heldPosts = [];
const externalRequests = [];
function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function deliverSettings(entry) {
  if (entry.ended || entry.closed) return;
  entry.ended = true;
  const mode = authCallerModes[entry.caller] || authMode;
  if (mode === 'http503') return sendJson(entry.res, { detail: 'synthetic fixture failure' }, 503);
  if (mode === 'invalidJson') {
    entry.res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return entry.res.end('{not json');
  }
  if (mode === 'null') return sendJson(entry.res, null);
  if (mode === 'array') return sendJson(entry.res, []);
  if (entry.bodyStarted) return entry.res.end(JSON.stringify(authSnapshot).slice(1));
  return sendJson(entry.res, authSnapshot);
}
function startAuthBodies(callers) {
  authReads.filter(entry => callers.includes(entry.caller) && !entry.ended && !entry.closed).forEach(entry => {
    entry.bodyStarted = true;
    entry.res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    entry.res.write('{');
  });
}
function deliverModels(entry) {
  if (entry.ended) return;
  entry.ended = true;
  sendJson(entry.res, models);
}
function configure({ mode = 'valid', settings = baseSaved, holdModels = false, holdAuthCallers = [], callerModes = {}, post = 'valid' } = {}) {
  authMode = mode;
  authReleased = false;
  heldAuthCallers = new Set(holdAuthCallers);
  authCallerModes = callerModes;
  authSnapshot = structuredClone(settings);
  authReads = [];
  modelsHeld = holdModels;
  modelReads = [];
  modelEndpointReads = 0;
  serverSettings = structuredClone(settings);
  posts = [];
  requestPaths = [];
  postMode = post;
  heldPosts = [];
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requestPaths.push({ method: req.method, path: url.pathname });
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8').replaceAll('{{CSP_NONCE}}', 'fixture-nonce'));
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'GET') {
    const entry = { res, ended: false, closed: false, bodyStarted: false, caller: req.headers['x-fixture-caller'] || 'other' };
    res.on('close', () => { entry.closed = true; });
    authReads.push(entry);
    if (authReleased || !heldAuthCallers.has(entry.caller)) deliverSettings(entry);
    return;
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      posts.push(parsed);
      const entry = { res, parsed };
      if (postMode === 'hold') { heldPosts.push(entry); return; }
      deliverPost(entry);
    });
    return;
  }
  if (url.pathname === '/api/auth/status') return sendJson(res, { username: 'synthetic', is_admin: true, privileges: {} });
  if (url.pathname === '/api/auth/features') return sendJson(res, {});
  if (url.pathname === '/api/model-endpoints') {
    modelEndpointReads++;
    return sendJson(res, endpoints);
  }
  if (url.pathname === '/api/models') {
    const entry = { res, ended: false };
    modelReads.push(entry);
    if (!modelsHeld) deliverModels(entry);
    return;
  }
  if (url.pathname === '/api/sessions') return sendJson(res, []);
  if (url.pathname === '/api/presets') return sendJson(res, { custom_revision: 0, custom_save_revision_guard: false, custom_template_autosave: false, presets: [] });
  if (url.pathname === '/api/presets/templates') return sendJson(res, []);
  if (url.pathname === '/api/usage') return sendJson(res, { days: 7, start_date: '2026-10-01', end_date: '2026-10-07', totals: { sessions: 0, messages: 0, assistant_messages: 0, failed_messages: 0, total_tokens: 0, input_tokens: 0, output_tokens: 0, measured_messages: 0, estimated_messages: 0, unknown_metrics_messages: 0, missing_metrics_messages: 0 }, daily: [{ date: '2026-10-01', messages: 0, total_tokens: 0 }], models: [], recent_sessions: [], insights: { active_days: 0, streak_days: 0 } });
  if (url.pathname === '/api/default-chat') return sendJson(res, {});
  if (url.pathname.startsWith('/api/')) return sendJson(res, {});
  const relative = decodeURIComponent(url.pathname.replace(/^\/static\//, ''));
  const staticRoot = path.resolve(repo, 'static');
  const file = path.resolve(staticRoot, relative);
  if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('fixture not found');
  }
  const ext = path.extname(file);
  const mime = ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json' })[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
const waitUntil = async (fn, label, timeout = 20000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
function deliverPost(entry) {
  if (postMode === 'http503') return sendJson(entry.res, { detail: 'synthetic save failure' }, 503);
  if (postMode === 'admin403') return sendJson(entry.res, { detail: 'synthetic admin denial' }, 403);
  Object.assign(serverSettings, entry.parsed);
  sendJson(entry.res, { ok: true });
}
function releasePosts() {
  postMode = 'valid';
  heldPosts.splice(0).forEach(deliverPost);
}
function releaseAuth() {
  authReleased = true;
  authReads.forEach(deliverSettings);
}
function releaseModels() {
  modelsHeld = false;
  modelReads.forEach(deliverModels);
}
async function openSettings(browser, base, pageErrors, pageWarnings, installClock = false) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.__settingsReadTrace = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/auth/settings')) {
        const method = init && init.method || 'GET';
        const stack = new Error().stack;
        const caller = method === 'GET'
          ? ['initUtilityModel', 'initVisionSettings', 'initResearchSettings', 'initResearchSearchSettings'].find(name => stack.includes(`at ${name} (`)) || 'other'
          : null;
        const trace = caller ? { caller, signal: init && init.signal || null, jsonComplete: false } : null;
        if (trace) window.__settingsReadTrace.push(trace);
        const nextInit = caller === null ? init : { ...init, headers: { ...(init && init.headers || {}), 'X-Fixture-Caller': caller } };
        const request = nativeFetch(input, nextInit);
        if (!trace) return request;
        return request.then(response => {
          const json = response.json.bind(response);
          response.json = async function() {
            const value = await json();
            trace.jsonComplete = true;
            return value;
          };
          return response;
        });
      }
      return nativeFetch(input, init);
    };
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { externalRequests.push(url.href); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  if (installClock) await page.clock.install();
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  page.on('console', message => { if (message.type() === 'warning') pageWarnings.push(message.text()); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window._isAdmin === true);
  await page.locator('#user-bar-settings').click();
  await page.locator('#settings-modal:not(.hidden)').waitFor({ state: 'attached' });
  await page.locator('[data-settings-tab="ai"]').click();
  return { page, context };
}
function exactPost(expected) {
  assert(posts.some(post => JSON.stringify(post) === JSON.stringify(expected)), `missing exact sparse POST ${JSON.stringify(expected)}; got ${JSON.stringify(posts)}`);
}

(async () => {
  let browser;
  const pageErrors = [];
  const pageWarnings = [];
  const results = {};
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-service-worker'] });
    const nondefault = { ...baseSaved, utility_endpoint_id: 'fixture-b', utility_model: 'utility-b', vision_enabled: false, vision_model: 'vision-b', research_endpoint_id: 'fixture-b', research_model: 'research-b', research_max_tokens: 8192, research_extraction_timeout_seconds: 150, research_extraction_concurrency: 6, research_run_timeout_seconds: 7200, research_search_provider: 'brave' };

    configure({ mode: 'valid', settings: nondefault });
    let { page, context } = await openSettings(browser, base, pageErrors, pageWarnings);
    await page.waitForFunction(() => document.querySelector('#set-utilityEpSelect')?.value === 'fixture-b' && document.querySelector('#set-utilityModelSelect')?.value === 'utility-b' && document.querySelector('#set-vlModelSelect')?.value === 'vision-b' && document.querySelector('#set-researchEndpoint')?.value === 'fixture-b' && document.querySelector('#set-researchModel')?.value === 'research-b' && document.querySelector('#set-researchMaxTokens')?.value === '8192');
    await page.locator('[data-settings-tab="search"]').click();
    await page.waitForFunction(() => document.querySelector('#set-researchSearch')?.value === 'brave');
    const normal = await page.evaluate(() => ({
      visionModel: document.querySelector('#set-vlModelSelect').value,
      visionEnabled: document.querySelector('#set-visionEnabledToggle').checked,
      visionMessage: document.querySelector('#set-visionSettingsMsg').textContent.trim(),
      utilityEndpoint: document.querySelector('#set-utilityEpSelect').value,
      utilityModel: document.querySelector('#set-utilityModelSelect').value,
      utilityMessage: document.querySelector('#set-utilityChatMsg').textContent.trim(),
      researchEndpoint: document.querySelector('#set-researchEndpoint').value,
      researchModel: document.querySelector('#set-researchModel').value,
      researchMaxTokens: document.querySelector('#set-researchMaxTokens').value,
      researchExtractTimeout: document.querySelector('#set-researchExtractTimeout').value,
      researchConcurrency: document.querySelector('#set-researchExtractConcurrency').value,
      researchRunTimeout: document.querySelector('#set-researchRunTimeout').value,
      researchMessage: document.querySelector('#set-researchMsg').textContent.trim(),
      researchSearchProvider: document.querySelector('#set-researchSearch').value,
      researchSearchMessage: document.querySelector('#set-researchSearchMsg')?.textContent.trim() || '',
      researchSearchMessageRole: document.querySelector('#set-researchSearchMsg')?.getAttribute('role') || '',
    }));
    assert.deepEqual(normal, { visionModel: 'vision-b', visionEnabled: false, visionMessage: '', utilityEndpoint: 'fixture-b', utilityModel: 'utility-b', utilityMessage: '', researchEndpoint: 'fixture-b', researchModel: 'research-b', researchMaxTokens: '8192', researchExtractTimeout: '150', researchConcurrency: '6', researchRunTimeout: '7200', researchMessage: 'Fixture B / research-b · Max tokens: 8192 · Extract: 150s · Parallel: 6 · Max time: 7200s', researchSearchProvider: 'brave', researchSearchMessage: '', researchSearchMessageRole: 'status' });
    results.normal = { saved: { visionModel: nondefault.vision_model, visionEnabled: nondefault.vision_enabled, researchEndpoint: nondefault.research_endpoint_id, researchModel: nondefault.research_model, researchMaxTokens: nondefault.research_max_tokens }, displayed: normal };
    await context.close();
    assert.ok(authReads.every(entry => entry.ended), 'normal successful responses are all released before next case');

    for (const [label, caller, mode] of [
      ['utility-http503', 'initUtilityModel', 'http503'],
      ['utility-malformed', 'initUtilityModel', 'invalidJson'],
      ['research-search-http503', 'initResearchSearchSettings', 'http503'],
      ['research-search-malformed', 'initResearchSearchSettings', 'null'],
    ]) {
      pageWarnings.length = 0;
      const sibling = caller === 'initUtilityModel' ? 'initResearchSearchSettings' : 'initUtilityModel';
      const callerModes = { [caller]: mode };
      configure({ mode: 'valid', settings: nondefault, callerModes });
      ({ page, context } = await openSettings(browser, base, pageErrors, pageWarnings));
      await waitUntil(() => authReads.some(entry => entry.caller === caller && entry.ended) && authReads.some(entry => entry.caller === sibling && entry.ended), `${label} target and sibling settings responses`);
      const warningPrefix = caller === 'initUtilityModel' ? 'Failed to load utility model settings' : 'Failed to load research search settings';
      await waitUntil(() => pageWarnings.some(text => text.includes(warningPrefix)), `${label} console warning`);
      if (caller === 'initResearchSearchSettings') await page.locator('[data-settings-tab="search"]').click();
      const ui = await page.evaluate(() => ({
        utilityEndpoint: document.querySelector('#set-utilityEpSelect').value,
        utilityModel: document.querySelector('#set-utilityModelSelect').value,
        utilityMessage: document.querySelector('#set-utilityChatMsg').textContent.trim(),
        researchSearchProvider: document.querySelector('#set-researchSearch').value,
        researchSearchMessage: document.querySelector('#set-researchSearchMsg')?.textContent.trim() || '',
        visibleAlerts: Array.from(document.querySelectorAll('[role="alert"]')).filter(node => node.getClientRects().length).map(node => node.textContent.trim()),
      }));
      if (caller === 'initUtilityModel') {
        assert.equal(ui.utilityEndpoint, '', `${label}: failed Utility read leaves its endpoint at the initial value`);
        assert.equal(ui.utilityModel, '', `${label}: failed Utility read leaves its model at the initial value`);
        assert.equal(ui.utilityMessage, 'Could not load saved Utility settings.', `${label}: Utility status reports the failed settings load`);
        assert.equal(ui.researchSearchProvider, 'brave', `${label}: valid Research Search sibling still hydrates`);
        assert.equal(ui.researchSearchMessage, '', `${label}: no Research Search failure text on valid sibling`);
      } else {
        assert.equal(ui.researchSearchProvider, '', `${label}: failed Research Search read leaves its selector at the initial value`);
        assert.equal(ui.researchSearchMessage, 'Could not load saved Research Search settings.', `${label}: Research Search status reports the failed settings load`);
        assert.equal(ui.utilityEndpoint, 'fixture-b', `${label}: valid Utility sibling still hydrates`);
        assert.equal(ui.utilityModel, 'utility-b', `${label}: valid Utility sibling still hydrates its model`);
        assert.equal(ui.utilityMessage, '', `${label}: no Utility failure text on valid sibling`);
      }
      assert.deepEqual(ui.visibleAlerts, [], `${label}: status is panel-local rather than role=alert`);
      results[label] = { ui, warning: pageWarnings.find(text => text.includes(warningPrefix)), target: caller, outcome: mode };
      await context.close();
      assert.ok(authReads.every(entry => entry.ended), `${label} responses all released before next case`);
    }

    pageWarnings.length = 0;
    configure({
      settings: nondefault,
      holdAuthCallers: ['initUtilityModel', 'initResearchSearchSettings'],
      callerModes: { initUtilityModel: 'http503', initResearchSearchSettings: 'http503' },
      post: 'hold',
    });
    ({ page, context } = await openSettings(browser, base, pageErrors, pageWarnings));
    await waitUntil(() => ['initUtilityModel', 'initResearchSearchSettings'].every(caller => authReads.some(entry => entry.caller === caller && !entry.ended)), 'held Utility and Research Search settings responses');
    await page.locator('#set-utilityEpSelect').selectOption('fixture-a');
    await page.locator('[data-settings-tab="search"]').click();
    await page.locator('#set-researchSearch').selectOption('google');
    await waitUntil(() => posts.some(post => post.utility_endpoint_id === 'fixture-a') && posts.some(post => post.research_search_provider === 'google'), 'Utility and Research Search sparse saves');
    assert.ok(posts.some(post => JSON.stringify(post) === JSON.stringify({ utility_endpoint_id: 'fixture-a', utility_model: '', utility_reasoning_effort: '' })), 'Utility change sends its intentional dependent sparse fields only');
    assert.ok(posts.some(post => JSON.stringify(post) === JSON.stringify({ research_search_provider: 'google' })), 'Research Search change sends only its owned key');
    await page.waitForFunction(() => document.querySelector('#set-utilityChatMsg')?.textContent.trim() === 'Saving…' && document.querySelector('#set-researchSearchMsg')?.textContent.trim() === 'Saving…');
    const saving = await page.evaluate(() => ({ utility: document.querySelector('#set-utilityChatMsg').textContent.trim(), researchSearch: document.querySelector('#set-researchSearchMsg').textContent.trim() }));
    releaseAuth();
    await waitUntil(() => ['initUtilityModel', 'initResearchSearchSettings'].every(caller => authReads.some(entry => entry.caller === caller && entry.ended)), 'load failures during Utility and Research Search saves');
    await waitUntil(() => ['Failed to load utility model settings', 'Failed to load research search settings'].every(prefix => pageWarnings.some(text => text.includes(prefix))), 'Utility and Research Search failure warnings');
    const savingAfterLoadFailure = await page.evaluate(() => ({ utility: document.querySelector('#set-utilityChatMsg').textContent.trim(), researchSearch: document.querySelector('#set-researchSearchMsg').textContent.trim() }));
    assert.deepEqual(savingAfterLoadFailure, saving, 'load failures do not replace active save feedback');
    releasePosts();
    await page.waitForFunction(() => document.querySelector('#set-utilityChatMsg')?.textContent.trim() === 'Saved' && document.querySelector('#set-researchSearchMsg')?.textContent.trim() === 'Saved');
    results.utilitySearchSaveFeedbackOwnership = { saving, afterLoadFailure: savingAfterLoadFailure };
    await context.close();
    assert.ok(authReads.every(entry => entry.ended), 'overlap-case GET responses all released before cleanup');

    pageWarnings.length = 0;
    configure({ settings: nondefault, holdAuthCallers: ['initUtilityModel', 'initResearchSearchSettings'], callerModes: { initUtilityModel: 'http503', initResearchSearchSettings: 'http503' } });
    ({ page, context } = await openSettings(browser, base, pageErrors, pageWarnings));
    await waitUntil(() => ['initUtilityModel', 'initResearchSearchSettings'].every(caller => authReads.some(entry => entry.caller === caller && !entry.ended)), 'held Utility and Research Search reads for saved feedback');
    await page.locator('#set-utilityEpSelect').selectOption('fixture-a');
    await page.locator('[data-settings-tab="search"]').click();
    await page.locator('#set-researchSearch').selectOption('google');
    await waitUntil(() => posts.some(post => post.utility_endpoint_id === 'fixture-a') && posts.some(post => post.research_search_provider === 'google'), 'Utility and Research Search successful writes');
    await page.waitForFunction(() => document.querySelector('#set-utilityChatMsg')?.textContent.trim() === 'Saved' && document.querySelector('#set-researchSearchMsg')?.textContent.trim() === 'Saved');
    releaseAuth();
    await waitUntil(() => ['initUtilityModel', 'initResearchSearchSettings'].every(caller => authReads.some(entry => entry.caller === caller && entry.ended)), 'late failed Utility and Research Search reads');
    await waitUntil(() => ['Failed to load utility model settings', 'Failed to load research search settings'].every(prefix => pageWarnings.some(text => text.includes(prefix))), 'late-failure warnings after saved feedback');
    const savedAfterLoadFailure = await page.evaluate(() => ({ utility: document.querySelector('#set-utilityChatMsg').textContent.trim(), researchSearch: document.querySelector('#set-researchSearchMsg').textContent.trim() }));
    assert.deepEqual(savedAfterLoadFailure, { utility: 'Saved', researchSearch: 'Saved' }, 'late initial-load failures do not replace completed Saved feedback');
    results.utilitySearchSavedFeedbackOwnership = savedAfterLoadFailure;
    await context.close();
    assert.ok(authReads.every(entry => entry.ended), 'saved-feedback overlap responses all released before cleanup');

    for (const [label, callerModes] of [
      ['http503', { initVisionSettings: 'http503', initResearchSettings: 'http503' }],
      ['malformed', { initVisionSettings: 'null', initResearchSettings: 'invalidJson' }],
    ]) {
      pageWarnings.length = 0;
      configure({ mode: 'valid', settings: nondefault, callerModes });
      ({ page, context } = await openSettings(browser, base, pageErrors, pageWarnings));
      for (const caller of ['initVisionSettings', 'initResearchSettings']) {
        await waitUntil(() => authReads.some(entry => entry.caller === caller && entry.ended), `${label} ${caller} response`);
      }
      const warningTexts = label === 'http503'
        ? ['Failed to load vision settings', 'Failed to load research settings']
        : ['Failed to load vision settings', 'Failed to load research settings'];
      await waitUntil(() => warningTexts.every(prefix => pageWarnings.some(text => text.includes(prefix))), `${label} console warnings`);
      const ui = await page.evaluate(() => {
        const toast = document.querySelector('#toast');
        const alerts = Array.from(document.querySelectorAll('[role="alert"]')).filter(node => node.getClientRects().length).map(node => node.textContent.trim());
        return {
          visionModel: document.querySelector('#set-vlModelSelect').value,
          visionSelectedLabel: document.querySelector('#set-vlModelSelect').selectedOptions[0]?.textContent || '',
          visionEnabled: document.querySelector('#set-visionEnabledToggle').checked,
          visionMessage: document.querySelector('#set-visionSettingsMsg').textContent.trim(),
          researchEndpoint: document.querySelector('#set-researchEndpoint').value,
          researchModel: document.querySelector('#set-researchModel').value,
          researchMaxTokens: document.querySelector('#set-researchMaxTokens').value,
          researchExtractTimeout: document.querySelector('#set-researchExtractTimeout').value,
          researchConcurrency: document.querySelector('#set-researchExtractConcurrency').value,
          researchRunTimeout: document.querySelector('#set-researchRunTimeout').value,
          researchMessage: document.querySelector('#set-researchMsg').textContent.trim(),
          visibleToast: !!toast && toast.classList.contains('show') ? toast.textContent.trim() : '',
          visibleAlerts: alerts,
        };
      });
      assert.equal(ui.visionMessage, 'Could not load saved Vision settings.', `${label}: Vision panel reports failed saved-settings load`);
      assert.equal(ui.researchEndpoint, '', `${label}: failed settings read leaves endpoint at panel default`);
      assert.equal(ui.researchModel, '', `${label}: failed settings read leaves model at panel default`);
      assert.equal(ui.researchMaxTokens, '', `${label}: failed settings read leaves numeric fields at blank placeholders`);
      assert.equal(ui.researchExtractTimeout, '');
      assert.equal(ui.researchConcurrency, '');
      assert.equal(ui.researchRunTimeout, '');
      assert.equal(ui.researchMessage, 'Could not load saved Research settings.', `${label}: Research panel reports failed saved-settings load`);
      assert.deepEqual(ui.visibleAlerts, [], `${label}: no visible role=alert reports settings load failure`);
      assert.ok(!/Failed to load (vision|research) settings/i.test(ui.visibleToast), `${label}: no Vision/Research settings failure is shown in the global toast`);
      const warnings = pageWarnings.filter(text => text.includes('Failed to load vision settings') || text.includes('Failed to load research settings'));
      assert.equal(warnings.length, 2, `${label}: both panel failures are logged to browser console`);
      results[label] = { ui, warnings, targetRequests: authReads.filter(entry => ['initVisionSettings', 'initResearchSettings'].includes(entry.caller)).map(entry => ({ caller: entry.caller, outcome: callerModes[entry.caller] })) };
      await context.close();
      assert.ok(authReads.every(entry => entry.ended), `${label} responses all released before next case`);
    }

    pageWarnings.length = 0;
    configure({
      settings: nondefault,
      holdAuthCallers: ['initVisionSettings', 'initResearchSettings'],
      callerModes: { initVisionSettings: 'http503', initResearchSettings: 'http503' },
      post: 'hold',
    });
    ({ page, context } = await openSettings(browser, base, pageErrors, pageWarnings));
    await waitUntil(() => ['initVisionSettings', 'initResearchSettings'].every(caller => authReads.some(entry => entry.caller === caller && !entry.ended)), 'held Vision and Research settings responses');
    await page.locator('label.admin-switch:has(#set-visionEnabledToggle)').click();
    await page.evaluate(() => {
      const input = document.querySelector('#set-researchMaxTokens');
      input.value = '2048';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitUntil(() => posts.some(post => post.vision_enabled === false) && posts.some(post => post.research_max_tokens === 2048), 'sparse Vision and Research saves');
    assert.ok(posts.some(post => JSON.stringify(post) === JSON.stringify({ vision_enabled: false })), 'Vision edit sends only touched key');
    assert.ok(posts.some(post => JSON.stringify(post) === JSON.stringify({ research_max_tokens: 2048 })), 'Research edit sends only touched key');
    await page.waitForFunction(() => document.querySelector('#set-visionSettingsMsg')?.textContent.trim() === 'Saving…' && document.querySelector('#set-researchMsg')?.textContent.trim() === 'Saving…');
    const savingMessages = await page.evaluate(() => ({
      vision: document.querySelector('#set-visionSettingsMsg').textContent.trim(),
      research: document.querySelector('#set-researchMsg').textContent.trim(),
    }));
    releaseAuth();
    await waitUntil(() => ['initVisionSettings', 'initResearchSettings'].every(caller => authReads.some(entry => entry.caller === caller && entry.ended)), 'failed settings responses during saves');
    await waitUntil(() => ['Failed to load vision settings', 'Failed to load research settings'].every(prefix => pageWarnings.some(text => text.includes(prefix))), 'save-overlap load warnings');
    const savingAfterFailure = await page.evaluate(() => ({
      vision: document.querySelector('#set-visionSettingsMsg').textContent.trim(),
      research: document.querySelector('#set-researchMsg').textContent.trim(),
    }));
    assert.deepEqual(savingMessages, { vision: 'Saving…', research: 'Saving…' });
    assert.deepEqual(savingAfterFailure, savingMessages, 'late GET failures must not replace active save feedback');
    releasePosts();
    await page.waitForFunction(() => document.querySelector('#set-visionSettingsMsg')?.textContent.trim() === 'Saved' && document.querySelector('#set-researchMsg')?.textContent.trim() === 'Saved');
    const afterSaveFailure = await page.evaluate(() => ({
      vision: document.querySelector('#set-visionSettingsMsg').textContent.trim(),
      research: document.querySelector('#set-researchMsg').textContent.trim(),
      visionEnabled: document.querySelector('#set-visionEnabledToggle').checked,
      researchMaxTokens: document.querySelector('#set-researchMaxTokens').value,
    }));
    assert.deepEqual(afterSaveFailure, { vision: 'Saved', research: 'Saved', visionEnabled: false, researchMaxTokens: '2048' }, 'successful saves complete without late GET mutation');
    results.saveFeedbackOwnership = { duringSave: savingMessages, afterLoadFailure: savingAfterFailure, afterSave: afterSaveFailure, targetRequests: authReads.filter(entry => ['initVisionSettings', 'initResearchSettings'].includes(entry.caller)).map(entry => ({ caller: entry.caller, outcome: 'http503' })) };
    await context.close();
    assert.ok(authReads.every(entry => entry.ended), 'save-overlap responses all released before cleanup');

    pageWarnings.length = 0;
    configure({
      settings: nondefault,
      holdAuthCallers: ['initVisionSettings', 'initResearchSettings'],
      callerModes: { initVisionSettings: 'http503', initResearchSettings: 'http503' },
      post: 'http503',
    });
    ({ page, context } = await openSettings(browser, base, pageErrors, pageWarnings));
    await waitUntil(() => ['initVisionSettings', 'initResearchSettings'].every(caller => authReads.some(entry => entry.caller === caller && !entry.ended)), 'held settings responses for save failures');
    await page.locator('label.admin-switch:has(#set-visionEnabledToggle)').click();
    await page.evaluate(() => {
      const input = document.querySelector('#set-researchMaxTokens');
      input.value = '3072';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitUntil(() => posts.some(post => post.vision_enabled === false) && posts.some(post => post.research_max_tokens === 3072), 'failed sparse saves');
    await page.waitForFunction(() => document.querySelector('#set-visionSettingsMsg')?.textContent.trim() === 'Failed to save' && document.querySelector('#set-researchMsg')?.textContent.trim() === 'Failed to save');
    releaseAuth();
    await waitUntil(() => ['initVisionSettings', 'initResearchSettings'].every(caller => authReads.some(entry => entry.caller === caller && entry.ended)), 'failed settings responses after failed saves');
    await waitUntil(() => ['Failed to load vision settings', 'Failed to load research settings'].every(prefix => pageWarnings.some(text => text.includes(prefix))), 'failed-save overlap client load warnings');
    const failedSaveMessages = await page.evaluate(() => ({
      vision: document.querySelector('#set-visionSettingsMsg').textContent.trim(),
      research: document.querySelector('#set-researchMsg').textContent.trim(),
    }));
    assert.deepEqual(failedSaveMessages, { vision: 'Failed to save', research: 'Failed to save' }, 'load failures must not replace owned Failed feedback');
    results.failedSaveFeedbackOwnership = failedSaveMessages;
    await context.close();
    assert.ok(authReads.every(entry => entry.ended), 'failed-save responses all released before cleanup');

    for (const [post, expected, label] of [
      ['http503', 'Failed to save', 'Utility/Search failed save'],
      ['admin403', 'Admin access is required to change these settings.', 'Utility/Search admin denial'],
    ]) {
      pageWarnings.length = 0;
      configure({ settings: nondefault, holdAuthCallers: ['initUtilityModel', 'initResearchSearchSettings'], callerModes: { initUtilityModel: 'http503', initResearchSearchSettings: 'http503' }, post });
      ({ page, context } = await openSettings(browser, base, pageErrors, pageWarnings));
      await waitUntil(() => ['initUtilityModel', 'initResearchSearchSettings'].every(caller => authReads.some(entry => entry.caller === caller && !entry.ended)), `${label}: held initial settings reads`);
      await page.locator('#set-utilityEpSelect').selectOption('fixture-a');
      await page.locator('[data-settings-tab="search"]').click();
      await page.locator('#set-researchSearch').selectOption('google');
      await waitUntil(() => posts.some(item => item.utility_endpoint_id === 'fixture-a') && posts.some(item => item.research_search_provider === 'google'), `${label}: settings writes`);
      await page.waitForFunction(expectedText => document.querySelector('#set-utilityChatMsg')?.textContent.trim() === expectedText && document.querySelector('#set-researchSearchMsg')?.textContent.trim() === expectedText, expected);
      releaseAuth();
      await waitUntil(() => ['initUtilityModel', 'initResearchSearchSettings'].every(caller => authReads.some(entry => entry.caller === caller && entry.ended)), `${label}: failed initial reads`);
      await waitUntil(() => ['Failed to load utility model settings', 'Failed to load research search settings'].every(prefix => pageWarnings.some(text => text.includes(prefix))), `${label}: initial-load warnings`);
      const retained = await page.evaluate(() => ({ utility: document.querySelector('#set-utilityChatMsg').textContent.trim(), researchSearch: document.querySelector('#set-researchSearchMsg').textContent.trim() }));
      assert.deepEqual(retained, { utility: expected, researchSearch: expected }, `${label}: load failure does not replace owned save feedback`);
      results[label] = retained;
      await context.close();
      assert.ok(authReads.every(entry => entry.ended), `${label}: responses released before cleanup`);
    }

    const deadlineCallers = ['initUtilityModel', 'initResearchSettings', 'initResearchSearchSettings'];
    const messageSelectors = {
      initUtilityModel: '#set-utilityChatMsg',
      initResearchSettings: '#set-researchMsg',
      initResearchSearchSettings: '#set-researchSearchMsg',
    };
    for (const phase of ['headers', 'body']) {
      for (const caller of deadlineCallers) {
        pageWarnings.length = 0;
        const callerModes = Object.fromEntries(deadlineCallers.map(name => [name, 'valid']));
        configure({ settings: nondefault, holdAuthCallers: [caller], callerModes });
        ({ page, context } = await openSettings(browser, base, pageErrors, pageWarnings, true));
        await waitUntil(() => authReads.some(entry => entry.caller === caller && !entry.ended), `${caller} held settings headers`);
        const target = authReads.find(entry => entry.caller === caller);
        if (phase === 'body') startAuthBodies([caller]);
        if (phase === 'body') await waitUntil(() => target.res.headersSent, `${caller} settings headers sent before held body`);
        await page.clock.fastForward(15001);
        await waitUntil(() => target.closed, `${caller} ${phase} response closes at deadline`);
        await waitUntil(() => pageWarnings.some(text => text.includes(`Failed to load ${caller === 'initUtilityModel' ? 'utility model' : caller === 'initResearchSettings' ? 'research' : 'research search'} settings`)), `${caller} visible failure handler runs`);
        const state = await page.evaluate(({ callerName, selector }) => ({
          requestCount: window.__settingsReadTrace.filter(entry => entry.caller === callerName).length,
          signalAborted: window.__settingsReadTrace.find(entry => entry.caller === callerName)?.signal?.aborted,
          message: document.querySelector(selector)?.textContent.trim(),
        }), { callerName: caller, selector: messageSelectors[caller] });
        assert.equal(state.requestCount, 1, `${caller} ${phase}: exactly one target settings read`);
        assert.equal(state.signalAborted, true, `${caller} ${phase}: native request signal aborted`);
        assert.ok(state.message, `${caller} ${phase}: existing panel failure status is visible`);
        assert.deepEqual(posts, [], `${caller} ${phase}: timeout does not save defaults or retry`);
        results[`${caller}-${phase}-deadline`] = { ...state, responseClosed: target.closed, postCount: posts.length };
        releaseAuth();
        await context.close();
        assert.ok(authReads.every(entry => entry.closed || entry.ended), `${caller} ${phase}: held responses are closed before cleanup`);
      }
    }

    configure({ settings: nondefault });
    ({ page, context } = await openSettings(browser, base, pageErrors, pageWarnings, true));
    await page.locator('[data-settings-tab="search"]').click();
    await waitUntil(() => deadlineCallers.every(caller => authReads.some(entry => entry.caller === caller && entry.ended)), 'normal Utility, Research, and Research Search reads finish');
    await page.waitForFunction(callers => callers.every(caller => window.__settingsReadTrace.some(entry => entry.caller === caller && entry.jsonComplete)), deadlineCallers);
    await page.waitForFunction(() => document.querySelector('#set-researchSearch')?.value === 'brave', null, { timeout: 10000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await new Promise(resolve => setTimeout(resolve, 50));
    const beforeTimer = await page.evaluate(callers => window.__settingsReadTrace.filter(entry => callers.includes(entry.caller)).map(entry => ({ caller: entry.caller, aborted: entry.signal?.aborted })), deadlineCallers);
    assert.equal(beforeTimer.length, 3, 'normal timer control observes all three target reads');
    assert.ok(beforeTimer.every(entry => entry.aborted === false), 'completed reads are not already aborted');
    await page.clock.fastForward(15001);
    const afterTimer = await page.evaluate(callers => window.__settingsReadTrace.filter(entry => callers.includes(entry.caller)).map(entry => ({ caller: entry.caller, aborted: entry.signal?.aborted })), deadlineCallers);
    assert.ok(afterTimer.every(entry => entry.aborted === false), `normal reads clear their deadline timers; signals=${JSON.stringify({ beforeTimer, afterTimer, reads: authReads.map(entry => ({ caller: entry.caller, ended: entry.ended, closed: entry.closed })) })}`);
    assert.ok(afterTimer.every(entry => entry.aborted === false), 'normal reads clear their deadline timers');
    results.normalDeadlineCleanup = afterTimer;
    await context.close();

    assert.deepEqual(externalRequests, [], `unexpected non-loopback requests: ${externalRequests.join(', ')}`);
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\\n')}`);
    const result = { pass: true, sourceHashes, externalRequests, pageErrors, results, cleanup: { browserClosed: true, serverClosed: true }, scope: 'Synthetic actual-app evidence for Vision, Research, Utility and Research Search initial settings GET failures only; unrelated app-global fixture notices are recorded and not attributed to these settings loads.' };
    if (process.env.RESULT_PATH) fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    authReleased = true;
    authReads.forEach(deliverSettings);
    releasePosts();
    if (browser) await browser.close().catch(() => {});
    if (server.listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
