// Exercise image-settings startup reads and controls with synthetic loopback responses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(repo, 'static/js/settings/imageModels.js'), 'utf8');
const start = source.indexOf('export async function initImageSettings(');
assert(start >= 0, 'could not locate image settings initializer');
const initializer = source.slice(start).replace('export async function initImageSettings', 'async function initImageSettings');
const settings = { image_model: 'gpt-image-b@Provider B', image_quality: 'high', image_gen_enabled: true };
const endpoints = [{ id: 'b', name: 'Provider B', is_enabled: true, model_type: 'image', models: ['gpt-image-b'] }];
const pending = new Map();
const observed = [];
const externalRequests = [];
const pageErrors = [];
let browser;
let context;
const html = '<!doctype html><meta charset="utf-8"><body>' +
  '<div class="admin-card"><h2>Image Generation<label class="admin-switch">' +
  '<input type="checkbox" id="set-imgEnabledToggle" disabled><span class="admin-slider"></span></label></h2>' +
  '<label for="set-imgModelSelect">Model</label><select id="set-imgModelSelect" disabled><option value="">Auto-detect</option></select>' +
  '<label for="set-imgQualitySelect">Quality</label><select id="set-imgQualitySelect" disabled>' +
  '<option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select>' +
  '<div id="set-imgBackendMsg" role="status"></div>' +
  '<div id="set-imgSettingsMsg" role="status" aria-live="polite">Loading saved image settings…</div></div>' +
  '<script type="module" src="/fixture.js"></script></body>';
const sendJson = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const cookieScenario = /(?:^|;\s*)fixture_case=([^;]+)/.exec(req.headers.cookie || '');
  const scenario = url.searchParams.get('case') || (cookieScenario && cookieScenario[1]) || 'normal';
  observed.push(req.method + ' ' + url.pathname + '?case=' + scenario);
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'fixture_case=' + scenario + '; Path=/' });
    return res.end(html);
  }
  if (url.pathname === '/fixture.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end([
      'const el = id => document.getElementById(id);',
      'const sortModelIds = values => [...values].sort();',
      'const _registerAiEndpointRefresh = fn => { window.__refreshImageEndpoints = fn; };',
      'window.__imageSaveCalls = [];',
      'const _postSettings = snapshot => { window.__imageSaveCalls.push({ ...snapshot }); return Promise.resolve({ ok: true, status: 200 }); };',
      initializer,
      'window.__imageInit = initImageSettings({ registerEndpointRefresh: _registerAiEndpointRefresh });',
      'window.__imageInit.then(() => { window.__imageSettingsReady = true; }, error => { window.__imageInitError = String(error); });',
    ].join('\n'));
  }
  if (url.pathname === '/api/model-endpoints') {
    if (scenario === 'endpoint-headers' || scenario === 'endpoint-body') return holdResponse('endpoint', scenario, res);
    if (scenario === 'endpoint-503') return sendJson(res, { error: 'synthetic failure' }, 503);
    if (scenario === 'endpoint-invalid') return sendJson(res, null);
    return sendJson(res, endpoints);
  }
  if (url.pathname === '/api/auth/settings') {
    if (scenario === 'settings-headers' || scenario === 'settings-body' || scenario === 'early-click') return holdResponse('settings', scenario, res);
    if (scenario === 'settings-503') return sendJson(res, { detail: 'synthetic failure' }, 503);
    if (scenario === 'settings-malformed') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end('{broken');
    }
    if (scenario === 'settings-null') return sendJson(res, null);
    if (scenario === 'settings-array') return sendJson(res, []);
    return sendJson(res, settings);
  }
  res.writeHead(404); return res.end('fixture not found');
});

