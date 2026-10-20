const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const held = new Map();
let nextDefaultMode = '';
let nextVetMode = '';
let defaultRequests = 0;
let holdNextAuth = false;
let heldAuthResponse = null;
let nextAuthStatus = null;
const chatPosts = [];
const groupPosts = [];
let browser;
let context;
let origin;
const html = `<!doctype html><meta charset="utf-8">
<div class="list-item active-session" data-session-id="synthetic-chat"></div>
<button id="mode-chat-btn"></button><textarea id="message"></textarea><div id="attach-strip"></div>
<input id="file-input" type="file" multiple><input id="incognito-toggle" type="checkbox">
<input id="web-toggle" type="checkbox"><input id="research-toggle" type="checkbox"><input id="bash-toggle" type="checkbox">
<button id="research-toggle-btn"></button><div class="chat-input-right"><button class="mode-toggle"></button></div><button id="workspace-indicator-btn"><span id="workspace-indicator-name"></span><span class="tool-indicator-x"></span></button>
<button id="overflow-workspace-btn"></button><div id="chat-history"></div><button class="send-btn"></button><div id="toast"></div>
<script type="module">
import chat from '/static/js/chat.js';
import sessions from '/static/js/sessions.js';
import * as workspace from '/static/js/workspace.js';
import group from '/static/js/group.js';
import Storage from '/static/js/storage.js';
window.modulesReady = Promise.all([chat, sessions]).then(() => {
  window.testModules = { chat, sessions, workspace, group, Storage };
});
</script>`;
const authProofHtml = `<!doctype html><meta charset="utf-8">
<button id="workspace-indicator-btn"><span id="workspace-indicator-name"></span></button><button id="overflow-workspace-btn"></button>
<div id="toast"></div>
<script type="module">
import workspace from '/static/js/workspace.js';
import { authStatePromise } from '/static/js/authState.js';
workspace.initWorkspace();
window.authProof = { workspace, authStatePromise };
</script>`;

