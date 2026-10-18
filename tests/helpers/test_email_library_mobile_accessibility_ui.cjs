const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
const evidenceDir = process.env.EVIDENCE_DIR || require('node:os').tmpdir();
const email = {
  uid: '17', account_id: 'fixture', folder: 'INBOX', from_name: 'Fixture Sender',
  from_address: 'sender@example.invalid', to: 'reader@example.invalid',
  subject: 'Synthetic accessibility fixture', date: '2026-10-17T12:00:00Z',
  preview: 'Synthetic preview', body_text: 'Synthetic email body.', is_read: true,
  is_answered: false, is_flagged: false, has_attachments: false, tags: [],
};
const account = { id: 'fixture', name: 'Fixture Inbox', from_address: 'reader@example.invalid', is_default: true };
const api = [];
let css = '';
const json = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><html lang="en" class="nx-workspace theme-novum-xenium"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="theme-novum-xenium"><div id="sidebar" class="hidden"></div><div id="sidebar-backdrop"></div><div id="minimized-dock"></div><div id="toast"></div><div id="chat-container"></div><script type="module">import * as email from '/static/js/emailLibrary.js'; window.openFixture=()=>email.openEmailLibrary({account_id:'fixture'}); window.fixtureReady=true;</script></body></html>`);
  }
  if (url.pathname.startsWith('/api/')) {
    api.push({ path: url.pathname, method: req.method });
    if (url.pathname === '/api/email/accounts') return json(res, { accounts: [account] });
    if (url.pathname === '/api/email/list') return json(res, { emails: [email], total: 1, sync: { source: 'fixture' } });
    if (url.pathname === '/api/email/folders') return json(res, { folders: ['INBOX', 'Sent', 'Archive'] });
    if (url.pathname === '/api/email/unread-state') return json(res, { unread_count: 0, max_uid: 17 });
    if (url.pathname === '/api/email/config') return json(res, { enabled: true, viewInlineImages: false });
    if (url.pathname === '/api/email/read/17') return json(res, { ...email, body_html: '<p>Synthetic email body only.</p>' });
    if (url.pathname === '/api/calendar/events') return json(res, { events: [] });
    return json(res, {});
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/static\//, '');
  const file = path.resolve(staticRoot, rel);
  if (!url.pathname.startsWith('/static/') || !file.startsWith(staticRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end();
  }
  const mime = { '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

function box(el) {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

async function settleModal(page) {
  await page.evaluate(async () => {
    const pending = document.getAnimations({ subtree: true }).filter(animation =>
      animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming?.().endTime));
    await Promise.all(pending.map(animation => animation.finished.catch(() => {})));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.evaluate(() => { window.__emailModalStableSample = null; window.__emailModalStableFrames = 0; });
  await page.waitForFunction(() => {
    const modal = document.querySelector('#email-lib-modal .doclib-modal-content');
    if (!modal) return false;
    const r = modal.getBoundingClientRect();
    const sample = [r.x, r.y, r.width, r.height, modal.scrollTop, window.scrollY];
    const previous = window.__emailModalStableSample;
    window.__emailModalStableFrames = previous && sample.every((value, i) => Math.abs(value - previous[i]) < 0.25)
      ? window.__emailModalStableFrames + 1 : 0;
    window.__emailModalStableSample = sample;
    return window.__emailModalStableFrames >= 3;
  }, null, { timeout: 5000 });
}

async function scrollModalToTop(page) {
  await page.evaluate(() => {
    document.querySelector('#email-lib-modal .doclib-modal-content')?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
  await settleModal(page);
}

(async () => {
  css = await (await import(path.join(repo, 'tests/helpers/stylesheets.mjs'))).appCss();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    let readCount = 0;
    page.on('pageerror', error => errors.push(error.stack || error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/email/read/17') readCount++; });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => window.openFixture());
    await page.waitForSelector('.doclib-card[data-uid="17"] .email-card-open-button');
    await settleModal(page);
    await scrollModalToTop(page);
    fs.mkdirSync(evidenceDir, { recursive: true });

    const subject = page.locator('.doclib-card[data-uid="17"] .email-card-open-button');
    const titleState = await subject.evaluate(el => ({ tag: el.tagName, type: el.type, role: el.getAttribute('role'), name: el.textContent.trim(), tabIndex: el.tabIndex }));
    assert.deepEqual(titleState, { tag: 'BUTTON', type: 'button', role: null, name: email.subject, tabIndex: 0 });
    await page.locator('.email-account-chip').focus();
    let reachedSubjectByTab = false;
    for (let i = 0; i < 30; i++) {
      if (await subject.evaluate(el => el === document.activeElement)) { reachedSubjectByTab = true; break; }
      await page.keyboard.press('Tab');
    }
    assert.equal(reachedSubjectByTab, true, 'Tab sequence did not reach email subject button');
    const keyboardEvidence = { tabReachedSubject: reachedSubjectByTab };

    // Child action buttons remain their own keyboard targets and do not bubble
    // into the row's expansion handler.
    await page.locator('.doclib-card[data-uid="17"] button[title="Actions"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.doclib-card[data-uid="17"]').evaluate(el => el.classList.contains('email-card-expanded')), false);
    assert.equal(readCount, 0);
    keyboardEvidence.childActionStayedSeparate = true;
    await page.keyboard.press('Escape');

    // Native Enter and Space activate exactly once through the existing card
    // handler in normal mode.
    await subject.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.doclib-card[data-uid="17"].email-card-expanded');
    await settleModal(page);
    assert.equal(readCount, 1);
    keyboardEvidence.enterOpenReadRequests = readCount;
    await subject.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('.doclib-card[data-uid="17"]')?.classList.contains('email-card-expanded'));
    await settleModal(page);
    const afterSpaceCollapse = readCount;
    await subject.focus();
    await page.keyboard.press('Space');
    await page.waitForSelector('.doclib-card[data-uid="17"].email-card-expanded');
    await settleModal(page);
    assert.equal(readCount, afterSpaceCollapse + 1);
    keyboardEvidence.spaceOpenReadRequests = readCount;
    await page.screenshot({ path: path.join(evidenceDir, 'email-reader-390.png') });

    // In select mode the same native subject target must toggle selection once,
    // without fetching the reader. The checkbox remains a separate control.
    await subject.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.doclib-card[data-uid="17"]')?.classList.contains('email-card-expanded'));
    await page.locator('#email-lib-select-btn').click();
    const readBeforeSelection = readCount;
    await subject.focus();
    await page.keyboard.press('Enter');
    const selectedOnce = await page.locator('.doclib-card[data-uid="17"] .memory-select-cb').isChecked();
    assert.equal(selectedOnce, true);
    assert.equal(await page.locator('.doclib-card[data-uid="17"]').evaluate(el => el.classList.contains('email-card-expanded')), false);
    assert.equal(readCount, readBeforeSelection);
    keyboardEvidence.selectModeEnterCheckedOnce = selectedOnce;
    keyboardEvidence.selectModeDidNotOpenReader = readCount === readBeforeSelection;
    await subject.focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('.doclib-card[data-uid="17"] .memory-select-cb').isChecked(), false);
    assert.equal(readCount, readBeforeSelection);
    keyboardEvidence.selectModeSpaceUncheckedOnce = true;
    await page.locator('#email-lib-select-btn').click();
    await subject.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.doclib-card[data-uid="17"].email-card-expanded');

    const viewportResults = [];
    for (const [width, height, label] of [[320, 844, '320x844'], [390, 844, '390x844'], [430, 844, '430x844'], [600, 320, '600x320-landscape']]) {
      await page.setViewportSize({ width, height });
      if (await page.locator('.doclib-card[data-uid="17"]').evaluate(el => el.classList.contains('email-card-expanded'))) {
        await subject.click();
        await page.waitForFunction(() => !document.querySelector('.doclib-card[data-uid="17"]')?.classList.contains('email-card-expanded'));
      }
      await scrollModalToTop(page);
      const header = await page.evaluate(() => {
        const getBox = selector => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { x:r.x,y:r.y,width:r.width,height:r.height,visible:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight }; };
        const targets = ['.email-account-chip','#email-lib-compose-btn','#email-lib-fab','#email-folder-btn','#email-filter-btn','#email-lib-select-btn','#email-lib-refresh-btn','#email-lib-settings-btn','#email-search-options-btn'];
        const boxes = Object.fromEntries(targets.map(s => [s,getBox(s)]));
        const overlap = (a,b) => a.x < b.x+b.width-1 && a.x+a.width > b.x+1 && a.y < b.y+b.height-1 && a.y+a.height > b.y+1;
        const visibleBoxes = Object.values(boxes).filter(b=>b?.visible);
        const headerOverlaps = visibleBoxes.some((a,i)=>visibleBoxes.slice(i+1).some(b=>overlap(a,b)));
        const newSearchOverlap = (boxes['#email-lib-fab']?.visible && overlap(boxes['#email-lib-fab'], boxes['#email-search-options-btn'])) || (boxes['#email-lib-compose-btn']?.visible && overlap(boxes['#email-lib-compose-btn'], boxes['#email-search-options-btn']));
        const searchBox = getBox('#email-lib-chip-bar');
        const modal = document.querySelector('#email-lib-modal .doclib-modal-content');
        const scrollers = [...document.querySelectorAll('#email-lib-modal .doclib-modal-content, #email-lib-modal .modal-body, #email-lib-modal #email-lib-grid')].map(el=>({el,overflowY:getComputedStyle(el).overflowY,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,scrollTop:el.scrollTop}));
        return {boxes,searchBox,headerOverlaps,newSearchOverlap,documentWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth,viewport:{width:innerWidth,height:innerHeight},modalScroll:{clientHeight:modal?.clientHeight,scrollHeight:modal?.scrollHeight,scrollTop:modal?.scrollTop,scrollers:scrollers.map(({el,...data})=>data)}};
      });
      if (label === '320x844' || label === '390x844' || label === '600x320-landscape') {
        await page.screenshot({ path: path.join(evidenceDir, `email-mobile-${label}.png`) });
      }
      for (const selector of ['.email-account-chip','#email-folder-btn','#email-filter-btn','#email-lib-select-btn','#email-lib-refresh-btn','#email-lib-settings-btn','#email-search-options-btn']) {
        assert.equal(header.boxes[selector]?.visible, true, `${label} ${selector} does not intersect the viewport`);
      }
      assert.equal(header.searchBox?.visible, true, `${label} search field does not intersect the viewport`);
      if (width <= 768 && height <= 400) {
        assert.equal(header.boxes['#email-lib-compose-btn']?.visible, true, `${label} header New action is not visible`);
        assert.equal(header.boxes['#email-lib-fab']?.visible, false, `${label} floating New action should be hidden`);
        const scrollable = header.modalScroll.scrollers.find(item => ['auto','scroll'].includes(item.overflowY) && item.scrollHeight > item.clientHeight + 1);
        assert.ok(scrollable, `${label} modal body has no scrollable overflow region`);
        const scrolled = await page.evaluate(() => {
          const el = [...document.querySelectorAll('#email-lib-modal .doclib-modal-content, #email-lib-modal .modal-body, #email-lib-modal #email-lib-grid')].find(node => ['auto','scroll'].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1);
          if (!el) return false;
          el.scrollTop = el.scrollHeight;
          const moved = el.scrollTop > 0;
          el.scrollTop = 0;
          return moved;
        });
        assert.equal(scrolled, true, `${label} modal body did not scroll`);
        await scrollModalToTop(page);
      } else {
        assert.equal(header.boxes['#email-lib-fab']?.visible, true, `${label} mobile New action FAB is not visible`);
        assert.equal(header.boxes['#email-lib-compose-btn']?.visible, false, `${label} desktop New action should stay hidden on mobile`);
      }
      for (const [selector, target] of Object.entries(header.boxes)) {
        if (target?.visible) {
          assert.ok(target.width >= 44, `${label} ${selector} target width ${target.width} < 44`);
          assert.ok(target.height >= 44, `${label} ${selector} target height ${target.height} < 44`);
        }
      }
      assert.ok(header.searchBox.height >= 44, `${label} search target height ${header.searchBox.height} < 44`);
      assert.equal(header.newSearchOverlap, false, `${label} New action overlaps search options`);
      assert.equal(header.headerOverlaps, false, `${label} email header controls overlap`);
      assert.equal(header.overflow, false, `${label} horizontal overflow width=${header.documentWidth}`);

      await subject.focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.doclib-card[data-uid="17"].email-card-expanded');
      await settleModal(page);
      await scrollModalToTop(page);
      const reader = await page.evaluate(() => {
        const getBox = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return{x:r.x,y:r.y,width:r.width,height:r.height,rendered:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none',visible:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight}; };
        const readerActions = [...document.querySelectorAll('.email-reader-actions-inline .reader-icon-btn')].map(el => ({act:el.dataset.act,...getBox(el)})).filter(el=>el.rendered);
        const overlap = (a,b) => a.x < b.x+b.width-1 && a.x+a.width > b.x+1 && a.y < b.y+b.height-1 && a.y+a.height > b.y+1;
        const visibleActions = readerActions.filter(action=>action.visible);
        const readerOverlaps = visibleActions.some((a,i)=>visibleActions.slice(i+1).some(b=>overlap(a,b)));
        const width=document.documentElement.scrollWidth;
        return {readerActions,readerOverlaps,documentWidth:width,overflow:width>innerWidth};
      });
      for (const action of reader.readerActions) {
        assert.equal(action.visible, true, `${label} reader ${action.act} does not intersect the viewport`);
        assert.ok(action.width >= 44, `${label} reader ${action.act} target width ${action.width} < 44`);
        assert.ok(action.height >= 44, `${label} reader ${action.act} target height ${action.height} < 44`);
      }
      for (const primaryAction of ['ai-reply','reply','more']) assert.ok(reader.readerActions.some(action=>action.act===primaryAction), `${label} missing visible ${primaryAction} action`);
      assert.equal(reader.readerOverlaps, false, `${label} reader action buttons overlap`);
      assert.equal(reader.overflow, false, `${label} reader horizontal overflow width=${reader.documentWidth}`);
      viewportResults.push({ label, header, reader });
      console.log(`PASS ${label}`);
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidenceDir, 'next-email-ux-results.json'), JSON.stringify({ titleState, keyboardEvidence, readerOpenRequestsAcrossViewportChecks: readCount, layoutValidation: 'Waited for animations and stable modal geometry; controls must intersect the viewport; modal content is scrolled deliberately for short landscape checks.', shortLandscapeNewAction: 'Header New action shown and floating New action hidden.', viewportResults, errors, api }, null, 2));
    console.log('PASS keyboard Enter/Space, select mode, child action, and mobile targets');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); server.close(); process.exitCode = 1; });
