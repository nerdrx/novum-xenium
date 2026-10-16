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
<div id="chat-history"></div><div id="toast"></div><button class="send-btn"></button>
<script type="module">
  import chat from '/js/chat.js';
  import sessions from '/js/sessions.js';
  import markdown from '/js/markdown.js';
  import files from '/js/fileHandler.js';
  window.modulesReady = Promise.all([chat, sessions, files]).then(() => {
    window.testModules = { chat, sessions, markdown, files };
  });
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('Content-Type', /\.(?:m?js)$/.test(file) ? 'text/javascript; charset=utf-8' : 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    try {
      await page.waitForFunction(() => window.testModules, null, { timeout: 20000 });
    } catch (error) {
      throw new Error(`${error.message}; page errors: ${pageErrors.join(' | ')}`);
    }

    await page.evaluate(() => {
      const { chat, sessions } = window.testModules;
      const nativeFetch = window.fetch.bind(window);
      window.resumeFixtures = new Map();
      window.resumeResults = new Map();
      window.fetch = (input, init) => {
        if (!String(input).includes('/api/chat/resume/')) return nativeFetch(input, init);
        let controller;
        const body = new ReadableStream({ start(streamController) { controller = streamController; } });
        const sessionId = String(input).split('/').pop();
        window.resumeFixtures.set(sessionId, { controller, settled: false });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { 'X-Odysseus-Run-Id': 'resume-format-run' },
        }));
      };
      window.startResumeFixture = sessionId => {
        sessions.setCurrentSessionId(sessionId);
        const result = chat.resumeStream(sessionId).then(value => {
          const fixture = window.resumeFixtures.get(sessionId);
          if (fixture) fixture.settled = true;
          return value;
        });
        window.resumeResults.set(sessionId, result);
      };
    });

    const scenario = process.argv[2];
    if (scenario === 'late') {
      const result = await page.evaluate(async () => {
        const { chat, sessions } = window.testModules;
        let finishFetch, signal;
        window.fetch = (_url, options) => { signal = options.signal; return new Promise(resolve => { finishFetch = resolve; }); };
        sessions.setCurrentSessionId('late-A');
        const pending = chat.resumeStream('late-A');
        sessions.setCurrentSessionId('late-B');
        chat.detachCurrentStream('late-A');
        finishFetch(new Response(''));
        return { attached: await pending, aborted: signal.aborted, active: chat.hasActiveStream('late-A'), bubbles: document.querySelectorAll('.msg-ai').length };
      });
      assert.deepEqual(result, { attached: false, aborted: true, active: false, bubbles: 0 });
    } else if (scenario === 'reader') {
      await page.evaluate(() => window.startResumeFixture('reader-A'));
      await page.waitForSelector('.msg-ai');
      const result = await page.evaluate(async () => {
        const { chat, sessions } = window.testModules;
        const activeBefore = chat.hasActiveStream('reader-A');
        sessions.setCurrentSessionId('reader-B');
        chat.detachCurrentStream('reader-A');
        await window.resumeResults.get('reader-A');
        return { activeBefore, activeAfter: chat.hasActiveStream('reader-A'), bubbles: document.querySelectorAll('.msg-ai').length };
      });
      assert.deepEqual(result, { activeBefore: true, activeAfter: false, bubbles: 0 });
    } else if (scenario === 'persona') {
      await page.evaluate(() => window.startResumeFixture('persona-A'));
      await page.waitForSelector('.msg-ai .role');
      await page.evaluate(() => {
        window.personaTimestamp = document.querySelector('.role-timestamp');
        const controller = window.resumeFixtures.get('persona-A').controller;
        for (const event of [
          { type: 'model_info', model: 'route-model', character_name: 'Mira' },
          { delta: '<think>Reasoned.</think>Hello from Mira.' },
        ]) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      });
      await page.waitForFunction(() => document.querySelector('.role')?.textContent.includes('Mira') && document.querySelector('.body')?.textContent.includes('Hello from Mira.'));
      const result = await page.evaluate(async () => {
        const controller = window.resumeFixtures.get('persona-A').controller;
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close();
        await window.resumeResults.get('persona-A');
        const holder = document.querySelector('.msg-ai');
        return { role: holder.querySelector('.role').textContent, timestampPreserved: holder.querySelector('.role-timestamp') === window.personaTimestamp,
          text: holder.querySelector('.body').textContent, thoughts: holder.querySelector('.thinking-content-inner')?.textContent, active: window.testModules.chat.hasActiveStream('persona-A') };
      });
      assert.match(result.role, /^Mira /); assert.equal(result.timestampPreserved, true);
      assert.match(result.text, /Hello from Mira/); assert.match(result.thoughts, /Reasoned/); assert.equal(result.active, false);
    } else throw Error('Unknown lifecycle scenario');
    assert.deepEqual(pageErrors, []);
    console.log(`PASS resume lifecycle ${scenario}`);
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
