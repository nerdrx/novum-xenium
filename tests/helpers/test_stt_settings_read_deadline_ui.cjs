// Actual settings UI with synthetic loopback APIs; never accesses speech devices.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
const savedSettings = { stt_enabled: true, stt_provider: 'browser', stt_model: 'base', stt_language: 'de' };
const state = { mode: 'normal', calls: [], settingsPosts: [], external: [], pageErrors: [], targets: [], activeApi: new Set() };

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const id = state.calls.length + 1;
  const caller = req.headers['x-fixture-caller'] || null;
  state.calls.push({ id, method: req.method, path: url.pathname, caller });
  if (url.pathname.startsWith('/api/')) {
    state.activeApi.add(id);
    const finish = () => state.activeApi.delete(id);
    res.on('finish', finish);
    res.on('close', finish);
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(path.join(staticRoot, 'index.html')).pipe(res);
  }
  if (url.pathname === '/api/auth/status') return json(res, { authenticated: true, configured: true, username: 'fixture', is_admin: true, privileges: {} });
  if (url.pathname === '/api/auth/features') return json(res, { features: {} });
  if (url.pathname === '/api/auth/settings' && req.method === 'GET') {
    if (caller === 'initSttSettings-settings') {
      const target = { id, caller, ended: false, closed: false, response: res };
      state.targets.push(target);
      res.on('finish', () => { target.ended = true; });
      res.on('close', () => { target.closed = true; });
      if (state.mode === 'settings-header') return;
      if (state.mode === 'settings-body') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.flushHeaders();
        return res.write('{');
      }
      if (state.mode === 'settings-503') return json(res, { detail: 'synthetic settings unavailable' }, 503);
      if (state.mode === 'settings-malformed') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end('{broken');
      }
    }
    return json(res, savedSettings);
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    state.settingsPosts.push(JSON.parse(body));
    return json(res, { success: true });
  }
  if (url.pathname === '/api/model-endpoints' && req.method === 'GET') {
    return json(res, [{ id: 'fixture-endpoint', name: 'Fixture endpoint', is_enabled: true, models: ['fixture-model'] }]);
  }
  if (url.pathname === '/api/models') return json(res, { items: [] });
  if (url.pathname === '/api/stt/stats') return json(res, { provider: 'browser', available: true, model_loaded: false });
  if (url.pathname === '/api/sessions' || url.pathname === '/api/presets/templates') return json(res, []);
  if (url.pathname.startsWith('/api/')) return json(res, {});
  const rel = decodeURIComponent(url.pathname.replace(/^\/static\//, ''));
  const file = path.resolve(staticRoot, rel);
  if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('fixture not found');
  }
  const ext = path.extname(file);
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

function waitFor(predicate, label, timeout = 12000) {
  const end = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const poll = () => predicate() ? resolve() : Date.now() >= end
      ? reject(new Error(`Timed out: ${label}; calls=${JSON.stringify(state.calls)}`))
      : setTimeout(poll, 10);
    poll();
  });
}

