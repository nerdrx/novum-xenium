// Reproduce a held resume response arriving after a newer send in the same chat.
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
<script type="module">import chat from '/js/chat.js'; import sessions from '/js/sessions.js'; import files from '/js/fileHandler.js?v=20260909mobileattachmentedit1';
window.modulesReady = Promise.all([chat, sessions, files]).then(() => { window.testModules = { chat, sessions, files }; }).catch(e => { window.moduleError = String(e.stack || e); });</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/auth/status') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ configured: false, authenticated: false, username: null }));
  }
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
  if (url.pathname === '/js/chat.js') {
    const source = fs.readFileSync(file, 'utf8') + "\nwindow.testResumeSetIdle = () => updateSubmitButton('idle', document.querySelector('.send-btn'));";
    return res.end(source);
  }
  fs.createReadStream(file).pipe(res);
});
const waitUntil = (page, expression) => page.waitForFunction(expression, null, { timeout: 7000 });

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    try { await waitUntil(page, () => window.testModules || window.moduleError); }
    catch (error) { throw new Error(`${error.message}; module=${await page.evaluate(() => window.moduleError || '')}; errors=${JSON.stringify(errors)}`); }
    const moduleError = await page.evaluate(() => window.moduleError || '');
    assert.equal(moduleError, '');
    await page.evaluate(() => {
      const { chat, sessions } = window.testModules;
      sessions.setCurrentSessionId('chat-A');
      window.__odysseusDefaultChat = { endpoint_url: 'http://fixture', model: 'fixture-model', endpoint_id: 'fixture-endpoint' };
      window.stopIds = [];
      window.resumeHeaders = null;
      window.resolveResume = null;
      window.streamController = null;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const url = String(input);
        if (url.includes('/api/chat/resume/chat-A')) return new Promise(resolve => { window.resolveResume = resolve; });
        if (url.includes('/api/chat_stream')) return new Response(new ReadableStream({ start(controller) { window.streamController = controller; } }), {
          status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Odysseus-Run-Id': 'new-run' },
        });
        if (url.includes('/api/chat/stop/chat-A')) {
          window.stopIds.push(new Headers(init.headers).get('X-Odysseus-Run-Id'));
          return Promise.resolve(new Response('{}', { status: 200 }));
        }
        if (url.includes('/api/default-chat')) return Promise.resolve(new Response(JSON.stringify(window.__odysseusDefaultChat), { status: 200 }));
        return originalFetch(input, init);
      };
      window.resumePromise = chat.resumeStream('chat-A');
      document.getElementById('message').value = 'latest send';
      window.sendPromise = chat.handleChatSubmit({ preventDefault() {} });
    });
    await waitUntil(page, () => !!window.streamController);
    await page.evaluate(() => { document.getElementById('message').value = 'latest unsent draft'; });
    await page.evaluate(() => window.resolveResume(new Response('data: [DONE]\n\n', {
      status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Odysseus-Run-Id': 'old-run' },
    })));
    await page.evaluate(() => window.resumePromise);
    const afterResume = await page.evaluate(() => ({
      draft: document.getElementById('message').value,
      mode: document.querySelector('.send-btn').dataset.mode || '',
      busy: window.__odysseusChatBusy,
    }));
    await page.evaluate(() => window.testModules.chat.abortCurrentRequest(true));
    await page.waitForFunction(() => window.stopIds.length > 0);
    assert.equal(afterResume.draft, 'latest unsent draft');
    assert.equal(afterResume.mode, 'streaming', 'stale resume must not idle the newer send');
    assert.equal(afterResume.busy, true, 'stale resume must not clear newer busy state');
    assert.deepEqual(await page.evaluate(() => window.stopIds), ['new-run'], 'Stop must target the new send run id');
    await page.evaluate(() => window.streamController?.close());

    // A resume can also have installed its reader before the replacement send.
    // Cancelling that reader must not let its cleanup idle the newer send.
    await page.reload();
    await waitUntil(page, () => window.testModules || window.moduleError);
    assert.equal(await page.evaluate(() => window.moduleError || ''), '');
    await page.evaluate(() => {
      const { chat, sessions } = window.testModules;
      sessions.setCurrentSessionId('chat-A');
      window.__odysseusDefaultChat = { endpoint_url: 'http://fixture', model: 'fixture-model', endpoint_id: 'fixture-endpoint' };
      window.stopIds = [];
      window.streamController = null;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const url = String(input);
        if (url.includes('/api/chat/resume/chat-A')) return Promise.resolve(new Response(new ReadableStream({ start() {} }), {
          status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Odysseus-Run-Id': 'old-run' },
        }));
        if (url.includes('/api/chat_stream')) return new Response(new ReadableStream({ start(controller) { window.streamController = controller; } }), {
          status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Odysseus-Run-Id': 'new-run' },
        });
        if (url.includes('/api/chat/stop/chat-A')) {
          window.stopIds.push(new Headers(init.headers).get('X-Odysseus-Run-Id'));
          return Promise.resolve(new Response('{}', { status: 200 }));
        }
        if (url.includes('/api/default-chat')) return Promise.resolve(new Response(JSON.stringify(window.__odysseusDefaultChat), { status: 200 }));
        return originalFetch(input, init);
      };
      window.resumePromise = chat.resumeStream('chat-A');
    });
    await waitUntil(page, () => !!document.querySelector('#chat-history .msg-ai .role'));
    await page.evaluate(() => {
      // Model the composer becoming sendable without sending a server Stop.
      // Keep the resumed reader alive so the new send cancels its local view.
      window.testResumeSetIdle();
      document.getElementById('message').value = 'replacement send';
      window.sendPromise = window.testModules.chat.handleChatSubmit({ preventDefault() {} });
    });
    await waitUntil(page, () => !!window.streamController);
    await page.evaluate(() => { document.getElementById('message').value = 'replacement draft'; });
    await waitUntil(page, () => window.testModules.chat.hasActiveStream('chat-A'));
    await page.evaluate(() => window.resumePromise);
    const afterReaderCancel = await page.evaluate(() => ({
      draft: document.getElementById('message').value,
      mode: document.querySelector('.send-btn').dataset.mode || '',
      busy: window.__odysseusChatBusy,
    }));
    await page.evaluate(() => window.testModules.chat.abortCurrentRequest(true));
    await page.waitForFunction(() => window.stopIds.length > 0);
    assert.equal(afterReaderCancel.draft, 'replacement draft');
    assert.equal(afterReaderCancel.mode, 'streaming', 'cancelled reader cleanup must not idle replacement send');
    assert.equal(afterReaderCancel.busy, true, 'cancelled reader cleanup must preserve replacement busy state');
    assert.deepEqual(await page.evaluate(() => window.stopIds), ['new-run']);
    await page.evaluate(() => window.streamController?.close());
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ pass: true, afterHeaders: afterResume, afterReaderCancel, stopIds: await page.evaluate(() => window.stopIds), pageErrors: errors }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
