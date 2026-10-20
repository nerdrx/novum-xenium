import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url);
const productionModules = new Map(await Promise.all([
  'authState.js', 'sessions.js', 'composerDrafts.js', 'sessionHistory.js',
].map(async name => [`/static/js/${name}`, await readFile(new URL(`static/js/${name}`, root), 'utf8')])));
const moduleStubs = {
  '/static/js/storage.js': `const Storage = { get: (key, fallback = null) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }, set: (key, value) => { try { localStorage.setItem(key, value); } catch {} }, remove: key => { try { localStorage.removeItem(key); } catch {} }, getJSON: (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback)); } catch { return fallback; } }, setJSON: (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} } }; export default Storage;`,
  '/static/js/ui.js': `export const autoResize = () => {}; export const styledPrompt = async () => null; const ui = { el: id => document.getElementById(id), showError: () => {}, showToast: () => {}, styledConfirm: async () => true, scrollHistoryInstant: () => {} }; export default ui;`,
  '/static/js/chatRenderer.js': `export default { addMessage: () => null, hideWelcomeScreen: () => {} };`,
  '/static/js/providers.js': `export const providerLogo = () => '';`,
  '/static/js/modelPicker.js': `export const initModelPicker = () => {}; export const updateModelPicker = () => {};`,
  '/static/js/theme.js': `export default {};`,
  '/static/js/spinner.js': `export default {};`,
  '/static/js/subagentInspector.js': `export const applySubagentInspector = () => {}; export const clearSubagentInspector = () => {};`,
  '/static/js/browserPreview.js': `export const resetBrowserPreview = () => {};`,
  '/static/js/actionMenuOrder.js': `export const SELECT_MENU_ICON = ''; export const actionMenuRank = () => 0; export const orderActionMenuItems = items => items;`,
  '/static/js/escMenuStack.js': `export const registerEscapeLayer = () => () => {}; export const bindMenuDismiss = () => {};`,
};

