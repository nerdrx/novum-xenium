// Exercise Calendar catalog deadlines and request ownership through its public UI/API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const plans = [];
const pending = new Map();
const seen = [];
const aborted = [];
const bodyStarted = [];
const unexpected = [];
const defaultCalendars = [{ href: 'fixture-default', name: 'Fixture calendar', color: '#456789' }];
const html = `<!doctype html><meta charset="utf-8"><body><div id="toast"></div>
<script type="module">import calendar from '/static/js/calendar.js'; window.calendar = calendar; window.fixtureReady = true;</script></body>`;

function json(res, value, status = 200) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/prefs/theme') return json(res, { value: null });
  if (url.pathname === '/api/prefs/custom-themes') return json(res, { value: {} });
  if (url.pathname === '/api/calendar/sync') return json(res, { calendars: 0, events: 0, deleted: 0 });
  if (url.pathname === '/api/calendar/events') return json(res, { events: [] });
  if (url.pathname === '/__state') return json(res, { seen, aborted, bodyStarted, pending: [...pending.keys()] });
  if (url.pathname === '/__plan' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    plans.push(JSON.parse(body));
    res.writeHead(204); return res.end();
  }
  if (url.pathname.startsWith('/__release/')) {
    const id = decodeURIComponent(url.pathname.slice('/__release/'.length));
    pending.get(id)?.release();
    pending.delete(id);
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/calendar/calendars') {
    const plan = plans.shift() || { id: `catalog-${seen.length + 1}`, calendars: defaultCalendars };
    seen.push(plan.id);
    const trackAbort = () => {
      if (!res.writableEnded && !aborted.includes(plan.id)) aborted.push(plan.id);
      pending.delete(plan.id);
    };
    res.on('close', trackAbort);
    if (plan.kind === 'hold-fetch') {
      pending.set(plan.id, { release: () => json(res, plan.body || { calendars: plan.calendars || defaultCalendars }, plan.status || 200) });
      return;
    }
    if (plan.kind === 'hold-json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.write('{"calendars":');
      bodyStarted.push(plan.id);
      pending.set(plan.id, { release: () => res.destroyed ? undefined : res.end(JSON.stringify(plan.calendars || defaultCalendars) + '}') });
      return;
    }
    if (plan.status && plan.status >= 400) return json(res, plan.body || { detail: `Synthetic HTTP ${plan.status}` }, plan.status);
    return json(res, { calendars: plan.calendars || defaultCalendars });
  }
  if (url.pathname.startsWith('/static/')) {
    const file = path.resolve(repo, `.${url.pathname}`);
    if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
    return fs.createReadStream(file).pipe(res);
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404); res.end();
});

