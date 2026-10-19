// Synthetic actual-module regression for chat destination ownership during initialization.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const staticRoot = path.resolve(__dirname, '../../static');
const html = `<!doctype html><meta charset="utf-8">
<div class="list-item active-session" data-session-id="chat-A"></div>
<textarea id="message"></textarea><div id="attach-strip"></div><input id="file-input" type="file" multiple>
<input id="incognito-toggle" type="checkbox"><input id="web-toggle" type="checkbox"><input id="research-toggle" type="checkbox"><input id="bash-toggle" type="checkbox"><button id="research-toggle-btn"></button>
<div id="chat-history"></div><button class="send-btn"></button><div id="toast"></div>
<script type="module">
  import chat from '/js/chat.js'; import sessions from '/js/sessions.js'; import files from '/js/fileHandler.js?v=20260909mobileattachmentedit1';
  window.modulesReady = Promise.all([chat, sessions, files]).then(() => { window.testModules = { chat, sessions, files }; });
</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.waitForFunction(() => window.testModules);
    await page.evaluate(async () => {
      const { sessions, files } = window.testModules;
      sessions.setCurrentSessionId(null);
      document.querySelector('.list-item').classList.add('active-session');
      document.querySelector('.list-item').dataset.sessionId = 'chat-A';
      await files.addFiles([new File(['synthetic A bytes'], 'startup-A.txt', { type: 'text/plain' })], { skipCrop: true });
      document.getElementById('message').value = 'Original startup prompt';
      window.fetchPosts = [];
      window.uploads = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.includes('/api/history/chat-A')) {
          window.adoptionStarted = true;
          return await new Promise(resolve => { window.resolveHistoryA = () => resolve(new Response(JSON.stringify({ history: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })); });
        }
        if (url.includes('/api/history/chat-B')) {
          return new Response(JSON.stringify({ history: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/upload')) {
          window.uploads.push({ session: init.body.get('session_id'), files: init.body.getAll('files').map(f => f.name) });
          return new Response(JSON.stringify({ files: [{ id: 'A-file-id', name: 'startup-A.txt' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/chat_stream')) {
          window.fetchPosts.push({ session: init.body.get('session'), message: init.body.get('message'), attachments: JSON.parse(init.body.get('attachments') || '[]') });
          return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (url.includes('/api/')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        return originalFetch(input, init);
      };
      window.adoptionStarted = false;
      window.sendSettled = false;
      window.sendPromise = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.sendSettled = true; });
    });
    await page.waitForFunction(() => window.adoptionStarted === true);
    await page.evaluate(async () => {
      const { sessions, files } = window.testModules;
      await sessions.selectSession('chat-B', { keepSidebar: true, showLoading: false });
      document.getElementById('message').value = 'Draft for B';
      await files.addFiles([new File(['synthetic B bytes'], 'draft-B.txt', { type: 'text/plain' })], { skipCrop: true });
      window.resolveHistoryA();
    });
    await page.waitForFunction(() => window.sendSettled === true);
    const result = await page.evaluate(() => ({
      selectedSession: window.testModules.sessions.getCurrentSessionId(),
      uploads: window.uploads,
      posts: window.fetchPosts,
      composer: document.getElementById('message').value,
      pending: window.testModules.files.getPendingInfo().map(f => f.name),
    }));
    assert.equal(result.selectedSession, 'chat-B');
    assert.equal(result.posts.length, 0, 'a send started for A must not be posted to B');
    assert.equal(result.uploads.length, 0, 'A attachment snapshot must not upload after navigation');
    assert.equal(result.composer, 'Draft for B');
    assert.deepEqual(result.pending, ['startup-A.txt', 'draft-B.txt']);
    assert.deepEqual(errors, []);

    // A cold New Chat default lookup can also finish after navigation and
    // create/materialize its stale destination over the selected chat.
    const initPage = await browser.newPage();
    initPage.setDefaultTimeout(7000);
    const initErrors = [];
    initPage.on('pageerror', error => initErrors.push(error.stack || error.message));
    await initPage.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await initPage.waitForFunction(() => window.testModules);
    await initPage.evaluate(async () => {
      const { sessions, files } = window.testModules;
      sessions.setCurrentSessionId(null);
      document.querySelector('.list-item').classList.remove('active-session');
      window.__odysseusLastSelectedSessionId = '';
      window.__odysseusDefaultChat = null;
      localStorage.removeItem('odysseus-default-chat-cache');
      await files.addFiles([new File(['synthetic cold A bytes'], 'cold-A.txt', { type: 'text/plain' })], { skipCrop: true });
      document.getElementById('message').value = 'Original cold-start prompt';
      window.coldUploads = [];
      window.coldPosts = [];
      window.coldCreates = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith('/api/default-chat')) {
          window.defaultLookupStarted = true;
          return await new Promise(resolve => { window.resolveDefaultLookup = () => resolve(new Response(JSON.stringify({ endpoint_url: 'http://fixture-model', model: 'fixture-model' }), { status: 200, headers: { 'Content-Type': 'application/json' } })); });
        }
        if (url.includes('/api/history/chat-B')) return new Response(JSON.stringify({ history: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/api/history/')) return new Response(JSON.stringify({ history: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.endsWith('/api/session') && init.method === 'POST') { window.coldCreates.push(url); return new Response(JSON.stringify({ id: 'created-default-C' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
        if (url.includes('/api/upload')) {
          window.coldUploads.push({ session: init.body.get('session_id'), files: init.body.getAll('files').map(f => f.name) });
          return new Response(JSON.stringify({ files: [{ id: 'cold-A-file-id', name: 'cold-A.txt' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/chat_stream')) {
          window.coldPosts.push({ session: init.body.get('session'), message: init.body.get('message'), attachments: JSON.parse(init.body.get('attachments') || '[]') });
          return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (url.includes('/api/')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        return originalFetch(input, init);
      };
      window.coldSettled = false;
      window.coldSend = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.coldSettled = true; });
    });
    await initPage.waitForFunction(() => window.defaultLookupStarted === true);
    await initPage.evaluate(async () => {
      await window.testModules.sessions.selectSession('chat-B', { keepSidebar: true, showLoading: false });
      document.getElementById('message').value = 'Draft for selected B';
      await window.testModules.files.addFiles([new File(['synthetic selected B bytes'], 'selected-B.txt', { type: 'text/plain' })], { skipCrop: true });
      window.resolveDefaultLookup();
    });
    await initPage.waitForFunction(() => window.coldSettled === true);
    const coldResult = await initPage.evaluate(() => ({
      finalSession: window.testModules.sessions.getCurrentSessionId(),
      uploads: window.coldUploads,
      posts: window.coldPosts,
      composer: document.getElementById('message').value,
      pending: window.testModules.files.getPendingInfo().map(f => f.name),
    }));
    assert.equal(coldResult.finalSession, 'chat-B');
    assert.equal(coldResult.posts.length, 0, 'cold init must not post after navigation');
    assert.deepEqual(coldResult.uploads, []);
    assert.deepEqual(coldResult.pending, ['cold-A.txt', 'selected-B.txt']);
    assert.equal(coldResult.composer, 'Draft for selected B');
    assert.deepEqual(coldResult.posts, []);
    assert.deepEqual(await initPage.evaluate(() => window.coldCreates), []);
    assert.deepEqual(initErrors, []);
    const newDraftPage = await browser.newPage();
    newDraftPage.setDefaultTimeout(7000);
    const newDraftErrors = [];
    newDraftPage.on('pageerror', error => newDraftErrors.push(error.stack || error.message));
    await newDraftPage.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await newDraftPage.waitForFunction(() => window.testModules);
    await newDraftPage.evaluate(async () => {
      const { sessions, files } = window.testModules;
      sessions.setCurrentSessionId(null);
      document.querySelector('.list-item').classList.remove('active-session');
      window.__odysseusLastSelectedSessionId = '';
      window.__odysseusDefaultChat = null;
      localStorage.removeItem('odysseus-default-chat-cache');
      sessions.startFreshChat();
      document.getElementById('message').value = 'Original draft before route change';
      await files.addFiles([new File(['old bytes'], 'old.txt', { type: 'text/plain' })], { skipCrop: true });
      window.originalDraftId = sessions.getPendingDraftId();
      window.routePosts = [];
      window.routeUploads = [];
      window.routeCreates = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith('/api/default-chat')) {
          window.routeLookupStarted = true;
          return await new Promise(resolve => { window.resolveRouteLookup = () => resolve(new Response(JSON.stringify({ endpoint_url: 'http://fixture-model', model: 'fixture-model' }), { status: 200, headers: { 'Content-Type': 'application/json' } })); });
        }
        if (url.includes('/api/history/')) return new Response(JSON.stringify({ history: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.endsWith('/api/session') && init.method === 'POST') { window.routeCreates.push(url); return new Response(JSON.stringify({ id: 'should-not-create' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
        if (url.includes('/api/upload')) { window.routeUploads.push(init.body.getAll('files').map(f => f.name)); return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
        if (url.includes('/api/chat_stream')) { window.routePosts.push(init.body.get('message')); return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); }
        if (url.includes('/api/')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        return originalFetch(input, init);
      };
      window.routeSettled = false;
      window.routeSend = window.testModules.chat.handleChatSubmit({ preventDefault() {} }).finally(() => { window.routeSettled = true; });
    });
    await newDraftPage.waitForFunction(() => window.routeLookupStarted === true);
    await newDraftPage.evaluate(async () => {
      const { sessions, files } = window.testModules;
      window.replacementDraftId = sessions.startFreshChat();
      document.getElementById('message').value = 'Text in replacement draft';
      await files.addFiles([new File(['new bytes'], 'new.txt', { type: 'text/plain' })], { skipCrop: true });
      window.resolveRouteLookup();
    });
    await newDraftPage.waitForFunction(() => window.routeSettled === true);
    const newDraftResult = await newDraftPage.evaluate(() => ({
      draftId: window.testModules.sessions.getPendingDraftId(),
      replacementDraftId: window.replacementDraftId,
      originalDraftId: window.originalDraftId,
      current: window.testModules.sessions.getCurrentSessionId(),
      composer: document.getElementById('message').value,
      pending: window.testModules.files.getPendingInfo().map(f => f.name),
      creates: window.routeCreates,
      uploads: window.routeUploads,
      posts: window.routePosts,
    }));
    assert.equal(newDraftResult.draftId, newDraftResult.replacementDraftId);
    assert.notEqual(newDraftResult.draftId, newDraftResult.originalDraftId);
    assert.equal(newDraftResult.current, null);
    assert.equal(newDraftResult.composer, 'Text in replacement draft');
    assert.deepEqual(newDraftResult.pending, ['old.txt', 'new.txt']);
    assert.deepEqual(newDraftResult.creates, []);
    assert.deepEqual(newDraftResult.uploads, []);
    assert.deepEqual(newDraftResult.posts, []);
    await newDraftPage.close();

    // New-chat hashes are considered by the existing startup adoption helper;
    // capture whether an actual send issues a history request for the draft ID.
    const routeProbePage = await browser.newPage();
    routeProbePage.setDefaultTimeout(7000);
    const routeProbeErrors = [];
    routeProbePage.on('pageerror', error => routeProbeErrors.push(error.stack || error.message));
    await routeProbePage.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await routeProbePage.waitForFunction(() => window.testModules);
    await routeProbePage.evaluate(async () => {
      const { sessions } = window.testModules;
      sessions.startFreshChat();
      document.getElementById('message').value = 'New route prompt';
      window.__odysseusDefaultChat = null;
      localStorage.removeItem('odysseus-default-chat-cache');
      window.newRouteId = sessions.getPendingDraftId();
      window.activeRowAtSend = document.querySelector('.list-item.active-session, .session-item.active')?.dataset?.sessionId || '';
      window.newRouteRequests = [];
      window.newRoutePosts = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = String(input);
        window.newRouteRequests.push(url);
        if (url.endsWith('/api/default-chat')) return new Response(JSON.stringify({ endpoint_url: 'http://fixture-model', model: 'fixture-model' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.endsWith('/api/session') && init.method === 'POST') return new Response(JSON.stringify({ id: 'new-route-created' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/api/chat_stream')) { window.newRoutePosts.push({ session: init.body.get('session'), message: init.body.get('message') }); return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); }
        if (url.includes('/api/history/')) return new Response(JSON.stringify({ history: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/api/')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        return originalFetch(input, init);
      };
      await window.testModules.chat.handleChatSubmit({ preventDefault() {} });
    });
    const newRouteRequests = await routeProbePage.evaluate(() => window.newRouteRequests);
    const newRouteId = await routeProbePage.evaluate(() => window.newRouteId);
    const activeRowAtSend = await routeProbePage.evaluate(() => window.activeRowAtSend);
    const newRoutePosts = await routeProbePage.evaluate(() => window.newRoutePosts);
    assert.equal(activeRowAtSend, 'chat-A');
    assert.equal(await routeProbePage.evaluate(() => window.testModules.sessions.getCurrentSessionId()), 'new-route-created');
    assert.deepEqual(newRouteRequests.filter(url => url.includes('/api/history/')), []);
    assert.deepEqual(newRoutePosts, [{ session: 'new-route-created', message: 'New route prompt' }]);
    await routeProbePage.close();
    await initPage.close();

    const successPage = await browser.newPage();
    successPage.setDefaultTimeout(7000);
    const successErrors = [];
    successPage.on('pageerror', error => successErrors.push(error.stack || error.message));
    await successPage.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await successPage.waitForFunction(() => window.testModules);
    await successPage.evaluate(async () => {
      const { sessions } = window.testModules;
      sessions.setCurrentSessionId(null);
      document.querySelector('.list-item').classList.add('active-session');
      document.querySelector('.list-item').dataset.sessionId = 'chat-A';
      window.__odysseusDefaultChat = null;
      localStorage.removeItem('odysseus-default-chat-cache');
      document.getElementById('message').value = 'Normal same-route prompt';
      window.successPosts = [];
      window.successCreates = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.includes('/api/history/chat-A')) return new Response(JSON.stringify({ history: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/api/chat_stream')) { window.successPosts.push({ session: init.body.get('session'), message: init.body.get('message') }); return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); }
        if (url.includes('/api/')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        return originalFetch(input, init);
      };
      await window.testModules.chat.handleChatSubmit({ preventDefault() {} });
    });
    const sameRouteSuccess = await successPage.evaluate(() => ({ current: window.testModules.sessions.getCurrentSessionId(), posts: window.successPosts }));
    assert.equal(sameRouteSuccess.current, 'chat-A');
    assert.deepEqual(sameRouteSuccess.posts, [{ session: 'chat-A', message: 'Normal same-route prompt' }]);
    assert.deepEqual(successErrors, []);
    await successPage.close();

    const coldSuccessPage = await browser.newPage();
    coldSuccessPage.setDefaultTimeout(7000);
    const coldSuccessErrors = [];
    coldSuccessPage.on('pageerror', error => coldSuccessErrors.push(error.stack || error.message));
    await coldSuccessPage.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await coldSuccessPage.waitForFunction(() => window.testModules);
    await coldSuccessPage.evaluate(async () => {
      const { sessions } = window.testModules;
      sessions.setCurrentSessionId(null);
      document.querySelectorAll('.list-item.active-session, .session-item.active').forEach(node => node.classList.remove('active-session', 'active'));
      window.__odysseusLastSelectedSessionId = '';
      window.__odysseusDefaultChat = null;
      localStorage.removeItem('odysseus-default-chat-cache');
      document.getElementById('message').value = 'Normal cold-start prompt';
      window.coldSuccessPosts = [];
      window.coldSuccessCreates = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith('/api/default-chat')) return new Response(JSON.stringify({ endpoint_url: 'http://fixture-model', model: 'fixture-model' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.endsWith('/api/session') && init.method === 'POST') { window.coldSuccessCreates.push(true); return new Response(JSON.stringify({ id: 'created-default-success' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
        if (url.includes('/api/history/created-default-success')) return new Response(JSON.stringify({ history: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/api/chat_stream')) { window.coldSuccessPosts.push({ session: init.body.get('session'), message: init.body.get('message') }); return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); }
        if (url.includes('/api/')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        return originalFetch(input, init);
      };
      await window.testModules.chat.handleChatSubmit({ preventDefault() {} });
    });
    const coldSameRouteSuccess = await coldSuccessPage.evaluate(() => ({ current: window.testModules.sessions.getCurrentSessionId(), creates: window.coldSuccessCreates, posts: window.coldSuccessPosts }));
    assert.equal(coldSameRouteSuccess.current, 'created-default-success');
    assert.deepEqual(coldSameRouteSuccess.creates, [true]);
    assert.deepEqual(coldSameRouteSuccess.posts, [{ session: 'created-default-success', message: 'Normal cold-start prompt' }]);
    assert.deepEqual(coldSuccessErrors, []);
    await coldSuccessPage.close();
    const evidence = { pass: true, adoptionNavigation: result, coldDefaultNavigation: coldResult, changedPendingDraft: newDraftResult, sameRouteSuccess, coldSameRouteSuccess, newChatRouteProbe: { draftId: newRouteId, activeRowAtSend, requests: newRouteRequests, posts: newRoutePosts, pageErrors: routeProbeErrors }, pageErrors: [...errors, ...initErrors, ...newDraftErrors, ...successErrors, ...coldSuccessErrors] };
    if (process.env.EVIDENCE_DIR) {
      fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'fresh-init-results.json'), JSON.stringify(evidence, null, 2));
    }
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
