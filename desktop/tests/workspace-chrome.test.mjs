import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const script = await fs.readFile(new URL('../src-tauri/src/workspace_chrome.js', import.meta.url), 'utf8');

test('workspace controls use only guarded navigation and preserve theme/layout', async t => {
  const server = http.createServer((req, res) => {
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
  assert.equal(await page.locator('#fixed').evaluate(el => el.getBoundingClientRect().top), 36);
  assert.equal(await page.locator('#nx-window-bar').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(23, 21, 27)');
  await page.getByRole('button', {name:'Minimize window'}).click();
  await page.getByRole('button', {name:'Maximize window'}).click();
  await page.getByRole('button', {name:'Restore window'}).click();
  await page.locator('#nx-window-drag').focus();
  await page.keyboard.press('Enter');
  await page.locator('#nx-window-drag').dblclick();
  await page.getByRole('button', {name:'Close window'}).click();
  const actions = await page.evaluate(() => window.__windowActions);
  assert.equal(actions[0], 'ready');
  assert.ok(actions.includes('drag'));
  assert.equal(actions.filter(a => a === 'toggle-maximize').length, 4);
  assert.ok(actions.includes('close') && actions.includes('minimize'));
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
});