async function runStartup({ browser, auth, cachedUser, draftAccount, prefetch, storageDenied = false, storageWriteDenied = false, fastDeadline = false, freshBeforeAuth = false, crossTabIdentity = null, externalStorageEvent = undefined }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let sessionsRequests = 0;
  let authRequests = 0;
  let releaseAuth;
  const authRelease = new Promise(resolve => { releaseAuth = resolve; });
  await page.addInitScript(({ cachedUser, draftAccount, prefetch, storageDenied, storageWriteDenied, fastDeadline, holdAuthBody }) => {
    if (cachedUser !== null) localStorage.setItem('odysseus-auth-user', cachedUser);
    localStorage.setItem(`ody-composer-drafts:${encodeURIComponent(draftAccount)}:pending%3Afixture`, JSON.stringify({
      text: `${draftAccount} private draft`,
      pending: { url: `https://${draftAccount}.example`, modelId: `${draftAccount}/model`, endpointId: `${draftAccount}-endpoint` },
    }));
    if (prefetch) sessionStorage.setItem('ody-prefetch-sessions', '[{"id":"private-prefetch"}]');
    if (storageDenied) {
      for (const method of ['getItem', 'setItem', 'removeItem', 'key']) {
        Object.defineProperty(Storage.prototype, method, { value() { throw new DOMException('denied', 'SecurityError'); } });
      }
      Object.defineProperty(Storage.prototype, 'length', { get() { throw new DOMException('denied', 'SecurityError'); } });
    }
    if (storageWriteDenied) {
      const setItem = Storage.prototype.setItem;
      Object.defineProperty(Storage.prototype, 'setItem', { value(key, value) {
        if (key === 'odysseus-auth-user') throw new DOMException('denied', 'QuotaExceededError');
        return setItem.call(this, key, value);
      } });
    }
    if (fastDeadline) {
      const original = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => original(callback, delay === 15000 ? 30 : delay, ...args);
    }
    if (holdAuthBody) {
      const originalFetch = window.fetch.bind(window);
      let held = false;
      window.fetch = (input, init) => {
        if (!held && String(input).includes('/api/auth/status')) {
          held = true;
          return Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
        }
        return originalFetch(input, init);
      };
    }
  }, { cachedUser, draftAccount, prefetch, storageDenied, storageWriteDenied, fastDeadline, holdAuthBody: auth === 'body-timeout-retry' });
  await page.route('http://auth-fixture.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><main id="chat-history"></main><textarea id="message"></textarea><section id="session-list"></section><section id="sessions-section"></section><div id="app-loader"></div><input id="incognito-toggle" type="checkbox"><div id="current-meta"></div><script type="module">import * as sessions from '/static/js/sessions.js'; import { authStatePromise } from '/static/js/authState.js'; window.sessions = sessions; window.authStatePromise = authStatePromise;</script>` });
    if (url.pathname === '/api/auth/status') {
      authRequests++;
      if (freshBeforeAuth) await authRelease;
      if (auth === 'network-error') return route.abort();
      if (auth === 'hold') return new Promise(() => {});
      if (auth === 'hang' || (auth === 'timeout-retry' && authRequests === 1)) return new Promise(() => {});
      if (auth === 'timeout-retry' || auth === 'body-timeout-retry') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: true, authenticated: true, username: 'bob' }) });
      return route.fulfill({ status: auth.status || 200, contentType: 'application/json', body: JSON.stringify(auth.body) });
    }
    if (url.pathname === '/api/sessions') {
      sessionsRequests++;
      return route.fulfill({ contentType: 'application/json', body: '[]' });
    }
    const source = productionModules.get(url.pathname) ?? moduleStubs[url.pathname];
    return source ? route.fulfill({ contentType: 'text/javascript', body: source }) : route.abort();
  });
  await page.goto('http://auth-fixture.test/#newchat-pending%3Afixture');
  if (freshBeforeAuth) {
    await page.waitForFunction(() => !!window.sessions);
    await page.evaluate(() => {
      window.sessions.startFreshChat();
      window.sessions.createDirectChat('http://new-user-model.test', 'new-model', 'new-endpoint');
      document.getElementById('message').value = 'New text typed before verification';
      document.getElementById('message').dispatchEvent(new Event('input', { bubbles: true }));
      window.provisionalDraftId = window.sessions.getPendingDraftId();
    });
    if (externalStorageEvent !== undefined) {
      await page.evaluate(() => {
        window.externalIdentityEvent = new Promise(resolve => {
          window.addEventListener('storage', event => {
            if (event.key === null || event.key === 'odysseus-auth-user') resolve();
          }, { once: true });
        });
      });
      const other = await page.context().newPage();
      await other.route('http://auth-fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>second tab</title>' }));
      await other.goto('http://auth-fixture.test/');
      await other.evaluate(identity => {
        if (identity === null) localStorage.clear();
        else localStorage.setItem('odysseus-auth-user', identity);
        localStorage.setItem('newtab-state', 'preserve-me');
      }, externalStorageEvent);
      await page.evaluate(async () => window.externalIdentityEvent);
      await other.close();
    }
    releaseAuth();
  }
  if (auth === 'hold') {
    await page.waitForFunction(() => !!window.sessions);
    const early = await page.evaluate(() => {
      document.getElementById('message').value = 'Typed before auth';
      const restored = window.sessions.restorePendingChatDraft('pending:fixture');
      return { restored, text: document.getElementById('message').value, pending: window.sessions.getPendingChat(), draftId: window.sessions.getPendingDraftId() };
    });
    await page.close();
    await context.close();
    return early;
  }
  const result = await page.evaluate(async crossTabIdentity => {
    await window.authStatePromise;
    if (crossTabIdentity !== null) localStorage.setItem('odysseus-auth-user', crossTabIdentity);
    const loaded = await window.sessions.loadSessions();
    const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
    return {
      loaded,
      text: document.getElementById('message').value,
      pending: window.sessions.getPendingChat(),
      pendingId: window.sessions.getPendingDraftId(),
      provisionalDraftId: window.provisionalDraftId,
      identity: read('odysseus-auth-user'),
      newTabMarker: read('newtab-state'),
      aliceDraft: read('ody-composer-drafts:alice:pending%3Afixture'),
      anonymousDraft: read('ody-composer-drafts::pending%3Afixture'),
      prefetch: (() => { try { return sessionStorage.getItem('ody-prefetch-sessions'); } catch { return null; } })(),
      authStatus: await window.authStatePromise,
    };
  }, crossTabIdentity);
  result.sessionsRequests = sessionsRequests;
  result.authRequests = authRequests;
  await page.close();
  await context.close();
  return result;
}

