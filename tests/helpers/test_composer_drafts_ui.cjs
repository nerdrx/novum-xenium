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
  ["import { installSessionHistory, pendingChatRouteId, setPendingChatHistory, setSessionHistory } from './sessionHistory.js';", "import { installSessionHistory, pendingChatRouteId, setPendingChatHistory, setSessionHistory } from '/static/js/sessionHistory.js';"],
  ["import { applySubagentInspector, clearSubagentInspector } from './subagentInspector.js';", "import { applySubagentInspector, clearSubagentInspector } from '/stubs/subagentInspector.js';"],
  ["import { resetBrowserPreview } from './browserPreview.js';", "import { resetBrowserPreview } from '/stubs/browserPreview.js';"],
  ["import { deleteComposerDraft, getComposerDraft, getPendingChatMetadata, saveComposerDraft, transferComposerDraft } from './composerDrafts.js';", "import { deleteComposerDraft, getComposerDraft, getPendingChatMetadata, saveComposerDraft, transferComposerDraft } from '/static/js/composerDrafts.js';"],
]);
const stubs = {
  'storage.js': `const Storage={get:(k,f=null)=>localStorage.getItem(k)??f,set:(k,v)=>localStorage.setItem(k,v),remove:k=>localStorage.removeItem(k)};export default Storage;`,
  'ui.js': `export const autoResize=()=>{};export const styledPrompt=async()=>null;const ui={el:id=>document.getElementById(id),showToast:message=>window.__toastMessages.push(message),showError:console.error,scrollHistoryInstant:()=>{},isTouchInsideModal:()=>false};export default ui;`,
  'chatRenderer.js': `export default {hideWelcomeScreen(){},addMessage(){},updateSessionCostUI(){}};`,
  'providers.js': `export const providerLogo=()=>'';`,
  'modelPicker.js': `export const initModelPicker=()=>{};export const updateModelPicker=()=>{};`,
  'theme.js': `export default {};`,
  'spinner.js': `export default {};`,
  'subagentInspector.js': `export const applySubagentInspector=()=>{};export const clearSubagentInspector=()=>{};`,
  'browserPreview.js': `export const resetBrowserPreview=()=>{};`,
  'presets.js': `export default {onSessionSwitch(){}};`,
};

