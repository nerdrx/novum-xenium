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
const externalRequests = [];
function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function deliverSettings(entry) {
  if (entry.ended) return;
  entry.ended = true;
  const mode = authCallerModes[entry.caller] || authMode;
  if (mode === 'http503') return sendJson(entry.res, { detail: 'synthetic fixture failure' }, 503);
  if (mode === 'invalidJson') {
    entry.res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return entry.res.end('{not json');
  }
  if (mode === 'null') return sendJson(entry.res, null);
  if (mode === 'array') return sendJson(entry.res, []);
  return sendJson(entry.res, authSnapshot);
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
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requestPaths.push({ method: req.method, path: url.pathname });
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8').replaceAll('{{CSP_NONCE}}', 'fixture-nonce'));
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'GET') {
    const entry = { res, ended: false, caller: req.headers['x-fixture-caller'] || 'other' };
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
      if (postMode === 'http503') return sendJson(res, { detail: 'synthetic save failure' }, 503);
      Object.assign(serverSettings, parsed);
      sendJson(res, { ok: true });
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
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
function releaseAuth() {
  authReleased = true;
  authReads.forEach(deliverSettings);
}
function releaseModels() {
  modelsHeld = false;
  modelReads.forEach(deliverModels);
}
async function openSettings(browser, base, pageErrors) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/auth/settings')) {
        const method = init && init.method || 'GET';
        const stack = new Error().stack;
        const caller = method === 'GET'
          ? ['initUtilityModel', 'initVisionSettings', 'initResearchSettings', 'initResearchSearchSettings'].find(name => stack.includes(`at ${name} (`)) || 'other'
          : null;
        const nextInit = caller === null ? init : { ...init, headers: { ...(init && init.headers || {}), 'X-Fixture-Caller': caller } };
        return nativeFetch(input, nextInit);
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
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
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
  const results = {};
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-service-worker'] });

    // All four panels: edit real controls while their successful settings responses are held.
    configure({ mode: 'valid', holdModels: true, holdAuthCallers: ['initUtilityModel', 'initVisionSettings', 'initResearchSettings', 'initResearchSearchSettings'] });
    let { page, context } = await openSettings(browser, base, pageErrors);
    await waitUntil(() => modelReads.length >= 1 && modelEndpointReads >= 2, 'prerequisite inventory reads');
    await page.waitForFunction(() => document.querySelector('#set-utilityEpSelect option[value="fixture-b"]') && document.querySelector('#set-researchEndpoint option[value="fixture-b"]'));
    await page.locator('#set-utilityEpSelect').selectOption('fixture-b');
    await page.locator('label.admin-switch:has(#set-visionEnabledToggle)').click();
    await page.locator('#set-researchEndpoint').selectOption('fixture-b');
    await page.locator('[data-settings-tab="search"]').click();
    await page.locator('#set-researchMaxTokens').fill('7777');
    await page.locator('#set-researchMaxTokens').press('Tab');
    await page.locator('#set-researchSearch').selectOption('duckduckgo');
    await waitUntil(() => posts.length >= 5, 'sparse saves while prerequisite model inventory is held', 5000);
    assert.ok(modelReads.some(entry => !entry.ended), 'model inventory response remains held while controls save');
    exactPost({ utility_endpoint_id: 'fixture-b', utility_model: '', utility_reasoning_effort: '' });
    exactPost({ vision_enabled: false });
    exactPost({ research_max_tokens: 7777 });
    exactPost({ research_endpoint_id: 'fixture-b', research_model: '' });
    exactPost({ research_search_provider: 'duckduckgo' });
    releaseModels();
    await waitUntil(() => ['initUtilityModel', 'initVisionSettings', 'initResearchSettings', 'initResearchSearchSettings'].every(caller => authReads.some(entry => entry.caller === caller)), 'four initial settings responses held', 5000).catch(error => {
      throw new Error(`${error.message}; server callers=${JSON.stringify(authReads.map(entry => entry.caller))}`);
    });
    await page.locator('[data-settings-tab="ai"]').click();
    await page.locator('#set-vlModelSelect').selectOption('vision-b');
    await waitUntil(() => posts.length >= 6, 'Vision sparse save while target settings responses are held', 5000);
    exactPost({ utility_endpoint_id: 'fixture-b', utility_model: '', utility_reasoning_effort: '' });
    exactPost({ vision_enabled: false });
    exactPost({ vision_model: 'vision-b' });
    exactPost({ research_max_tokens: 7777 });
    exactPost({ research_endpoint_id: 'fixture-b', research_model: '' });
    exactPost({ research_search_provider: 'duckduckgo' });
    const immediate = structuredClone(posts);
    assert.ok(modelReads.every(entry => entry.ended), 'model inventory response is released before Vision model options are used');
    const preHydration = await page.evaluate(() => ({
      utilityEndpoint: document.querySelector('#set-utilityEpSelect').value,
      visionEnabled: document.querySelector('#set-visionEnabledToggle').checked,
      visionModel: document.querySelector('#set-vlModelSelect').value,
      researchEndpoint: document.querySelector('#set-researchEndpoint').value,
      researchMaxTokens: document.querySelector('#set-researchMaxTokens').value,
      researchSearch: document.querySelector('#set-researchSearch').value,
    }));
    releaseAuth();
    await page.waitForFunction(() =>
      document.querySelector('#set-utilityEpSelect').value === 'fixture-b' &&
      document.querySelector('#set-visionEnabledToggle').checked === false &&
      document.querySelector('#set-vlModelSelect').value === 'vision-b' &&
      document.querySelector('#set-researchEndpoint').value === 'fixture-b' &&
      document.querySelector('#set-researchMaxTokens').value === '7777' &&
      document.querySelector('#set-researchSearch').value === 'duckduckgo' &&
      document.querySelector('#set-researchExtractTimeout').value === '90' &&
      document.querySelector('#set-researchExtractConcurrency').value === '3' &&
      document.querySelector('#set-researchRunTimeout').value === '3600'
    );
    await page.locator('#set-vlModelSelect').selectOption('vision-a');
    await waitUntil(() => posts.some(post => post.vision_model === 'vision-a'), 'normal post-hydration vision save');
    exactPost({ vision_model: 'vision-a' });
    results.validHeldHydration = {
      targetSettingsResponsesHeld: true,
      earlySparsePosts: immediate,
      preHydration,
      afterHydration: await page.evaluate(() => ({
        utilityEndpoint: document.querySelector('#set-utilityEpSelect').value,
        visionEnabled: document.querySelector('#set-visionEnabledToggle').checked,
        visionModel: document.querySelector('#set-vlModelSelect').value,
        researchEndpoint: document.querySelector('#set-researchEndpoint').value,
        researchMaxTokens: document.querySelector('#set-researchMaxTokens').value,
        researchExtractionTimeout: document.querySelector('#set-researchExtractTimeout').value,
        researchExtractionConcurrency: document.querySelector('#set-researchExtractConcurrency').value,
        researchRunTimeout: document.querySelector('#set-researchRunTimeout').value,
        researchSearch: document.querySelector('#set-researchSearch').value,
      })),
      normalPostHydrationSave: posts.at(-1),
    };
    await context.close();

    // A successful early Research save must not call showStatus before its
    // held settings request finishes and initializes that callback.
    configure({ mode: 'valid', holdAuthCallers: ['initResearchSettings'] });
    ({ page, context } = await openSettings(browser, base, pageErrors));
    await waitUntil(() => authReads.some(entry => entry.caller === 'initResearchSettings' && !entry.ended), 'held Research settings response before early save');
    await page.locator('[data-settings-tab="search"]').click();
    const timerErrorCount = pageErrors.length;
    await page.locator('#set-researchMaxTokens').fill('5000');
    await page.locator('#set-researchMaxTokens').press('Tab');
    await waitUntil(() => posts.some(post => post.research_max_tokens === 5000), 'early successful Research save');
    await waitUntil(() => page.locator('#set-researchMsg').textContent().then(text => text === 'Saved'), 'early Research save feedback');
    assert.ok(authReads.some(entry => entry.caller === 'initResearchSettings' && !entry.ended), 'Research settings response remains held through the save-status timer');
    await new Promise(resolve => setTimeout(resolve, 2250));
    results.earlyResearchSaveTimer = {
      researchSettingsStillHeld: authReads.some(entry => entry.caller === 'initResearchSettings' && !entry.ended),
      pageErrors: pageErrors.slice(timerErrorCount),
      message: await page.locator('#set-researchMsg').textContent(),
    };
    assert.equal(pageErrors.length, timerErrorCount, `early Research save timer must not throw before settings hydration: ${pageErrors.slice(timerErrorCount).join('\n')}`);
    releaseAuth();
    await waitUntil(() => authReads.every(entry => entry.ended), 'timer case settings response release');
    await context.close();

    // Late successful hydration must not replace the visible failure from an
    // early sparse save that completed while the initial GET was held.
    configure({ mode: 'valid', settings: { ...baseSaved, research_endpoint_id: 'fixture-b', research_model: 'research-b' }, holdAuthCallers: ['initResearchSettings'], post: 'http503' });
    ({ page, context } = await openSettings(browser, base, pageErrors));
    await waitUntil(() => authReads.some(entry => entry.caller === 'initResearchSettings' && !entry.ended), 'held Research settings response before failed early save');
    await page.locator('[data-settings-tab="search"]').click();
    await page.locator('#set-researchMaxTokens').fill('5000');
    await page.locator('#set-researchMaxTokens').press('Tab');
    await waitUntil(() => page.locator('#set-researchMsg').textContent().then(text => text === 'Failed to save'), 'early Research save failure feedback');
    assert.equal(await page.locator('#set-researchMsg').textContent(), 'Failed to save');
    assert.deepEqual(posts, [{ research_max_tokens: 5000 }], 'one explicit sparse failed save');
    releaseAuth();
    await waitUntil(() => authReads.every(entry => entry.ended), 'failed-save hydration response release');
    await page.waitForFunction(() =>
      document.querySelector('#set-researchEndpoint').value === 'fixture-b' &&
      document.querySelector('#set-researchModel').value === 'research-b' &&
      document.querySelector('#set-researchMaxTokens').value === '5000'
    );
    results.earlyResearchSaveFailure = {
      message: await page.locator('#set-researchMsg').textContent(),
      posts: structuredClone(posts),
    };
    assert.equal(results.earlyResearchSaveFailure.message, 'Failed to save', 'late hydration must preserve the failed-save feedback');
    await context.close();

    // A Vision enable toggle must not post an unknown saved model as a blank default.
    const unknownSaved = { ...baseSaved, vision_model: 'legacy-vision-model' };
    configure({ mode: 'valid', settings: unknownSaved });
    ({ page, context } = await openSettings(browser, base, pageErrors));
    await waitUntil(() => authReads.length >= 4, 'unknown-model settings response bodies');
    await page.locator('label.admin-switch:has(#set-visionEnabledToggle)').click();
    await waitUntil(() => posts.some(post => Object.prototype.hasOwnProperty.call(post, 'vision_enabled')), 'sparse Vision toggle save');
    exactPost({ vision_enabled: false });
    assert.equal(serverSettings.vision_model, 'legacy-vision-model', 'sparse toggle save preserves an unknown saved Vision model');
    await page.locator('[data-settings-tab="search"]').click();
    await page.locator('#set-researchMaxTokens').fill('5000');
    await page.locator('#set-researchMaxTokens').press('Tab');
    await waitUntil(() => posts.some(post => post.research_max_tokens === 5000), 'sparse Research numeric save', 5000).catch(async error => {
      const state = await page.evaluate(() => ({ value: document.querySelector('#set-researchMaxTokens').value, message: document.querySelector('#set-researchMsg').textContent }));
      throw new Error(`${error.message}; state=${JSON.stringify(state)}; posts=${JSON.stringify(posts)}; paths=${JSON.stringify(requestPaths.filter(request => request.method === 'POST'))}; pageErrors=${JSON.stringify(pageErrors)}`);
    });
    exactPost({ research_max_tokens: 5000 });
    assert.equal(serverSettings.research_endpoint_id, 'fixture-a');
    assert.equal(serverSettings.research_model, 'research-a');
    assert.equal(serverSettings.research_extraction_timeout_seconds, 90);
    releaseAuth();
    await waitUntil(() => authReads.every(entry => entry.ended), 'unknown-model hydration completion');
    results.sparsePreservation = {
      visionModelInFixtureStore: serverSettings.vision_model,
      researchUntouchedFields: {
        endpoint: serverSettings.research_endpoint_id,
        model: serverSettings.research_model,
        extractionTimeout: serverSettings.research_extraction_timeout_seconds,
        extractionConcurrency: serverSettings.research_extraction_concurrency,
        runTimeout: serverSettings.research_run_timeout_seconds,
      },
      posts: structuredClone(posts),
      note: 'Synthetic server applies POST bodies as the production route does: only included keys are updated. This scenario checks sparse persistence; option presentation is tested separately.'
    };
    await context.close();

    // Failed and malformed settings loads do not hydrate defaults; an explicit edit still saves sparsely.
    for (const mode of ['http503', 'invalidJson', 'null', 'array']) {
      configure({ mode: 'valid', holdModels: false, callerModes: { initVisionSettings: mode, initResearchSettings: mode } });
      ({ page, context } = await openSettings(browser, base, pageErrors));
      await waitUntil(() => authReads.length >= 4, `${mode} initial settings reads`);
      const before = await page.evaluate(() => ({
        visionModel: document.querySelector('#set-vlModelSelect').value,
        researchTokens: document.querySelector('#set-researchMaxTokens').value,
      }));
      await page.locator('label.admin-switch:has(#set-visionEnabledToggle)').click();
      await waitUntil(() => posts.some(post => Object.prototype.hasOwnProperty.call(post, 'vision_enabled')), `${mode} sparse save`);
      exactPost({ vision_enabled: false });
      releaseAuth();
      await waitUntil(() => authReads.every(entry => entry.ended), `${mode} responses released`);
      const after = await page.evaluate(() => ({
        visionEnabled: document.querySelector('#set-visionEnabledToggle').checked,
        visionModel: document.querySelector('#set-vlModelSelect').value,
        researchTokens: document.querySelector('#set-researchMaxTokens').value,
      }));
      assert.equal(after.visionEnabled, false, `${mode} must not overwrite the edited toggle`);
      assert.equal(after.visionModel, before.visionModel, `${mode} must not assign a bogus model default`);
      assert.equal(after.researchTokens, before.researchTokens, `${mode} must not assign bogus Research settings`);
      assert.equal(posts.length, 1, `${mode} causes no autosave beyond the explicit control change`);
      results[mode] = { before, after, posts: structuredClone(posts) };
      await context.close();
    }

    assert.deepEqual(externalRequests, [], `unexpected non-loopback requests: ${externalRequests.join(', ')}`);
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
    const result = { pass: true, sourceHashes, externalRequests, pageErrors, results, cleanup: { browserClosed: true, serverClosed: true } };
    if (process.env.RESULT_PATH) fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    authReleased = true;
    authReads.forEach(deliverSettings);
    modelsHeld = false;
    modelReads.forEach(deliverModels);
    if (browser) await browser.close().catch(() => {});
    if (server.listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
