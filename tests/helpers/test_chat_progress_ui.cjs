// Hidden browser regression using shipped status code, spinner and real DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const chat = fs.readFileSync(path.join(repo, 'static/js/chat.js'), 'utf8');
function slice(start, end) {
  assert.equal(chat.split(start).length, 2, `unique anchor: ${start}`);
  return start + chat.split(start)[1].split(end)[0];
}
const statusCode = slice('  function _formatStreamElapsed(', '\n  let API_BASE')
  + slice('  export function checkBackgroundStream(', '\n  async function refreshRecoveryCheckpoint(').replace('export function', 'function');
const server = http.createServer((req, res) => {
  if (req.url === '/spinner.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(path.join(repo, 'static/js/spinner.js')));
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<meta charset="utf-8"><style>body{background:#111;color:#ddd;font:14px monospace}#chat-history{width:320px}.msg{padding:12px;border:1px solid #555;margin:8px 0}.role{margin-bottom:12px}</style><div id="chat-history"></div><script type="module">import spinner from "/spinner.js"; window.spinnerModule=spinner;</script>');
  }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 650 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => !!window.spinnerModule);
    const result = await page.evaluate(source => {
      let now = 200000;
      const originalNow = Date.now;
      Date.now = () => now;
      const originalInterval = window.setInterval;
      let poll;
      window.setInterval = (callback, delay) => delay === 500 ? (poll = callback, 9999) : originalInterval(callback, delay);
      const _backgroundStreams = new Map([['chat', { status: 'running', accumulated: '', startedAt: 50000 }]]);
      const sessionModule = { getCurrentSessionId: () => 'chat', getSessions: () => [{ id: 'chat', model: 'local-model' }] };
      const uiModule = { esc: text => text, scrollHistory: () => {} };
      const documentModule = null;
      const refreshRecoveryCheckpoint = () => {};
      const _shortModel = text => text;
      const _applyModelColor = () => {};
      eval(source + '\ncheckBackgroundStream("chat");');
      const box = document.getElementById('chat-history');
      const waiting = box.textContent;
      const fits = box.scrollWidth <= box.clientWidth;
      now += 2000;
      _backgroundStreams.get('chat').accumulated = 'Hello';
      poll();
      const streaming = box.textContent;
      _backgroundStreams.get('chat').status = 'error';
      _backgroundStreams.get('chat').error = 'Read timeout: no data received. <img src=x onerror=alert(1)> Check the model service and retry.';
      poll();
      const failure = box.textContent;
      const injectedImage = !!box.querySelector('img');
      Date.now = originalNow;
      window.setInterval = originalInterval;
      return { waiting, streaming, failure, fits, injectedImage };
    }, statusCode);
    assert.match(result.waiting, /No model output after 2m 30s/);
    assert.match(result.streaming, /Response streaming in background · 2m 32s/);
    assert.match(result.failure, /Read timeout.*Check the model service and retry/);
    assert.equal(result.fits, true, 'verbose status wraps within narrow chat');
    assert.equal(result.injectedImage, false, 'error is text, not HTML');
    assert.deepEqual(errors, []);
    if (process.env.UI_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.UI_CAPTURE_DIR, 'nx-chat-progress.png'), animations: 'disabled' });
    console.log('PASS: elapsed waiting, streaming transition, terminal explanation, narrow layout and safe error text');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
