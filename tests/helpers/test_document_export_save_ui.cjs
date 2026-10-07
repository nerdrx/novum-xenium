// Exercise the real document export helpers in hidden headless Chrome. The
// fixture API models a failing/recovering save; no app account or documents.
// PLAYWRIGHT_PACKAGE=/path/to/playwright BROWSER_EXECUTABLE=/path/to/chrome node tests/helpers/test_document_export_save_ui.cjs
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const state = { failSave: true, saves: 0, exports: 0, previews: 0, saved: 'original' };
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
  if (url.pathname === '/api/document/fixture' && req.method === 'GET') {
    return reply(res, 200, { id: 'fixture', title: 'Fixture', language: 'markdown',
      content: state.saved, session_id: 'fixture-session' });
  }
  if (url.pathname === '/api/document/fixture' && req.method === 'PUT') {
    let body = '';
    for await (const part of req) body += part;
    state.saves++;
    if (state.failSave) return reply(res, 503, { error: 'fixture unavailable' });
    state.saved = JSON.parse(body).content;
    return reply(res, 200, { ok: true });
  }
  if (url.pathname === '/api/document/fixture/export-pdf') {
    state.exports++;
    return reply(res, 200, { exportedContent: state.saved });
  }
  if (url.pathname === '/api/document/fixture/export-pdf/preview') {
    state.previews++;
    return reply(res, 200, { fields: [] });
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  if (file === path.join(repo, 'static/js/document.js')) {
    const source = fs.readFileSync(file, 'utf8').replace('const documentModule = {',
      'window.__docs = docs; window.__saveBeforeExport = _saveActiveDocBeforeExport; window.__downloadFilledPdf = _downloadFilledPdf; window.__openExportPdfModal = _openExportPdfModal; const documentModule = {');
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
    page.on('pageerror', error => { throw error; });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => window.documentModule.loadDocument('fixture'));
    await page.waitForSelector('#doc-editor-textarea', { state: 'attached' });

    const moduleSource = fs.readFileSync(path.join(repo, 'static/js/document.js'), 'utf8');
    assert.equal((moduleSource.match(/if \(!await _saveActiveDocBeforeExport\(\)\) return;/g) || []).length, 2,
      'both PDF export callers must abort after a failed save');
    await page.evaluate(() => { document.getElementById('doc-editor-textarea').value = 'unsaved edit'; });

    await page.evaluate(() => window.__downloadFilledPdf());
    assert.equal(state.saves, 1);
    assert.equal(state.exports, 0, 'failed save must prevent PDF export');
    assert.equal(await page.locator('#doc-editor-textarea').inputValue(), 'unsaved edit', 'failed save keeps textarea edits');
    assert.equal(await page.locator('#toast').textContent().then(s => s.includes('Could not save')), true);
    assert.equal(await page.evaluate(() => window.__docs.get('fixture').content), 'original', 'failed save leaves cached content unchanged');

    // The export-modal caller must also stop before its preview request.
    await page.evaluate(() => window.__openExportPdfModal());
    await page.waitForTimeout(50);
    assert.equal(state.saves, 2);
    assert.equal(state.exports, 0);
    assert.equal(state.previews, 0, 'failed save blocks preview request');
    assert.equal(state.saved, 'original');

    state.failSave = false;
    await page.evaluate(() => window.__downloadFilledPdf());
    assert.equal(state.saves, 3);
    assert.equal(state.exports, 1, 'successful save reaches PDF export');
    assert.equal(state.saved, 'unsaved edit', 'export uses the content that was saved');
    assert.equal(await page.locator('#doc-editor-textarea').inputValue(), 'unsaved edit');
    assert.equal(await page.evaluate(() => window.__docs.get('fixture').content), 'unsaved edit');
    console.log('PASS: failed pre-export PUT keeps edits and blocks both export paths; successful PUT exports saved content');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
