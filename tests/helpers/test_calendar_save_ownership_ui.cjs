// Deferred fake Calendar requests verify that stale saves cannot replace a newer form/view.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let held = null;
let requestSequence = 0;
let failNextCreate = false;
const reminders = [];
const saveBodies = [];
const html = `<!doctype html><meta charset="utf-8"><body><div id="toast"></div><script type="module">import '/static/js/calendar.js'; window.fixtureReady = true;</script></body>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/calendar/calendars') return json({ calendars: [{ href: 'fake-cal', name: 'Fake', color: '#456789' }] });
  if (url.pathname === '/api/calendar/events' && req.method === 'GET') return json({ events: [] });
  if (url.pathname === '/api/calendar/sync') return json({ calendars: 0, events: 0, deleted: 0 });
  if (url.pathname === '/__state') return json({ reminders, saveBodies, pending: !!held });
  if (url.pathname === '/__fail-next-create') { failNextCreate = true; res.writeHead(204); return res.end(); }
  if (url.pathname === '/__release') {
    const release = held; held = null; release?.(); res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/calendar/events' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    const uid = `created-${++requestSequence}`;
    saveBodies.push({ method: 'POST', uid, ...data });
    if (failNextCreate) { failNextCreate = false; return json({ detail: 'temporary failure' }, 503); }
    const respond = () => json({ uid, event: { ...data, uid } });
    if (url.searchParams.has('hold')) held = respond; else respond();
    return;
  }
  if (url.pathname.startsWith('/api/calendar/events/') && req.method === 'PUT') {
    let body = ''; for await (const chunk of req) body += chunk;
    const uid = decodeURIComponent(url.pathname.split('/').pop());
    const data = JSON.parse(body);
    saveBodies.push({ method: 'PUT', uid, ...data });
    const respond = () => json({ event: { ...data, uid } });
    if (url.searchParams.has('hold')) held = respond; else respond();
    return;
  }
  if (url.pathname.startsWith('/static/')) {
    const file = path.resolve(repo, `.${url.pathname}`);
    if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
    if (url.pathname === '/static/js/calendar.js') {
      let source = fs.readFileSync(file, 'utf8');
      source = source.replace('await _createEventReminder(', 'await window.__calendarTestReminder(');
      source = source.replace('const calendarModule = {', `
        window.__calendarTest = {
          showNew: date => _showEventForm(null, date),
          showExisting: ev => { _allEvents[ev.uid] = ev; _showEventForm({ ...ev, __detailFresh: true }); },
          close: _doCloseCalendar,
          open: () => openCalendar({ preserveFocus: true }),
          setView: date => { _currentDate = new Date(date + 'T00:00:00'); _selectedDay = date; },
          state: uid => ({ open: _open, selectedDay: _selectedDay, event: _allEvents[uid], cache: JSON.parse(localStorage.getItem(LS_KEY) || '{}') })
        };
        const calendarModule = {`);
      return res.end(source);
    }
    fs.createReadStream(file).pipe(res); return;
  }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const context = await browser.newContext({ timezoneId: 'Europe/Berlin' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.addInitScript(() => { window.__calendarTestReminder = async (ev, due) => { window.__reminderCalls ||= []; window.__reminderCalls.push({ uid: ev.uid, due: new Date(due).toISOString() }); }; });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && window.__calendarTest);
    await page.evaluate(() => window.__calendarTest.open());
    await page.waitForFunction(() => document.querySelector('#cal-body .cal-grid'));

    // Late create after close/reopen and a newer form must preserve that form and its selection.
    await page.evaluate(() => window.__calendarTest.showNew('2027-01-15'));
    await page.locator('#cal-f-sum').fill('Saved event');
    await page.locator('#cal-f-remind').selectOption('custom');
    await page.locator('#cal-f-remind-custom').fill('2027-01-15T08:15');
    await page.route('**/api/calendar/events', async route => {
      if (route.request().method() === 'POST') route.continue({ url: route.request().url() + '?hold=1' });
      else route.continue();
    });
    await page.locator('#cal-f-save').click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending);
    await page.locator('#cal-f-save').evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(await page.evaluate(async () => (await (await fetch('/__state')).json()).saveBodies.filter(row => row.summary === 'Saved event').length), 1, 'a second click cannot duplicate the pending create');
    await page.evaluate(() => { window.__calendarTest.close(); window.__calendarTest.open(); });
    await page.waitForFunction(() => document.querySelector('#cal-body .cal-grid'));
    await page.evaluate(() => { window.__calendarTest.setView('2027-02-15'); window.__calendarTest.showNew('2027-02-15'); });
    await page.locator('#cal-f-sum').fill('Newer draft');
    await page.evaluate(() => fetch('/__release'));
    await page.unroute('**/api/calendar/events');
    await page.waitForFunction(() => window.__reminderCalls?.length === 1);
    assert.equal(await page.locator('#cal-f-sum').inputValue(), 'Newer draft');
    let state = await page.evaluate(() => window.__calendarTest.state('created-1'));
    assert.equal(state.selectedDay, '2027-02-15');
    assert.equal(state.event.summary, 'Saved event');
    assert.equal(state.cache.events.some(ev => ev.uid === 'created-1'), true, 'successful create remains cached');
    assert.equal((await page.evaluate(() => window.__reminderCalls[0])).due, '2027-01-15T07:15:00.000Z', 'original custom reminder value survives helper renders');
    assert.equal((await page.evaluate(() => window.__calendarTest.state('created-1').cache.events.find(ev => ev.uid === 'created-1').dtstart)), '2027-01-15T08:00:00.000Z', 'winter event uses the selected date offset');

    // Late update after another close/reopen also leaves the newer form intact while persisting data.
    await page.evaluate(() => { window.__calendarTest.close(); window.__calendarTest.open(); });
    await page.waitForFunction(() => document.querySelector('#cal-body .cal-grid'));
    await page.evaluate(() => window.__calendarTest.showExisting({ uid: 'existing-1', summary: 'Before', dtstart: '2027-06-20T09:00:00Z', dtend: '2027-06-20T10:00:00Z', calendar_href: 'fake-cal' }));
    await page.locator('#cal-f-sum').fill('Updated event');
    await page.locator('#cal-f-start').fill('09:00');
    await page.locator('#cal-f-end').fill('10:00');
    await page.route('**/api/calendar/events/existing-1', route => route.continue({ url: route.request().url() + '?hold=1' }));
    await page.locator('#cal-f-save').click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending);
    await page.evaluate(() => { window.__calendarTest.close(); window.__calendarTest.open(); });
    await page.waitForFunction(() => document.querySelector('#cal-body .cal-grid'));
    await page.evaluate(() => { window.__calendarTest.setView('2027-03-12'); window.__calendarTest.showNew('2027-03-12'); });
    await page.locator('#cal-f-sum').fill('Another draft');
    await page.evaluate(() => fetch('/__release'));
    await page.waitForFunction(() => window.__calendarTest.state('existing-1').event?.summary === 'Updated event');
    assert.equal(await page.locator('#cal-f-sum').inputValue(), 'Another draft');
    assert.equal((await page.evaluate(() => window.__calendarTest.state('existing-1'))).selectedDay, '2027-03-12');
    assert.equal((await page.evaluate(() => window.__calendarTest.state('existing-1').event.dtstart)), '2027-06-20T07:00:00.000Z', 'summer event uses the selected date offset');

    // A normal save in the same form still selects its date and renders the calendar.
    await page.evaluate(() => window.__calendarTest.showNew('2027-03-28'));
    await page.locator('#cal-f-sum').fill('Normal save');
    await page.locator('#cal-f-start').fill('01:30');
    await page.locator('#cal-f-end').fill('03:30');
    await page.locator('#cal-f-save').click();
    await page.waitForFunction(() => !document.querySelector('.cal-form') && window.__calendarTest.state('created-2').event?.summary === 'Normal save');
    assert.equal((await page.evaluate(() => window.__calendarTest.state('created-2'))).selectedDay, '2027-03-28');
    state = await page.evaluate(async () => await (await fetch('/__state')).json());
    assert.equal(state.saveBodies.find(row => row.uid === 'created-2').dtstart, '2027-03-28T00:30:00.000Z');
    assert.equal(state.saveBodies.find(row => row.uid === 'created-2').dtend, '2027-03-28T01:30:00.000Z');
    await page.evaluate(() => window.__calendarTest.showNew('2027-03-28'));
    await page.locator('#cal-f-sum').fill('DST gap');
    await page.locator('#cal-f-start').fill('02:30');
    await page.locator('#cal-f-end').fill('04:00');
    await page.locator('#cal-f-save').click();
    await page.waitForFunction(() => !document.querySelector('.cal-form') && window.__calendarTest.state('created-3').event?.summary === 'DST gap');
    state = await page.evaluate(async () => await (await fetch('/__state')).json());
    assert.equal(state.saveBodies.find(row => row.uid === 'created-3').dtstart, '2027-03-28T01:30:00.000Z', 'native DST-gap normalization is preserved');
    await page.evaluate(() => window.__calendarTest.showNew('2027-04-02'));
    await page.locator('#cal-f-sum').fill('Retry save');
    await page.locator('#cal-f-date').fill('');
    await page.locator('#cal-f-save').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('valid date and time'));
    state = await page.evaluate(async () => await (await fetch('/__state')).json());
    assert.equal(state.saveBodies.some(row => row.summary === 'Retry save'), false, 'invalid dates send no save request');
    assert.equal(await page.locator('#cal-f-save').isDisabled(), false, 'invalid date leaves Save usable');
    await page.locator('#cal-f-date').fill('2027-04-02');
    await page.evaluate(() => fetch('/__fail-next-create'));
    await page.locator('#cal-f-save').click();
    await page.waitForFunction(async () => {
      const state = await (await fetch('/__state')).json();
      return !state.pending && state.saveBodies.filter(row => row.summary === 'Retry save').length === 1 && !document.querySelector('#cal-f-save')?.disabled;
    });
    await page.locator('#cal-f-save').click();
    await page.waitForFunction(() => window.__calendarTest.state('created-5').event?.summary === 'Retry save');
    assert.deepEqual(errors, []);
    console.log('PASS Calendar save ownership, retry, reminders and selected-date instants');
  } finally {
    await browser.close(); server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
