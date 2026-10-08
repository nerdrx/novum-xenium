// Reproduce a failed note reorder being accepted as locally persisted.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let reorderAttempts = 0;
const reorderBodies = [];
let releaseFirst = null;
const plans = [
  { hold: true, status: 503 },
  { status: 200 },
  { status: 503 },
  { status: 200 },
  { status: 503 },
  { status: 200 },
];
const html = `<!doctype html><meta charset="utf-8"><body>
<div id="notes-pane"><div class="notes-pane-body">
  <div class="note-card" data-note-id="a"></div><div class="note-card" data-note-id="b"></div>
</div></div><div id="toast"></div>
<script type="module">
  import '/static/js/notes.js';
  window.fixtureReady = true;
</script></body>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/notes/reorder') {
    reorderAttempts++;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      reorderBodies.push(JSON.parse(body));
      const plan = plans.shift() || { status: 200 };
      const respond = () => {
        res.writeHead(plan.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(plan.status === 503 ? { detail: 'temporary reorder outage' } : { ok: true, count: 2 }));
      };
      if (plan.hold) releaseFirst = respond;
      else respond();
    });
    return;
  }
  if (url.pathname === '/__release-first') {
    releaseFirst?.(); res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__state') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ reorderAttempts, reorderBodies }));
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (url.pathname === '/static/js/notes.js') {
    const source = fs.readFileSync(file, 'utf8').replace('const notesModule = {', 'window.__testSetNotes = value => { _notes = value; };\nwindow.__testGetNotes = () => _notes;\nwindow.__testCommitNoteReorder = _commitNoteReorder;\nconst notesModule = {');
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
    await page.waitForFunction(() => window.fixtureReady && window.__testCommitNoteReorder);
    await page.evaluate(() => {
      window.__testSetNotes([{ id: 'a', sort_order: 10 }, { id: 'b', sort_order: 20 }]);
      const body = document.querySelector('.notes-pane-body');
      body.insertBefore(body.lastElementChild, body.firstElementChild); // user has dragged B above A
    });
    await page.evaluate(() => { window.firstCommit = window.__testCommitNoteReorder(); });
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).reorderAttempts === 1);

    // A second drop while the first request is pending must be queued after it.
    await page.evaluate(() => {
      const body = document.querySelector('.notes-pane-body');
      body.insertBefore(body.lastElementChild, body.firstElementChild); // newest order becomes A, B
      window.secondCommit = window.__testCommitNoteReorder();
    });
    let state = await page.evaluate(async () => await (await fetch('/__state')).json());
    assert.equal(state.reorderAttempts, 1, 'second save waits for the first request to settle');
    await page.evaluate(() => fetch('/__release-first'));
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).reorderAttempts === 2);
    await page.evaluate(() => Promise.all([window.firstCommit, window.secondCommit]));
    state = await page.evaluate(async () => await (await fetch('/__state')).json());
    assert.deepEqual(state.reorderBodies.map(body => body.ids), [['b', 'a'], ['a', 'b']], 'saves reach the server in interaction order');
    assert.equal(await page.locator('#toast button').filter({ hasText: 'Retry' }).count(), 0, 'obsolete failures do not create stale retry actions');
    assert.deepEqual(await page.evaluate(() => window.__testGetNotes().map(note => ({ id: note.id, sort_order: note.sort_order }))), [{ id: 'a', sort_order: 0 }, { id: 'b', sort_order: 1 }]);

    // A newer drop supersedes an already-visible failed-order Retry control.
    await page.evaluate(() => {
      const body = document.querySelector('.notes-pane-body');
      body.insertBefore(body.lastElementChild, body.firstElementChild); // order B, A
    });
    await page.evaluate(() => window.__testCommitNoteReorder());
    assert.match(await page.locator('#toast').textContent(), /Could not save note order/);
    await page.evaluate(() => {
      const body = document.querySelector('.notes-pane-body');
      body.insertBefore(body.lastElementChild, body.firstElementChild); // newer order A, B
      window.latestCommit = window.__testCommitNoteReorder();
    });
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).reorderAttempts === 4);
    await page.evaluate(() => window.latestCommit);
    assert.equal(await page.locator('#toast button').filter({ hasText: 'Retry' }).count(), 0, 'newer order replaces the obsolete retry action');

    // A current failure keeps order B/A visible and its own retry preserves that snapshot.
    await page.evaluate(() => {
      const body = document.querySelector('.notes-pane-body');
      body.insertBefore(body.lastElementChild, body.firstElementChild); // order B, A
    });
    await page.evaluate(() => window.__testCommitNoteReorder());
    assert.match(await page.locator('#toast').textContent(), /Could not save note order/);
    await page.locator('#toast button').filter({ hasText: 'Retry' }).click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).reorderAttempts === 6);
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Note order saved'));
    state = await page.evaluate(async () => await (await fetch('/__state')).json());
    assert.deepEqual(state.reorderBodies.map(body => body.ids), [['b', 'a'], ['a', 'b'], ['b', 'a'], ['a', 'b'], ['b', 'a'], ['b', 'a']], 'retry sends the latest failed order');
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log('PASS: note reorder saves serialize; obsolete failures/retries stay suppressed');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
