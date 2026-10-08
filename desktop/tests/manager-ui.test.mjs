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
      if (pathname === '/chrome.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(await fs.readFile(path.resolve(here, '../src-tauri/src/workspace_chrome.js')));
        return;
      }
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
    window.__holdNextStatus = false;
    window.__pendingStatuses = [];
    window.confirm = () => window.__confirmUpdate;
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      window.__calls.push({ command, args });
      if (command === 'mount_manager_chrome') {
        document.documentElement.dataset.nxWindowManager = 'true';
        const script = document.createElement('script');
        script.src = '/chrome.js';
        document.head.append(script);
        return;
      }
      if (command === 'manager_window_action') {
        if (args.action === 'ready') document.documentElement.dataset.nxWindowFrame = 'custom';
        return;
      }
      if (command === 'get_status') {
        if (window.__holdNextStatus) {
          window.__holdNextStatus = false;
          return new Promise((resolve, reject) => window.__pendingStatuses.push({ resolve, reject }));
        }
        return { config: window.__config, backend: window.__backend };
      }
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
  assert.equal(await page.locator('.dashboard-grid').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundImage), 'none');
  assert.equal(await page.locator('.panel').first().evaluate(el => getComputedStyle(el).backgroundImage), 'none');
  assert.equal(await page.locator('[data-action="start"]').isEnabled(), true);
  await page.waitForSelector('#nx-window-bar');
  await page.setViewportSize({ width: 1180, height: 600 });
  await page.waitForFunction(() => document.body.clientHeight === 564 && document.body.scrollHeight > 564);
  const frameLayout = await page.evaluate(() => {
    const body = document.body;
    body.scrollTop = 200;
    return {
      top: body.getBoundingClientRect().top,
      height: body.clientHeight,
      overflow: getComputedStyle(body).overflowY,
      scroll: body.scrollTop,
      rootScroll: document.documentElement.scrollTop,
      barTop: document.querySelector('#nx-window-bar').getBoundingClientRect().top,
    };
  });
  assert.equal(frameLayout.top, 36);
  assert.equal(frameLayout.height, 564);
  assert.equal(frameLayout.overflow, 'auto');
  assert.ok(frameLayout.scroll > 0, 'manager content must scroll independently');
  assert.equal(frameLayout.rootScroll, 0);
  assert.equal(frameLayout.barTop, 0, 'title bar must stay outside scrolling content');
  await page.evaluate(() => { document.body.scrollTop = 0; });
  await page.setViewportSize({ width: 1180, height: 900 });

  await page.locator('#project').fill('Fixture project');
  await page.locator('#config-form button[type="submit"]').click();
  await page.waitForFunction(() => window.__calls.some((call) => call.command === 'save_config'));
  const saveCall = await page.evaluate(() => window.__calls.find((call) => call.command === 'save_config'));
  assert.deepEqual(saveCall.args.config, { checkout: '/tmp/nx-checkout', project: 'Fixture project', port: 7300 });
  assert.equal(await page.locator('#config-message').textContent(), 'Settings saved.');

  await page.locator('#checkout').fill('/tmp/unsaved-checkout');
  await page.locator('#project').fill('Unsaved draft');
  await page.locator('#port').fill('7444');
  await page.evaluate(() => { window.__holdNextStatus = true; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => window.__pendingStatuses.length === 1);
  await page.evaluate(() => window.__pendingStatuses[0].resolve({
    config: { checkout: '/tmp/external-checkout', project: 'External config', port: 7445 },
    backend: { state: 'stopped', detail: 'Newest service check.' },
  }));
  await page.waitForFunction(() => document.querySelector('#backend-detail').textContent === 'Newest service check.');
  assert.equal(await page.locator('#checkout').inputValue(), '/tmp/unsaved-checkout');
  assert.equal(await page.locator('#project').inputValue(), 'Unsaved draft');
  assert.equal(await page.locator('#port').inputValue(), '7444');

  await page.evaluate(() => { window.__holdNextStatus = true; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => window.__pendingStatuses.length === 2);
  await page.evaluate(() => { window.__backend = { state: 'running', detail: 'Newest status.' }; });
  const statusCountBeforeRefresh = await page.evaluate(() => window.__calls.filter((call) => call.command === 'get_status').length);
  await page.locator('[data-action="refresh"]').click();
  await page.waitForFunction((count) => window.__calls.filter((call) => call.command === 'get_status').length === count + 1, statusCountBeforeRefresh);
  await page.waitForFunction(() => document.querySelector('#backend-state-text').textContent === 'Running' && document.querySelector('.dashboard-grid').getAttribute('aria-busy') === 'false');
  await page.evaluate(() => window.__pendingStatuses[1].reject(new Error('late stale failure')));
  await page.waitForTimeout(30);
  assert.equal(await page.locator('#global-error').isVisible(), false);
  assert.equal(await page.locator('#backend-state-text').textContent(), 'Running');
  assert.equal(await page.locator('#project').inputValue(), 'Unsaved draft');
  await page.evaluate(() => { window.__backend = { state: 'stopped' }; });
  await page.locator('[data-action="refresh"]').click();
  await page.waitForFunction(() => document.querySelector('#backend-state-text').textContent === 'Stopped' && document.querySelector('.dashboard-grid').getAttribute('aria-busy') === 'false');

  await page.locator('[data-action="start"]').click();
  for (const action of ['minimize', 'toggle-maximize', 'close']) {
    const control = page.locator(`#nx-window-bar [data-action="${action}"]`);
    assert.equal(await control.isEnabled(), true, 'backend work must not disable window controls');
    await control.click();
    assert.ok(await page.evaluate(action => window.__calls.some(call =>
      call.command === 'manager_window_action' && call.args.action === action), action));
  }
  await page.waitForFunction(() => typeof window.__finishStart === 'function');
  assert.equal(await page.locator('.dashboard-grid').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#global-notice').textContent(), 'Starting backend…');
  assert.equal(await page.locator('[data-action="refresh"]').isDisabled(), true);
  const statusCallsWhileStarting = await page.evaluate(() => window.__calls.filter((call) => call.command === 'get_status').length);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => window.__calls.filter((call) => call.command === 'get_status').length), statusCallsWhileStarting, 'focus refresh must not overlap a native action');
  await page.locator('[data-action="start"]').click({ force: true });
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
  const pendingStatusIndex = await page.evaluate(() => window.__pendingStatuses.length);
  await page.evaluate(() => { window.__holdNextStatus = true; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction((index) => window.__pendingStatuses.length === index + 1, pendingStatusIndex);
  await page.locator('[data-action="check-update"]').click();
  await page.waitForFunction(() => window.__calls.some((call) => call.command === 'check_update'));
  await page.waitForFunction(() => document.querySelector('#update-message').textContent.includes('not supported'));
  assert.match(await page.locator('#update-message').textContent(), /not supported/);
  await page.evaluate((index) => window.__pendingStatuses[index].resolve({
    config: window.__config,
    backend: { state: 'stopped', detail: 'Late status response.' },
    update: { supported: true, available: false, detail: 'Run the update check.' },
  }), pendingStatusIndex);
  await page.waitForFunction(() => document.querySelector('#backend-detail').textContent === 'Late status response.');
  assert.match(await page.locator('#update-message').textContent(), /not supported/, 'late status must not overwrite a newer explicit update check');
  assert.equal(await page.locator('[data-action="update"]').count(), 1);
  assert.equal(await page.locator('[data-action="update"]').isVisible(), false);
  await page.evaluate(() => { window.__updateCheck = { supported: true, current: 'old', target: 'new', update_available: true, detail: 'A reviewed update is available.' }; });
  await page.locator('[data-action="check-update"]').click();
  await page.waitForFunction(() => window.__calls.filter((call) => call.command === 'check_update').length === 2);
  assert.equal(await page.locator('[data-action="update"]').isVisible(), true);
  assert.match(await page.locator('.backup-note').textContent(), /make a backup/);
  await page.locator('[data-action="update"]').click();
  await page.waitForTimeout(20);
  assert.equal(await page.evaluate(() => window.__calls.filter((call) => call.command === 'update_backend').length), 0, 'cancelled confirmation must not apply update');
  assert.equal(await page.locator('.dashboard-grid').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#global-notice').isVisible(), false, 'cancelled update clears pending progress');
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
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const narrowLayout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      topbar: document.querySelector('.topbar').scrollWidth,
      topbarClient: document.querySelector('.topbar').clientWidth,
      brandRight: document.querySelector('.brand').getBoundingClientRect().right,
      statusRight: document.querySelector('#backend-state').getBoundingClientRect().right,
    }));
    assert.equal(narrowLayout.page, narrowLayout.viewport, `${width}px manager layout should not overflow horizontally`);
    assert.ok(narrowLayout.topbar <= narrowLayout.topbarClient, `${width}px topbar should fit its container`);
  }
  assert.deepEqual(pageErrors, []);

  const preview = await browser.newPage();
  await preview.goto(url);
  assert.match(await preview.locator('#global-error').textContent(), /unavailable in browser preview/);
  assert.equal(await preview.locator('#config-form input').first().isDisabled(), true);
  assert.equal(await preview.locator('.app-shell [data-action]:not([hidden])').evaluateAll((buttons) => buttons.every((button) => button.disabled)), true);
  assert.equal(await preview.locator('#backend-state-text').textContent(), 'Checking status');
  assert.deepEqual(await preview.evaluate(() => window.__TAURI__), undefined);
  await preview.close();
});
