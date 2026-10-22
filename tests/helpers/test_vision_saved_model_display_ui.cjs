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
  'static/js/providers.js': sha('static/js/providers.js'),
  'static/js/settings.js': sha('static/js/settings.js'),
  'static/js/settings/shell.js': sha('static/js/settings/shell.js'),
};
const saved = (model, overrides = {}) => ({
  vision_enabled: true, vision_model: model, vision_model_fallbacks: [],
  default_endpoint_id: 'fixture-a', default_model: 'chat-a',
  utility_endpoint_id: 'fixture-a', utility_model: 'utility-a', utility_model_fallbacks: [],
  research_endpoint_id: 'fixture-a', research_model: 'research-a', research_max_tokens: 4096,
  research_extraction_timeout_seconds: 90, research_extraction_concurrency: 3, research_run_timeout_seconds: 3600,
  research_search_provider: 'searxng', search_provider: 'disabled', search_api_key: '',
  tts_provider: 'disabled', stt_provider: 'disabled',
  ...overrides,
});
const endpoints = [
  { id: 'fixture-a', name: 'Fixture A', is_enabled: true, online: true, models: ['chat-a', 'chat-c', 'utility-a', 'research-a', 'utility-b', 'research-b'], model_type: 'chat' },
  { id: 'fixture-b', name: 'Fixture B', is_enabled: true, online: true, models: ['chat-b', 'utility-a', 'research-a', 'utility-b', 'research-b'], model_type: 'chat' },
];
const inventory = { items: [
  { endpoint_id: 'fixture-a', offline: false, models: ['vision-a', 'vision-b'], models_metadata: { 'utility-a': { supported_reasoning_levels: ['low', 'high'] }, 'utility-b': { supported_reasoning_levels: ['low', 'high'] } } },
  { endpoint_id: 'fixture-b', offline: false, models: ['vision-a', 'vision-b'], models_metadata: { 'utility-a': { supported_reasoning_levels: ['low', 'high'] }, 'utility-b': { supported_reasoning_levels: ['low', 'high'] } } },
] };
let config = { settings: saved('vision-a'), holdSettingsCallers: new Set(), holdVisionSettings: null };
let settingsReads = [];
let modelReads = [];
let requestLog = [];
let posts = [];
let serverSettings = {};
let externalRequests = [];
function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function configure(settings, holdSettingsCallers = [], holdVisionModels = null, holdVisionSettings = null) {
  config = { settings: structuredClone(settings), holdSettingsCallers: new Set(holdSettingsCallers), holdVisionModels, holdVisionSettings };
  settingsReads = [];
  modelReads = [];
  requestLog = [];
  posts = [];
  serverSettings = structuredClone(settings);
}
function deliver(entry) {
  if (entry.done) return;
  entry.done = true;
  if (entry.res.headersSent) entry.res.end(JSON.stringify(config.settings));
  else json(entry.res, config.settings);
}
function deliverModels(entry) {
  if (entry.done) return;
  entry.done = true;
  json(entry.res, inventory);
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
    const entry = { res, done: false, closed: false, aborted: false, caller };
    settingsReads.push(entry);
    res.on('finish', () => { entry.done = true; entry.closed = true; });
    res.on('close', () => { entry.closed = true; entry.aborted = !entry.done; entry.done = true; });
    if (caller === 'initVisionSettings' && config.holdVisionSettings) {
      if (config.holdVisionSettings === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.flushHeaders();
      }
      return;
    }
    if (!config.holdSettingsCallers.has(caller)) deliver(entry);
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
  if (url.pathname === '/api/models') {
    const caller = req.headers['x-fixture-caller'] || 'other';
    const entry = { res, done: false, closed: false, aborted: false, caller, phase: config.holdVisionModels };
    modelReads.push(entry);
    res.on('finish', () => { entry.done = true; entry.closed = true; });
    res.on('close', () => { entry.closed = true; entry.aborted = !entry.done; });
    if (caller === 'initVisionSettings' && config.holdVisionModels) {
      if (config.holdVisionModels === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.flushHeaders();
      }
      return;
    }
    return deliverModels(entry);
  }
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
async function openSettings(browser, base, errors, installClock = false) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/models') && (!init || !init.method || init.method === 'GET')) {
        const stack = new Error().stack || '';
        if (stack.includes('at initVisionSettings (') && stack.includes('settings.js')) {
          const signal = init && init.signal;
          window.__fixtureVisionModelSignals = window.__fixtureVisionModelSignals || [];
          window.__fixtureVisionModelSignals.push(signal || null);
          return nativeFetch(input, { ...(init || {}), headers: { ...((init && init.headers) || {}), 'X-Fixture-Caller': 'initVisionSettings' } });
        }
      }
      if (url.includes('/api/auth/settings') && (!init || !init.method || init.method === 'GET')) {
        const stack = new Error().stack || '';
        const caller = ['initDefaultChat', 'initUtilityModel', 'initVisionSettings', 'initResearchSettings'].find(name => stack.includes(`at ${name} (`)) || 'other';
        if (caller === 'initVisionSettings') {
          window.__fixtureVisionSettingsSignals = window.__fixtureVisionSettingsSignals || [];
          window.__fixtureVisionSettingsSignals.push(init && init.signal ? init.signal : null);
        }
        return nativeFetch(input, { ...(init || {}), headers: { ...((init && init.headers) || {}), 'X-Fixture-Caller': caller } }).then(response => {
          response.clone().json().then(body => {
            window.__fixtureSettingsBodies = window.__fixtureSettingsBodies || [];
            window.__fixtureSettingsBodies.push({ caller, body });
          }).catch(() => {});
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
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window._isAdmin === true);
  if (installClock) await page.clock.install();
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
    const providersSource = fs.readFileSync(path.join(repo, 'static/js/providers.js'), 'utf8');
    const { providerLogo } = await import(`data:text/javascript;base64,${Buffer.from(providersSource).toString('base64')}`);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-service-worker'] });

    configure(saved('vision-a'));
    let { page, context } = await openSettings(browser, base, errors, true);
    await waitFor(() => modelReads.some(entry => entry.caller === 'initVisionSettings' && entry.done), 'normal Vision inventory read completed');
    await page.waitForFunction(() => document.querySelector('#set-vlModelSelect')?.value === 'vision-a', null, { timeout: 12000 }).catch(async error => {
      const select = await page.locator('#set-vlModelSelect').evaluate(node => ({ value: node.value, options: Array.from(node.options).map(option => [option.value, option.textContent]) })).catch(() => null);
      throw new Error(`${error.message}; select=${JSON.stringify(select)}; settings=${JSON.stringify(settingsReads.map(entry => ({ caller: entry.caller, done: entry.done })))}; requests=${JSON.stringify(requestLog.filter(item => item.includes('settings') || item.includes('model')))}; errors=${JSON.stringify(errors)}`);
    });
    const normal = await page.locator('#set-vlModelSelect').evaluate(select => ({ value: select.value, label: select.selectedOptions[0]?.textContent }));
    assert.deepEqual(normal, { value: 'vision-a', label: 'vision-a' });
    await page.waitForFunction(() => document.querySelector('#set-utilityModelSelect')?.value === 'utility-a');
    await page.waitForFunction(() => document.querySelector('#set-researchModel')?.value === 'research-a');
    assert.equal(await page.locator('#set-utilityModelSelect').inputValue(), 'utility-a');
    assert.equal(await page.locator('#set-researchModel').inputValue(), 'research-a');
    assert.equal(await page.locator('#set-defaultModelSelect').inputValue(), 'chat-a', 'Default Chat keeps its configured model');
    assert.equal(posts.length, 0, 'normal inventory selection hydrates without a save');
    await page.clock.fastForward(15000);
    const normalSignalAborted = await page.evaluate(() => window.__fixtureVisionModelSignals?.at(-1)?.aborted ?? null);
    const normalSettingsSignalAborted = await page.evaluate(() => window.__fixtureVisionSettingsSignals?.at(-1)?.aborted ?? null);
    assert.equal(normalSignalAborted, false, 'a normally completed inventory read does not get aborted after its deadline');
    assert.equal(normalSettingsSignalAborted, false, 'a normally completed saved-settings read clears its deadline timer');
    assert.equal(posts.length, 0, 'normal timeout cleanup does not cause a delayed save');
    results.normalSavedModelDeadlineCleanup = { ...normal, signalAbortedAfter15s: normalSignalAborted, settingsSignalAbortedAfter15s: normalSettingsSignalAborted };
    results.normalSavedModel = normal;
    await context.close();
    assert.ok(settingsReads.every(entry => entry.done), 'normal case leaves no held settings responses');

    const defaultUnknown = 'claude-legacy <img src=x>';
    configure(saved('vision-a', { default_model: defaultUnknown }));
    ({ page, context } = await openSettings(browser, base, errors));
    await waitFor(() => settingsReads.some(entry => entry.caller === 'initDefaultChat' && entry.done), 'Default Chat settings response completed');
    await page.waitForFunction(value => document.querySelector('#set-defaultModelSelect').value === value && (window.__fixtureSettingsBodies || []).some(entry => entry.caller === 'initDefaultChat' && entry.body.default_model === value), defaultUnknown);
    const defaultOmitted = await page.locator('#set-defaultModelSelect').evaluate(select => ({
      value: select.value,
      label: select.selectedOptions[0]?.textContent,
      disabled: select.selectedOptions[0]?.disabled,
      matchingOptions: Array.from(select.options).filter(option => option.value === select.value).length,
      imageNodes: select.querySelectorAll('img').length,
    }));
    assert.deepEqual(defaultOmitted, {
      value: defaultUnknown,
      label: defaultUnknown + ' (saved; not in current list)',
      disabled: true,
      matchingOptions: 1,
      imageNodes: 0,
    });
    const defaultLogo = await page.locator('#set-defaultModelSelect-logo').innerHTML();
    const expectedDefaultLogo = await page.evaluate(svg => {
      const container = document.createElement('span');
      container.innerHTML = svg;
      return container.innerHTML;
    }, providerLogo(defaultUnknown));
    assert.equal(defaultLogo, expectedDefaultLogo, 'Default Chat logo matches the retained saved model');
    assert.ok(defaultLogo.includes('<svg'), 'provider logo is shown for the saved-only model');
    assert.equal(posts.length, 0, 'omitted Default Chat model hydration does not save');
    await page.locator('#set-defaultModelSelect').evaluate(select => select.dispatchEvent(new Event('change', { bubbles: true })));
    assert.equal(posts.length, 0, 'Default Chat selectable-model validation rejects the disabled saved-only option');

    const defaultEndpointReads = requestLog.filter(request => request === 'GET /api/model-endpoints').length;
    await page.locator('[data-settings-tab="search"]').click();
    await page.locator('[data-settings-tab="ai"]').click();
    await waitFor(() => requestLog.filter(request => request === 'GET /api/model-endpoints').length > defaultEndpointReads, 'Default Chat same-endpoint passive refresh');
    await page.waitForFunction(value => {
      const select = document.querySelector('#set-defaultModelSelect');
      return select.value === value && select.selectedOptions[0]?.disabled;
    }, defaultUnknown);
    assert.equal(posts.length, 0, 'passive endpoint refresh preserves saved-only Default Chat display without saving');

    await page.locator('#set-defaultModelSelect').selectOption('chat-a');
    await waitFor(() => posts.length === 1, 'explicit known Default Chat model selection');
    assert.deepEqual(posts[0], { default_endpoint_id: 'fixture-a', default_model: 'chat-a' });
    await page.locator('#set-defaultEpSelect').selectOption('fixture-b');
    await waitFor(() => posts.length === 2, 'explicit Default Chat endpoint change');
    assert.deepEqual(posts[1], { default_endpoint_id: 'fixture-b', default_model: 'chat-b' });
    assert.equal(await page.locator('#set-defaultModelSelect').inputValue(), 'chat-b', 'endpoint change uses the existing first selectable model behavior');
    assert.equal(await page.locator('#set-defaultModelSelect').locator('option').evaluateAll((options, value) => options.some(option => option.value === value), defaultUnknown), false);
    results.defaultChatSavedOnlyModel = { initial: defaultOmitted, logoMatchesModel: true, afterRefresh: defaultUnknown, afterKnownSelection: posts[0], afterEndpointChange: posts[1] };
    await context.close();
    assert.ok(settingsReads.every(entry => entry.done), 'Default Chat saved-only case leaves no held settings responses');

    const defaultLateUnknown = 'legacy-late-chat';
    configure(saved('vision-a', { default_endpoint_id: 'fixture-a', default_model: defaultLateUnknown }), ['initDefaultChat']);
    ({ page, context } = await openSettings(browser, base, errors));
    await waitFor(() => settingsReads.some(entry => entry.caller === 'initDefaultChat' && !entry.done), 'Default Chat initial settings response held');
    const defaultHeld = settingsReads.find(entry => entry.caller === 'initDefaultChat' && !entry.done);
    await page.waitForFunction(() => Array.from(document.querySelector('#set-defaultModelSelect').options).some(option => option.value === 'chat-c'));
    await page.locator('#set-defaultModelSelect').selectOption('chat-c');
    await waitFor(() => posts.length === 1, 'new Default Chat model saved while initial GET held');
    assert.equal(defaultHeld.done, false);
    deliver(defaultHeld);
    await waitFor(() => defaultHeld.done, 'Default Chat held settings response released');
    await page.waitForFunction(value => (window.__fixtureSettingsBodies || []).some(entry => entry.caller === 'initDefaultChat' && entry.body.default_model === value), defaultLateUnknown);
    await page.waitForFunction(() => document.querySelector('#set-defaultEpSelect').value === 'fixture-a' && document.querySelector('#set-defaultModelSelect').value === 'chat-c');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(posts.length, 1, 'late Default Chat settings response causes no extra save');
    assert.deepEqual(posts[0], { default_endpoint_id: 'fixture-a', default_model: 'chat-c' });
    results.defaultChatLateResponseAfterEdit = { endpoint: await page.locator('#set-defaultEpSelect').inputValue(), model: await page.locator('#set-defaultModelSelect').inputValue(), posts: structuredClone(posts) };
    await context.close();
    assert.ok(settingsReads.every(entry => entry.done), 'Default Chat late-response case leaves no held settings responses');

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

    const utilityUnknown = 'legacy-utility <img src=x>';
    const researchUnknown = 'legacy-research <img src=x>';
    configure(saved('vision-a', {
      utility_model: utilityUnknown,
      utility_model_fallbacks: [{ endpoint_id: 'fixture-a', model: 'utility-a', reasoning_effort: '' }],
      research_model: researchUnknown,
      research_max_tokens: 5001,
    }));
    ({ page, context } = await openSettings(browser, base, errors));
    await waitFor(() => ['initUtilityModel', 'initResearchSettings'].every(caller => settingsReads.some(entry => entry.caller === caller && entry.done)), 'Utility and Research settings responses completed');
    await page.waitForFunction(() =>
      document.querySelector('#set-utilityEpSelect').value === 'fixture-a' &&
      document.querySelector('#set-utilityFallbacks').textContent.includes('utility-a') &&
      document.querySelector('#set-researchEndpoint').value === 'fixture-a' &&
      document.querySelector('#set-researchMaxTokens').value === '5001'
    );
    const savedPanelModels = await page.evaluate(() => {
      const read = id => {
        const select = document.getElementById(id);
        return { value: select.value, label: select.selectedOptions[0]?.textContent, matchingOptions: Array.from(select.options).filter(option => option.value === select.value).length, imageNodes: select.querySelectorAll('img').length };
      };
      return { utility: read('set-utilityModelSelect'), research: read('set-researchModel') };
    });
    for (const [panel, value] of [['utility', utilityUnknown], ['research', researchUnknown]]) {
      assert.equal(savedPanelModels[panel].value, value, `${panel} retains persisted model omitted by endpoint inventory`);
      assert.equal(savedPanelModels[panel].label, value + ' (saved; not in current list)');
      assert.equal(savedPanelModels[panel].matchingOptions, 1);
      assert.equal(savedPanelModels[panel].imageNodes, 0, `${panel} model label is text, not HTML`);
    }
    assert.equal(posts.length, 0, 'Utility and Research hydration issue no initial saves');

    const endpointReadsBeforeRefresh = requestLog.filter(request => request === 'GET /api/model-endpoints').length;
    await page.locator('[data-settings-tab="search"]').click();
    await page.locator('[data-settings-tab="ai"]').click();
    await waitFor(() => requestLog.filter(request => request === 'GET /api/model-endpoints').length > endpointReadsBeforeRefresh, 'same-endpoint refresh on re-entering AI settings');
    await page.waitForFunction(() => document.querySelector('#set-utilityModelSelect').value === 'legacy-utility <img src=x>' && document.querySelector('#set-researchModel').value === 'legacy-research <img src=x>');
    assert.equal(posts.length, 0, 'same-endpoint inventory refresh preserves untouched saved-only options without writes');

    await page.locator('#set-utilityEpSelect').selectOption('fixture-a');
    await waitFor(() => posts.length === 1, 'same-value Utility endpoint change clears dependent saved-only model');
    assert.deepEqual(posts[0], { utility_endpoint_id: 'fixture-a', utility_model: '', utility_reasoning_effort: '' });
    assert.equal(await page.locator('#set-utilityModelSelect').inputValue(), '', 'same-value Utility endpoint event leaves dependent model blank');
    assert.equal(await page.locator('#set-utilityModelSelect').locator('option').evaluateAll((options, value) => options.some(option => option.value === value), utilityUnknown), false);

    await page.locator('#set-researchEndpoint').selectOption('fixture-a');
    await waitFor(() => posts.length === 2, 'same-value Research endpoint change clears dependent saved-only model');
    assert.deepEqual(posts[1], { research_endpoint_id: 'fixture-a', research_model: '' });
    assert.equal(await page.locator('#set-researchModel').inputValue(), '', 'same-value Research endpoint event leaves dependent model blank');
    assert.equal(await page.locator('#set-researchModel').locator('option').evaluateAll((options, value) => options.some(option => option.value === value), researchUnknown), false);
    results.sameValueEndpointChangeClearsSavedOnlyModel = {
      utilityPayload: structuredClone(posts[0]),
      researchPayload: structuredClone(posts[1]),
      utilityModel: await page.locator('#set-utilityModelSelect').inputValue(),
      researchModel: await page.locator('#set-researchModel').inputValue(),
    };

    const beforeUtilityClear = posts.length;
    await page.locator('#set-utilityModelSelect').selectOption('');
    await waitFor(() => posts.length > beforeUtilityClear, 'explicit Utility model clear');
    assert.deepEqual(posts.at(-1), { utility_model: '', utility_reasoning_effort: '' });
    assert.equal(serverSettings.utility_model, '', 'explicit Utility clear updates only Utility fields');
    assert.equal(await page.locator('#set-utilityModelSelect').locator('option').evaluateAll((options, value) => options.some(option => option.value === value), utilityUnknown), false);

    const beforeResearchClear = posts.length;
    await page.locator('#set-researchModel').selectOption('');
    await waitFor(() => posts.length > beforeResearchClear, 'explicit Deep Research model clear');
    assert.deepEqual(posts.at(-1), { research_model: '' });
    assert.equal(serverSettings.research_model, '', 'explicit Research clear updates only its model');

    await page.locator('#set-utilityEpSelect').selectOption('fixture-b');
    await waitFor(() => posts.some(post => post.utility_endpoint_id === 'fixture-b'), 'explicit Utility endpoint change');
    assert.deepEqual(posts.at(-1), { utility_endpoint_id: 'fixture-b', utility_model: '', utility_reasoning_effort: '' });
    await page.locator('#set-researchEndpoint').selectOption('fixture-b');
    await waitFor(() => posts.some(post => post.research_endpoint_id === 'fixture-b'), 'explicit Deep Research endpoint change');
    assert.deepEqual(posts.at(-1), { research_endpoint_id: 'fixture-b', research_model: '' });
    assert.equal(await page.locator('#set-utilityModelSelect').locator('option').evaluateAll((options, value) => options.some(option => option.value === value), utilityUnknown), false);
    assert.equal(await page.locator('#set-researchModel').locator('option').evaluateAll((options, value) => options.some(option => option.value === value), researchUnknown), false);
    results.utilityAndResearchSavedOnlyModels = {
      beforeRefresh: savedPanelModels,
      afterRefresh: { utility: await page.locator('#set-utilityModelSelect').inputValue(), research: await page.locator('#set-researchModel').inputValue() },
      afterExplicitChanges: { utilityEndpoint: await page.locator('#set-utilityEpSelect').inputValue(), utilityModel: await page.locator('#set-utilityModelSelect').inputValue(), researchEndpoint: await page.locator('#set-researchEndpoint').inputValue(), researchModel: await page.locator('#set-researchModel').inputValue() },
      posts: structuredClone(posts),
    };
    await context.close();
    assert.ok(settingsReads.every(entry => entry.done), 'saved-only model case leaves no held settings responses');

    const lateHydration = [];
    for (const scenario of [
      { caller: 'initUtilityModel', endpointId: 'set-utilityEpSelect', modelId: 'set-utilityModelSelect', endpointKey: 'utility_endpoint_id', modelKey: 'utility_model', model: 'utility-b', settings: { utility_model: 'stale-utility', utility_endpoint_id: 'fixture-a', utility_reasoning_effort: 'low' } },
      { caller: 'initResearchSettings', endpointId: 'set-researchEndpoint', modelId: 'set-researchModel', endpointKey: 'research_endpoint_id', modelKey: 'research_model', model: 'research-b', settings: { research_model: 'stale-research', research_endpoint_id: 'fixture-a', research_max_tokens: 5123 } },
    ]) {
      configure(saved('vision-a', scenario.settings), [scenario.caller]);
      ({ page, context } = await openSettings(browser, base, errors));
      await waitFor(() => settingsReads.some(entry => entry.caller === scenario.caller && !entry.done), `${scenario.caller} settings response held`);
      const held = settingsReads.find(entry => entry.caller === scenario.caller && !entry.done);
      await page.locator(`#${scenario.endpointId}`).selectOption('fixture-a');
      await waitFor(() => posts.some(post => post[scenario.endpointKey] === 'fixture-a'), `${scenario.caller} endpoint selection save`);
      await page.waitForFunction(({ id, value }) => Array.from(document.getElementById(id).options).some(option => option.value === value), { id: scenario.modelId, value: scenario.model });
      await page.locator(`#${scenario.modelId}`).selectOption(scenario.model);
      await waitFor(() => posts.some(post => post[scenario.modelKey] === scenario.model), `${scenario.caller} model selection save`);
      const beforeRelease = await page.locator(`#${scenario.modelId}`).inputValue();
      assert.equal(beforeRelease, scenario.model);
      assert.equal(held.done, false, `${scenario.caller} initial settings response remains held after newer selection`);
      deliver(held);
      await waitFor(() => held.done, `${scenario.caller} stale settings response released`);
      await page.waitForFunction(({ caller, model }) => (window.__fixtureSettingsBodies || []).some(entry => entry.caller === caller && entry.body[model.key] === model.value), { caller: scenario.caller, model: { key: scenario.modelKey, value: scenario.settings[scenario.modelKey] } });
      await page.waitForFunction(({ id, value }) => document.getElementById(id).value === value, { id: scenario.modelId, value: scenario.model });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(posts.length, 2, `${scenario.caller} late GET causes no extra save`);
      assert.deepEqual(posts[0], scenario.caller === 'initUtilityModel'
        ? { utility_endpoint_id: 'fixture-a', utility_model: '', utility_reasoning_effort: '' }
        : { research_endpoint_id: 'fixture-a', research_model: '' });
      assert.deepEqual(posts[1], scenario.caller === 'initUtilityModel'
        ? { utility_model: scenario.model, utility_reasoning_effort: '' }
        : { research_model: scenario.model });
      lateHydration.push({ caller: scenario.caller, selectedBeforeRelease: beforeRelease, selectedAfterRelease: await page.locator(`#${scenario.modelId}`).inputValue(), posts: structuredClone(posts) });
      await context.close();
      assert.ok(settingsReads.every(entry => entry.done), `${scenario.caller} case leaves no held settings responses`);
    }
    results.editedWhileUtilityAndResearchLoadsHeld = lateHydration;

    configure(saved('vision-a'), ['initVisionSettings']);
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

    const visionDeadlineResults = [];
    for (const phase of ['headers', 'body']) {
      configure(saved('vision-b', { vision_model_fallbacks: [{ endpoint_id: 'fixture-a', model: 'vision-a' }] }), [], phase);
      ({ page, context } = await openSettings(browser, base, errors, true));
      await waitFor(() => modelReads.some(entry => entry.caller === 'initVisionSettings' && !entry.done), `Vision model inventory held at ${phase}`);
      const heldModels = modelReads.find(entry => entry.caller === 'initVisionSettings' && !entry.done);
      await waitFor(() => settingsReads.filter(entry => entry.caller !== 'initVisionSettings').every(entry => entry.done), 'all unrelated initial settings reads complete');
      const visionSettingsReadsBefore = settingsReads.filter(entry => entry.caller === 'initVisionSettings').length;
      const beforeTimeout = await page.evaluate(() => ({
        model: document.querySelector('#set-vlModelSelect').value,
        modelDisabled: document.querySelector('#set-vlModelSelect').disabled,
        fallbackRows: document.querySelectorAll('#set-visionFallbacks .settings-fallback-row').length,
        message: document.querySelector('#set-visionSettingsMsg').textContent,
      }));
      assert.equal(beforeTimeout.model, '', 'Vision remains at Auto-detect while inventory is pending');
      assert.equal(beforeTimeout.modelDisabled, false, 'the model control is not marked disabled during the inventory wait');
      assert.equal(beforeTimeout.fallbackRows, 0);
      assert.equal(visionSettingsReadsBefore, 0, 'saved Vision settings read waits for inventory completion');
      assert.equal(posts.length, 0);

      await page.clock.fastForward(15000);
      await waitFor(() => heldModels.closed, `${phase} Vision inventory request aborted by its local deadline`);
      assert.equal(heldModels.aborted, true, `${phase} held request is aborted, not merely hidden`);
      const signalAborted = await page.evaluate(() => window.__fixtureVisionModelSignals?.at(-1)?.aborted ?? false);
      assert.equal(signalAborted, true);
      await waitFor(() => settingsReads.some(entry => entry.caller === 'initVisionSettings' && entry.done), 'saved Vision settings read resumes after inventory timeout');
      await page.waitForFunction(() => document.querySelector('#set-vlModelSelect').value === 'vision-b');
      const recovered = await page.evaluate(() => ({
        model: document.querySelector('#set-vlModelSelect').value,
        fallbacks: Array.from(document.querySelectorAll('#set-visionFallbacks .settings-fallback-row')).map(row => Array.from(row.querySelectorAll('select')).slice(0, 2).map(select => select.value)),
        message: document.querySelector('#set-visionSettingsMsg').textContent,
      }));
      assert.deepEqual(recovered.fallbacks, [['fixture-a', 'vision-a']], 'saved fallback is rendered after the timed-out inventory request');
      assert.equal(recovered.model, 'vision-b');
      assert.equal(posts.length, 0, 'timeout and recovery do not save settings');
      visionDeadlineResults.push({ phase, beforeTimeout, signalAborted, recovered });
      await context.close();
    }
    results.visionInventoryDeadline = visionDeadlineResults;

    const visionSettingsDeadlineResults = [];
    for (const phase of ['headers', 'body']) {
      configure(saved('vision-b', { vision_model_fallbacks: [{ endpoint_id: 'fixture-a', model: 'vision-a' }] }), [], null, phase);
      ({ page, context } = await openSettings(browser, base, errors, true));
      await waitFor(() => settingsReads.some(entry => entry.caller === 'initVisionSettings' && !entry.done), `Vision saved-settings GET held at ${phase}`);
      const heldSettings = settingsReads.find(entry => entry.caller === 'initVisionSettings');
      await waitFor(() => modelReads.some(entry => entry.caller === 'initVisionSettings' && entry.done), 'Vision model inventory completes before settings read');
      await waitFor(() => settingsReads.filter(entry => entry.caller !== 'initVisionSettings').every(entry => entry.done), 'all unrelated settings reads complete before Vision timeout');
      if (phase === 'body') assert.equal(heldSettings.res.headersSent, true, 'body case sends headers before holding JSON');
      else assert.equal(heldSettings.res.headersSent, false, 'header case holds before response headers');
      const beforeTimeout = await page.evaluate(() => ({
        model: document.querySelector('#set-vlModelSelect').value,
        label: document.querySelector('#set-vlModelSelect').selectedOptions[0]?.textContent || '',
        fallbackRows: document.querySelectorAll('#set-visionFallbacks .settings-fallback-row').length,
        message: document.querySelector('#set-visionSettingsMsg').textContent,
      }));
      assert.equal(beforeTimeout.model, '', 'saved model remains default-looking while settings GET waits');
      assert.equal(beforeTimeout.label, 'Auto-detect');
      assert.equal(beforeTimeout.fallbackRows, 0);
      assert.equal(beforeTimeout.message, '');
      assert.equal(posts.length, 0);

      await page.clock.fastForward(15000);
      await waitFor(() => heldSettings.closed, `${phase} Vision saved-settings request closes at its deadline`);
      await page.waitForFunction(() => document.querySelector('#set-visionSettingsMsg')?.textContent === 'Could not load saved Vision settings.');
      const afterTimeout = await page.evaluate(() => ({
        model: document.querySelector('#set-vlModelSelect').value,
        fallbackRows: document.querySelectorAll('#set-visionFallbacks .settings-fallback-row').length,
        message: document.querySelector('#set-visionSettingsMsg').textContent,
        signalAborted: window.__fixtureVisionSettingsSignals?.at(-1)?.aborted ?? null,
        consumedBodies: (window.__fixtureSettingsBodies || []).filter(entry => entry.caller === 'initVisionSettings').length,
      }));
      assert.equal(heldSettings.aborted, true, 'deadline aborts the actual held HTTP request');
      assert.equal(afterTimeout.signalAborted, true);
      assert.equal(afterTimeout.consumedBodies, 0, 'the held settings response body was not consumed before abort');
      assert.equal(afterTimeout.model, '');
      assert.equal(afterTimeout.fallbackRows, 0);
      assert.equal(afterTimeout.message, 'Could not load saved Vision settings.');
      assert.equal(posts.length, 0, 'load timeout does not post settings');
      visionSettingsDeadlineResults.push({ phase, beforeTimeout, afterTimeout, request: { closed: heldSettings.closed, aborted: heldSettings.aborted } });
      await context.close();
      assert.ok(settingsReads.every(entry => entry.done), `${phase} Vision settings timeout leaves no held requests`);
    }

    configure(saved('vision-a'), [], null, 'body');
    ({ page, context } = await openSettings(browser, base, errors, true));
    await waitFor(() => settingsReads.some(entry => entry.caller === 'initVisionSettings' && !entry.done), 'Vision settings body held for late edit control');
    const lateEditHeldSettings = settingsReads.find(entry => entry.caller === 'initVisionSettings');
    await waitFor(() => modelReads.some(entry => entry.caller === 'initVisionSettings' && entry.done), 'Vision inventory completes before late edit');
    await page.clock.fastForward(14000);
    await page.locator('#set-vlModelSelect').selectOption('vision-b');
    await waitFor(() => posts.length === 1, 'user model edit saves before settings-read deadline');
    await page.waitForFunction(() => document.querySelector('#set-visionSettingsMsg')?.textContent === 'Saved');
    assert.deepEqual(posts[0], { vision_model: 'vision-b' });
    await page.clock.fastForward(1000);
    await waitFor(() => lateEditHeldSettings.closed, 'pending settings read aborts after newer model save');
    await page.waitForFunction(() => document.querySelector('#set-visionSettingsMsg')?.textContent === 'Saved');
    assert.equal(lateEditHeldSettings.aborted, true);
    assert.equal(await page.locator('#set-vlModelSelect').inputValue(), 'vision-b');
    assert.equal(posts.length, 1, 'timeout does not add a write after the user edit');
    visionSettingsDeadlineResults.push({ phase: 'body-after-user-edit', selectedModel: await page.locator('#set-vlModelSelect').inputValue(), message: await page.locator('#set-visionSettingsMsg').textContent(), posts: structuredClone(posts), requestAborted: lateEditHeldSettings.aborted });
    await context.close();
    assert.ok(settingsReads.every(entry => entry.done), 'late-edit case leaves no held settings requests');
    results.visionSavedSettingsDeadline = visionSettingsDeadlineResults;

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
