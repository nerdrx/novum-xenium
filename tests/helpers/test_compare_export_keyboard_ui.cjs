// Compare export popover keyboard check using the shipped module in hidden Chrome.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
<button id="trigger" type="button">Export</button><button id="after" type="button">After</button>
<script type="module">import '/static/js/compare/index.js';
document.querySelector('#trigger').addEventListener('click', event => window.__toggleExportMenu(event.currentTarget));
window.fixtureReady = true;</script></body>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (file === path.join(repo, 'static/js/compare/index.js')) {
    const source = fs.readFileSync(file, 'utf8').replace('let _exportMenuEl = null;',
      'window.__toggleExportMenu = _toggleExportMenu; let _exportMenuEl = null;');
    return res.end(source);
  }
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.fixtureReady && window.__toggleExportMenu);
    const trigger = page.locator('#trigger');
    await trigger.focus();
    await trigger.press('Enter');
    assert.equal(await page.locator('.compare-export-menu button').count(), 3);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Copy as Markdown',
      'opening the export popover from keyboard should move focus to its first action');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.compare-export-menu').count(), 0, 'Escape closes the popover');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'trigger', 'Escape returns focus to opener');
    await trigger.click();
    assert.equal(await page.locator('.compare-export-menu').count(), 1, 'mouse click still opens the menu');
    await page.locator('.compare-export-menu button').first().click();
    assert.equal(await page.locator('.compare-export-menu').count(), 0, 'action click closes the menu');
    console.log('PASS: Compare export keyboard focus, Escape restore, and mouse open/action close');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