function holdResponse(kind, scenario, res) {
  const item = { res, closed: false, ended: false, headersSent: false };
  res.on('finish', () => { item.ended = true; });
  res.on('close', () => { item.closed = true; });
  if (scenario.endsWith('-body') || scenario === 'early-click') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.flushHeaders();
    item.headersSent = true;
  }
  pending.set(kind + ':' + scenario, item);
}
async function waitFor(predicate, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function openPage(origin, scenario, useClock = false) {
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  if (useClock) await page.clock.install();
  await page.goto(origin + '/?case=' + scenario, { waitUntil: 'domcontentloaded' });
  return page;
}
async function assertDisabled(page) {
  assert.equal(await page.locator('#set-imgEnabledToggle').isDisabled(), true);
  assert.equal(await page.locator('#set-imgModelSelect').isDisabled(), true);
  assert.equal(await page.locator('#set-imgQualitySelect').isDisabled(), true);
}
async function clickVisibleDisabledSwitch(page) {
  const box = await page.locator('label.admin-switch').boundingBox();
  assert(box, 'image enable switch is visible');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
async function assertFailure(page) {
  await page.waitForFunction(() => document.querySelector('#set-imgSettingsMsg').textContent.includes('Reload the page'));
  assert.match(await page.locator('#set-imgSettingsMsg').textContent(), /Could not load saved image settings/);
  await assertDisabled(page);
  assert.equal(await page.locator('.admin-card').evaluate(node => node.style.opacity), '',
    'a load failure is not presented as a user-disabled image setting');
  await clickVisibleDisabledSwitch(page);
  assert.equal(await page.locator('#set-imgEnabledToggle').isChecked(), false,
    'visible switch remains inert after a failed load');
  assert.equal(await page.evaluate(() => window.__imageSaveCalls.length), 0);
  await page.evaluate(() => {
    const toggle = document.getElementById('set-imgEnabledToggle');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    document.getElementById('set-imgQualitySelect').dispatchEvent(new Event('change'));
  });
  assert.equal(await page.evaluate(() => window.__imageSaveCalls.length), 0, 'failed initialization cannot post fallback snapshots');
}
async function finishPage(page) { await page.close(); }

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu'] });
    context = await browser.newContext();
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { externalRequests.push(url.href); return route.abort(); }
      return route.continue();
    });

    const normal = await openPage(origin, 'normal', true);
    await normal.waitForFunction(() => window.__imageSettingsReady === true);
    assert.equal(await normal.locator('#set-imgModelSelect').inputValue(), 'gpt-image-b@Provider B');
    assert.equal(await normal.locator('#set-imgQualitySelect').inputValue(), 'high');
    assert.equal(await normal.locator('#set-imgEnabledToggle').isChecked(), true);
    assert.equal(await normal.locator('#set-imgEnabledToggle').isDisabled(), false);
    const normalReadCount = observed.length;
    await normal.clock.fastForward(15000);
    assert.equal(observed.length, normalReadCount, 'completed reads do not retry or re-fire when their timeout expires');
    assert.equal(await normal.locator('#set-imgSettingsMsg').textContent(), '');
    assert.equal(await normal.locator('#set-imgEnabledToggle').isDisabled(), false);
    await normal.locator('label.admin-switch').click();
    await normal.waitForFunction(() => window.__imageSaveCalls.length === 1);
    assert.deepEqual(await normal.evaluate(() => window.__imageSaveCalls[0]), {
      image_gen_enabled: false, image_model: 'gpt-image-b@Provider B', image_quality: 'high',
    });
    await finishPage(normal);

    for (const scenario of ['settings-503', 'settings-malformed', 'settings-null', 'settings-array']) {
      const page = await openPage(origin, scenario);
      await assertFailure(page);
      await finishPage(page);
    }

    const endpointFailure = await openPage(origin, 'endpoint-503');
    await endpointFailure.waitForFunction(() => window.__imageSettingsReady === true);
    assert.equal(await endpointFailure.locator('#set-imgModelSelect').isDisabled(), false,
      'inventory failure alone does not block a successful settings read');
    assert.equal(await endpointFailure.locator('#set-imgModelSelect').inputValue(), 'gpt-image-b@Provider B');
    assert.match(await endpointFailure.locator('#set-imgModelSelect option:checked').textContent(), /saved; not listed/);
    assert.equal(await endpointFailure.evaluate(() => window.__imageSaveCalls.length), 0);
    await finishPage(endpointFailure);

    const heldEarly = await openPage(origin, 'early-click');
    await waitFor(() => pending.has('settings:early-click'), 'held settings body');
    assert.equal(pending.get('settings:early-click').headersSent, true);
    await assertDisabled(heldEarly);
    await clickVisibleDisabledSwitch(heldEarly);
    assert.equal(await heldEarly.locator('#set-imgEnabledToggle').isChecked(), false, 'visible switch click cannot change disabled control');
    assert.equal(await heldEarly.evaluate(() => window.__imageSaveCalls.length), 0);
    pending.get('settings:early-click').res.end(JSON.stringify(settings));
    await heldEarly.waitForFunction(() => window.__imageSettingsReady === true);
    assert.equal(await heldEarly.locator('#set-imgModelSelect').inputValue(), 'gpt-image-b@Provider B');
    assert.equal(await heldEarly.locator('#set-imgQualitySelect').inputValue(), 'high');
    assert.equal(await heldEarly.locator('#set-imgEnabledToggle').isChecked(), true);
    assert.equal(await heldEarly.evaluate(() => window.__imageSaveCalls.length), 0);
    await finishPage(heldEarly);

    const timeoutCases = [];
    for (const scenario of ['settings-headers', 'settings-body']) {
      const page = await openPage(origin, scenario, true);
      await waitFor(() => pending.has('settings:' + scenario), scenario + ' response held');
      const response = pending.get('settings:' + scenario);
      assert.equal(response.headersSent, scenario.endsWith('-body'));
      assert.equal(response.ended, false);
      await assertDisabled(page);
      await clickVisibleDisabledSwitch(page);
      assert.equal(await page.locator('#set-imgEnabledToggle').isChecked(), false);
      await page.clock.fastForward(15000);
      await assertFailure(page);
      await waitFor(() => response.closed, scenario + ' aborted response');
      assert.equal(response.ended, false, 'deadline aborts pending fetch/body');
      timeoutCases.push({ phase: scenario.endsWith('-body') ? 'body' : 'headers', aborted: true });
      await finishPage(page);
    }

    for (const scenario of ['endpoint-headers', 'endpoint-body']) {
      const endpointTimeout = await openPage(origin, scenario, true);
      await waitFor(() => pending.has('endpoint:' + scenario), 'held endpoint inventory response');
      const endpointResponse = pending.get('endpoint:' + scenario);
      await endpointTimeout.clock.fastForward(15000);
      await endpointTimeout.waitForFunction(() => window.__imageSettingsReady === true);
      await waitFor(() => endpointResponse.closed, 'endpoint inventory request aborted');
      assert.equal(endpointResponse.ended, false);
      assert.equal(await endpointTimeout.locator('#set-imgModelSelect').inputValue(), 'gpt-image-b@Provider B');
      assert.equal(await endpointTimeout.locator('#set-imgModelSelect').isDisabled(), false,
        'valid settings remain usable after bounded optional inventory failure');
      assert.equal(observed.filter(item => item === 'GET /api/model-endpoints?case=' + scenario).length, 1,
        'inventory timeout does not automatically retry');
      timeoutCases.push({ phase: scenario.endsWith('-body') ? 'endpoint-body' : 'endpoint-headers', aborted: true, settingsHydrated: true });
      await finishPage(endpointTimeout);
    }

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
    console.log(JSON.stringify({
      pass: true,
      sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
      normalFullSnapshot: true,
      settingsFailures: ['503', 'malformed-json', 'null', 'array'],
      earlyVisibleClickIgnored: true,
      timeoutCases,
      optionalInventoryFailureKeepsSavedSettings: true,
      externalRequests: externalRequests.length,
      pageErrors: pageErrors.length,
    }));
  } finally {
    for (const item of pending.values()) {
      if (!item.ended && !item.closed) item.res.destroy();
    }
    if (context) await context.close();
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
