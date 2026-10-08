// A failed mobile archive must leave the email visible and explain the failure.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const email = { uid: '7', from_name: 'Alice', from_address: 'alice@example.com', subject: 'Keep me', date: '2026-10-01T12:00:00Z', is_read: true, is_answered: false };
let archiveAttempts = 0;
let deleteAttempts = 0;
const html = `<!doctype html><meta charset="utf-8"><body><div id="email-list"></div><div id="email-load-more"></div><div id="toast"></div>
<script>window.ontouchstart = null;</script>
<script type="module">
  import * as inbox from '/static/js/emailInbox.js';
  window.startLoad = () => inbox.loadEmails(false);
  window.fixtureReady = true;
</script></body>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/email/list') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ emails: [email], total: 1 }));
  }
  if (url.pathname === '/api/email/archive/7') {
    archiveAttempts++;
    if (archiveAttempts === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'temporary archive outage' }));
    }
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/email/delete/7') {
    deleteAttempts++;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ detail: 'temporary delete outage' }));
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (url.pathname === '/static/js/emailInbox.js') {
    const source = fs.readFileSync(file, 'utf8').replace('export function init(documentModule)', 'window.__testDeleteEmail = _deleteEmail;\nwindow.__testToggleDone = _toggleDone;\nexport function init(documentModule)');
    return res.end(source);
  }
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => window.startLoad());
    const row = page.locator('.email-item[data-uid="7"]');
    await row.waitFor();

    const swipe = async () => row.evaluate(el => {
      const touch = (type, x) => {
        const event = new Event(type, { bubbles: true });
        Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: 10 }] });
        el.dispatchEvent(event);
      };
      touch('touchstart', 180);
      touch('touchmove', 80);
      touch('touchend', 80);
    });
    await swipe();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Could not archive'));
    assert.equal(await row.count(), 1, 'failed archive keeps the email row');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.email-item[data-uid="7"]')).opacity === '1');
    assert.equal(await row.evaluate(el => getComputedStyle(el).opacity), '1', 'failed swipe restores row visibility');
    assert.equal(await row.getAttribute('data-swipe-block'), null);

    await page.evaluate(() => { void window.__testDeleteEmail({ uid: '7', subject: 'Keep me' }); });
    await page.locator('#styled-confirm-ok').waitFor();
    await page.locator('#styled-confirm-ok').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Could not delete'));
    assert.equal(await row.count(), 1, 'failed delete keeps the email row');
    assert.equal(deleteAttempts, 1);

    await swipe();
    await page.waitForFunction(() => !document.querySelector('.email-item[data-uid="7"]'));
    assert.equal(archiveAttempts, 2, 'successful retry removes the row');
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log('PASS: failed archive/delete preserve rows; mobile archive retry succeeds');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
