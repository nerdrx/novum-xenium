// Gallery fetches must not let an older filter response replace newer results.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let failNextLibraryRequest = false;
const html = `<!doctype html><meta charset="utf-8"><body><div id="toast"></div>
<script type="module">import * as gallery from '/static/js/gallery.js'; window.gallery = gallery; gallery.openGallery(); window.fixtureReady = true;</script></body>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/__fail-next-library') {
    failNextLibraryRequest = true;
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/gallery/albums') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ albums: [] }));
  }
  if (url.pathname === '/api/gallery/library') {
    const search = url.searchParams.get('search') || '';
    const offset = Number(url.searchParams.get('offset') || 0);
    if (failNextLibraryRequest) {
      failNextLibraryRequest = false;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'first load failed' }));
    }
    if (!search) await new Promise(resolve => setTimeout(resolve, 800));
    if (search === 'cat' && offset > 0) await new Promise(resolve => setTimeout(resolve, 650));
    if (search === 'dog' && offset === 0) await new Promise(resolve => setTimeout(resolve, 650));
    if (search === 'slowclose') await new Promise(resolve => setTimeout(resolve, 650));
    if (search === 'missing' || search === 'slowerror') {
      if (search === 'slowerror') await new Promise(resolve => setTimeout(resolve, 650));
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'fixture failure' }));
    }
    const id = search ? (offset ? `${search}-next` : search) : 'all';
    const label = search ? (offset ? `${search.toUpperCase()} NEXT` : `${search.toUpperCase()} RESULT`) : 'ALL RESULT';
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      items: [{ id, caption: label, url: '/fixture.jpg', filename: 'fixture.jpg', created_at: '2026-01-01' }],
      total: ['cat', 'dog'].includes(search) ? 3 : 1, tags: [], models: [],
    }));
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
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    const initialRequest = page.waitForRequest(request => request.url().includes('/api/gallery/library') &&
      !request.url().includes('search='));
    const initialResponse = page.waitForResponse(response => response.url().includes('/api/gallery/library') &&
      !response.url().includes('search='));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await initialRequest;
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('#gallery-search'));

    // Search completes before the delayed initial response. Older success must
    // not replace the correctly filtered gallery after it arrives.
    await page.locator('#gallery-search').fill('cat');
    await page.waitForFunction(() => document.querySelector('#gallery-grid')?.getAttribute('aria-busy') === 'true');
    await page.waitForFunction(() => document.querySelector('.gallery-card[data-id="cat"]'));
    await initialResponse;
    await page.waitForFunction(() => document.querySelector('#gallery-grid')?.getAttribute('aria-busy') !== 'true');
    assert.deepEqual(await page.locator('.gallery-card-prompt').allTextContents(), ['CAT RESULT']);

    // A pending append page from the old filter must not be merged into the
    // replacement filter's results.
    await page.waitForFunction(() => document.querySelector('#gallery-load-more')?.style.display === 'block');
    const oldAppendRequest = page.waitForRequest(request => request.url().includes('search=cat') && request.url().includes('offset=1'));
    const oldAppendResponse = page.waitForResponse(response => response.url().includes('search=cat') && response.url().includes('offset=1'));
    await page.locator('#gallery-load-more').click();
    await oldAppendRequest;
    await page.locator('#gallery-search').fill('dog');
    await page.waitForFunction(() => document.querySelector('.gallery-card[data-id="dog"]'));
    await oldAppendResponse;
    assert.deepEqual(await page.locator('.gallery-card-prompt').allTextContents(), ['DOG RESULT'],
      'a stale append response must not add an old-filter photo');

    // The old Load-more control remains visible while a replacement request
    // runs; clicking it must not launch a new-filter append at the old offset.
    await page.locator('#gallery-search').fill('cat');
    await page.waitForFunction(() => document.querySelector('.gallery-card[data-id="cat"]'));
    const dogReplacement = page.waitForRequest(request => request.url().includes('search=dog') && request.url().includes('offset=0'));
    await page.locator('#gallery-search').fill('dog');
    await dogReplacement;
    const invalidAppend = page.waitForRequest(request => request.url().includes('search=dog') && request.url().includes('offset=1'), { timeout: 250 }).catch(() => null);
    await page.locator('#gallery-load-more').click();
    assert.equal(await invalidAppend, null, 'Load more is suppressed until the replacement request completes');
    await page.waitForFunction(() => document.querySelector('.gallery-card[data-id="dog"]'));
    assert.deepEqual(await page.locator('.gallery-card-prompt').allTextContents(), ['DOG RESULT']);

    // Auto-load scroll is suppressed immediately on input, before debounce.
    await page.locator('#gallery-search').fill('fox');
    const scrollAppend = page.waitForRequest(request => request.url().includes('search=fox') && request.url().includes('offset=1'), { timeout: 250 }).catch(() => null);
    await page.evaluate(() => {
      const button = document.getElementById('gallery-load-more');
      Object.defineProperty(button, 'offsetParent', { configurable: true, get: () => document.body });
      button.getBoundingClientRect = () => ({ top: 0 });
      document.dispatchEvent(new Event('scroll'));
    });
    assert.equal(await scrollAppend, null, 'scroll pagination is suppressed during the pending filter debounce');
    await page.waitForFunction(() => document.querySelector('.gallery-card[data-id="fox"]'));

    // A latest failure is visible and does not destroy the last successful
    // results, so the user can tell the filter refresh did not complete.
    await page.locator('#gallery-search').fill('missing');
    await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('show'));
    assert.match(await page.locator('#toast').textContent(), /Could not refresh gallery photos/);
    assert.deepEqual(await page.locator('.gallery-card-prompt').allTextContents(), ['FOX RESULT']);
    await page.evaluate(() => document.querySelector('#toast')?.classList.remove('show', 'error'));

    // Input invalidates in-flight responses immediately, before its 300ms
    // debounce launches the replacement request; obsolete failure is silent.
    const slowError = page.waitForRequest(request => request.url().includes('search=slowerror'));
    await page.locator('#gallery-search').fill('slowerror');
    await slowError;
    const currentDog = page.waitForResponse(response => response.url().includes('search=dog') && response.url().includes('offset=0'));
    await page.locator('#gallery-search').fill('dog');
    await currentDog;
    await page.waitForFunction(() => document.querySelector('#gallery-grid')?.getAttribute('aria-busy') !== 'true');
    await page.waitForTimeout(450);
    assert.deepEqual(await page.locator('.gallery-card-prompt').allTextContents(), ['DOG RESULT']);
    assert.equal(await page.locator('#toast').evaluate(el => el.classList.contains('show')), false,
      'superseded failure must not report an error after the newer search succeeds');

    // A response from a closed gallery must not overwrite the next gallery
    // session, even when reopening starts a request for another filter.
    const closingRequest = page.waitForRequest(request => request.url().includes('search=slowclose'));
    await page.locator('#gallery-search').fill('slowclose');
    await closingRequest;
    const closingResponse = page.waitForResponse(response => response.url().includes('search=slowclose'));
    await page.evaluate(() => window.gallery.closeGallery());
    await page.waitForFunction(() => !document.getElementById('gallery-modal'));
    await page.evaluate(() => window.gallery.openGallery());
    await page.waitForFunction(() => document.querySelector('#gallery-search'));
    await page.locator('#gallery-search').fill('reopen');
    await page.waitForFunction(() => document.querySelector('.gallery-card[data-id="reopen"]'));
    await closingResponse;
    assert.deepEqual(await page.locator('.gallery-card-prompt').allTextContents(), ['REOPEN RESULT']);

    // Repeated gallery sessions must detach each document scroll handler.
    await page.evaluate(() => {
      const add = document.addEventListener;
      const remove = document.removeEventListener;
      const track = { add: [], remove: [], originalAdd: add, originalRemove: remove };
      document.addEventListener = function(type, listener, options) {
        if (type === 'scroll' && options === true) track.add.push(listener);
        return add.call(this, type, listener, options);
      };
      document.removeEventListener = function(type, listener, options) {
        if (type === 'scroll' && options === true) track.remove.push(listener);
        return remove.call(this, type, listener, options);
      };
      window.__scrollTrack = track;
      window.gallery.closeGallery();
    });
    await page.waitForFunction(() => !document.getElementById('gallery-modal'));
    await page.evaluate(() => { window.__scrollTrack.add.length = 0; window.__scrollTrack.remove.length = 0; });
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.gallery.openGallery());
      await page.waitForFunction(() => !!document.getElementById('gallery-modal'));
      await page.evaluate(() => window.gallery.closeGallery());
      await page.waitForFunction(() => !document.getElementById('gallery-modal'));
    }
    const scrollCounts = await page.evaluate(() => {
      const track = window.__scrollTrack;
      document.addEventListener = track.originalAdd;
      document.removeEventListener = track.originalRemove;
      return { added: track.add.length, removed: track.remove.length,
        eachRemoved: track.add.every(listener => track.remove.includes(listener)) };
    });
    assert.deepEqual(scrollCounts, { added: 3, removed: 3, eachRemoved: true },
      'gallery close must remove each per-open scroll listener');
    assert.deepEqual(pageErrors, []);

    // First-load failure must replace skeletons with a truthful error and a
    // retry action, never misreport a failed request as an empty library.
    await page.evaluate(() => fetch('/__fail-next-library'));
    const emptyPage = await browser.newPage();
    const emptyPageErrors = [];
    emptyPage.on('pageerror', error => emptyPageErrors.push(error.stack || error.message));
    await emptyPage.goto(`http://127.0.0.1:${server.address().port}`);
    await emptyPage.waitForFunction(() => document.querySelector('.gallery-load-error') ||
      document.querySelector('#gallery-grid .gallery-empty[role="alert"]'));
    await emptyPage.waitForFunction(() => document.querySelector('#gallery-grid')?.getAttribute('aria-busy') !== 'true');
    assert.match(await emptyPage.locator('#gallery-grid').textContent(), /Could not load photos/);
    assert.doesNotMatch(await emptyPage.locator('#gallery-grid').textContent(), /No photos yet/);
    assert.equal(await emptyPage.locator('.gallery-card-skeleton').count(), 0);
    const retry = emptyPage.waitForResponse(response => response.url().includes('/api/gallery/library') && response.status() === 200);
    await emptyPage.locator('#gallery-grid button').filter({ hasText: 'Retry' }).click();
    await retry;
    await emptyPage.waitForFunction(() => document.querySelector('.gallery-card[data-id="all"]'));
    assert.deepEqual(emptyPageErrors, []);
    console.log('PASS: gallery filter races preserve current results and report current failures');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
