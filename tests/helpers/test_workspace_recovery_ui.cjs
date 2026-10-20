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
const chatPosts = [];
let browser;
let origin;
const html = `<!doctype html><meta charset="utf-8">
<div class="list-item active-session" data-session-id="synthetic-chat"></div>
<button id="mode-chat-btn"></button><textarea id="message"></textarea><div id="attach-strip"></div>
<input id="file-input" type="file" multiple><input id="incognito-toggle" type="checkbox">
<input id="web-toggle" type="checkbox"><input id="research-toggle" type="checkbox"><input id="bash-toggle" type="checkbox">
<button id="research-toggle-btn"></button><button id="workspace-indicator-btn"><span id="workspace-indicator-name"></span><span class="tool-indicator-x"></span></button>
<button id="overflow-workspace-btn"></button><div id="chat-history"></div><button class="send-btn"></button><div id="toast"></div>
<script type="module">
import chat from '/static/js/chat.js';
import sessions from '/static/js/sessions.js';
import * as workspace from '/static/js/workspace.js';
import Storage from '/static/js/storage.js';
window.modulesReady = Promise.all([chat, sessions]).then(() => {
  window.testModules = { chat, sessions, workspace, Storage };
});
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
  if (url.pathname === '/api/auth/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ configured: false, authenticated: false, username: null }));
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
    chatPosts.push({ workspace: value('workspace'), session: value('session'), mode: value('mode') });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    return res.end('data: [DONE]\n\n');
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
  });
}

(async () => {
  let listening = false;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    listening = true;
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
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
      workspace.initWorkspace();
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
      await page.evaluate(() => { localStorage.removeItem('odysseus-workspace'); window.__pendingDefault = window.testModules.workspace.loadDefaultWorkspace(); });
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
    assert.deepEqual(errors, []);
    assert.deepEqual(outside, []);
    console.log(JSON.stringify({ loopbackOnly: outside.length === 0, pageErrors: errors, keylessConfiguredDefault: selectedDefault, chatPosts: chatPosts.map(post => ({ workspace: post.workspace, mode: post.mode, session: post.session })), explicitClearSkippedDefault, timeoutCases, normalVetSuccess: normalVet.result.ok, activeWorkspaceDeadlineTimers: normalVet.timers }));
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
