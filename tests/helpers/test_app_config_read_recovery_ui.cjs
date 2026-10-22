const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || '/run/media/nerdrx/Lex/novum-xenium/node_modules/playwright');

const repo = path.resolve(process.env.SOURCE_ROOT || path.join(__dirname, '../..'));
const sourcePath = path.join(repo, 'static/js/appConfig.js');
const source = fs.readFileSync(sourcePath);
const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
let plans = [];
let settingsRequests = 0;
let toolsRequests = 0;
const requestEvents = [];
let requestWaiters = [];
const held = new Set();
const externalRequests = [];
const pageErrors = [];

function sendJson(res, body, status = 200) {
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function waitNextRequest() {
  return new Promise(resolve => requestWaiters.push(resolve));
}
function noteRequest(entry) {
  requestEvents.push(entry);
  for (const resolve of requestWaiters.splice(0)) resolve(entry);
}
function release(entry, mode = 'success') {
  if (!entry || entry.res.writableEnded || entry.res.destroyed) return;
  if (mode === 'invalid-json') {
    if (!entry.res.headersSent) entry.res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    entry.res.end('{');
    return;
  }
  sendJson(entry.res, mode === '503' ? { detail: 'synthetic unavailable' } : { fixture: `settings-${settingsRequests}` }, mode === '503' ? 503 : 200);
}
function waitClosed(entry) {
  if (entry.closed) return Promise.resolve();
  return new Promise(resolve => entry.res.once('close', resolve));
}
function reset({ settings = [], tools = 0 } = {}) {
  plans = settings.slice();
  settingsRequests = 0;
  toolsRequests = 0;
  requestEvents.length = 0;
  requestWaiters = [];
  held.clear();
  return tools;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!doctype html><meta charset="utf-8"><script type="module">
      const nativeFetch = window.fetch.bind(window);
      window.__fetchHeaders = 0;
      window.__signalAborts = 0;
      window.fetch = (input, init = {}) => {
        init.signal?.addEventListener('abort', () => window.__signalAborts++, { once: true });
        return nativeFetch(input, init).then(response => { window.__fetchHeaders++; return response; });
      };
      window.__appConfig = await import('/static/js/appConfig.js');
      window.__startPair = () => {
        const first = window.__appConfig.getSettings();
        const second = window.__appConfig.getSettings();
        window.__pair = { same: first === second, firstDone: false, secondDone: false };
        first.then(value => { window.__pair.firstDone = true; window.__pair.firstValue = value; }, error => { window.__pair.firstDone = true; window.__pair.firstError = String(error); });
        second.then(value => { window.__pair.secondDone = true; window.__pair.secondValue = value; }, error => { window.__pair.secondDone = true; window.__pair.secondError = String(error); });
      };
    </script>`);
  }
  if (url.pathname === '/static/js/appConfig.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    return res.end(source);
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'GET') {
    settingsRequests++;
    const plan = plans.shift() || { kind: 'success' };
    const entry = { path: url.pathname, plan, req, res, headers: false, ended: false, closed: false, aborted: false };
    res.on('finish', () => { entry.ended = true; });
    res.on('close', () => { entry.closed = true; entry.aborted = !entry.ended; held.delete(entry); });
    noteRequest(entry);
    if (plan.kind === '503') return release(entry, '503');
    if (plan.kind === 'hold-headers' || plan.kind === 'hold-body' || plan.kind === 'hold-invalid-json') {
      held.add(entry);
      if (plan.kind !== 'hold-headers') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.flushHeaders();
        entry.headers = true;
      }
      return;
    }
    return release(entry);
  }
  if (url.pathname === '/api/tools' && req.method === 'GET') {
    toolsRequests++;
    noteRequest({ path: url.pathname });
    return sendJson(res, { tools: [{ id: 'synthetic_tool' }] });
  }
  res.writeHead(404); res.end('not found');
});

async function openPage(browser, origin) {
  const context = await browser.newContext();
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { externalRequests.push(url.href); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__appConfig);
  return { context, page };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Harness timeout: ${label}`)), 12000); })]);
  } finally { clearTimeout(timer); }
}

