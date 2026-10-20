// Reproduce stale network-first module fallback at the canonical picker URL.
// chat.js/dependencies are current; the picker fixture omits the new named getter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
const currentPickerSource = fs.readFileSync(path.join(staticRoot, 'js/modelPicker.js'), 'utf8');
const legacyPickerSource = currentPickerSource.replace(
  /export function getPendingModelSwitch\(sessionId\)\s*\{\s*return sessionId \? _modelPickQueues\.get\(sessionId\) \|\| null : null;\s*\}\s*/,
  '',
);
if (legacyPickerSource === currentPickerSource) throw new Error('Expected picker getter export was not found');
let useStaleModelPicker = true;
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
  if (url.pathname === '/api/auth/status') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ configured: false, authenticated: false, username: null }));
  }
  if (url.pathname === '/fixture') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname === '/js/modelPicker.js' && useStaleModelPicker) {
    res.setHeader('Content-Type', 'text/javascript');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(legacyPickerSource);
  }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const url = `http://127.0.0.1:${server.address().port}/fixture`;
    const stalePage = await browser.newPage();
    stalePage.setDefaultTimeout(7000);
    const staleErrors = [];
    stalePage.on('pageerror', error => staleErrors.push(error.stack || error.message));
    await stalePage.goto(url);
    await stalePage.waitForFunction(() => window.testModules);
    await stalePage.evaluate(async () => {
      const { chat, sessions } = window.testModules;
      sessions.setCurrentSessionId('chat-A');
      document.getElementById('message').value = 'A synthetic prompt';
      window.chatRequests = [];
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const target = String(input);
        if (target.includes('/api/chat_stream')) window.chatRequests.push(target);
        return nativeFetch(input, init);
      };
      window.__odysseusModelSwitchPromise = {
        sessionId: 'chat-A',
        then(resolve) { window.switchWaiting = true; window.resolveSwitch = resolve; },
      };
      window.sendDone = false;
      window.sendPromise = chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.sendDone = true; });
    });
    await stalePage.waitForFunction(() => window.switchWaiting === true);
    await stalePage.evaluate(() => {
      window.testModules.sessions.setCurrentSessionId('chat-B');
      document.getElementById('message').value = 'B draft';
      window.resolveSwitch();
    });
    await stalePage.waitForFunction(() => window.sendDone === true);
    const staleResult = await stalePage.evaluate(() => ({
      composer: document.getElementById('message').value,
      chatRequests: window.chatRequests,
      pickerGetter: typeof window.testModules.chat === 'object',
    }));
    assert.equal(staleResult.composer, 'B draft', 'legacy tagged global fallback waits and cancels stale A send safely');
    assert.deepEqual(staleResult.chatRequests, []);
    assert.equal(staleResult.pickerGetter, true);
    assert.deepEqual(staleErrors, []);
    await stalePage.close();

    useStaleModelPicker = false;
    const currentPage = await browser.newPage();
    const currentErrors = [];
    currentPage.on('pageerror', error => currentErrors.push(error.stack || error.message));
    await currentPage.goto(url);
    await currentPage.waitForFunction(() => window.testModules, { timeout: 7000 });
    assert.deepEqual(currentErrors, [], 'same current module graph also loads normally');
    await currentPage.close();
    console.log(JSON.stringify({ pass: true, mode: 'canonical-stale-picker-module', staleResult, currentModuleLoaded: true }, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
