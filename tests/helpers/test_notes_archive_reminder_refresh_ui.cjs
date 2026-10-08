// Active reminder refreshes must not replace or flip an open archive view.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css">
<body><aside id="sidebar"></aside><button id="tool-notes-btn"></button><button id="rail-notes"></button><div id="chat-container"></div><div id="toast"></div>
<script>
  let fixtureNow = Date.now(); Date.now = () => fixtureNow;
  window.advanceFixtureClock = ms => { fixtureNow += ms; };
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  window.reminderTick = null;
  let reminderIntervalId = null;
  let reminderIntervalCleared = false;
  window.setInterval = (callback, delay, ...args) => {
    if (delay === 30000) window.reminderTick = callback;
    const id = nativeSetInterval(callback, delay, ...args);
    if (delay === 30000) reminderIntervalId = id;
    return id;
  };
  window.clearInterval = id => {
    if (id === reminderIntervalId) reminderIntervalCleared = true;
    return nativeClearInterval(id);
  };
  window.runReminderTick = () => window.reminderTick?.();
  window.reminderIntervalActive = () => reminderIntervalId !== null && !reminderIntervalCleared;
</script>
<script type="module">import notes from '/static/js/notes.js'; window.notesModule = notes; notes.openPanel(); window.fixtureReady = true;</script></body>`;
const dueDate = new Date(Date.now() + 60_000).toISOString();
const activeNotes = [{ id: 'active-note', title: 'Active reminder', content: 'reminder', note_type: 'todo', archived: false, due_date: dueDate, items: [], sort_order: 0 }];
const archivedNotes = [{ id: 'archived-note', title: 'Archived note', content: 'history', note_type: 'note', archived: true, items: [], sort_order: 0 }];
let holdNextActive = false;
let failNextActive = false;
let heldResponse = null;
const firedNoteIds = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') { res.end(html); return; }
  if (url.pathname === '/__hold-active' && req.method === 'POST') { holdNextActive = true; res.end('ok'); return; }
  if (url.pathname === '/__fail-active' && req.method === 'POST') { failNextActive = true; res.end('ok'); return; }
  if (url.pathname === '/__fired') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(firedNoteIds)); return; }
  if (url.pathname === '/__release-active') {
    if (!heldResponse) { res.writeHead(409); res.end('No held refresh'); return; }
    heldResponse.setHeader('Content-Type', 'application/json');
    heldResponse.end(JSON.stringify({ notes: activeNotes }));
    heldResponse = null;
    res.end('released');
    return;
  }
  if (url.pathname === '/api/notes' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    if (url.searchParams.get('archived') === 'true') {
      res.end(JSON.stringify({ notes: archivedNotes }));
      return;
    }
    if (failNextActive) {
      failNextActive = false;
      res.writeHead(503);
      res.end('fixture unavailable');
      return;
    }
    if (holdNextActive) {
      holdNextActive = false;
      heldResponse = res;
      return;
    }
    res.end(JSON.stringify({ notes: activeNotes }));
    return;
  }
  if (url.pathname === '/api/notes/fire-reminder' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      firedNoteIds.push(JSON.parse(body).note_id);
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
    return;
  }
  const file = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('.note-card[data-note-id="active-note"]'));
    await page.evaluate(() => window.advanceFixtureClock(90_000));

    // A reminder refresh started in active view must not flip a later switch
    // into the archive back to active when its response arrives.
    await page.evaluate(() => fetch('/__hold-active', { method: 'POST' }));
    await page.evaluate(() => { window.activeRefresh = window.notesModule.refreshDueBadge({ force: true }); });
    let holdDeadline = Date.now() + 3000;
    while (!heldResponse && Date.now() < holdDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(heldResponse, 'active-view reminder refresh reached the held response');
    await page.locator('#notes-archive-toggle').click();
    await page.waitForSelector('.note-card[data-note-id="archived-note"]');
    await page.request.get(`http://127.0.0.1:${server.address().port}/__release-active`);
    await page.evaluate(() => window.activeRefresh);
    await page.locator('#notes-search').fill('missing');
    await page.locator('#notes-search').fill('');
    assert.equal(await page.locator('#notes-archive-toggle').getAttribute('title'), 'Exit archive',
      'late active refresh does not revert a switch into the archive');
    assert.equal(await page.locator('.note-card[data-note-id="archived-note"]').count(), 1,
      'late active refresh does not replace the archive list');
    await page.evaluate(() => window.runReminderTick());
    await page.waitForFunction(() => fetch('/__fired').then(res => res.json()).then(ids => ids.includes('active-note')));
    assert.equal(await page.locator('.note-card[data-note-id="archived-note"]').count(), 1,
      'active reminder fires while archive remains visible');

    await page.evaluate(() => window.notesModule.refreshDueBadge({ force: true }));
    assert.equal(await page.locator('.note-card[data-note-id="archived-note"]').count(), 1,
      'active reminder refresh keeps archive card visible');
    assert.equal(await page.locator('.rail-notes-badge').textContent(), '1',
      'active reminder refresh still updates the reminder badge');

    await page.evaluate(() => fetch('/__fail-active', { method: 'POST' }));
    await page.evaluate(() => window.notesModule.refreshDueBadge({ force: true }));
    assert.equal(await page.locator('.note-card[data-note-id="archived-note"]').count(), 1,
      'failed active refresh leaves archived card visible');
    assert.equal(await page.locator('.rail-notes-badge').textContent(), '1',
      'failed active refresh preserves the last successful badge');

    await page.evaluate(() => window.notesModule.closePanel());
    assert.equal(await page.evaluate(() => window.reminderIntervalActive()), true,
      'closing archive leaves the background reminder interval active');
    const clientNowAfterArchiveClose = await page.evaluate(() => Date.now());
    activeNotes.push({ id: 'created-after-close', title: 'New calendar reminder', content: 'created after close', note_type: 'todo', archived: false, due_date: new Date(clientNowAfterArchiveClose - 1000).toISOString(), items: [], sort_order: 1 });
    await page.evaluate(() => window.notesModule.refreshDueBadge({ force: true }));
    await page.evaluate(() => window.runReminderTick());
    await page.waitForFunction(() => fetch('/__fired').then(res => res.json()).then(ids => ids.includes('created-after-close')));
    assert.equal(await page.evaluate(() => window.notesModule.isPanelOpen()), false,
      'refresh after closing archive starts reminder handling without reopening panel');

    await page.waitForTimeout(250);
    await page.evaluate(() => window.notesModule.openPanel());
    await page.waitForSelector('.note-card[data-note-id="archived-note"]');
    await page.locator('#notes-archive-toggle').click();
    await page.waitForSelector('.note-card[data-note-id="active-note"]');
    await page.evaluate(() => window.notesModule.closePanel());
    assert.equal(await page.evaluate(() => window.reminderIntervalActive()), true,
      'closing active notes leaves the background reminder interval active');
    const clientNowAfterActiveClose = await page.evaluate(() => Date.now());
    activeNotes.push({ id: 'created-after-active-close', title: 'New active reminder', content: 'created after close', note_type: 'todo', archived: false, due_date: new Date(clientNowAfterActiveClose - 1000).toISOString(), items: [], sort_order: 2 });
    await page.evaluate(() => window.notesModule.refreshDueBadge({ force: true }));
    await page.evaluate(() => window.runReminderTick());
    await page.waitForFunction(() => fetch('/__fired').then(res => res.json()).then(ids => ids.includes('created-after-active-close')));

    console.log('PASS: forced refresh preserves archive data and starts reminders created after close');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
