// Synthetic actual-module proof for stale Continue state during send preflight.
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
  import chat from '/js/chat.js'; import sessions from '/js/sessions.js'; import renderer from '/js/chatRenderer.js';
  window.modulesReady = Promise.all([chat, sessions, renderer]).then(() => { window.testModules = { chat, sessions, renderer }; });
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
    for (const uiPath of ['renderer-history', 'rounds-exhausted']) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.stack || error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await waitUntil(page, () => window.testModules);
      await page.evaluate(uiPath => {
        const { chat, sessions, renderer } = window.testModules;
        document.querySelector('.send-btn').addEventListener('click', () => {
          window.lastClickSend = chat.handleChatSubmit({ preventDefault() {} });
        });
        sessions.setCurrentSessionId('chat-A');
        window.__odysseusDefaultChat = { endpoint_url: 'http://fixture-model', model: 'fixture-model' };
        window.chatPosts = [];
        window.fetch = async (input, init = {}) => {
          const url = String(input);
          if (url.includes('/api/chat_stream')) {
            const message = init.body.get('message');
            window.chatPosts.push(message);
            if (message === 'Seed interrupted answer') {
              return new Response(
                'data: {"delta":"Old partial answer"}\n\ndata: {"type":"rounds_exhausted","rounds":5}\n\ndata: [DONE]\n\n',
                { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
              );
            }
            if (message === 'Unrelated next request') {
              return new Response('data: {"delta":"Answer to unrelated request"}\n\ndata: [DONE]\n\n', {
                status: 200, headers: { 'Content-Type': 'text/event-stream' },
              });
            }
            if (message === 'In-flight request A') {
              return new Response('data: {"delta":"Answer to in-flight request"}\n\ndata: [DONE]\n\n', {
                status: 200, headers: { 'Content-Type': 'text/event-stream' },
              });
            }
            if (message.includes('Continue from where you left off') || message.includes('You hit the step limit')) {
              return new Response('data: {"delta":"Answer to continued request"}\n\ndata: [DONE]\n\n', {
                status: 200, headers: { 'Content-Type': 'text/event-stream' },
              });
            }
            return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
          }
          return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
        if (uiPath === 'renderer-history') {
          window.oldHolder = renderer.addMessage('assistant', 'Old partial answer', 'fixture-model', { stopped: true });
        }
        window.makeHeldSwitch = () => {
          let resolve;
          const promise = new Promise(done => { resolve = done; });
          promise.sessionId = 'chat-A';
          window.__odysseusModelSwitchPromise = promise;
          window.resolveHeldSwitch = resolve;
        };
        if (uiPath === 'rounds-exhausted') {
          document.getElementById('message').value = 'Seed interrupted answer';
          window.seedDone = chat.handleChatSubmit({ preventDefault() {} });
        }
      }, uiPath);

      if (uiPath === 'rounds-exhausted') {
        await waitUntil(page, () => document.querySelector('.rounds-exhausted .continue-btn'));
        await page.evaluate(() => window.seedDone);
        await page.evaluate(() => {
          window.oldHolder = document.querySelector('#chat-history .msg-ai');
        });
      } else {
        await waitUntil(page, () => document.querySelector('.msg-ai .stopped-indicator .continue-btn'));
      }

      await page.evaluate(() => {
        document.getElementById('message').value = 'In-flight request A';
        window.makeHeldSwitch();
        window.aSettled = false;
        window.aSend = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.aSettled = true; });
      });
      await waitUntil(page, () => window.__odysseusChatBusy === true && document.querySelector('.send-btn').dataset.mode === 'streaming');
      const preClick = await page.evaluate(() => ({
        currentSession: window.testModules.sessions.getCurrentSessionId(),
        promiseSession: window.__odysseusModelSwitchPromise?.sessionId,
        promisePending: !!window.__odysseusModelSwitchPromise,
        composer: document.getElementById('message').value,
        posts: window.chatPosts.slice(),
      }));
      assert.equal(preClick.currentSession, 'chat-A');
      assert.equal(preClick.promiseSession, 'chat-A');
      assert.equal(preClick.promisePending, true);

      const continueSelector = uiPath === 'rounds-exhausted'
        ? '.rounds-exhausted .continue-btn'
        : '.msg-ai .stopped-indicator .continue-btn';
      await page.locator(continueSelector).click();
      const afterContinueClick = await page.evaluate(() => ({
        composer: document.getElementById('message').value,
        oldButtonRemains: !!document.querySelector('.continue-btn'),
        sendMode: document.querySelector('.send-btn').dataset.mode,
        posts: window.chatPosts.slice(),
      }));
      assert.equal(afterContinueClick.oldButtonRemains, true, `${uiPath}: busy Continue affordance should remain available`);
      assert.equal(afterContinueClick.composer, preClick.composer, `${uiPath}: busy Continue changed composer`);
      assert.equal(afterContinueClick.sendMode, 'streaming', `${uiPath}: busy Continue must not Stop A`);
      assert.deepEqual(afterContinueClick.posts, preClick.posts, `${uiPath}: busy Continue must not submit`);
      await page.evaluate(() => window.resolveHeldSwitch());
      await waitUntil(page, () => window.aSettled === true);
      assert.equal(await page.evaluate(() => window.chatPosts.includes('In-flight request A')), true, `${uiPath}: A should post after preflight resolves`);

      await page.evaluate(() => {
        window.__odysseusModelSwitchPromise = null;
        document.getElementById('message').value = 'Unrelated next request';
        window.bSettled = false;
        window.bSend = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.bSettled = true; });
      });
      await waitUntil(page, () => window.bSettled === true);
      const result = await page.evaluate(() => ({
        posts: window.chatPosts.slice(),
        oldRaw: window.oldHolder?.dataset.raw || '',
        holders: Array.from(document.querySelectorAll('#chat-history .msg-ai')).map(node => ({ raw: node.dataset.raw || '', text: node.textContent || '' })),
        unrelatedUserBubbles: Array.from(document.querySelectorAll('#chat-history .msg-user')).filter(node => node.dataset.raw === 'Unrelated next request').length,
        composer: document.getElementById('message').value,
      }));
      const expectedPosts = uiPath === 'rounds-exhausted'
        ? ['Seed interrupted answer', 'In-flight request A', 'Unrelated next request']
        : ['In-flight request A', 'Unrelated next request'];
      assert.deepEqual(result.posts, expectedPosts);
      assert.equal(result.oldRaw, 'Old partial answer', `${uiPath}: unrelated send must not consume Continue state`);
      assert.equal(result.unrelatedUserBubbles, 1, `${uiPath}: unrelated send should keep its user bubble`);
      assert.equal(result.holders.some(item => item.raw.includes('Answer to unrelated request')), true, `${uiPath}: unrelated response should keep its own holder`);

      await page.locator(continueSelector).click();
      await waitUntil(page, () => window.lastClickSend instanceof Promise);
      await page.evaluate(() => window.lastClickSend);
      const afterIdleContinue = await page.evaluate(() => ({
        oldRaw: window.oldHolder?.dataset.raw || '',
        continuedUserBubbles: Array.from(document.querySelectorAll('#chat-history .msg-user')).filter(node => node.dataset.raw && node.dataset.raw.includes('Continue')).length,
        unrelatedUserBubbles: Array.from(document.querySelectorAll('#chat-history .msg-user')).filter(node => node.dataset.raw === 'Unrelated next request').length,
        posts: window.chatPosts.slice(),
      }));
      assert.match(afterIdleContinue.oldRaw, /Old partial answer\n\n\*\(continued\)\*\n\nAnswer to continued request/);
      assert.equal(afterIdleContinue.continuedUserBubbles, 0, `${uiPath}: idle Continue should hide its own prompt bubble`);
      assert.equal(afterIdleContinue.unrelatedUserBubbles, 1, `${uiPath}: idle Continue must preserve B's visible bubble`);
      assert.equal(afterIdleContinue.posts.length, expectedPosts.length + 1);
      assert.deepEqual(errors, []);
      await page.close();
      console.log(uiPath.toUpperCase(), JSON.stringify({
        busyContinuePreservedButtonAndDraft: afterContinueClick.oldButtonRemains && afterContinueClick.composer === preClick.composer,
        busyContinueDidNotStopA: afterContinueClick.sendMode === 'streaming' && result.posts.includes('In-flight request A'),
        unrelatedSendKeptOwnHolderAndBubble: result.holders.some(item => item.raw.includes('Answer to unrelated request')) && result.unrelatedUserBubbles === 1,
        idleContinueMergedAndHidOnlyItsOwnBubble: /Answer to continued request/.test(afterIdleContinue.oldRaw) && afterIdleContinue.continuedUserBubbles === 0,
      }));
    }
    console.log(JSON.stringify({ pass: true }));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
