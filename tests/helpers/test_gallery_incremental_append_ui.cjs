// Synthetic regression for Gallery's incremental Load-more path.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const evidencePath = '/home/nerdrx/.local/state/novum-xenium/maintenance/2026-10-18/pass7/gallery-append-results.json';
const index = fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8');
const cssLinks = [...index.matchAll(/<link[^>]+stylesheet[^>]+href="([^"]+)"/g)].map(match => match[1]);
const styles = cssLinks.map(href => `<link rel="stylesheet" href="${href}">`).join('\n');
const html = `<!doctype html><html lang="en" class="nx-workspace theme-novum-xenium"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}</head>
<body class="theme-novum-xenium"><div id="toast"></div>
<script type="module">import * as gallery from '/static/js/gallery.js'; window.gallery=gallery; gallery.openGallery(); window.fixtureReady=true;</script></body></html>`;

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#584577"/></svg>';
const record = { library: [], favorites: [] };
const image = (id, url, extra = {}) => ({
  id, url, filename: `${id}.${url.endsWith('.webm') ? 'webm' : 'svg'}`, prompt: `Synthetic ${id}`,
  model: 'Synthetic model', created_at: '2026-01-01T00:00:00Z', ...extra,
});
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, value, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(value) : value);
  };
  if (url.pathname === '/') return send(200, html, 'text/html');
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/fixture/photo-1.svg') return send(200, svg, 'image/svg+xml');
  if (url.pathname === '/fixture/video-2.webm') return send(200, Buffer.alloc(0), 'video/webm');
  if (url.pathname === '/api/gallery/albums') return send(200, { albums: [] });
  if (url.pathname === '/api/gallery/library') {
    const search = url.searchParams.get('search') || '';
    const offset = Number(url.searchParams.get('offset') || 0);
    record.library.push({ search, offset, include_facets: url.searchParams.get('include_facets') });
    if (search === 'empty' && offset === 0) {
      if (url.searchParams.get('include_facets') === 'false') {
        return send(200, { items: [image('empty-append', '/fixture/photo-1.svg')], total: 1 });
      }
      return send(200, { items: [], total: 1, tags: [], models: [] });
    }
    if (!search && offset === 0) {
      await new Promise(resolve => setTimeout(resolve, 250));
      return send(200, {
        items: [image('photo-1', '/fixture/photo-1.svg'), image('video-2', '/fixture/video-2.webm')],
        total: 4, total_tagged: 1, tags: ['synthetic-tag'], models: ['Synthetic model'],
      });
    }
    if (!search && offset === 2) {
      return send(200, { items: [image('photo-3', '/fixture/photo-1.svg')], total: 4, total_tagged: 1 });
    }
    if (!search && offset === 3) {
      await new Promise(resolve => setTimeout(resolve, 550));
      return send(200, { items: [image('stale-photo-4', '/fixture/photo-1.svg')], total: 4, total_tagged: 1 });
    }
    if (search === 'cat' && offset === 0) {
      return send(200, { items: [image('cat-result', '/fixture/photo-1.svg', { model: 'Cat model' })], total: 1, tags: ['cat-tag'], models: ['Cat model'] });
    }
    return send(200, { items: [], total: 0, tags: [], models: [] });
  }
  const favorite = url.pathname.match(/^\/api\/gallery\/([^/]+)\/favorite$/);
  if (favorite) {
    record.favorites.push(favorite[1]);
    return send(200, { ok: true, favorite: true });
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(path.join(repo, 'static') + path.sep) || !fs.existsSync(file)) return send(404, {});
  const type = file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(file).pipe(res);
});