async function addPlan(origin, plan) {
  const response = await fetch(`${origin}/__plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(plan) });
  assert.equal(response.status, 204);
}

async function waitSeen(page, id, body = false) {
  await page.waitForFunction(async ({ id, body }) => {
    const state = await (await fetch('/__state')).json();
    return (body ? state.bodyStarted : state.seen).includes(id);
  }, { id, body });
}

async function release(origin, id) {
  const response = await fetch(`${origin}/__release/${encodeURIComponent(id)}`);
  assert.equal(response.status, 204);
}

async function openFixturePage(browser, origin, pageErrors, externalRequests) {
  const context = await browser.newContext({ timezoneId: 'Europe/Berlin' });
  const page = await context.newPage();
  const baselineCatalogCalls = seen.length;
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  await page.goto(origin);
  await page.waitForFunction(() => window.fixtureReady);
  await page.waitForFunction(async baseline => {
    const state = await (await fetch('/__state')).json();
    return state.seen.length >= baseline + 2;
  }, baselineCatalogCalls, { timeout: 10000 });
  return { context, page };
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const contexts = [];
  const pageErrors = [];
  const externalRequests = [];
  const checks = {};
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });

    const timeoutContext = await browser.newContext({ timezoneId: 'Europe/Berlin' });
    contexts.push(timeoutContext);
    const timeoutPage = await timeoutContext.newPage();
    await timeoutPage.clock.install({ time: new Date('2027-01-15T12:00:00Z') });
    timeoutPage.on('pageerror', error => pageErrors.push(error.stack || error.message));
    await timeoutPage.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { externalRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    await timeoutPage.goto(origin);
    await timeoutPage.waitForFunction(() => window.fixtureReady);
    await timeoutPage.waitForFunction(async () => {
      const state = await (await fetch('/__state')).json();
      return state.seen.includes('catalog-1') && state.seen.length >= 2;
    });

    await addPlan(origin, { id: 'timeout-fetch', kind: 'hold-fetch' });
    await timeoutPage.evaluate(() => window.calendar.openCalendar());
    await waitSeen(timeoutPage, 'timeout-fetch');
    await timeoutPage.locator('#cal-body .cal-loading').waitFor();
    await timeoutPage.clock.runFor(15000);
    await timeoutPage.locator('.cal-empty-title').waitFor();
    assert.equal(await timeoutPage.locator('.cal-empty-title').textContent(), 'Calendar unavailable', JSON.stringify({ message: await timeoutPage.locator('.cal-empty-msg').textContent(), state: await timeoutPage.evaluate(async () => await (await fetch('/__state')).json()) }));
    assert.match(await timeoutPage.locator('.cal-empty-msg').textContent(), /timed out/i);
    await timeoutPage.waitForFunction(async () => (await (await fetch('/__state')).json()).aborted.includes('timeout-fetch'));
    checks.heldFetchTimeout = { unavailable: true, timedOutMessage: true, requestAborted: true, clock: 'Playwright simulated 15000ms' };

    await timeoutPage.evaluate(() => window.calendar.closeCalendar());
    await timeoutPage.evaluate(() => window.calendar.openCalendar());
    await timeoutPage.locator('#cal-body .cal-grid').waitFor();
    checks.closeReopenRetry = { gridVisible: true };

    const jsonContext = await browser.newContext({ timezoneId: 'Europe/Berlin' });
    contexts.push(jsonContext);
    const jsonPage = await jsonContext.newPage();
    const catalogBaseline = seen.length;
    await jsonPage.clock.install({ time: new Date('2027-01-15T12:00:00Z') });
    jsonPage.on('pageerror', error => pageErrors.push(error.stack || error.message));
    await jsonPage.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { externalRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    await jsonPage.goto(origin);
    await jsonPage.waitForFunction(() => window.fixtureReady);
    await jsonPage.waitForFunction(async baseline => (await (await fetch('/__state')).json()).seen.length >= baseline + 2, catalogBaseline);

    await addPlan(origin, { id: 'timeout-json', kind: 'hold-json' });
    await jsonPage.evaluate(() => window.calendar.openCalendar());
    await waitSeen(jsonPage, 'timeout-json', true);
    await jsonPage.clock.runFor(15000);
    await jsonPage.waitForFunction(() => document.querySelector('.cal-empty-msg')?.textContent.includes('timed out'));
    assert.equal(await jsonPage.locator('.cal-empty-title').textContent(), 'Calendar unavailable');
    await jsonPage.waitForFunction(async () => (await (await fetch('/__state')).json()).aborted.includes('timeout-json'));
    checks.heldJsonTimeout = { unavailable: true, timedOutMessage: true, requestAborted: true, clock: 'Playwright simulated 15000ms' };

    await jsonPage.evaluate(() => window.calendar.closeCalendar());
    await addPlan(origin, { id: 'catalog-503', status: 503, body: { detail: 'Synthetic catalog outage' } });
    await jsonPage.evaluate(() => window.calendar.openCalendar());
    await jsonPage.waitForFunction(() => document.querySelector('.cal-empty-msg')?.textContent.includes('Synthetic catalog outage'));
    assert.equal(await jsonPage.locator('.cal-empty-title').textContent(), 'Calendar unavailable');
    checks.http503 = { unavailable: true, message: 'Synthetic catalog outage' };

    const race = await openFixturePage(browser, origin, pageErrors, externalRequests);
    contexts.push(race.context);
    const { page } = race;
    await page.evaluate(() => window.calendar.openCalendarView('month', '2027-01-15'));
    await page.locator('#cal-body .cal-day.cal-selected[data-date="2027-01-15"]').waitFor();
    await addPlan(origin, { id: 'late-error-a', kind: 'hold-fetch', status: 503, body: { detail: 'Synthetic stale catalog outage' } });
    const oldErrorView = page.evaluate(() => window.calendar.openCalendarView('month', '2027-01-15'));
    await waitSeen(page, 'late-error-a');
    await addPlan(origin, { id: 'success-b-error-race', calendars: [{ href: 'catalog-b-error-race', name: 'Catalog B', color: '#198754' }] });
    const newerView = page.evaluate(() => window.calendar.openCalendarView('month', '2027-02-15'));
    await page.locator('#cal-body .cal-day.cal-selected[data-date="2027-02-15"]').waitFor();
    await newerView;
    await release(origin, 'late-error-a');
    await oldErrorView;
    await page.locator('#cal-settings').click();
    assert.equal(await page.locator('#cal-settings-list .cal-settings-row').count(), 1);
    assert.equal(await page.locator('#cal-settings-list .cal-s-name').inputValue(), 'Catalog B');
    checks.lateErrorAfterNewSuccess = { selectedDate: '2027-02-15', catalogName: 'Catalog B', oldErrorIgnored: true };
    await page.locator('#cal-settings-close').click();

    await addPlan(origin, { id: 'late-success-a', kind: 'hold-fetch', calendars: [{ href: 'catalog-a-late', name: 'Catalog A late', color: '#dc3545' }] });
    const oldSuccessView = page.evaluate(() => window.calendar.openCalendarView('month', '2027-04-09'));
    await waitSeen(page, 'late-success-a');
    await addPlan(origin, { id: 'success-b-success-race', calendars: [{ href: 'catalog-b-success', name: 'Catalog B newest', color: '#198754' }] });
    const newView = page.evaluate(() => window.calendar.openCalendarView('month', '2027-03-12'));
    await page.locator('#cal-body .cal-day.cal-selected[data-date="2027-03-12"]').waitFor();
    await newView;
    await release(origin, 'late-success-a');
    await oldSuccessView;
    await page.locator('#cal-settings').click();
    assert.equal(await page.locator('#cal-settings-list .cal-settings-row').count(), 1);
    assert.equal(await page.locator('#cal-settings-list .cal-s-name').inputValue(), 'Catalog B newest');
    checks.lateSuccessAfterNewSuccess = { selectedDate: '2027-03-12', catalogName: 'Catalog B newest', oldCatalogIgnored: true };

    assert.deepEqual(unexpected, []);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
    console.log(`PASS Calendar catalog loading recovery ${JSON.stringify({ checks, unexpectedRequests: unexpected, externalRequests, pageErrors })}`);
  } finally {
    for (const item of pending.values()) item.release();
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
