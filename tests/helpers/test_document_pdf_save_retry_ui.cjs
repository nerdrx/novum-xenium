// Ensure a failed PDF-pane save can be retried from live field refs without
// promoting unsaved markdown to the saved cache. Fixture API only.
// PLAYWRIGHT_PACKAGE=/path/to/playwright BROWSER_EXECUTABLE=/path/to/chrome node tests/helpers/test_document_pdf_save_retry_ui.cjs
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const original = '- Name:**_(empty)_** <!-- field=Name type=text -->';
const state = { fail: true, saved: original, puts: [] };
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css">
<body><div id="toast"></div><div id="chat-container" style="height:100vh"></div>
<script type="module">import doc from '/static/js/document.js'; doc.init(''); window.doc=doc; window.ready=true;</script></body>`;
const reply = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/document/fixture' && req.method === 'GET') {
    return reply(res, 200, { id: 'fixture', title: 'Fixture', language: 'markdown', content: state.saved });
  }
  if (url.pathname === '/api/document/fixture' && req.method === 'PUT') {
    let body = '';
    for await (const part of req) body += part;
    const content = JSON.parse(body).content;
    state.puts.push(content);
    if (state.fail) return reply(res, 503, { error: 'fixture unavailable' });
    state.saved = content;
    return reply(res, 200, { version_count: 1 });
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (file === path.join(repo, 'static/js/document.js')) {
    const source = fs.readFileSync(file, 'utf8').replace('const documentModule = {',
      'window.__docs=docs;window.__fields=_pdfPaneFieldsByDoc;window.__annotations=_pdfPaneAnnotationsByDoc;window.__savePdfPane=_savePdfPaneToMarkdown;const documentModule = {');
    return res.end(source);
  }
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => { throw error; });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready);
    await page.evaluate(() => window.doc.loadDocument('fixture'));
    await page.waitForSelector('#doc-editor-textarea', { state: 'attached' });
    await page.evaluate(() => {
      const ref = { name: 'Name', type: 'text', el: { value: 'first edit' } };
      window.__fields.set('fixture', [ref]);
      window.__annotations.set('fixture', []);
    });
    assert.equal(await page.evaluate(() => window.__savePdfPane()), false);
    assert.equal(state.puts.length, 1);
    assert.equal(state.saved, original);
    assert.equal(await page.evaluate(() => window.__docs.get('fixture').content), original,
      'failed PDF-pane save rolls cached source back');
    assert.match(await page.locator('#doc-editor-textarea').inputValue(), /first edit/,
      'failed save keeps the generated markdown visible');

    await page.evaluate(() => { window.__fields.get('fixture')[0].el.value = 'latest edit'; });
    state.fail = false;
    assert.equal(await page.evaluate(() => window.__savePdfPane()), true);
    assert.equal(state.puts.length, 2);
    assert.match(state.puts[1], /latest edit/);
    assert.equal(await page.evaluate(() => window.__docs.get('fixture').content), state.saved);
    assert.match(state.saved, /latest edit/);
    console.log('PASS: failed PDF-pane save retains visible edit and old cache; retry persists latest field value');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
