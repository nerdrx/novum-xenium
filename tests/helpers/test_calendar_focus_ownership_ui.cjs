// Hold real Calendar event reads so explicit focus requests can be raced against
// newer links and visible user actions through the exported module API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const pending = new Map();
const seen = new Map();
const heldUids = new Set(['refresh-event']);
const unexpected = [];
const event = uid => ({
  uid, summary: `Synthetic ${uid}`,
  dtstart: uid === 'refresh-event' ? '2027-05-15T10:00:00+01:00' : uid === 'link-b' || uid === 'race-b' ? '2027-02-15T10:00:00+01:00' : '2027-01-15T10:00:00+01:00',
  dtend: uid === 'refresh-event' ? '2027-05-15T11:00:00+01:00' : uid === 'link-b' || uid === 'race-b' ? '2027-02-15T11:00:00+01:00' : '2027-01-15T11:00:00+01:00',
  calendar_href: 'fixture-cal', calendar: 'Fixture', color: '#456789', all_day: false,
});
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/') return res.end('<!doctype html><meta charset="utf-8"><div id="toast"></div><script type="module">import cal from "/static/js/calendar.js";window.calendar=cal;window.fixtureReady=true;</script>');
  if (url.pathname === '/api/prefs/theme') return json({ value: null });
  if (url.pathname === '/api/prefs/custom-themes') return json({ value: {} });
  if (url.pathname === '/api/calendar/calendars') return json({ calendars: [{ href: 'fixture-cal', name: 'Fixture', color: '#456789' }] });
  if (url.pathname === '/api/calendar/events') {
    const start = url.searchParams.get('start') || '';
    const end = url.searchParams.get('end') || '';
    const date = '2027-05-15';
    return json({ events: start <= date && date < end ? [event('refresh-event')] : [] });
  }
  if (url.pathname === '/api/calendar/sync') return json({ calendars: 0, events: 0, deleted: 0 });
  if (url.pathname.startsWith('/__release/')) {
    const uid = decodeURIComponent(url.pathname.slice('/__release/'.length));
    const respond = pending.get(uid);
    pending.delete(uid);
    respond?.();
    res.writeHead(204); return res.end();
  }
  if (url.pathname.startsWith('/api/calendar/events/')) {
    const uid = decodeURIComponent(url.pathname.split('/').pop());
    if (uid.startsWith('race-') || heldUids.has(uid)) {
      seen.get(uid)?.();
      return new Promise(resolve => { pending.set(uid, () => { json({ event: event(uid) }); resolve(); }); });
    }
    return json({ event: event(uid) });
  }
  if (url.pathname.startsWith('/static/')) {
    const file = path.resolve(repo, `.${url.pathname}`);
    if (file.startsWith(repo + path.sep) && fs.existsSync(file)) {
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
      return fs.createReadStream(file).pipe(res);
    }
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404); res.end();
});

