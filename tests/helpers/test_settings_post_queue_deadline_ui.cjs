const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || '/run/media/nerdrx/Lex/novum-xenium/node_modules/playwright');

const repo = path.resolve(process.env.SOURCE_ROOT || path.join(__dirname, '../..'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const candidateSettingsJs = fs.readFileSync(path.join(repo, 'static/js/settings.js'));
const sourceHashes = {
  'static/index.html': hash(path.join(repo, 'static/index.html')),
  'static/js/settings.js': crypto.createHash('sha256').update(candidateSettingsJs).digest('hex'),
  'static/js/settings/api.js': hash(path.join(repo, 'static/js/settings/api.js')),
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
let postHoldSequence = 0;
let postSequence = 0;
let heldPosts = [];
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
function configure({ mode = 'valid', settings = baseSaved, holdModels = false, holdAuthCallers = [], callerModes = {}, post = 'valid', holdPostSequence: holdSequence = 0 } = {}) {
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
  postHoldSequence = holdSequence;
  postSequence = 0;
  heldPosts = [];
}
function releaseHeldPost(sequence) {
  const entry = heldPosts.find(item => item.sequence === sequence);
  assert(entry, `no held POST ${sequence}`);
  entry.ended = true;
  if (entry.res.destroyed) return;
  Object.assign(serverSettings, entry.body);
  sendJson(entry.res, { ok: true });
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
      const sequence = ++postSequence;
      if (sequence === postHoldSequence) {
        const entry = { sequence, body: parsed, res, ended: false, closed: false, finished: false };
        res.on('close', () => { entry.closed = true; entry.finished = res.writableFinished; });
        heldPosts.push(entry);
        return;
      }
      if (postMode === 'http503') return sendJson(res, { detail: 'synthetic save failure' }, 503);
      if (postMode === 'http403') return sendJson(res, { detail: 'synthetic admin denial' }, 403);
      Object.assign(serverSettings, parsed);
      Object.assign(authSnapshot, parsed);
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
  if (relative === 'js/settings.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    return res.end(candidateSettingsJs);
  }
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
async function trackAbortControllers(page) {
  await page.evaluate(() => {
    const NativeAbortController = window.AbortController;
    window.__settingsControllers = [];
    window.AbortController = class extends NativeAbortController {
      constructor() {
        super();
        this.wasAborted = false;
        this.signal.addEventListener('abort', () => { this.wasAborted = true; });
        window.__settingsControllers.push(this);
      }
    };
  });
}
async function trackSettingsReads(page) {
  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__settingsGetCount = 0;
    window.fetch = function(input, init = {}) {
      const url = typeof input === 'string' ? input : input.url;
      const method = init.method || 'GET';
      if (url.endsWith('/api/auth/settings') && method === 'GET') window.__settingsGetCount += 1;
      return nativeFetch(input, init);
    };
  });
}
async function primeSettingsCache(page) {
  await page.evaluate(async () => {
    const config = await import('/static/js/appConfig.js');
    await config.getSettings();
  });
}
(async () => {
  let browser;
  const pageErrors = [];
  const results = {};
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-service-worker'] });
    configure({ holdPostSequence: 1 });
    const { page, context } = await openSettings(browser, base, pageErrors);
    await page.locator('[data-settings-tab="ai"]').click();
    await page.waitForFunction(() => [...document.querySelector('#set-vlModelSelect').options].some(option => option.value === 'vision-b'));
    await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') });
    await trackAbortControllers(page);

    await page.locator('#set-vlModelSelect').selectOption('vision-b');
    await waitUntil(() => heldPosts.some(entry => entry.sequence === 1), 'first Vision POST reaches synthetic server and is held');
    await page.locator('#set-vlModelSelect').selectOption('vision-a');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(posts.length, 1, 'second explicit save remains queued while first POST is held');
    assert.equal(await page.locator('#set-visionSettingsMsg').textContent(), 'Saving…');

    await page.clock.fastForward(15001);
    await waitUntil(() => posts.length === 2, 'queued second Vision POST starts after first response settles');
    assert.deepEqual(posts, [{ vision_model: 'vision-b' }, { vision_model: 'vision-a' }], 'writes remain ordered and sparse');
    await waitUntil(() => heldPosts[0].closed, 'aborted first response closes its synthetic connection');
    assert.equal(heldPosts[0].finished, false, 'first response was aborted before the server completed it');
    assert.deepEqual(await page.evaluate(() => window.__settingsControllers.map(controller => controller.wasAborted)), [true, false], 'only the held request is aborted; the queued explicit edit succeeds');
    assert.equal(serverSettings.vision_model, 'vision-a');
    results.heldPostQueue = {
      firstPostHeldAtServer: true,
      queuedEditDidNotReachServerBeforeRelease: true,
      posts: structuredClone(posts),
      clock: 'Playwright clock advanced 15001ms; no 15-second wall wait.',
      firstRequestAborted: heldPosts[0].closed && !heldPosts[0].finished,
      finalServerValue: serverSettings.vision_model,
      secondRequestWasTheExplicitQueuedEdit: true,
      autoRetryObserved: false,
    };
    await context.close();

    configure({ holdPostSequence: 1 });
    const standalone = await openSettings(browser, base, pageErrors);
    await standalone.page.locator('[data-settings-tab="ai"]').click();
    await standalone.page.waitForFunction(() => [...document.querySelector('#set-vlModelSelect').options].some(option => option.value === 'vision-b'));
    await trackSettingsReads(standalone.page);
    await primeSettingsCache(standalone.page);
    const settingsReadsBeforeTimeout = await standalone.page.evaluate(() => window.__settingsGetCount);
    await standalone.page.clock.install({ time: new Date('2026-10-21T12:00:00Z') });
    await trackAbortControllers(standalone.page);
    await standalone.page.locator('#set-vlModelSelect').selectOption('vision-b');
    await waitUntil(() => heldPosts.some(entry => entry.sequence === 1), 'standalone POST reaches synthetic server and is held');
    await standalone.page.clock.fastForward(15001);
    await standalone.page.waitForFunction(() => document.querySelector('#set-visionSettingsMsg').textContent === 'Failed to save');
    assert.equal(await standalone.page.locator('#set-visionSettingsMsg').textContent(), 'Failed to save', 'standalone timeout shows exact failure feedback');
    assert.equal(posts.length, 1, 'timeout does not create a retry');
    assert.deepEqual(await standalone.page.evaluate(() => window.__settingsControllers.map(controller => controller.wasAborted)), [true]);
    await primeSettingsCache(standalone.page);
    assert.equal(await standalone.page.evaluate(() => window.__settingsGetCount), settingsReadsBeforeTimeout + 1, 'timeout invalidates cached settings in finally');
    results.standaloneTimeout = { posts: structuredClone(posts), message: await standalone.page.locator('#set-visionSettingsMsg').textContent(), autoRetryObserved: false, clock: '15001ms simulated', settingsCacheRefetchedAfterTimeout: true };
    await standalone.context.close();

    configure();
    const successPage = await openSettings(browser, base, pageErrors);
    await trackSettingsReads(successPage.page);
    await primeSettingsCache(successPage.page);
    const settingsReadsBeforeSuccess = await successPage.page.evaluate(() => window.__settingsGetCount);
    await successPage.page.clock.install({ time: new Date('2026-10-21T12:00:00Z') });
    await trackAbortControllers(successPage.page);
    const success = await successPage.page.evaluate(async () => {
      const { postSettings } = await import('/static/js/settings/api.js');
      const response = await postSettings({ vision_model: 'vision-b' });
      const body = await response.json();
      const config = await import('/static/js/appConfig.js');
      const settings = await config.getSettings();
      return { status: response.status, body, refreshedSettingsModel: settings.vision_model, reads: window.__settingsGetCount };
    });
    assert.deepEqual(success, { status: 200, body: { ok: true }, refreshedSettingsModel: 'vision-b', reads: settingsReadsBeforeSuccess + 1 }, 'successful response body remains readable and settings cache is invalidated');
    await successPage.page.clock.fastForward(15001);
    assert.deepEqual(await successPage.page.evaluate(() => window.__settingsControllers.map(controller => controller.wasAborted)), [false], 'successful request timer is cleared without aborting response');
    await successPage.context.close();

    configure({ post: 'http403' });
    const denied = await openSettings(browser, base, pageErrors);
    await trackSettingsReads(denied.page);
    await primeSettingsCache(denied.page);
    const settingsReadsBefore403 = await denied.page.evaluate(() => window.__settingsGetCount);
    await denied.page.clock.install({ time: new Date('2026-10-21T12:00:00Z') });
    await trackAbortControllers(denied.page);
    const forbidden = await denied.page.evaluate(async () => {
      const { postSettings } = await import('/static/js/settings/api.js');
      try { await postSettings({ vision_model: 'vision-b' }); return null; }
      catch (error) { return { status: error.status, message: error.message }; }
    });
    assert.deepEqual(forbidden, { status: 403, message: 'Admin access is required to change these settings.' });
    assert.match(await denied.page.locator('#toast').textContent(), /Admin access is required to change these settings\./, '403 still invokes showError');
    await primeSettingsCache(denied.page);
    assert.equal(await denied.page.evaluate(() => window.__settingsGetCount), settingsReadsBefore403 + 1, '403 invalidates cached settings in finally');
    await denied.page.clock.fastForward(15001);
    assert.deepEqual(await denied.page.evaluate(() => window.__settingsControllers.map(controller => controller.wasAborted)), [false], '403 response timer is cleared and status remains available');
    results.successAnd403 = { successResponseBody: success.body, successfulSettingsCacheRefetched: true, forbidden, showErrorToast: await denied.page.locator('#toast').textContent(), forbiddenSettingsCacheRefetched: true, completedRequestTimersAbortedLater: false };
    await denied.context.close();
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
    heldPosts.forEach(entry => { if (!entry.ended) releaseHeldPost(entry.sequence); });
    if (browser) await browser.close().catch(() => {});
    if (server.listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
