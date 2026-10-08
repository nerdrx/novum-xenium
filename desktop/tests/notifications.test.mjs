import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const source = await readFile(new URL('../src-tauri/src/workspace_notifications.js', import.meta.url), 'utf8');
test('desktop notifications require opt-in, persist, and reuse existing calls', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:7000/**', route => route.fulfill({ contentType: 'text/html', body: '<div data-settings-panel="reminders"></div>' }));
    await page.addInitScript(() => {
      window.sent = [];
      HTMLAnchorElement.prototype.click = function () { window.sent.push(this.href); };
    });
    await page.addInitScript(source);
    await page.goto('http://127.0.0.1:7000/');
    assert.equal(await page.evaluate(() => Notification.permission), 'denied');
    await page.evaluate(() => new Notification('Hidden'));
    assert.equal(await page.evaluate(() => sent.length), 0);
    assert.equal(await page.locator('#nx-notifications-test').isDisabled(), true);
    await page.locator('#nx-notifications-enabled').check();
    assert.equal(await page.evaluate(() => Notification.requestPermission()), 'granted');
    await page.locator('#nx-notifications-test').click();
    const url = new URL(await page.evaluate(() => sent[0]));
    assert.equal(url.protocol, 'nx-workbench:');
    assert.equal(url.hostname, 'notify');
    assert.equal(url.searchParams.get('title'), 'Novum Xenium');
    await page.reload();
    assert.equal(await page.locator('#nx-notifications-enabled').isChecked(), true);
    await page.evaluate(() => new Notification('T'.repeat(140), {body:'B'.repeat(600)}));
    const bounded = new URL(await page.evaluate(() => sent[0]));
    assert.equal(bounded.searchParams.get('title').length, 120);
    assert.equal(bounded.searchParams.get('body').length, 500);
    await page.locator('#nx-notifications-enabled').uncheck();
    await page.evaluate(() => new Notification('Suppressed'));
    assert.equal(await page.evaluate(() => sent.length), 1);
    await page.reload();
    assert.equal(await page.evaluate(() => Notification.permission), 'denied');
  } finally { await browser.close(); }
});
