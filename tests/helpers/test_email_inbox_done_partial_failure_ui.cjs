// A partially successful done-state update must serialize clicks and reload authoritative state.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let answered = false;
let listLoads = 0;
let answeredWrites = 0;
let readWrites = 0;
let releaseRead;
const email = { uid: '9', from_name: 'Alice', from_address: 'alice@example.com', subject: 'Needs reply', tags: ['urgent'], date: '2026-10-01T12:00:00Z', is_read: false, is_answered: false };
const html = `<!doctype html><meta charset="utf-8"><body><div id="email-list"></div><div id="email-load-more"></div><div id="toast"></div>
<script type="module">
  import * as inbox from '/static/js/emailInbox.js';
  window.startLoad = () => inbox.loadEmails(false);
  window.fixtureReady = true;
</script></body>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/email/list') {
    if (url.searchParams.get('cached_only') !== '1') listLoads++;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ emails: [{ ...email, is_answered: answered }], total: 1 }));
  }
  if (url.pathname === '/api/email/mark-answered/9') {
    answeredWrites++;
    answered = true;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: true }));
  }
  if (url.pathname === '/api/email/mark-read/9') {
    readWrites++;
    await new Promise(resolve => { releaseRead = resolve; });
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, error: 'Mail operation failed' }));
  }
  if (url.pathname === '/__release-read') {
    releaseRead?.(); res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__state') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ answeredWrites, readWrites, listLoads }));
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (url.pathname === '/static/js/emailInbox.js') {
    const source = fs.readFileSync(file, 'utf8').replace('export function init(documentModule)', 'window.__testToggleDone = _toggleDone;\nexport function init(documentModule)');
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
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => window.startLoad());
    await page.locator('.email-item[data-uid="9"]').waitFor();
    await page.evaluate(() => {
      const model = { uid: '9', tags: ['urgent'], is_read: false, is_answered: false };
      const row = document.querySelector('.email-item[data-uid="9"]');
      window.doneFirst = window.__testToggleDone(model, row);
      window.doneSecond = window.__testToggleDone(model, row);
    });
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).readWrites === 1);
    assert.equal(readWrites, 1, 'a repeated click cannot start a second out-of-order mutation');
    await page.evaluate(() => fetch('/__release-read'));
    await page.evaluate(() => Promise.all([window.doneFirst, window.doneSecond]));
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).listLoads >= 2);
    await page.waitForFunction(() => !document.querySelector('.email-tag-urgent'));
    assert.equal(answeredWrites, 1);
    assert.equal(readWrites, 1);
    assert.match(await page.locator('#toast').textContent(), /checking the server state/i);
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log('PASS: done-state partial failure serializes writes and refreshes server state');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