const html = `<!doctype html><meta charset="utf-8"><textarea id="message"></textarea><input id="incognito-toggle" type="checkbox"><section id="sessions-section"><div id="session-list"></div></section><div id="chat-history"></div><div id="current-meta"></div><div id="app-loader"></div><button class="send-btn"></button><script type="module">
  window.__toastMessages = [];
  const input = document.getElementById('message');
  if (new URLSearchParams(location.search).has('startup')) {
    input.value = 'newly typed startup text';
    window.__odysseusComposerUserEdited = true;
  }
  const sessions = (await import('/test/sessions.js')).default;
  for (const name of ['startFreshChat', 'getPendingDraftId', 'setPendingDraftIncognito', 'restorePendingChatDraft']) {
    if (typeof sessions?.[name] !== 'function') throw new Error('sessions.default missing ' + name);
  }
  window.testSessions = sessions;
  window.testDraftHelper = await import('/static/js/composerDrafts.js');
  await sessions.loadSessions();
  const requestedSession = new URLSearchParams(location.search).get('session');
  if (requestedSession === 'private-chat') sessionStorage.setItem('ody-incognito-sessions', JSON.stringify(['private-chat']));
  if (requestedSession && sessions.getCurrentSessionId() !== requestedSession) await sessions.selectSession(requestedSession, { showLoading: false });
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
    source = source.replace('let sessions = [];', `let sessions = [
      { id: 'chat-a', name: 'Chat A', message_count: 4 },
      { id: 'chat-b', name: 'Chat B', message_count: 2 },
      { id: 'private-chat', name: 'Nobody', message_count: 0 },
      { id: 'empty-materialized', name: 'Empty', model: 'model-empty', endpoint_url: '/api/endpoint-empty', endpoint_id: 'endpoint-empty', message_count: 0 },
    ];`);
    source = source.replaceAll('renderSessionList();', 'window.__renderSessionListStub?.();');
    res.setHeader('Content-Type', 'text/javascript'); return res.end(source);
  }
  if (url.pathname.startsWith('/api/history/')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ history: [], model: null, offset: 0, limit: 24, total: 0, has_more_before: false }));
  }
  if (url.pathname === '/api/sessions') {
    res.setHeader('Content-Type', 'application/json');
    if (url.searchParams.has('empty')) return res.end(JSON.stringify([]));
    return res.end(JSON.stringify([
      { id: 'chat-a', name: 'Chat A', message_count: 4 },
      { id: 'chat-b', name: 'Chat B', message_count: 2 },
      { id: 'private-chat', name: 'Nobody', message_count: 0 },
      { id: 'empty-materialized', name: 'Empty', model: 'model-empty', endpoint_url: '/api/endpoint-empty', endpoint_id: 'endpoint-empty', message_count: 0 },
    ]));
  }
  if (req.method === 'POST' && url.pathname === '/test/fail-session-create') {
    server.failNextSessionCreate = true;
    res.writeHead(204); return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/api/session') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    server.lastSessionBody = Buffer.concat(chunks).toString();
    if (server.failNextSessionCreate) {
      server.failNextSessionCreate = false;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'fixture failure' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id: 'materialized-chat' }));
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
  if (url.pathname === '/static/js/sessionHistory.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return fs.createReadStream(path.join(repo, 'static/js/sessionHistory.js')).pipe(res);
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

    await page.goto(`${origin}/?empty=1`);
    await page.waitForFunction(() => window.integrationReady);
    const blankPendingId = await page.evaluate(() => window.testSessions.startFreshChat());
    assert.equal(await page.evaluate(id => localStorage.getItem(`ody-composer-drafts:alice:${encodeURIComponent(id)}`), blankPendingId), null,
      'blank new-chat placeholders do not consume persistent draft slots');
    await input.fill('typed before choosing any model');
    assert.match(await page.evaluate(() => location.hash), /^#newchat-/,
      'typing on an empty install binds an explicit pending draft route');
    const noModelId = await page.evaluate(() => window.testSessions.getPendingDraftId());
    await page.goto(`${origin}/?empty=1#newchat-${encodeURIComponent(noModelId)}`);
    await page.waitForFunction(() => window.integrationReady);
    assert.equal(await input.inputValue(), 'typed before choosing any model',
      'pending text restores through the real empty-install bootstrap without a selected model');
    assert.equal(await page.evaluate(() => window.testSessions.getPendingChat()), null,
      'text-only pending restore does not create an unusable model-less session');

    await page.evaluate(() => {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      window.testSessions.startFreshChat();
    });
    await input.fill('pending new-chat text');
    const pendingId = await page.evaluate(() => {
      const id = window.testSessions.getPendingDraftId();
      window.testSessions.createDirectChat('/api/endpoint-one', 'model-one', 'endpoint-one');
      window.testSessions.createDirectChat('/api/endpoint-two', 'model-two', 'endpoint-two');
      return id;
    });
    assert.match(await page.evaluate(() => location.hash), /^#newchat-/,
      'pending composer has an explicit route identity');
    assert.equal(await page.evaluate(() => window.testSessions.getPendingDraftId()), pendingId,
      'model changes retain the same pending draft identity');
    await page.goto(`${origin}/#newchat-${encodeURIComponent(pendingId)}`);
    await page.waitForFunction(() => window.integrationReady);
    assert.equal(await input.inputValue(), 'pending new-chat text', 'reload restores pending new-chat text');
    assert.equal(await page.evaluate(() => window.testSessions.getPendingChat()?.modelId), 'model-two',
      'reload restores the pending model metadata');
    await page.goto(`${origin}/?startup=1#newchat-${encodeURIComponent(pendingId)}`);
    await page.waitForFunction(() => window.integrationReady);
    assert.equal(await input.inputValue(), 'newly typed startup text',
      'loadSessions bootstrap keeps newly typed startup text ahead of a stored pending draft');
    await page.goto(`${origin}/?account=bob#newchat-${encodeURIComponent(pendingId)}`);
    await page.waitForFunction(() => window.integrationReady);
    assert.equal(await input.inputValue(), '', 'pending route from another account opens blank home');
    assert.equal(await page.evaluate(() => location.hash), '', 'unknown account route is replaced with plain home');
    await page.goto(`${origin}/#newchat-${encodeURIComponent(pendingId)}`);
    await page.waitForFunction(() => window.integrationReady);
    assert.equal(await input.inputValue(), 'newly typed startup text',
      'startup edit was saved to the authenticated account draft during bootstrap');

    await page.evaluate(() => {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      window.testSessions.startFreshChat();
    });
    const freshId = await page.evaluate(() => window.testSessions.getPendingDraftId());
    assert.notEqual(freshId, pendingId, 'explicit New Chat receives a new identity');
    assert.equal(await input.inputValue(), '', 'explicit New Chat starts with an empty composer');
    await page.goBack();
    await page.waitForFunction(() => location.hash === '');
    assert.equal(await input.inputValue(), '', 'Back from pending route returns to plain home');

    const detachedId = await page.evaluate(() => window.testSessions.startFreshChat());
    await input.fill('outgoing pending draft');
    const outgoingRecord = await page.evaluate(id => localStorage.getItem(`ody-composer-drafts:alice:${encodeURIComponent(id)}`), detachedId);
    await page.evaluate(() => window.testSessions.setCurrentSessionId(null));
    await input.fill('new ephemeral composer text');
    assert.notEqual(await page.evaluate(() => window.testSessions.getPendingDraftId()), detachedId,
      'explicit null detachment allocates a different pending identity for later typing');
    assert.equal(await page.evaluate(id => localStorage.getItem(`ody-composer-drafts:alice:${encodeURIComponent(id)}`), detachedId), outgoingRecord,
      'typing after null detachment cannot overwrite the saved outgoing pending draft');

    await page.evaluate(() => window.testSessions.selectSession('empty-materialized', { showLoading: false }));
    await input.fill('text before Nobody');
    assert.notEqual(await page.evaluate(() => localStorage.getItem('ody-composer-drafts:alice:empty-materialized')), null,
      'empty materialized chat had a saved unsent draft before Nobody mode');
    await page.evaluate(() => {
      document.getElementById('incognito-toggle').checked = true;
      window.testSessions.setPendingDraftIncognito(true);
    });
    const nobodyId = await page.evaluate(() => window.testSessions.getPendingDraftId());
    assert.equal(await page.evaluate(() => window.testSessions.getCurrentSessionId()), null,
      'empty materialized chat detaches into a pending Nobody chat');
    assert.equal(await input.inputValue(), 'text before Nobody', 'Nobody conversion preserves current composer text');
    assert.equal(await page.evaluate(() => window.testSessions.getPendingChat()?.modelId), 'model-empty',
      'Nobody conversion preserves the empty chat model');
    assert.equal(await page.evaluate(() => localStorage.getItem('ody-composer-drafts:alice:empty-materialized')), null,
      'Nobody conversion removes the original persistent empty-chat draft');
    assert.equal(await page.evaluate(id => localStorage.getItem(`ody-composer-drafts:alice:${encodeURIComponent(id)}`), nobodyId), null,
      'Nobody pending text and metadata remain memory-only');
    await page.goto(`${origin}/?reload=incognito#newchat-${encodeURIComponent(nobodyId)}`);
    await page.waitForFunction(() => window.integrationReady);
    assert.equal(await input.inputValue(), '', 'Nobody pending draft does not return after reload');

    await page.evaluate(() => window.testSessions.startFreshChat());
    await input.fill('retry after create failure');
    await page.evaluate(() => window.testSessions.createDirectChat('/api/retry', 'model-retry', 'endpoint-retry'));
    await page.evaluate(() => {
      document.getElementById('incognito-toggle').checked = true;
      window.testSessions.setPendingDraftIncognito(true);
      document.getElementById('incognito-toggle').checked = false;
      window.testSessions.setPendingDraftIncognito(false);
    });
    assert.equal(await page.evaluate(id => localStorage.getItem(`ody-composer-drafts:alice:${encodeURIComponent(id)}`),
      await page.evaluate(() => window.testSessions.getPendingDraftId())), null,
      'turning Nobody off does not silently persist text entered while private');
    await page.evaluate(() => fetch('/test/fail-session-create', { method: 'POST' }));
    const retryDraftId = await page.evaluate(() => window.testSessions.getPendingDraftId());
    assert.equal(await page.evaluate(() => window.testSessions.materializePendingSession()), false,
      'failed session creation leaves the pending route unmaterialized');
    assert.equal(await input.inputValue(), 'retry after create failure', 'failed creation keeps unsent text');
    assert.equal(await page.evaluate(() => window.testSessions.getPendingDraftId()), retryDraftId,
      'failed creation keeps the same pending draft identity');
    const historyLengthBeforeMaterialize = await page.evaluate(() => history.length);
    assert.equal(await page.evaluate(() => window.testSessions.materializePendingSession()), true,
      'retry can materialize the pending chat');
    const materializedState = await page.evaluate(id => ({
      route: location.hash, historyLength: history.length,
      source: localStorage.getItem(`ody-composer-drafts:alice:${encodeURIComponent(id)}`),
    }), retryDraftId);
    assert.equal(materializedState.route, '#materialized-chat', 'accepted materialization replaces the pending route');
    assert.equal(materializedState.historyLength, historyLengthBeforeMaterialize, 'materialization replaces history rather than adding a stale pending entry');
    assert.equal(materializedState.source, null, 'materialization removes the temporary draft key');
    assert.equal(await page.evaluate(() => window.testSessions.getCurrentSessionId()), 'materialized-chat',
      'successful materialization selects the created session');
    assert.match(server.lastSessionBody, /name="name"\r\n\r\nmodel-retry /,
      'turning Nobody off makes the next session a normal model-named chat');
    assert.match(server.lastSessionBody, /name="auto_title"\r\n\r\ntrue/,
      'turning Nobody off uses normal title behavior');
    assert.equal(await page.evaluate(() => localStorage.getItem('ody-composer-drafts:alice:materialized-chat')).then(JSON.parse).then(x => x.text),
      'retry after create failure', 'successful materialization transfers the composer draft');

    await page.goto(`${origin}/?session=private-chat`);
    await page.waitForFunction(() => window.integrationReady);
    await input.fill('private text');
    const incognitoState = await page.evaluate(() => ({
      draft: window.testDraftHelper.getComposerDraft('private-chat', { accountId: 'alice', incognito: true }),
      current: window.testSessions.getCurrentSessionId(), value: document.getElementById('message').value,
      privateIds: sessionStorage.getItem('ody-incognito-sessions'),
      stored: localStorage.getItem('ody-composer-drafts:alice:private-chat'),
    }));
    assert.equal(incognitoState.draft, 'private text', 'incognito input is stored in memory');
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
