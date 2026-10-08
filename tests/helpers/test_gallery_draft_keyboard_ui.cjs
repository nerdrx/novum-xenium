// Keyboard activation for the saved-project resume cards in Gallery.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const draftReads = [];
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"><body>
<script type="module">
  import ui from '/static/js/ui.js';
  import gallery from '/static/js/gallery.js';
  ui.styledConfirm = async () => { window.fixture.confirmCalls++; return false; };
  ui.styledPrompt = async () => null;
  ui.showToast = () => {};
  ui.showError = text => { window.fixture.error = String(text); };
  window.gallery = gallery;
  gallery.openGallery();
  const modal = document.getElementById('gallery-modal');
  modal.classList.remove('hidden', 'modal-minimized');
  modal.style.setProperty('display', 'flex', 'important');
  window.fixture = { confirmCalls: 0 };
  window.fixture.ready = true;
</script></body>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.end(html); return; }
  if (url.pathname === '/api/editor-drafts') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ drafts: [{ id: 'draft-x', name: 'Audit draft', width: 400, height: 300 }] }));
    return;
  }
  if (url.pathname === '/api/editor-drafts/draft-x') {
    draftReads.push(url.pathname);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'draft-x', name: 'Audit draft', payload: { imgWidth: 400, imgHeight: 300, layers: [] } }));
    return;
  }
  if (url.pathname === '/api/gallery/albums') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ albums: [] }));
    return;
  }
  if (url.pathname === '/__draftReads') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(draftReads));
    return;
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixture?.ready);
    await page.locator('.gallery-tab[data-tab="editor"]').click();
    const card = page.locator('.gallery-editor-draft-card[data-draft-id="draft-x"]');
    await card.waitFor({ state: 'visible' });
    assert.equal(await card.getAttribute('role'), 'button');
    assert.equal(await card.getAttribute('tabindex'), '0');
    assert.match(await card.getAttribute('aria-label'), /resume project Audit draft/i);

    await page.locator('#gallery-editor-drafts-select').click();
    assert.equal(await card.getAttribute('aria-pressed'), 'false');
    await card.focus();
    await page.keyboard.press('Space');
    assert.equal(await card.getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#gallery-editor-drafts-bulk-count').textContent(), /1 selected/);

    await page.locator('.gallery-editor-draft-delete[data-draft-id="draft-x"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.fixture.confirmCalls === 1);
    assert.equal(await page.evaluate(() => window.__galleryEditLive || false), false,
      'nested Delete activation does not also resume the draft');
    assert.equal(await card.isVisible(), true, 'canceling nested Delete leaves the selected draft');

    await page.locator('#gallery-editor-drafts-select').click();
    assert.equal(await card.getAttribute('aria-label').then(value => /resume project Audit draft/i.test(value)), true);
    await card.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__galleryEditLive === true);
    await page.waitForFunction(() => fetch('/__draftReads').then(r => r.json()).then(paths => paths.includes('/api/editor-drafts/draft-x')));
    assert.deepEqual(errors, []);
    console.log('PASS: Space selects a draft, nested Delete stays independent, and Enter resumes that draft');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
