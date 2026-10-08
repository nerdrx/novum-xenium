import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const script = await fs.readFile(new URL('../src-tauri/src/workspace_chrome.js', import.meta.url), 'utf8');

test('workspace controls use only guarded navigation and preserve theme/layout', async t => {
  const server = http.createServer(async (req, res) => {
    if (/^\/static\/js\/[A-Za-z]+\.js$/.test(req.url)) {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await fs.readFile(new URL('../../' + req.url.slice(1), import.meta.url)));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><style>:root{--bg:#17151b;--fg:#eee;--border:#554466;--red:#9600ff}body{margin:0;height:100dvh;display:flex}#fixed{position:fixed;top:0}</style></head><body><main>Workspace</main><div id="fixed">Overlay</div></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const browser = await chromium.launch({ headless:true, executablePath:process.env.BROWSER_EXECUTABLE, args:['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{width:1100,height:760} });
  await page.addInitScript(() => {
    window.__windowActions = [];
    document.addEventListener('click', event => {
      const href = event.target.href;
      if (!href?.startsWith('nx-workbench://')) return;
      event.preventDefault();
      const action = new URL(href).hostname;
      window.__windowActions.push(action);
      // Mock only the native window acknowledgement; ordinary web pages have no IPC.
      if (action === 'ready') document.documentElement.dataset.nxWindowFrame = 'custom';
      if (action === 'native-frame') document.documentElement.dataset.nxWindowFrame = 'native';
      if (action === 'toggle-maximize') document.documentElement.dataset.nxMaximized =
        document.documentElement.dataset.nxMaximized === 'true' ? 'false' : 'true';
    }, true);
  });
  await page.addInitScript(script);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await page.locator('#nx-window-bar').count(), 1);
  assert.equal(await page.locator('body').evaluate(el => el.getBoundingClientRect().top), 36);
  assert.equal(await page.locator('#fixed').evaluate(el => el.getBoundingClientRect().top), 0);
  assert.equal(await page.locator('#nx-window-bar').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(23, 21, 27)');
  // Real shared popup helper, including Documents' custom skip selector.
  await page.evaluate(async () => {
    const { makeWindowDraggable } = await import('/static/js/windowDrag.js');
    const modal = document.createElement('div');
    modal.id = 'popup';
    modal.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none';
    modal.innerHTML = '<section style="width:400px;height:240px;background:#222;pointer-events:auto"><header style="height:44px;display:flex;justify-content:space-between;align-items:center;padding:0 20px"><span>Documents</span><button class="close-btn" id="popup-close">Close popup</button></header></section>';
    document.body.append(modal);
    const content = modal.querySelector('section');
    makeWindowDraggable(modal, {content, header:modal.querySelector('header'), skipSelector:'.modal-close', enableDock:false});
    modal.querySelector('button').addEventListener('click', () => modal.remove());
  });
  const popup = page.locator('#popup section');
  const before = await popup.boundingBox();
  await page.locator('#popup header span').click();
  assert.deepEqual(await popup.boundingBox(), before, 'header click must not shift the popup');
  await page.mouse.move(before.x + 80, before.y + 22);
  await page.mouse.down();
  await page.mouse.move(before.x + 130, before.y + 52, {steps:5});
  await page.mouse.up();
  const dragged = await popup.boundingBox();
  assert.equal(dragged.x, before.x + 50);
  assert.equal(dragged.y, before.y + 30);
  // Right-click must not pin or move a popup, and dragging cannot hide its header.
  await page.locator('#popup header span').click({button:'right'});
  assert.deepEqual(await popup.boundingBox(), dragged);
  await page.mouse.move(dragged.x + 80, dragged.y + 22);
  await page.mouse.down();
  await page.mouse.move(-200, -200, {steps:5});
  await page.mouse.up();
  const clamped = await popup.boundingBox();
  assert.equal(clamped.x, 0);
  assert.equal(clamped.y, 36, 'popup header stays below desktop title bar');
  await page.mouse.move(80, 58);
  await page.mouse.down();
  await page.mouse.move(1000, 750, {steps:5});
  await page.mouse.up();
  const lower = await popup.boundingBox();
  assert.ok(lower.x + lower.width <= 1100);
  assert.ok(lower.y + 44 <= 760, 'header controls stay reachable at bottom edge');
  await page.getByRole('button', {name:'Close popup'}).click();
  assert.equal(await page.locator('#popup').count(), 0, 'close receives its click without starting a drag');
  await page.getByRole('button', {name:'Minimize window'}).click();
  await page.getByRole('button', {name:'Maximize window'}).click();
  await page.getByRole('button', {name:'Restore window'}).click();
  await page.locator('#nx-window-drag').focus();
  await page.keyboard.press('Enter');
  await page.locator('#nx-window-drag').dblclick();
  await page.getByRole('button', {name:'Close window'}).click();
  await page.keyboard.press('Control+Equal');
  await page.keyboard.press('Control+-');
  await page.keyboard.press('Control+0');
  await page.evaluate(() => document.dispatchEvent(new WheelEvent('wheel', {deltaY:-1, ctrlKey:true, cancelable:true})));
  const actions = await page.evaluate(() => window.__windowActions);
  assert.equal(actions[0], 'ready');
  assert.ok(actions.includes('drag'));
  assert.equal(actions.filter(a => a === 'toggle-maximize').length, 4);
  assert.ok(actions.includes('close') && actions.includes('minimize'));
  assert.ok(actions.includes('zoom-in') && actions.includes('zoom-out') && actions.includes('zoom-reset'));
  assert.equal(await page.evaluate(() => typeof window.__TAURI__), 'undefined');
  await page.screenshot({path:'/tmp/nx-workbench-titlebar.png'});
  await page.locator('#nx-window-drag').click({button:'right'});
  assert.equal(await page.locator('#nx-window-bar').isVisible(), false);
  assert.equal(await page.locator('body').evaluate(el => el.getBoundingClientRect().top), 0);

  const mac = await browser.newPage();
  await mac.addInitScript(() => Object.defineProperty(navigator, 'platform', {value:'MacIntel'}));
  await mac.addInitScript(script);
  await mac.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await mac.locator('#nx-window-bar').count(), 0);

  const manager = await browser.newPage({ viewport:{width:1100,height:760} });
  await manager.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.dataset.nxWindowManager = 'true';
    }, {once:true});
    window.__managerActions = [];
    window.__TAURI__ = { core:{ invoke: async (command, {action}) => {
      window.__managerActions.push([command, action]);
      if (action === 'ready') document.documentElement.dataset.nxWindowFrame = 'custom';
    } } };
  });
  await manager.addInitScript(script);
  await manager.goto(`http://127.0.0.1:${server.address().port}`);
  await manager.getByRole('button', {name:'Minimize window'}).click();
  await manager.keyboard.press('Control+Equal');
  assert.equal(await manager.locator('body').evaluate(el => el.getBoundingClientRect().top), 36);
  assert.deepEqual(await manager.evaluate(() => window.__managerActions.slice(0, 3)), [
    ['manager_window_action', 'ready'],
    ['manager_window_action', 'minimize'],
    ['manager_window_action', 'zoom-in'],
  ]);
  assert.equal(await manager.evaluate(() => window.__windowActions), undefined, 'manager uses scoped Tauri commands, not workbench navigation');
});
