// Synthetic-only regression for document._saveDraft response ownership.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const state = { saveRequests: [], held: [], externalRequests: 0 };
const html = `<!doctype html><meta charset="utf-8"><body>
<div id="toast"></div><div id="chat-container" style="height:100vh"></div>
<script>
  window.__draftJsonEntered = 0;
  window.__draftJsonCompleted = 0;
  window.__holdNextDraftJson = false;
  window.__releaseDraftJson = null;
  const fixtureFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await fixtureFetch(...args);
    if (new URL(args[0], window.location.href).pathname === '/api/email/draft') {
      const originalJson = response.json.bind(response);
      response.json = async (...jsonArgs) => {
        const value = await originalJson(...jsonArgs);
        if (window.__holdNextDraftJson) {
          window.__holdNextDraftJson = false;
          window.__draftJsonEntered += 1;
          await new Promise(resolve => { window.__releaseDraftJson = resolve; });
          window.__releaseDraftJson = null;
        }
        window.__draftJsonCompleted += 1;
        return value;
      };
    }
    return response;
  };
</script>
<script type="module">
  import doc from '/static/js/document.js';
  import sessions from '/static/js/sessions.js';
  doc.init(window.location.origin);
  sessions.setCurrentSessionId('fixture-session');
  window.fixture = { doc, sessions };
  window.fixtureReady = true;
</script></body>`;
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname === '/api/email/draft' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const index = state.saveRequests.push(body) - 1;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    state.held[index] = { release: () => { json(res, { success: true, draft_uid: `fixture-saved-${index}`, draft_folder: 'Drafts' }); release(); } };
    await gate;
    return;
  }
  if (url.pathname === '/__held') return json(res, { count: state.held.length, requests: state.saveRequests });
  if (url.pathname.startsWith('/__release/')) { const index = Number(url.pathname.split('/').pop()); state.held[index]?.release(); res.writeHead(204); return res.end(); }
  if (url.pathname === '/api/document' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    return json(res, { id: `fixture-doc-${body.title}`, title: body.title, language: body.language, content: body.content, current_content: body.content, session_id: body.session_id });
  }
  if (url.pathname === '/api/settings') return json(res, {});
  if (url.pathname.startsWith('/api/')) return json(res, {});
  const file = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${repo}${path.sep}`) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
async function waitFor(predicate, label) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function releaseServerResponse(page, index) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/email/draft') && response.request().method() === 'POST');
  await page.evaluate(i => fetch(`/__release/${i}`, { method: 'POST' }), index);
  await response;
}
async function releaseAndWait(page, index) {
  await releaseServerResponse(page, index);
  await page.waitForFunction(expected => window.__draftJsonCompleted === expected, index + 1);
}
async function save(page, expectedCount, label) {
  await page.locator('#doc-email-more-menu').evaluate(el => { el.style.display = 'block'; });
  await page.locator('#doc-email-draft-btn').click();
  await waitFor(async () => (await (await page.request.get(`${page.url().replace(/\/$/, '')}/__held`)).json()).count === expectedCount, label);
  return (await (await page.request.get(`${page.url().replace(/\/$/, '')}/__held`)).json()).requests[expectedCount - 1];
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.stack || e.message));
    await page.route('**/*', route => {
      let requestOrigin = '';
      try { requestOrigin = new URL(route.request().url()).origin; } catch (_) {}
      if (requestOrigin !== origin) { state.externalRequests++; return route.abort(); }
      return route.continue();
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(async () => {
      await window.fixture.doc.openEmailDraft({ to: 'a@example.invalid', subject: 'A', body: 'Synthetic A', uid: 'fixture-original-a', folder: 'Drafts' });
      await window.fixture.doc.openEmailDraft({ to: 'b@example.invalid', subject: 'B', body: 'Synthetic B' });
    });
    await page.waitForSelector('.doc-tab');
    await page.evaluate(() => {
      const a = [...document.querySelectorAll('.doc-tab')].find(el => el.textContent.includes('A'));
      if (!a) throw new Error('A tab not found');
      a.click();
    });
    await page.waitForFunction(() => window.fixture.doc.getCurrentDocId() === 'fixture-doc-A', null, { timeout: 3000 }).catch(async () => { throw new Error(JSON.stringify(await page.evaluate(() => ({ id: window.fixture.doc.getCurrentDocId(), tabs: [...document.querySelectorAll('.doc-tab')].map(el => ({ id: el.dataset.docId, text: el.textContent })) })))); });
    const aSave = await save(page, 1, 'held A save');
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.doc-tab')].find(el => el.textContent.includes('B'));
      if (!b) throw new Error('B tab not found');
      b.click();
    });
    await page.waitForFunction(() => window.fixture.doc.getCurrentDocId() === 'fixture-doc-B');
    await releaseAndWait(page, 0);
    const bAfterA = await save(page, 2, 'B save after A completion');
    await releaseAndWait(page, 1);
    await page.evaluate(() => {
      const a = [...document.querySelectorAll('.doc-tab')].find(el => el.dataset.docId === 'fixture-doc-A');
      if (!a) throw new Error('A tab not found after switching to B');
      a.click();
    });
    await page.waitForFunction(() => window.fixture.doc.getCurrentDocId() === 'fixture-doc-A');
    const aFollowup = await save(page, 3, 'A follow-up save');
    await releaseAndWait(page, 2);

    // Same-document positive control: completion should attach its UID to that document.
    await page.evaluate(async () => { await window.fixture.doc.openEmailDraft({ to: 'c@example.invalid', subject: 'C', body: 'Synthetic C' }); });
    const cSave = await save(page, 4, 'held C save');
    await releaseAndWait(page, 3);
    const cFollowup = await save(page, 5, 'C follow-up save');
    await releaseAndWait(page, 4);

    // A removed while its request is pending must not transfer its UID to a replacement document.
    await page.evaluate(async () => { await window.fixture.doc.openEmailDraft({ to: 'd@example.invalid', subject: 'D', body: 'Synthetic D' }); });
    const dSave = await save(page, 6, 'held D save');
    await page.evaluate(async () => {
      window.fixture.doc.clearAll();
      await window.fixture.doc.openEmailDraft({ to: 'e@example.invalid', subject: 'E', body: 'Synthetic E' });
    });
    await page.waitForFunction(() => window.fixture.doc.getCurrentDocId() === 'fixture-doc-E');
    await releaseAndWait(page, 5);
    const eAfterDRemoved = await save(page, 7, 'E save after D removed');
    await releaseAndWait(page, 6);
    await page.evaluate(async () => {
      await window.fixture.doc.openEmailDraft({ to: 'f@example.invalid', subject: 'F', body: 'Synthetic existing draft', uid: 'fixture-existing-uid', folder: 'Drafts' });
    });
    const existingDraftMetadata = await save(page, 8, 'existing draft metadata save');
    await releaseAndWait(page, 7);

    // Hold parsed JSON before the production await resumes, then switch tabs.
    await page.evaluate(async () => {
      await window.fixture.doc.openEmailDraft({ to: 'g@example.invalid', subject: 'G', body: 'Synthetic G' });
      await window.fixture.doc.openEmailDraft({ to: 'h@example.invalid', subject: 'H', body: 'Synthetic H' });
    });
    await page.evaluate(() => {
      const g = [...document.querySelectorAll('.doc-tab')].find(el => el.dataset.docId === 'fixture-doc-G');
      if (!g) throw new Error('G tab not found');
      g.click();
      window.__holdNextDraftJson = true;
    });
    await page.waitForFunction(() => window.fixture.doc.getCurrentDocId() === 'fixture-doc-G');
    const gSave = await save(page, 9, 'held G save');
    await releaseServerResponse(page, 8);
    await page.waitForFunction(() => window.__draftJsonEntered === 1, null);
    await page.evaluate(() => {
      const h = [...document.querySelectorAll('.doc-tab')].find(el => el.dataset.docId === 'fixture-doc-H');
      if (!h) throw new Error('H tab not found');
      h.click();
    });
    await page.waitForFunction(() => window.fixture.doc.getCurrentDocId() === 'fixture-doc-H');
    await page.evaluate(() => window.__releaseDraftJson());
    await page.waitForFunction(() => window.__draftJsonCompleted === 9);
    const hAfterG = await save(page, 10, 'H save after G JSON completion');
    await releaseAndWait(page, 9);
    await page.evaluate(() => {
      const g = [...document.querySelectorAll('.doc-tab')].find(el => el.dataset.docId === 'fixture-doc-G');
      if (!g) throw new Error('G tab not found after H switch');
      g.click();
    });
    await page.waitForFunction(() => window.fixture.doc.getCurrentDocId() === 'fixture-doc-G');
    const gAfterJson = await save(page, 11, 'G save after JSON completion');
    await releaseAndWait(page, 10);
    assert.equal(aSave.subject, 'A');
    assert.equal(bAfterA.subject, 'B');
    assert.equal(bAfterA.draft_uid, null, 'A completion must not attach its UID to active B');
    assert.equal(aFollowup.draft_uid, 'fixture-saved-0', 'A retains its own save result after switching back');
    assert.equal(cSave.subject, 'C');
    assert.equal(cFollowup.draft_uid, 'fixture-saved-3', 'same-context positive control retains returned UID');
    assert.equal(dSave.subject, 'D');
    assert.equal(eAfterDRemoved.draft_uid, null, 'removed D result must not attach to replacement E');
    assert.equal(gSave.subject, 'G');
    assert.equal(hAfterG.draft_uid, null, 'held G JSON completion must not attach its UID to H');
    assert.equal(gAfterJson.draft_uid, 'fixture-saved-8', 'G retains its UID after JSON completion while H was active');
    assert.equal(state.externalRequests, 0);
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log(JSON.stringify({ pass: true, externalRequests: state.externalRequests, pageErrors: errors, cases: { aSave, bAfterA, aFollowup, cSave, cFollowup, dSave, eAfterDRemoved, gSave, hAfterG, gAfterJson }, observations: { existingDraftMetadata } }));
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.closeAllConnections?.(); server.close(); process.exitCode = 1; });
