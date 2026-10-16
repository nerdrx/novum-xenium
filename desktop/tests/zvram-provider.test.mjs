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

test('local provider offers Regular and zVram modes and registers after health', async t => {
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
    window.__failAction = '';
    window.__zvram = {
      available: true, installation: '/opt/zvram', router_supported: true,
      ignore_swap_guard_supported: true,
      live_control_supported: true,
      models: [{ name: 'Test Model.gguf', path: '/models/test.gguf', size: 1234 }, { name: 'Second.gguf', path: '/models/second.gguf', size: 5678 }],
      router: { name: 'nx-zvram-router', mode: 'regular', auto_start: true, running: false, healthy: false, state: 'stopped', models: [] },
      profiles: [{ name: 'legacy-model', alias: 'Qwen 9B', port: 8097, running: true, state: 'running', lastlog: '' }],
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
        if (request.action === 'router_start') {
          window.__zvram.router = { name: 'nx-zvram-router', mode: request.mode, auto_start: request.auto_start, running: true, healthy: true, state: 'running', port: request.port, context: request.context, compressed: request.compressed, ignore_swap_guard: request.ignore_swap_guard, models: [] };
        }
        if (request.action === 'router_configure') window.__zvram.router = { ...window.__zvram.router, mode: request.mode, auto_start: request.auto_start, port: request.port, context: request.context, compressed: request.compressed, ignore_swap_guard: request.ignore_swap_guard };
        if (request.action === 'router_register') window.__zvram.router.registered = true;
        if (request.action === 'router_stop') window.__zvram.router = { ...window.__zvram.router, running: false, healthy: false, state: 'stopped', models: [] };
        if (request.action === 'stop') window.__zvram.profiles = window.__zvram.profiles.map(profile => profile.name === request.profile ? { ...profile, running: false, state: 'stopped' } : profile);
        return { available: true, message: `${request.action} completed` };
      }
      throw new Error(`unexpected command: ${command}`);
    } } };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.__calls.some(call => call.command === 'zvram_status'));
  await page.waitForFunction(() => !document.getElementById('zvram-refresh').disabled);
  assert.equal(await page.locator('#zvram-advanced').evaluate(element => element.open), false);
  assert.equal(await page.locator('#zvram-installation').textContent(), '/opt/zvram');
  assert.equal(await page.locator('#zvram-live-control').isChecked(), true, 'live management is opt-out by default');
  assert.equal(await page.locator('#zvram-live-control').isDisabled(), true, 'zVram memory controls stay inactive in Regular mode');
  assert.match(await page.locator('#zvram-model-list').textContent(), /Test Model\.gguf, Second\.gguf/);
  assert.equal(await page.locator('#zvram-ignore-swap-guard').isChecked(), true, 'supported swap-growth override defaults on');
  assert.equal(await page.locator('#zvram-ignore-swap-guard').isDisabled(), true);
  assert.equal(await page.locator('#zvram-router-state-value').textContent(), 'Provider stopped');
  assert.equal(await page.locator('#zvram-mode-regular').isChecked(), true, 'new provider defaults to Regular mode');
  assert.equal(await page.locator('#zvram-auto-start').isChecked(), true);
  assert.equal(await page.locator('#zvram-compressed').isDisabled(), true, 'zVram paging is unavailable in Regular mode');
  assert.equal(await page.locator('#zvram-start').isDisabled(), true, 'legacy server on configured router port blocks start');
  assert.match(await page.locator('#zvram-status').textContent(), /Legacy server Qwen 9B is using port 8097/);
  await page.locator('#zvram-advanced > summary').click();
  await page.locator('#zvram-legacy-profiles > summary').click();
  assert.equal(await page.locator('#zvram-legacy-list').getByText('Stop').isEnabled(), true);
  await page.locator('#zvram-legacy-list button').click();
  await page.waitForFunction(() => document.getElementById('zvram-status').textContent === 'Legacy model stopped.');
  assert.equal(await page.locator('#zvram-start').isEnabled(), true);

  await page.evaluate(() => { window.__zvram.ignore_swap_guard_supported = false; });
  await page.locator('#zvram-refresh').click();
  await page.waitForFunction(() => !document.getElementById('zvram-refresh').disabled);
  assert.equal(await page.locator('#zvram-ignore-swap-guard').isDisabled(), true);
  await page.locator('#zvram-ignore-swap-guard').click({ force: true });
  assert.equal(await page.locator('#zvram-ignore-swap-guard').isChecked(), false, 'unsupported override remains off when clicked');
  assert.match(await page.locator('#zvram-swap-guard-note').textContent(), /requires zVram 0\.4\.2 or newer/i);
  await page.evaluate(() => { window.__zvram.ignore_swap_guard_supported = true; });
  await page.locator('#zvram-refresh').click();
  await page.waitForFunction(() => !document.getElementById('zvram-refresh').disabled);
  await page.evaluate(() => { window.__zvram.router_supported = false; });
  await page.locator('#zvram-refresh').click();
  await page.waitForFunction(() => !document.getElementById('zvram-refresh').disabled);
  assert.match(await page.locator('#zvram-status').textContent(), /llama-server build needs model-router support/i);
  assert.equal(await page.locator('#zvram-start').isDisabled(), true);
  await page.evaluate(() => { window.__zvram.router_supported = true; });
  await page.locator('#zvram-refresh').click();
  await page.waitForFunction(() => !document.getElementById('zvram-refresh').disabled);

  await page.locator('#zvram-mode-regular').check();
  assert.equal(await page.locator('#zvram-compressed').isDisabled(), true, 'BP16 cannot be toggled in Regular mode');
  assert.equal(await page.locator('#zvram-live-control').isDisabled(), true);
  assert.equal(await page.locator('#zvram-ignore-swap-guard').isDisabled(), true);
  await page.locator('#zvram-auto-start').uncheck();
  await page.locator('#zvram-apply').click();
  await page.waitForFunction(() => document.getElementById('zvram-status').textContent.includes('Settings saved'));
  assert.equal(await page.locator('#zvram-router-state-value').textContent(), 'Provider stopped', 'applying while stopped does not start the provider');
  const savedRegular = await page.evaluate(() => window.__calls.map(call => call.args?.request).find(request => request?.action === 'router_configure'));
  assert.equal(savedRegular.mode, 'regular');
  assert.equal(savedRegular.ignore_swap_guard, false, 'Regular mode never sends the swap-growth override');
  assert.equal(savedRegular.auto_start, false);
  assert.equal(await page.evaluate(() => window.__zvram.router.running), false);
  await page.locator('#zvram-mode-zvram').check();
  assert.equal(await page.locator('#zvram-compressed').isEnabled(), true, 'zVram mode enables BP16 control');
  assert.equal(await page.locator('#zvram-live-control').isChecked(), true, 'zVram selection defaults live management on when supported');
  await page.locator('#zvram-live-control').uncheck();
  await page.locator('#zvram-mode-regular').check();
  await page.locator('#zvram-mode-zvram').check();
  assert.equal(await page.locator('#zvram-live-control').isChecked(), false, 'mode changes preserve a manual live-management opt-out');
  await page.locator('#zvram-live-control').check();
  await page.locator('#zvram-auto-start').check();
  await page.locator('#zvram-apply').click();
  await page.waitForFunction(() => document.getElementById('zvram-status').textContent.includes('Settings saved'));

  await page.locator('#zvram-port').fill('8098');
  await page.locator('#zvram-context').fill('8192');
  await page.locator('#zvram-compressed').check();
  assert.equal(await page.locator('#zvram-live-control').isChecked(), true);
  assert.equal(await page.locator('#zvram-live-control').isDisabled(), true, 'BP16 paging enables live management automatically');
  await page.locator('#zvram-budget-details > summary').click();
  await page.locator('#zvram-resident').fill('0');
  await page.locator('#zvram-start').click();
  assert.equal(await page.evaluate(() => window.__calls.some(call => call.command === 'zvram_action' && call.args.request.action === 'router_start')), false, 'invalid budgets never start a server');
  await page.locator('#zvram-resident').fill('12000');
  await page.locator('#zvram-cold').fill('8000');
  await page.locator('#zvram-clean-cache').fill('1024');
  await page.locator('#zvram-headroom').fill('1024');
  await page.locator('#zvram-virtual').fill('40');
  await page.locator('#zvram-ignore-swap-guard').uncheck();

  await page.evaluate(() => { window.__failAction = 'router_start'; });
  await page.locator('#zvram-start').click();
  await page.waitForFunction(() => document.getElementById('zvram-error').textContent.includes('Fixture action failure'));
  assert.equal(await page.evaluate(() => window.__calls.some(call => call.command === 'zvram_action' && call.args.request.action === 'router_register')), false, 'provider registration never runs when start fails');

  await page.evaluate(() => { window.__failAction = 'router_register'; });
  await page.locator('#zvram-start').click();
  await page.waitForFunction(() => document.getElementById('zvram-error').textContent.includes('Fixture action failure'));
  assert.equal(await page.locator('#zvram-connect').isEnabled(), true, 'healthy but unregistered router can retry connection');
  await page.locator('#zvram-connect').click();
  await page.waitForFunction(() => document.getElementById('zvram-status').textContent.includes('Provider connected'));
  const requests = await page.evaluate(() => window.__calls.filter(call => call.command === 'zvram_action').map(call => call.args.request));
  assert.deepEqual(requests.map(request => request.action), ['stop', 'router_configure', 'router_configure', 'router_configure', 'router_start', 'router_configure', 'router_start', 'router_register', 'router_register']);
  assert.deepEqual(requests.find(request => request.action === 'router_configure' && request.port === 8098), {
    action: 'router_configure', mode: 'zvram', auto_start: true, port: 8098, context: 8192, compressed: true,
    live_control: true, ignore_swap_guard: false, resident_mib: 12000, cold_mib: 8000,
    clean_cache_mib: 1024, headroom_mib: 1024, virtual_gib: 40,
  });
  assert.deepEqual(requests.find(request => request.action === 'router_start'), {
    action: 'router_start', mode: 'zvram', auto_start: true, port: 8098, context: 8192, compressed: true,
    live_control: true, ignore_swap_guard: false, resident_mib: 12000, cold_mib: 8000,
    clean_cache_mib: 1024, headroom_mib: 1024, virtual_gib: 40,
  });
  assert.equal(await page.locator('#zvram-router-state-value').textContent(), 'Provider ready');
  assert.equal(await page.locator('#zvram-router-models').textContent(), 'No model loaded');
  assert.equal(await page.locator('#zvram-start').isDisabled(), true, 'running router cannot be started twice');
  assert.equal(await page.locator('#zvram-stop').isEnabled(), true);
  await page.evaluate(() => { window.__zvram.router.models = [
    { id: 'qwen3.5:9b', status: 'unloaded' },
    { id: 'qwen3.8:27b', status: 'loaded' },
    { id: 'tiny:135m', status: 'loading' },
  ]; });
  await page.locator('#zvram-refresh').click();
  await page.waitForFunction(() => !document.getElementById('zvram-refresh').disabled);
  assert.equal(await page.locator('#zvram-router-models').textContent(), 'Active: qwen3.8:27b, tiny:135m', 'only loaded/loading models appear active');
  assert.equal(await page.locator('#zvram-ignore-swap-guard').isChecked(), false,
    'explicit opt-out survives router status refresh');

  await page.locator('#zvram-stop').click();
  await page.waitForFunction(() => document.getElementById('zvram-router-state-value').textContent === 'Provider stopped');
  const actions = await page.evaluate(() => window.__calls.filter(call => call.command === 'zvram_action').map(call => call.args.request.action));
  assert.equal(actions.at(-1), 'router_stop');
  assert.equal(await page.evaluate(() => window.__calls.some(call => ['start_backend', 'stop_backend', 'save_config'].includes(call.command))), false, 'provider buttons do not trigger general manager actions');
  await page.evaluate(() => {
    window.__zvram.live_control_supported = false;
    window.__zvram.router = { running: false, state: 'stopped', models: [], compressed: false };
  });
  await page.locator('#zvram-refresh').click();
  await page.waitForFunction(() => !document.getElementById('zvram-refresh').disabled);
  assert.equal(await page.locator('#zvram-live-control').isDisabled(), true);
  assert.equal(await page.locator('#zvram-live-control').isChecked(), false);
  await page.evaluate(() => { window.__zvram.live_control_supported = true; });
  await page.locator('#zvram-refresh').click();
  await page.waitForFunction(() => !document.getElementById('zvram-refresh').disabled);
  assert.equal(await page.locator('#zvram-live-control').isChecked(), true, 'new supported installation defaults live management on');
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'collapsed provider fits narrow desktop window');
  assert.deepEqual(errors, []);
});