test('verified account switch clears old draft before production sessions module can restore it', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const state = await runStartup({ browser, cachedUser: 'alice', draftAccount: 'alice', auth: { body: { configured: true, authenticated: true, username: 'bob' } } });
    assert.equal(state.loaded, true);
    assert.equal(state.identity, 'bob');
    assert.equal(state.text, '');
    assert.equal(state.pending, null);
    assert.equal(state.aliceDraft, null);
    assert.equal(state.sessionsRequests, 1);
  } finally { await browser.close(); }
});

test('cross-tab identity mismatch blocks private draft and prefetch hydration without rewriting the marker', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const state = await runStartup({
      browser, cachedUser: 'alice', draftAccount: 'alice', prefetch: true,
      crossTabIdentity: 'bob',
      auth: { body: { configured: true, authenticated: true, username: 'alice' } },
    });
    assert.equal(state.authStatus.switched, true);
    assert.equal(state.identity, 'bob', 'old tab must not overwrite the newer shared identity marker');
    assert.equal(state.text, '');
    assert.equal(state.pending, null);
    assert.ok(state.aliceDraft, 'the old draft remains stored and untouched');
    assert.equal(state.prefetch, '[{"id":"private-prefetch"}]');
  } finally { await browser.close(); }
});

test('held auth response cannot overwrite a newer cross-tab identity or clear marker', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    for (const identity of ['bob', null]) {
      const state = await runStartup({
        browser, cachedUser: 'alice', draftAccount: 'alice', freshBeforeAuth: true,
        externalStorageEvent: identity,
        auth: { body: { configured: true, authenticated: true, username: 'alice' } },
      });
      assert.equal(state.authStatus.switched, true, `external ${identity ?? 'clear'} event must latch`);
      assert.equal(state.identity, identity, 'late Alice response must not rewrite the newer marker');
      assert.equal(state.newTabMarker, 'preserve-me', 'late response must not clear newer tab storage');
      assert.equal(state.text, 'New text typed before verification');
    }
  } finally { await browser.close(); }
});

test('write-denied identity storage does not turn a missing marker into an account switch', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const state = await runStartup({
      browser, cachedUser: null, draftAccount: '', storageWriteDenied: true,
      auth: { body: { configured: true, authenticated: true, username: 'alice' } },
    });
    assert.equal(state.authStatus.verified, true);
    assert.equal(state.authStatus.storageAvailable, false);
    assert.equal(state.authStatus.switched, false);
    assert.equal(state.authStatus.identity, 'alice');
    assert.equal(state.identity, null, 'write denial leaves the marker absent');
  } finally { await browser.close(); }
});

test('same-user auth restores its pending draft through production modules', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const state = await runStartup({ browser, cachedUser: 'alice', draftAccount: 'alice', auth: { body: { configured: true, authenticated: true, username: 'alice' } } });
    assert.equal(state.text, 'alice private draft');
    assert.equal(state.pending?.url, 'https://alice.example');
    assert.equal(state.identity, 'alice');
  } finally { await browser.close(); }
});

test('explicit anonymous auth preserves anonymous draft state without a prior account', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const state = await runStartup({ browser, cachedUser: null, draftAccount: '', auth: { body: { configured: false, authenticated: false, username: null } } });
    assert.equal(state.text, '');
    assert.equal(state.pending, null);
    assert.equal(state.identity, '');
    assert.ok(state.anonymousDraft, 'legacy anonymous draft key remains untouched');
  } finally { await browser.close(); }
});

