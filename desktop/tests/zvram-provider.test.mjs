import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../src');

test('zVram provider stays manual and saves, starts, registers, and stops through typed IPC', async t => {
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__calls = [];
    window.__holdStart = false;
    window.__finishStart = null;
    window.__failAction = '';
    window.__zvram = {
      available: true, installation: '/opt/zvram',
      models: [{ name: 'Test Model.gguf', path: '/models/test.gguf', size: 1234 }],
      profiles: [{ profile: 'nx-test-model-gguf', alias: 'nx-test-model-gguf', model: '/models/test.gguf', port: 8097, context: 4096, compressed: false, running: false, healthy: false, state: 'Stopped' }],
      memory: { ram_available_mib: 8000, swap_available_mib: 12000 }, gpu: [{ card: 'card1', vram_used_mib: 9000, vram_total_mib: 24000 }],
    };
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      window.__calls.push({ command, args });
      if (command === 'mount_manager_chrome') return;
      if (command === 'get_status') return { config: { checkout: '/tmp/nx', project: 'Test', port: 7300 }, backend: { state: 'stopped' } };
      if (command === 'zvram_choose_installation') return '/opt/zvram';
      if (command === 'zvram_status') return structuredClone(window.__zvram);
      if (command === 'zvram_action') {
        const request = args.request;
        if (window.__failAction === request.action) { window.__failAction = ''; throw 'Fixture action failure'; }
        if (request.action === 'start' && window.__holdStart) await new Promise(resolve => { window.__finishStart = resolve; });
        if (request.action === 'start') window.__zvram.profiles[0] = { ...window.__zvram.profiles[0], running: true, healthy: true, state: 'Healthy' };
        if (request.action === 'stop') window.__zvram.profiles[0] = { ...window.__zvram.profiles[0], running: false, healthy: false, state: 'Stopped' };
        return { available: true, message: `${request.action} completed` };
      }
      throw new Error(`unexpected command: ${command}`);
    } } };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const disclosure = page.locator('#zvram-panel');
  assert.equal(await disclosure.evaluate(element => element.open), false);
  assert.equal(await page.evaluate(() => window.__calls.some(call => call.command.startsWith('zvram_'))), false, 'zVram stays idle until its panel opens');
  await page.locator('#zvram-panel > summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await disclosure.evaluate(element => element.open), true);

  await page.waitForFunction(() => window.__calls.some(call => call.command === 'zvram_status'));
  await page.waitForFunction(() => !document.getElementById('zvram-refresh').disabled);
  assert.equal(await page.evaluate(() => window.__calls.some(call => call.command === 'zvram_choose_installation' || call.command === 'zvram_action')), false, 'Auto-discovery needs no folder picker and starts no model');
  assert.equal(await page.locator('#zvram-installation').textContent(), '/opt/zvram');
  assert.equal(await page.locator('#zvram-model option').count(), 1);
  assert.match(await page.locator('#zvram-model option').textContent(), /1\.2 KiB/);
  assert.equal(await page.locator('#zvram-alias').inputValue(), 'nx-test-model-gguf');
  assert.equal(await page.locator('#zvram-compressed').isChecked(), false);
  assert.equal(await page.locator('#zvram-resident').isDisabled(), true);
  assert.match(await page.locator('#zvram-gpu').textContent(), /card1: 9,000 \/ 24,000 MiB allocated/);
  assert.match(await page.locator('#zvram-memory').textContent(), /RAM available MiB: 8000 · Swap available MiB: 12000/);

  await page.locator('#zvram-alias').fill('nx-test');
  await page.locator('#zvram-profile-form button[type="submit"]').click();
  await page.waitForFunction(() => window.__calls.some(call => call.command === 'zvram_action'));
  let saved = await page.evaluate(() => window.__calls.find(call => call.command === 'zvram_action').args.request);
  assert.deepEqual(saved, { action: 'save', profile: 'nx-test', model: '/models/test.gguf', alias: 'nx-test', port: 8097, context: 4096, compressed: false });

  assert.match(await page.locator('#zvram-gpu').textContent(), /card1: 9,000 \/ 24,000 MiB allocated/);
  await page.locator('#zvram-compressed').check();
  assert.equal(await page.locator('#zvram-resident').isDisabled(), false);
  await page.locator('#zvram-budget-details > summary').click();
  await page.locator('#zvram-resident').fill('0');
  await page.locator('#zvram-profile-form button[type="submit"]').click();
  assert.equal(await page.locator('#zvram-resident').evaluate(input => input.validity.rangeUnderflow), true);
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.command === 'zvram_action').length), 1);
  await page.locator('#zvram-resident').fill('10000');
  await page.locator('#zvram-cold').fill('4000');
  await page.locator('#zvram-clean-cache').fill('512');
  await page.locator('#zvram-headroom').fill('1024');
  await page.locator('#zvram-virtual').fill('32');
  await page.locator('#zvram-profile-form button[type="submit"]').click();
  await page.waitForFunction(() => window.__calls.filter(call => call.command === 'zvram_action').length === 2);
  saved = await page.evaluate(() => window.__calls.filter(call => call.command === 'zvram_action')[1].args.request);
  assert.equal(saved.compressed, true);
  assert.equal(saved.resident_mib, 10000);
  assert.equal(saved.cold_mib, 4000);
  assert.equal(saved.clean_cache_mib, 512);
  assert.equal(saved.virtual_gib, 32);

  await page.evaluate(() => { window.__holdStart = true; });
  const start = page.locator('[data-zvram-action="start"]');
  await start.click();
  await page.waitForFunction(() => typeof window.__finishStart === 'function');
  assert.equal(await start.isDisabled(), true);
  await start.click({ force: true });
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.command === 'zvram_action' && call.args.request.action === 'start').length), 1, 'duplicate start clicks must not race');
  await page.evaluate(() => { window.__holdStart = false; window.__finishStart(); });
  await page.waitForFunction(() => document.querySelector('#zvram-profile-list').textContent.includes('Healthy') && document.querySelector('#zvram-profile-list [data-zvram-action="register"]:not(:disabled)'));

  await page.evaluate(() => { window.__failAction = 'register'; });
  await page.locator('[data-zvram-action="register"]').click();
  await page.waitForFunction(() => document.querySelector('#zvram-error').textContent.includes('Fixture action failure'));
  assert.equal(await page.locator('[data-zvram-action="register"]').isEnabled(), true, 'failed action unlocks retry');
  await page.locator('[data-zvram-action="register"]').click();
  await page.waitForFunction(() => window.__calls.some(call => call.command === 'zvram_action' && call.args.request.action === 'register'));
  await page.locator('[data-zvram-action="stop"]').click();
  await page.waitForFunction(() => document.querySelector('#zvram-profile-list').textContent.includes('Stopped'));
  assert.equal(await page.locator('[data-zvram-action="start"]').isEnabled(), true);
  assert.equal(await page.locator('[data-zvram-action="stop"]').isEnabled(), false);
  assert.equal(await page.evaluate(() => window.__calls.some(call => ['start_backend', 'stop_backend', 'save_config'].includes(call.command))), false, 'provider buttons must not trigger general manager actions');
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'collapsed provider should fit narrow desktop window');
  assert.deepEqual(errors, []);
});
