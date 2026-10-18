// Synthetic keyboard/touch regression for Gallery photo cards.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const evidenceDir = process.env.EVIDENCE_DIR || os.tmpdir();
const output = path.join(evidenceDir, 'gallery-accessibility-results.json');
const index = fs.readFileSync(path.join(repo, 'static/index.html'), 'utf8');
const cssLinks = [...index.matchAll(/<link[^>]+stylesheet[^>]+href="([^"]+)"/g)].map(match => match[1]);
const styles = cssLinks.map(href => `<link rel="stylesheet" href="${href}">`).join('\n');
const html = `<!doctype html><html lang="en" class="nx-workspace theme-novum-xenium"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}</head><body class="theme-novum-xenium"><div id="toast"></div><script type="module">import * as gallery from '/static/js/gallery.js'; gallery.openGallery(); window.fixtureReady=true;</script></body></html>`;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#584577"/></svg>';
const record = { favorites: [], mutations: [] };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (status, value, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(value) : value);
  };
  if (url.pathname === '/') return send(200, html, 'text/html');
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/fixture/local.svg') return send(200, svg, 'image/svg+xml');
  if (url.pathname === '/api/gallery/albums') return send(200, { albums: [] });
  if (url.pathname === '/api/gallery/library') {
    const search = url.searchParams.get('search') || '';
    const id = search === 'refreshed' ? 'refreshed-photo' : 'synthetic-photo';
    return send(200, {
    items: [{ id, url: '/fixture/local.svg', filename: `${id}.svg`, prompt: search === 'refreshed' ? 'Refreshed photo' : 'Synthetic photo', model: 'Synthetic', created_at: '2026-01-01T00:00:00Z' }],
    total: 1, total_tagged: 0, tags: [], models: ['Synthetic'],
  });
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
  fs.mkdirSync(evidenceDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  const pageErrors = [];
  const externalRequests = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(n => window.fixtureReady && [...document.querySelectorAll('link[rel="stylesheet"]')].filter(link => link.sheet).length === n, cssLinks.length);
    await page.waitForSelector('#gallery-grid .gallery-card[data-id="synthetic-photo"] .gallery-card-open');
    await page.waitForFunction(() => !document.getElementById('gallery-grid')?.classList.contains('gallery-just-opened'));
    const stylesheetCount = await page.locator('link[rel="stylesheet"]').evaluateAll(links => links.filter(link => !!link.sheet).length);
    assert.equal(stylesheetCount, cssLinks.length, 'complete app stylesheet order loads');

    const cardOpen = page.locator('.gallery-card-open');
    let tabReachedOpen = false;
    for (let i = 0; i < 50; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.classList.contains('gallery-card-open'))) {
        tabReachedOpen = true;
        break;
      }
    }
    assert.equal(tabReachedOpen, true, 'card open action is reachable with Tab');
    await page.evaluate(() => {
      const detail = document.getElementById('gallery-detail');
      let count = 0;
      new MutationObserver(records => { if (records.some(record => record.type === 'childList')) count++; }).observe(detail, { childList: true });
      window.__detailRenderCount = () => count;
    });
    const countBeforeEnter = await page.evaluate(() => window.__detailRenderCount());
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('gallery-detail')?.style.display === 'flex');
    await page.waitForFunction(() => window.__detailRenderCount() > 0);
    const enterOpenCount = await page.evaluate(() => window.__detailRenderCount() - 0);
    assert.equal(enterOpenCount - countBeforeEnter, 1, 'Enter opens detail once');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'gallery-detail-back', 'open moves focus to a useful detail control');
    await page.locator('#gallery-detail-back').click();
    await page.waitForFunction(() => document.getElementById('gallery-detail')?.style.display === 'none');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('gallery-card-open')), true, 'Back restores focus to opener');

    await cardOpen.focus();
    const countBeforeSpace = await page.evaluate(() => window.__detailRenderCount());
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.getElementById('gallery-detail')?.style.display === 'flex');
    await page.waitForFunction(count => window.__detailRenderCount() > count, countBeforeSpace);
    assert.equal(await page.evaluate(count => window.__detailRenderCount() - count, countBeforeSpace), 1, 'Space opens detail once');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('gallery-detail')?.style.display === 'none');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('gallery-card-open')), true, 'Escape restores focus to opener');
    assert.equal(await page.locator('#gallery-modal').count(), 1, 'Escape closes detail without closing Gallery');

    await cardOpen.focus();
    await page.locator('#gallery-select-btn').click();
    assert.equal(await cardOpen.getAttribute('aria-pressed'), 'false');
    assert.match(await cardOpen.getAttribute('aria-label'), /^Select photo:/, 'select mode action has a selection name');
    await cardOpen.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('.gallery-select-dot')?.classList.contains('selected'));
    assert.equal(await cardOpen.getAttribute('aria-pressed'), 'true', 'selection state is announced');
    assert.equal(await page.locator('#gallery-detail').evaluate(el => el.style.display), 'none', 'selecting does not open detail');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('.gallery-select-dot')?.classList.contains('selected'));
    assert.equal(await cardOpen.getAttribute('aria-pressed'), 'false', 'keyboard toggles selection exactly once');
    await page.locator('#gallery-select-btn').click();
    assert.match(await cardOpen.getAttribute('aria-label'), /^Open photo:/, 'normal mode action has an open name');

    const favoriteRequest = page.waitForResponse(response => response.url().endsWith('/api/gallery/synthetic-photo/favorite'));
    await page.locator('.gallery-fav-btn').click();
    await favoriteRequest;
    assert.deepEqual(record.favorites, ['synthetic-photo'], 'favorite action sends one request');
    assert.equal(await page.locator('#gallery-detail').evaluate(el => el.style.display), 'none', 'favorite stays separate from open action');
    const download = page.waitForEvent('download');
    await page.locator('.gallery-dl-btn').click();
    await download;
    assert.equal(await page.locator('#gallery-detail').evaluate(el => el.style.display), 'none', 'download stays separate from open action');

    const viewports = [];
    for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 600, height: 320 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#gallery-grid .gallery-card[data-id="synthetic-photo"]').scrollIntoViewIfNeeded();
      const metrics = await page.evaluate(() => {
        const card = document.querySelector('#gallery-grid .gallery-card[data-id="synthetic-photo"]');
        const open = card.querySelector('.gallery-card-open');
        const fav = card.querySelector('.gallery-fav-btn');
        const dl = card.querySelector('.gallery-dl-btn');
        const rect = el => { const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height, opacity:getComputedStyle(el).opacity, display:getComputedStyle(el).display }; };
        const f = rect(fav), d = rect(dl);
        const overlaps = f.left < d.right && f.right > d.left && f.top < d.bottom && f.bottom > d.top;
        return { viewport:{width:innerWidth,height:innerHeight}, documentWidth:document.documentElement.scrollWidth, card:rect(card), open:rect(open), favorite:f, download:d, actionsOverlap:overlaps };
      });
      assert.ok(metrics.documentWidth <= viewport.width, `page overflow at ${viewport.width}: ${JSON.stringify(metrics)}`);
      for (const action of [metrics.favorite, metrics.download]) {
        assert.ok(action.width >= 44 && action.height >= 44, `small action target at ${viewport.width}: ${JSON.stringify(metrics)}`);
        assert.ok(Number(action.opacity) > 0, `mobile action hidden at ${viewport.width}: ${JSON.stringify(metrics)}`);
        assert.ok(action.left >= metrics.card.left && action.right <= metrics.card.right, `action outside card at ${viewport.width}: ${JSON.stringify(metrics)}`);
      }
      assert.equal(metrics.actionsOverlap, false, `favorite/download overlap at ${viewport.width}`);
      await page.screenshot({ path: path.join(evidenceDir, `gallery-${viewport.width}x${viewport.height}.png`), fullPage: false });
      viewports.push(metrics);
    }

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.mouse.move(1018, 762);
    await page.waitForTimeout(250);
    const desktop = await page.locator('.gallery-dl-btn').evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
    assert.ok(Math.abs(desktop.width - 26) < 0.1 && Math.abs(desktop.height - 26) < 0.1, 'desktop action dimensions remain compact');

    // If a filter refresh replaces an explicit opener while detail is open,
    // Escape should move focus to the visible Gallery close control instead.
    await page.locator('.gallery-card-open').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('gallery-detail')?.style.display === 'flex');
    await page.evaluate(() => {
      const search = document.getElementById('gallery-search');
      search.value = 'refreshed';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => !!document.querySelector('.gallery-card[data-id="refreshed-photo"]'));
    assert.equal(await page.locator('.gallery-card[data-id="synthetic-photo"]').count(), 0, 'filter refresh replaces original opener');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('gallery-detail')?.style.display === 'none');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'gallery-close', 'removed opener uses visible Gallery fallback');

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
    const results = {
      stylesheetsLoaded: stylesheetCount,
      keyboard: { tabReachedOpen: tabReachedOpen, enterOpensOnce: true, spaceOpensOnce: true, backRestoresOpener: true, escapeRestoresOpener: true, refreshedOpenerFallback: 'gallery-close' },
      selection: { initialPressed: 'false', selectedPressed: 'true', deselectedPressed: 'false', detailStayedClosed: true },
      childActions: { favoriteRequests: record.favorites, downloadDidNotOpenDetail: true },
      viewports,
      desktop,
      pageErrors,
      externalRequests,
      limitation: 'Synthetic local SVG and metadata in headless Chromium; no real gallery content, media playback, mobile device, or assistive technology used.',
    };
    fs.writeFileSync(output, JSON.stringify(results, null, 2));
    console.log('PASS Gallery card keyboard, focus return, selection state, and mobile targets');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
