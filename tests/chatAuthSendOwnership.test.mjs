import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const staticRoot = resolve(new URL('..', import.meta.url).pathname, 'static');
const html = `<!doctype html><meta charset="utf-8">
<textarea id="message"></textarea><div id="attach-strip"></div><input id="file-input" type="file" multiple>
<input id="incognito-toggle" type="checkbox"><input id="web-toggle" type="checkbox"><input id="research-toggle" type="checkbox"><input id="bash-toggle" type="checkbox"><button id="research-toggle-btn"></button>
<div id="chat-history"></div><button class="send-btn"></button><div id="toast"></div>
<script type="module">import chat from '/js/chat.js'; import sessions from '/js/sessions.js'; import files from '/js/fileHandler.js?v=20260909mobileattachmentedit1'; window.modulesReady = Promise.all([chat, sessions, files]).then(() => { window.testModules = { chat, sessions, files }; });</script>`;
let authMode = 'same';
let authCount = 0;
let releaseHeldAuth = null;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname === '/api/auth/status') {
    authCount++;
    if (authMode === 'stop-hang' && authCount === 1) return;
    if (authMode === 'delayed-same') {
      releaseHeldAuth = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured: true, authenticated: true, username: 'alice' }));
      };
      return;
    }
    const response = authMode === 'unknown'
      ? { status: 401, body: { detail: 'login required' } }
      : { status: 200, body: authMode === 'switch'
        ? { configured: true, authenticated: true, username: 'bob' }
        : authMode === 'anonymous'
          ? { configured: false, authenticated: false, username: null }
          : { configured: true, authenticated: true, username: 'alice' } };
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(response.body));
  }
  const file = resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${sep}`)) { res.writeHead(404); return res.end(); }
  try {
    await stat(file);
    res.setHeader('Content-Type', url.pathname.startsWith('/js/') || file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    const bytes = await readFile(file);
    res.end(bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
});

async function openPage(browser, mode, { storageDenied = false, accelerateDeadline = false } = {}) {
  authMode = storageDenied ? 'delayed-same' : mode;
  authCount = 0;
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.addInitScript(({ accelerateDeadline, mode }) => {
    if (mode !== 'anonymous') localStorage.setItem('odysseus-auth-user', 'alice');
    if (accelerateDeadline) {
      const nativeTimeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 15000 ? 35 : ms, ...args);
    }
  }, { accelerateDeadline, mode });
  const errors = [];
  page.on('pageerror', e => errors.push(e.stack || e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('requestfailed', req => errors.push(`${req.url()}: ${req.failure()?.errorText}`));
  page.on('response', res => { if (res.status() >= 400) errors.push(`${res.status()} ${res.url()}`); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.testModules).catch(error => { throw new Error(`${error.message}\n${errors.join('\n')}`); });
  if (storageDenied) await page.evaluate(() => {
    for (const method of ['getItem', 'setItem', 'removeItem', 'key']) {
      Object.defineProperty(Storage.prototype, method, { value() { throw new DOMException('denied', 'SecurityError'); } });
    }
    Object.defineProperty(Storage.prototype, 'length', { get() { throw new DOMException('denied', 'SecurityError'); } });
  });
  await page.evaluate(() => {
    const { sessions, files } = window.testModules;
    sessions.setCurrentSessionId('chat-A');
    window.uploadRequests = [];
    window.chatPosts = [];
    window.apiCalls = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/api/')) {
        window.apiCalls.push(url);
        if (url.includes('chat_stream')) window.chatPosts.push(`seen:${url}`);
      }
      if (url.includes('/api/auth/status')) {
        const response = window.__fixtureAuth || { status: 200, body: { configured: true, authenticated: true, username: 'alice' } };
        return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/upload')) {
        window.uploadRequests.push(url);
        return new Response(JSON.stringify({ files: [{ id: 'fixture-file', name: 'secret.txt' }] }), { status: 200 });
      }
      if (url.includes('/api/chat_stream')) {
        return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.includes('/api/default-chat')) return new Response(JSON.stringify({ endpoint_url: 'http://fixture-model', model: 'fixture-model' }), { status: 200 });
      if (url.includes('/api/history/')) return new Response(JSON.stringify({ history: [], total: 0 }), { status: 200 });
      if (url.includes('/api/session/')) return new Response('{}', { status: 200 });
      return nativeFetch(input, init);
    };
    window.testModules.files.addFiles([new File(['private attachment'], 'secret.txt', { type: 'text/plain' })], { skipCrop: true });
    document.getElementById('message').value = 'Private composer text';
  });
  await page.evaluate(mode => {
    window.__fixtureAuth = mode === 'unknown'
      ? { status: 401, body: { detail: 'login required' } }
      : { status: 200, body: mode === 'switch'
        ? { configured: true, authenticated: true, username: 'bob' }
        : mode === 'anonymous'
          ? { configured: false, authenticated: false, username: null }
          : { configured: true, authenticated: true, username: 'alice' } };
  }, mode);
  return { page, errors, releaseAuth: storageDenied ? () => releaseHeldAuth?.() : null };
}

test('production chat send gates unknown and switched ownership before upload/post, preserves same-user send, and honors Stop', async () => {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    for (const mode of ['unknown', 'switch']) {
      const { page, errors } = await openPage(browser, mode);
      await page.evaluate(async () => {
        window.sendSettled = false;
        window.sendPromise = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.sendSettled = true; });
      });
      await page.waitForFunction(() => window.sendSettled);
      const state = await page.evaluate(() => ({
        posts: window.chatPosts,
        uploads: window.uploadRequests,
        draft: document.getElementById('message').value,
        files: window.testModules.files.getPendingInfo().map(file => file.name),
      }));
      assert.deepEqual(state.posts, [], `${mode}: must not POST chat content`);
      assert.deepEqual(state.uploads, [], `${mode}: must not upload attachments`);
      assert.equal(state.draft, 'Private composer text');
      assert.deepEqual(state.files, ['secret.txt']);
      await page.close();
    }

    for (const [mode, options] of [['same', {}], ['same', { storageDenied: true }], ['anonymous', {}]]) {
      const { page, errors, releaseAuth } = await openPage(browser, mode, options);
      releaseAuth?.();
      await page.evaluate(async () => {
        window.sendSettled = false;
        window.sendPromise = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.sendSettled = true; });
      });
      await page.waitForFunction(() => window.sendSettled);
      const same = await page.evaluate(async () => ({
        posts: window.chatPosts, uploads: window.uploadRequests,
        auth: await (await import('/js/authState.js')).getAuthState(),
      }));
      assert.equal(same.auth.verified, true);
      assert.equal(same.posts.length, 1, `${mode} send must proceed: ${JSON.stringify(same)}`);
      assert.equal(same.uploads.length, 1, `${mode} attachment must upload`);
      assert.equal(await page.evaluate(() => !!window.__odysseusChatBusy), false, 'successful DONE releases busy state');
      assert.ok(!errors.some(error => /ReferenceError|TypeError|Stream error/.test(error)), errors.join('\n'));
      if (options.storageDenied) assert.equal(same.auth.storageAvailable, false);
      await page.close();
    }

    const held = await openPage(browser, 'stop-hang', { accelerateDeadline: true });
    await held.page.evaluate(async () => {
      window.sendSettled = false;
      window.sendPromise = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.sendSettled = true; });
    });
    await held.page.waitForFunction(() => window.__odysseusChatBusy === true);
    await held.page.evaluate(() => window.testModules.chat.abortCurrentRequest(true));
    await held.page.waitForFunction(() => window.sendSettled);
    const stopped = await held.page.evaluate(() => ({
      posts: window.chatPosts,
      uploads: window.uploadRequests,
      draft: document.getElementById('message').value,
      files: window.testModules.files.getPendingInfo().map(file => file.name),
    }));
    assert.deepEqual(stopped.posts, []);
    assert.deepEqual(stopped.uploads, []);
    assert.equal(stopped.draft, 'Private composer text');
    assert.deepEqual(stopped.files, ['secret.txt']);
    await held.page.close();
  } finally {
    await browser.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
