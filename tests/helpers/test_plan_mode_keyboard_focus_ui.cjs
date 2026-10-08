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
    if (url.pathname === '/api/presets/templates') return res.end('[]');
    if (url.pathname === '/api/prefs/tool_approval_mode') return res.end('{"value":"auto"}');
    return res.end('{}');
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
      await page.addInitScript(() => {
        const nativeSetTimeout = window.setTimeout.bind(window);
        window.__initialComposerFocusDone = false;
        window.setTimeout = (callback, delay, ...args) => {
          if (typeof callback === 'function' && String(callback).includes('messageInput.focus()')) {
            return nativeSetTimeout(() => {
              try { callback(...args); }
              finally { window.__initialComposerFocusDone = true; }
            }, delay);
          }
          return nativeSetTimeout(callback, delay, ...args);
        };
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.__odysseusSetPlanMode === 'function');
      // Wait for app.js's known 100ms startup autofocus timer, so it cannot
      // steal focus midway through the keyboard assertions.
      await page.waitForFunction(() => window.__initialComposerFocusDone === true);
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

      const planToggle = page.locator('#plan-toggle-btn');
      assert.equal(await planToggle.getAttribute('aria-pressed'), 'false', `${viewport.name}: Plan entry starts off`);

      // Escape from a keyboard-focused menu item returns focus to its opener.
      const trigger = page.locator('#overflow-plus-btn');
      await trigger.focus();
      await page.keyboard.press('Enter');
      await planToggle.waitFor({ state: 'visible' });
      for (let i = 0; i < 30 && await page.evaluate(() => document.activeElement.id) !== 'plan-toggle-btn'; i++) {
        await page.keyboard.press('Tab');
      }
      assert.equal(await page.evaluate(() => document.activeElement.id), 'plan-toggle-btn', `${viewport.name}: Tab reaches Plan entry`);
      await page.keyboard.press('Escape');
      await planToggle.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement.id === 'overflow-plus-btn');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'overflow-plus-btn', `${viewport.name}: Escape returns focus to trigger`);
      assert.equal(await page.evaluate(() => document.body.classList.contains('plan-mode-active')), false, `${viewport.name}: Escape does not toggle Plan mode`);

      // Escape while focus remains on the trigger closes without changing it.
      await page.keyboard.press('Enter');
      await planToggle.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await planToggle.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'overflow-plus-btn', `${viewport.name}: Escape at trigger keeps focus there`);

      // Keyboard activation closes and returns focus; draft and mode survive.
      await page.keyboard.press('Enter');
      await planToggle.waitFor({ state: 'visible' });
      for (let i = 0; i < 30 && await page.evaluate(() => document.activeElement.id) !== 'plan-toggle-btn'; i++) {
        await page.keyboard.press('Tab');
      }
      await page.keyboard.press('Enter');
      await planToggle.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'overflow-plus-btn', `${viewport.name}: keyboard activation returns focus`);
      assert.equal(await page.locator('#plan-toggle-btn').getAttribute('aria-pressed'), 'true', `${viewport.name}: keyboard Plan entry toggles on`);
      assert.equal(await composer.inputValue(), 'Keep this draft while I navigate controls', `${viewport.name}: keyboard Plan toggle retains text`);

      // Pointer-driven close paths must not steal focus from the composer.
      await composer.focus();
      await trigger.click();
      await planToggle.waitFor({ state: 'visible' });
      await composer.click();
      await planToggle.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'message', `${viewport.name}: outside pointer close preserves focus`);
      await trigger.click();
      await planToggle.waitFor({ state: 'visible' });
      await planToggle.click();
      await planToggle.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'message', `${viewport.name}: pointer action preserves composer focus`);
      assert.equal(await page.locator('#plan-toggle-btn').getAttribute('aria-pressed'), 'false', `${viewport.name}: pointer Plan entry toggles off`);
      assert.equal(await composer.inputValue(), 'Keep this draft while I navigate controls', `${viewport.name}: pointer Plan toggle retains text`);

      // Reopening during the fold-in cancels its pending hide and focus work.
      await trigger.click();
      await planToggle.waitFor({ state: 'visible' });
      await trigger.click();
      assert.equal(await page.locator('#overflow-menu').evaluate(menu => menu.classList.contains('closing')), true, `${viewport.name}: close animation started`);
      await trigger.click();
      await planToggle.waitFor({ state: 'visible' });
      await page.waitForTimeout(450);
      assert.equal(await planToggle.isVisible(), true, `${viewport.name}: rapid reopen stays visible beyond old timer`);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'message', `${viewport.name}: stale close does not steal focus`);
      await composer.click();
      await planToggle.waitFor({ state: 'hidden' });

      // Existing mouse activation remains unchanged.
      await trigger.click();
      await planToggle.waitFor({ state: 'visible' });
      await planToggle.click();
      assert.equal(await planToggle.getAttribute('aria-pressed'), 'true', `${viewport.name}: Plan entry toggles on with mouse`);
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
