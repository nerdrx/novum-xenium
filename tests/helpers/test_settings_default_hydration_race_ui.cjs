// Default chat selection remains user-owned when initial settings arrive late.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(repo, 'static/js/settings.js'), 'utf8');
const api = fs.readFileSync(path.join(repo, 'static/js/settings/api.js'), 'utf8');
const apiStart = api.indexOf('export async function postSettings(body)');
const apiEnd = api.indexOf('\n}', apiStart) + 2;
const queueStart = source.indexOf('function _createSettingsSaver(');
const helpersEnd = source.indexOf('const el = byId;', queueStart);
const initStart = source.indexOf('async function initDefaultChat()');
const initEnd = source.indexOf('/* ── Utility Model ── */', initStart);
assert(apiStart >= 0 && apiEnd > apiStart && queueStart >= 0 && helpersEnd > queueStart && initStart >= 0 && initEnd > initStart);
const settingsHelpers = api.slice(apiStart, apiEnd)
  .replace('export async function postSettings(body)', 'async function _postSettings(body)')
  + '\n' + source.slice(queueStart, helpersEnd);
const initializer = source.slice(initStart, initEnd);
const calls = [];
let releaseInitialSettings = null;
let heldSettingsRead = null;
const endpoints = [
  { id: 'ep1', name: 'One', is_enabled: true, models: ['m0', 'm1'] },
  { id: 'ep2', name: 'Two', is_enabled: true, models: ['m2', 'm3'] },
];