test('unknown auth retains private storage, skips it, and still permits ordinary session API load', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const state = await runStartup({ browser, cachedUser: 'alice', draftAccount: 'alice', prefetch: true, auth: { status: 401, body: { detail: 'login required' } } });
    assert.equal(state.loaded, true);
    assert.equal(state.identity, 'alice');
    assert.equal(state.text, '');
    assert.equal(state.aliceDraft !== null, true);
    assert.equal(state.prefetch, '[{"id":"private-prefetch"}]');
    assert.equal(state.sessionsRequests, 1);
  } finally { await browser.close(); }
});

test('configured anonymous auth isolates cached signed-in state', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const state = await runStartup({ browser, cachedUser: 'alice', draftAccount: 'alice', auth: { body: { configured: false, authenticated: false, username: null } } });
    assert.equal(state.identity, '');
    assert.equal(state.text, '');
    assert.equal(state.aliceDraft, null);
  } finally { await browser.close(); }
});

test('hung auth status is bounded and a later auth check can verify identity', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const started = Date.now();
    const state = await runStartup({ browser, cachedUser: 'alice', draftAccount: 'alice', prefetch: true, fastDeadline: true, auth: 'timeout-retry' });
    assert.ok(Date.now() - started < 5000, 'fake 15s deadline did not release the auth waiter');
    assert.equal(state.loaded, true);
    assert.equal(state.identity, 'bob');
    assert.equal(state.text, '');
    assert.equal(state.aliceDraft, null);
    assert.equal(state.authRequests, 2);
    assert.equal(state.sessionsRequests, 1);
  } finally { await browser.close(); }
});

test('auth deadline also releases a held JSON body before a successful retry', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const state = await runStartup({ browser, cachedUser: 'alice', draftAccount: 'alice', fastDeadline: true, auth: 'body-timeout-retry' });
    assert.equal(state.authStatus.verified, false, 'initial body waiter expires without trusting partial data');
    assert.equal(state.loaded, true);
    assert.equal(state.identity, 'bob');
    assert.equal(state.text, '');
    assert.equal(state.aliceDraft, null);
    assert.equal(state.authRequests, 1, 'retry reaches the server after the synthetic held body');
  } finally { await browser.close(); }
});

test('verified identity stays usable when browser storage is denied, without hydrating private cache', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const state = await runStartup({ browser, cachedUser: 'alice', draftAccount: 'alice', storageDenied: true, auth: { body: { configured: true, authenticated: true, username: 'bob' } } });
    assert.equal(state.authStatus.verified, true);
    assert.equal(state.authStatus.storageAvailable, false);
    assert.equal(state.loaded, true);
    assert.equal(state.text, '');
    assert.equal(state.sessionsRequests, 1);
  } finally { await browser.close(); }
});

test('direct pending-draft restore before auth cannot read cached account state', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const state = await runStartup({ browser, cachedUser: 'alice', draftAccount: 'alice', auth: 'hold' });
    assert.equal(state.restored, false);
    assert.equal(state.text, 'Typed before auth');
    assert.equal(state.pending, null);
    assert.equal(state.draftId, '');
  } finally { await browser.close(); }
});

test('a new draft typed during identity verification survives same-user and changed-user hydration', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    for (const username of ['alice', 'bob']) {
      const state = await runStartup({ browser, cachedUser: 'alice', draftAccount: 'alice', freshBeforeAuth: true,
        auth: { body: { configured: true, authenticated: true, username } } });
      assert.equal(state.text, 'New text typed before verification');
      assert.equal(state.pendingId, state.provisionalDraftId);
      assert.equal(state.pending?.url, 'http://new-user-model.test');
      assert.equal(state.pending?.modelId, 'new-model');
      assert.equal(state.identity, username);
    }
  } finally { await browser.close(); }
});