async function main() {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  const pageErrors = [];
  const externalRequests = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
    const initialRequest = page.waitForRequest(request => request.url().includes('/api/gallery/library') && new URL(request.url()).searchParams.get('offset') === '0');
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const firstPageRequest = await initialRequest;
    await page.waitForSelector('#gallery-load-more');
    await page.evaluate(() => Object.defineProperty(document.getElementById('gallery-load-more'), 'offsetParent', { configurable: true, get: () => null }));
    const initialResponse = await firstPageRequest.response();
    assert.ok(initialResponse?.ok());
    await page.waitForFunction(expected => window.fixtureReady && [...document.querySelectorAll('link[rel="stylesheet"]')].filter(link => link.sheet).length === expected, cssLinks.length);
    const stylesheetsLoaded = await page.locator('link[rel="stylesheet"]').evaluateAll(links => links.filter(link => !!link.sheet).length);
    assert.equal(stylesheetsLoaded, cssLinks.length, 'all app stylesheets load in index order');
    await page.locator('.gallery-card[data-id="video-2"] video').waitFor();
    await page.waitForFunction(() => document.getElementById('gallery-load-more')?.style.display === 'block');
    await page.waitForFunction(() => !document.getElementById('gallery-grid')?.classList.contains('gallery-just-opened'));
    const identitiesBefore = await page.evaluate(() => {
      window.__appendNodes = {
        upload: document.getElementById('gallery-upload-tile'),
        photo: document.querySelector('.gallery-card[data-id="photo-1"]'),
        image: document.querySelector('.gallery-card[data-id="photo-1"] img'),
        videoCard: document.querySelector('.gallery-card[data-id="video-2"]'),
        video: document.querySelector('.gallery-card[data-id="video-2"] video'),
        model: document.getElementById('gallery-model-filter'),
        allChip: document.querySelector('#gallery-filter-chips .gallery-chip[data-album=""]'),
        tagFacet: document.getElementById('gallery-tag-chips'),
      };
      return { modelOptions: [...__appendNodes.model.options].map(option => option.value), allText: __appendNodes.allChip.textContent };
    });

    await page.locator('#gallery-select-btn').click();
    await page.locator('.gallery-card[data-id="photo-1"]').click({ force: true });
    await page.waitForFunction(() => document.querySelector('#gallery-bulk-count')?.textContent === '1 selected');
    const appendRequest = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === '/api/gallery/library' && url.searchParams.get('offset') === '2';
    });
    await page.locator('#gallery-load-more').click();
    const appendReq = await appendRequest;
    assert.equal(new URL(appendReq.url()).searchParams.get('include_facets'), 'false');
    await page.waitForSelector('.gallery-card[data-id="photo-3"]');
    const appendState = await page.evaluate(() => {
      const nodes = window.__appendNodes;
      return {
        uploadRetained: nodes.upload === document.getElementById('gallery-upload-tile'),
        cardRetained: nodes.photo === document.querySelector('.gallery-card[data-id="photo-1"]'),
        imageRetained: nodes.image === document.querySelector('.gallery-card[data-id="photo-1"] img'),
        videoCardRetained: nodes.videoCard === document.querySelector('.gallery-card[data-id="video-2"]'),
        videoRetained: nodes.video === document.querySelector('.gallery-card[data-id="video-2"] video'),
        modelControlRetained: nodes.model === document.getElementById('gallery-model-filter'),
        modelOptions: [...document.getElementById('gallery-model-filter').options].map(option => option.value),
        allChipRetained: nodes.allChip === document.querySelector('#gallery-filter-chips .gallery-chip[data-album=""]'),
        tagFacetRetained: nodes.tagFacet === document.getElementById('gallery-tag-chips'),
        cardIds: [...document.querySelectorAll('#gallery-grid .gallery-card[data-id]')].map(card => card.dataset.id),
        selected: document.querySelector('#gallery-grid .gallery-card[data-id="photo-1"] .gallery-select-dot')?.classList.contains('selected'),
        appendedDotVisible: getComputedStyle(document.querySelector('#gallery-grid .gallery-card[data-id="photo-3"] .gallery-select-dot')).display !== 'none',
        selectedCount: document.getElementById('gallery-bulk-count')?.textContent,
        selectAllChecked: document.getElementById('gallery-bulk-select-all')?.checked,
        selectAllIndeterminate: document.getElementById('gallery-bulk-select-all')?.indeterminate,
      };
    });
    for (const key of ['uploadRetained','cardRetained','imageRetained','videoCardRetained','videoRetained','modelControlRetained','allChipRetained','tagFacetRetained','selected','appendedDotVisible','selectAllIndeterminate']) assert.equal(appendState[key], true, `${key} must survive append`);
    assert.deepEqual(appendState.modelOptions, identitiesBefore.modelOptions);
    assert.deepEqual(appendState.cardIds, ['photo-1','video-2','photo-3']);
    assert.equal(appendState.selectedCount, '1 selected');
    assert.equal(appendState.selectAllChecked, false);

    await page.locator('#gallery-select-btn').click();
    const favoriteResponse = page.waitForResponse(response => response.url().endsWith('/api/gallery/photo-1/favorite'));
    await page.locator('.gallery-card[data-id="photo-1"] .gallery-fav-btn').click({ force: true });
    await favoriteResponse;
    assert.deepEqual(record.favorites, ['photo-1'], 'the retained favorite button has exactly one handler');

    const staleAppendRequest = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === '/api/gallery/library' && url.searchParams.get('offset') === '3';
    });
    await page.locator('#gallery-load-more').click();
    await staleAppendRequest;
    await page.locator('#gallery-search').fill('cat');
    await page.waitForSelector('.gallery-card[data-id="cat-result"]');
    await page.waitForFunction(() => document.querySelector('#gallery-grid')?.getAttribute('aria-busy') !== 'true');
    const afterRefresh = await page.evaluate(() => ({
      oldCardConnected: window.__appendNodes.photo.isConnected,
      cardIds: [...document.querySelectorAll('#gallery-grid .gallery-card[data-id]')].map(card => card.dataset.id),
      models: [...document.getElementById('gallery-model-filter').options].map(option => option.value),
    }));
    await page.waitForTimeout(650);
    const afterStaleAppend = await page.locator('#gallery-grid .gallery-card[data-id]').evaluateAll(cards => cards.map(card => card.dataset.id));
    assert.equal(afterRefresh.oldCardConnected, false, 'filter refresh replaces old result cards');
    assert.deepEqual(afterRefresh.cardIds, ['cat-result']);
    assert.deepEqual(afterRefresh.models, ['', 'Cat model'], 'filter refresh still replaces facets');
    assert.deepEqual(afterStaleAppend, ['cat-result'], 'stale append cannot add results after filter refresh');

    await page.locator('#gallery-search').fill('empty');
    await page.waitForSelector('#gallery-grid .gallery-empty');
    const emptyAppendRequest = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === '/api/gallery/library' && url.searchParams.get('search') === 'empty' && url.searchParams.get('include_facets') === 'false';
    });
    // The empty-state renderer hides Load more, but resize/top-up callers can
    // still request an append; trigger its existing handler directly here.
    await page.evaluate(() => document.getElementById('gallery-load-more').click());
    const emptyReq = await emptyAppendRequest;
    await page.waitForSelector('.gallery-card[data-id="empty-append"]');
    const emptyAppend = await page.evaluate(() => ({
      emptyPlaceholderRemoved: !document.querySelector('#gallery-grid .gallery-empty'),
      cardIds: [...document.querySelectorAll('#gallery-grid .gallery-card[data-id]')].map(card => card.dataset.id),
      uploadPresent: !!document.getElementById('gallery-upload-tile'),
    }));
    assert.equal(new URL(emptyReq.url()).searchParams.get('offset'), '0');
    assert.equal(emptyAppend.emptyPlaceholderRemoved, true, 'empty-state placeholder disappears when first appended results arrive');
    assert.deepEqual(emptyAppend.cardIds, ['empty-append']);
    assert.equal(emptyAppend.uploadPresent, true);

    const viewport = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, gridWidth: document.getElementById('gallery-grid').scrollWidth, clientWidth: document.getElementById('gallery-grid').clientWidth }));
    assert.ok(viewport.documentWidth <= viewport.width, `horizontal page overflow: ${JSON.stringify(viewport)}`);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
    const output = {
      stylesheetsLoaded,
      identitiesBefore,
      appendRequest: record.library.find(entry => entry.offset === 2),
      appendState,
      favoriteRequests: record.favorites,
      afterRefresh,
      afterStaleAppend,
      emptyAppend: { request: record.library.find(entry => entry.search === 'empty' && entry.include_facets === 'false'), ...emptyAppend },
      viewport,
      pageErrors,
      externalRequests,
      limitation: 'Synthetic local SVG/video fixture in headless Chromium; no real gallery content or media playback is used.',
    };
    fs.writeFileSync(evidencePath, JSON.stringify(output, null, 2));
    console.log('PASS synthetic Gallery append preserves existing cards, facets, selection and handler counts');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
