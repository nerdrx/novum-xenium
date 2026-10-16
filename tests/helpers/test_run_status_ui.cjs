const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const { withAppStyles } = require('./app_styles.cjs');
const html = withAppStyles(`<!doctype html><html class="nx-workspace"><head><!-- APP_STYLESHEET_LINKS --></head><body class="sidebar-collapsed hamburger-left"><main class="chat-container"><header class="chat-top-bar"><div class="chat-meta-overlay"><span id="current-meta">A current chat title</span></div><button class="workspace-dock-toggle">Workspace</button></header></main><script type="module">import * as runStatus from '/static/js/runStatus.js';window.runStatus=runStatus;runStatus.resetRunStatus('alpha');</script>`);
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://fixture').pathname;
  if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(await html); }
  const file = path.resolve(repo, `.${pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(file));
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
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => runStatus.updateRunStatus({ type: 'delta' }, 'layout'));
      const row = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { title: rect('.chat-meta-overlay'), status: rect('#nx-run-status'), workspace: rect('.workspace-dock-toggle') };
      });
      assert.ok(row.title.width >= 60, `readable title at ${width}px: ${JSON.stringify(row)}`);
      assert.ok(row.title.right <= row.status.left && row.status.right <= row.workspace.left, `header controls overlap at ${width}px`);
      assert.equal(await page.locator('#nx-run-status').textContent(), 'Working');
      assert.equal(await page.locator('#nx-run-status').getAttribute('role'), 'status');
    }
    await page.evaluate(() => runStatus.resetRunStatus());
    assert.equal(await page.locator('#nx-run-status').isHidden(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: terminal status mapping, stream-end stability, and per-session isolation');
  } finally { await browser.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.closeAllConnections?.(); server.close(); process.exitCode = 1; });
