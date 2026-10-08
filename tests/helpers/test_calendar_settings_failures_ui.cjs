// Reproduce Calendar Settings showing success and mutating local state after a 503.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let saveAttempts = 0;
let deleteAttempts = 0;
const saveBodies = [];
const plans = [{ hold: true, status: 503 }, { status: 200 }, { status: 503 }, { status: 200 }];
let releaseFirstSave = null;
let holdNextDelete = false;
let releaseDelete = null;
const html = `<!doctype html><meta charset="utf-8"><body><div id="toast"></div>
<script type="module">import '/static/js/calendar.js'; window.fixtureReady = true;</script></body>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/calendar/calendars/test-calendar' && req.method === 'PUT') {
    saveAttempts++;
    const plan = plans.shift() || { status: 200 };
    const respond = () => {
      res.writeHead(plan.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(plan.status === 503 ? { detail: 'temporary calendar service outage' } : { ok: true }));
    };
    const urlParams = url.searchParams;
    saveBodies.push({ name: urlParams.get('name'), color: urlParams.get('color') });
    if (plan.hold) releaseFirstSave = respond;
    else respond();
    return;
  }
  if (url.pathname === '/api/calendar/calendars/test-calendar' && req.method === 'DELETE') {
    deleteAttempts++;
    const respond = () => {
      res.writeHead(deleteAttempts === 1 ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(deleteAttempts === 1 ? { detail: 'temporary delete outage' } : { ok: true }));
    };
    if (holdNextDelete) { holdNextDelete = false; releaseDelete = respond; }
    else respond();
    return;
  }
  if (url.pathname === '/__state') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ saveAttempts, deleteAttempts, saveBodies }));
  }
  if (url.pathname === '/__release-first-save') {
    const release = releaseFirstSave;
    releaseFirstSave = null;
    release?.(); res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__hold-next-save') {
    plans.push({ hold: true, status: 200 });
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__hold-next-delete') {
    holdNextDelete = true;
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__release-delete') {
    const release = releaseDelete;
    releaseDelete = null;
    release?.(); res.writeHead(204); return res.end();
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (url.pathname === '/static/js/calendar.js') {
    const source = fs.readFileSync(file, 'utf8').replace('const calendarModule = {', 'window.__testSetCalendars = value => { _calendars = value; };\nwindow.__testGetCalendars = () => _calendars;\nwindow.__testOpenCalendarSettings = _showCalSettings;\nconst calendarModule = {');
    return res.end(source);
  }
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && window.__testOpenCalendarSettings);
    await page.evaluate(async () => {
      window.__testSetCalendars([{ href: 'test-calendar', name: 'Original', color: '#5b8abf' }]);
      await window.__testOpenCalendarSettings();
    });
    const input = page.locator('.cal-s-name');
    await input.fill('First draft');
    await page.waitForTimeout(350);
    let state = await page.evaluate(async () => await (await fetch('/__state')).json());
    assert.equal(state.saveAttempts, 1, 'first draft starts one PUT');
    await input.fill('Newest draft');
    await page.waitForTimeout(350); // allow the debounced second edit to queue behind the held request
    state = await page.evaluate(async () => await (await fetch('/__state')).json());
    assert.equal(state.saveAttempts, 1, 'calendar setting saves serialize while the earlier write is pending');
    await page.evaluate(() => fetch('/__release-first-save'));
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).saveAttempts === 2);
    await page.waitForFunction(() => window.__testGetCalendars()[0]?.name === 'Newest draft');
    assert.match(await page.locator('#toast').textContent(), /Saved/);
    state = await page.evaluate(async () => await (await fetch('/__state')).json());
    assert.deepEqual(state.saveBodies.map(body => body.name), ['First draft', 'Newest draft'], 'each write preserves its interaction-time value');
    assert.equal(await page.evaluate(() => window.__testGetCalendars()[0].name), 'Newest draft', 'stale failed save cannot overwrite the newest settings');
    assert.doesNotMatch(await page.locator('#toast').textContent(), /Could not save calendar/, 'obsolete failure does not replace latest success');

    // A current failed save keeps both the input draft and previous local value, then retry succeeds.
    await input.fill('Unsaved draft');
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).saveAttempts === 3);
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Could not save calendar'));
    assert.equal(await input.inputValue(), 'Unsaved draft');
    assert.equal(await page.evaluate(() => window.__testGetCalendars()[0].name), 'Newest draft');
    await page.locator('#toast button').filter({ hasText: 'Retry' }).click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).saveAttempts === 4);
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Saved “Unsaved draft”'));
    assert.equal(await page.evaluate(() => window.__testGetCalendars()[0].name), 'Unsaved draft');

    // Deleting while a save is pending drains the write and invalidates its success UI.
    await page.evaluate(() => fetch('/__hold-next-save'));
    await page.evaluate(() => fetch('/__hold-next-delete'));
    await input.fill('Pending save');
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).saveAttempts === 5);
    await input.fill('Latest unsaved draft'); // This debounced edit must not slip past deletion.
    await page.locator('.cal-s-del').click();
    await page.locator('#styled-confirm-ok').click();
    await page.waitForFunction(() => document.querySelector('.cal-s-name')?.disabled);
    await page.evaluate(() => fetch('/__release-first-save'));
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).deleteAttempts === 1);
    await page.evaluate(() => window.__testOpenCalendarSettings());
    await page.evaluate(() => window.__testOpenCalendarSettings());
    assert.equal(await page.locator('.cal-s-name').isDisabled(), true,
      'reopened settings reflect a deletion already in flight');
    await page.evaluate(() => fetch('/__release-delete'));
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Could not delete calendar'));
    assert.equal(await page.locator('.cal-settings-row').count(), 1);
    assert.equal(await page.evaluate(() => window.__testGetCalendars().length), 1);
    assert.doesNotMatch(await page.locator('#toast').textContent(), /Saved/,
      'the in-flight pre-delete save must not announce a completed save after deletion starts');

    // The retryable draft survives modal closure; controls recover after failure.
    assert.equal(await page.locator('.cal-s-name').inputValue(), 'Latest unsaved draft');
    assert.equal(await page.locator('.cal-s-name').isDisabled(), false,
      'delete failure reenables the currently open row');
    assert.match(await page.locator('#toast').textContent(), /remains listed/);
    await page.locator('#toast button').filter({ hasText: 'Retry' }).click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).deleteAttempts === 2);
    await page.waitForFunction(() => document.querySelectorAll('.cal-settings-row').length === 0);
    assert.equal(await page.evaluate(() => window.__testGetCalendars().length), 0);
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log('PASS: Calendar Settings serializes snapshot saves and preserves/retries failures');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
