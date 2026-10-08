// Context usage must not imply a zero-percent model window when capacity is unknown.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let payload = null;
const html = `<!doctype html><meta charset="utf-8"><body>
<div id="export-compact-btn"><span class="dropdown-icon"></span></div>
<button id="chat-context-pill" hidden><span id="chat-context-pill-label">0%</span></button>
<script type="module">
  window.sessionModule = { getCurrentSessionId: () => 'fixture-session' };
  const chat = await import('/static/js/chat.js');
  window.refreshContext = chat.refreshChatContextHeader;
  window.fixtureReady = true;
</script></body>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/session/fixture-session/context') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(payload));
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady && window.refreshContext);

    payload = {
      model: 'unknown-provider/model-x', used_tokens: 4662, context_length: 0,
      context_percent: 0, messages: 8, auto_compact_threshold: 85,
      last_request: {
        estimated: true, total_tokens: 4662, output_reserve: 1000,
        input_budget_tokens: 4976, available_tokens: 4976, remaining_tokens: 314,
        categories: { instructions: { tokens: 100 }, conversation: { tokens: 4562 } },
      },
    };
    await page.evaluate(() => window.refreshContext('fixture'));
    const pill = page.locator('#chat-context-pill');
    assert.equal(await pill.locator('#chat-context-pill-label').textContent(), '?',
      'unknown capacity must not be rendered as zero usage');
    assert.match(await pill.getAttribute('title'), /Context window unknown/);
    assert.equal(await pill.evaluate(el => el.style.getPropertyValue('--ctx-color')), 'var(--text-muted, #888)');
    await pill.click();
    await page.waitForFunction(() => !!document.querySelector('.chat-context-popup'), null, { timeout: 3000 })
      .catch(() => { throw new Error(`popup did not open; errors=${pageErrors.join(' | ')} pill=${JSON.stringify(page.locator('#chat-context-pill').getAttribute('class'))}`); });
    const popup = page.locator('.chat-context-popup');
    let popupRows = await popup.locator('.chat-context-popup-row').allTextContents();
    assert.ok(popupRows.includes('UsageUnknown window'), `rows=${JSON.stringify(popupRows)} popup=${await popup.innerText()}`);
    assert.ok(popupRows.includes('Used4,662 / Unknown'), JSON.stringify(popupRows));
    assert.ok(popupRows.includes('Last request vs input budget4,662 / 4,976 (94%)'), JSON.stringify(popupRows));

    // Known-window rendering keeps the established percentage and budget detail.
    payload = { ...payload, context_length: 32768, context_percent: 14.2 };
    await page.evaluate(() => window.refreshContext('known-fixture'));
    assert.equal(await pill.locator('#chat-context-pill-label').textContent(), '14%');
    popupRows = await popup.locator('.chat-context-popup-row').allTextContents();
    assert.ok(popupRows.includes('Usage14.2%'), JSON.stringify(popupRows));
    assert.ok(!popupRows.some(row => row.startsWith('Last request vs input budget')));
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
    console.log('PASS: unknown-window honesty, last-request budget ratio, and known-window behavior');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
