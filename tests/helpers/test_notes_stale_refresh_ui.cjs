// A delayed refresh after one failed edit must not overwrite another edit
// that succeeded while that refresh was in flight.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css">
<body><aside id="sidebar"></aside><button id="tool-notes-btn"></button><div id="chat-container"></div><div id="toast"></div>
<script type="module">import notes from '/static/js/notes.js'; notes.openPanel(); window.fixtureReady = true;</script></body>`;
const serverNotes = [
  { id: 'note-a', title: 'Alpha original', content: 'A original body', note_type: 'note', label: null, color: '', items: [], sort_order: 0 },
  { id: 'note-b', title: 'Beta original', content: 'B original body', note_type: 'note', label: null, color: '', items: [], sort_order: 1 },
];
let getCount = 0;
let archiveGetCount = 0;
let refreshPending = false;
let releaseRefresh = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.end(html); return; }
  if (url.pathname === '/__state') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ getCount, archiveGetCount, refreshPending, serverNotes }));
    return;
  }
  if (url.pathname === '/__release-refresh') {
    if (!releaseRefresh) { res.writeHead(409); res.end('No held refresh'); return; }
    releaseRefresh();
    res.end('released');
    return;
  }
  if (url.pathname === '/api/notes' && req.method === 'GET') {
    if (url.searchParams.get('archived') === 'true') {
      archiveGetCount++;
      if (archiveGetCount === 1) { res.writeHead(503); res.end('fixture unavailable'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ notes: [{ id: 'archived-x', title: 'Archived fixture', content: '', note_type: 'note', archived: true, items: [] }] }));
      return;
    }
    getCount++;
    const snapshot = JSON.stringify(serverNotes);
    if (getCount === 2) {
      refreshPending = true;
      releaseRefresh = () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ notes: JSON.parse(snapshot) }));
      };
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ notes: JSON.parse(snapshot) }));
    return;
  }
  if (url.pathname.startsWith('/api/notes/') && req.method === 'PUT') {
    const id = url.pathname.split('/').pop();
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      if (id === 'note-a') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'fixture unavailable' }));
        return;
      }
      const index = serverNotes.findIndex(note => note.id === id);
      serverNotes[index] = { ...serverNotes[index], ...payload };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(serverNotes[index]));
    });
    return;
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('.note-card[data-note-id="note-a"]'));

    await page.locator('.note-card[data-note-id="note-a"] .note-card-title').click();
    await page.locator('.note-form-title').fill('Alpha failed edit');
    await page.locator('.note-form-content').fill('A edited body');
    await page.locator('.note-form-save').click();
    await page.waitForFunction(() => fetch('/__state').then(res => res.json()).then(state => state.refreshPending));
    assert.ok(await page.evaluate(() => localStorage.getItem('odysseus-note-draft-note-a')),
      'failed edit keeps its local recovery draft');

    const staleRefresh = page.waitForResponse(response => response.url().endsWith('/api/notes') && response.request().method() === 'GET');
    await page.locator('.note-card[data-note-id="note-b"] .note-card-title').click();
    await page.locator('.note-form-title').fill('Beta newer saved');
    await page.locator('.note-form-content').fill('B newer body');
    await page.locator('.note-form-save').click();
    await page.waitForFunction(() => fetch('/__state').then(res => res.json()).then(state => state.serverNotes.find(note => note.id === 'note-b')?.title === 'Beta newer saved'));
    await page.request.get(`http://127.0.0.1:${server.address().port}/__release-refresh`);
    await (await staleRefresh).finished();
    await page.waitForFunction(() => document.querySelector('.note-card[data-note-id="note-b"] .note-card-title')?.textContent === 'Beta newer saved');

    const visible = await page.locator('.note-card[data-note-id="note-b"] .note-card-title').textContent();
    const state = await page.evaluate(() => ({
      draftA: localStorage.getItem('odysseus-note-draft-note-a'),
      draftB: localStorage.getItem('odysseus-note-draft-note-b'),
    }));
    assert.equal(visible, 'Beta newer saved', 'stale GET from A failure must not overwrite B’s confirmed save');
    assert.equal(serverNotes.find(note => note.id === 'note-b').content, 'B newer body');
    assert.equal(state.draftB, null, 'confirmed B save clears its draft');
    assert.ok(state.draftA, 'A’s failed-edit draft remains recoverable');

    await page.locator('#notes-archive-toggle').click();
    await page.waitForFunction(() => document.querySelector('#notes-load-error'));
    assert.equal(await page.locator('.note-card[data-note-id="note-b"]').count(), 0,
      'active cached notes are not presented as archive entries after archive loading fails');
    assert.match(await page.locator('#notes-load-error').textContent(), /Could not load archived notes/);
    await page.locator('#notes-load-error button').click();
    await page.waitForFunction(() => document.querySelector('.note-card[data-note-id="archived-x"]'));
    assert.equal(await page.locator('#notes-load-error').count(), 0, 'successful retry clears the error');

    // The startup reminder refresh runs after three seconds. It must not
    // replace the open archive view with an unfiltered active-notes response.
    await page.waitForTimeout(3200);
    assert.equal(await page.locator('.note-card[data-note-id="archived-x"]').count(), 1,
      'archive view remains intact after the background reminder startup time');
    await page.locator('#notes-archive-toggle').click();
    await page.waitForFunction(() => document.querySelector('.note-card[data-note-id="note-b"] .note-card-title')?.textContent === 'Beta newer saved');
    assert.equal(await page.locator('.note-card[data-note-id="archived-x"]').count(), 0,
      'toggling back loads active notes without mixing in the archive');
    const loadState = await page.evaluate(async () => fetch('/__state').then(res => res.json()));
    assert.equal(loadState.getCount, 3, 'background reminder startup performs no competing list fetch while the panel is open');
    assert.equal(loadState.archiveGetCount, 2);
    assert.deepEqual(errors, []);
    console.log('PASS: stale refresh is ignored, failed archive reload keeps last-good notes with Retry, and background refresh leaves archive view intact');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
