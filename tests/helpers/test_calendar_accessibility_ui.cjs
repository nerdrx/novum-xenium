// Synthetic keyboard, focus-return, and narrow-layout checks for Calendar.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const { withAppStyles } = require('./app_styles.cjs');

const repo = path.resolve(__dirname, '../..');
const evidenceDir = process.env.EVIDENCE_DIR || os.tmpdir();
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><!-- APP_STYLESHEET_LINKS --><body class="theme-novum-xenium"><aside id="sidebar"></aside><button id="tool-calendar-btn">Calendar</button><div id="chat-container"></div><div id="toast"></div><script type="module">import * as calendar from '/static/js/calendar.js'; window.calendar=calendar; calendar.openCalendar(); window.fixtureReady=true;</script></body>`;
const event = { uid: 'fixture-event', summary: 'Synthetic event', dtstart: '2026-10-20T14:00:00Z', dtend: '2026-10-20T15:00:00Z', all_day: false, calendar_href: 'fixture-calendar', description: 'Synthetic fixture only', location: 'Local fixture', rrule: '', event_type: 'personal', color: '', has_reminder: false, reminder_minutes: null };
const writes = [];
let showFixtureEvent = true;
let holdEventReads = false;
const heldEventReads = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/') return res.end(await withAppStyles(html));
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/fixture/prepare-missing-event') { showFixtureEvent = false; holdEventReads = true; return json(200, {}); }
  if (url.pathname === '/fixture/restore-event') { showFixtureEvent = true; holdEventReads = false; return json(200, {}); }
  if (url.pathname === '/fixture/event-read-state') return json(200, { pending: heldEventReads.length });
  if (url.pathname === '/fixture/release-event-reads') {
    holdEventReads = false;
    while (heldEventReads.length) heldEventReads.shift()();
    return json(200, {});
  }
  if (url.pathname === '/api/calendar/calendars') return json(200, { calendars: [{ id: 'fixture-calendar', href: 'fixture-calendar', name: 'Synthetic calendar', color: '#5577dd' }] });
  if (url.pathname === '/api/calendar/events' && req.method === 'GET') {
    if (holdEventReads) await new Promise(resolve => heldEventReads.push(resolve));
    return json(200, { events: showFixtureEvent ? [event] : [] });
  }
  if (url.pathname === '/api/calendar/events/fixture-event' && req.method === 'GET') return json(200, event);
  if (url.pathname === '/api/calendar/sync') return json(200, { ok: true, events: 0 });
  if (url.pathname.startsWith('/api/calendar/') && req.method !== 'GET') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { writes.push({ method: req.method, path: url.pathname, body }); json(200, { ...event }); });
    return;
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(path.join(repo, 'static') + path.sep) || !fs.existsSync(file)) return json(404, {});
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  const results = {};
  try {
    for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 600, height: 320 }]) {
      writes.length = 0;
      showFixtureEvent = true;
      holdEventReads = false;
      while (heldEventReads.length) heldEventReads.shift()();
      const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      // Keep the fixed fixture event upcoming regardless of the host date.
      await page.clock.setFixedTime(new Date('2026-10-20T07:00:00Z'));
      page.setDefaultTimeout(7000);
      const errors = [], externalRequests = [];
      page.on('pageerror', error => errors.push(error.stack || error.message));
      page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => window.fixtureReady && document.querySelector('#cal-add'));
      await page.waitForTimeout(250);
      const styles = await page.locator('link[rel="stylesheet"]').evaluateAll(links => ({ total: links.length, loaded: links.filter(link => !!link.sheet).length }));
      assert.ok(styles.total > 0 && styles.total === styles.loaded, 'full app stylesheet order loads');

      await page.locator('#cal-add').click();
      await page.waitForSelector('.cal-form-bespoke');
      await page.waitForFunction(() => document.activeElement?.id === 'cal-f-sum');
      const fieldNames = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('.cal-form-bespoke input, .cal-form-bespoke select, .cal-form-bespoke textarea')];
        return controls.map(el => ({ id: el.id, name: el.getAttribute('aria-label') || [...(el.labels || [])].map(label => label.innerText.trim()).filter(Boolean).join(' '), labels: [...(el.labels || [])].map(label => label.innerText.trim()), labelVisible: [...(el.labels || [])].some(label => !label.classList.contains('cal-visually-hidden') && !!label.getClientRects().length && getComputedStyle(label).visibility !== 'hidden'), type: el.type || el.tagName }));
      });
      for (const field of fieldNames) {
        assert.ok(field.name, `${field.id || field.type} has an accessible name`);
        assert.ok(field.labels.length > 0, `${field.id || field.type} is associated with a form label`);
      }
      assert.ok(fieldNames.some(field => /start date/i.test(field.name) && field.labelVisible), 'start date has a visible label');
      assert.ok(fieldNames.some(field => /end date/i.test(field.name) && field.labelVisible), 'end date has a visible label');
      assert.ok(fieldNames.some(field => /start time/i.test(field.name) && field.labelVisible), 'start time has a visible label');
      assert.ok(fieldNames.some(field => /end time/i.test(field.name) && field.labelVisible), 'end time has a visible label');
      const overflow = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }));
      assert.ok(overflow.documentWidth <= overflow.viewportWidth, `no horizontal overflow at ${viewport.width}px`);

      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.cal-form-bespoke'));
      await page.waitForFunction(() => document.activeElement?.id === 'cal-add');
      const createEscapeFocus = await page.evaluate(() => document.activeElement?.id);
      assert.equal(writes.length, 0, 'Escape closes without writing');
      await page.locator('#cal-add').click();
      await page.waitForSelector('.cal-form-bespoke');
      await page.locator('#cal-f-cancel').click();
      await page.waitForFunction(() => !document.querySelector('.cal-form-bespoke'));
      await page.waitForFunction(() => document.activeElement?.id === 'cal-add');
      const createCancelFocus = await page.evaluate(() => document.activeElement?.id);
      assert.equal(writes.length, 0, 'Cancel closes without writing');
      let otherPaneFocusPreserved = null;
      if (viewport.width === 390) {
        await page.locator('#cal-add').click();
        await page.waitForSelector('.cal-form-bespoke');
        await page.locator('#tool-calendar-btn').focus();
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.cal-form-bespoke'));
        otherPaneFocusPreserved = await page.evaluate(() => document.activeElement?.id);
        assert.equal(otherPaneFocusPreserved, 'tool-calendar-btn', 'closing does not steal focus from another pane');
      }

      await page.evaluate(() => window.calendar.openCalendarView('agenda'));
      const opener = page.locator('.cal-agenda-open[data-uid="fixture-event"]');
      await opener.waitFor();
      const openerSemantics = await opener.evaluate(el => ({ tag: el.tagName, name: el.getAttribute('aria-label') || el.innerText.trim(), nestedButton: !!el.closest('.cal-agenda-event button:not(.cal-agenda-open)') }));
      assert.equal(openerSemantics.tag, 'BUTTON', 'agenda open action is a native button');
      assert.match(openerSemantics.name, /Synthetic event/i, 'agenda action name identifies the event');
      await page.locator('#cal-close').focus();
      let tabReachedOpener = false;
      for (let i = 0; i < 80; i++) {
        await page.keyboard.press('Tab');
        if (await page.evaluate(() => document.activeElement?.matches('.cal-agenda-open[data-uid="fixture-event"]'))) { tabReachedOpener = true; break; }
      }
      assert.equal(tabReachedOpener, true, 'Tab can reach the agenda open action');
      await opener.focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.cal-form-bespoke');
      await page.waitForFunction(() => document.activeElement?.id === 'cal-f-sum');
      const enterOpenedForm = true;
      assert.equal(writes.length, 0, 'keyboard open does not write');
      await page.locator('#cal-f-cancel').click();
      await page.waitForFunction(() => !document.querySelector('.cal-form-bespoke'));
      await page.waitForFunction(() => document.activeElement?.matches('.cal-agenda-open[data-uid="fixture-event"]'));
      const editCancelReturnedFocus = await page.evaluate(() => document.activeElement?.matches('.cal-agenda-open[data-uid="fixture-event"]'));
      assert.equal(writes.length, 0, 'edit Cancel does not write');

      await opener.focus();
      await page.keyboard.press('Space');
      await page.waitForSelector('.cal-form-bespoke');
      await page.waitForFunction(() => document.activeElement?.id === 'cal-f-sum');
      const spaceOpenedForm = true;
      await page.evaluate(() => document.querySelector('.cal-agenda-open[data-uid="fixture-event"]')?.remove());
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.cal-form-bespoke'));
      await page.waitForFunction(() => document.activeElement?.matches('.cal-agenda-open[data-uid="fixture-event"]') || ['cal-add', 'tool-calendar-btn', 'cal-close'].includes(document.activeElement?.id));
      const recreatedOpenerFocus = await page.evaluate(() => document.activeElement?.matches('.cal-agenda-open[data-uid="fixture-event"]') ? 'current event opener' : document.activeElement?.id);
      assert.equal(writes.length, 0, 'Escape with a removed opener falls back without writing');
      let missingEventFocus = null;
      let calendarCloseCancellation = null;
      let refreshFormPreserved = null;
      if (viewport.width === 390) {
        await page.locator('.cal-agenda-open[data-uid="fixture-event"]').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.cal-form-bespoke');
        await page.request.get(`http://127.0.0.1:${server.address().port}/fixture/prepare-missing-event`);
        await page.evaluate(() => window.dispatchEvent(new Event('calendar-refresh')));
        await page.waitForFunction(async () => (await (await fetch('/fixture/event-read-state')).json()).pending >= 1);
        await page.keyboard.press('Escape');
        await page.waitForFunction(async () => (await (await fetch('/fixture/event-read-state')).json()).pending >= 2);
        await page.request.get(`http://127.0.0.1:${server.address().port}/fixture/release-event-reads`);
        await page.waitForFunction(() => !document.querySelector('.cal-form-bespoke') && !document.querySelector('.cal-agenda-open[data-uid="fixture-event"]'));
        missingEventFocus = await page.evaluate(() => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim() }));
        assert.ok(['cal-add', 'tool-calendar-btn', 'cal-close'].includes(missingEventFocus.id), `missing-event fallback focus: ${JSON.stringify(missingEventFocus)}`);

        await page.request.get(`http://127.0.0.1:${server.address().port}/fixture/restore-event`);
        await page.evaluate(() => window.calendar.openCalendarView('agenda'));
        await page.locator('.cal-agenda-open[data-uid="fixture-event"]').waitFor();
        await page.locator('.cal-agenda-open[data-uid="fixture-event"]').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.cal-form-bespoke');
        await page.request.get(`http://127.0.0.1:${server.address().port}/fixture/prepare-missing-event`);
        await page.keyboard.press('Escape');
        await page.waitForFunction(async () => (await (await fetch('/fixture/event-read-state')).json()).pending >= 1);
        await page.evaluate(() => window.calendar.closeCalendar());
        await page.request.get(`http://127.0.0.1:${server.address().port}/fixture/release-event-reads`);
        await page.waitForTimeout(100);
        calendarCloseCancellation = await page.evaluate(() => ({ open: !!document.querySelector('#calendar-modal:not(.hidden)'), focus: document.activeElement?.id }));
        assert.equal(calendarCloseCancellation.open, false, 'Calendar close cancels pending focus return');
        await page.evaluate(() => window.calendar.openCalendar());
        await page.locator('#cal-add').waitFor({ state: 'visible' });
        await page.locator('#cal-add').click();
        await page.waitForSelector('.cal-form-bespoke');
        await page.locator('#cal-f-sum').fill('Synthetic draft survives refresh');
        await page.locator('#cal-f-sum').focus();
        await page.evaluate(() => { window.fixtureFormNode = document.querySelector('.cal-form-bespoke'); });
        await page.request.get(`http://127.0.0.1:${server.address().port}/fixture/prepare-missing-event`);
        await page.evaluate(() => window.dispatchEvent(new Event('calendar-refresh')));
        await page.waitForFunction(async () => (await (await fetch('/fixture/event-read-state')).json()).pending >= 1);
        await page.request.get(`http://127.0.0.1:${server.address().port}/fixture/release-event-reads`);
        await page.waitForFunction(async () => (await (await fetch('/fixture/event-read-state')).json()).pending === 0);
        refreshFormPreserved = await page.evaluate(() => ({ sameNode: window.fixtureFormNode === document.querySelector('.cal-form-bespoke'), value: document.querySelector('#cal-f-sum')?.value, focus: document.activeElement?.id }));
        assert.deepEqual(refreshFormPreserved, { sameNode: true, value: 'Synthetic draft survives refresh', focus: 'cal-f-sum' }, 'delayed refresh preserves the connected form, draft, and focus');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.cal-form-bespoke'));
        await page.evaluate(() => window.calendar.openCalendar());
        await page.locator('#cal-add').waitFor({ state: 'visible' });
      }

      // Reopen create form for footer reachability. Explicitly scroll the modal,
      // matching the existing scrollable-form behavior on short landscape.
      await page.locator('#cal-add').click();
      await page.waitForSelector('.cal-form-bespoke');
      const actionReachability = await page.evaluate(async () => {
        const save = document.querySelector('#cal-f-save');
        const cancel = document.querySelector('#cal-f-cancel');
        save.scrollIntoView({ block: 'end' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const box = el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, visible: r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1 }; };
        const saveBox = save.getBoundingClientRect(), cancelBox = cancel.getBoundingClientRect();
        return { save: box(save), cancel: box(cancel), overlap: saveBox.left < cancelBox.right && saveBox.right > cancelBox.left && saveBox.top < cancelBox.bottom && saveBox.bottom > cancelBox.top, scrollTop: document.querySelector('#cal-body')?.scrollTop };
      });
      for (const [name, action] of Object.entries({ save: actionReachability.save, cancel: actionReachability.cancel })) {
        assert.ok(action.width >= 44 && action.height >= 44, `${name} target is at least 44x44`);
        assert.equal(action.visible, true, `${name} can be brought into the viewport by scrolling`);
      }
      assert.equal(actionReachability.overlap, false, 'Save and Cancel do not overlap');
      if (viewport.width === 390 || viewport.width === 600) await page.screenshot({ path: path.join(evidenceDir, `calendar-${viewport.width}x${viewport.height}-form.png`), fullPage: false, animations: 'disabled' });
      assert.deepEqual(errors, []);
      assert.deepEqual(externalRequests, []);
      results[`${viewport.width}x${viewport.height}`] = { styles, fieldNames, overflow, openerSemantics, keyboard: { tabReachedOpener, enterOpenedForm, spaceOpenedForm }, focus: { createEscapeFocus, createCancelFocus, editCancelReturnedFocus, recreatedOpenerFocus, missingEventFocus, calendarCloseCancellation, otherPaneFocusPreserved }, refreshFormPreserved, actionReachability, writes: writes.length, errors, externalRequests };
      await context.close();
    }
    fs.writeFileSync(path.join(evidenceDir, 'calendar-accessibility-results.json'), JSON.stringify(results, null, 2));
    console.log('PASS synthetic Calendar accessible controls, keyboard focus, and mobile reachability');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
