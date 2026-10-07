// A failed Notes save must leave its draft recoverable in localStorage.
// Uses the shipped module and hidden Chrome; all API state is an in-memory fixture.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css">
<body><aside id="sidebar"></aside><button id="tool-notes-btn"></button><div id="chat-container"></div><div id="toast"></div>
<script type="module">import notes from '/static/js/notes.js'; notes.openPanel(); window.fixtureReady = true;</script></body>`;
let gets = 0;
let failNextPost = true;
let delayNextPost = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/notes' && req.method === 'GET') {
    gets++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ notes: [] }));
  }
  if (url.pathname === '/api/notes' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const delay = delayNextPost;
      delayNextPost = 0;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (failNextPost) {
        failNextPost = false;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'fixture unavailable' }));
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...JSON.parse(body), id: 'saved-note' }));
    });
    return;
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
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('.notes-quick-input'));
    await page.locator('.notes-quick-type-pill[data-type="note"]').click();
    await page.locator('.notes-quick-input').click();
    await page.locator('.note-form-title').fill('Keep this after failure');
    await page.locator('.note-form-content').fill('Unsaved content must remain recoverable.');
    await page.waitForTimeout(700); // allow the draft debounce to persist before Save
    await page.locator('.note-form-save').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Save failed'));
    await page.waitForTimeout(100); // allow failure refresh to replace the optimistic card
    assert.equal(await page.locator('.note-form').count(), 0, 'failed optimistic form is removed');
    const savedDraft = await page.evaluate(() => JSON.parse(localStorage.getItem('odysseus-note-draft-__new__') || 'null'));
    assert.equal(savedDraft?.title, 'Keep this after failure', 'failed create should retain a recoverable draft title');
    assert.equal(savedDraft?.content, 'Unsaved content must remain recoverable.');
    await page.locator('.notes-quick-input').click();
    assert.equal(await page.locator('.note-form-title').inputValue(), 'Keep this after failure');
    assert.equal(await page.locator('.note-form-content').inputValue(), 'Unsaved content must remain recoverable.');

    const retryResponse = page.waitForResponse(response => response.url().endsWith('/api/notes') && response.request().method() === 'POST');
    await page.locator('.note-form-save').click();
    await retryResponse;
    assert.equal(await page.evaluate(() => localStorage.getItem('odysseus-note-draft-__new__')), null,
      'successful save clears the exact draft it submitted');

    // A successful, slow save may complete after the user has started another
    // new note. Its callback must not clear the newer note's draft.
    await page.locator('.notes-quick-type-pill[data-type="note"]').click();
    await page.locator('.notes-quick-input').click();
    await page.locator('.note-form-title').fill('First retry');
    await page.locator('.note-form-content').fill('Submitted snapshot');
    delayNextPost = 1300;
    const firstPost = page.waitForRequest(request => request.url().endsWith('/api/notes') && request.method() === 'POST');
    await page.locator('.note-form-save').click();
    await firstPost;
    await page.locator('.notes-quick-input').click();
    await page.locator('.note-form-title').fill('Newer in-flight draft');
    await page.locator('.note-form-content').fill('Must survive first save completion.');
    await page.waitForTimeout(700);
    const newerDraft = await page.evaluate(() => localStorage.getItem('odysseus-note-draft-__new__'));
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => localStorage.getItem('odysseus-note-draft-__new__')), newerDraft,
      'successful older save must preserve newer draft snapshot');
    assert.equal(await page.locator('.note-form-title').inputValue(), 'Newer in-flight draft');
    assert.equal(await page.locator('.note-form-content').inputValue(), 'Must survive first save completion.');
    assert.deepEqual(errors, []);
    console.log('PASS: failed Notes create restores its draft; older successful save preserves a newer in-flight draft');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