(async () => {
  let browser;
  const contexts = new Set();
  const results = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-service-worker'] });

    reset();
    let env = await openPage(browser, origin); contexts.add(env.context);
    const success = await bounded(env.page.evaluate(async () => {
      const settings = await window.__appConfig.getSettings();
      const settingsAgain = await window.__appConfig.getSettings();
      const tools = await window.__appConfig.getTools();
      const toolsAgain = await window.__appConfig.getTools();
      window.__appConfig.invalidateSettings();
      const settingsAfterInvalidate = await window.__appConfig.getSettings();
      return { settingsSame: settings === settingsAgain, toolsSame: tools === toolsAgain, settings, tools, settingsAfterInvalidate };
    }), 'success/invalidation controls');
    assert.equal(success.settingsSame, true);
    assert.equal(success.toolsSame, true);
    assert.equal(success.settings.fixture, 'settings-1');
    assert.deepEqual(success.tools.tools, [{ id: 'synthetic_tool' }]);
    assert.equal(success.settingsAfterInvalidate.fixture, 'settings-2');
    assert.equal(settingsRequests, 2);
    assert.equal(toolsRequests, 1);
    results.push({ case: 'success-cache-and-invalidation-controls', settingsFetches: settingsRequests, toolsFetches: toolsRequests, settingsCacheReused: success.settingsSame, toolsCacheReused: success.toolsSame, invalidationRefetched: success.settingsAfterInvalidate.fixture === 'settings-2' });
    await env.context.close(); contexts.delete(env.context);

    reset({ settings: [{ kind: '503' }, { kind: 'success' }] });
    env = await openPage(browser, origin); contexts.add(env.context);
    const httpFailure = await bounded(env.page.evaluate(async () => {
      let message = '';
      try { await window.__appConfig.getSettings(); } catch (error) { message = error.message; }
      const retry = await window.__appConfig.getSettings();
      return { message, retry };
    }), 'HTTP 503 and retry');
    assert.equal(httpFailure.message, 'HTTP 503');
    assert.equal(httpFailure.retry.fixture, 'settings-2');
    assert.equal(settingsRequests, 2);
    results.push({ case: 'http503-rejects-and-explicit-next-read-recovers', firstError: httpFailure.message, retryFixture: httpFailure.retry.fixture, requestCount: settingsRequests });
    await env.context.close(); contexts.delete(env.context);

    for (const phase of ['hold-headers', 'hold-body']) {
      reset({ settings: [{ kind: phase }, { kind: 'success' }] });
      env = await openPage(browser, origin); contexts.add(env.context);
      await env.page.clock.install();
      const next = waitNextRequest();
      await env.page.evaluate(() => window.__startPair());
      const heldEntry = await bounded(next, `${phase} request arrival`);
      if (phase === 'hold-body') await env.page.waitForFunction(() => window.__fetchHeaders === 1);
      const beforeAbort = await env.page.evaluate(() => ({ ...window.__pair, fetchHeaders: window.__fetchHeaders, signalAborts: window.__signalAborts }));
      assert.equal(beforeAbort.same, true);
      assert.equal(beforeAbort.firstDone, false);
      assert.equal(beforeAbort.secondDone, false);
      assert.equal(settingsRequests, 1);
      if (phase === 'hold-body') assert.equal(heldEntry.headers, true);
      await env.page.clock.fastForward(15000);
      await env.page.waitForFunction(() => window.__pair.firstDone && window.__pair.secondDone);
      await bounded(waitClosed(heldEntry), `${phase} abort closes fixture response`);
      const timedOut = await env.page.evaluate(() => ({ firstError: window.__pair.firstError, secondError: window.__pair.secondError, signalAborts: window.__signalAborts }));
      assert.match(timedOut.firstError, /AbortError|aborted/i);
      assert.match(timedOut.secondError, /AbortError|aborted/i);
      assert.equal(timedOut.signalAborts, 1);
      assert.equal(heldEntry.aborted, true);
      assert.equal(settingsRequests, 1, 'timeout must not automatically retry');
      const retry = await bounded(env.page.evaluate(() => window.__appConfig.getSettings()), `${phase} explicit retry`);
      assert.equal(retry.fixture, 'settings-2');
      assert.equal(settingsRequests, 2);
      results.push({ case: phase, coalescedCallers: beforeAbort.same, bothPendingBeforeDeadline: !beforeAbort.firstDone && !beforeAbort.secondDone, signalAbortCount: timedOut.signalAborts, responseClosedAsAborted: heldEntry.aborted, automaticRetries: 0, explicitRetryFixture: retry.fixture });
      await env.context.close(); contexts.delete(env.context);
    }

    reset({ settings: [{ kind: 'hold-invalid-json' }, { kind: 'success' }] });
    env = await openPage(browser, origin); contexts.add(env.context);
    const staleFirstRequest = waitNextRequest();
    await env.page.evaluate(() => {
      window.__oldRead = window.__appConfig.getSettings().then(value => ({ value }), error => ({ error: error.message }));
    });
    const oldEntry = await bounded(staleFirstRequest, 'stale request arrival');
    const newer = await bounded(env.page.evaluate(async () => {
      window.__appConfig.invalidateSettings();
      window.__newRead = window.__appConfig.getSettings();
      window.__newValue = await window.__newRead;
      return window.__newValue;
    }), 'newer read after invalidation');
    assert.equal(newer.fixture, 'settings-2');
    assert.equal(settingsRequests, 2);
    release(oldEntry, 'invalid-json');
    const oldResult = await bounded(env.page.evaluate(() => window.__oldRead), 'older malformed response rejection');
    assert.match(oldResult.error, /JSON|Unexpected|position/i);
    const afterStaleFailure = await bounded(env.page.evaluate(async () => {
      const current = await window.__appConfig.getSettings();
      return { sameObject: current === window.__newValue, fixture: current.fixture };
    }), 'current cache after stale failure');
    assert.equal(afterStaleFailure.sameObject, true, 'late stale rejection must not clear the newer cache slot');
    assert.equal(afterStaleFailure.fixture, newer.fixture);
    assert.equal(settingsRequests, 2, 'newer cached value remains reusable after stale rejection');
    results.push({ case: 'invalidate-refetch-stale-error-preserves-newer-cache', oldError: oldResult.error, newerFixture: newer.fixture, cacheObjectPreserved: afterStaleFailure.sameObject, requestCount: settingsRequests });
    await env.context.close(); contexts.delete(env.context);

    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ pass: true, sourceSha256, results, externalRequests, pageErrors, cleanup: { contextsClosed: true, browserClosed: true, serverClosed: true }, clock: 'Playwright simulated 15-second deadline; no 15-second wall wait.' }, null, 2));
  } finally {
    for (const entry of held) release(entry);
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
