// Exercise event-read timeouts and recovery through Calendar's public UI/API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const plans = new Map();
const pending = new Map();
const seen = [];
const completed = [];
const aborted = [];
const unexpected = [];
let requestNumber = 0;
const calendar = [{ href: 'fixture-cal', name: 'Fixture calendar', color: '#456789' }];
const html = '<!doctype html><meta charset="utf-8"><body><div id="toast"></div><script>window.__fixtureEventJson=[];const nativeFetch=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await nativeFetch(...args);if(new URL(args[0],location.href).pathname==="/api/calendar/events"){const id=response.headers.get("x-fixture-id");const nativeJson=response.json.bind(response);response.json=async(...jsonArgs)=>{const value=await nativeJson(...jsonArgs);if(id)queueMicrotask(()=>window.__fixtureEventJson.push(id));return value;};}return response;};</script><script type="module">import cal from "/static/js/calendar.js";window.calendar=cal;window.fixtureReady=true;</script></body>';

const keyFor = (start, end) => `${start}|${end}`;
function monthRange(day) {
  const [year, month] = day.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(year, month - 1, 1 - mondayOffset));
  const end = new Date(start.getTime() + 42 * 86400000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
const event = (uid, date, summary = uid) => ({
  uid, summary, dtstart: `${date}T10:00:00+01:00`, dtend: `${date}T11:00:00+01:00`,
  calendar_href: 'fixture-cal', calendar: 'Fixture calendar', color: '#456789', all_day: false,
});
function json(res, value, status = 200, headers = {}) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/api/prefs/theme' || url.pathname === '/api/prefs/custom-themes') return json(res, { value: null });
  if (url.pathname === '/api/calendar/calendars') return json(res, { calendars: calendar });
  if (url.pathname === '/api/calendar/sync') return json(res, { calendars: 0, events: 0, deleted: 0 });
  if (url.pathname === '/__state') return json(res, { seen, completed, aborted, pending: [...pending.keys()] });
  if (url.pathname === '/__plan' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const plan = JSON.parse(body);
    const key = keyFor(plan.start, plan.end);
    if (!plans.has(key)) plans.set(key, []);
    plans.get(key).push(plan);
    res.writeHead(204); return res.end();
  }
  if (url.pathname.startsWith('/__release/')) {
    const id = decodeURIComponent(url.pathname.slice('/__release/'.length));
    pending.get(id)?.release();
    pending.delete(id);
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/calendar/events') {
    const start = url.searchParams.get('start') || '';
    const end = url.searchParams.get('end') || '';
    const id = `event-${++requestNumber}`;
    const plan = plans.get(keyFor(start, end))?.shift() || { events: [] };
    const record = { id: plan.id || id, start, end };
    const fixtureHeader = { 'X-Fixture-Id': record.id };
    seen.push(record);
    res.on('finish', () => completed.push(record.id));
    res.on('close', () => {
      if (!res.writableEnded && !aborted.includes(record.id)) aborted.push(record.id);
      pending.delete(record.id);
    });
    if (plan.kind === 'hold-fetch') {
      pending.set(record.id, { release: () => json(res, plan.body || { events: plan.events || [] }, plan.status || 200, fixtureHeader) });
      return;
    }
    if (plan.kind === 'hold-json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...fixtureHeader });
      res.write('{"events":');
      pending.set(record.id, { release: () => { if (!res.destroyed) res.end(JSON.stringify(plan.events || []) + '}'); } });
      return;
    }
    if (plan.status && plan.status >= 400) return json(res, plan.body || { detail: `Synthetic HTTP ${plan.status}` }, plan.status, fixtureHeader);
    if (plan.body) return json(res, plan.body, 200, fixtureHeader);
    return json(res, { events: plan.events || [] }, 200, fixtureHeader);
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
async function state(page) {
  return page.evaluate(async () => await (await fetch('/__state')).json());
}
async function waitSeen(page, id) {
  await page.waitForFunction(async id => (await (await fetch('/__state')).json()).seen.some(item => item.id === id), id);
}
async function waitCompleted(page, id) {
  await page.waitForFunction(async id => (await (await fetch('/__state')).json()).completed.includes(id), id);
}
async function waitBodyApplied(page, id) {
  // The fixture observes native response JSON; this polling task runs after
  // Calendar's awaiting continuation has applied or discarded the payload.
  await page.waitForFunction(id => window.__fixtureEventJson.includes(id), id);
}
async function release(origin, id) {
  const response = await fetch(`${origin}/__release/${encodeURIComponent(id)}`);
  assert.equal(response.status, 204);
}
async function newCalendarPage(browser, origin, pageErrors, externalRequests, simulatedClock = false, pauseTimersBeforeOpen = false) {
  const context = await browser.newContext({ timezoneId: 'Europe/Berlin' });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  if (simulatedClock) await page.clock.install({ time: new Date('2027-01-15T12:00:00Z') });
  await page.goto(origin);
  await page.waitForFunction(() => window.fixtureReady);
  if (pauseTimersBeforeOpen) {
    assert.equal(simulatedClock, true, 'pausing fixture timers requires the native Playwright clock');
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1));
  }
  await page.evaluate(() => window.calendar.openCalendar());
  await page.locator('#cal-body .cal-grid').waitFor();
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

    // Cold range: fetch itself and response JSON body both have native 15s deadlines.
    const cold = await newCalendarPage(browser, origin, pageErrors, externalRequests, true);
    contexts.push(cold.context);
    const coldRange = monthRange('2027-04-15');
    await addPlan(origin, { ...coldRange, id: 'cold-fetch-timeout', kind: 'hold-fetch' });
    const coldOpen = cold.page.evaluate(() => window.calendar.openCalendarView('month', '2027-04-15'));
    await waitSeen(cold.page, 'cold-fetch-timeout');
    await cold.page.clock.runFor(15000);
    await coldOpen;
    await cold.page.locator('.cal-event-load-error[role="alert"]').waitFor({ timeout: 5000 }).catch(async error => {
      throw new Error(`${error.message}; debug=${JSON.stringify({ state: await state(cold.page), html: await cold.page.locator('#cal-body').innerText() })}`);
    });
    assert.match(await cold.page.locator('.cal-event-load-error').textContent(), /timed out/i);
    await cold.page.waitForFunction(async () => (await (await fetch('/__state')).json()).aborted.includes('cold-fetch-timeout'));
    await addPlan(origin, { ...coldRange, id: 'cold-fetch-retry', events: [event('retry-event', '2027-04-15', 'Recovered event')] });
    await cold.page.locator('[data-cal-event-retry]').click();
    await cold.page.locator('.cal-event-item[data-uid="retry-event"]').waitFor();
    await cold.page.locator('.cal-event-load-error').waitFor({ state: 'detached' });
    assert.equal((await state(cold.page)).seen.find(item => item.id === 'cold-fetch-retry').start, coldRange.start);
    checks.coldFetchTimeoutRetry = { aborted: true, retryRange: coldRange, recoveredEventVisible: true };
    await cold.context.close().catch(() => {});

    const formRetry = await newCalendarPage(browser, origin, pageErrors, externalRequests, true);
    contexts.push(formRetry.context);
    const formRange = monthRange('2027-04-15');
    await addPlan(origin, { ...formRange, id: 'form-retry-timeout', kind: 'hold-fetch' });
    const formOpen = formRetry.page.evaluate(() => window.calendar.openCalendarView('month', '2027-04-15'));
    await waitSeen(formRetry.page, 'form-retry-timeout');
    await formRetry.page.clock.runFor(15000);
    await formOpen;
    await formRetry.page.locator('.cal-event-load-error').waitFor();
    await addPlan(origin, { ...formRange, id: 'form-retry-held', kind: 'hold-fetch', events: [event('form-retry-event', '2027-04-15')] });
    await formRetry.page.locator('[data-cal-event-retry]').click();
    await waitSeen(formRetry.page, 'form-retry-held');
    await formRetry.page.locator('#cal-add').click();
    await formRetry.page.locator('#cal-body .cal-form').waitFor();
    await release(origin, 'form-retry-held');
    await waitCompleted(formRetry.page, 'form-retry-held');
    await formRetry.page.waitForFunction(() => document.querySelector('#cal-body .cal-form'));
    assert.equal(await formRetry.page.locator('#cal-body .cal-form').count(), 1);
    checks.retryDoesNotReplaceForm = { requestCompleted: true, formPreserved: true };
    await formRetry.context.close().catch(() => {});

    const bodyPage = await newCalendarPage(browser, origin, pageErrors, externalRequests, true);
    contexts.push(bodyPage.context);
    const bodyRange = monthRange('2027-05-15');
    await addPlan(origin, { ...bodyRange, id: 'cold-json-timeout', kind: 'hold-json' });
    const bodyOpen = bodyPage.page.evaluate(() => window.calendar.openCalendarView('month', '2027-05-15'));
    await bodyPage.page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending.includes('cold-json-timeout'));
    await bodyPage.page.clock.runFor(15000);
    await bodyOpen;
    await bodyPage.page.locator('.cal-event-load-error').waitFor();
    await bodyPage.page.waitForFunction(async () => (await (await fetch('/__state')).json()).aborted.includes('cold-json-timeout'));
    checks.coldJsonTimeout = { responseBodyAborted: true, visibleError: true, clock: 'Playwright simulated 15000ms' };
    await bodyPage.context.close().catch(() => {});

    // A normal zero-event response stays a normal empty month, while HTTP 503 is explicit.
    const emptyPage = await newCalendarPage(browser, origin, pageErrors, externalRequests);
    contexts.push(emptyPage.context);
    const emptyRange = monthRange('2027-06-15');
    await addPlan(origin, { ...emptyRange, id: 'successful-empty', events: [] });
    await emptyPage.page.evaluate(() => window.calendar.openCalendarView('month', '2027-06-15'));
    await emptyPage.page.locator('#cal-body .cal-grid').waitFor();
    assert.equal(await emptyPage.page.locator('.cal-event-load-error').count(), 0);
    checks.successfulEmpty = { gridVisible: true, loadErrorAbsent: true };
    const failedRange = monthRange('2027-07-15');
    await addPlan(origin, { ...failedRange, id: 'events-http-503', status: 503, body: { detail: 'Synthetic event outage' } });
    await emptyPage.page.evaluate(() => window.calendar.openCalendarView('month', '2027-07-15'));
    await emptyPage.page.locator('.cal-event-load-error').waitFor();
    assert.match(await emptyPage.page.locator('.cal-event-load-error').textContent(), /Synthetic event outage/);
    assert.equal(await emptyPage.page.locator('.cal-event-load-error button').textContent(), 'Retry');
    checks.http503 = { visibleFailure: true, retryPresent: true };
    const failedCallCount = (await state(emptyPage.page)).seen.filter(item => item.start === failedRange.start && item.end === failedRange.end).length;
    await emptyPage.page.locator('[data-view="month"]').click();
    await emptyPage.page.waitForFunction(async ({ start, end, count }) => {
      const state = await (await fetch('/__state')).json();
      return state.seen.filter(item => item.start === start && item.end === end).length === count;
    }, { ...failedRange, count: failedCallCount });
    assert.equal((await state(emptyPage.page)).seen.filter(item => item.start === failedRange.start && item.end === failedRange.end).length, failedCallCount, 'rerender should not retry the same failed range');
    checks.sameRangeNoLoop = { requestCount: failedCallCount };
    await emptyPage.context.close().catch(() => {});

    // Retain cached events on a different-range failure, then make retry exact.
    const cachedPage = await newCalendarPage(browser, origin, pageErrors, externalRequests);
    contexts.push(cachedPage.context);
    const seedRange = monthRange('2027-08-15');
    await addPlan(origin, { ...seedRange, id: 'cache-seed', events: [event('cached-event', '2027-08-15', 'Cached event')] });
    await cachedPage.page.evaluate(() => window.calendar.openCalendarView('month', '2027-08-15'));
    await cachedPage.page.locator('.cal-event-item[data-uid="cached-event"]').waitFor();
    const cacheFailure = monthRange('2027-09-15');
    await addPlan(origin, { ...cacheFailure, id: 'cache-range-malformed', body: {} });
    await cachedPage.page.evaluate(() => window.calendar.openCalendarView('month', '2027-09-15'));
    await cachedPage.page.locator('.cal-event-load-error').waitFor();
    assert.match(await cachedPage.page.locator('.cal-event-load-error').textContent(), /Invalid event response/);
    await cachedPage.page.evaluate(() => window.calendar.openCalendarView('month', '2027-08-15'));
    await cachedPage.page.locator('.cal-event-item[data-uid="cached-event"]').waitFor();
    assert.equal(await cachedPage.page.locator('.cal-event-load-error').count(), 0);
    await addPlan(origin, { ...cacheFailure, id: 'cache-range-failure-again', status: 503 });
    await cachedPage.page.evaluate(() => window.calendar.openCalendarView('month', '2027-09-15'));
    await cachedPage.page.locator('.cal-event-load-error').waitFor();
    await addPlan(origin, { ...cacheFailure, id: 'cache-range-retry', events: [event('retry-cached-range', '2027-09-15', 'Retry event')] });
    await cachedPage.page.locator('[data-cal-event-retry]').click();
    await cachedPage.page.locator('.cal-event-item[data-uid="retry-cached-range"]').waitFor();
    checks.cachedFailureRetry = { priorCachedEventRetained: true, retryRange: cacheFailure, retryEventVisible: true };
    await cachedPage.context.close().catch(() => {});

    // A stale error from range A cannot replace a newer successful range B.
    const racePage = await newCalendarPage(browser, origin, pageErrors, externalRequests);
    contexts.push(racePage.context);
    const rangeA = monthRange('2027-10-15');
    const rangeB = monthRange('2027-11-15');
    await addPlan(origin, { ...rangeA, id: 'old-range-a', kind: 'hold-fetch', status: 503, body: { detail: 'Stale outage A' } });
    const oldA = racePage.page.evaluate(() => window.calendar.openCalendarView('month', '2027-10-15'));
    await waitSeen(racePage.page, 'old-range-a');
    await addPlan(origin, { ...rangeB, id: 'new-range-b', events: [event('new-range-event', '2027-11-15', 'New range B')] });
    await racePage.page.evaluate(() => window.calendar.openCalendarView('month', '2027-11-15'));
    await racePage.page.locator('.cal-event-item[data-uid="new-range-event"]').waitFor();
    await release(origin, 'old-range-a');
    await oldA;
    await waitCompleted(racePage.page, 'old-range-a');
    assert.equal(await racePage.page.locator('.cal-event-load-error').count(), 0);
    assert.equal(await racePage.page.locator('.cal-day.cal-selected').getAttribute('data-date'), '2027-11-15');
    checks.oldErrorAfterNewSuccess = { newerRangeVisible: true, staleErrorIgnored: true };
    await racePage.context.close().catch(() => {});

    // Exercise X → cached Y → X using real toolbar navigation. The Playwright
    // clock is paused after setup so the 200ms adjacent prefetch cannot warm X.
    const returnPage = await newCalendarPage(browser, origin, pageErrors, externalRequests, true, true);
    contexts.push(returnPage.context);
    const cachedMonth = monthRange('2027-10-15');
    const middleMonth = monthRange('2027-11-15');
    const middleMonth2 = monthRange('2027-12-15');
    const pendingMonth = monthRange('2028-01-15');
    await addPlan(origin, { ...cachedMonth, id: 'return-cache-seed', events: [event('return-cache-seed', '2027-10-15', 'Cached October')] });
    await returnPage.page.evaluate(() => window.calendar.openCalendarView('month', '2027-10-15'));
    await returnPage.page.locator('.cal-event-item[data-uid="return-cache-seed"]').waitFor();

    // Cache the only intermediate month ranges through actual next-month clicks.
    await addPlan(origin, { ...middleMonth, id: 'return-cache-november', events: [event('return-cache-november', '2027-11-01', 'Cached November')] });
    await returnPage.page.locator('#cal-next').click();
    await returnPage.page.locator('.cal-event-item[data-uid="return-cache-november"]').waitFor();
    await addPlan(origin, { ...middleMonth2, id: 'return-cache-december', events: [event('return-cache-december', '2027-12-01', 'Cached December')] });
    await returnPage.page.locator('#cal-next').click();
    await returnPage.page.locator('.cal-event-item[data-uid="return-cache-december"]').waitFor();

    // Return to cached October, then request held X (January) once.
    await returnPage.page.locator('#cal-prev').click();
    await returnPage.page.locator('#cal-prev').click();
    await returnPage.page.waitForFunction(() => document.querySelector('.cal-day.cal-selected')?.getAttribute('data-date') === '2027-10-01');
    const xRequestBaseline = (await state(returnPage.page)).seen.length;
    await addPlan(origin, { ...pendingMonth, id: 'stale-x-held', kind: 'hold-fetch', status: 503, body: { detail: 'Stale X failure' } });
    await returnPage.page.locator('#cal-next').click();
    await returnPage.page.locator('#cal-next').click();
    await returnPage.page.locator('#cal-next').click();
    await waitSeen(returnPage.page, 'stale-x-held');

    // Cached Y invalidates X ownership without replacing the stale in-flight record.
    await returnPage.page.locator('#cal-prev').click();
    await returnPage.page.locator('#cal-prev').click();
    await returnPage.page.locator('#cal-prev').click();
    await returnPage.page.waitForFunction(() => document.querySelector('.cal-day.cal-selected')?.getAttribute('data-date') === '2027-10-01');
    await addPlan(origin, { ...pendingMonth, id: 'returned-x-current', kind: 'hold-fetch', events: [event('returned-x-event', '2028-01-01', 'Current X')] });
    await returnPage.page.locator('#cal-next').click();
    await returnPage.page.locator('#cal-next').click();
    await returnPage.page.locator('#cal-next').click();
    await waitSeen(returnPage.page, 'returned-x-current');
    const xRequests = (await state(returnPage.page)).seen.slice(xRequestBaseline).filter(item => item.start === pendingMonth.start && item.end === pendingMonth.end).map(item => item.id);
    assert.deepEqual(xRequests, ['stale-x-held', 'returned-x-current'], 'returning to uncached X starts a fresh request despite its stale in-flight record');

    await release(origin, 'returned-x-current');
    await waitCompleted(returnPage.page, 'returned-x-current');
    await waitBodyApplied(returnPage.page, 'returned-x-current');
    await returnPage.page.locator('.cal-event-item[data-uid="returned-x-event"]').waitFor();
    await release(origin, 'stale-x-held');
    await waitCompleted(returnPage.page, 'stale-x-held');
    await waitBodyApplied(returnPage.page, 'stale-x-held');
    assert.equal(await returnPage.page.locator('.cal-event-load-error').count(), 0);
    assert.equal(await returnPage.page.locator('.cal-event-item[data-uid="returned-x-event"]').count(), 1);
    checks.cachedRangeReturn = { currentRequestStarted: true, staleRequestIgnored: true, eventVisible: true, mainRangeRequests: xRequests };
    await returnPage.context.close().catch(() => {});

    // Search's two-year request keeps its warning and retries that exact range.
    const cachedSearch = await newCalendarPage(browser, origin, pageErrors, externalRequests, true);
    contexts.push(cachedSearch.context);
    const janRange = monthRange('2027-01-15');
    await addPlan(origin, { ...janRange, id: 'search-cache-seed', events: [event('search-cache-seed', '2027-01-15', 'Needle seed')] });
    await cachedSearch.page.evaluate(() => window.calendar.openCalendarView('month', '2027-01-15'));
    await cachedSearch.page.locator('.cal-event-item[data-uid="search-cache-seed"]').waitFor();
    const searchRange = { start: '2027-01-01', end: '2029-01-01' };
    await addPlan(origin, { ...searchRange, id: 'cached-search-held', kind: 'hold-fetch', events: [event('cached-search-match', '2027-03-20', 'Needle found')] });
    const cachedSearchOpen = cachedSearch.page.evaluate(() => window.calendar.openCalendarTo('search:needle'));
    await waitSeen(cachedSearch.page, 'cached-search-held');
    await cachedSearchOpen;
    await cachedSearch.page.locator('#cal-search').waitFor();
    const seedSearchText = await cachedSearch.page.locator("#cal-body").innerText();
    assert.match(seedSearchText, /1 result\s+Needle seed/);
    await release(origin, 'cached-search-held');
    await waitCompleted(cachedSearch.page, 'cached-search-held');
    await cachedSearch.page.waitForFunction(() => document.querySelector('#cal-body')?.innerText.includes('Needle found'));
    checks.cachedSearchSuccess = { broadRangeOwnerPreserved: true, resultVisible: true };
    await cachedSearch.context.close().catch(() => {});

    const searchPage = await newCalendarPage(browser, origin, pageErrors, externalRequests, true);
    contexts.push(searchPage.context);
    const failedSearchRange = { start: '2027-01-01', end: '2029-01-01' };
    await addPlan(origin, { ...failedSearchRange, id: 'search-range-failure', status: 503, body: { detail: 'Synthetic search outage' } });
    await searchPage.page.evaluate(() => window.calendar.openCalendarTo('search:needle'));
    await searchPage.page.locator('#cal-search').waitFor();
    await searchPage.page.locator('.cal-event-load-error').waitFor();
    assert.match(await searchPage.page.locator('.cal-event-load-error').textContent(), /Synthetic search outage/);
    const searchFailureCount = (await state(searchPage.page)).seen.filter(item => item.start === failedSearchRange.start && item.end === failedSearchRange.end).length;
    await searchPage.page.evaluate(() => window.calendar.openCalendarView('year', '2027-06-15'));
    await searchPage.page.locator('#cal-body .cal-year').waitFor();
    assert.equal(await searchPage.page.locator('.cal-event-load-error').count(), 1, 'broad search failure remains visible in year view');
    await searchPage.page.evaluate(() => window.calendar.openCalendarView('month', '2027-06-15'));
    await searchPage.page.locator('#cal-search').waitFor();
    assert.equal(await searchPage.page.locator('.cal-event-load-error').count(), 1, 'broad search failure remains visible after returning to search panel');
    assert.equal((await state(searchPage.page)).seen.filter(item => item.start === failedSearchRange.start && item.end === failedSearchRange.end).length, searchFailureCount, 'view changes do not retry the broad search range');
    await addPlan(origin, { ...failedSearchRange, id: 'search-range-retry', events: [event('search-match', '2027-03-20', 'Needle found')] });
    await searchPage.page.locator('[data-cal-event-retry]').click();
    await searchPage.page.waitForFunction(() => document.querySelector('#cal-body')?.innerText.includes('Needle found'));
    const searchRetry = (await state(searchPage.page)).seen.find(item => item.id === 'search-range-retry');
    assert.deepEqual({ start: searchRetry.start, end: searchRetry.end }, failedSearchRange);
    checks.searchRangeRetry = { warningSurvivedSearchRender: true, exactRetry: failedSearchRange, resultVisible: true };
    await searchPage.context.close().catch(() => {});

    assert.deepEqual(unexpected, []);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
    console.log(`PASS Calendar event loading recovery ${JSON.stringify({ checks, unexpectedRequests: unexpected, externalRequests, pageErrors })}`);
  } finally {
    for (const item of pending.values()) item.release();
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
