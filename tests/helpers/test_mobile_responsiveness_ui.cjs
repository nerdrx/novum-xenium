// Isolated mobile interaction test; no live app API or user session.
// BROWSER_EXECUTABLE=/path/to/chrome node tests/helpers/test_mobile_responsiveness_ui.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body>
  <button id="hamburger-btn" type="button">Menu</button>
  <nav id="sidebar" class="hidden"></nav>
  <div id="icon-rail" class="rail-hidden"></div>
  <main id="chat-container"><section id="stream"></section></main>
  <section id="memory-list"></section>
  <button id="memory-select-btn" type="button">Select memories</button>
  <script>
    document.getElementById('memory-select-btn').addEventListener('click', event => {
      event.currentTarget.classList.add('active');
    });
  </script>
  <script>
    const querySelectorAll = Document.prototype.querySelectorAll;
    window.fullDocumentQueries = 0;
    Document.prototype.querySelectorAll = function (...args) {
      if (this === document) window.fullDocumentQueries++;
      return querySelectorAll.apply(this, args);
    };
  </script>
  <script src="/static/js/mobileBulkSelect.js"></script>
  <script type="module">
    import { initSidebarLayout } from '/static/js/sidebar-layout.js';
    const Storage = { KEYS: { SIDEBAR_SIDE: 'side' }, get: () => null, set: () => {} };
    initSidebarLayout(Storage, {});
    window.sidebarReady = true;
  </script>
</body>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(html);
  }
  const file = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    });
    await context.addInitScript(() => localStorage.setItem('odysseus-sidebar-mode', 'off'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.sidebarReady);

    await page.evaluate(async () => {
      const stream = document.getElementById('stream');
      const baseline = window.fullDocumentQueries;
      for (let i = 0; i < 100; i++) {
        stream.append(document.createTextNode(`token ${i} `));
        await Promise.resolve();
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      window.streamQueryDelta = window.fullDocumentQueries - baseline;

      const card = document.createElement('article');
      card.className = 'memory-item';
      card.dataset.memoryId = 'fixture';
      card.innerHTML = '<input class="memory-select-cb" type="checkbox">';
      document.getElementById('memory-list').append(card);
      await new Promise(resolve => setTimeout(resolve, 0));
      window.insertedCardBound = card.dataset.mobileSelectHoldBound === '1';
    });
    assert.equal(await page.evaluate(() => window.streamQueryDelta), 0,
      'stream text mutations must not trigger full-document card searches');
    assert.equal(await page.evaluate(() => window.insertedCardBound), true,
      'newly inserted selectable cards still receive touch handling');
    const card = page.locator('.memory-item[data-memory-id="fixture"]');
    await card.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 40, clientY: 40 });
    await page.waitForTimeout(500);
    await card.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 40, clientY: 40 });
    assert.equal(await page.locator('#memory-select-btn').evaluate(el => el.classList.contains('active')), true,
      'long press still enters bulk-select mode');
    assert.equal(await card.locator('.memory-select-cb').isChecked(), true,
      'long press still selects the held card');

    const touchSwipe = async (targetSelector, x1, x2) => page.evaluate(({ targetSelector, x1, x2 }) => {
      const target = document.querySelector(targetSelector);
      const fire = (type, x) => {
        const touch = new Touch({ identifier: 7, target, clientX: x, clientY: 240 });
        const touches = type === 'touchend' ? [] : [touch];
        target.dispatchEvent(new TouchEvent(type, {
          bubbles: true, cancelable: true, touches, targetTouches: touches,
          changedTouches: [touch],
        }));
      };
      fire('touchstart', x1);
      fire('touchmove', x2);
      fire('touchend', x2);
    }, { targetSelector, x1, x2 });

    await touchSwipe('#chat-container', 195, 115);
    assert.equal(await page.locator('#sidebar').evaluate(el => el.classList.contains('hidden')), true,
      'horizontal content gestures must not open the sidebar');

    await page.locator('#hamburger-btn').click();
    assert.equal(await page.locator('#sidebar').evaluate(el => !el.classList.contains('hidden')), true,
      'deliberate hamburger tap still opens the sidebar');
    assert.equal(await page.locator('#sidebar-backdrop').evaluate(el => el.classList.contains('visible')), true,
      'opening the sidebar still shows its backdrop');

    await touchSwipe('#sidebar', 280, 360);
    assert.equal(await page.locator('#sidebar').evaluate(el => el.classList.contains('hidden')), true,
      'rightward swipe still closes the right-side drawer');
    assert.deepEqual(errors, [], 'fixture has no uncaught browser errors');
    console.log('390px mobile interaction checks passed');
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
