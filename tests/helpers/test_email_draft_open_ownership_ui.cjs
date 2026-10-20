// Actual frontend modules against a loopback-only synthetic mail/document server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const state = { readMode: 'normal', postMode: 'normal', reads: [], posts: [], requests: [], externalRequests: 0 };
const accounts = [
  { id: 'fixture-account-a', name: 'Fixture A', from_address: 'a@example.invalid' },
  { id: 'fixture-account-b', name: 'Fixture B', from_address: 'b@example.invalid' },
];
const html = `<!doctype html><meta charset="utf-8"><body>
<div id="toast"></div><div id="chat-container" style="height:100vh"></div>
<script type="module">
  import doc from '/static/js/document.js';
  import * as inbox from '/static/js/emailInbox.js';
  import sessions from '/static/js/sessions.js';
  import { openEmailLibrary, mountEmailSettings } from '/static/js/emailLibrary/index.js?v=20260915trashmove2';
  import { state as emailState } from '/static/js/emailLibrary/state.js';
  doc.init(window.location.origin); sessions.setCurrentSessionId('fixture-session'); doc.openPanel(); inbox.init(doc);
  window.fixture = { doc, inbox, sessions, openEmailLibrary, mountEmailSettings, emailState };
  window.fixtureReady = true;
</script></body>`;
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  state.requests.push(`${req.method} ${url.pathname}${url.search}`);
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname === '/__state') return json(res, { reads: state.reads.map(x => x.started), posts: state.posts.map(x => x.started) });
  if (url.pathname === '/__reset') {
    state.readMode = url.searchParams.get('read') || 'normal';
    state.postMode = url.searchParams.get('post') || 'normal';
    state.reads = []; state.posts = [];
    return json(res, { ok: true });
  }
  if (url.pathname.startsWith('/__release/read/')) {
    state.reads[Number(url.pathname.split('/').pop())]?.release();
    res.writeHead(204); return res.end();
  }
  if (url.pathname.startsWith('/__release/post/')) {
    state.posts[Number(url.pathname.split('/').pop())]?.release();
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/email/accounts') return json(res, { accounts });
  if (url.pathname === '/api/email/folders') return json(res, { folders: ['INBOX', 'Drafts'] });
  if (url.pathname === '/api/email/config') return json(res, { configured: true });
  if (url.pathname === '/api/email/unread-state') return json(res, {});
  if (url.pathname === '/api/email/list') {
    const account = url.searchParams.get('account_id') || 'fixture-account-a';
    const suffix = account.endsWith('-b') ? 'b' : 'a';
    return json(res, { emails: [{ uid: `fixture-draft-${suffix}`, account_id: account, folder: 'Drafts', subject: `Synthetic draft ${suffix.toUpperCase()}`, from_address: `${suffix}@example.invalid`, to: 'recipient@example.invalid', is_read: true }], total: 1 });
  }
  if (url.pathname.startsWith('/api/email/read/')) {
    const index = state.reads.length;
    const held = state.readMode !== 'normal' ? gate() : null;
    state.reads.push({ started: true, release: held?.release || (() => {}) });
    if (held) await held.promise;
    const bad = state.readMode === 'error';
    const uid = url.pathname.split('/').pop();
    const suffix = uid.endsWith('-b') ? 'B' : 'A';
    return json(res, { uid, subject: `Synthetic draft ${suffix}`, account_id: `fixture-account-${suffix.toLowerCase()}`, folder: 'Drafts', source_uid: `fixture-source-${suffix.toLowerCase()}`, source_folder: 'Drafts', in_reply_to: `fixture-message-${suffix.toLowerCase()}`, to: 'recipient@example.invalid', body: `Fixture draft ${suffix}`, is_read: true }, bad ? 503 : 200);
  }
  if (url.pathname === '/api/document' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const index = state.posts.length;
    const doc = { id: `fixture-doc-${index}`, title: body.title, language: 'email', content: body.content, current_content: body.content, session_id: body.session_id };
    if (state.postMode === 'headers') {
      const held = gate();
      state.posts.push({ started: true, release: () => { res.end(JSON.stringify(doc)); held.release(); } });
      res.writeHead(201, { 'Content-Type': 'application/json' }); res.flushHeaders();
      await held.promise;
      return;
    }
    const held = state.postMode !== 'normal' ? gate() : null;
    state.posts.push({ started: true, release: held?.release || (() => {}) });
    if (held) await held.promise;
    return json(res, doc, state.postMode === 'error' ? 503 : 201);
  }
  if (url.pathname === '/api/prefs/theme' || url.pathname === '/api/auth/settings' || url.pathname === '/api/tools' || url.pathname === '/api/auth/status' || url.pathname === '/api/prefs/custom-themes' || url.pathname === '/api/tts/stats' || url.pathname === '/api/settings') return json(res, {});
  if (url.pathname.startsWith('/api/')) return json(res, {});
  const file = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${repo}${path.sep}`) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const browser = null;
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-gpu'] });
  const errors = [];
  let externalRequests = 0;
  const open = async ({ read = 'normal', post = 'normal' } = {}) => {
    const page = await chrome.newPage();
    page.on('pageerror', e => errors.push(e.stack || e.message));
    await page.route('**/*', route => {
      let requestOrigin = '';
      try { requestOrigin = new URL(route.request().url()).origin; } catch (_) {}
      if (requestOrigin !== origin) { externalRequests++; return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(() => {
      window.__fixtureFetchBodies = [];
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        const requestUrl = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href);
        if (requestUrl.pathname.startsWith('/api/email/read/') || requestUrl.pathname === '/api/document') {
          response.clone().text().then(() => window.__fixtureFetchBodies.push(requestUrl.pathname));
        }
        return response;
      };
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('#doc-editor-pane'));
    await page.evaluate(({ read, post }) => fetch(`/__reset?read=${read}&post=${post}`), { read, post });
    await page.evaluate(() => window.fixture.openEmailLibrary({ folder: 'Drafts', account_id: 'fixture-account-a' }));
    await page.waitForSelector('.doclib-card[data-uid="fixture-draft-a"]');
    await page.waitForSelector('.email-account-chip[data-acc-id="fixture-account-b"]');
    return page;
  };
  const count = async (page, field) => page.evaluate(async field => (await (await fetch('/__state')).json())[field].length, field);
  const waitBody = (page, pathname, count = 1) => page.waitForFunction(({ pathname, count }) =>
    window.__fixtureFetchBodies.filter(value => value === pathname).length >= count, { pathname, count });
  const nextTask = page => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  const switchAccount = async (page, account) => {
    await page.locator(`.email-account-chip[data-acc-id="fixture-account-${account}"]`).click();
    await page.waitForFunction(account => window.__odysseusActiveEmailAccount === `fixture-account-${account}`, account);
  };
  const clickDraft = async (page, account = 'a') => {
    const uid = `fixture-draft-${account}`;
    await page.waitForSelector(`.doclib-card[data-uid="${uid}"]`);
    await page.locator(`.doclib-card[data-uid="${uid}"]`).click();
  };
  const release = async (page, kind, index) => page.evaluate(({ kind, index }) => fetch(`/__release/${kind}/${index}`, { method: 'POST' }), { kind, index });
  const currentDoc = page => page.evaluate(() => ({ id: window.fixture.doc.getCurrentDocId(), text: document.querySelector('#doc-editor-textarea')?.value || '' }));
  const localDraftKey = suffix => `odysseus.email.replyDraft.v1:${encodeURIComponent(`Drafts|fixture-source-${suffix}|fixture-message-${suffix}`)}`;
  const results = {};
  try {
    // A read response that becomes stale before the document POST must not create a draft document or show its error.
    {
      const page = await open({ read: 'error' });
      await clickDraft(page);
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).reads.length === 1);
      await switchAccount(page, 'b');
      await release(page, 'read', 0);
      await waitBody(page, '/api/email/read/fixture-draft-a'); await nextTask(page);
      assert.equal(await count(page, 'posts'), 0, 'stale failed read must not create a document');
      assert.equal((await currentDoc(page)).id, null, 'stale read must not replace editor');
      results.staleReadError = { posts: 0, currentDoc: (await currentDoc(page)).id, account: 'fixture-account-b' };
      await page.close();
    }
    // Hold the actual POST until the user switches mailboxes.
    {
      const page = await open({ post: 'hold' });
      await clickDraft(page);
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).posts.length === 1);
      await switchAccount(page, 'b');
      await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ body: 'Keep local recovery' })), localDraftKey('a'));
      await release(page, 'post', 0);
      await waitBody(page, '/api/document'); await nextTask(page);
      assert.equal((await currentDoc(page)).id, null, 'late A POST must not activate after switching to B');
      assert.ok(await page.evaluate(key => localStorage.getItem(key), localDraftKey('a')), 'stale draft must not clear local recovery');
      results.stalePost = { account: 'fixture-account-b', currentDoc: (await currentDoc(page)).id, localRecoveryPreserved: true };
      await page.close();
    }
    // The separate emailInbox.openReplyDraft caller also rejects A→B→A intent changes.
    {
      const page = await open({ post: 'hold' });
      await page.evaluate(() => { window.__inboxOpen = window.fixture.inbox.openReplyDraft('fixture-draft-a', 'Drafts'); });
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).posts.length === 1);
      await switchAccount(page, 'b'); await switchAccount(page, 'a');
      await release(page, 'post', 0);
      await page.evaluate(() => window.__inboxOpen);
      await waitBody(page, '/api/document'); await nextTask(page);
      assert.equal((await currentDoc(page)).id, null, 'the inbox caller must not revive across A→B→A');
      results.inboxCallerABA = { account: 'fixture-account-a', currentDoc: (await currentDoc(page)).id };
      await page.close();
    }
    // A→B→A is stale too: equality of current account alone must not revive A's old intent.
    {
      const page = await open({ post: 'hold' });
      await clickDraft(page);
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).posts.length === 1);
      await switchAccount(page, 'b'); await switchAccount(page, 'a');
      await release(page, 'post', 0);
      await waitBody(page, '/api/document'); await nextTask(page);
      assert.equal((await currentDoc(page)).id, null, 'A→B→A must not revive the old request generation');
      results.accountABA = { account: 'fixture-account-a', currentDoc: (await currentDoc(page)).id };
      await page.close();
    }
    // The global settings mount has an account selector path separate from the library chip handler.
    {
      const page = await open({ post: 'hold' });
      await clickDraft(page);
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).posts.length === 1);
      await page.evaluate(async () => {
        const shell = document.createElement('div');
        shell.innerHTML = '<div id="settings-email-default-card"><div id="settings-email-default-host"></div></div><section id="fixture-email-settings"><div class="email-settings-page-head"></div><div class="email-settings-body"></div></section>';
        document.body.appendChild(shell);
        await window.fixture.mountEmailSettings(shell.querySelector('#fixture-email-settings'));
      });
      const selector = page.locator('#settings-email-default-host #email-settings-account-select');
      await selector.waitFor();
      await selector.selectOption('fixture-account-b');
      await page.waitForFunction(() => window.__odysseusActiveEmailAccount === 'fixture-account-b');
      await selector.waitFor();
      await selector.selectOption('fixture-account-a');
      await page.waitForFunction(() => window.__odysseusActiveEmailAccount === 'fixture-account-a');
      await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ body: 'Keep settings ABA recovery' })), localDraftKey('a'));
      await release(page, 'post', 0);
      await waitBody(page, '/api/document'); await nextTask(page);
      assert.equal((await currentDoc(page)).id, null, 'settings-selector A→B→A must not revive the old draft intent');
      assert.ok(await page.evaluate(key => localStorage.getItem(key), localDraftKey('a')), 'stale settings-selector intent must preserve matching local recovery');
      results.settingsSelectorABA = { account: 'fixture-account-a', currentDoc: (await currentDoc(page)).id, localRecoveryPreserved: true };
      await page.close();
    }
    // A newer B draft intent supersedes the still-pending A draft; B remains usable.
    {
      const page = await open({ post: 'hold' });
      await clickDraft(page, 'a');
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).posts.length === 1);
      await switchAccount(page, 'b');
      await clickDraft(page, 'b');
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).posts.length === 2);
      await release(page, 'post', 0);
      await waitBody(page, '/api/document', 1); await nextTask(page);
      assert.equal((await currentDoc(page)).id, null, 'older A intent must not activate over B');
      await release(page, 'post', 1);
      await page.waitForFunction(() => window.fixture.doc.getCurrentDocId() === 'fixture-doc-1');
      results.newerDraft = { account: 'fixture-account-b', currentDoc: (await currentDoc(page)).id };
      await page.close();
    }
    // POST headers can resolve while JSON remains pending; ownership is rechecked after res.json().
    {
      const page = await open({ post: 'headers' });
      await clickDraft(page);
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).posts.length === 1);
      await switchAccount(page, 'b');
      await release(page, 'post', 0);
      await waitBody(page, '/api/document'); await nextTask(page);
      assert.equal((await currentDoc(page)).id, null, 'late JSON body must not activate after account switch');
      results.staleJson = { account: 'fixture-account-b', currentDoc: (await currentDoc(page)).id };
      await page.close();
    }
    // Stale failed POSTs must not surface an obsolete error in the new mailbox.
    {
      const page = await open({ post: 'error' });
      await clickDraft(page);
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).posts.length === 1);
      await switchAccount(page, 'b');
      await release(page, 'post', 0);
      await waitBody(page, '/api/document'); await nextTask(page);
      assert.equal((await currentDoc(page)).id, null);
      assert.doesNotMatch(await page.locator('body').innerText(), /Could not open draft|Draft open failed/i,
        'stale failure must not show an obsolete draft error');
      results.stalePostError = { account: 'fixture-account-b', currentDoc: (await currentDoc(page)).id, staleErrorShown: false };
      await page.close();
    }
    // If mailbox changes after response processing but before the scheduled activation frame, the frame must recheck ownership.
    {
      const page = await open({ post: 'hold' });
      await clickDraft(page);
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).posts.length === 1);
      await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ body: 'Keep local recovery' })), localDraftKey('a'));
      await page.evaluate(() => {
        const native = window.requestAnimationFrame.bind(window);
        window.__frames = []; let nextId = 1;
        window.requestAnimationFrame = callback => { const id = nextId++; window.__frames.push({ id, callback }); return id; };
        window.cancelAnimationFrame = id => { window.__frames = window.__frames.filter(frame => frame.id !== id); };
        window.__nativeRaf = native;
      });
      await release(page, 'post', 0);
      await page.waitForFunction(() => window.__frames?.length === 1);
      await switchAccount(page, 'b');
      await page.evaluate(() => {
        const frames = window.__frames.splice(0); window.requestAnimationFrame = window.__nativeRaf;
        for (const frame of frames) frame.callback(performance.now());
      });
      await nextTask(page);
      assert.equal((await currentDoc(page)).id, null, 'deferred activation must recheck mailbox ownership');
      assert.ok(await page.evaluate(key => localStorage.getItem(key), localDraftKey('a')), 'stale frame must not clear local recovery');
      results.staleAnimationFrame = { account: 'fixture-account-b', currentDoc: (await currentDoc(page)).id, localRecoveryPreserved: true };
      await page.close();
    }
    // Same-context positive control.
    {
      const page = await open({ post: 'hold' });
      await clickDraft(page);
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).posts.length === 1);
      await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ body: 'Replace with server draft' })), localDraftKey('a'));
      await release(page, 'post', 0);
      await page.waitForFunction(() => window.fixture.doc.getCurrentDocId() === 'fixture-doc-0');
      assert.equal(await page.evaluate(key => localStorage.getItem(key), localDraftKey('a')), null, 'current draft activation may clear its matching local recovery copy');
      results.sameContext = { account: 'fixture-account-a', currentDoc: (await currentDoc(page)).id, localRecoveryCleared: true };
      await page.close();
    }
    assert.equal(externalRequests, 0, 'all non-fixture origins were blocked');
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    console.log(JSON.stringify({ pass: true, externalRequests, pageErrors: errors, results }));
  } finally {
    await chrome.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); server.closeAllConnections?.(); server.close(); process.exitCode = 1; });