async function runCase(browser, origin, mode) {
  state.mode = mode;
  state.calls = []; state.settingsPosts = []; state.targets = []; state.activeApi = new Set(); state.pageErrors = [];
  const context = await browser.newContext();
  let page;
  try {
    await context.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.__micRequests = 0;
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia() { window.__micRequests++; return Promise.reject(new Error('fixture microphone access blocked')); } } });
      window.fetch = function(input, init) {
        const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
        const method = (init && init.method) || (input instanceof Request && input.method) || 'GET';
        const stack = new Error().stack || '';
        const isSpeech = stack.includes('speech.js') && stack.includes('initSttSettings');
        const target = isSpeech && url.pathname === '/api/auth/settings' && method === 'GET';
        if (!window.__settingsTrace) window.__settingsTrace = { targetCount: 0, jsonStarted: false, jsonCompleted: false, signal: null };
        let request = init || {};
        if (target) {
          const headers = new Headers(request.headers || (input instanceof Request ? input.headers : undefined));
          headers.set('x-fixture-caller', 'initSttSettings-settings');
          request = Object.assign({}, request, { headers });
          window.__settingsTrace.targetCount++;
          window.__settingsTrace.signal = request.signal || null;
        }
        return nativeFetch(input, request).then(response => {
          if (!target) return response;
          const nativeJson = response.json.bind(response);
          response.json = function() {
            window.__settingsTrace.jsonStarted = true;
            return nativeJson().then(value => { window.__settingsTrace.jsonCompleted = true; return value; });
          };
          return response;
        });
      };
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { state.external.push(url.href); return route.abort(); }
      return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => state.pageErrors.push(error.stack || error.message));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window._isAdmin === true, null, { timeout: 15000 });
    await waitFor(() => state.activeApi.size === 0, 'unrelated startup APIs complete');
    await page.clock.install();
    await page.locator('#user-bar-settings').click();
    await page.locator('#settings-modal:not(.hidden)').waitFor({ state: 'visible' });
    await page.locator('[data-settings-tab="ai"]').click();
    await page.getByRole('heading', { name: 'Speech to Text' }).waitFor({ state: 'visible' });
    await waitFor(() => state.targets.length === 1, 'single stack-tagged initSttSettings settings request');
    const target = state.targets[0];

    if (mode !== 'normal') {
      if (mode === 'settings-body') await page.waitForFunction(() => window.__settingsTrace.jsonStarted === true);
      const waiting = await page.evaluate(() => ({
        targetCount: window.__settingsTrace.targetCount,
        providerDisabled: document.querySelector('#set-sttProviderSelect').disabled,
        enabledDisabled: document.querySelector('#set-sttEnabledToggle').disabled,
        status: document.querySelector('#set-sttSettingsMsg').textContent,
        hasAbortSignal: !!window.__settingsTrace.signal,
        jsonStarted: window.__settingsTrace.jsonStarted,
      }));
      assert.equal(waiting.targetCount, 1);
      assert.equal(waiting.providerDisabled, true, 'controls remain inert until saved settings are loaded');
      assert.equal(waiting.enabledDisabled, true);
      assert.equal(waiting.hasAbortSignal, true, 'saved-settings request uses a local deadline signal');
      if (mode === 'settings-header' || mode === 'settings-body') {
        assert.equal(waiting.status, '', 'no false failure status before deadline');
        assert.equal(waiting.jsonStarted, mode === 'settings-body');
        await page.clock.fastForward(15001);
        await page.waitForFunction(() => document.querySelector('#set-sttSettingsMsg').textContent === 'Could not load saved speech settings. Reload the app to try again.');
        await waitFor(() => target.closed, 'deadline abort closes held saved-settings response');
        assert.equal(await page.evaluate(() => window.__settingsTrace.signal.aborted), true, 'settings GET aborts at the deadline');
        assert.equal(await page.locator('#set-sttProviderSelect').isDisabled(), true);
        assert.equal(await page.locator('#set-sttEnabledToggle').isDisabled(), true);
      } else {
        await page.waitForFunction(() => document.querySelector('#set-sttSettingsMsg').textContent === 'Could not load saved speech settings. Reload the app to try again.');
        await waitFor(() => target.ended, 'failed settings response is consumed');
        assert.equal(await page.evaluate(() => window.__settingsTrace.signal.aborted), false, 'ordinary HTTP/JSON failure does not trigger deadline');
        assert.equal(await page.locator('#set-sttProviderSelect').isDisabled(), true);
      }
      assert.equal(await page.locator('#set-sttSettingsMsg').textContent(), 'Could not load saved speech settings. Reload the app to try again.');
      assert.equal(state.settingsPosts.length, 0, 'failed initialization never POSTs settings');
      state.mode = 'normal';
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window._isAdmin === true, null, { timeout: 15000 });
      await waitFor(() => state.activeApi.size === 0, 'reload startup APIs complete');
      await page.locator('#user-bar-settings').click();
      await page.locator('#settings-modal:not(.hidden)').waitFor({ state: 'visible' });
      await page.locator('[data-settings-tab="ai"]').click();
      await page.getByRole('heading', { name: 'Speech to Text' }).waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('#set-sttProviderSelect').disabled === false);
      assert.equal(await page.locator('#set-sttProviderSelect').inputValue(), 'browser', 'manual reload recovers the saved provider');
      assert.equal(await page.locator('#set-sttEnabledToggle').isChecked(), true, 'manual reload recovers the saved enabled state');
      assert.equal(state.settingsPosts.length, 0, 'manual recovery also makes no settings writes');
    } else {
      await waitFor(() => target.ended, 'saved-settings request completes normally');
      await page.waitForFunction(() => document.querySelector('#set-sttProviderSelect').disabled === false);
      assert.equal(await page.locator('#set-sttProviderSelect').inputValue(), 'browser');
      assert.equal(await page.locator('#set-sttEnabledToggle').isChecked(), true);
      await page.clock.fastForward(15001);
      assert.equal(await page.evaluate(() => window.__settingsTrace.signal && window.__settingsTrace.signal.aborted), false, 'completed settings read is not aborted after the timer is cleared');
    }
    assert.equal(await page.evaluate(() => window.__micRequests), 0);
    assert.equal(state.settingsPosts.length, 0, 'initialization does not POST settings');
    assert.equal(state.calls.some(item => item.path === '/api/stt/transcribe' || item.path === '/api/tts/synthesize'), false);
    assert.equal(await page.evaluate(() => window.__settingsTrace.targetCount), 1, 'one initSttSettings saved-settings GET in the current page');
    assert.deepEqual(state.external, []);
    assert.deepEqual(state.pageErrors, []);
    return {
      mode, passed: true,
      targetClosed: target.closed, targetFinished: target.ended,
      settingsReadCount: await page.evaluate(() => window.__settingsTrace.targetCount),
      settingsTargetRequests: state.targets.length,
      finalProviderDisabled: await page.locator('#set-sttProviderSelect').isDisabled(),
      finalEnabled: await page.locator('#set-sttEnabledToggle').isChecked(),
      status: await page.locator('#set-sttSettingsMsg').textContent(),
      posts: state.settingsPosts.length, micRequests: await page.evaluate(() => window.__micRequests),
      endpointRequests: state.calls.filter(item => item.path === '/api/model-endpoints').length,
      sttStatsRequests: state.calls.filter(item => item.path === '/api/stt/stats').length,
      transcribeRequests: state.calls.filter(item => item.path === '/api/stt/transcribe').length,
      ttsSynthesizeRequests: state.calls.filter(item => item.path === '/api/tts/synthesize').length,
    };
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
    server.closeAllConnections();
  }
}

