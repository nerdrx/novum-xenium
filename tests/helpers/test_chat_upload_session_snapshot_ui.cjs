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
      window.messageFileIds = [];
      window.messageRoutes = [];
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
        if (url.includes('/api/session/') && url.includes('/truncate')) {
          return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/chat_stream')) {
          window.messageSessions.push(init.body.get('session'));
          window.messageBodies.push(init.body.get('message'));
          window.messageFileIds.push(JSON.parse(init.body.get('attachments') || '[]'));
          window.messageRoutes.push({
            model: init.body.get('selected_model'),
            endpointUrl: init.body.get('selected_endpoint_url'),
          });
          if (window.holdStreamSession === init.body.get('session')) {
            return new Response(new ReadableStream({ start(controller) { window.streamController = controller; window.bStreamStarted = true; } }), {
              status: 200, headers: { 'Content-Type': 'text/event-stream' },
            });
          }
          const streamText = window.streamText;
          window.streamText = null;
          return new Response((streamText ? `data: ${JSON.stringify({ delta: streamText })}\n\n` : '') + 'data: [DONE]\n\n', {
            status: 200, headers: { 'Content-Type': 'text/event-stream' },
          });
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
        sessionId: 'chat-A',
        then(resolve) { window.modelSwitchWaiting = true; window.resolveAModelSwitch = resolve; },
      };
      window.pendingASettled = false;
      window.pendingAPromise = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.pendingASettled = true; });
    });
    await page.waitForFunction(() => window.modelSwitchWaiting === true);
    await page.evaluate(() => {
      const { sessions, chat } = window.testModules;
      sessions.setCurrentSessionId('chat-B');
      // Clear A's stale foreground Stop state, then prove B ignores A's tag.
      window.navigationReset = chat.handleChatSubmit({ preventDefault() {} });
      document.getElementById('message').value = 'B independent draft';
      window.messageSessions = [];
      window.messageBodies = [];
      window.independentBSettled = false;
      window.independentBPromise = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.independentBSettled = true; });
    });
    await page.waitForFunction(() => window.independentBSettled === true);
    assert.deepEqual(await page.evaluate(() => window.messageSessions), ['chat-B'], 'B send skips the unrelated held A switch');
    assert.equal(await page.evaluate(() => window.pendingASettled), false, 'B completes before A switch resolves');
    await page.evaluate(() => {
      document.getElementById('message').value = 'B pending draft';
      window.bModelSwitchWaiting = false;
      window.__odysseusModelSwitchPromise = {
        sessionId: 'chat-B',
        then(resolve) { window.bModelSwitchWaiting = true; window.resolveBModelSwitch = resolve; },
      };
      window.pendingBSettled = false;
      window.pendingBPromise = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.pendingBSettled = true; });
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
    assert.equal(pendingBAfterACancel.posts, 1, 'only the completed independent B send has posted');
    assert.equal(pendingBAfterACancel.busy, true, 'A cancellation preserves B pending-send busy state');
    await page.evaluate(() => {
      window.testModules.files.clearPending();
      window.resolveBModelSwitch();
    });
    await page.waitForFunction(() => window.pendingBSettled === true);
    assert.deepEqual(await page.evaluate(() => window.messageSessions), ['chat-B', 'chat-B'], 'B pending send continues after A cleanup');

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
        sessionId: 'chat-A',
        then(resolve) { window.modelSwitchWaiting = true; window.resolveModelSwitch = resolve; },
      };
      window.sameChatSettled = false;
      window.sameChatPromise = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.sameChatSettled = true; });
    });
    await page.waitForFunction(() => window.modelSwitchWaiting === true);
    assert.equal(await page.evaluate(() => window.sameChatSettled), false, 'same-owner A send waits for its tagged switch');
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

    // One-shot bubble state and regen file IDs belong to the send that
    // captured them, even if that send waits on another chat's switch.
    await page.evaluate(() => {
      const { sessions, chat } = window.testModules;
      sessions.setCurrentSessionId('chat-A');
      chat.setDisplayOverride('A ONLY DISPLAY');
      chat.setHideUserBubble();
      window.__odysseusModelSwitchPromise = {
        sessionId: 'chat-A',
        then(resolve) { window.modelSwitchWaiting = true; window.resolveAModelSwitch = resolve; },
      };
      window.modelSwitchWaiting = false;
      window.messageSessions = [];
      window.messageBodies = [];
      window.messageFileIds = [];
      window.sendButtonHandler = () => {
        window.aSendSettled = false;
        window.aSend = chat.handleChatSubmit({ preventDefault() { } }).finally(() => { window.aSendSettled = true; });
      };
      document.querySelector('.send-btn').addEventListener('click', window.sendButtonHandler);
      const history = document.getElementById('chat-history');
      history.innerHTML = '<div class="msg msg-user" data-raw="A regeneration prompt"><div class="body">A regeneration prompt</div><span data-file-id="A_ONLY_FILE_ID"></span></div>'
        + '<div class="msg msg-assistant" data-raw="Prior answer"><div class="body">Prior answer</div></div>';
      const ai = history.querySelector('.msg-assistant');
      window.regenerateA = chat.regenerateFrom(ai);
    });
    await page.waitForFunction(() => window.modelSwitchWaiting === true);
    await page.evaluate(() => {
      const { sessions, chat } = window.testModules;
      document.querySelector('.send-btn').removeEventListener('click', window.sendButtonHandler);
      sessions.setCurrentSessionId('chat-B');
      // The normal navigation path lets the newly visible chat detach A's
      // foreground UI before submitting its own message.
      window.navigationResetForOneShot = chat.handleChatSubmit({ preventDefault() {} });
      document.getElementById('message').value = 'B normal bubble';
      window.__odysseusModelSwitchPromise = null;
      window.independentBSettled = false;
      window.independentB = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.independentBSettled = true; });
    });
    await page.waitForFunction(() => window.independentBSettled === true);
    const isolatedOneShots = await page.evaluate(() => ({
      sessions: window.messageSessions,
      bodies: window.messageBodies,
      fileIds: window.messageFileIds,
      bubbleText: Array.from(document.querySelectorAll('#chat-history .msg-user .body')).at(-1)?.textContent || '',
    }));
    assert.deepEqual(isolatedOneShots.sessions, ['chat-B']);
    assert.deepEqual(isolatedOneShots.bodies, ['B normal bubble']);
    assert.deepEqual(isolatedOneShots.fileIds, [[]], 'A regen file IDs cannot leak into B payload');
    assert.equal(isolatedOneShots.bubbleText, 'B normal bubble', 'A hide/display state cannot affect B bubble');
    await page.evaluate(() => window.resolveAModelSwitch());
    await page.waitForFunction(() => window.aSendSettled === true);
    assert.deepEqual(await page.evaluate(() => window.messageSessions), ['chat-B'], 'navigated A regen cancels before POST');

    // A same-chat regeneration still sends its captured file ID.
    await page.evaluate(() => {
      const { sessions, chat } = window.testModules;
      sessions.setCurrentSessionId('chat-A');
      window.__odysseusModelSwitchPromise = null;
      window.messageSessions = [];
      window.messageBodies = [];
      window.messageFileIds = [];
      window.streamText = 'Synthetic regenerated answer';
      const history = document.getElementById('chat-history');
      history.innerHTML = '<div class="msg msg-user" data-raw="Same-chat regen"><div class="body">Same-chat regen</div><span data-file-id="SAME_CHAT_FILE_ID"></span></div>'
        + '<div class="msg msg-assistant" data-raw="Prior answer"><div class="body">Prior answer</div></div>';
      const ai = history.querySelector('.msg-assistant');
      window.regenSettled = false;
      window.regenSendHandler = () => {
        window.sameChatRegenSend = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.regenSettled = true; });
      };
      document.querySelector('.send-btn').addEventListener('click', window.regenSendHandler, { once: true });
      window.regenerateA = chat.regenerateFrom(ai);
    });
    await page.waitForFunction(() => window.regenSettled === true);
    const sameChatRegen = await page.evaluate(() => ({
      sessions: window.messageSessions,
      fileIds: window.messageFileIds[0],
    }));
    assert.deepEqual(sameChatRegen.sessions, ['chat-A']);
    assert.deepEqual(sameChatRegen.fileIds, ['SAME_CHAT_FILE_ID'], 'same-chat regen retains its original attachment ID');

    // Same-chat public one-shot helpers still affect their intended send.
    await page.evaluate(() => {
      const { sessions, chat } = window.testModules;
      sessions.setCurrentSessionId('chat-A');
      document.getElementById('chat-history').innerHTML = '';
      document.getElementById('message').value = 'Same-chat hidden continuation';
      chat.setHideUserBubble();
      chat.setPendingContinue(document.createElement('div'));
      window.__odysseusModelSwitchPromise = null;
      window.messageSessions = [];
      window.messageBodies = [];
      window.sameChatOneShotSettled = false;
      window.sameChatOneShot = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.sameChatOneShotSettled = true; });
    });
    await page.waitForFunction(() => window.sameChatOneShotSettled === true);
    assert.deepEqual(await page.evaluate(() => window.messageSessions), ['chat-A']);
    assert.equal(await page.evaluate(() => document.querySelector('#chat-history .msg-user')), null, 'same-chat hide state still suppresses its bubble');

    await page.evaluate(() => {
      const { sessions, chat } = window.testModules;
      sessions.setCurrentSessionId('chat-A');
      document.getElementById('chat-history').innerHTML = '';
      document.getElementById('message').value = 'Same-chat visible prompt';
      chat.setDisplayOverride('Same-chat visible override');
      window.messageSessions = [];
      window.sameChatDisplaySettled = false;
      window.sameChatDisplay = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.sameChatDisplaySettled = true; });
    });
    await page.waitForFunction(() => window.sameChatDisplaySettled === true);
    assert.equal(await page.locator('#chat-history .msg-user .body').textContent(), 'Same-chat visible override');

    // The route submitted to the backend must reflect the confirmed picker
    // choice made while this same-chat send was waiting.
    await page.evaluate(() => {
      const { sessions, chat } = window.testModules;
      sessions.setCurrentSessionId('chat-A');
      window.originalRouteGetters = {
        model: sessions.getCurrentModel,
        endpoint: sessions.getCurrentEndpointUrl,
      };
      window.routeFixture = { model: 'old-model', endpoint: 'http://old.example' };
      sessions.getCurrentModel = () => window.routeFixture.model;
      sessions.getCurrentEndpointUrl = () => window.routeFixture.endpoint;
      window.messageSessions = [];
      window.messageRoutes = [];
      document.getElementById('message').value = 'Confirm the new route';
      window.modelSwitchWaiting = false;
      window.__odysseusModelSwitchPromise = {
        sessionId: 'chat-A',
        then(resolve) { window.modelSwitchWaiting = true; window.resolveRouteSwitch = resolve; },
      };
      window.routeSendSettled = false;
      window.routeSend = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.routeSendSettled = true; });
    });
    await page.waitForFunction(() => window.modelSwitchWaiting === true);
    await page.evaluate(() => {
      window.routeFixture = { model: 'new-model', endpoint: 'http://new.example' };
      window.resolveRouteSwitch();
    });
    await page.waitForFunction(() => window.routeSendSettled === true);
    const routeAfterSwitch = await page.evaluate(() => ({
      session: window.messageSessions[0],
      route: window.messageRoutes[0],
    }));
    assert.equal(routeAfterSwitch.session, 'chat-A');
    assert.deepEqual(routeAfterSwitch.route, { model: 'new-model', endpointUrl: 'http://new.example' });
    await page.evaluate(() => {
      const { sessions } = window.testModules;
      sessions.getCurrentModel = window.originalRouteGetters.model;
      sessions.getCurrentEndpointUrl = window.originalRouteGetters.endpoint;
      window.__odysseusModelSwitchPromise = null;
    });

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
    console.log(JSON.stringify({ pass: true, mode: 'session-owned-model-switch', switched, pendingBAfterACancel, sameChat, isolatedOneShots, sameChatRegen, routeAfterSwitch, retry, pageErrors: errors }, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
