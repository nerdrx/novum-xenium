const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let defaultRequests = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><button id="type">Type</button><script type="module">import workspace from "/static/js/workspace.js";window.workspace=workspace;window.ready=true;</script>');
  }
  if (url.pathname === '/api/workspace/default') {
    defaultRequests++;
    const requestNo = defaultRequests;
    return setTimeout(() => {
      if (requestNo === 1) { res.writeHead(503).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, path: '/default-workspace' }));
    }, requestNo >= 3 ? 100 : 0);
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(path.join(repo, 'static') + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.ready);
    const retry = await page.evaluate(async () => {
      const first = await workspace.loadDefaultWorkspace();
      const second = await workspace.loadDefaultWorkspace();
      return { first, second, stored: localStorage.getItem('odysseus-workspace') };
    });
    assert.equal(retry.first.ok, false);
    assert.equal(retry.second.ok, true, 'failed default load can be retried');
    assert.equal(retry.stored, '/default-workspace');

    await page.reload();
    await page.waitForFunction(() => window.ready);
    await page.evaluate(async () => {
      localStorage.setItem('odysseus-workspace', '');
      const result = await workspace.loadDefaultWorkspace();
      window.explicitEmpty = { result, stored: localStorage.getItem('odysseus-workspace') };
    });
    assert.equal(await page.evaluate(() => window.explicitEmpty.stored), '', 'explicitly cleared workspace stays empty');
    assert.equal(defaultRequests, 2, 'an explicit empty workspace skips the default request');

    await page.reload();
    await page.waitForFunction(() => window.ready);
    await page.evaluate(async () => {
      localStorage.removeItem('odysseus-workspace');
      const pending = workspace.loadDefaultWorkspace();
      workspace.setWorkspace('/chosen-during-load');
      const result = await pending;
      window.concurrentChoice = { result, stored: localStorage.getItem('odysseus-workspace') };
    });
    assert.equal(await page.evaluate(() => window.concurrentChoice.stored), '/chosen-during-load', 'selection made during request wins');
    assert.equal(defaultRequests, 3);
    assert.deepEqual(errors, []);
    console.log('PASS: default workspace retries failure and preserves explicit/concurrent choices');
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.closeAllConnections?.(); server.close(); process.exitCode = 1; });
