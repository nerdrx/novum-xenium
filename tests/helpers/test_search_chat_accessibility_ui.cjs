const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let source = `var uiModule = { esc: value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])) };
var sessionModule = { selectSession: id => { window.selectedSession = id; } };
` + fs.readFileSync(path.join(repo, 'static/js/search-chat.js'), 'utf8')
  .replace(/^import .*;\s*$/gm, '')
  .replace(/^export function /gm, 'function ')
  .replace(/^export default searchChatModule;\s*$/m, '')
  .replace("import('./workspace.js').then(workspace => workspace.openWorkspaceBrowser())", 'Promise.resolve(window.workspaceModule).then(workspace => workspace.openWorkspaceBrowser())');
source += '\nwindow.searchChat = { init, openSearch, closeSearch, isOpen };';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.setContent(`<!doctype html><style>
      .search-overlay { position: fixed; inset: 0; display: flex; align-items: flex-start; justify-content: center; }
      .search-overlay.hidden { display: none; }
      .search-popup { width: 520px; }
      .search-results { height: 130px; overflow-y: auto; }
      .search-result-item { min-height: 40px; }
    </style>
      <nav id="sidebar"><button id="opener">Search</button><button id="sidebar-new-chat-btn">New chat</button></nav>
      <button id="user-bar-settings">Settings</button>
      <div class="search-overlay hidden" id="search-overlay"><div class="search-popup">
        <input id="search-input" placeholder="Search conversations">
        <div id="search-results" class="search-results"></div>
      </div></div>`);
    await page.addScriptTag({ content: source });
    assert.deepEqual(errors, []);
    await page.evaluate(() => {
      window.searchChat.init('');
      document.getElementById('opener').addEventListener('click', window.searchChat.openSearch);
      document.getElementById('sidebar-new-chat-btn').addEventListener('click', () => { window.newChatOpened = true; });
      document.getElementById('user-bar-settings').addEventListener('click', () => { window.settingsOpened = true; });
      window.workspaceModule = { openWorkspaceBrowser: async () => { window.workspaceOpened = true; } };
      window.requests = [];
      window.pendingResponses = {};
      window.fetch = async url => {
        window.requests.push(url);
        const query = new URL(url, 'http://fixture').searchParams.get('q');
        if (query === 'settings') return new Promise(resolve => { window.pendingResponses[query] = resolve; });
        if (query.startsWith('slow')) return new Promise(resolve => { window.pendingResponses[query] = resolve; });
        if (query === 'setting') return { ok: false };
        if (query === 'offline') throw new Error('network unavailable');
        const data = ['none', 'settings', 'files'].includes(query) ? [] : Array.from({ length: 30 }, (_, index) => ({
          session_id: 'session-1', session_name: 'Long session title', role: 'user',
          content_snippet: `Result ${index}: ${'long content '.repeat(14)}`, timestamp: '',
        }));
        return { ok: true, json: async () => data };
      };
    });
    await page.locator('#opener').click();
    const input = page.locator('#search-input');
    assert.equal(await input.getAttribute('role'), 'combobox');
    assert.equal(await input.getAttribute('aria-expanded'), 'true');
    assert.equal(await input.getAttribute('aria-controls'), 'search-results');
    assert.equal(await page.locator('[role=option]').count(), 3, 'empty query offers quick actions');
    assert.deepEqual((await page.locator('[role=option]').allTextContents()).map(text => text.trim().replace(/\s+/g, ' ')), [
      'Action New chat Start a fresh conversation',
      'Action Files & project tools Choose a project and review its files',
      'Action Settings Preferences and shortcuts',
    ]);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.newChatOpened), true, 'New chat command uses existing sidebar action');

    await page.locator('#opener').click();
    await input.fill('settings');
    await page.keyboard.press('ArrowDown');
    assert.equal(await input.getAttribute('aria-activedescendant'), 'search-option-0');
    await page.waitForFunction(() => window.requests.some(url => url.includes('q=settings')));
    await page.evaluate(() => window.pendingResponses.settings({ ok: true, json: async () => [] }));
    await page.waitForFunction(() => document.querySelector('#search-results').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('[role=option]').count(), 1, 'query filters commands alongside conversation search');
    assert.equal(await page.locator('[role=option]').getAttribute('data-action'), 'settings');
    assert.equal(await input.getAttribute('aria-activedescendant'), 'search-option-0', 'selection survives same-query results rendering');
    assert.equal(await page.locator('[role=option]').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.settingsOpened), true, 'Settings command uses existing settings action');

    await page.locator('#opener').click();
    await input.fill('setting');
    await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent.includes('search failed'));
    assert.equal(await page.locator('[role=option][data-action=settings]').count(), 1, 'failed search keeps matching quick actions');
    assert.equal(await page.locator('[role=status]').textContent(), 'Conversation search failed. Try again.');
    assert.equal(await page.locator('#search-results').getAttribute('aria-busy'), 'false');
    await page.keyboard.press('Escape');

    await page.locator('#opener').click();
    await input.fill('offline');
    await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent.includes('search failed'));
    assert.equal(await page.locator('#search-results').getAttribute('aria-busy'), 'false', 'network errors clear the busy state');
    await page.keyboard.press('Escape');

    await page.locator('#opener').click();
    await input.fill('files');
    await page.waitForTimeout(350);
    assert.equal(await page.locator('[role=option]').count(), 1);
    assert.equal(await page.locator('[role=option]').getAttribute('data-action'), 'workspace_files');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.workspaceOpened === true);

    await page.locator('#opener').click();
    await input.fill('many');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('[role=option]').count(), 30, `results rendered: ${await page.locator('#search-results').innerHTML()} requests: ${JSON.stringify(await page.evaluate(() => window.requests))} errors: ${errors.join('; ')}`);
    for (let index = 0; index < 30; index++) await page.keyboard.press('ArrowDown');
    const last = page.locator('#search-option-29');
    assert.equal(await input.getAttribute('aria-activedescendant'), 'search-option-29');
    assert.equal(await last.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('[role=option][aria-selected=true]').count(), 1);
    const visibleInList = await last.evaluate(option => {
      const list = option.parentElement;
      const optionBox = option.getBoundingClientRect();
      const listBox = list.getBoundingClientRect();
      return optionBox.top >= listBox.top && optionBox.bottom <= listBox.bottom && list.scrollTop > 0;
    });
    assert.equal(visibleInList, true, 'ArrowDown scrolls the long result list to the active option');
    assert.match(await last.getAttribute('aria-label'), /Long session title — You: Result 29/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#search-overlay').evaluate(el => el.classList.contains('hidden')), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'opener');

    await page.locator('#opener').click();
    await input.fill('slow-old');
    await page.waitForFunction(() => window.requests.some(url => url.includes('slow-old')));
    await input.fill('none');
    await page.waitForFunction(() => window.requests.some(url => url.includes('q=none')));
    await page.waitForTimeout(350);
    await page.evaluate(() => window.pendingResponses['slow-old']({ ok: true, json: async () => [{
      session_id: 'stale-session', session_name: 'Stale', role: 'user', content_snippet: 'stale result', timestamp: '',
    }] }));
    await page.waitForTimeout(50);
    assert.equal(await page.locator('[role=option]').count(), 0, 'late earlier query cannot replace newer empty results');
    assert.match(await page.locator('#search-results').textContent(), /No results found/);

    await input.fill('slow-close');
    await page.waitForFunction(() => window.requests.some(url => url.includes('slow-close')));
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.pendingResponses['slow-close']({ ok: true, json: async () => [{
      session_id: 'closed-session', session_name: 'Closed', role: 'user', content_snippet: 'late result', timestamp: '',
    }] }));
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#search-overlay').evaluate(el => el.classList.contains('hidden')), true);
    assert.equal(await page.locator('#search-results').textContent(), '', 'closed palette ignores pending response');
    assert.equal(await input.getAttribute('aria-activedescendant'), null);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#opener').click();
    assert.equal(await page.locator('#sidebar').evaluate(el => el.classList.contains('hidden')), true);
    await input.fill('many');
    await page.waitForFunction(() => document.querySelectorAll('[role=option]').length === 30);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.selectedSession), 'session-1');
    assert.equal(await page.locator('#sidebar').evaluate(el => el.classList.contains('hidden')), true, 'chat selection keeps mobile navigation collapsed');
    assert.equal(await page.locator('#search-overlay').evaluate(el => el.classList.contains('hidden')), true);
    assert.deepEqual(errors, []);
    console.log('PASS: quick actions, failed-search recovery, stable selection, scrolling, stale-response guards, Escape focus, and mobile navigation');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
