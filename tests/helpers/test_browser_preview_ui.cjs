const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const server = http.createServer((req, res) => {
  if (req.url === '/browserPreview.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(path.join(repo, 'static/js/browserPreview.js')));
  } else if (req.url === '/browser-preview.css') {
    res.setHeader('Content-Type', 'text/css');
    res.end(fs.readFileSync(path.join(repo, 'static/browser-preview.css')));
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<meta charset="utf-8"><link rel="stylesheet" href="/browser-preview.css"><main id="chat-history"></main><script>window.sessionModule={getCurrentSessionId:()=>window.activeSession};window.activeSession="chat-1";</script><script type="module">import {updateBrowserPreview,resetBrowserPreview} from "/browserPreview.js";window.preview={updateBrowserPreview,resetBrowserPreview};</script>');
  }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => !!window.preview);
    const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/f9sAAAAASUVORK5CYII=';
    const result = await page.evaluate(screenshot => {
      const startAccepted = window.preview.updateBrowserPreview({ type: 'tool_start', tool: 'mcp__builtin_browser__browser_navigate', command: 'Navigating' }, 'chat-1');
      const startCard = document.querySelector('.browser-preview-card');
      const outputAccepted = window.preview.updateBrowserPreview({
        type: 'tool_output', tool: 'mcp__builtin_browser__browser_navigate',
        browser_preview: { state: 'updated', screenshot, title: '<img src=x onerror=alert(1)>', url: 'https://example.test/path', action: 'Navigate' },
      }, 'chat-1');
      const panel = document.querySelector('#browser-preview-panel');
      const first = {
        startAccepted, outputAccepted, cardText: startCard.textContent,
        autoOpened: !!panel,
        title: panel.querySelector('.browser-preview-title').textContent,
        imageSrc: panel.querySelector('img').getAttribute('src'),
        external: panel.querySelector('a')?.href,
        safeLink: panel.querySelector('a')?.rel,
        injected: !!panel.querySelector('.browser-preview-title img'),
        status: panel.querySelector('.browser-preview-status').textContent,
      };
      window.preview.updateBrowserPreview({
        type: 'tool_output', tool: 'mcp__builtin_browser__browser_click',
        browser_preview: { state: 'updated', screenshot, title: 'Second page', url: 'https://example.test/second', action: 'Click button' },
      }, 'chat-1');
      document.querySelector('#browser-preview-panel .browser-preview-close').click();
      window.preview.updateBrowserPreview({
        type: 'tool_output', tool: 'mcp__builtin_browser__browser_click',
        browser_preview: { state: 'updated', screenshot, title: 'Updated title', url: 'javascript:alert(1)', action: 'Click button' },
      }, 'chat-1');
      const stayedClosed = !document.querySelector('#browser-preview-panel');
      document.querySelector('.browser-preview-card').click();
      const reopened = !!document.querySelector('#browser-preview-panel');
      const safeUrlPreserved = document.querySelector('#browser-preview-panel .browser-preview-url')?.href === 'https://example.test/second';
      document.querySelector('#browser-preview-panel .browser-preview-close').focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const escapeClosed = !document.querySelector('#browser-preview-panel');
      const focusRestored = document.activeElement === document.querySelector('.browser-preview-card');
      document.querySelector('.browser-preview-card').click();
      window.preview.updateBrowserPreview({ type: 'tool_start', tool: 'mcp__builtin_browser__browser_fill', command: 'password=not-display-this' }, 'chat-1');
      const secretOmitted = !document.querySelector('.browser-preview-card').textContent.includes('password');
      window.preview.updateBrowserPreview({ type: 'tool_output', tool: 'mcp__builtin_browser__browser_fill', exit_code: 1 }, 'chat-1');
      const failedStatus = document.querySelector('.browser-preview-card').textContent.includes('Browser action failed');
      const staleLabel = document.querySelector('#browser-preview-panel .browser-preview-title')?.textContent.includes('Last successful page');
      window.activeSession = 'chat-2';
      window.preview.resetBrowserPreview('chat-2');
      const sessionReset = !document.querySelector('#browser-preview-panel') && !document.querySelector('.browser-preview-card');
      window.activeSession = 'chat-1';
      window.preview.resetBrowserPreview('chat-1');
      window.preview.resetBrowserPreview('chat-1');
      const sameSessionCardRestored = !!document.querySelector('.browser-preview-card');
      window.preview.resetBrowserPreview();
      const fullyCleared = !document.querySelector('.browser-preview-card');
      const invalid = window.preview.updateBrowserPreview({
        type: 'tool_output', tool: 'mcp__builtin_browser__browser_snapshot',
        browser_preview: { state: 'updated', screenshot: 'https://remote.test/image.png', title: 'No remote images', url: 'file:///etc/passwd' },
      }, 'chat-2');
      document.querySelector('.browser-preview-card')?.click();
      return {
        first, stayedClosed, reopened, safeUrlPreserved, escapeClosed, focusRestored, secretOmitted,
        failedStatus, staleLabel, sessionReset, sameSessionCardRestored, fullyCleared, invalid,
        cardCount: document.querySelectorAll('.browser-preview-card').length,
        remoteImageRejected: !document.querySelector('#browser-preview-panel img'),
        localUrlRejected: !document.querySelector('#browser-preview-panel .browser-preview-url'),
      };
    }, screenshot);
    assert.equal(result.first.startAccepted, true);
    assert.equal(result.first.outputAccepted, true);
    assert.match(result.first.cardText, /Watch browser/);
    assert.equal(result.first.autoOpened, true);
    assert.equal(result.first.title, '<img src=x onerror=alert(1)>');
    assert.equal(result.first.injected, false);
    assert.match(result.first.imageSrc, /^data:image\/png;base64,/);
    assert.match(result.first.external, /^https:\/\/example\.test\//);
    assert.match(result.first.safeLink, /noopener/);
    assert.match(result.first.status, /Updates after each browser action/);
    assert.equal(result.stayedClosed, true);
    assert.equal(result.reopened, true);
    assert.equal(result.safeUrlPreserved, true);
    assert.equal(result.escapeClosed, true);
    assert.equal(result.focusRestored, true);
    assert.equal(result.secretOmitted, true);
    assert.equal(result.failedStatus, true);
    assert.equal(result.staleLabel, true);
    assert.equal(result.sessionReset, true);
    assert.equal(result.sameSessionCardRestored, true);
    assert.equal(result.fullyCleared, true);
    assert.equal(result.invalid, true);
    assert.equal(result.cardCount, 1);
    assert.equal(result.remoteImageRejected, true);
    assert.equal(result.localUrlRejected, true);
    assert.deepEqual(errors, []);
    console.log('PASS: browser preview events, safe screenshot/link, close/reopen and session reset');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