function holdResponse(res, key, mode) {
  if (mode === 'body') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"ok":');
  }
  held.set(key, res);
  res.on('close', () => held.delete(key));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  if (url.pathname === '/auth-proof') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(authProofHtml);
  }
  if (url.pathname === '/api/auth/status') {
    if (holdNextAuth) {
      holdNextAuth = false;
      heldAuthResponse = res;
      res.on('close', () => { if (heldAuthResponse === res) heldAuthResponse = null; });
      return;
    }
    const data = nextAuthStatus || { configured: false, authenticated: false, username: null };
    nextAuthStatus = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  }
  if (url.pathname === '/__release-auth') {
    if (!heldAuthResponse) return res.writeHead(404).end();
    const response = heldAuthResponse;
    heldAuthResponse = null;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(url.searchParams.get('valid') === 'false'
      ? JSON.stringify({ configured: true, authenticated: false, username: null })
      : JSON.stringify({ configured: true, authenticated: true, username: url.searchParams.get('identity') }));
    return res.writeHead(204).end();
  }
  if (url.pathname === '/__release') {
    const key = url.searchParams.get('key');
    const response = held.get(key);
    if (!response) return res.writeHead(404).end();
    held.delete(key);
    const vetPath = key.startsWith('vet:') ? key.slice(4) : '';
    const path = key.startsWith('default-') ? `/synthetic/${key}` : `/canonical${vetPath}`;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, path }));
    return res.writeHead(204).end();
  }
  if (url.pathname === '/api/workspace/default') {
    const requestNo = ++defaultRequests;
    const mode = nextDefaultMode;
    nextDefaultMode = '';
    const key = `default-${requestNo}`;
    if (mode) return holdResponse(res, key, mode);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, path: `/synthetic/default-${requestNo}` }));
  }
  if (url.pathname === '/api/workspace/vet') {
    const selected = url.searchParams.get('path') || '';
    const mode = nextVetMode;
    nextVetMode = '';
    if (mode) return holdResponse(res, `vet:${selected}`, mode);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, path: `/canonical${selected}` }));
  }
  if (url.pathname === '/api/chat_stream') {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString('utf8');
    const value = name => raw.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`))?.[1] || '';
    chatPosts.push({ workspace: value('workspace'), session: value('session'), mode: value('mode'), message: value('message') });
    if (value('message').includes('group workspace')) groupPosts.push({ workspace: value('workspace') });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    return res.end('data: {"delta":"Synthetic reply"}\n\ndata: [DONE]\n\n');
  }
  if (url.pathname === '/api/tasks/notification-logs') return res.writeHead(204).end();
  if (url.pathname === '/favicon.ico') return res.writeHead(204).end();
  if (url.pathname.startsWith('/static/')) {
    const file = path.resolve(repo, `.${url.pathname}`);
    if (!file.startsWith(path.join(repo, 'static') + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': /\.(?:js|mjs)$/.test(file) ? 'text/javascript' : 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{}');
  }
  res.writeHead(404).end();
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function releaseVet(path) {
  const response = await fetch(`${origin}/__release?key=${encodeURIComponent(`vet:${path}`)}`);
  assert.equal(response.status, 204, `held vet response missing: ${path}`);
}
async function speedWorkspaceDeadline(page) {
  await page.evaluate(() => {
    const realSet = window.setTimeout.bind(window);
    const realClear = window.clearTimeout.bind(window);
    const active = new Set();
    window.__workspaceDeadlineCount = () => active.size;
    window.setTimeout = (callback, ms, ...args) => {
      if (ms !== 15000) return realSet(callback, ms, ...args);
      let id;
      id = realSet(() => { active.delete(id); callback(...args); }, 40);
      active.add(id);
      return id;
    };
    window.clearTimeout = id => { active.delete(id); realClear(id); };
    window.__restoreWorkspaceDeadlineTimers = () => { window.setTimeout = realSet; window.clearTimeout = realClear; };
  });
}

(async () => {
  let listening = false;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    listening = true;
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu'] });
    context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    const outside = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url || ''}`); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`http${response.status()}:${response.url()}`); });
    page.on('request', request => { if (!request.url().startsWith(origin)) outside.push(request.url()); });
    await page.goto(origin);
    await page.waitForFunction(() => window.testModules, null, { timeout: 12000 }).catch(error => { throw new Error(`${error.message}; pageErrors=${JSON.stringify(errors)}`); });
    await speedWorkspaceDeadline(page);

    // Missing storage key must request configured default, show it, and post same choice.
    await page.evaluate(() => {
      const { workspace, sessions, Storage } = window.testModules;
      localStorage.removeItem('odysseus-workspace');
      sessions.setCurrentSessionId('synthetic-chat');
      Storage.saveToggleState({ mode: 'agent' });
      workspace.initWorkspace();
    });
    await page.waitForFunction(() => localStorage.getItem('odysseus-workspace') === '/synthetic/default-1', { timeout: 5000 });
    const selectedDefault = await page.evaluate(() => ({
      getter: window.testModules.workspace.getWorkspace(),
      stored: localStorage.getItem('odysseus-workspace'),
      pill: document.getElementById('workspace-indicator-name').textContent,
    }));
    assert.deepEqual(selectedDefault, { getter: '/synthetic/default-1', stored: '/synthetic/default-1', pill: 'default-1' });
    await page.evaluate(() => {
      document.getElementById('message').value = 'Synthetic workspace default POST';
      window.__send1 = window.testModules.chat.handleChatSubmit({ preventDefault() {} });
    });
    await waitFor(() => chatPosts.length === 1, 'chat post for configured default');
    await page.evaluate(() => window.__send1);
    assert.equal(chatPosts[0].workspace, '/synthetic/default-1');

    // Explicit empty selection stays empty and skips another default lookup.
    const beforeClearDefaultCount = defaultRequests;
    await page.evaluate(() => {
      const { workspace } = window.testModules;
      workspace.clearWorkspace();
      document.getElementById('message').value = 'Synthetic explicit clear POST';
      window.__send2 = workspace.getWorkspace() === '' ? window.testModules.chat.handleChatSubmit({ preventDefault() {} }) : Promise.resolve();
    });
    await waitFor(() => chatPosts.length === 2, 'chat post after explicit clear');
    await page.evaluate(() => window.__send2);
    assert.equal(defaultRequests, beforeClearDefaultCount, 'explicit clear skips default request');
    assert.equal(chatPosts[1].workspace, '', 'explicit clear omits workspace from chat post');
    const explicitClearSkippedDefault = defaultRequests === beforeClearDefaultCount;

    // Time only this exact 15-second deadline down in the synthetic page.
    const timeoutCases = [];
    for (const mode of ['headers', 'body']) {
      await page.reload();
      await page.waitForFunction(() => window.testModules, null, { timeout: 12000 });
      await speedWorkspaceDeadline(page);
      nextDefaultMode = mode;
      await page.evaluate(() => localStorage.removeItem('odysseus-workspace'));
      await page.reload();
      await page.waitForFunction(() => window.testModules, null, { timeout: 12000 });
      await speedWorkspaceDeadline(page);
      await page.evaluate(() => { window.__pendingDefault = window.testModules.workspace.loadDefaultWorkspace(); });
      await waitFor(() => held.has(`default-${defaultRequests}`), `default ${mode} hold`);
      const timedDefault = await page.evaluate(async () => ({ result: await window.__pendingDefault, timers: window.__workspaceDeadlineCount() }));
      assert.equal(timedDefault.result.request_error, true, `default ${mode} timeout is a request error`);
      assert.equal(timedDefault.timers, 0, `default ${mode} timeout clears timer`);
      await page.evaluate(() => { window.__defaultRetry = window.testModules.workspace.loadDefaultWorkspace(); });
      await page.evaluate(async () => window.__defaultRetry);
      assert.equal(await page.evaluate(() => window.testModules.workspace.getWorkspace()), `/synthetic/default-${defaultRequests}`);
      timeoutCases.push(`default-${mode}-timeout-retry`);

      nextVetMode = mode;
      const vetPath = `/synthetic/vet-${mode}`;
      await page.evaluate(path => { window.__pendingVet = window.testModules.workspace.vetAndSetWorkspace(path); }, vetPath);
      await waitFor(() => held.has(`vet:${vetPath}`), `vet ${mode} hold`);
      const timedVet = await page.evaluate(async () => ({ result: await window.__pendingVet, timers: window.__workspaceDeadlineCount() }));
      assert.equal(timedVet.result.request_error, true, `vet ${mode} timeout is a request error`);
      assert.equal(timedVet.timers, 0, `vet ${mode} timeout clears timer`);
      const retryVet = await page.evaluate(async path => {
        const result = await window.testModules.workspace.vetAndSetWorkspace(path);
        return { result, timers: window.__workspaceDeadlineCount() };
      }, `/synthetic/vet-retry-${mode}`);
      assert.equal(retryVet.result.ok, true);
      assert.equal(retryVet.timers, 0, 'successful vet clears timer');
      timeoutCases.push(`vet-${mode}-timeout-retry`);
    }

    const normalVet = await page.evaluate(async () => {
      const result = await window.testModules.workspace.vetAndSetWorkspace('/synthetic/normal');
      return { result, timers: window.__workspaceDeadlineCount() };
    });
    assert.equal(normalVet.result.ok, true);
    assert.equal(normalVet.timers, 0, 'normal vet clears timer');
    await page.evaluate(() => window.__restoreWorkspaceDeadlineTimers());

    // Separate pages share the saved preference but retain their own active
    // workspace choice and outgoing chat/group request scope.
    await page.evaluate(() => window.testModules.workspace.setWorkspace('/synthetic/tab-seed'));
    const pageB = await context.newPage();
    const tabErrors = [];
    pageB.on('pageerror', error => tabErrors.push(error.message));
    pageB.on('request', request => { if (!request.url().startsWith(origin)) outside.push(request.url()); });
    await pageB.goto(origin);
    await pageB.waitForFunction(() => window.testModules, null, { timeout: 12000 });
    nextVetMode = 'headers';
    await page.evaluate(() => { window.__lateTabVet = window.testModules.workspace.vetAndSetWorkspace('/synthetic/pending-A'); });
    await waitFor(() => held.has('vet:/synthetic/pending-A'), 'held Tab A vet');
    await pageB.evaluate(() => window.testModules.workspace.setWorkspace('/synthetic/tab-B'));
    await releaseVet('/synthetic/pending-A');
    const lateTabVetResult = await page.evaluate(async () => await window.__lateTabVet);
    const tabStateAfterLateA = await pageB.evaluate(() => ({
      getter: window.testModules.workspace.getWorkspace(),
      stored: localStorage.getItem('odysseus-workspace'),
      pill: document.getElementById('workspace-indicator-name').textContent,
    }));
    assert.deepEqual(tabStateAfterLateA, { getter: '/synthetic/tab-B', stored: '/canonical/synthetic/pending-A', pill: 'tab-B' }, JSON.stringify({ lateTabVetResult, tabStateAfterLateA }));

    await pageB.evaluate(() => {
      const { sessions, Storage, group } = window.testModules;
      sessions.setCurrentSessionId('synthetic-chat');
      Storage.saveToggleState({ mode: 'agent' });
      document.getElementById('message').value = 'Synthetic Tab B chat workspace';
      window.__tabChatSend = window.testModules.chat.handleChatSubmit({ preventDefault() {} });
      localStorage.setItem('odysseus-group-state', JSON.stringify({ active: true, mode: 'round-robin', models: [{ mid: 'fixture-model', display: 'Fixture', url: 'http://model.local/v1' }], participantSessions: ['fixture-group-session'], parentSessionId: null, autoConversation: false, replyLimit: 20 }));
      group.restoreState(null);
      window.__groupSend = group.sendMessage('Synthetic Tab B group workspace');
    });
    await waitFor(() => chatPosts.some(post => post.message.includes('Tab B chat workspace')), 'Tab B chat POST');
    await waitFor(() => groupPosts.length === 1, 'Tab B group POST');
    await pageB.evaluate(async () => { await Promise.all([window.__tabChatSend, window.__groupSend]); });
    assert.equal(chatPosts.find(post => post.message.includes('Tab B chat workspace')).workspace, '/synthetic/tab-B');
    assert.equal(groupPosts[0].workspace, '/synthetic/tab-B');

    // Rejected-path cleanup from A must preserve B's choice and pending vet.
    await pageB.evaluate(() => window.testModules.workspace.setWorkspace('/synthetic/tab-B'));
    nextVetMode = 'headers';
    await pageB.evaluate(() => { window.__pendingTabBVet = window.testModules.workspace.vetAndSetWorkspace('/synthetic/pending-B'); });
    await waitFor(() => held.has('vet:/synthetic/pending-B'), 'held Tab B vet');
    assert.equal(await page.evaluate(() => window.testModules.workspace.default.clearRejectedWorkspace('/canonical/synthetic/pending-A')), true);
    const tabStateAfterCleanup = await pageB.evaluate(() => ({
      getter: window.testModules.workspace.getWorkspace(),
      stored: localStorage.getItem('odysseus-workspace'),
      pill: document.getElementById('workspace-indicator-name').textContent,
    }));
    assert.deepEqual(tabStateAfterCleanup, { getter: '/synthetic/tab-B', stored: '/synthetic/tab-B', pill: 'tab-B' });
    await releaseVet('/synthetic/pending-B');
    const pendingB = await pageB.evaluate(async () => ({ result: await window.__pendingTabBVet, getter: window.testModules.workspace.getWorkspace(), stored: localStorage.getItem('odysseus-workspace') }));
    assert.equal(pendingB.result.ok, true);
    assert.equal(pendingB.getter, '/canonical/synthetic/pending-B');
    assert.equal(pendingB.stored, '/canonical/synthetic/pending-B');

    const authCases = [];
    const authErrors = [];
    async function authPage(seedUser, seedWorkspace, responseIdentity, valid = true, denySessionStorage = false) {
      const authContext = await browser.newContext();
      const authPageErrors = [];
      const authPage = await authContext.newPage();
      authPage.on('pageerror', error => { authPageErrors.push(error.message); authErrors.push(error.message); });
      authPage.on('request', request => { if (!request.url().startsWith(origin)) outside.push(request.url()); });
      await authContext.addInitScript(({ user, workspace, denySessionStorage }) => {
        localStorage.setItem('odysseus-auth-user', user);
        localStorage.setItem('odysseus-workspace', workspace);
        if (denySessionStorage) Object.defineProperty(sessionStorage, 'length', { configurable: true, get() { throw new Error('synthetic sessionStorage denial'); } });
      }, { user: seedUser, workspace: seedWorkspace, denySessionStorage });
      holdNextAuth = true;
      await authPage.goto(`${origin}/auth-proof`);
      await authPage.waitForFunction(() => window.authProof);
      await waitFor(() => !!heldAuthResponse, 'held auth proof response');
      const pending = await authPage.evaluate(() => ({
        getter: window.authProof.workspace.getWorkspace(),
        pill: document.getElementById('workspace-indicator-name').textContent,
        stored: localStorage.getItem('odysseus-workspace'),
      }));
      assert.deepEqual(pending, { getter: '', pill: '', stored: seedWorkspace }, 'unverified auth keeps preference stored but does not expose it');
      const release = await fetch(`${origin}/__release-auth?identity=${encodeURIComponent(responseIdentity)}&valid=${valid}`);
      assert.equal(release.status, 204);
      const result = await authPage.evaluate(async () => await window.authProof.authStatePromise);
      return { authContext, authPage, authPageErrors, result, pending };
    }

    const switchedAuth = await authPage('synthetic-account-A', '/synthetic/account-A', 'synthetic-account-B');
    await switchedAuth.authPage.waitForFunction(() => localStorage.getItem('odysseus-auth-user') === 'synthetic-account-B');
    const switchedWorkspace = await switchedAuth.authPage.evaluate(() => ({
      getter: window.authProof.workspace.getWorkspace(),
      pill: document.getElementById('workspace-indicator-name').textContent,
      storedWorkspace: localStorage.getItem('odysseus-workspace'),
      storedIdentity: localStorage.getItem('odysseus-auth-user'),
    }));
    assert.equal(switchedAuth.result.switched, true);
    assert.deepEqual(switchedWorkspace, { getter: '', pill: '', storedWorkspace: null, storedIdentity: 'synthetic-account-B' }, 'account switch invalidates old page workspace without writing a blank preference');
    authCases.push('account-switch-invalidates-page-cache');
    await switchedAuth.authContext.close();

    const intentContext = await browser.newContext();
    const intentPage = await intentContext.newPage();
    const intentErrors = [];
    intentPage.on('pageerror', error => { intentErrors.push(error.message); authErrors.push(error.message); });
    await intentContext.addInitScript(() => {
      localStorage.setItem('odysseus-auth-user', 'synthetic-account-A');
      localStorage.setItem('odysseus-workspace', '/synthetic/kept');
    });
    holdNextAuth = true;
    await intentPage.goto(`${origin}/auth-proof`);
    await intentPage.waitForFunction(() => window.authProof);
    await waitFor(() => !!heldAuthResponse, 'held auth intent response');
    await intentPage.evaluate(() => {
      window.pendingIntentVet = window.authProof.workspace.vetAndSetWorkspace('/synthetic/obsolete-vet');
      window.pendingIntentDefault = window.authProof.workspace.loadDefaultWorkspace();
    });
    assert.equal(await intentPage.evaluate(() => window.authProof.workspace.clearWorkspace()), false, 'explicit clear attempt is rejected while auth is unknown');
    const defaultsBeforeAuthRelease = defaultRequests;
    const intentRelease = await fetch(`${origin}/__release-auth?identity=synthetic-account-A`);
    assert.equal(intentRelease.status, 204);
    await intentPage.evaluate(async () => await window.authProof.authStatePromise);
    const canceledVet = await intentPage.evaluate(async () => await window.pendingIntentVet);
    const canceledDefault = await intentPage.evaluate(async () => await window.pendingIntentDefault);
    assert.equal(canceledVet.stale, true, 'explicit clear attempt supersedes a vet while auth is pending');
    assert.equal(canceledDefault.stale, true, 'explicit clear attempt supersedes a default lookup while auth is pending');
    assert.equal(defaultRequests, defaultsBeforeAuthRelease, 'stale default lookup does not reach the backend');
    assert.equal(await intentPage.evaluate(() => localStorage.getItem('odysseus-workspace')), '/synthetic/kept', 'failed explicit clear does not write storage');
    assert.deepEqual(intentErrors, []);
    authCases.push('explicit-clear-attempt-supersedes-pending-auth-vet-and-default');
    await intentContext.close();

    const sameAuth = await authPage('synthetic-account-A', '/synthetic/account-A', 'synthetic-account-A');
    await sameAuth.authPage.waitForFunction(() => window.authProof.workspace.getWorkspace() === '/synthetic/account-A');
    const sameWorkspace = await sameAuth.authPage.evaluate(() => ({ getter: window.authProof.workspace.getWorkspace(), pill: document.getElementById('workspace-indicator-name').textContent }));
    assert.equal(sameAuth.result.verified, true);
    assert.equal(sameAuth.result.switched, false);
    assert.deepEqual(sameWorkspace, { getter: '/synthetic/account-A', pill: 'account-A' }, 'verified same-account auth restores its saved workspace');
    authCases.push('same-account-hydrates-saved-workspace');
    await sameAuth.authContext.close();

    const sessionDeniedAuth = await authPage('synthetic-account-A', '/synthetic/account-A', 'synthetic-account-A', true, true);
    assert.equal(sessionDeniedAuth.result.verified, true);
    assert.equal(sessionDeniedAuth.result.switched, false);
    assert.equal(sessionDeniedAuth.result.storageAvailable, false, 'authState reports sessionStorage-only denial');
    await sessionDeniedAuth.authPage.waitForFunction(() => window.authProof.workspace.getWorkspace() === '/synthetic/account-A');
    const sessionDeniedWorkspace = await sessionDeniedAuth.authPage.evaluate(() => ({ getter: window.authProof.workspace.getWorkspace(), pill: document.getElementById('workspace-indicator-name').textContent }));
    assert.deepEqual(sessionDeniedWorkspace, { getter: '/synthetic/account-A', pill: 'account-A' }, 'verified same-account workspace remains available when only sessionStorage is denied');
    authCases.push('session-storage-denial-does-not-hide-verified-workspace');
    await sessionDeniedAuth.authContext.close();

    const unknownAuth = await authPage('synthetic-account-A', '/synthetic/account-A', 'synthetic-account-A', false);
    assert.equal(unknownAuth.result.verified, false);
    const unknownWorkspace = await unknownAuth.authPage.evaluate(() => ({ getter: window.authProof.workspace.getWorkspace(), pill: document.getElementById('workspace-indicator-name').textContent, stored: localStorage.getItem('odysseus-workspace') }));
    assert.deepEqual(unknownWorkspace, { getter: '', pill: '', stored: '/synthetic/account-A' }, 'unverified auth preserves saved preference without exposing it');
    authCases.push('unverified-auth-preserves-hidden-preference');
    nextAuthStatus = { configured: true, authenticated: true, username: 'synthetic-account-A' };
    const authRetry = await unknownAuth.authPage.evaluate(async () => await window.authProof.workspace.vetAndSetWorkspace('/synthetic/auth-retry'));
    assert.equal(authRetry.ok, true, 'explicit vet retries auth reconciliation after an unverified response');
    assert.equal(await unknownAuth.authPage.evaluate(() => window.authProof.workspace.getWorkspace()), '/canonical/synthetic/auth-retry');
    authCases.push('explicit-vet-retries-auth-verification');
    await unknownAuth.authContext.close();

    assert.deepEqual([...errors, ...tabErrors, ...authErrors], []);
    assert.deepEqual(outside, []);
    console.log(JSON.stringify({ loopbackOnly: outside.length === 0, pageErrors: [...errors, ...tabErrors, ...authErrors], keylessConfiguredDefault: selectedDefault, chatPosts: chatPosts.map(post => ({ workspace: post.workspace, mode: post.mode, session: post.session })), groupPosts: groupPosts.map(post => ({ workspace: post.workspace })), explicitClearSkippedDefault, timeoutCases, normalVetSuccess: normalVet.result.ok, activeWorkspaceDeadlineTimers: normalVet.timers, tabLocalStateAfterLateVet: tabStateAfterLateA, tabLocalStateAfterRejectedCleanup: tabStateAfterCleanup, pendingOtherTabVetSurvived: pendingB.result.ok, authCases }));
  } finally {
    for (const response of held.values()) { try { response.destroy(); } catch {} }
    held.clear();
    await browser?.close().catch(() => {});
    if (listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => {
  console.error(error);
  for (const response of held.values()) { try { response.destroy(); } catch {} }
  server.closeAllConnections?.();
  server.close();
  process.exitCode = 1;
});
