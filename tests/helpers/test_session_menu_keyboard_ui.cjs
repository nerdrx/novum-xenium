// Session row action menu should open from Enter without also navigating chats.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let failRenameOnce = true;
let nextRenameDelay = 0;
const html = `<!doctype html><meta charset="utf-8"><body>
<div id="toast"></div><section id="sessions-section"><div id="session-list"></div></section>
<div id="chat-history"></div><div id="current-meta"></div>
<script type="module">import * as sessions from '/static/js/sessions.js';
window.sessionModule = sessions; window.fixtureReady = true;
window.__setSessionFixture([{ id: 'one', name: 'One', model: 'fixture/model', created_at: new Date().toISOString() }]);
</script></body>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/__delay-rename') {
    nextRenameDelay = Math.min(2000, Number(url.searchParams.get('ms')) || 0);
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/session/one' && req.method === 'PATCH') {
    const delay = nextRenameDelay;
    nextRenameDelay = 0;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (failRenameOnce) {
      failRenameOnce = false;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'fixture unavailable' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (file === path.join(repo, 'static/js/sessions.js')) {
    const source = fs.readFileSync(file, 'utf8').replace('let sessions = [];',
      "let sessions = []; window.__setSessionFixture = (items) => { sessions = items; renderSessionList(); };");
    return res.end(source);
  }
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('.session-menu-btn'));
    const renderClickListeners = await page.evaluate(async () => {
      const original = document.addEventListener;
      let added = 0;
      document.addEventListener = function(type, listener, options) {
        if (type === 'click') added += 1;
        return original.call(this, type, listener, options);
      };
      for (let i = 0; i < 6; i++) window.__setSessionFixture([
        { id: 'one', name: `One ${i}`, model: 'fixture/model', folder: 'Work', created_at: new Date().toISOString() },
      ]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.addEventListener = original;
      document.querySelectorAll('.session-dropdown, .session-folder-submenu').forEach(el => el.remove());
      return added;
    });
    assert.equal(renderClickListeners, 0, 'rendering folder menus must not retain one document click listener per submenu');
    await page.evaluate(async () => {
      window.__setSessionFixture([
      { id: 'one', name: 'One', model: 'fixture/model', created_at: new Date().toISOString() },
      ]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const menuButton = page.locator('.session-menu-btn');
    await menuButton.focus();
    await menuButton.press('Enter');
    const result = await page.evaluate(() => ({
      display: document.querySelector('.session-dropdown')?.style.display,
      dropdownCount: document.querySelectorAll('.session-dropdown').length,
      rowCount: document.querySelectorAll('.session-menu-btn').length,
      selected: window.sessionModule.getCurrentSessionId(),
    }));
    assert.equal(result.display, 'block', `Enter should open menu (actual ${JSON.stringify(result)})`);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('dropdown-item-compact')), true,
      'keyboard opening should focus the first action');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.session-dropdown').evaluate(el => el.style.display), 'none');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('session-menu-btn')), true,
      'Escape should return focus to the menu trigger');
    assert.equal(await menuButton.getAttribute('aria-expanded'), 'false');

    // Pointer flow still opens the dropdown and its Rename action still enters
    // inline editing; Escape cancels without sending a PATCH.
    await menuButton.click();
    assert.equal(await page.locator('.session-dropdown').evaluate(el => el.style.display), 'block');
    await page.locator('.session-dropdown .dropdown-item-compact').filter({ hasText: 'Rename' }).click();
    assert.equal(await page.locator('.session-rename-input').count(), 1);
    await page.locator('.session-rename-input').press('Escape');

    // A failed rename keeps the proposed title available for retry; success
    // then persists and updates the visible title.
    await menuButton.click();
    await page.locator('.session-dropdown .dropdown-item-compact').filter({ hasText: 'Rename' }).click();
    await page.locator('.session-rename-input').fill('Unsaved title');
    const renameResponse = page.waitForResponse(response => response.url().endsWith('/api/session/one') && response.request().method() === 'PATCH');
    await page.locator('.session-rename-input').press('Enter');
    assert.equal((await renameResponse).status(), 503);
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Could not rename chat'));
    assert.equal(await page.locator('.session-rename-input').inputValue(), 'Unsaved title',
      'failed rename should preserve the typed title for retry');
    assert.equal(await page.evaluate(() => window.sessionModule.getSessions()[0].name), 'One',
      'failed rename must leave the local session title unchanged');
    const retryResponse = page.waitForResponse(response => response.url().endsWith('/api/session/one') && response.request().method() === 'PATCH');
    await page.locator('.session-rename-input').press('Enter');
    assert.equal((await retryResponse).status(), 200);
    await page.waitForFunction(() => document.querySelector('.list-item[data-session-id="one"] .grow')?.textContent === 'Unsaved title · model');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Renamed'));

    // A delayed request commits only its captured title and preserves any
    // newer draft typed while pending. Repeated Enter must not duplicate PATCH.
    await menuButton.click();
    await page.locator('.session-dropdown .dropdown-item-compact').filter({ hasText: 'Rename' }).click();
    const renameInput = page.locator('.session-rename-input');
    await renameInput.fill('First pending title');
    await page.evaluate(() => fetch('/__delay-rename?ms=700'));
    const pendingRequest = page.waitForRequest(request => request.url().endsWith('/api/session/one') && request.method() === 'PATCH');
    await renameInput.press('Enter');
    await pendingRequest;
    await renameInput.fill('Newer title');
    const duplicateRequest = page.waitForRequest(request => request.url().endsWith('/api/session/one') && request.method() === 'PATCH', { timeout: 250 }).catch(() => null);
    await renameInput.press('Enter');
    assert.equal(await duplicateRequest, null, 'Enter during an in-flight rename must not send a duplicate PATCH');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Earlier title saved'));
    assert.equal(await renameInput.inputValue(), 'Newer title', 'late success must preserve the newer draft');
    assert.equal(await page.evaluate(() => window.sessionModule.getSessions()[0].name), 'First pending title');
    const latestResponse = page.waitForResponse(response => response.url().endsWith('/api/session/one') && response.request().method() === 'PATCH');
    await renameInput.press('Enter');
    assert.equal((await latestResponse).status(), 200);
    await page.waitForFunction(() => document.querySelector('.list-item[data-session-id="one"] .grow')?.textContent === 'Newer title · model');

    // Escape after Enter closes the editor while the already-submitted save is
    // pending. Completion may update the title, but must not reopen the input.
    await menuButton.click();
    await page.locator('.session-dropdown .dropdown-item-compact').filter({ hasText: 'Rename' }).click();
    await page.locator('.session-rename-input').fill('Saved before Escape');
    await page.evaluate(() => fetch('/__delay-rename?ms=500'));
    const escapePending = page.waitForRequest(request => request.url().endsWith('/api/session/one') && request.method() === 'PATCH');
    await page.locator('.session-rename-input').press('Enter');
    await escapePending;
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.list-item[data-session-id="one"] .grow')?.textContent === 'Saved before Escape · model');
    assert.equal(await page.locator('.session-rename-input').count(), 0, 'late completion must not reopen an editor dismissed with Escape');
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => window.sessionModule.getCurrentSessionId()), null,
      'activating session actions must not select the row chat');
    console.log('PASS: session action keyboard navigation and delayed rename race recovery');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