const requested = uid => new Promise(resolve => seen.set(uid, resolve));
const release = async (origin, uid) => {
  const response = await fetch(`${origin}/__release/${encodeURIComponent(uid)}`);
  assert.equal(response.status, 204);
};
const selectedDate = page => page.locator('#cal-body .cal-day.cal-selected').getAttribute('data-date');

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const contexts = [];
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
    const context = await browser.newContext({ timezoneId: 'Europe/Berlin' });
    contexts.push(context);
    const page = await context.newPage();
    const pageErrors = [];
    let externalRequests = 0;
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { externalRequests++; return route.abort(); }
      return route.continue();
    });
    // Guard the fixture origin before navigation so a misconfigured test cannot
    // accidentally open the deployed application or a non-loopback service.
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    await page.goto(origin);
    await page.waitForFunction(() => window.fixtureReady);

    const aRequested = requested('race-a');
    const linkA = page.evaluate(() => window.calendar.openCalendarTo('race-a'));
    await aRequested;
    const linkB = page.evaluate(() => window.calendar.openCalendarTo('link-b'));
    await page.locator('#cal-body .cal-day.cal-selected[data-date="2027-02-15"]').waitFor();
    assert.equal(await selectedDate(page), '2027-02-15');
    await release(origin, 'race-a');
    await linkA; await linkB;
    assert.equal(await selectedDate(page), '2027-02-15', 'older UID link must not replace the newer link date');

    const manualRequested = requested('race-manual');
    const manualLink = page.evaluate(() => window.calendar.openCalendarTo('race-manual'));
    await manualRequested;
    await page.locator('#cal-today').click();
    const manualDate = await selectedDate(page);
    await release(origin, 'race-manual'); await manualLink;
    assert.equal(await selectedDate(page), manualDate, 'held link must not replace manual Today navigation');

    const formRequested = requested('race-form');
    const formLink = page.evaluate(() => window.calendar.openCalendarTo('race-form'));
    await formRequested;
    await page.locator('#cal-add').click();
    await page.locator('#cal-body .cal-form').waitFor();
    await release(origin, 'race-form'); await formLink;
    assert.equal(await page.locator('#cal-body .cal-form').count(), 1, 'held link must not replace a newly opened form');

    const reopenRequested = requested('race-reopen');
    const reopenLink = page.evaluate(() => window.calendar.openCalendarTo('race-reopen'));
    await reopenRequested;
    await page.evaluate(() => { window.calendar.closeCalendar(); window.calendar.openCalendar(); });
    await page.locator('#cal-body .cal-day.cal-selected').waitFor();
    const reopenedDate = await selectedDate(page);
    await release(origin, 'race-reopen'); await reopenLink;
    assert.equal(await selectedDate(page), reopenedDate, 'held link must not change a close-and-reopen calendar');

    await page.evaluate(() => window.calendar.openCalendarTo('2027-03-12'));
    await page.locator('#cal-body .cal-day.cal-selected[data-date="2027-03-12"]').waitFor();
    assert.equal(await selectedDate(page), '2027-03-12', 'date links still focus their requested day');
    await page.evaluate(() => window.calendar.openCalendarTo('link-b'));
    await page.locator('#cal-body .cal-day.cal-selected[data-date="2027-02-15"]').waitFor();
    assert.equal(await selectedDate(page), '2027-02-15', 'UID links still focus their event date');
    await page.evaluate(() => window.calendar.openCalendarTo('search:focus-probe'));
    await page.locator('#cal-search').waitFor();
    assert.equal(await page.locator('#cal-search').inputValue(), 'focus-probe', 'search links still open the search view');
    await page.evaluate(() => window.calendar.openCalendarView('month', '2027-04-09'));
    await page.locator('#cal-body .cal-day.cal-selected[data-date="2027-04-09"]').waitFor();
    assert.equal(await selectedDate(page), '2027-04-09', 'sidebar view/date opens still focus the requested date');

    await page.evaluate(() => window.calendar.openCalendarTo('2027-05-15'));
    const search = page.locator('#cal-search');
    if (await search.count()) await search.fill('');
    const existingEvent = page.locator('#cal-body .cal-day-detail .cal-event-item[data-uid="refresh-event"]');
    await existingEvent.waitFor();
    const refreshRequested = requested('refresh-event');
    await existingEvent.click();
    await refreshRequested;
    const oldForm = await page.locator('#cal-body .cal-form').elementHandle();
    assert.ok(oldForm, 'clicking a real event row should open its form');
    await page.locator('#cal-f-sum').focus();
    const newerRequested = requested('race-after-form-refresh');
    const newerFocus = page.evaluate(() => window.calendar.openCalendarTo('race-after-form-refresh'));
    await newerRequested;
    await release(origin, 'refresh-event');
    await page.waitForFunction(node => !node.isConnected, oldForm);
    await page.locator('#cal-body .cal-form').waitFor();
    await release(origin, 'race-after-form-refresh'); await newerFocus;
    const formRefreshRace = {
      staleFormStillOpen: await page.locator('#cal-body .cal-form').count() === 1,
      selectedDateAfterFocus: await page.locator('#cal-body .cal-day.cal-selected').getAttribute('data-date').catch(() => null),
    };
    assert.equal(formRefreshRace.staleFormStillOpen, false, 'newer focus request must supersede older form refresh');
    assert.equal(formRefreshRace.selectedDateAfterFocus, '2027-01-15');

    const mobileContext = await browser.newContext({ timezoneId: 'Europe/Berlin', viewport: { width: 390, height: 844 } });
    contexts.push(mobileContext);
    const mobile = await mobileContext.newPage();
    mobile.on('pageerror', error => pageErrors.push(error.message));
    await mobile.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { externalRequests++; return route.abort(); }
      return route.continue();
    });
    await mobile.goto(origin);
    await mobile.waitForFunction(() => window.fixtureReady);
    await mobile.evaluate(() => window.calendar.openCalendarView('week', '2027-01-13'));
    const slot = mobile.locator('.cal-wk-grid[data-date="2027-01-13"]');
    await slot.waitFor();
    const mobileRequested = requested('race-mobile-slot');
    const mobileLink = mobile.evaluate(() => window.calendar.openCalendarTo('race-mobile-slot'));
    await mobileRequested;
    await slot.locator('.cal-wk-cell').first().click();
    const selectedSlot = mobile.locator('.cal-wk-slot-selected');
    await selectedSlot.waitFor({ state: 'attached' });
    const slotBeforeRelease = await selectedSlot.evaluate(el => el.closest('.cal-wk-grid')?.dataset.date);
    await release(origin, 'race-mobile-slot'); await mobileLink;
    const slotRetained = await selectedSlot.count() === 1;
    const mobileViewAfterRelease = await mobile.locator('.cal-view-btn.active').innerText();
    const mobileFocus = { selectedWeekSlotDateBeforeRelease: slotBeforeRelease, slotRetainedAfterRelease: slotRetained, viewAfterRelease: mobileViewAfterRelease };
    assert.equal(slotBeforeRelease, '2027-01-13');
    assert.equal(slotRetained, true, 'held UID link must not replace the first mobile week-slot tap');
    assert.equal(mobileViewAfterRelease.toLowerCase(), 'week', 'mobile week-slot selection must retain week view');

    assert.equal(externalRequests, 0);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(pageErrors, []);
    const result = {
      source: 'static/js/calendar.js exported API',
      cases: ['link A then B retains B after A release', 'manual Today supersedes held link', 'new form survives held link', 'close and reopen supersedes held link', 'date link', 'UID link', 'search link', 'sidebar view/date open', 'mobile week-slot first tap supersedes held UID link', 'older form detail refresh does not cancel newer focus'],
      mobileFocus, formRefreshRace,
      externalRequests, unexpectedRequests: unexpected, pageErrors,
      limits: 'Synthetic loopback browser only; no real events, accounts, CalDAV, reminders, providers, or network access.',
    };
    const evidenceDir = process.env.CALENDAR_FOCUS_EVIDENCE_DIR;
    if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, 'calendar-focus-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`PASS Calendar focus ownership ${JSON.stringify(result)}`);
  } finally {
    for (const respond of pending.values()) respond();
    pending.clear();
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