(async () => {
  let browser;
  let serverClosed = false;
  const result = { pass: false, base: '61b537be1610009f6b90033f4be9d2f2c253495a', cases: [], externalRequests: state.external, pageErrors: state.pageErrors, scope: 'actual static/index.html and settings/speech.js; one stack-tagged initSttSettings saved-settings GET held over loopback; all other startup APIs normal; no speech-device/provider/model access' };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-service-worker'] });
    for (const mode of ['normal', 'settings-header', 'settings-body', 'settings-503', 'settings-malformed']) {
      result.cases.push(await runCase(browser, origin, mode));
    }
    result.sourceHashes = Object.fromEntries(['static/index.html', 'static/js/settings.js', 'static/js/settings/speech.js', 'static/js/voiceRecorder.js'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]));
    result.apiCounts = {
      sttInventory: result.cases.reduce((sum, item) => sum + item.endpointRequests, 0),
      sttSettingsGET: result.cases.reduce((sum, item) => sum + item.settingsTargetRequests, 0),
      settingsPOST: result.cases.reduce((sum, item) => sum + item.posts, 0),
      sttStatsMetadata: result.cases.reduce((sum, item) => sum + item.sttStatsRequests, 0),
      sttTranscribe: result.cases.reduce((sum, item) => sum + item.transcribeRequests, 0),
      ttsSynthesize: result.cases.reduce((sum, item) => sum + item.ttsSynthesizeRequests, 0),
      external: state.external.length
    };
    assert.deepEqual(state.external, []);
    assert.deepEqual(state.pageErrors, []);
    result.pass = true;
  } catch (error) {
    result.error = error.stack || error.message;
    result.calls = state.calls;
    result.targets = state.targets.map(target => ({ caller: target.caller, ended: target.ended, closed: target.closed }));
  } finally {
    server.closeAllConnections();
    if (browser) await browser.close().catch(() => {});
    await new Promise(resolve => server.close(() => { serverClosed = true; resolve(); }));
    result.cleanup = { browserClosed: !browser || !browser.isConnected(), serverClosed };
  }
  if (!result.pass) { console.error(JSON.stringify(result, null, 2)); process.exitCode = 1; }
  else console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
