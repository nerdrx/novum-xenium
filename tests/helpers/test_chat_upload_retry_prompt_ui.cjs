// Synthetic chat-send regression for attachment upload retry draft retention.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
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
  if (url.pathname === '/api/chat_stream') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(''); }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    async function setup() {
      const page = await browser.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.stack || error.message));
      await page.goto(`${base}/fixture`);
      await page.waitForFunction(() => window.testModules);
      await page.evaluate(async () => {
        const { sessions, files } = window.testModules;
        sessions.setCurrentSessionId('fixture-session');
        await files.addFiles([new File(['safe synthetic bytes'], 'fixture.txt', { type: 'text/plain' })], { skipCrop: true });
        document.getElementById('message').value = 'Prompt to retry with file';
      });
      assert.equal(await page.evaluate(() => window.testModules.sessions.getCurrentSessionId()), 'fixture-session');
      return { page, errors };
    }
    async function finish(page) {
      await page.waitForFunction(() => !document.getElementById('message').disabled);
      await page.evaluate(() => window.submitDone);
    }

    // HTTP-style and network-style failures both leave the same file pending and restore text.
    for (const mode of ['http', 'network']) {
      const { page, errors } = await setup();
      await page.evaluate(mode => {
        const { chat, files } = window.testModules;
        files.uploadPending = async () => { window.uploadCalled = (window.uploadCalled || 0) + 1; if (mode === 'network') throw new Error('synthetic network failure'); return []; };
        files.wasLastUploadCancelled = () => false;
        window.submitDone = chat.handleChatSubmit({ preventDefault() {} });
      }, mode);
      await finish(page);
      const state = await page.evaluate(() => ({ text: document.getElementById('message').value, files: window.testModules.files.getPendingCount(), session: window.testModules.sessions.getCurrentSessionId(), uploadCalled: window.uploadCalled, history: document.getElementById('chat-history').innerText }));
      assert.equal(state.text, 'Prompt to retry with file', `${mode}: retry preserves text and attachment; ${JSON.stringify(state)}`);
      assert.equal(state.files, 1);
      assert.equal(state.session, 'fixture-session');
      assert.equal(state.uploadCalled, 1, `${mode}: fake upload was attempted`);
      assert.deepEqual(errors, [], `${mode}: no page errors`);
      await page.close();
    }

    // A draft typed while upload is pending wins over the older submitted text.
    {
      const { page, errors } = await setup();
      await page.evaluate(() => {
        const { chat, files } = window.testModules;
        files.uploadPending = () => new Promise(resolve => { window.finishUpload = () => resolve([]); });
        files.wasLastUploadCancelled = () => false;
        window.submitDone = chat.handleChatSubmit({ preventDefault() {} });
      });
      await page.waitForFunction(() => typeof window.finishUpload === 'function');
      await page.evaluate(() => { document.getElementById('message').value = 'Newer draft'; window.finishUpload(); });
      await finish(page);
      assert.equal(await page.locator('#message').inputValue(), 'Newer draft');
      assert.equal(await page.evaluate(() => window.testModules.files.getPendingCount()), 1);
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Switching chats while upload is pending must not inject the old prompt into the new chat.
    {
      const { page, errors } = await setup();
      await page.evaluate(() => {
        const { chat, files } = window.testModules;
        files.uploadPending = () => new Promise(resolve => { window.finishUpload = () => resolve([]); });
        files.wasLastUploadCancelled = () => false;
        window.submitDone = chat.handleChatSubmit({ preventDefault() {} });
      });
      await page.waitForFunction(() => typeof window.finishUpload === 'function');
      await page.evaluate(() => { window.testModules.sessions.setCurrentSessionId('other-session'); window.finishUpload(); });
      await finish(page);
      assert.equal(await page.locator('#message').inputValue(), '');
      assert.equal(await page.evaluate(() => window.testModules.files.getPendingCount()), 1);
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Intentional cancel suppresses the failure toast, but still keeps the retry text and attachment.
    {
      const { page, errors } = await setup();
      await page.evaluate(() => {
        const { chat, files } = window.testModules;
        files.uploadPending = async () => [];
        files.wasLastUploadCancelled = () => true;
        window.submitDone = chat.handleChatSubmit({ preventDefault() {} });
      });
      await finish(page);
      assert.equal(await page.locator('#message').inputValue(), 'Prompt to retry with file');
      assert.equal(await page.evaluate(() => window.testModules.files.getPendingCount()), 1);
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Success consumes the submitted files and continues sending without restoring text.
    {
      const { page, errors } = await setup();
      await page.evaluate(() => {
        const { chat, files } = window.testModules;
        files.uploadPending = async () => { files.clearPending(); return ['fixture-upload-id']; };
        files.getLastUploadedMeta = () => [{ id: 'fixture-upload-id', name: 'fixture.txt' }];
        window.submitDone = chat.handleChatSubmit({ preventDefault() {} });
      });
      await finish(page);
      assert.equal(await page.locator('#message').inputValue(), '');
      assert.equal(await page.evaluate(() => window.testModules.files.getPendingCount()), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
    const evidenceDir = process.env.EVIDENCE_DIR || os.tmpdir();
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'attachment-recovery-results.json'), JSON.stringify({
      result: 'PASS',
      syntheticOnly: true,
      cases: ['HTTP-style failure restores submitted prompt and retains attachment', 'network rejection restores submitted prompt and retains attachment', 'newer composer text is preserved', 'session switch prevents old prompt restoration', 'cancel retains prompt and attachment without failure toast', 'success clears attachment and does not restore submitted prompt'],
      realUploads: false,
      modelInference: false,
    }, null, 2));
    console.log('PASS synthetic upload retry prompt, newer-draft, switched-chat, cancel, and success cases');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