const html = `<!doctype html><meta charset="utf-8"><body>
<select id="set-defaultEpSelect"></select><select id="set-defaultModelSelect"></select><div id="set-defaultChatMsg"></div>
<script type="module" src="/fixture.js"></script></body>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/auth/settings' && req.method === 'GET') {
    const respond = () => json({ default_endpoint_id: 'ep1', default_model: 'm0' });
    if (url.searchParams.has('hold')) {
      const currentSettingsRead = { started: true, closed: false, bodyHeld: url.searchParams.has('body') };
      heldSettingsRead = currentSettingsRead;
      res.on('close', () => { currentSettingsRead.closed = true; });
      if (currentSettingsRead.bodyHeld) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.flushHeaders();
        releaseInitialSettings = () => res.end(JSON.stringify({ default_endpoint_id: 'ep1', default_model: 'm0' }));
      } else releaseInitialSettings = respond;
      return;
    }
    return respond();
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push(JSON.parse(body));
    return json({ ok: true });
  }
  if (url.pathname === '/api/model-endpoints') return json(endpoints);
  if (url.pathname === '/__release-settings') {
    const release = releaseInitialSettings; releaseInitialSettings = null;
    if (!release) { res.writeHead(409); return res.end(); }
    release(); res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__calls') return json(calls);
  if (url.pathname === '/__settings-read') return json(heldSettingsRead);
  if (url.pathname === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(`
      const byId = id => document.getElementById(id);
      const el = byId;
      const invalidateSettings = () => {};
      const uiModule = { showError() {} };
      ${settingsHelpers}
      const endpointData = ${JSON.stringify(endpoints)};
      const _fetchModelEndpoints = () => new Promise(resolve => { window.__releaseEndpointInventory = () => resolve(endpointData); });
      const _selectableEndpointModels = endpoint => [...new Set([...(endpoint?.models || []), ...(endpoint?.pinned_models || [])])];
      const _fillEndpointSelect = (select, list, selected) => {
        const previous = selected !== undefined ? selected : select.value;
        select.replaceChildren(...list.filter(item => item.is_enabled).map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; return option; }));
        if (previous && Array.from(select.options).some(option => option.value === previous)) select.value = previous;
      };
      const _fillModelSelect = (select, list, selected) => {
        const previous = selected !== undefined ? selected : select.value;
        select.replaceChildren(...list.map(item => { const option = document.createElement('option'); option.value = item; option.textContent = item; return option; }));
        if (previous && Array.from(select.options).some(option => option.value === previous)) select.value = previous;
      };
      const _registerAiEndpointRefresh = fn => { (window.__endpointRefreshers ||= []).push(fn); };
      const providerLogo = () => '';
      ${initializer}
      window.__initPromise = initDefaultChat();
      window.fixtureReady = true;
    `);
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.route('**/api/auth/settings', route => {
      if (route.request().method() === 'GET') route.continue({ url: route.request().url() + '?hold=1' });
      else route.continue();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady, null, { timeout: 4000 })
      .catch(() => { throw new Error(`fixture did not initialize: ${errors.join('\\n')}`); });
    const endpoint = page.locator('#set-defaultEpSelect');
    const model = page.locator('#set-defaultModelSelect');
    assert.equal(await endpoint.locator('option').count(), 0, 'endpoint inventory is still loading');
    await page.evaluate(() => {
      document.querySelector('#set-defaultEpSelect').dispatchEvent(new Event('change'));
      document.querySelector('#set-defaultModelSelect').dispatchEvent(new Event('change'));
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(calls, [], 'unavailable selections during inventory loading must not be saved');
    await page.evaluate(() => window.__releaseEndpointInventory());
    await page.waitForFunction(() => document.querySelectorAll('#set-defaultEpSelect option').length === 2 && document.querySelectorAll('#set-defaultModelSelect option').length === 2);

    // Make both choices while saved settings are pending. Each choice must be saved.
    await endpoint.selectOption('ep2');
    await page.waitForFunction(async () => (await (await fetch('/__calls')).json()).length === 1);
    await model.selectOption('m3');
    await page.waitForFunction(async () => (await (await fetch('/__calls')).json()).length === 2);
    assert.deepEqual(await page.evaluate(async () => (await (await fetch('/__calls')).json()),), [
      { default_endpoint_id: 'ep2', default_model: 'm2' },
      { default_endpoint_id: 'ep2', default_model: 'm3' },
    ]);
    await page.evaluate(() => fetch('/__release-settings'));
    await page.evaluate(() => window.__initPromise);
    assert.equal(await endpoint.inputValue(), 'ep2', 'late saved endpoint must not overwrite a user choice');
    assert.equal(await model.inputValue(), 'm3', 'late saved model must not overwrite a user choice');

    // Endpoint refresh preserves both current selections while extending models.
    await page.evaluate(() => window.__endpointRefreshers.forEach(fn => fn([
      { id: 'ep1', name: 'One', is_enabled: true, models: ['m0', 'm1'] },
      { id: 'ep2', name: 'Two', is_enabled: true, models: ['m2', 'm3', 'm4'] },
    ])));
    assert.equal(await endpoint.inputValue(), 'ep2');
    assert.equal(await model.inputValue(), 'm3');
    await model.selectOption('m4');
    await page.waitForFunction(async () => (await (await fetch('/__calls')).json()).length === 3);
    assert.deepEqual((await page.evaluate(async () => (await (await fetch('/__calls')).json())))[2], { default_endpoint_id: 'ep2', default_model: 'm4' });
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);

    // Untouched controls still hydrate from the saved defaults normally.
    const normal = await browser.newPage();
    await normal.goto(`http://127.0.0.1:${server.address().port}`);
    await normal.waitForFunction(() => window.fixtureReady);
    await normal.evaluate(() => window.__releaseEndpointInventory());
    await normal.waitForFunction(() => window.__initPromise && document.querySelector('#set-defaultModelSelect').value === 'm0');
    await normal.evaluate(() => window.__initPromise);
    assert.equal(await normal.locator('#set-defaultEpSelect').inputValue(), 'ep1');
    assert.equal(await normal.locator('#set-defaultModelSelect').inputValue(), 'm0');
    await normal.close();

    // If the settings read fails, listeners are already active and a later choice still saves.
    const failed = await browser.newPage();
    await failed.route('**/api/auth/settings', route => route.request().method() === 'GET'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ default_endpoint_id: 'ep2', default_model: 'm3' }) })
      : route.continue());
    await failed.goto(`http://127.0.0.1:${server.address().port}`);
    await failed.waitForFunction(() => window.fixtureReady);
    await failed.evaluate(() => window.__releaseEndpointInventory());
    await failed.waitForFunction(() => document.querySelectorAll('#set-defaultEpSelect option').length === 2 && document.querySelectorAll('#set-defaultModelSelect option').length === 2);
    await failed.evaluate(() => window.__initPromise);
    assert.equal(await failed.locator('#set-defaultEpSelect').inputValue(), 'ep1', 'HTTP-error JSON must not hydrate saved selection');
    assert.equal(await failed.locator('#set-defaultModelSelect').inputValue(), 'm0');
    assert.equal(await failed.locator('#set-defaultChatMsg').textContent(), 'Could not load saved chat defaults. Displayed choices may differ from saved settings. Reload to verify.');
    await failed.locator('#set-defaultEpSelect').selectOption('ep2');
    await failed.waitForFunction(async () => (await (await fetch('/__calls')).json()).length === 4);
    assert.deepEqual((await failed.evaluate(async () => (await (await fetch('/__calls')).json())))[3], { default_endpoint_id: 'ep2', default_model: 'm2' });
    assert.deepEqual(errors, [], `primary-page errors: ${errors.join('\n')}`);
    await failed.close();

    // The actual initializer's timer also aborts a body-stalled JSON read and shows a visible failure.
    heldSettingsRead = null;
    releaseInitialSettings = null;
    const callsBeforeTimeout = calls.length;
    const timeoutPage = await browser.newPage();
    const timeoutErrors = [];
    timeoutPage.on('pageerror', error => timeoutErrors.push(error.stack || error.message));
    await timeoutPage.clock.install();
    await timeoutPage.route('**/api/auth/settings', route => route.request().method() === 'GET'
      ? route.continue({ url: `${route.request().url()}?hold=1&body=1` })
      : route.continue());
    await timeoutPage.goto(`http://localhost:${server.address().port}`);
    await timeoutPage.waitForFunction(() => window.fixtureReady);
    await timeoutPage.evaluate(() => window.__releaseEndpointInventory());
    await timeoutPage.waitForFunction(async () => (await (await fetch('/__settings-read')).json())?.started === true);
    assert.equal(heldSettingsRead.bodyHeld, true, 'fixture holds JSON after sending response headers');
    await timeoutPage.clock.fastForward(15000);
    await timeoutPage.locator('#set-defaultChatMsg').getByText('Could not load saved chat defaults. Displayed choices may differ from saved settings. Reload to verify.', { exact: true }).waitFor({ state: 'visible' });
    await timeoutPage.evaluate(() => window.__initPromise);
    const readState = await timeoutPage.evaluate(async () => (await (await fetch('/__settings-read')).json()));
    assert.equal(readState.closed, true, 'AbortController closes the pending JSON response');
    assert.equal(await timeoutPage.locator('#set-defaultChatMsg').textContent(), 'Could not load saved chat defaults. Displayed choices may differ from saved settings. Reload to verify.');
    assert.equal(calls.length, callsBeforeTimeout, 'failed read does not POST settings');
    assert.deepEqual(timeoutErrors, [], `timeout page errors: ${timeoutErrors.join('\n')}`);
    await timeoutPage.close();
    console.log('PASS: initial saved-default timeout and load failure are visible without a settings write');
    console.log('PASS: early endpoint/model choices survive hydration, persist, and survive refresh/recovery');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
