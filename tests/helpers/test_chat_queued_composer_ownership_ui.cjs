// Synthetic actual-module coverage for queued sends preserving later composer state.
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
const waitUntil = (page, fn) => page.waitForFunction(fn, null, { timeout: 8000 });

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    async function openPage() {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.stack || error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await waitUntil(page, () => window.testModules);
      await page.evaluate(() => {
        const { sessions, chat } = window.testModules;
        sessions.setCurrentSessionId('chat-A');
        window.__odysseusDefaultChat = { endpoint_url: 'http://fixture', model: 'fixture-model', endpoint_id: 'fixture-endpoint' };
        window.__odysseusModelSwitchPromise = null;
        window.messagePosts = [];
        window.uploadPosts = [];
        window.testModules.files.clearPending();
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init = {}) => {
          const url = String(input);
          if (url.includes('/api/upload')) {
            window.uploadPosts.push(url);
            return new Response(JSON.stringify({ files: [{ id: 'synthetic-file-id', name: 'later-file.txt' }] }), { status: 200 });
          }
          if (url.includes('/api/chat_stream')) {
            window.messagePosts.push({
              session: init.body.get('session'),
              message: init.body.get('message'),
              attachments: JSON.parse(init.body.get('attachments') || '[]'),
            });
            if (window.holdNextStream) {
              window.holdNextStream = false;
              return new Response(new ReadableStream({ start(controller) { window.streamController = controller; window.streamStarted = true; } }), {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream', 'X-Odysseus-Run-Id': 'synthetic-run' },
              });
            }
            return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
          }
          if (url.includes('/api/chat/stop/')) return new Response('{}', { status: 200 });
          if (url.includes('/api/default-chat')) return new Response(JSON.stringify(window.__odysseusDefaultChat), { status: 200 });
          if (url.includes('/api/session/') && url.includes('/truncate')) return new Response('{}', { status: 200 });
          return originalFetch(input, init);
        };
        window.testModules.files.clearPending();
        window.bindStopButton = () => document.querySelector('.send-btn').addEventListener('click', () => chat.handleChatSubmit({ preventDefault() {} }));
      });
      return { page, errors };
    }
    async function startHeld(page) {
      await page.evaluate(() => {
        document.getElementById('message').value = 'Active synthetic response';
        window.holdNextStream = true;
        window.streamStarted = false;
        window.activeSettled = false;
        window.activeSend = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.activeSettled = true; });
      });
      await waitUntil(page, () => window.streamStarted === true);
    }
    async function queueAndAddLaterContent(page, queuedText, draftText) {
      await page.evaluate(async ({ queuedText, draftText }) => {
        document.getElementById('message').value = queuedText;
        window.queueAccepted = window.testModules.chat.queueStreamingComposerRequest();
        await window.testModules.files.addFiles([new File(['synthetic later file'], 'later-file.txt', { type: 'text/plain' })], { skipCrop: true });
        document.getElementById('message').value = draftText;
      }, { queuedText, draftText });
      assert.equal(await page.evaluate(() => window.queueAccepted), true);
      assert.equal(await page.evaluate(() => window.testModules.files.getPendingCount()), 1);
    }
    async function finishActive(page) {
      await page.evaluate(() => {
        window.streamController.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        window.streamController.close();
      });
    }
    async function verifyQueued(page, queuedText, draftText, errors) {
      await waitUntil(page, () => window.messagePosts.length === 2);
      await waitUntil(page, () => window.__odysseusChatBusy === false);
      const result = await page.evaluate(() => ({
        posts: window.messagePosts,
        uploadCount: window.uploadPosts.length,
        composer: document.getElementById('message').value,
        pendingFiles: window.testModules.files.getPendingCount(),
      }));
      assert.deepEqual(result.posts.map(post => post.message), ['Active synthetic response', queuedText]);
      assert.deepEqual(result.posts[1].attachments, [], 'new composer files are excluded from queued dispatch');
      assert.equal(result.uploadCount, 0);
      assert.equal(result.composer, draftText, 'queued message does not overwrite the newer draft, even when text matches');
      assert.equal(result.pendingFiles, 1, 'new attachment stays pending with the draft');
      assert.deepEqual(errors, []);
      return result;
    }

    for (const draftText of ['Different newer draft', 'Same queued request']) {
      const { page, errors } = await openPage();
      await startHeld(page);
      await queueAndAddLaterContent(page, 'Same queued request', draftText);
      await finishActive(page);
      const result = await verifyQueued(page, 'Same queued request', draftText, errors);
      await page.close();
      if (draftText.startsWith('Different')) console.log('AUTO_DRAIN', JSON.stringify(result));
      else console.log('SAME_TEXT_DRAFT', JSON.stringify(result));
    }

    // A queued slash command also operates on its captured text without
    // clearing a newer composer draft or consuming later attachments.
    {
      const { page, errors } = await openPage();
      await startHeld(page);
      await queueAndAddLaterContent(page, '/chats --help', 'Draft after queued command');
      await finishActive(page);
      await waitUntil(page, () => !document.querySelector('.msg-user-queued') && window.__odysseusChatBusy === false);
      const result = await page.evaluate(() => ({
        postCount: window.messagePosts.length,
        uploadCount: window.uploadPosts.length,
        composer: document.getElementById('message').value,
        pendingFiles: window.testModules.files.getPendingCount(),
        history: document.getElementById('chat-history').textContent,
      }));
      assert.equal(result.postCount, 1, 'queued slash command does not dispatch an AI request');
      assert.equal(result.uploadCount, 0);
      assert.equal(result.composer, 'Draft after queued command');
      assert.equal(result.pendingFiles, 1);
      assert.match(result.history, /Manage chat sessions/);
      assert.deepEqual(errors, []);
      await page.close();
      console.log('QUEUED_SLASH', JSON.stringify({ ...result, history: 'help rendered' }));
    }

    // Explicit promotion stops the active response without erasing the draft or its later file.
    {
      const { page, errors } = await openPage();
      await page.evaluate(() => window.bindStopButton());
      await startHeld(page);
      await queueAndAddLaterContent(page, 'Promoted queued request', 'Draft before promotion');
      await page.locator('.msg-user-queued').click();
      const result = await verifyQueued(page, 'Promoted queued request', 'Draft before promotion', errors);
      await page.close();
      console.log('PROMOTION', JSON.stringify(result));
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
