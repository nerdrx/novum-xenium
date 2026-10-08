// The composer must keep native Tab navigation; Plan mode stays on its visible toggle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
let blockedWrites = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    blockedWrites++;
    res.statusCode = 405;
    return res.end('Read-only UI fixture');
  }
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(fs.readFileSync(path.join(staticRoot, 'index.html')));
  }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(url.pathname === '/api/presets/templates' ? '[]' : '{}');
  }
  const relative = url.pathname.startsWith('/static/')
    ? url.pathname.slice('/static/'.length)
    : url.pathname.replace(/^\//, '');
  const file = path.resolve(staticRoot, relative);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript'
    : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    for (const viewport of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 900 }]) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.__odysseusSetPlanMode === 'function');
      await page.evaluate(() => window.__odysseusSetPlanMode(false));
      const composer = page.locator('#message');
      await composer.fill('Keep this draft while I navigate controls');
      await composer.focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'model-picker-btn', `${viewport.name}: Tab advances from composer`);
      assert.equal(await page.evaluate(() => document.body.classList.contains('plan-mode-active')), false, `${viewport.name}: Tab does not toggle Plan mode`);
      assert.equal(await composer.inputValue(), 'Keep this draft while I navigate controls', `${viewport.name}: Tab retains text`);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'message', `${viewport.name}: Shift+Tab returns to composer`);
      assert.equal(await page.evaluate(() => document.body.classList.contains('plan-mode-active')), false, `${viewport.name}: Shift+Tab does not toggle Plan mode`);

      await page.locator('#overflow-plus-btn').click();
      const planToggle = page.locator('#plan-toggle-btn');
      await planToggle.waitFor({ state: 'visible' });
      assert.equal(await planToggle.getAttribute('aria-pressed'), 'false', `${viewport.name}: Plan entry starts off`);
      await planToggle.click();
      assert.equal(await planToggle.getAttribute('aria-pressed'), 'true', `${viewport.name}: Plan entry toggles on`);
      assert.equal(await page.evaluate(() => document.body.classList.contains('plan-mode-active')), true, `${viewport.name}: Plan state is active`);
      assert.equal(await composer.inputValue(), 'Keep this draft while I navigate controls', `${viewport.name}: Plan toggle retains text`);
      await planToggle.waitFor({ state: 'hidden' });
      assert.equal(errors.length, 0, `${viewport.name}: no browser errors`);
      if (process.env.UI_CAPTURE_DIR) {
        await page.screenshot({ path: path.join(process.env.UI_CAPTURE_DIR, `plan-mode-${viewport.name}.png`), animations: 'disabled' });
      }
      await page.close();
    }
    console.log(`PASS: native composer Tab/Shift+Tab and Plan mode menu toggle at 390px and desktop; fixture rejected ${blockedWrites} write requests`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
