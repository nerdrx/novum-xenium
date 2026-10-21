// Actual app/settings UI with synthetic loopback APIs and microphone access.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const calls = [];
const pageErrors = [];
const externalRequests = [];
let denySettingsWrites = false;
let failSettingsRead = false;
let holdNextSettingsWrite = false;
let heldSettingsWrite = null;
let resolveHeldSettingsWrite;
const heldSettingsWritePromise = new Promise(resolve => { resolveHeldSettingsWrite = resolve; });
let settings = { stt_enabled: false, stt_provider: 'disabled', stt_model: 'base', stt_language: '' };
let settingsWrites = [];
let holdNextSttStats = 0;
let heldSttStats = [];
let statsProvider = 'disabled';
const fakeMedia = `Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia(){window.__micRequests++;return Promise.reject(new Error('synthetic mic must not be requested'));}}});window.__micRequests=0;`;

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(repo, 'static/index.html')).pipe(res);
  }
  if (url.pathname.startsWith('/api/')) {
    calls.push({ method: req.method, path: url.pathname });
    if (url.pathname === '/api/auth/status') return json(res, { authenticated: true, configured: true, username: 'fixture-user', is_admin: false, privileges: {} });
    if (url.pathname === '/api/auth/features') return json(res, { features: {} });
    if (url.pathname === '/api/auth/settings' && req.method === 'GET') {
      if (failSettingsRead) return json(res, { detail: 'synthetic settings unavailable' }, 503);
      return json(res, settings);
    }
    if (url.pathname === '/api/auth/settings' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const patch = JSON.parse(body);
      settingsWrites.push(patch);
      if (holdNextSettingsWrite) {
        holdNextSettingsWrite = false;
        heldSettingsWrite = {
          patch,
          reply(status = 200) {
            if (status >= 400) return json(res, { detail: 'synthetic settings failure' }, status);
            settings = { ...settings, ...patch };
            return json(res, { success: true });
          },
        };
        resolveHeldSettingsWrite(heldSettingsWrite);
        return;
      }
      if (denySettingsWrites) return json(res, { detail: 'synthetic admin restriction' }, 403);
      settings = { ...settings, ...patch };
      return json(res, { success: true });
    }
    if (url.pathname === '/api/stt/stats') {
      if (holdNextSttStats > 0) {
        holdNextSttStats--;
        heldSttStats.push({
          reply(value) { json(res, value); },
          headers() { res.writeHead(200, { 'content-type': 'application/json' }); },
          finish(value) { res.end(JSON.stringify(value)); },
        });
        return;
      }
      return json(res, { provider: statsProvider });
    }
    if (url.pathname === '/api/model-endpoints' || url.pathname === '/api/sessions' || url.pathname === '/api/presets/templates') return json(res, []);
    if (url.pathname === '/api/models') return json(res, { items: [] });
    return json(res, {});
  }
  const filename = path.resolve(repo, `.${url.pathname}`);
  if (!filename.startsWith(repo + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    res.writeHead(404); return res.end();
  }
  const ext = path.extname(filename);
  const contentType = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' :
    (ext === '.js' || ext === '.mjs') ? 'text/javascript' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType });
  if (url.pathname === '/static/js/voiceRecorder.js') {
    const source = fs.readFileSync(filename, 'utf8')
      .replace('const stats = await res.json();', 'const stats = await res.json(); window.__sttStatsResponseCount = (window.__sttStatsResponseCount || 0) + 1;')
      .replace('export default voiceRecorderModule;', 'window.__sttStatsResponseCount = 0; window.__sttProviderProbe = () => _sttProvider; window.__refreshSttProviderProbe = refreshSttProvider;\nexport default voiceRecorderModule;');
    return res.end(source);
  }
  fs.createReadStream(filename).pipe(res);
});

