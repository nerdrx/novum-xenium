// Read-only mobile smoke test against a running Novum. No chat/settings writes.
// NOVUM_SESSION=<cookie> NOVUM_URL=http://127.0.0.1:7000 node scripts/check-mobile-layout.mjs
// Optional PLAYWRIGHT_MODULE and CHROME_PATH select an existing browser runtime.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.NOVUM_URL || 'http://127.0.0.1:7000';
assert(process.env.NOVUM_SESSION, 'Set NOVUM_SESSION to an authenticated test session');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'odysseus_session', value: process.env.NOVUM_SESSION, url: base }]);
  const page = await context.newPage();
  await page.route('**/*', route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) return route.abort();
    const path = new URL(route.request().url()).pathname;
    if (['/static/app.js', '/static/js/modelPicker.js'].includes(path)) {
      return route.fulfill({ path: fileURLToPath(new URL('..' + path, import.meta.url)), contentType: 'application/javascript' });
    }
    return route.continue();
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.approval-mode-trigger').waitFor();
  for (const name of ['mobile-chat.css', 'mobile-dialogs.css']) {
    await page.addStyleTag({ path: fileURLToPath(new URL('../static/' + name, import.meta.url)) });
  }
  for (const [width, height] of [[320, 740], [390, 844], [576, 900], [390, 360], [844, 390], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => {
      for (const id of ['workspace-indicator-btn', 'rag-indicator-btn', 'character-indicator-btn', 'compare-indicator-btn']) {
        document.getElementById(id).style.display = 'flex';
      }
    });
    await page.waitForTimeout(350);
    if (width <= 640) {
      for (const selector of ['.chat-input-right']) {
        const fits = await page.locator(selector).evaluate(e => e.scrollWidth <= e.clientWidth + 1);
        assert(fits, `${selector} clips at ${width}x${height}`);
      }
      const rail = page.locator('.chat-input-left');
      assert(await rail.evaluate(e => e.clientHeight <= 52), 'Tools must stay in one compact row');
      await page.locator('#compare-indicator-btn').scrollIntoViewIfNeeded();
      assert(await page.locator('#compare-indicator-btn').isVisible(), 'Last active tool remains reachable');
      await rail.evaluate(e => { e.scrollLeft = 0; });
      assert(await page.locator('#mode-agent-btn').isVisible(), 'Agent mode must remain reachable');
    }
    for (const [button, menu] of [['#overflow-plus-btn', '#overflow-menu'], ['.approval-mode-trigger', '.approval-mode-panel'], ['#model-picker-btn', '#model-picker-menu']]) {
      await page.locator(button).click();
      await page.waitForTimeout(400);
      const box = await page.locator(menu).boundingBox();
      assert(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1,
        `${menu} outside ${width}x${height}: ${JSON.stringify(box)}`);
      await page.locator(button).click();
      await page.waitForTimeout(250);
    }
    console.log(`PASS ${width}x${height}: toolbar and menus`);
  }
} finally {
  await browser.close();
}
