// Exercise the shipped sessions and composer draft modules in headless Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const imports = new Map([
  ["import Storage from './storage.js';", "import Storage from '/stubs/storage.js';"],
  ["import uiModule, { autoResize, styledPrompt } from './ui.js';", "import uiModule, { autoResize, styledPrompt } from '/stubs/ui.js';"],
  ["import chatRenderer from './chatRenderer.js?v=20261007toolstatus1';", "import chatRenderer from '/stubs/chatRenderer.js';"],
  ["import { providerLogo } from './providers.js';", "import { providerLogo } from '/stubs/providers.js';"],
  ["import { initModelPicker, updateModelPicker } from './modelPicker.js?v=20260722ctxheader1';", "import { initModelPicker, updateModelPicker } from '/stubs/modelPicker.js';"],
  ["import themeModule from './theme.js';", "import themeModule from '/stubs/theme.js';"],
  ["import spinnerModule from './spinner.js';", "import spinnerModule from '/stubs/spinner.js';"],
  ["import { installSessionHistory, setSessionHistory } from './sessionHistory.js';", "import { installSessionHistory, setSessionHistory } from '/stubs/sessionHistory.js';"],
  ["import { applySubagentInspector, clearSubagentInspector } from './subagentInspector.js';", "import { applySubagentInspector, clearSubagentInspector } from '/stubs/subagentInspector.js';"],
  ["import { resetBrowserPreview } from './browserPreview.js';", "import { resetBrowserPreview } from '/stubs/browserPreview.js';"],
  ["import { deleteComposerDraft, getComposerDraft, saveComposerDraft } from './composerDrafts.js';", "import { deleteComposerDraft, getComposerDraft, saveComposerDraft } from '/static/js/composerDrafts.js';"],
]);
const stubs = {
  'storage.js': `const Storage={get:(k,f=null)=>localStorage.getItem(k)??f,set:(k,v)=>localStorage.setItem(k,v),remove:k=>localStorage.removeItem(k)};export default Storage;`,
  'ui.js': `export const autoResize=()=>{};export const styledPrompt=async()=>null;const ui={el:id=>document.getElementById(id),showToast:message=>window.__toastMessages.push(message),showError:console.error,scrollHistoryInstant:()=>{},isTouchInsideModal:()=>false};export default ui;`,
  'chatRenderer.js': `export default {hideWelcomeScreen(){},addMessage(){},updateSessionCostUI(){}};`,
  'providers.js': `export const providerLogo=()=>'';`,
  'modelPicker.js': `export const initModelPicker=()=>{};export const updateModelPicker=()=>{};`,
  'theme.js': `export default {};`,
  'spinner.js': `export default {};`,
  'sessionHistory.js': `export const installSessionHistory=()=>()=>{};export const setSessionHistory=()=>{};`,
  'subagentInspector.js': `export const applySubagentInspector=()=>{};export const clearSubagentInspector=()=>{};`,
  'browserPreview.js': `export const resetBrowserPreview=()=>{};`,
  'presets.js': `export default {onSessionSwitch(){}};`,
};

