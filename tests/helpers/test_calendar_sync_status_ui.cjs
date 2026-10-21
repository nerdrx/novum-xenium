// Opt-in loopback proof for CalDAV sync response handling in the real UI.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

if (process.env.NOVUM_CALENDAR_SYNC_STATUS_UI_PROOF !== '1') {
  throw new Error('Opt in with NOVUM_CALENDAR_SYNC_STATUS_UI_PROOF=1');
}
const repo = path.resolve(__dirname, '../..');
const source = path.join(repo, 'static/js/calendar.js');
const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body class="theme-novum-xenium"><aside id="sidebar"></aside><button id="tool-calendar-btn">Calendar</button><div id="chat-container"></div><div id="toast"></div><script type="module">import * as calendar from '/static/js/calendar.js'; window.calendar=calendar; calendar.openCalendar(); window.fixtureReady=true;</script></body>`;
const state = { calendarGets: 0, eventGets: 0, syncCalls: [], mode: 'success', unexpected: [], active: { calendar: 0, event: 0, sync: 0 } };
const calendar = { href: 'fixture-calendar', name: 'Synthetic CalDAV calendar', color: '#5577dd' };
const json = (res, value, status = 200, category) => {
  if (category) {
    state.active[category]++;
    res.once('finish', () => state.active[category]--);
  }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/api/prefs/theme') return json(res, { value: null });
  if (url.pathname === '/api/prefs/custom-themes') return json(res, { value: {} });
  if (url.pathname === '/api/calendar/calendars') { state.calendarGets++; return json(res, { calendars: [calendar] }, 200, 'calendar'); }
  if (url.pathname === '/api/calendar/events' && req.method === 'GET') { state.eventGets++; return json(res, { events: [] }, 200, 'event'); }
  if (url.pathname === '/api/calendar/sync' && req.method === 'POST') {
    const mode = state.mode;
    const status = ['success', '200-invalid-json', '200-null', '200-empty-object', '200-errors-string'].includes(mode) ? 200 : 504;
    state.syncCalls.push({ mode, status });
    state.active.sync++;
    res.once('finish', () => state.active.sync--);
    if (mode === '504') return json(res, { detail: 'Synthetic FastAPI 504 detail' }, 504);
    if (mode === '504-text') { res.writeHead(504, { 'content-type': 'text/plain' }); return res.end('Gateway timeout text'); }
    if (mode === '200-invalid-json') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('not JSON'); }
    if (mode === '200-null') return json(res, null);
    if (mode === '200-empty-object') return json(res, {});
    if (mode === '200-errors-string') return json(res, { errors: 'bad' });
    return json(res, { calendars: 0, events: 0, deleted: 0, errors: [] });
  }
  if (url.pathname === '/__state') return json(res, state);
  if (url.pathname === '/__mode' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { state.mode = JSON.parse(body).mode; json(res, { ok: true }); });
    return;
  }
  if (url.pathname.startsWith('/static/')) {
    const file = path.resolve(repo, `.${url.pathname}`);
    if (!file.startsWith(path.join(repo, 'static') + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    return fs.createReadStream(file).pipe(res);
  }
  state.unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404); res.end();
});

async function getState(origin) { return (await fetch(`${origin}/__state`)).json(); }
async function setMode(origin, mode) {
  const response = await fetch(`${origin}/__mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
  assert.equal(response.status, 200);
}
async function runCase(page, origin, mode, expectedText, expectSuccess) {
  await setMode(origin, mode);
  const before = await getState(origin);
  const uiBefore = await page.evaluate(() => ({ history: window.__syncStatusHistory.length, removed: window.__calendarRemovedKeys.length }));
  await page.locator('#cal-settings-sync-now').click();
  if (expectSuccess) {
    await page.waitForFunction(({ index, text }) => window.__syncStatusHistory.slice(index).some(x => x.text === text && !x.isError), { index: uiBefore.history, text: expectedText });
    await page.waitForFunction(() => document.querySelector('#cal-settings-panel') && !document.querySelector('#cal-settings-sync-now')?.disabled);
    assert.equal(await page.locator('#cal-settings-sync-status').textContent(), '', 'success reopens the settings panel');
  } else {
    await page.locator('#cal-settings-sync-status.is-error').waitFor();
    assert.equal((await page.locator('#cal-settings-sync-status').textContent()).trim(), expectedText, 'failure remains visible in the open panel');
    assert.equal(await page.locator('#cal-settings-panel').count(), 1, 'failure leaves the settings panel open');
    assert.equal(await page.locator('#cal-settings-sync-now').isDisabled(), false, 'manual retry remains available');
  }
  if (expectSuccess) {
    await page.waitForFunction(async beforeEvents => {
      const s = await (await fetch('/__state')).json();
      return s.eventGets > beforeEvents && s.active.event === 0;
    }, before.eventGets);
  }
  const after = await getState(origin);
  const uiAfter = await page.evaluate(() => ({
    history: window.__syncStatusHistory,
    removed: window.__calendarRemovedKeys,
    currentText: document.querySelector('#cal-settings-sync-status')?.textContent ?? null,
    currentError: document.querySelector('#cal-settings-sync-status')?.classList.contains('is-error') ?? false,
  }));
  assert.equal(after.syncCalls.length, before.syncCalls.length + 1);
  const last = after.syncCalls.at(-1);
  assert.equal(last.mode, mode);
  const cacheRemovals = uiAfter.removed.slice(uiBefore.removed);
  const catalogGets = after.calendarGets - before.calendarGets;
  const eventGets = after.eventGets - before.eventGets;
  if (expectSuccess) {
    assert.deepEqual(cacheRemovals, ['odysseus-calendar-cache']);
    assert.ok(catalogGets > 0, 'success refreshes the calendar catalog');
    assert.ok(eventGets > 0, 'success refreshes calendar events');
  } else {
    assert.deepEqual(cacheRemovals, []);
    assert.equal(catalogGets, 0, 'failure does not refresh the calendar catalog');
    assert.equal(eventGets, 0, 'failure does not refresh calendar events');
  }
  return {
    mode, httpStatus: last.status, status: expectedText,
    isError: expectSuccess ? false : true,
    panelAfterHandler: expectSuccess ? 'reopened with blank status' : 'remains open with error',
    retryAvailableAfterHandler: true,
    cacheRemovals, calendarCatalogGets: catalogGets, eventGets,
  };
}
async function runMalformedObjectCase(page, origin, mode, expectedText) {
  await setMode(origin, mode);
  const before = await getState(origin);
  const uiBefore = await page.evaluate(() => ({ history: window.__syncStatusHistory.length, removed: window.__calendarRemovedKeys.length }));
  await page.locator('#cal-settings-sync-now').click();
  await page.waitForFunction(index => window.__syncStatusHistory.slice(index).some(x => x.text.startsWith('Sync failed:') || x.text.startsWith('Synced — ')), uiBefore.history);
  const observed = await page.evaluate(index => window.__syncStatusHistory.slice(index).find(x => x.text.startsWith('Sync failed:') || x.text.startsWith('Synced — ')), uiBefore.history);
  assert.equal(observed?.text, expectedText, 'malformed success envelopes must not appear successful');
  await page.locator('#cal-settings-sync-status.is-error').waitFor();
  assert.equal((await page.locator('#cal-settings-sync-status').textContent()).trim(), expectedText);
  assert.equal(await page.locator('#cal-settings-sync-now').isDisabled(), false, 'manual retry remains available');
  const after = await getState(origin);
  const removed = await page.evaluate(() => window.__calendarRemovedKeys);
  assert.equal(after.syncCalls.length, before.syncCalls.length + 1);
  assert.deepEqual(removed.slice(uiBefore.removed), []);
  assert.equal(after.calendarGets - before.calendarGets, 0);
  assert.equal(after.eventGets - before.eventGets, 0);
  return { mode, httpStatus: after.syncCalls.at(-1).status, status: observed.text, isError: observed.isError, retryAvailable: true, cacheRemovals: [], calendarCatalogGets: 0, eventGets: 0 };
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  let browser;
  let context;
  const externalRequests = [];
  const pageErrors = [];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--no-sandbox', '--disable-gpu'] });
    context = await browser.newContext();
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2027-01-15T12:00:00Z') });
    await context.addInitScript(() => {
      window.__calendarRemovedKeys = [];
      window.__syncStatusHistory = [];
      const remove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function(key) {
        if (key === 'odysseus-calendar-cache') window.__calendarRemovedKeys.push(key);
        return remove.call(this, key);
      };
      new MutationObserver(() => {
        const el = document.querySelector('#cal-settings-sync-status');
        if (el) window.__syncStatusHistory.push({ text: el.textContent, isError: el.classList.contains('is-error') });
      }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    // Install the deny-all-external request guard before navigation.
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { externalRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('#cal-settings'));
    await page.waitForFunction(async () => {
      const s = await (await fetch('/__state')).json();
      return s.calendarGets > 0 && s.eventGets > 0 && s.syncCalls.length > 0 && Object.values(s.active).every(n => n === 0);
    });
    await page.locator('#cal-settings').click();
    await page.locator('#cal-settings-sync-now').waitFor();
    await page.clock.pauseAt(new Date('2027-01-15T12:00:01Z'));
    await page.waitForFunction(async () => {
      const s = await (await fetch('/__state')).json();
      return Object.values(s.active).every(n => n === 0);
    });
    const cases = [];
    cases.push(await runCase(page, origin, '504', 'Sync failed: Synthetic FastAPI 504 detail', false));
    cases.push(await runCase(page, origin, 'success', 'Synced — no changes', true));
    cases.push(await runCase(page, origin, '504-text', 'Sync failed: Invalid JSON response (HTTP 504)', false));
    cases.push(await runCase(page, origin, '200-invalid-json', 'Sync failed: Invalid JSON response (HTTP 200)', false));
    cases.push(await runCase(page, origin, '200-null', 'Sync failed: Invalid response payload (HTTP 200)', false));
    cases.push(await runMalformedObjectCase(page, origin, '200-empty-object', 'Sync failed: Invalid response payload (HTTP 200)'));
    cases.push(await runCase(page, origin, '200-errors-string', 'Sync failed: Invalid response payload (HTTP 200)', false));
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(state.unexpected, []);
    assert.deepEqual(pageErrors, []);
    const result = {
      source: 'static/js/calendar.js', source_sha256: sourceSha256,
      fixture: 'Actual Calendar ES module/UI with loopback-only synthetic HTTP; no real account, calendar, provider, or external network.',
      cases, externalRequestCount: 0, unexpectedRequests: [], pageErrors,
      conclusion: 'HTTP status and unreadable response bodies produce persistent, retryable errors without cache removal or success refresh. Successful no-change sync retains its existing success refresh behavior.',
    };
    const evidenceDir = process.env.CALENDAR_SYNC_UI_EVIDENCE_DIR;
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(evidenceDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    }
    console.log(`PASS ${JSON.stringify(result)}`);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
