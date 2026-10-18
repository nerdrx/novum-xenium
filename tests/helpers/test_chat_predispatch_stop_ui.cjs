// Synthetic actual-module coverage for Stop during a held model switch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const staticRoot = path.resolve(__dirname, '../../static');
const html = `<!doctype html><meta charset="utf-8">
<textarea id="message"></textarea><div id="attach-strip"></div><input id="file-input" type="file" multiple>
<input id="incognito-toggle" type="checkbox"><input id="web-toggle" type="checkbox"><input id="research-toggle" type="checkbox"><input id="bash-toggle" type="checkbox"><button id="research-toggle-btn"></button>
<div id="chat-history"></div><button class="send-btn"></button><div id="toast"></div>
<script type="module">
  import chat from '/js/chat.js'; import sessions from '/js/sessions.js'; import files from '/js/fileHandler.js?v=20260909mobileattachmentedit1';
  window.modulesReady = Promise.all([chat, sessions, files]).then(() => { window.testModules = { chat, sessions, files }; });
</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

const waitUntil = async (page, expression) => page.waitForFunction(expression, null, { timeout: 7000 });
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.stack || e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await waitUntil(page, () => window.testModules);
    await page.evaluate(() => {
      const { sessions, files } = window.testModules;
      sessions.setCurrentSessionId('chat-A');
      window.__odysseusDefaultChat = { endpoint_url: 'http://fixture', model: 'fixture-model', endpoint_id: 'fixture-endpoint' };
      window.messagePosts = [];
      window.uploadPosts = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.includes('/api/upload')) {
          window.uploadPosts.push(url);
          return new Response(JSON.stringify({ files: [{ id: 'synthetic-file-id', name: 'stop-check.txt' }] }), { status: 200 });
        }
        if (url.includes('/api/chat_stream')) {
          window.messagePosts.push({ session: init.body.get('session'), message: init.body.get('message') });
          return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (url.includes('/api/default-chat')) return new Response(JSON.stringify(window.__odysseusDefaultChat), { status: 200 });
        if (url.includes('/api/session/') && url.includes('/truncate')) return new Response('{}', { status: 200 });
        return originalFetch(input, init);
      };
      window.makeHeldSwitch = () => {
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        promise.sessionId = 'chat-A';
        window.__odysseusModelSwitchPromise = promise;
        window.resolveHeldSwitch = resolve;
      };
      window.makeHeldSwitch();
    });

    // Stop while the model switch is held must leave the draft and attachment untouched.
    await page.evaluate(async () => {
      const { files, chat } = window.testModules;
      await files.addFiles([new File(['synthetic bytes'], 'stop-check.txt', { type: 'text/plain' })], { skipCrop: true });
      document.getElementById('message').value = 'Keep this stopped draft';
      window.stoppedSendSettled = false;
      window.stoppedSend = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.stoppedSendSettled = true; });
    });
    await waitUntil(page, () => window.__odysseusChatBusy === true && !!window.__odysseusModelSwitchPromise);
    await page.evaluate(() => window.testModules.chat.abortCurrentRequest(true));
    const beforeRelease = await page.evaluate(() => ({ posts: window.messagePosts.length, uploads: window.uploadPosts.length }));
    await page.evaluate(() => window.resolveHeldSwitch());
    await waitUntil(page, () => window.stoppedSendSettled === true);
    const stopped = await page.evaluate(() => ({
      posts: window.messagePosts.length,
      uploads: window.uploadPosts.length,
      draft: document.getElementById('message').value,
      pendingFiles: window.testModules.files.getPendingCount(),
      busy: window.__odysseusChatBusy,
      buttonMode: document.querySelector('.send-btn').dataset.mode || '',
      sendPending: document.querySelector('.send-btn').classList.contains('send-pending'),
      bubbleCount: document.querySelectorAll('#chat-history .msg-user').length,
    }));
    assert.deepEqual(beforeRelease, { posts: 0, uploads: 0 });
    assert.equal(stopped.posts, 0);
    assert.equal(stopped.uploads, 0);
    assert.equal(stopped.draft, 'Keep this stopped draft');
    assert.equal(stopped.pendingFiles, 1);
    assert.equal(stopped.busy, false);
    assert.equal(stopped.buttonMode, '');
    assert.equal(stopped.sendPending, false);
    assert.equal(stopped.bubbleCount, 0);

    // Resolving a normal held switch still performs the send.
    await page.evaluate(() => {
      window.testModules.files.clearPending();
      document.getElementById('message').value = 'Normal held-switch send';
      window.makeHeldSwitch();
      window.normalSendSettled = false;
      window.normalSend = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.normalSendSettled = true; });
    });
    await waitUntil(page, () => window.__odysseusChatBusy === true && !!window.__odysseusModelSwitchPromise);
    await page.evaluate(() => window.resolveHeldSwitch());
    await waitUntil(page, () => window.normalSendSettled === true);
    assert.deepEqual(await page.evaluate(() => window.messagePosts), [{ session: 'chat-A', message: 'Normal held-switch send' }]);

    // A cancelled A preflight must not clobber B's newer draft or busy ownership.
    await page.evaluate(() => {
      const { sessions, chat } = window.testModules;
      sessions.setCurrentSessionId('chat-A');
      document.getElementById('message').value = 'Cancelled A';
      window.makeHeldSwitch();
      window.aSettled = false;
      window.aSend = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.aSettled = true; });
    });
    await waitUntil(page, () => !!window.__odysseusModelSwitchPromise && window.__odysseusChatBusy === true);
    await page.evaluate(() => {
      window.testModules.chat.abortCurrentRequest(true);
      window.testModules.sessions.setCurrentSessionId('chat-B');
      document.getElementById('message').value = 'B newer draft';
      window.__odysseusModelSwitchPromise = null;
    });
    await page.evaluate(() => window.resolveHeldSwitch());
    await waitUntil(page, () => window.aSettled === true);
    const replacement = await page.evaluate(() => ({ posts: window.messagePosts.slice(), draft: document.getElementById('message').value }));
    assert.deepEqual(replacement.posts.map(x => x.message), ['Normal held-switch send']);
    assert.equal(replacement.draft, 'B newer draft');
    await page.evaluate(() => {
      window.bSettled = false;
      window.bSend = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.bSettled = true; });
    });
    await waitUntil(page, () => window.bSettled === true);
    assert.deepEqual(await page.evaluate(() => window.messagePosts.map(x => x.message)), ['Normal held-switch send', 'B newer draft']);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ pass: true, stopped, normalPosts: await page.evaluate(() => window.messagePosts.slice(0, 1)), replacement, pageErrors: errors }, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
