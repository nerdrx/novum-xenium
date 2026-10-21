const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || '/run/media/nerdrx/Lex/novum-xenium/node_modules/playwright');

const repo = path.resolve(process.env.SOURCE_ROOT || path.join(__dirname, '../..'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex');
const sourceHashes = {
  'static/index.html': sha('static/index.html'),
  'static/js/settings.js': sha('static/js/settings.js'),
  'static/js/settings/shell.js': sha('static/js/settings/shell.js'),
};
const saved = model => ({
  vision_enabled: true, vision_model: model, vision_model_fallbacks: [],
  default_endpoint_id: 'fixture-a', default_model: 'chat-a',
  utility_endpoint_id: 'fixture-a', utility_model: 'utility-a', utility_model_fallbacks: [],
  research_endpoint_id: 'fixture-a', research_model: 'research-a', research_max_tokens: 4096,
  research_extraction_timeout_seconds: 90, research_extraction_concurrency: 3, research_run_timeout_seconds: 3600,
  research_search_provider: 'searxng', search_provider: 'disabled', search_api_key: '',
  tts_provider: 'disabled', stt_provider: 'disabled',
});
const endpoints = [
  { id: 'fixture-a', name: 'Fixture A', is_enabled: true, online: true, models: ['chat-a'], model_type: 'chat' },
  { id: 'fixture-b', name: 'Fixture B', is_enabled: true, online: true, models: ['chat-b'], model_type: 'chat' },
];
const inventory = { items: [
  { endpoint_id: 'fixture-a', offline: false, models: ['vision-a', 'vision-b'], models_metadata: {} },
  { endpoint_id: 'fixture-b', offline: false, models: ['vision-a', 'vision-b'], models_metadata: {} },
] };
let config = { settings: saved('vision-a'), holdVision: false };
let settingsReads = [];
let requestLog = [];
let posts = [];
let serverSettings = {};
let externalRequests = [];
function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function configure(settings, holdVision = false) {
  config = { settings: structuredClone(settings), holdVision };
  settingsReads = [];
  requestLog = [];
  posts = [];
  serverSettings = structuredClone(settings);
}
function deliver(entry) {
  if (entry.done) return;
  entry.done = true;
  json(entry.res, config.settings);
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requestLog.push(`${req.method} ${url.pathname}${url.search}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8').replaceAll('{{CSP_NONCE}}', 'fixture-nonce'));
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'GET') {
    const caller = req.headers['x-fixture-caller'] || 'other';
    const entry = { res, done: false, caller };
    settingsReads.push(entry);
    if (!config.holdVision || caller !== 'initVisionSettings') deliver(entry);
    return;
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      posts.push(parsed);
      Object.assign(serverSettings, parsed);
      json(res, { ok: true });
    });
    return;
  }
  if (url.pathname === '/api/auth/status') return json(res, { username: 'synthetic', is_admin: true, privileges: {} });
  if (url.pathname === '/api/auth/features') return json(res, {});
  if (url.pathname === '/api/model-endpoints') return json(res, endpoints);
  if (url.pathname === '/api/models') return json(res, inventory);
  if (url.pathname === '/api/default-chat') return json(res, {});
  if (url.pathname.startsWith('/api/')) return json(res, {});
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
const waitFor = async (predicate, label, timeout = 15000) => {
  const until = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
async function openSettings(browser, base, errors) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/auth/settings') && (!init || !init.method || init.method === 'GET')) {
        const stack = new Error().stack || '';
        const caller = /initVisionSettings/.test(stack) ? 'initVisionSettings' : 'other';
        return nativeFetch(input, { ...(init || {}), headers: { ...((init && init.headers) || {}), 'X-Fixture-Caller': caller } });
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
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window._isAdmin === true);
  await page.locator('#user-bar-settings').click();
  await page.locator('#settings-modal:not(.hidden)').waitFor({ state: 'visible' });
  await page.locator('[data-settings-tab="ai"]').click();
  return { page, context };
}

(async () => {
  let browser;
  const errors = [];
  const results = {};
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-service-worker'] });

    configure(saved('vision-a'));
    let { page, context } = await openSettings(browser, base, errors);
    await page.waitForFunction(() => document.querySelector('#set-vlModelSelect')?.value === 'vision-a', null, { timeout: 12000 }).catch(async error => {
      const select = await page.locator('#set-vlModelSelect').evaluate(node => ({ value: node.value, options: Array.from(node.options).map(option => [option.value, option.textContent]) })).catch(() => null);
      throw new Error(`${error.message}; select=${JSON.stringify(select)}; settings=${JSON.stringify(settingsReads.map(entry => ({ caller: entry.caller, done: entry.done })))}; requests=${JSON.stringify(requestLog.filter(item => item.includes('settings') || item.includes('model')))}; errors=${JSON.stringify(errors)}`);
    });
    const normal = await page.locator('#set-vlModelSelect').evaluate(select => ({ value: select.value, label: select.selectedOptions[0]?.textContent }));
    assert.deepEqual(normal, { value: 'vision-a', label: 'vision-a' });
    assert.equal(posts.length, 0, 'normal inventory selection hydrates without a save');
    results.normalSavedModel = normal;
    await context.close();
    assert.ok(settingsReads.every(entry => entry.done), 'normal case leaves no held settings responses');

    const unknown = 'legacy-vision-model <img src=x>';
    configure(saved(unknown));
    ({ page, context } = await openSettings(browser, base, errors));
    await page.waitForFunction(() => document.querySelector('#set-vlModelSelect').value === 'legacy-vision-model <img src=x>');
    const displayed = await page.locator('#set-vlModelSelect').evaluate(select => ({
      value: select.value,
      label: select.selectedOptions[0]?.textContent,
      selectedIndex: select.selectedIndex,
      matchingOptions: Array.from(select.options).filter(option => option.value === 'legacy-vision-model <img src=x>').length,
      imageNodes: select.querySelectorAll('img').length,
    }));
    assert.equal(displayed.value, unknown);
    assert.equal(displayed.label, unknown + ' (saved; not in current list)');
    assert.equal(displayed.matchingOptions, 1);
    assert.equal(displayed.imageNodes, 0);
    assert.ok(displayed.selectedIndex >= 0);
    assert.equal(posts.length, 0, 'unknown saved-model hydration does not write');
    results.unknownSavedModel = displayed;
    await page.locator('label.admin-switch:has(#set-visionEnabledToggle)').click();
    await waitFor(() => posts.length === 1, 'sparse Vision enable toggle');
    assert.deepEqual(posts[0], { vision_enabled: false });
    assert.equal(serverSettings.vision_model, unknown, 'partial toggle save retains saved model');
    await page.locator('#set-vlModelSelect').selectOption('');
    await waitFor(() => posts.length === 2, 'explicit Auto-detect change');
    assert.deepEqual(posts[1], { vision_model: '' });
    assert.equal(serverSettings.vision_model, '', 'explicit Auto-detect selection clears model');
    await context.close();
    assert.ok(settingsReads.every(entry => entry.done), 'unknown-model case leaves no held settings responses');

    configure(saved('vision-a'), true);
    ({ page, context } = await openSettings(browser, base, errors));
    await waitFor(() => settingsReads.some(entry => entry.caller === 'initVisionSettings' && !entry.done), `held initial Vision settings response; callers=${JSON.stringify(settingsReads.map(entry => entry.caller))}`);
    await page.waitForFunction(() => Array.from(document.querySelector('#set-vlModelSelect').options).some(option => option.value === 'vision-b'));
    await page.locator('#set-vlModelSelect').selectOption('vision-b');
    await waitFor(() => posts.length === 1, 'immediate Vision selection save');
    assert.deepEqual(posts[0], { vision_model: 'vision-b' });
    const beforeRelease = await page.locator('#set-vlModelSelect').inputValue();
    assert.equal(beforeRelease, 'vision-b');
    settingsReads.filter(entry => !entry.done).forEach(deliver);
    await waitFor(() => settingsReads.every(entry => entry.done), 'held Vision settings response release');
    await page.waitForFunction(() => document.querySelector('#set-vlModelSelect').value === 'vision-b');
    assert.equal(posts.length, 1, 'late hydration does not generate an extra save');
    results.editedWhileVisionLoadHeld = { beforeRelease, afterRelease: await page.locator('#set-vlModelSelect').inputValue(), posts: structuredClone(posts) };
    await context.close();

    assert.deepEqual(externalRequests, [], `non-fixture requests: ${externalRequests.join(', ')}`);
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    const result = { pass: true, sourceHashes, externalRequests, pageErrors: errors, results, cleanup: { browserClosed: true, serverClosed: true } };
    if (process.env.RESULT_PATH) fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    settingsReads.forEach(deliver);
    if (browser) await browser.close().catch(() => {});
    if (server.listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