async function openApp(browser, port) {
  const context = await browser.newContext();
  await context.addInitScript(fakeMedia);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => {
    const target = new URL(route.request().url());
    if (target.origin !== `http://127.0.0.1:${port}`) {
      externalRequests.push(target.href);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__odysseusAppStarted === true, null, { timeout: 15000 });
  return { context, page };
}

async function openAiSettings(page) {
  await page.locator('#user-bar-settings').click();
  await page.getByRole('button', { name: 'AI Defaults' }).click();
  assert.equal(await page.locator('[data-settings-panel="ai"]').isVisible(), true, 'visible AI Defaults navigation opens its panel');
  assert.equal(await page.getByRole('heading', { name: 'Speech to Text' }).isVisible(), true, 'restored speech controls are discoverable in AI Defaults');
  await page.locator('#set-sttProviderSelect').waitFor({ state: 'attached' });
}

function waitForHeldSttStats(count = 1, offset = 0) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (heldSttStats.length >= offset + count) return resolve(heldSttStats.slice(offset, offset + count));
      if (Date.now() - started > 10000) return reject(new Error(`timed out waiting for ${count} held STT stats responses`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function waitForHeldWrite() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for synthetic held settings POST')), 10000);
    heldSettingsWritePromise.then(value => { clearTimeout(timer); resolve(value); }, reject);
  });
}

async function checkSwitchLayoutAndKeyboard(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.getByRole('heading', { name: 'Speech to Text' }).scrollIntoViewIfNeeded();
  const bounds = await page.locator('.stt-settings-switch').boundingBox();
  assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44, `${width}px switch target is at least 44 by 44`);
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `${width}px switch target fits viewport`);
  const nav = page.getByRole('button', { name: 'AI Defaults' });
  await nav.focus();
  let reached = false;
  for (let i = 0; i < 100; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.id === 'set-sttEnabledToggle')) { reached = true; break; }
  }
  assert.equal(reached, true, 'keyboard Tab reaches speech toggle');
  const focusOutline = await page.locator('#set-sttEnabledToggle + .admin-slider').evaluate(node => ({ style: getComputedStyle(node).outlineStyle, width: getComputedStyle(node).outlineWidth }));
  assert.equal(focusOutline.style, 'solid', 'keyboard focus has a visible outline');
  assert.equal(focusOutline.width, '2px');
  return { bounds, focusOutline };
}

