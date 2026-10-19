// Synthetic actual-module coverage for bounded cold default-chat setup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
const html = `<!doctype html><meta charset="utf-8">
<textarea id="message"></textarea><div id="attach-strip"></div><input id="file-input" type="file" multiple>
<input id="incognito-toggle" type="checkbox"><input id="web-toggle" type="checkbox"><input id="research-toggle" type="checkbox"><input id="bash-toggle" type="checkbox"><button id="research-toggle-btn"></button>
<div id="chat-history"></div><button class="send-btn"></button><div id="toast"></div>
<script type="module">
  import chat from '/js/chat.js';
  import sessions from '/js/sessions.js';
  import files from '/js/fileHandler.js';
  window.modulesReady = Promise.all([chat, sessions, files]).then(() => {
    window.testModules = { chat, sessions, files };
  });
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(html);
  }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('Content-Type', (file.endsWith('.js') || file.endsWith('.mjs')) ? 'text/javascript' : 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    async function openPage() {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/fixture`);
      await page.waitForFunction(() => window.testModules);
      await page.evaluate(() => {
        const originalSetTimeout = window.setTimeout.bind(window);
        const originalClearTimeout = window.clearTimeout.bind(window);
        window.deadlineTimers = [];
        window.setTimeout = (callback, delay, ...args) => {
          if (delay === 15000) {
            const timer = { callback: () => callback(...args), delay, id: `deadline-${window.deadlineTimers.length + 1}`, cleared: false };
            window.deadlineTimers.push(timer);
            return timer.id;
          }
          return originalSetTimeout(callback, delay, ...args);
        };
        window.clearTimeout = id => {
          const timer = window.deadlineTimers.find(item => item.id === id);
          if (timer) { timer.cleared = true; return; }
          originalClearTimeout(id);
        };
        window.fireDefaultDeadline = () => window.deadlineTimers.at(-1)?.callback();
        window.__odysseusDefaultChat = null;
        localStorage.removeItem('odysseus-default-chat-cache');
        window.lookupMode = 'fetch-held';
        window.defaultChatCalls = [];
        window.sessionCreates = 0;
        window.chatPosts = 0;
        window.uploadPosts = 0;
        window.fetch = async (input, init = {}) => {
          const url = String(input);
          if (url.endsWith('/api/default-chat')) {
            const signal = init.signal;
            window.defaultChatCalls.push({ hasSignal: !!signal, timeoutMs: window.deadlineTimers.at(-1)?.delay });
            const abortPromise = () => new Promise((resolve, reject) => {
              if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
              signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
            if (window.lookupMode === 'fetch-held') return abortPromise();
            if (window.lookupMode === 'body-held') {
              return { ok: true, json: abortPromise };
            }
            if (window.lookupMode === 'success') {
              return new Response(JSON.stringify({ endpoint_url: 'http://fixture-model', model: 'fixture-model' }), { status: 200 });
            }
          }
          if (url.endsWith('/api/session') && init.method === 'POST') {
            window.sessionCreates += 1;
            return new Response(JSON.stringify({ id: `fixture-session-${window.sessionCreates}` }), { status: 200 });
          }
          if (url.includes('/api/upload')) {
            window.uploadPosts += 1;
            return new Response(JSON.stringify({ files: [{ id: 'synthetic-file-id', name: 'keep.txt' }] }), { status: 200 });
          }
          if (url.includes('/api/chat_stream')) {
            window.chatPosts += 1;
            return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
          }
          return new Response('{}', { status: 200 });
        };
      });
      return { page, errors };
    }
    async function beginFreshSend(page, draft) {
      await page.evaluate(async draft => {
        const { sessions, files, chat } = window.testModules;
        sessions.startFreshChat({ pushHistory: false });
        const input = document.getElementById('message');
        input.value = draft;
        await files.addFiles([new File(['synthetic pending file'], 'keep.txt', { type: 'text/plain' })]);
        window.submitDone = chat.handleChatSubmit({ preventDefault() {} });
      }, draft);
      await page.waitForFunction(() => window.defaultChatCalls.length > 0, null, { timeout: 5000 });
    }
    async function assertTimedOut(page, draft) {
      const before = await page.evaluate(() => ({
        call: window.defaultChatCalls.at(-1),
        inputDisabled: document.getElementById('message').disabled,
        busy: window.__odysseusChatBusy,
        pending: document.querySelector('.send-btn')?.classList.contains('send-pending'),
        timer: window.deadlineTimers.at(-1) && { delay: window.deadlineTimers.at(-1).delay, cleared: window.deadlineTimers.at(-1).cleared },
      }));
      assert.equal(before.call.hasSignal, true, 'lookup receives the deadline controller signal');
      assert.equal(before.call.timeoutMs, 15000, 'lookup registers the bounded 15-second deadline');
      assert.equal(before.inputDisabled, true);
      assert.equal(before.busy, true);
      assert.equal(before.pending, true);
      await page.evaluate(() => window.fireDefaultDeadline());
      await page.evaluate(() => window.submitDone);
      const after = await page.evaluate(() => ({
        composer: document.getElementById('message').value,
        files: window.testModules.files.getPendingCount(),
        inputDisabled: document.getElementById('message').disabled,
        busy: window.__odysseusChatBusy,
        pending: document.querySelector('.send-btn')?.classList.contains('send-pending'),
        timer: window.deadlineTimers.at(-1) && { delay: window.deadlineTimers.at(-1).delay, cleared: window.deadlineTimers.at(-1).cleared },
        guidance: document.getElementById('chat-history').textContent,
        uploads: window.uploadPosts,
      }));
      assert.equal(after.composer, draft, 'timeout retains submitted text');
      assert.equal(after.files, 1, 'timeout retains pending files');
      assert.equal(after.inputDisabled, false, 'timeout releases input');
      assert.equal(after.busy, false, 'timeout releases send gate');
      assert.equal(after.pending, false, 'timeout clears pending button state');
      assert.deepEqual(after.timer, { delay: 15000, cleared: true }, 'timeout clears its timer in finally');
      assert.equal(after.uploads, 0, 'failure does not upload pending files');
      assert.match(after.guidance, /still in the composer/i);
      return after;
    }

    for (const mode of ['fetch-held', 'body-held']) {
      const { page, errors } = await openPage();
      if (mode === 'body-held') await page.evaluate(() => { window.lookupMode = 'body-held'; });
      await beginFreshSend(page, `Draft survives ${mode}`);
      const result = await assertTimedOut(page, `Draft survives ${mode}`);
      assert.deepEqual(errors, [], `${mode}: no browser error`);

      // A retry after timeout proceeds through a successful lookup and send.
      await page.evaluate(() => { window.lookupMode = 'success'; window.__odysseusDefaultChat = null; });
      await page.evaluate(() => { window.submitDone = window.testModules.chat.handleChatSubmit({ preventDefault() {} }); });
      await page.waitForFunction(() => window.chatPosts === 1, null, { timeout: 8000 });
      await page.evaluate(() => window.submitDone);
      assert.equal(await page.locator('#message').inputValue(), '', 'successful retry clears submitted text at handoff');
      assert.equal(await page.evaluate(() => window.defaultChatCalls.length), 2, 'retry performs a fresh default lookup');
      assert.equal(await page.evaluate(() => window.sessionCreates), 1);
      await page.close();
      console.log(`TIMEOUT_${mode}`, JSON.stringify({ filesRetained: result.files, released: !result.busy, retryPosts: 1 }));
    }

    // If the original owner navigates away while the deadline is pending,
    // timeout cleanup must not inject an error into the new chat.
    {
      const { page, errors } = await openPage();
      await beginFreshSend(page, 'Draft from old chat');
      await page.evaluate(() => {
        window.testModules.sessions.startFreshChat({ pushHistory: false });
        document.getElementById('message').value = 'Draft in new chat';
        window.fireDefaultDeadline();
      });
      await page.evaluate(() => window.submitDone);
      const state = await page.evaluate(() => ({
        composer: document.getElementById('message').value,
        session: window.testModules.sessions.getCurrentSessionId(),
        creates: window.sessionCreates,
        posts: window.chatPosts,
        busy: window.__odysseusChatBusy,
        history: document.getElementById('chat-history').textContent,
        timerCleared: window.deadlineTimers.at(-1)?.cleared,
      }));
      assert.equal(state.composer, 'Draft in new chat');
      assert.equal(state.session, null);
      assert.equal(state.creates, 0, 'stale lookup cannot create a session in the new chat');
      assert.equal(state.posts, 0);
      assert.equal(state.busy, false);
      assert.equal(state.timerCleared, true);
      assert.doesNotMatch(state.history, /Could not load the default chat settings/i);
      assert.deepEqual(errors, []);
      await page.close();
      console.log('OWNER_CHANGED', JSON.stringify({ composer: state.composer, creates: state.creates, posts: state.posts, busy: state.busy }));
    }

    // A normal in-memory default cache bypasses the cold lookup and sends.
    {
      const { page, errors } = await openPage();
      await page.evaluate(() => {
        window.testModules.sessions.startFreshChat({ pushHistory: false });
        window.__odysseusDefaultChat = { endpoint_url: 'http://fixture-model', model: 'fixture-model' };
        document.getElementById('message').value = 'Cached default succeeds';
        window.submitDone = window.testModules.chat.handleChatSubmit({ preventDefault() {} });
      });
      await page.waitForFunction(() => window.chatPosts === 1, null, { timeout: 8000 });
      await page.evaluate(() => window.submitDone);
      assert.equal(await page.evaluate(() => window.defaultChatCalls.length), 0, 'cached config avoids cold lookup');
      assert.deepEqual(errors, []);
      await page.close();
      console.log('CACHED_DEFAULT', JSON.stringify({ defaultLookups: 0, chatPosts: 1 }));
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
