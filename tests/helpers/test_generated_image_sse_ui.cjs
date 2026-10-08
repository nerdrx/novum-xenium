// Real chat-module send lifecycle with a fixture SSE stream; no provider call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
let streamRequests = 0;
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9N8AAAAASUVORK5CYII=';
const generatedImage = { type: 'generated_image', image_url: pixel, image_id: 'fixture-image-1', image_prompt: 'fixture image', image_model: 'fixture-model' };
const stream = [
  `data: ${JSON.stringify({ delta: 'Image ready.' })}`,
  `data: ${JSON.stringify(generatedImage)}`,
  `data: ${JSON.stringify(generatedImage)}`,
  'data: [DONE]',
  '',
].join('\n\n');

const html = `<!doctype html><meta charset="utf-8">
<textarea id="message"></textarea><div id="attach-strip"></div><input id="file-input" type="file" multiple>
<input id="incognito-toggle" type="checkbox"><input id="web-toggle" type="checkbox"><input id="research-toggle" type="checkbox"><input id="bash-toggle" type="checkbox"><button id="research-toggle-btn"></button>
<div id="chat-history"></div><button class="send-btn"></button>
<script type="module">
  import chat from '/js/chat.js';
  import sessions from '/js/sessions.js';
  import files from '/js/fileHandler.js';
  window.modulesReady = Promise.all([chat, sessions, files]).then(() => { window.testModules = { chat, sessions, files }; });
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(html);
  }
  if (url.pathname === '/api/chat_stream') {
    streamRequests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    return res.end(stream);
  }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.waitForFunction(() => window.testModules);
    await page.evaluate(() => {
      const { chat, sessions } = window.testModules;
      sessions.setCurrentSessionId('fixture-image-session');
      document.getElementById('message').value = 'Make a fixture image';
      window.sendFinished = chat.handleChatSubmit({ preventDefault() {} });
    });
    await page.waitForFunction(() => document.querySelectorAll('#chat-history .generated-image-wrap').length === 1, null, { timeout: 10000 });
    await page.evaluate(() => window.sendFinished);
    await page.waitForFunction(() => /Image ready\.|ReferenceError|_isBg is not defined|Error:/.test(document.getElementById('chat-history').textContent), null, { timeout: 5000 });

    const result = await page.evaluate(() => {
      const history = document.getElementById('chat-history');
      return {
        currentSession: window.testModules.sessions.getCurrentSessionId(),
        images: history.querySelectorAll('.generated-image-wrap').length,
        imageSrc: history.querySelector('.generated-image')?.getAttribute('src') || null,
        prompt: history.querySelector('.generated-image-caption')?.textContent || null,
        errors: history.textContent.match(/ReferenceError|_isBg is not defined|\[Error:|Error:/g) || [],
        text: history.textContent,
      };
    });
    assert.equal(result.images, 1, 'generated image renders exactly once through SSE completion');
    assert.ok(streamRequests > 0, 'the mocked chat stream endpoint was reached');
    assert.equal(result.imageSrc, pixel, 'rendered image is the fixture SSE image');
    assert.equal(result.prompt, 'fixture image', 'image prompt is rendered');
    assert.deepEqual(result.errors, [], 'no ReferenceError or error bubble appears');
    assert.match(result.text, /Image ready\./, 'normal assistant response completes alongside the generated image');
    assert.deepEqual(pageErrors, [], 'no uncaught browser errors');
    console.log(JSON.stringify({ result: 'passed', streamRequests, currentSession: result.currentSession, images: result.images, prompt: result.prompt, renderedText: result.text.slice(-200), pageErrors, errorText: result.errors }));
    await page.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
