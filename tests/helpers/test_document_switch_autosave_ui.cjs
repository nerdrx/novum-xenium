// Verify pending autosaves stay attached to their document while tabs switch.
// Uses the shipped document module, hidden Chrome and a fixture-only API.
// PLAYWRIGHT_PACKAGE=/path/to/playwright BROWSER_EXECUTABLE=/path/to/chrome node tests/helpers/test_document_switch_autosave_ui.cjs
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const state = {
  docs: { a: 'A original', b: 'B original' },
  failA: false,
  slowAGetOnce: false,
  putDelays: [],
  puts: [],
};
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css">
<body><div id="toast"></div><div id="chat-container" style="height:100vh"></div>
<script type="module">
import doc from '/static/js/document.js';
doc.init(''); window.documentModule = doc; window.fixtureReady = true;
</script></body>`;
const reply = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  const match = url.pathname.match(/^\/api\/document\/([ab])$/);
  if (match && req.method === 'GET') {
    const id = match[1];
    if (id === 'a' && state.slowAGetOnce) {
      state.slowAGetOnce = false;
      await new Promise(resolve => setTimeout(resolve, 350));
    } else if (id === 'b' && state.slowAGetOnce) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return reply(res, 200, { id, title: id.toUpperCase(), language: 'python',
      content: state.docs[id], session_id: 'fixture-session' });
  }
  if (match && req.method === 'PUT') {
    let body = '';
    for await (const part of req) body += part;
    const id = match[1];
    const content = JSON.parse(body).content;
    state.puts.push({ id, content });
    const delay = state.putDelays.shift() || 0;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (id === 'a' && state.failA) return reply(res, 503, { error: 'fixture unavailable' });
    state.docs[id] = content;
    return reply(res, 200, { version_count: 1 });
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (file === path.join(repo, 'static/js/document.js')) {
    const source = fs.readFileSync(file, 'utf8').replace('const documentModule = {',
      'window.__docs = docs; window.__switchDoc = switchToDoc; const documentModule = {');
    return res.end(source);
  }
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.fixtureReady);
    state.slowAGetOnce = true;
    await page.evaluate(async () => {
      const oldRequest = window.documentModule.loadDocument('a');
      await new Promise(resolve => setTimeout(resolve, 10));
      await window.documentModule.loadDocument('b');
      await oldRequest;
    });
    assert.equal(await page.evaluate(() => window.documentModule.getCurrentDocId()), 'b',
      'latest document request wins when earlier GET resolves later');
    assert.equal(await page.evaluate(() => window.__docs.has('a')), false,
      'stale load does not add the old document');
    await page.evaluate(() => window.documentModule.loadDocument('a'));
    await page.evaluate(() => window.__switchDoc('a'));
    const editor = page.locator('#doc-editor-textarea');

    // Edit A, switch immediately; its delayed timer must not save active B.
    await editor.fill('A edited');
    await page.evaluate(() => window.__switchDoc('b'));
    await page.waitForTimeout(2200);
    assert.deepEqual(state.puts, [{ id: 'a', content: 'A edited' }]);
    assert.equal(state.docs.a, 'A edited');
    assert.equal(state.docs.b, 'B original');

    // A failed autosave retains the dirty cache/editor value, then explicit
    // retry after switching back saves A without touching B.
    state.failA = true;
    await page.evaluate(() => window.__switchDoc('a'));
    await editor.fill('A retry me');
    await page.evaluate(() => window.__switchDoc('b'));
    await page.waitForTimeout(2200);
    assert.deepEqual(state.puts.slice(1), [{ id: 'a', content: 'A retry me' }]);
    assert.equal(state.docs.a, 'A edited');
    assert.equal(await page.evaluate(() => window.__docs.get('a').content), 'A retry me');
    await page.evaluate(() => window.__switchDoc('a'));
    assert.equal(await editor.inputValue(), 'A retry me');
    state.failA = false;
    assert.equal(await page.evaluate(() => window.documentModule.saveDocument({ silent: true })), true);
    assert.deepEqual(state.puts.slice(2), [{ id: 'a', content: 'A retry me' }]);
    assert.equal(state.docs.a, 'A retry me');
    assert.equal(state.docs.b, 'B original');

    // A newer edit made during a slow PUT must survive its stale response and
    // be written after it, even if its own autosave fires first.
    state.putDelays = [3000, 0];
    await editor.fill('A slow snapshot');
    await page.evaluate(() => window.__switchDoc('b'));
    await page.waitForTimeout(2100); // first A PUT has started but is pending
    await page.evaluate(() => window.__switchDoc('a'));
    await editor.fill('A newest edit');
    await page.waitForTimeout(3700);
    assert.equal(state.docs.a, 'A newest edit');
    assert.equal(await page.evaluate(() => window.__docs.get('a').content), 'A newest edit');
    assert.equal(state.docs.b, 'B original');
    assert(state.puts.slice(3).every(put => put.id === 'a'), 'pending A saves must never write B');

    // Closing the pane removes its editor before the delayed save fires. The
    // cached document still owns the edit and must be persisted by its timer.
    await editor.fill('A saved after pane close');
    await page.evaluate(() => window.documentModule.closePanel());
    await page.waitForFunction(() => !document.getElementById('doc-editor-pane'));
    await page.waitForTimeout(2200);
    assert.equal(state.docs.a, 'A saved after pane close');
    assert.deepEqual(state.puts.at(-1), { id: 'a', content: 'A saved after pane close' });
    assert.deepEqual(errors, []);
    console.log('PASS: stale loads, tab-bound autosave, retry, in-flight edits, and pane-close save preserve A without writing B');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
