// Keyboard controls for actual Gallery album cards and their action tiles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const albums = [
  { id: 'album-a', name: 'Album Alpha', count: 2 },
  { id: 'album-b', name: 'Album Beta', count: 1 },
];
const albumQueries = [];
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"><body>
<script type="module">
  import ui from '/static/js/ui.js';
  import gallery from '/static/js/gallery.js';
  window.fixture = { prompts: [], promptCount: 0, uploadClicks: 0, errors: [] };
  ui.styledPrompt = async () => { window.fixture.promptCount++; return window.fixture.prompts.shift() || null; };
  ui.styledConfirm = async () => true;
  ui.showError = text => window.fixture.errors.push(String(text));
  ui.showToast = () => {};
  const click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function() {
    if (this.type === 'file') { window.fixture.uploadClicks++; return; }
    return click.call(this);
  };
  window.gallery = gallery;
  gallery.openGallery();
  const modal = document.getElementById('gallery-modal');
  modal.classList.remove('hidden', 'modal-minimized');
  modal.style.setProperty('display', 'flex', 'important');
  window.fixture.ready = true;
</script></body>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.end(html); return; }
  if (url.pathname === '/api/gallery/albums') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ albums }));
    return;
  }
  if (url.pathname === '/__queries') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(albumQueries));
    return;
  }
  if (url.pathname === '/api/gallery/library') {
    albumQueries.push(url.searchParams.get('album'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: [], total: 0, tags: [], models: [] }));
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
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixture?.ready);
    const albumsTab = page.locator('.gallery-tab[data-tab="albums"]');
    await albumsTab.click();
    assert.equal(await albumsTab.evaluate(el => el.classList.contains('active')), true,
      'Albums is active before opening a card');
    const create = page.locator('#gallery-albums-new');
    await create.waitFor();
    assert.equal(await create.getAttribute('role'), 'button');
    assert.equal(await create.getAttribute('tabindex'), '0');
    assert.match(await create.getAttribute('aria-label'), /new album/i);
    await create.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.fixture.promptCount === 1);

    const upload = page.locator('#gallery-albums-upload');
    assert.equal(await upload.getAttribute('role'), 'button');
    await upload.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.fixture.uploadClicks === 1);

    const alpha = page.locator('.gallery-album-card[data-album="album-a"]');
    assert.equal(await alpha.getAttribute('role'), 'button');
    assert.equal(await alpha.getAttribute('tabindex'), '0');
    assert.match(await alpha.getAttribute('aria-label'), /open album.*Album Alpha/i);
    await alpha.focus();
    assert.equal(await alpha.evaluate(el => getComputedStyle(el).outlineStyle), 'solid',
      'the real stylesheet draws a visible outline on a focused album card');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.gallery-tab[data-tab="images"]')?.classList.contains('active'));
    await page.waitForFunction(() => fetch('/__queries').then(r => r.json()).then(items => items.includes('album-a')));
    assert.equal(await page.locator('.gallery-tab[data-tab="albums"]').evaluate(el => el.classList.contains('active')), false);
    assert.equal(await page.locator('.gallery-tab[data-tab="images"]').evaluate(el => el.classList.contains('active')), true,
      'opening the card switches from Albums to Photos');
    assert.match(await page.locator('#gallery-filter-chips').textContent(), /Album Alpha/,
      'Photos displays the selected album filter');

    await page.locator('.gallery-tab[data-tab="albums"]').click();
    await page.locator('#gallery-albums-select-btn').click();
    const beta = page.locator('.gallery-album-card[data-album="album-b"]');
    assert.match(await beta.getAttribute('aria-label'), /select album.*Album Beta/i);
    await beta.focus();
    await page.keyboard.press('Space');
    assert.equal(await beta.getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#gallery-albums-bulk-count').textContent(), /1 selected/);

    await page.locator('#gallery-albums-select-btn').click();
    const menu = page.locator('.gallery-album-menu-btn[data-album="album-b"]');
    await menu.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.gallery-album-menu-pop[data-album="album-b"]').isVisible(), true);
    assert.equal(await page.locator('.gallery-tab[data-tab="albums"]').evaluate(el => el.classList.contains('active')), true,
      'activating the nested options button does not also open the album');

    await beta.click();
    await page.waitForFunction(() => fetch('/__queries').then(r => r.json()).then(items => items.includes('album-b')));
    assert.deepEqual(errors, []);
    console.log('PASS: album actions, open/select cards and nested options work by keyboard; mouse still opens album');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