(async () => {
  let browser;
  let serverClosed = false;
  const contexts = [];
  const proof = {
    source: {}, cases: {}, api: {}, externalRequests, pageErrors,
    scope: 'actual static/index.html, static/app.js, settings.js and speech.js; synthetic loopback API and mediaDevices only',
  };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

    const normal = await openApp(browser, port); contexts.push(normal.context);
    await openAiSettings(normal.page);
    await normal.page.waitForFunction(() => !document.querySelector('#set-sttProviderSelect').disabled);
    assert.equal(await normal.page.locator('#set-sttEnabledToggle').isChecked(), false, 'saved default remains off');
    assert.equal(await normal.page.locator('#set-sttProviderSelect').inputValue(), 'disabled');
    assert.notEqual(await normal.page.locator('.send-btn').getAttribute('title'), 'Record voice', 'disabled provider does not show microphone button');
    assert.equal(await normal.page.evaluate(() => window.__micRequests), 0, 'disabled provider makes no microphone request');
    await normal.page.locator('#set-sttEnabledToggle').locator('xpath=..').click();
    await normal.page.locator('#set-sttProviderSelect').selectOption('browser');
    await normal.page.waitForFunction(() => document.querySelector('#set-sttSettingsMsg').textContent === 'Saved');
    await normal.page.waitForFunction(() => document.querySelector('.send-btn')?.title === 'Record voice');
    proof.cases.enableBrowserVoice = {
      saved: settings,
      buttonTitle: await normal.page.locator('.send-btn').getAttribute('title'),
      microphoneRequests: await normal.page.evaluate(() => window.__micRequests),
    };
    await normal.page.locator('#message').fill('synthetic text');
    await normal.page.waitForFunction(() => document.querySelector('.send-btn')?.title !== 'Record voice');
    assert.equal(await normal.page.locator('.send-btn').getAttribute('title'), 'Send message');
    proof.cases.textKeepsSend = { buttonTitle: await normal.page.locator('.send-btn').getAttribute('title') };
    await normal.page.locator('#message').fill('');
    await normal.page.locator('#file-input').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic attachment') });
    await normal.page.waitForFunction(() => document.querySelector('#attach-strip')?.textContent.includes('synthetic.txt'));
    assert.equal(await normal.page.locator('.send-btn').getAttribute('title'), 'Send message');
    proof.cases.attachmentKeepsSend = { buttonTitle: await normal.page.locator('.send-btn').getAttribute('title'), attachStrip: await normal.page.locator('#attach-strip').innerText() };

    settings = { stt_provider: 'disabled', stt_model: 'base', stt_language: '' };
    const missingEnabled = await openApp(browser, port); contexts.push(missingEnabled.context);
    await openAiSettings(missingEnabled.page);
    await missingEnabled.page.waitForFunction(() => !document.querySelector('#set-sttProviderSelect').disabled);
    assert.equal(await missingEnabled.page.locator('#set-sttEnabledToggle').isChecked(), false, 'missing stt_enabled defaults safely to off');
    proof.cases.missingEnabledDefaultsOff = { enabled: await missingEnabled.page.locator('#set-sttEnabledToggle').isChecked() };

    settings = { stt_enabled: false, stt_provider: 'local', stt_model: 'small', stt_language: 'de' };
    const savedLocal = await openApp(browser, port); contexts.push(savedLocal.context);
    await openAiSettings(savedLocal.page);
    await savedLocal.page.waitForFunction(() => !document.querySelector('#set-sttProviderSelect').disabled);
    assert.equal(await savedLocal.page.locator('#set-sttProviderSelect').inputValue(), 'local');
    assert.equal(await savedLocal.page.locator('#set-sttModelSelect').inputValue(), 'small', 'saved model absent from built-in choices remains selected');
    await savedLocal.page.locator('#set-sttEnabledToggle').locator('xpath=..').click();
    await savedLocal.page.waitForFunction(() => document.querySelector('#set-sttSettingsMsg').textContent === 'Saved');
    assert.equal(settingsWrites.at(-1).stt_model, 'small', 'toggle save preserves configured model');
    proof.cases.savedLocalModelPreserved = { savedProvider: settings.stt_provider, savedModel: settings.stt_model, postedModel: settingsWrites.at(-1).stt_model };

    settings = { stt_enabled: false, stt_provider: 'endpoint:removed-fixture-id', stt_model: 'saved-fixture-model', stt_language: '' };
    const unavailableEndpoint = await openApp(browser, port); contexts.push(unavailableEndpoint.context);
    await openAiSettings(unavailableEndpoint.page);
    await unavailableEndpoint.page.waitForFunction(() => !document.querySelector('#set-sttProviderSelect').disabled);
    assert.equal(await unavailableEndpoint.page.locator('#set-sttProviderSelect').inputValue(), 'endpoint:removed-fixture-id');
    assert.equal(await unavailableEndpoint.page.locator('#set-sttProviderSelect option:checked').textContent(), 'Saved provider (unavailable)');
    await unavailableEndpoint.page.locator('#set-sttEnabledToggle').locator('xpath=..').click();
    await unavailableEndpoint.page.waitForFunction(() => document.querySelector('#set-sttSettingsMsg').textContent === 'Saved');
    assert.equal(settingsWrites.at(-1).stt_provider, 'endpoint:removed-fixture-id', 'missing configured endpoint is not silently replaced');
    proof.cases.unavailableEndpointPreserved = { provider: settings.stt_provider, optionLabel: await unavailableEndpoint.page.locator('#set-sttProviderSelect option:checked').textContent() };

    settings = { stt_enabled: false, stt_provider: 'browser', stt_model: 'base', stt_language: '' };
    const heldSave = await openApp(browser, port); contexts.push(heldSave.context);
    await openAiSettings(heldSave.page);
    await heldSave.page.waitForFunction(() => !document.querySelector('#set-sttProviderSelect').disabled);
    holdNextSettingsWrite = true;
    await heldSave.page.locator('#set-sttEnabledToggle').locator('xpath=..').click();
    const held = await waitForHeldWrite();
    assert.equal(held.patch.stt_enabled, true);
    assert.equal(held.patch.stt_provider, 'browser');
    assert.equal(await heldSave.page.locator('#set-sttProviderSelect').isDisabled(), true, 'provider is locked while its settings save is pending');
    assert.equal(await heldSave.page.locator('#set-sttEnabledToggle').isDisabled(), true, 'toggle is locked while its settings save is pending');
    held.reply(200);
    await heldSave.page.waitForFunction(() => document.querySelector('#set-sttSettingsMsg').textContent === 'Saved');
    await heldSave.page.waitForFunction(() => document.querySelector('.send-btn')?.title === 'Record voice');
    assert.equal(await heldSave.page.evaluate(() => window.__micRequests), 0);
    proof.cases.heldSaveOwnership = { request: held.patch, providerDisabledDuringRequest: true, buttonAfterAcceptedSave: await heldSave.page.locator('.send-btn').getAttribute('title'), microphoneRequests: await heldSave.page.evaluate(() => window.__micRequests) };

    settings = { stt_enabled: false, stt_provider: 'disabled', stt_model: 'base', stt_language: '' };
    const denied = await openApp(browser, port); contexts.push(denied.context);
    await openAiSettings(denied.page);
    await denied.page.waitForFunction(() => !document.querySelector('#set-sttProviderSelect').disabled);
    await denied.page.locator('#set-sttEnabledToggle').locator('xpath=..').click();
    await denied.page.waitForFunction(() => document.querySelector('#set-sttSettingsMsg').textContent === 'Saved');
    denySettingsWrites = true;
    await denied.page.locator('#set-sttProviderSelect').selectOption('browser');
    await denied.page.waitForFunction(() => document.querySelector('#set-sttSettingsMsg').textContent.includes('Admin access is required'));
    assert.notEqual(await denied.page.locator('#set-sttSettingsMsg').textContent(), 'Saved');
    await denied.page.waitForTimeout(2100);
    assert.match(await denied.page.locator('#set-sttSettingsMsg').textContent(), /Admin access is required/, 'prior Saved timer cannot clear a newer save error');
    assert.equal(await denied.page.evaluate(() => window.__micRequests), 0);
    proof.cases.deniedWriteAfterSuccess = { message: await denied.page.locator('#set-sttSettingsMsg').textContent(), savedSettings: settings, errorSurvivesPreviousSavedTimer: true };
    denySettingsWrites = false;

    settings = { stt_enabled: false, stt_provider: 'disabled', stt_model: 'base', stt_language: '' };
    const writesBeforeFailedRead = settingsWrites.length;
    const unavailable = await openApp(browser, port); contexts.push(unavailable.context);
    failSettingsRead = true;
    await openAiSettings(unavailable.page);
    await unavailable.page.waitForFunction(() => document.querySelector('#set-sttSettingsMsg').textContent.includes('Could not load saved'));
    assert.equal(await unavailable.page.locator('#set-sttProviderSelect').isDisabled(), true);
    assert.equal(await unavailable.page.locator('#set-sttEnabledToggle').isDisabled(), true);
    assert.equal(await unavailable.page.evaluate(() => window.__micRequests), 0);
    proof.cases.settingsReadFailure = {
      message: await unavailable.page.locator('#set-sttSettingsMsg').textContent(),
      controlsDisabled: await unavailable.page.locator('#set-sttProviderSelect').isDisabled() && await unavailable.page.locator('#set-sttEnabledToggle').isDisabled(),
      writes: settingsWrites.length - writesBeforeFailedRead,
    };
    failSettingsRead = false;

    settings = { stt_enabled: false, stt_provider: 'disabled', stt_model: 'base', stt_language: '' };
    holdNextSttStats = true;
    const requestOffset = calls.length;
    const staleStartup = await openApp(browser, port); contexts.push(staleStartup.context);
    const [heldStartupStats] = await waitForHeldSttStats();
    await openAiSettings(staleStartup.page);
    await staleStartup.page.waitForFunction(() => !document.querySelector('#set-sttProviderSelect').disabled);
    await staleStartup.page.locator('#set-sttEnabledToggle').locator('xpath=..').click();
    await staleStartup.page.locator('#set-sttProviderSelect').selectOption('browser');
    await staleStartup.page.waitForFunction(() => document.querySelector('#set-sttSettingsMsg').textContent === 'Saved');
    await staleStartup.page.waitForFunction(() => document.querySelector('.send-btn')?.title === 'Record voice');
    const confirmedBeforeStale = {
      savedSettings: settings,
      provider: await staleStartup.page.evaluate(() => window.__sttProviderProbe?.()),
      buttonTitle: await staleStartup.page.locator('.send-btn').getAttribute('title'),
    };
    heldStartupStats.reply({ provider: 'disabled' });
    await staleStartup.page.waitForFunction(() => window.__sttStatsResponseCount === 1);
    const afterStale = {
      provider: await staleStartup.page.evaluate(() => window.__sttProviderProbe?.()),
      buttonTitle: await staleStartup.page.locator('.send-btn').getAttribute('title'),
    };
    assert.equal(confirmedBeforeStale.provider, 'browser');
    assert.equal(confirmedBeforeStale.buttonTitle, 'Record voice');
    assert.equal(afterStale.provider, 'browser', 'stale startup response cannot overwrite confirmed browser provider');
    assert.equal(afterStale.buttonTitle, 'Record voice', 'stale disabled response cannot hide voice button');
    assert.equal(await staleStartup.page.evaluate(() => window.__micRequests), 0);
    proof.cases.staleStartupStatsIgnored = {
      requestOrder: calls.slice(requestOffset).map(({ method, path }) => `${method} ${path}`),
      startupRequest: 'GET /api/stt/stats held before response',
      settingsSave: settingsWrites.at(-1),
      confirmedBeforeStale,
      staleResponse: { provider: 'disabled' },
      afterStale,
      microphoneRequests: await staleStartup.page.evaluate(() => window.__micRequests),
    };

    statsProvider = 'browser';
    const normalStats = await openApp(browser, port); contexts.push(normalStats.context);
    await normalStats.page.waitForFunction(() => window.__sttStatsResponseCount === 1 && window.__sttProviderProbe?.() === 'browser');
    assert.equal(await normalStats.page.locator('.send-btn').getAttribute('title'), 'Record voice');
    proof.cases.normalStartupStats = { provider: await normalStats.page.evaluate(() => window.__sttProviderProbe()), buttonTitle: await normalStats.page.locator('.send-btn').getAttribute('title') };

    const responseCountBeforePair = await normalStats.page.evaluate(() => window.__sttStatsResponseCount);
    const pairOffset = heldSttStats.length;
    holdNextSttStats = 2;
    await normalStats.page.evaluate(() => {
      window.__parallelStatsRefreshes = [window.__refreshSttProviderProbe(), window.__refreshSttProviderProbe()];
    });
    const heldPair = await waitForHeldSttStats(2, pairOffset);
    heldPair[1].reply({ provider: 'local' });
    await normalStats.page.waitForFunction((count) => window.__sttStatsResponseCount === count + 1 && window.__sttProviderProbe?.() === 'local', responseCountBeforePair);
    heldPair[0].reply({ provider: 'disabled' });
    await normalStats.page.waitForFunction((count) => window.__sttStatsResponseCount === count + 2, responseCountBeforePair);
    assert.equal(await normalStats.page.evaluate(() => window.__sttProviderProbe()), 'local', 'older refresh cannot overwrite newer completed refresh');
    proof.cases.outOfOrderRefresh = { newerResponse: 'local', olderResponse: 'disabled', finalProvider: await normalStats.page.evaluate(() => window.__sttProviderProbe()) };

    const responseCountBeforeJson = await normalStats.page.evaluate(() => window.__sttStatsResponseCount);
    const jsonOffset = heldSttStats.length;
    holdNextSttStats = 1;
    await normalStats.page.evaluate(() => { window.__pendingJsonRefresh = window.__refreshSttProviderProbe(); });
    const [heldJson] = await waitForHeldSttStats(1, jsonOffset);
    heldJson.headers();
    await normalStats.page.waitForTimeout(50);
    await normalStats.page.evaluate(() => window._setSttProvider('browser'));
    heldJson.finish({ provider: 'disabled' });
    await normalStats.page.waitForFunction((count) => window.__sttStatsResponseCount === count + 1, responseCountBeforeJson);
    assert.equal(await normalStats.page.evaluate(() => window.__sttProviderProbe()), 'browser', 'settings setter invalidates request whose JSON body was still pending');
    assert.equal(await normalStats.page.locator('.send-btn').getAttribute('title'), 'Record voice');
    proof.cases.pendingJsonInvalidated = { setterProvider: 'browser', staleJsonProvider: 'disabled', finalProvider: await normalStats.page.evaluate(() => window.__sttProviderProbe()) };

    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
    proof.api = {
      loopbackRequestCount: calls.length,
      uniquePaths: [...new Set(calls.map(call => call.path))].length,
      syntheticSttStatsRequests: calls.filter(call => call.path === '/api/stt/stats').length,
      settingsWrites: settingsWrites.length,
    };
    proof.source = Object.fromEntries(['static/index.html', 'static/app.js', 'static/js/settings.js', 'static/js/settings/speech.js', 'static/js/voiceRecorder.js', 'static/css/06-admin-settings.css'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]));
    proof.pass = true;
    process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
  } finally {
    await Promise.all(contexts.map(context => context.close().catch(() => {})));
    if (browser) await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(() => { serverClosed = true; resolve(); }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