const html = `<!doctype html><meta charset="utf-8"><textarea id="message"></textarea><div id="chat-history"></div><div id="current-meta"></div><div id="app-loader"></div><button class="send-btn"></button><script type="module">
  window.__toastMessages = [];
  const input = document.getElementById('message');
  if (new URLSearchParams(location.search).has('startup')) {
    input.value = 'newly typed startup text';
    window.__odysseusComposerUserEdited = true;
  }
  const sessions = await import('/test/sessions.js');
  window.testSessions = sessions;
  await sessions.selectSession(new URLSearchParams(location.search).get('session'), { showLoading: false });
  window.integrationReady = true;
</script>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname.startsWith('/stubs/')) {
    const body = stubs[path.basename(url.pathname)];
    if (!body) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'text/javascript'); return res.end(body);
  }
  if (url.pathname === '/test/sessions.js') {
    let source = fs.readFileSync(path.join(repo, 'static/js/sessions.js'), 'utf8');
    for (const [before, after] of imports) {
      assert.ok(source.includes(before), `missing sessions import: ${before}`);
      source = source.replace(before, after);
    }
    res.setHeader('Content-Type', 'text/javascript'); return res.end(source);
  }
  if (url.pathname.startsWith('/api/history/')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ history: [], model: null, offset: 0, limit: 24, total: 0, has_more_before: false }));
  }
  if (req.method === 'DELETE' && url.pathname === '/api/session/fail-delete') {
    res.writeHead(500); return res.end();
  }
  if (req.method === 'DELETE' && url.pathname === '/api/session/delayed-delete') {
    await new Promise(resolve => setTimeout(resolve, 150));
    res.writeHead(204); return res.end();
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/session/')) {
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/static/js/composerDrafts.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return fs.createReadStream(path.join(repo, 'static/js/composerDrafts.js')).pipe(res);
  }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('odysseus-auth-user', new URL(location.href).searchParams.get('account') || 'alice');
      if (!localStorage.getItem('__composer_draft_test_seeded')) {
        localStorage.setItem('ody-composer-drafts:alice:chat-a', JSON.stringify({ text: 'saved A' }));
        localStorage.setItem('ody-composer-drafts:alice:chat-b', JSON.stringify({ text: 'saved B' }));
        localStorage.setItem('__composer_draft_test_seeded', '1');
      }
      sessionStorage.setItem('ody-incognito-sessions', JSON.stringify(['private-chat']));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}/?session=chat-a`);
    await page.waitForFunction(() => window.integrationReady);
    const input = page.locator('#message');
    assert.equal(await input.inputValue(), 'saved A', 'stored draft restores for the selected chat');
    await input.fill('new A');
    await page.evaluate(() => window.testSessions.selectSession('chat-b', { showLoading: false }));
    assert.equal(await input.inputValue(), 'saved B', 'switch restores B draft');
    await input.fill('new B');
    await page.evaluate(() => window.testSessions.selectSession('chat-a', { showLoading: false }));
    assert.equal(await input.inputValue(), 'new A', 'switch back restores current A draft');
    await page.goto(`${origin}/?session=chat-b`);
    await page.waitForFunction(() => window.integrationReady);
    assert.equal(await input.inputValue(), 'new B', 'page reload restores the latest B draft');

    await page.goto(`${origin}/?session=chat-a&startup=1`);
    await page.waitForFunction(() => window.integrationReady);
    assert.equal(await input.inputValue(), 'newly typed startup text', 'current startup typing wins over an older saved draft');

    await page.goto(`${origin}/?session=private-chat`);
    await page.waitForFunction(() => window.integrationReady);
    await input.fill('private text');
    await page.evaluate(() => window.testSessions.selectSession('chat-a', { showLoading: false }));
    await page.evaluate(() => window.testSessions.selectSession('private-chat', { showLoading: false }));
    assert.equal(await input.inputValue(), 'private text', 'incognito text can stay in page memory while navigating');
    await page.goto(`${origin}/?session=private-chat`);
    await page.waitForFunction(() => window.integrationReady);
    assert.equal(await input.inputValue(), '', 'incognito draft is absent after a page reload');

    await page.evaluate(() => window.testSessions.selectSession('large-chat', { showLoading: false }));
    const oversized = 'x'.repeat(21000);
    await input.fill(oversized);
    assert.equal(await page.evaluate(() => window.__toastMessages.some(message => message.includes('too large'))), true,
      'oversized draft shows a visible persistence warning');
    await page.evaluate(() => window.testSessions.selectSession('chat-a', { showLoading: false }));
    await page.evaluate(() => window.testSessions.selectSession('large-chat', { showLoading: false }));
    assert.equal(await input.inputValue(), oversized, 'oversized draft stays intact during this page session');
    await page.goto(`${origin}/?session=large-chat`);
    await page.waitForFunction(() => window.integrationReady);
    assert.equal(await input.inputValue(), '', 'oversized draft is not falsely presented as persisted after reload');

    await page.evaluate(() => localStorage.setItem('ody-composer-drafts:alice:fail-delete', JSON.stringify({ text: 'retain this draft' })));
    await page.evaluate(() => window.testSessions.selectSession('delete-me', { showLoading: false }));
    await input.fill('delete this draft');
    await page.evaluate(async () => {
      await window.testSessions.deleteSessionById('delete-me');
      await window.testSessions.selectSession('chat-a', { showLoading: false });
      await window.testSessions.deleteSessionById('fail-delete');
    });
    assert.equal(await page.evaluate(() => localStorage.getItem('ody-composer-drafts:alice:delete-me')), null,
      'switch after current-chat deletion cannot recreate its draft');
    assert.notEqual(await page.evaluate(() => localStorage.getItem('ody-composer-drafts:alice:fail-delete')), null,
      'failed chat deletion retains its saved draft');

    const deletingTab = await context.newPage();
    const typingTab = await context.newPage();
    const otherAccountTab = await context.newPage();
    await deletingTab.goto(`${origin}/?session=multi-tab-delete`);
    await typingTab.goto(`${origin}/?session=multi-tab-delete`);
    await otherAccountTab.goto(`${origin}/?session=multi-tab-delete&account=bob`);
    await Promise.all([
      deletingTab.waitForFunction(() => window.integrationReady),
      typingTab.waitForFunction(() => window.integrationReady),
      otherAccountTab.waitForFunction(() => window.integrationReady),
    ]);
    await typingTab.locator('#message').fill('stale tab draft');
    await otherAccountTab.locator('#message').fill('bob draft');
    assert.notEqual(await otherAccountTab.evaluate(() => localStorage.getItem('ody-composer-drafts:bob:multi-tab-delete')), null,
      'other account draft setup succeeds');
    // Auth identity is shared localStorage in this app, so restore Alice as
    // the deleting tab's active account before exercising the broadcast.
    await deletingTab.evaluate(() => localStorage.setItem('odysseus-auth-user', 'alice'));
    await deletingTab.evaluate(async () => window.testSessions.deleteSessionById('multi-tab-delete'));
    await typingTab.waitForFunction(() => localStorage.getItem('ody-composer-drafts:alice:multi-tab-delete') === null);
    await typingTab.locator('#message').fill('typing after deletion');
    assert.equal(await typingTab.evaluate(() => localStorage.getItem('ody-composer-drafts:alice:multi-tab-delete')), null,
      'successful deletion invalidates a stale tab and blocks later draft saves');
    assert.notEqual(await otherAccountTab.evaluate(() => localStorage.getItem('ody-composer-drafts:bob:multi-tab-delete')), null,
      'deletion invalidation is scoped to the authenticated account');

    await deletingTab.goto(`${origin}/?session=fail-delete`);
    await typingTab.goto(`${origin}/?session=fail-delete`);
    await Promise.all([
      deletingTab.waitForFunction(() => window.integrationReady),
      typingTab.waitForFunction(() => window.integrationReady),
    ]);
    await deletingTab.evaluate(async () => window.testSessions.deleteSessionById('fail-delete'));
    await typingTab.locator('#message').fill('still editable after failed delete');
    assert.notEqual(await typingTab.evaluate(() => localStorage.getItem('ody-composer-drafts:alice:fail-delete')), null,
      'failed deletion does not invalidate another tab draft');

    await page.evaluate(() => window.testSessions.selectSession('delayed-delete', { showLoading: false }));
    await input.fill('old chat text');
    await page.evaluate(() => { window.deletePending = window.testSessions.deleteSessionById('delayed-delete'); });
    await page.evaluate(() => window.testSessions.selectSession('chat-b', { showLoading: false }));
    await input.fill('new chat text');
    await page.evaluate(() => window.deletePending);
    assert.equal(await input.inputValue(), 'new chat text', 'late deletion does not clear the newly selected chat composer');
    assert.deepEqual(errors, []);
    await deletingTab.close();
    await typingTab.close();
    await otherAccountTab.close();
    await context.close();
    console.log('PASS: composer drafts session wiring');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
