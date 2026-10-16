const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
const html = `<!doctype html><meta charset="utf-8">
<div id="chat-history"></div><div id="welcome-screen" style="display:none"></div>
<script type="module">
  import { addMessage, displayMetrics } from '/js/chatRenderer.js';
  window.rendererReady = true;
  window.renderer = { addMessage, displayMetrics };
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('Content-Type', /\.(?:m?js)$/.test(file) ? 'text/javascript; charset=utf-8' : 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.waitForFunction(() => window.rendererReady, null, { timeout: 20000 });

    const result = await page.evaluate(() => {
      const { addMessage, displayMetrics } = window.renderer;
      const makeLiveTarget = () => {
        const message = document.createElement('div');
        message.className = 'msg msg-ai';
        message.innerHTML = '<div class="msg-footer"><div class="msg-actions"></div></div>';
        document.querySelector('#chat-history').appendChild(message);
        return message;
      };
      const footerText = message => message.querySelector('.response-metrics')?.textContent || '';
      const popupSpeed = message => {
        message.querySelector('.response-metrics')?.click();
        return document.querySelector('.ctx-popup')?.textContent || '';
      };

      const live = makeLiveTarget();
      displayMetrics(live, {
        model: 'fixture-model', input_tokens: 20, output_tokens: 100,
        response_time: 50, _fromHistory: true,
      });
      const liveLabel = footerText(live);
      const livePopup = popupSpeed(live);
      document.querySelector('.ctx-popup')?.remove();

      const reopened = addMessage('assistant', 'Saved answer.', 'fixture-model', {
        model: 'fixture-model', input_tokens: 20, output_tokens: 100,
        response_time: 50, usage_source: 'real', _fromHistory: true,
      });
      const reopenedLabel = footerText(reopened);

      const measured = makeLiveTarget();
      displayMetrics(measured, {
        model: 'fixture-model', input_tokens: 1, output_tokens: 100,
        response_time: 50, tokens_per_second: null, gen_tps: 77.7,
        tps_source: 'backend', _fromHistory: true,
      });
      const measuredLabel = footerText(measured);

      const invalid = [];
      for (const metrics of [
        { input_tokens: 10, output_tokens: 0, response_time: 10, _fromHistory: true },
        { input_tokens: 10, output_tokens: 100, response_time: 0, _fromHistory: true },
        { input_tokens: 10, output_tokens: 0, response_time: 0, _fromHistory: true },
      ]) {
        const message = makeLiveTarget();
        displayMetrics(message, metrics);
        invalid.push(footerText(message));
      }
      return { liveLabel, livePopup, reopenedLabel, measuredLabel, invalid };
    });

    assert.match(result.liveLabel, /^~2 tok\/s$/);
    assert.match(result.livePopup, /~2 tok\/s avg \(includes response time\)/);
    assert.match(result.reopenedLabel, /^~2 tok\/s$/);
    assert.equal(result.measuredLabel, '77.7 tok/s', 'measured generation speed remains unchanged');
    assert.ok(result.invalid.every(label => !label.includes('tok/s')),
      'zero/missing token count or duration must not fabricate a rate');
    assert.deepEqual(pageErrors, []);
    console.log('PASS live and reopened TPS metrics');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
