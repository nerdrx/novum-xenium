// Hidden browser regression for draft retention when automatic session setup fails.
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
<div id="chat-history"></div><button class="send-btn"></button>
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
  if (url.pathname === '/api/chat_stream') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    return res.end('');
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
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const failures = ['absent', 'invalid', 'malformed', 'nonok', 'network'];
    for (const scenario of failures) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/default-chat', async route => {
        if (scenario === 'network') return route.abort();
        if (scenario === 'nonok') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ endpoint_url: 'https://example.invalid', model: 'must-not-use' }) });
        if (scenario === 'invalid') return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
        if (scenario === 'malformed') return route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      await page.goto(`${base}/fixture`);
      await page.waitForFunction(() => window.testModules);
      await page.evaluate(async scenario => {
        const { chat, files } = window.testModules;
        localStorage.removeItem('odysseus-default-chat-cache');
        const input = document.getElementById('message');
        input.value = `Draft for ${scenario}`;
        await files.addFiles([new File(['fixture'], 'keep.txt', { type: 'text/plain' })]);
        window.submitDone = chat.handleChatSubmit({ preventDefault() {} });
      }, scenario);
      await page.waitForFunction(() => !document.getElementById('message').disabled);
      await page.evaluate(() => window.submitDone);
      const result = await page.evaluate(() => ({
        value: document.getElementById('message').value,
        attachments: window.testModules.files.getPendingCount(),
        guidance: document.getElementById('chat-history').textContent,
      }));
      assert.equal(result.value, `Draft for ${scenario}`, `${scenario}: composer text retained`);
      assert.equal(result.attachments, 1, `${scenario}: pending attachment retained`);
      assert.match(result.guidance, /still in the composer/i, `${scenario}: clear failure guidance`);
      if (scenario === 'nonok' || scenario === 'network' || scenario === 'malformed') assert.match(result.guidance, /Could not load the default chat settings/i);
      else assert.match(result.guidance, /No default chat model is configured/i);
      assert.deepEqual(errors, [], `${scenario}: no browser errors`);
      await page.close();
    }

    const heldPage = await browser.newPage();
    await heldPage.goto(`${base}/fixture`);
    await heldPage.waitForFunction(() => window.testModules);
    let finishDefaultLoad;
    await heldPage.route('**/api/default-chat', route => new Promise(resolve => {
      finishDefaultLoad = () => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }).then(resolve);
    }));
    await heldPage.evaluate(() => {
      document.getElementById('message').value = 'Submitted before setup';
      window.submitDone = window.testModules.chat.handleChatSubmit({ preventDefault() {} });
    });
    await heldPage.waitForFunction(() => document.getElementById('message').disabled);
    await heldPage.evaluate(() => { document.getElementById('message').value = 'Newer composer draft'; });
    assert.equal(typeof finishDefaultLoad, 'function', 'default route request is pending');
    await finishDefaultLoad();
    await heldPage.evaluate(() => window.submitDone);
    assert.equal(await heldPage.locator('#message').inputValue(), 'Newer composer draft', 'failure does not erase a newer composer value');
    await heldPage.close();

    const page = await browser.newPage();
    await page.goto(`${base}/fixture`);
    await page.waitForFunction(() => window.testModules);
    let posted = false;
    let resolvePost;
    const postedRequest = new Promise(resolve => { resolvePost = resolve; });
    await page.route('**/api/chat_stream', async route => {
      posted = true; resolvePost();
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    await page.evaluate(async () => {
      const { chat, sessions } = window.testModules;
      sessions.setCurrentSessionId('fixture-session');
      document.getElementById('message').value = 'Successful submitted draft';
      window.submitDone = chat.handleChatSubmit({ preventDefault() {} });
    });
    await page.waitForFunction(() => document.getElementById('message').value === '');
    await postedRequest;
    assert.equal(posted, true, 'successful send reaches chat stream');
    await page.evaluate(() => window.submitDone);
    assert.equal(await page.locator('#message').inputValue(), '', 'successful handoff still clears sent text once');
    await page.close();
    console.log('PASS: failed default-route setup retains text and attachments; successful send clears submitted text');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
