// Failed Notes bootstrap remains an error with Retry; a valid empty response
// still renders the normal empty state.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css">
<body><aside id="sidebar"></aside><button id="tool-notes-btn"></button><div id="chat-container"></div><div id="toast"></div>
<script type="module">import notes from '/static/js/notes.js'; notes.openPanel(); window.fixtureReady = true;</script></body>`;
let noteLoads = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.end(html); return; }
  if (url.pathname === '/api/notes' && req.method === 'GET') {
    noteLoads++;
    if (noteLoads === 1) { res.writeHead(503); res.end('fixture unavailable'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ notes: [] }));
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
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('#notes-load-error'));
    assert.equal(await page.locator('#notes-load-error').getAttribute('role'), 'alert');
    assert.match(await page.locator('#notes-load-error').textContent(), /Could not load notes.*Retry/);
    assert.equal(await page.locator('.notes-empty-msg').count(), 0,
      'failed first load must not claim the account has no notes');
    await page.locator('#notes-load-error button').click();
    await page.waitForFunction(() => document.querySelector('.notes-empty-msg')?.textContent.includes('No notes yet'));
    assert.equal(await page.locator('#notes-load-error').count(), 0,
      'a valid empty response clears the error and shows the true empty state');
    assert.equal(noteLoads, 2);
    console.log('PASS: first-load failure has Retry and valid empty remains a distinct state');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
