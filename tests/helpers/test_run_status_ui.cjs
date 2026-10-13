const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><header class="chat-top-bar"></header><script type="module">import * as runStatus from '/static/js/runStatus.js';window.runStatus=runStatus;runStatus.resetRunStatus('alpha');</script>`;
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  const file = path.resolve(repo, `.${req.url}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.runStatus);
    await page.evaluate(() => {
      runStatus.updateRunStatus({ type: 'agent_terminal', status: 'completed' }, 'alpha');
      runStatus.updateRunStatus({ type: 'chat_terminal', data: { failed: true } }, 'beta');
    });
    await page.evaluate(() => runStatus.resetRunStatus('alpha'));
    assert.equal(await page.locator('#nx-run-status').textContent(), 'Finished');
    await page.evaluate(() => runStatus.resetRunStatus('beta'));
    assert.equal(await page.locator('#nx-run-status').textContent(), 'Failed');
    assert.equal(await page.locator('#nx-run-status').getAttribute('data-state'), 'failed');
    await page.evaluate(() => runStatus.updateRunStatus({ type: 'agent_terminal', status: 'waiting_user' }, 'gamma'));
    assert.equal(await page.locator('#nx-run-status').textContent(), 'Needs you');
    await page.evaluate(() => runStatus.updateRunStatus({ type: 'stream_end' }, 'alpha'));
    assert.equal(await page.locator('#nx-run-status').textContent(), 'Finished');
    await page.evaluate(() => runStatus.resetRunStatus());
    assert.equal(await page.locator('#nx-run-status').isHidden(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: terminal status mapping, stream-end stability, and per-session isolation');
  } finally { await browser.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.closeAllConnections?.(); server.close(); process.exitCode = 1; });
