// Synthetic regression: an attachment upload must use the chat captured by the send.
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
  if (url.pathname === '/fixture') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.waitForFunction(() => window.testModules);
    await page.evaluate(async () => {
      const { sessions, files } = window.testModules;
      sessions.setCurrentSessionId('chat-A');
      await files.addFiles([new File(['synthetic attachment bytes'], 'session-check.txt', { type: 'text/plain' })], { skipCrop: true });
      document.getElementById('message').value = 'Synthetic prompt for chat A';
      window.uploadSessions = [];
      window.uploadFiles = [];
      window.messageSessions = [];
      window.messageBodies = [];
      window.uploadAttempts = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.includes('/api/upload')) {
          window.uploadAttempts++;
          const form = init.body;
          window.uploadSessions.push(form.get('session_id'));
          window.uploadFiles.push(form.getAll('files').map(file => file.name));
          if (window.uploadAttempts === 1 && window.failFirstUpload) {
            return new Response(JSON.stringify({ detail: 'synthetic temporary upload failure' }), {
              status: 503, headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ files: [{ id: 'synthetic-upload-id', name: 'session-check.txt' }] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/chat_stream')) {
          window.messageSessions.push(init.body.get('session'));
          window.messageBodies.push(init.body.get('message'));
          if (window.holdStreamSession === init.body.get('session')) {
            return new Response(new ReadableStream({ start(controller) { window.streamController = controller; window.bStreamStarted = true; } }), {
              status: 200, headers: { 'Content-Type': 'text/event-stream' },
            });
          }
          return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return originalFetch(input, init);
      };
    });

    // Hold the actual send at its model-switch await, then move the fake current chat.
    await page.evaluate(() => {
      const { chat } = window.testModules;
      window.__odysseusModelSwitchPromise = {
        then(resolve) {
          window.modelSwitchWaiting = true;
          window.resolveModelSwitch = resolve;
        },
      };
      window.sendSettled = false;
      window.sendPromise = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.sendSettled = true; });
    });
    await page.waitForFunction(() => window.modelSwitchWaiting === true);
    await page.evaluate(async () => {
      window.testModules.sessions.setCurrentSessionId('chat-B');
      document.getElementById('message').value = 'Draft written in chat B';
      await window.testModules.files.addFiles([
        new File(['chat B only bytes'], 'chat-B-only.txt', { type: 'text/plain' }),
      ], { skipCrop: true });
      window.resolveModelSwitch();
    });
    await page.waitForFunction(() => window.sendSettled === true);

    const switched = await page.evaluate(() => ({
      uploadSession: window.uploadSessions[0],
      uploadedFiles: window.uploadFiles[0],
      messageSession: window.messageSessions[0],
      messageBody: window.messageBodies[0],
      composerAfterSend: document.getElementById('message').value,
      attempts: window.uploadAttempts,
      pending: window.testModules.files.getPendingCount(),
    }));
    assert.equal(switched.uploadSession, undefined, 'session change cancels before upload');
    assert.equal(switched.messageSession, undefined, 'session change cancels before message POST');
    assert.deepEqual(switched.uploadedFiles, undefined);
    assert.equal(switched.messageBody, undefined);
    assert.equal(switched.composerAfterSend, 'Draft written in chat B', 'B draft survives cancellation');
    assert.equal(switched.attempts, 0);
    assert.equal(switched.pending, 2, 'A and B files remain visible for review');
    assert.equal(await page.evaluate(() => window.testModules.chat.hasActiveStream('chat-A')), false);
    assert.equal(await page.locator('.send-btn').getAttribute('data-mode'), '', 'cancelled A send leaves B submit button idle');
    assert.equal(await page.locator('#message').isDisabled(), false, 'cancelled A send leaves B composer enabled');

    // A's cancellation must not reset B's pending preflight UI either.
    await page.evaluate(() => {
      const { sessions, files, chat } = window.testModules;
      files.clearPending();
      sessions.setCurrentSessionId('chat-A');
      document.getElementById('message').value = 'A pending preflight';
      window.messageSessions = [];
      window.modelSwitchWaiting = false;
      window.__odysseusModelSwitchPromise = {
        then(resolve) { window.modelSwitchWaiting = true; window.resolveAModelSwitch = resolve; },
      };
      window.pendingASettled = false;
      window.pendingAPromise = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.pendingASettled = true; });
    });
    await page.waitForFunction(() => window.modelSwitchWaiting === true);
    await page.evaluate(() => {
      const { sessions, chat } = window.testModules;
      sessions.setCurrentSessionId('chat-B');
      // Clear A's stale foreground Stop state, then hold a separate B preflight.
      window.navigationReset = chat.handleChatSubmit({ preventDefault() {} });
      document.getElementById('message').value = 'B pending draft';
      window.bModelSwitchWaiting = false;
      window.__odysseusModelSwitchPromise = {
        then(resolve) { window.bModelSwitchWaiting = true; window.resolveBModelSwitch = resolve; },
      };
      window.pendingBSettled = false;
      window.pendingBPromise = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.pendingBSettled = true; });
    });
    await page.waitForFunction(() => window.bModelSwitchWaiting === true);
    await page.evaluate(() => window.resolveAModelSwitch());
    await page.waitForFunction(() => window.pendingASettled === true);
    const pendingBAfterACancel = await page.evaluate(() => ({
      mode: document.querySelector('.send-btn').dataset.mode,
      draft: document.getElementById('message').value,
      posts: window.messageSessions.length,
      busy: window.__odysseusChatBusy,
    }));
    assert.equal(pendingBAfterACancel.mode, 'streaming', 'A cancellation leaves B pending send indicator intact');
    assert.equal(pendingBAfterACancel.draft, 'B pending draft');
    assert.equal(pendingBAfterACancel.posts, 0, 'neither preflight POSTs before its model switch resolves');
    assert.equal(pendingBAfterACancel.busy, true, 'A cancellation preserves B pending-send busy state');
    await page.evaluate(() => {
      window.testModules.files.clearPending();
      window.resolveBModelSwitch();
    });
    await page.waitForFunction(() => window.pendingBSettled === true);
    assert.deepEqual(await page.evaluate(() => window.messageSessions), ['chat-B'], 'B pending send continues after A cleanup');

    // A same-chat deferred send continues normally after the model switch settles.
    await page.evaluate(async () => {
      const { sessions, files, chat } = window.testModules;
      files.clearPending();
      sessions.setCurrentSessionId('chat-A');
      await files.addFiles([new File(['same-chat bytes'], 'same-chat.txt', { type: 'text/plain' })], { skipCrop: true });
      document.getElementById('message').value = 'Same-chat prompt';
      window.uploadAttempts = 0;
      window.uploadSessions = [];
      window.uploadFiles = [];
      window.messageSessions = [];
      window.messageBodies = [];
      window.modelSwitchWaiting = false;
      window.__odysseusModelSwitchPromise = {
        then(resolve) { window.modelSwitchWaiting = true; window.resolveModelSwitch = resolve; },
      };
      window.sameChatSettled = false;
      window.sameChatPromise = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.sameChatSettled = true; });
    });
    await page.waitForFunction(() => window.modelSwitchWaiting === true);
    await page.evaluate(() => window.resolveModelSwitch());
    await page.waitForFunction(() => window.sameChatSettled === true);
    const sameChat = await page.evaluate(() => ({
      uploadSession: window.uploadSessions[0],
      uploadedFiles: window.uploadFiles[0],
      messageSession: window.messageSessions[0],
      messageBody: window.messageBodies[0],
      pending: window.testModules.files.getPendingCount(),
    }));
    assert.equal(sameChat.uploadSession, 'chat-A');
    assert.deepEqual(sameChat.uploadedFiles, ['same-chat.txt']);
    assert.equal(sameChat.messageSession, 'chat-A');
    assert.equal(sameChat.messageBody, 'Same-chat prompt');
    assert.equal(sameChat.pending, 0);

    // Same-chat HTTP failure keeps the file and prompt; the retry uses the same chat ID.
    await page.evaluate(async () => {
      const { sessions, files, chat } = window.testModules;
      sessions.setCurrentSessionId('chat-A');
      await files.addFiles([new File(['retry bytes'], 'retry-check.txt', { type: 'text/plain' })], { skipCrop: true });
      const input = document.getElementById('message');
      input.value = 'Retry this prompt';
      window.failFirstUpload = true;
      window.uploadAttempts = 0;
      window.uploadSessions = [];
      window.messageSessions = [];
      window.__odysseusModelSwitchPromise = null;
      window.firstRetrySettled = false;
      window.firstRetryPromise = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.firstRetrySettled = true; });
    });
    await page.waitForFunction(() => window.firstRetrySettled === true);
    assert.equal(await page.locator('#message').inputValue(), 'Retry this prompt');
    assert.equal(await page.evaluate(() => window.testModules.files.getPendingCount()), 1);
    await page.evaluate(() => {
      window.secondRetrySettled = false;
      window.secondRetryPromise = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.secondRetrySettled = true; });
    });
    await page.waitForFunction(() => window.secondRetrySettled === true);
    const retry = await page.evaluate(() => ({
      uploadSessions: window.uploadSessions,
      messageSessions: window.messageSessions,
      attempts: window.uploadAttempts,
      pending: window.testModules.files.getPendingCount(),
    }));
    assert.deepEqual(retry.uploadSessions, ['chat-A', 'chat-A']);
    assert.deepEqual(retry.messageSessions, ['chat-A']);
    assert.equal(retry.pending, 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ pass: true, mode: 'cancel-on-session-change', switched, pendingBAfterACancel, sameChat, retry, pageErrors: errors }, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
