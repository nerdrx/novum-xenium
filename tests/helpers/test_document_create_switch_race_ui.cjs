// An auto-created document request must not take over the editor after a tab switch.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const state = { createStarted: false, docs: { b: 'B content' } };
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css">
<body><div id="toast"></div><div id="chat-container" style="height:100vh"></div>
<script type="module">import doc from '/static/js/document.js'; doc.init(''); doc.openPanel();
window.documentModule = doc; window.fixtureReady = true;</script></body>`;
const reply = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/sessions') return reply(res, 200, { sessions: [] });
  if (url.pathname === '/api/session' && req.method === 'POST') return reply(res, 200, { id: 'fixture-session' });
  if (url.pathname === '/api/document' && req.method === 'POST') {
    state.createStarted = true;
    await new Promise(resolve => setTimeout(resolve, 600));
    return reply(res, 201, { id: 'created', title: '', language: 'markdown', content: 'A draft', current_content: 'A draft', session_id: 'fixture-session' });
  }
  if (url.pathname === '/api/document/b' && req.method === 'GET') {
    return reply(res, 200, { id: 'b', title: 'B', language: 'markdown', content: state.docs.b, session_id: 'fixture-session' });
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('#doc-editor-textarea'));
    const createRequest = page.waitForRequest(request => request.url().endsWith('/api/document') && request.method() === 'POST');
    await page.locator('#doc-editor-textarea').fill('A draft');
    await createRequest;
    await page.evaluate(() => window.documentModule.loadDocument('b'));
    await page.waitForFunction(() => window.documentModule.getCurrentDocId() === 'b');
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.documentModule.getCurrentDocId()), 'b',
      'late auto-create completion must not replace the document selected while request was pending');
    assert.equal(await page.locator('#doc-editor-textarea').inputValue(), 'B content',
      'late auto-create completion must leave the selected document visible');
    assert.deepEqual(errors, []);
    console.log('PASS: pending auto-create does not steal selection after switching to B');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
