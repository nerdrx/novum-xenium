// Synthetic actual-module regressions for resend/regenerate/edit ownership.
// Uses only deferred fake truncate responses and synthetic session/message data.
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
  import chat from '/js/chat.js'; import sessions from '/js/sessions.js';
  window.modulesReady = Promise.all([chat, sessions]).then(() => { window.testModules = { chat, sessions }; });
</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/auth/status') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ configured: false, authenticated: false, username: null }));
  }
  if (url.pathname === '/fixture') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

async function openPage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  await page.waitForFunction(() => window.testModules);
  await page.evaluate(() => {
    const { sessions } = window.testModules;
    window.putMessages = (sessionId, html) => {
      sessions.setCurrentSessionId(sessionId);
      document.getElementById('chat-history').innerHTML = html;
    };
    window.sendSnapshots = [];
    document.querySelector('.send-btn').click = () => window.sendSnapshots.push({
      session: sessions.getCurrentSessionId(), text: document.getElementById('message').value,
    });
    window.truncates = [];
    window.truncateMode = 'held';
    window.fetch = (input, init = {}) => {
      if (String(input).includes('/truncate')) {
        return new Promise(resolve => window.truncates.push({
          url: String(input), body: init.body,
          resolve: status => resolve(new Response('{}', { status })),
        }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
  });
  return page;
}

async function waitFor(page, expression) { await page.waitForFunction(expression); }
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    // Deferred A resend must not overwrite B's composer or dispatch in B.
    const stale = await openPage(browser);
    await stale.evaluate(() => {
      window.putMessages('chat-A', '<div class="msg msg-user" data-raw="A prompt"><div class="body">A prompt</div></div>');
      const bubble = document.querySelector('.msg-user');
      window.done = false;
      window.operation = window.testModules.chat.resendUserMessage(bubble).finally(() => { window.done = true; });
    });
    await waitFor(stale, () => window.truncates.length === 1);
    await stale.evaluate(() => {
      window.putMessages('chat-B', '<div class="msg msg-user" data-raw="B history"><div class="body">B history</div></div>');
      document.getElementById('message').value = 'B draft';
      window.truncates[0].resolve(200);
    });
    await waitFor(stale, () => window.done);
    const staleResult = await stale.evaluate(() => ({
      session: window.testModules.sessions.getCurrentSessionId(), draft: document.getElementById('message').value,
      history: document.getElementById('chat-history').textContent, sends: window.sendSnapshots,
    }));
    assert.equal(staleResult.session, 'chat-B');
    assert.equal(staleResult.draft, 'B draft', 'late A completion preserves B draft');
    assert.match(staleResult.history, /B history/);
    assert.deepEqual(staleResult.sends, []);
    await stale.close();

    // Deferred A regeneration must not replace B's composer or consume its send button.
    const staleRegen = await openPage(browser);
    await staleRegen.evaluate(() => {
      window.putMessages('chat-A', '<div class="msg msg-user" data-raw="A prompt"><div class="body">A prompt</div></div><div class="msg msg-ai"><div class="body">A answer</div></div>');
      window.done = false;
      window.operation = window.testModules.chat.regenerateFrom(document.querySelector('.msg-ai')).finally(() => { window.done = true; });
    });
    await waitFor(staleRegen, () => window.truncates.length === 1);
    await staleRegen.evaluate(() => {
      window.putMessages('chat-B', '<div class="msg msg-user" data-raw="B history"><div class="body">B history</div></div>');
      document.getElementById('message').value = 'B draft';
      window.truncates[0].resolve(200);
    });
    await waitFor(staleRegen, () => window.done);
    const staleRegenResult = await staleRegen.evaluate(() => ({
      session: window.testModules.sessions.getCurrentSessionId(), draft: document.getElementById('message').value,
      history: document.getElementById('chat-history').textContent, sends: window.sendSnapshots,
    }));
    assert.equal(staleRegenResult.session, 'chat-B');
    assert.equal(staleRegenResult.draft, 'B draft');
    assert.match(staleRegenResult.history, /B history/);
    assert.deepEqual(staleRegenResult.sends, []);
    await staleRegen.close();

    // Same-session resend remains functional after ownership checks.
    const same = await openPage(browser);
    await same.evaluate(() => {
      window.putMessages('chat-A', '<div class="msg msg-user" data-raw="same A"><div class="body">same A</div></div>');
      window.done = false;
      window.operation = window.testModules.chat.resendUserMessage(document.querySelector('.msg-user')).finally(() => { window.done = true; });
    });
    await waitFor(same, () => window.truncates.length === 1);
    await same.evaluate(() => window.truncates[0].resolve(200));
    await waitFor(same, () => window.done);
    assert.deepEqual(await same.evaluate(() => window.sendSnapshots), [{ session: 'chat-A', text: 'same A' }]);
    await same.close();

    // Canceling an edit invalidates its detached editor/save handler.
    const canceled = await openPage(browser);
    await canceled.evaluate(() => {
      window.putMessages('chat-A', '<div class="msg msg-user" data-raw="cancel A"><div class="body">cancel A</div></div>');
      window.testModules.chat.editUserMessage(document.querySelector('.msg-user'));
      window.oldSaveButton = document.querySelector('.edit-save-btn');
      document.querySelector('.edit-cancel-btn').click();
      window.oldSaveButton.click();
    });
    await canceled.waitForTimeout(50);
    assert.equal(await canceled.evaluate(() => window.truncates.length), 0, 'canceled edit cannot issue a late truncate');
    await canceled.close();

    // Edit opened in A, then disconnected by navigation: clicking stale Save must not truncate.
    const disconnected = await openPage(browser);
    await disconnected.evaluate(() => {
      window.putMessages('chat-A', '<div class="msg msg-user" data-raw="edit A"><div class="body">edit A</div></div>');
      window.editBubble = document.querySelector('.msg-user');
      window.editPromise = window.testModules.chat.editUserMessage(window.editBubble);
    });
    await disconnected.locator('.edit-textarea').fill('edited A');
    await disconnected.evaluate(() => {
      window.putMessages('chat-B', '<div class="msg msg-user" data-raw="B history"><div class="body">B history</div></div>');
      document.getElementById('message').value = 'B draft';
      window.editBubble.querySelector('.edit-save-btn').click();
    });
    await disconnected.waitForTimeout(50);
    const disconnectedResult = await disconnected.evaluate(() => ({
      session: window.testModules.sessions.getCurrentSessionId(), requests: window.truncates.length,
      draft: document.getElementById('message').value, sends: window.sendSnapshots,
    }));
    assert.equal(disconnectedResult.session, 'chat-B');
    assert.equal(disconnectedResult.requests, 0, 'disconnected edit does not issue truncate');
    assert.equal(disconnectedResult.draft, 'B draft');
    assert.deepEqual(disconnectedResult.sends, []);
    await disconnected.close();

    // Failed truncate responses for edit/regenerate keep history and composer and do not send.
    const failed = await openPage(browser);
    await failed.evaluate(() => {
      window.putMessages('chat-A', '<div class="msg msg-user" data-raw="A prompt"><div class="body">A prompt</div></div><div class="msg msg-ai"><div class="body">A answer</div></div>');
      window.originalHistory = document.getElementById('chat-history').innerHTML;
      window.regenDone = false;
      window.regenPromise = window.testModules.chat.regenerateFrom(document.querySelector('.msg-ai')).finally(() => { window.regenDone = true; });
    });
    await waitFor(failed, () => window.truncates.length === 1);
    await failed.evaluate(() => window.truncates[0].resolve(503));
    await waitFor(failed, () => window.regenDone);
    const failedRegen = await failed.evaluate(() => ({
      historySame: document.getElementById('chat-history').innerHTML === window.originalHistory,
      sends: window.sendSnapshots, composer: document.getElementById('message').value,
    }));
    assert.equal(failedRegen.historySame, true);
    assert.deepEqual(failedRegen.sends, []);

    await failed.evaluate(() => {
      const userBubble = document.querySelector('.msg-user');
      window.editOriginalHTML = userBubble.querySelector('.body').innerHTML;
      window.testModules.chat.editUserMessage(userBubble);
      document.getElementById('message').value = 'keep A draft';
    });
    await failed.locator('.edit-textarea').fill('edited A');
    await failed.locator('.edit-save-btn').click();
    await waitFor(failed, () => window.truncates.length === 2);
    await failed.evaluate(() => window.truncates[1].resolve(503));
    await failed.waitForFunction(() => document.querySelector('.edit-textarea')?.value === 'edited A');
    const failedEdit = await failed.evaluate(() => ({
      history: document.getElementById('chat-history').textContent,
      composer: document.getElementById('message').value,
      sends: window.sendSnapshots,
      editorDraft: document.querySelector('.edit-textarea')?.value,
      canRetry: !!document.querySelector('.edit-save-btn')?.isConnected,
      canCancel: !!document.querySelector('.edit-cancel-btn')?.isConnected,
    }));
    assert.match(failedEdit.history, /A answer/);
    assert.equal(failedEdit.composer, 'keep A draft');
    assert.deepEqual(failedEdit.sends, []);
    assert.equal(failedEdit.editorDraft, 'edited A');
    assert.equal(failedEdit.canRetry, true);
    assert.equal(failedEdit.canCancel, true);
    await failed.locator('.edit-cancel-btn').click();
    assert.equal(await failed.locator('.msg-user .body').textContent(), 'A prompt', 'Cancel still restores original message');
    await failed.close();
    console.log(JSON.stringify({ pass: true, mode: 'resend-session-ownership', staleResult, staleRegenResult, failedRegen, failedEdit }, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
