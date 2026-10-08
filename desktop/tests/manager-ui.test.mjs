import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PACKAGE || 'playwright';
const { chromium } = require(playwrightPath);
const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../src');

async function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = path.resolve(sourceRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(sourceRoot + path.sep)) throw new Error('invalid path');
      const body = await fs.readFile(file);
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('manager uses native IPC safely and browser preview remains inert', async (t) => {
  const { server, url } = await startServer();
  t.after(() => server.close());
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__calls = [];
    window.__backend = { state: 'stopped', detail: 'Docker is available; service is stopped.' };
    window.__config = { checkout: '/tmp/nx-checkout', project: 'Fixture', port: 7300 };
    window.__confirmUpdate = false;
    window.confirm = () => window.__confirmUpdate;
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      window.__calls.push({ command, args });
      if (command === 'get_status') return { config: window.__config, backend: window.__backend };
      if (command === 'save_config') { window.__config = args.config; return args.config; }
      if (command === 'start_backend') { await new Promise((resolve) => { window.__finishStart = resolve; }); window.__backend = { state: 'running' }; return {}; }
      if (command === 'stop_backend') { window.__backend = { state: 'stopped' }; return {}; }
      if (command === 'open_workbench') return { url: 'http://127.0.0.1:7300' };
      if (command === 'read_logs') return { text: '<img src=x onerror=alert(1)>\nservice ready', truncated: true };
      if (command === 'check_update') return window.__updateCheck || { supported: false, message: 'Updates are not supported by this installation yet.' };
      if (command === 'update_backend') return { updated: true, from: 'old', to: 'new', backupPath: '/tmp/nx-backup', detail: 'Updated successfully.' };
      throw new Error(`unexpected command: ${command}`);
    } } };
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__calls.some((call) => call.command === 'get_status'));
  assert.equal(await page.locator('#backend-state-text').textContent(), 'Stopped');
  assert.equal(await page.locator('[data-action="start"]').isEnabled(), true);

  await page.locator('#project').fill('Fixture project');
  await page.locator('#config-form button[type="submit"]').click();
  await page.waitForFunction(() => window.__calls.some((call) => call.command === 'save_config'));
  const saveCall = await page.evaluate(() => window.__calls.find((call) => call.command === 'save_config'));
  assert.deepEqual(saveCall.args.config, { checkout: '/tmp/nx-checkout', project: 'Fixture project', port: 7300 });
  assert.equal(await page.locator('#config-message').textContent(), 'Settings saved.');

  await page.locator('[data-action="start"]').click();
  await page.locator('[data-action="start"]').click({ force: true });
  await page.waitForFunction(() => typeof window.__finishStart === 'function');
  assert.equal(await page.evaluate(() => window.__calls.filter((call) => call.command === 'start_backend').length), 1);
  await page.evaluate(() => window.__finishStart());
  await page.waitForFunction(() => window.__calls.filter((call) => call.command === 'get_status').length >= 2);
  assert.equal(await page.locator('#backend-state-text').textContent(), 'Running');
  assert.equal(await page.locator('[data-action="open"]').isEnabled(), true);
  await page.locator('[data-action="open"]').click();
  await page.waitForFunction(() => window.__calls.some((call) => call.command === 'open_workbench'));
  await page.locator('[data-action="stop"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__calls.some((call) => call.command === 'stop_backend'));
  await page.waitForFunction(() => window.__calls.filter((call) => call.command === 'get_status').length >= 3);
  assert.equal(await page.locator('#backend-state-text').textContent(), 'Stopped');

  await page.evaluate(() => { window.__backend = { state: 'unhealthy' }; });
  await page.locator('[data-action="refresh"]').click();
  await page.waitForFunction(() => document.querySelector('#backend-state-text').textContent === 'Unhealthy');
  assert.equal(await page.locator('[data-action="stop"]').isEnabled(), true, 'running but unhealthy service must remain stoppable');
  assert.equal(await page.locator('[data-action="open"]').isEnabled(), false);

  await page.locator('[data-action="logs"]').click();
  await page.waitForFunction(() => window.__calls.some((call) => call.command === 'read_logs'));
  assert.equal(await page.locator('#logs-output').textContent(), '<img src=x onerror=alert(1)>\nservice ready');
  assert.equal(await page.locator('#logs-output img').count(), 0);
  await page.locator('[data-action="check-update"]').click();
  await page.waitForFunction(() => window.__calls.some((call) => call.command === 'check_update'));
  assert.match(await page.locator('#update-message').textContent(), /not supported/);
  assert.equal(await page.locator('[data-action="update"]').count(), 1);
  assert.equal(await page.locator('[data-action="update"]').isVisible(), false);
  await page.evaluate(() => { window.__updateCheck = { supported: true, current: 'old', target: 'new', available: true, detail: 'A reviewed update is available.' }; });
  await page.locator('[data-action="check-update"]').click();
  await page.waitForFunction(() => window.__calls.filter((call) => call.command === 'check_update').length === 2);
  assert.equal(await page.locator('[data-action="update"]').isVisible(), true);
  assert.match(await page.locator('.backup-note').textContent(), /make a backup/);
  await page.locator('[data-action="update"]').click();
  await page.waitForTimeout(20);
  assert.equal(await page.evaluate(() => window.__calls.filter((call) => call.command === 'update_backend').length), 0, 'cancelled confirmation must not apply update');
  await page.evaluate(() => { window.__confirmUpdate = true; });
  await page.locator('[data-action="update"]').click();
  await page.waitForFunction(() => window.__calls.some((call) => call.command === 'update_backend'));
  await page.waitForFunction(() => document.querySelector('#global-notice').textContent.includes('/tmp/nx-backup'));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(50);
  const mobileLayout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
    gridColumns: getComputedStyle(document.querySelector('.dashboard-grid')).gridTemplateColumns,
  }));
  assert.equal(mobileLayout.page, mobileLayout.viewport, 'mobile layout should not overflow horizontally');
  assert.ok(mobileLayout.gridColumns.split(' ').length <= 1, 'mobile panels should stack in one column');
  assert.deepEqual(pageErrors, []);

  const preview = await browser.newPage();
  await preview.goto(url);
  assert.match(await preview.locator('#global-error').textContent(), /unavailable in browser preview/);
  assert.equal(await preview.locator('#config-form input').first().isDisabled(), true);
  assert.equal(await preview.locator('#backend-state-text').textContent(), 'Checking status');
  assert.deepEqual(await preview.evaluate(() => window.__TAURI__), undefined);
  await preview.close();
});
