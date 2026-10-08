// Sender-filter changes during a cached inbox refresh must supersede stale rows and remain retryable.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const alice = { uid: '1', from_name: 'Alice', from_address: 'alice@example.com', subject: 'Alice mail', date: '2026-10-01T12:00:00Z', is_read: true, is_answered: false };
const bob = { uid: '2', from_name: 'Bob', from_address: 'bob@example.com', subject: 'Bob mail', date: '2026-10-01T12:00:00Z', is_read: true, is_answered: false };
const html = `<!doctype html><meta charset="utf-8"><body><div id="email-list"></div><div id="email-load-more"></div>
<script type="module">
  import * as inbox from '/static/js/emailInbox.js';
  window.inbox = inbox;
  window.startLoad = () => { window.currentLoad = inbox.loadEmails(false); return true; };
  window.fixtureReady = true;
</script></body>`;
let regularRequests = [];
let releaseInitial = null;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/email/list') {
    const cached = url.searchParams.get('cached_only') === '1';
    if (cached) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ emails: [alice, bob], total: 2 }));
    }
    const index = regularRequests.length;
    regularRequests.push(url.toString());
    if (index === 0) await new Promise(resolve => { releaseInitial = resolve; });
    if (index === 2) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'temporary inbox outage' }));
    }
    const isFiltered = url.searchParams.get('from') === 'alice@example.com';
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ emails: isFiltered ? [alice] : [alice, bob], total: isFiltered ? 1 : 2 }));
  }
  if (url.pathname === '/__state') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(regularRequests));
  }
  if (url.pathname === '/__release') {
    releaseInitial?.(); res.writeHead(204); return res.end();
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
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
    await page.waitForFunction(() => document.querySelector('.email-item[data-uid="2"]'));
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).length === 1);
    await page.locator('.email-sender-clickable[data-from-addr="alice@example.com"]').click();
    await page.evaluate(() => fetch('/__release'));

    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).length === 2);
    await page.waitForFunction(() => document.querySelector('.email-filter-chip')?.textContent.includes('Alice')
      && document.querySelectorAll('.email-sender-clickable').length === 1);
    let urls = await page.evaluate(async () => (await (await fetch('/__state')).json()));
    assert.match(urls[1], /from=alice%40example\.com/);
    assert.deepEqual(await page.locator('.email-sender-clickable').allTextContents(), ['Alice'],
      'the older unfiltered response must not repaint rows under the active sender filter');

    // Current request failures stay actionable and a retry uses the same filter.
    await page.evaluate(() => window.startLoad());
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).length === 3);
    await page.waitForFunction(() => document.querySelector('.email-load-retry'));
    assert.match(await page.locator('#email-list').textContent(), /Failed to load: temporary inbox outage/);
    assert.deepEqual(await page.locator('.email-sender-clickable').allTextContents(), ['Alice'],
      'a failed refresh keeps the last rows when they belong to the same active filter');
    await page.locator('.email-load-retry').click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).length === 4);
    await page.waitForFunction(() => document.querySelectorAll('.email-sender-clickable').length === 1);
    urls = await page.evaluate(async () => (await (await fetch('/__state')).json()));
    assert.match(urls[3], /from=alice%40example\.com/);
    assert.deepEqual(await page.locator('.email-sender-clickable').allTextContents(), ['Alice']);
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log('PASS: inbox filter response ownership, HTTP error recovery, and filtered retry');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
