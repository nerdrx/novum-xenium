// Headless check for filename search in the existing workspace drawer.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const { withAppStyles } = require('./app_styles.cjs');
const html = `<!doctype html><html><head><meta charset="utf-8"><!-- APP_STYLESHEET_LINKS --><link rel="stylesheet" href="/static/workspace-dock.css"></head>
<body><button id="workspace-open">Workspace</button><button id="mode-chat-btn"></button>
<script type="module">localStorage.setItem('odysseus-workspace','/workspace');
import workspace from '/static/js/workspace.js';
document.getElementById('workspace-open').onclick=()=>workspace.openWorkspaceBrowser();
window.fixtureReady=true;</script></body></html>`;
const calls = [];
const json = (res, body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return withAppStyles(html).then(styled => res.end(styled));
  if (url.pathname === '/api/workspace/browse') return json(res, {
    path: '/workspace', parent: null, dirs: [], selectable: true,
  });
  if (url.pathname === '/api/workspace/search') {
    calls.push({ q: url.searchParams.get('q'), workspace: url.searchParams.get('workspace') });
    return json(res, { results: [{ name: 'report.txt', path: 'nested/report.txt',
      url: '/api/workspace/open?workspace=%2Fworkspace&path=nested%2Freport.txt' }], truncated: false });
  }
  if (url.pathname === '/api/workspace/open') { res.setHeader('Content-Type','text/plain'); return res.end('<script>window.previewExecuted=true</script>\nSource file contents'); }
  if (url.pathname === '/api/workspace/snapshots') return json(res, { snapshots: [] });
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', (file.endsWith('.js') || file.endsWith('.mjs')) ? 'text/javascript' : 'text/css');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixtureReady);
    await page.locator('#workspace-open').click();
    await page.locator('#workspace-file-query').fill('report');
    await page.waitForFunction(() => document.querySelector('.workspace-file-result'));
    const result = page.locator('.workspace-file-result');
    assert.match(await result.textContent(), /report\.txt[\s\S]*nested\/report\.txt/);
    assert.match(await result.getByRole('link', { name: 'Download' }).getAttribute('href'), /workspace=%2Fworkspace.*path=nested%2Freport\.txt/);
    await result.getByRole('button', {name:'Preview', exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#workspace-file-preview pre')?.textContent.includes('Source file contents'));
    assert.equal(await page.evaluate(()=>window.previewExecuted), undefined, 'Source is text, never executed');
    await page.locator('#workspace-file-preview').getByRole('button', {name:'Close preview'}).click();
    assert.equal(await page.locator('#workspace-file-preview').isVisible(), false);
    assert.equal(await result.getByRole('button', {name:'Preview', exact:true}).evaluate(e=>e===document.activeElement), true);
    await page.route('**/api/workspace/open?*', route=>route.fulfill({body:'x'.repeat(100000),contentType:'text/plain'}));
    await result.getByRole('button', {name:'Preview', exact:true}).click();
    await page.getByText('Preview limited to the first 64 KiB.', {exact:false}).waitFor();
    assert.equal((await page.locator('#workspace-file-preview pre').textContent()).length, 65536);
    await page.unroute('**/api/workspace/open?*');
    await page.route('**/api/workspace/open?*', route=>route.fulfill({body:Buffer.from([0,1,2]),contentType:'application/octet-stream'}));
    await result.getByRole('button', {name:'Preview', exact:true}).click();
    await page.getByText('This file is not plain text.', {exact:false}).waitFor();
    assert.deepEqual(calls, [{ q: 'report', workspace: '/workspace' }]);
    assert.equal(await result.evaluate(el => getComputedStyle(el).display), 'flex');
    const modal = page.locator('#workspace-modal .modal-content');
    const box = await modal.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, 'workspace drawer fits mobile width');
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    assert.deepEqual(errors, []);
    console.log('PASS: workspace filename results show paths and usable open links in the mobile drawer');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
