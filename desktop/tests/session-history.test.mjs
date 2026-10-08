import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const router = await fs.readFile(new URL('../../static/js/sessionHistory.js', import.meta.url), 'utf8');
const sideButtons = await fs.readFile(new URL('../src-tauri/src/workspace_reload.js', import.meta.url), 'utf8');
const appSource = await fs.readFile(new URL('../../static/app.js', import.meta.url), 'utf8');
const sessionsSource = await fs.readFile(new URL('../../static/js/sessions.js', import.meta.url), 'utf8');

test('session routes traverse browser history without replay duplicates or restoring deleted chats', async t => {
  assert.match(appSource, /function _startFreshChat\(\)[\s\S]*?setCurrentSessionId\(null,\s*\{\s*pushHistory:\s*true\s*\}\)/,
    'the explicit Home/New Chat path must push a Home entry');
  assert.match(sessionsSource, /setCurrentSessionId\(id,\s*\{\s*pushHistory\s*=\s*false\s*\}/,
    'non-navigation deselection such as deletion must keep replace semantics');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/sessionHistory.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(router);
      return;
    }
    if (req.url === '/workspace_reload.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(sideButtons);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><script src="/workspace_reload.js"></script>
      <button data-id="A">A</button><button data-id="B">B</button><button data-id="C">C</button>
      <button id="new-chat">New chat</button><button id="materialize">Send first message</button><button id="home">Home</button>
      <script type="module">
        import { installSessionHistory, setSessionHistory } from '/sessionHistory.js';
        const sessions = ['A', 'B', 'C'].map(id => ({ id, archived:false }));
        let current = null;
        window.routeState = () => ({ current, length:history.length, hash:location.hash });
        window.deleteB = () => { sessions.splice(sessions.findIndex(s => s.id === 'B'), 1); };
        const select = id => { current = id; setSessionHistory(id); };
        for (const button of document.querySelectorAll('button')) button.onclick = () => select(button.dataset.id);
        document.getElementById('new-chat').onclick = () => { current = null; setSessionHistory(null); };
        document.getElementById('materialize').onclick = () => {
          sessions.push({ id:'D', archived:false });
          current = 'D';
          setSessionHistory('D');
        };
        document.getElementById('home').onclick = () => { current = null; setSessionHistory(null); };
        installSessionHistory({
          getCurrentSessionId:() => current,
          getSessions:() => sessions,
          selectSession:select,
          showHome:() => { current = null; setSessionHistory(null, { replace:true }); },
          isReady:() => true,
        });
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const browser = await chromium.launch({ headless:true, executablePath:process.env.BROWSER_EXECUTABLE, args:['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof window.routeState === 'function');
  const initialLength = (await page.evaluate(() => history.length));

  await page.getByRole('button', { name:'A', exact:true }).click();
  await page.getByRole('button', { name:'B', exact:true }).click();
  await page.getByRole('button', { name:'C', exact:true }).click();
  const routeLength = (await page.evaluate(() => history.length));
  assert.equal(routeLength, initialLength + 3);

  const backEventWasPrevented = await page.evaluate(() => !document.dispatchEvent(new MouseEvent('auxclick', { button:3, bubbles:true, cancelable:true })));
  assert.ok(backEventWasPrevented, 'the side-button default must be suppressed');
  await page.waitForFunction(() => routeState().current === 'B');
  assert.equal((await page.evaluate(() => history.length)), routeLength, 'replaying B must not add an entry');
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('auxclick', { button:4, bubbles:true, cancelable:true })));
  await page.waitForFunction(() => routeState().current === 'C');
  assert.equal((await page.evaluate(() => history.length)), routeLength, 'forward replay must not add an entry');
  await page.goBack();
  await page.goBack();
  await page.waitForFunction(() => routeState().current === 'A');
  await page.goBack();
  await page.waitForFunction(() => routeState().current === null && routeState().hash === '');
  await page.goForward();
  await page.waitForFunction(() => routeState().current === 'A');

  await page.getByRole('button', { name:'New chat' }).click();
  await page.getByRole('button', { name:'Send first message' }).click();
  await page.waitForFunction(() => routeState().current === 'D');
  await page.goBack();
  await page.waitForFunction(() => routeState().current === null && routeState().hash === '');
  await page.goBack();
  await page.waitForFunction(() => routeState().current === 'A');
  await page.goForward();
  await page.waitForFunction(() => routeState().current === null && routeState().hash === '');
  await page.goForward();
  await page.waitForFunction(() => routeState().current === 'D');

  // A stale route to a removed session resolves to Home and sanitizes that URL.
  const staleLength = await page.evaluate(() => {
    deleteB();
    history.pushState(null, '', '#B');
    const length = history.length;
    dispatchEvent(new PopStateEvent('popstate'));
    return length;
  });
  await page.waitForFunction(() => routeState().current === null && routeState().hash === '');
  assert.equal(await page.evaluate(() => history.length), staleLength, 'deleted route is replaced by Home without a duplicate');

  const homePage = await browser.newPage();
  await homePage.goto(`http://127.0.0.1:${server.address().port}`);
  await homePage.waitForFunction(() => typeof window.routeState === 'function');
  const homeStart = await homePage.evaluate(() => history.length);
  await homePage.getByRole('button', { name:'A', exact:true }).click();
  await homePage.getByRole('button', { name:'B', exact:true }).click();
  await homePage.getByRole('button', { name:'Home', exact:true }).click();
  await homePage.waitForFunction(() => routeState().current === null && routeState().hash === '');
  assert.equal(await homePage.evaluate(() => history.length), homeStart + 3);
  await homePage.goBack();
  await homePage.waitForFunction(() => routeState().current === 'B');
  await homePage.goBack();
  await homePage.waitForFunction(() => routeState().current === 'A');
});
