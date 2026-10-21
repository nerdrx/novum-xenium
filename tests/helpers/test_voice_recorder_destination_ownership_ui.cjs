const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const origin = 'http://127.0.0.1';
const htmlPath = path.join(repo, 'static/index.html');
const apiRequests = [], externalRequests = [], pageErrors = [], clipboardWrites = [], downloads = [];
let provider = 'browser';
let authMode = 'user';
let sttRelease = null;
let sttRequestResolve = null;
let sttRequestReady = new Promise(resolve => { sttRequestResolve = resolve; });
let sessionCounter = 0;
const createdSessions = [];
const mediaScript = `(() => {
  const requests = [], recorders = [], tracks = [], recognitions = [];
  let grant;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia() { return new Promise(resolve => { grant = resolve; requests.push(true); }); }
  }});
  class Recorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { if (this.state !== 'recording') return; this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['synthetic audio']) }); queueMicrotask(() => this.onstop?.()); }
  }
  class Recognition {
    constructor() { this.stopped = false; this.aborted = false; recognitions.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; this.onend?.(); }
    emit(text) { const item = { isFinal: true, 0: { transcript: text } }; this.onresult?.({ resultIndex: 0, results: [item] }); }
    finish() { this.ended = true; this.onend?.(); }
  }
  Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: Recorder });
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText(text) { window.__voiceFixture.clipboard.push(text); return Promise.resolve(); } } });
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function() {
    if (this.download && String(this.href).startsWith('blob:')) { window.__voiceFixture.downloads.push(this.download); return; }
    return originalAnchorClick.call(this);
  };
  window.__voiceFixture = {
    requests, recorders, tracks, recognitions, clipboard: [], downloads: [],
    grant(i) { const track = { stopped: false, stop() { this.stopped = true; } }; tracks.push(track); grant({ getTracks: () => [track] }); },
  };
})();`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(htmlPath).pipe(res);
  }
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/stt/transcribe') {
      req.resume();
      req.on('end', () => {
        apiRequests.push({ method: req.method, path: url.pathname });
        sttRequestResolve?.();
        sttRequestReady = new Promise(resolve => { sttRequestResolve = resolve; });
        sttRelease = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: 'late server transcript A' })); sttRelease = null; };
      });
      return;
    }
    req.resume();
    req.on('end', () => {
      apiRequests.push({ method: req.method, path: url.pathname });
      if (url.pathname === '/api/auth/status' && authMode === 'unknown') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'synthetic unavailable' }));
        return;
      }
      let data = url.pathname === '/api/stt/stats' ? { provider }
        : url.pathname === '/api/auth/status' ? (authMode === 'anonymous'
          ? { authenticated: false, configured: false, username: null, is_admin: false, privileges: {} }
          : { authenticated: true, configured: true, username: 'fixture-user', is_admin: false, privileges: {} })
        : url.pathname === '/api/session' && req.method === 'POST' ? { id: `fixture-session-${++sessionCounter}`, name: 'Fixture chat' }
        : url.pathname === '/api/auth/features' ? { features: {} }
        : ['/api/sessions', '/api/presets/templates'].includes(url.pathname) ? []
        : url.pathname === '/api/models' ? { items: [] }
        : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.pathname === '/api/session' && req.method === 'POST') createdSessions.push(data.id);
      res.end(JSON.stringify(data));
    });
    return;
  }
  const filename = path.resolve(repo, `.${url.pathname}`);
  if (!filename.startsWith(repo + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    res.writeHead(404).end(); return;
  }
  const ext = path.extname(filename);
  const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css'
    : (ext === '.js' || ext === '.mjs') ? 'text/javascript' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(filename).pipe(res);
});

(async () => {
  let browser, context;
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const testOrigin = `${origin}:${server.address().port}`;
  try {
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    context = await browser.newContext();
    await context.addInitScript(mediaScript);
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', route => {
      const target = new URL(route.request().url());
      if (target.origin !== testOrigin) { externalRequests.push(target.href); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${testOrigin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__odysseusAppStarted === true &&
      document.querySelector('.send-btn')?.dataset.mode === 'mic', null, { timeout: 20000 });
    assert.equal(await page.evaluate(() => typeof window.sessionModule.captureVoiceDestination), 'function');
    const openApp = async (mode = 'user') => {
      authMode = mode;
      const isolatedContext = await browser.newContext();
      await isolatedContext.addInitScript(mediaScript);
      const isolatedPage = await isolatedContext.newPage();
      isolatedPage.on('pageerror', error => pageErrors.push(error.message));
      await isolatedPage.route('**/*', route => {
        const target = new URL(route.request().url());
        if (target.origin !== testOrigin) { externalRequests.push(target.href); return route.abort(); }
        return route.continue();
      });
      await isolatedPage.goto(`${testOrigin}/`, { waitUntil: 'domcontentloaded' });
      await isolatedPage.waitForFunction(() => window.__odysseusAppStarted === true && document.querySelector('.send-btn')?.dataset.mode === 'mic', null, { timeout: 20000 });
      if (mode === 'unknown') await isolatedPage.evaluate(async () => (await import('/static/js/authState.js')).authStatePromise);
      else await isolatedPage.waitForFunction(() => window.sessionModule.captureVoiceIdentity()?.authVerified === true);
      authMode = 'user';
      return { isolatedContext, isolatedPage };
    };

    await page.locator('#sidebar-new-chat-btn').click();
    await page.waitForFunction(() => !!window.sessionModule.getPendingDraftId());
    const draftA = await page.evaluate(() => window.sessionModule.getPendingDraftId());
    await page.locator('.send-btn').click();
    await page.waitForFunction(() => window.__voiceFixture.requests.length === 1);
    await page.evaluate(() => window.__voiceFixture.grant(0));
    await page.waitForFunction(() => window.__voiceFixture.recorders[0]?.state === 'recording');
    await page.locator('.send-btn').click();
    await page.waitForFunction(() => window.__voiceFixture.recognitions[0]?.stopped === true);
    await page.locator('#message').fill('A draft stays with A');

    await page.locator('#sidebar-new-chat-btn').click();
    await page.waitForFunction(id => window.sessionModule.getPendingDraftId() !== id, draftA);
    const draftB = await page.evaluate(() => window.sessionModule.getPendingDraftId());
    assert.notEqual(draftB, draftA);
    await page.waitForFunction(() => document.querySelector('#message')?.value === '');
    await page.locator('#message').fill('B destination draft');
    const beforeRelease = { draftA, draftB, currentPendingDraftId: await page.evaluate(() => window.sessionModule.getPendingDraftId()), input: await page.locator('#message').inputValue() };
    assert.equal(beforeRelease.currentPendingDraftId, draftB);

    await page.evaluate(() => {
      window.__voiceFixture.recognitions[0].emit('late transcript A');
      window.__voiceFixture.recognitions[0].finish();
    });
    await page.waitForFunction(() => document.querySelector('.toast-message')?.textContent.includes('Voice transcript'), null, { timeout: 10000 });
    const firstToast = await page.locator('.toast-message').textContent();
    assert.equal(firstToast, 'Voice transcript saved to its original chat.');
    const afterA = { currentPendingDraftId: await page.evaluate(() => window.sessionModule.getPendingDraftId()), input: await page.locator('#message').inputValue() };

    await page.goBack();
    await page.waitForFunction(id => window.sessionModule.getPendingDraftId() === id, draftA, { timeout: 10000 });
    const backA = { currentPendingDraftId: await page.evaluate(() => window.sessionModule.getPendingDraftId()), input: await page.locator('#message').inputValue() };
    assert.equal(beforeRelease.currentPendingDraftId, draftB);
    assert.equal(afterA.currentPendingDraftId, draftB);
    assert.equal(afterA.input, 'B destination draft');
    assert.equal(backA.currentPendingDraftId, draftA);
    assert.equal(backA.input, 'A draft stays with A late transcript A');

    // The actual server-STT path owns the draft captured when Stop was clicked.
    provider = 'local';
    await page.evaluate(async () => { await (await import('/static/js/voiceRecorder.js')).default.refreshSttProvider(); });
    await page.waitForFunction(async () => (await import('/static/js/voiceRecorder.js')).default._sttProvider === 'local');
    const priorPending = await page.evaluate(() => window.sessionModule.getPendingDraftId());
    await page.locator('#sidebar-new-chat-btn').click();
    await page.waitForFunction(id => window.sessionModule.getPendingDraftId() !== id, priorPending);
    await page.waitForFunction(() => document.querySelector('#message')?.value === '');
    const serverDraftA = await page.evaluate(() => window.sessionModule.getPendingDraftId());
    await page.locator('.send-btn').click();
    await page.waitForFunction(() => window.__voiceFixture.requests.length === 2);
    await page.evaluate(() => window.__voiceFixture.grant(1));
    await page.waitForFunction(() => window.__voiceFixture.recorders[1]?.state === 'recording');
    const serverRequestSeen = sttRequestReady;
    await page.locator('.send-btn').click();
    await serverRequestSeen;
    await page.locator('#message').fill('server A latest draft');
    const beforeServerReturn = await page.evaluate(async id => {
      const drafts = await import('/static/js/composerDrafts.js');
      return drafts.getComposerDraft(id, { accountId: 'fixture-user' });
    }, serverDraftA);
    assert.equal(beforeServerReturn, 'server A latest draft');
    await page.locator('#sidebar-new-chat-btn').click();
    await page.waitForFunction(id => window.sessionModule.getPendingDraftId() !== id, serverDraftA);
    const serverDraftB = await page.evaluate(() => window.sessionModule.getPendingDraftId());
    await page.waitForFunction(() => document.querySelector('#message')?.value === '');
    await page.locator('#message').fill('server B draft');
    sttRelease?.();
    await page.waitForFunction(() => document.querySelector('.toast-message')?.textContent.includes('Voice transcript'), null, { timeout: 10000 });
    assert.equal(await page.locator('#message').inputValue(), 'server B draft');
    const serverSavedDraft = await page.evaluate(async id => {
      const drafts = await import('/static/js/composerDrafts.js');
      return drafts.getComposerDraft(id, { accountId: 'fixture-user' });
    }, serverDraftA);
    assert.notEqual(serverDraftB, serverDraftA);
    assert.equal(serverSavedDraft, 'server A latest draft late server transcript A');

    // A pending destination keeps its identity when a first send materializes it.
    provider = 'local';
    await page.evaluate(async () => { await (await import('/static/js/voiceRecorder.js')).default.refreshSttProvider(); });
    const beforeMaterialize = await page.evaluate(() => window.sessionModule.getPendingDraftId());
    await page.evaluate(() => window.sessionModule.createDirectChat('http://fixture.invalid', 'fixture/model', '', { fresh: true }));
    await page.waitForFunction(id => window.sessionModule.getPendingDraftId() !== id, beforeMaterialize);
    const materializedDraft = await page.evaluate(() => window.sessionModule.getPendingDraftId());
    await page.locator('.send-btn').click();
    await page.waitForFunction(() => window.__voiceFixture.requests.length === 3);
    await page.evaluate(() => window.__voiceFixture.grant(2));
    await page.waitForFunction(() => window.__voiceFixture.recorders[2]?.state === 'recording');
    const materializeRequestSeen = sttRequestReady;
    await page.locator('.send-btn').click();
    await materializeRequestSeen;
    await page.locator('#message').fill('materialized A latest draft');
    const materialized = await page.evaluate(() => window.sessionModule.materializePendingSession());
    assert.equal(materialized, true);
    const materializedSessionId = await page.evaluate(() => window.sessionModule.getCurrentSessionId());
    assert.ok(materializedSessionId);
    await page.locator('#sidebar-new-chat-btn').click();
    await page.waitForFunction(() => !!window.sessionModule.getPendingDraftId());
    await page.waitForFunction(() => document.querySelector('#message')?.value === '');
    await page.locator('#message').fill('materialized B draft');
    sttRelease?.();
    await page.waitForFunction(() => document.querySelector('.toast-message')?.textContent.includes('Voice transcript'), null, { timeout: 10000 });
    assert.equal(await page.locator('#message').inputValue(), 'materialized B draft');
    const materializedSavedDraft = await page.evaluate(async id => {
      const drafts = await import('/static/js/composerDrafts.js');
      return drafts.getComposerDraft(id, { accountId: 'fixture-user' });
    }, materializedSessionId);
    assert.equal(materializedSavedDraft, 'materialized A latest draft late server transcript A');

    // A page-private anonymous pending draft remains recoverable in this tab.
    provider = 'browser';
    const anonymousContext = await browser.newContext();
    await anonymousContext.addInitScript(mediaScript);
    const anonymousPage = await anonymousContext.newPage();
    anonymousPage.on('pageerror', error => pageErrors.push(error.message));
    await anonymousPage.route('**/*', route => {
      const target = new URL(route.request().url());
      if (target.origin !== testOrigin) { externalRequests.push(target.href); return route.abort(); }
      return route.continue();
    });
    authMode = 'anonymous';
    await anonymousPage.goto(`${testOrigin}/`, { waitUntil: 'domcontentloaded' });
    await anonymousPage.waitForFunction(() => window.__odysseusAppStarted === true && document.querySelector('.send-btn')?.dataset.mode === 'mic', null, { timeout: 20000 });
    await anonymousPage.waitForFunction(() => window.sessionModule.captureVoiceIdentity()?.authVerified === true);
    assert.equal(await anonymousPage.evaluate(() => window.sessionModule.captureVoiceIdentity().identity), '');
    authMode = 'user';
    await anonymousPage.locator('#sidebar-new-chat-btn').click();
    await anonymousPage.waitForFunction(() => !!window.sessionModule.getPendingDraftId());
    const anonymousA = await anonymousPage.evaluate(() => window.sessionModule.getPendingDraftId());
    await anonymousPage.locator('.send-btn').click();
    await anonymousPage.waitForFunction(() => window.__voiceFixture.requests.length === 1);
    await anonymousPage.evaluate(() => window.__voiceFixture.grant(0));
    await anonymousPage.waitForFunction(() => window.__voiceFixture.recorders[0]?.state === 'recording');
    await anonymousPage.locator('.send-btn').click();
    await anonymousPage.waitForFunction(() => window.__voiceFixture.recognitions[0]?.stopped === true);
    await anonymousPage.locator('#message').fill('anonymous draft A');
    await anonymousPage.locator('#sidebar-new-chat-btn').click();
    await anonymousPage.waitForFunction(id => window.sessionModule.getPendingDraftId() !== id, anonymousA);
    await anonymousPage.waitForFunction(() => document.querySelector('#message')?.value === '');
    await anonymousPage.locator('#message').fill('anonymous draft B');
    await anonymousPage.evaluate(() => { window.__voiceFixture.recognitions[0].emit('anonymous late transcript'); window.__voiceFixture.recognitions[0].finish(); });
    await anonymousPage.goBack();
    await anonymousPage.waitForFunction(id => window.sessionModule.getPendingDraftId() === id, anonymousA, { timeout: 10000 });
    assert.equal(await anonymousPage.locator('#message').inputValue(), 'anonymous draft A anonymous late transcript');
    await anonymousContext.close();

    const unknownAuth = await openApp('unknown');
    await unknownAuth.isolatedPage.locator('#sidebar-new-chat-btn').click();
    await unknownAuth.isolatedPage.waitForFunction(() => !!window.sessionModule.getPendingDraftId());
    const unknownA = await unknownAuth.isolatedPage.evaluate(() => window.sessionModule.getPendingDraftId());
    await unknownAuth.isolatedPage.locator('.send-btn').click();
    await unknownAuth.isolatedPage.waitForFunction(() => window.__voiceFixture.requests.length === 1);
    await unknownAuth.isolatedPage.evaluate(() => window.__voiceFixture.grant(0));
    await unknownAuth.isolatedPage.waitForFunction(() => window.__voiceFixture.recorders[0]?.state === 'recording');
    await unknownAuth.isolatedPage.locator('.send-btn').click();
    await unknownAuth.isolatedPage.waitForFunction(() => window.__voiceFixture.recognitions[0]?.stopped === true);
    await unknownAuth.isolatedPage.locator('#message').fill('page-owned A draft');
    await unknownAuth.isolatedPage.locator('#sidebar-new-chat-btn').click();
    await unknownAuth.isolatedPage.waitForFunction(id => window.sessionModule.getPendingDraftId() !== id, unknownA);
    await unknownAuth.isolatedPage.waitForFunction(() => document.querySelector('#message')?.value === '');
    await unknownAuth.isolatedPage.locator('#message').fill('page-owned B draft');
    authMode = 'user';
    const resolvedAuth = await unknownAuth.isolatedPage.evaluate(async () => (await import('/static/js/authState.js')).getAuthState());
    assert.equal(resolvedAuth.verified, true);
    assert.equal(resolvedAuth.switched, false);
    await unknownAuth.isolatedPage.evaluate(() => { window.__voiceFixture.recognitions[0].emit('page-owned late transcript'); window.__voiceFixture.recognitions[0].finish(); });
    await unknownAuth.isolatedPage.waitForFunction(() => document.querySelector('.toast-message')?.textContent.includes('Voice transcript kept for this page.'), null, { timeout: 10000 });
    assert.equal(await unknownAuth.isolatedPage.locator('#message').inputValue(), 'page-owned B draft');
    await unknownAuth.isolatedPage.goBack();
    await unknownAuth.isolatedPage.waitForFunction(id => window.sessionModule.getPendingDraftId() === id, unknownA, { timeout: 10000 });
    const unknownRecovered = await unknownAuth.isolatedPage.locator('#message').inputValue();
    assert.equal(unknownRecovered, 'page-owned A draft page-owned late transcript');
    await unknownAuth.isolatedContext.close();

    provider = 'browser';
    const normal = await openApp('user');
    await normal.isolatedPage.locator('#sidebar-new-chat-btn').click();
    await normal.isolatedPage.waitForFunction(() => !!window.sessionModule.getPendingDraftId());
    await normal.isolatedPage.locator('.send-btn').click();
    await normal.isolatedPage.waitForFunction(() => window.__voiceFixture.requests.length === 1);
    await normal.isolatedPage.evaluate(() => window.__voiceFixture.grant(0));
    await normal.isolatedPage.waitForFunction(() => window.__voiceFixture.recorders[0]?.state === 'recording');
    await normal.isolatedPage.locator('.send-btn').click();
    await normal.isolatedPage.waitForFunction(() => window.__voiceFixture.recognitions[0]?.stopped === true);
    await normal.isolatedPage.locator('#message').fill('normal control draft');
    await normal.isolatedPage.evaluate(() => { window.__voiceFixture.recognitions[0].emit('normal control transcript'); window.__voiceFixture.recognitions[0].finish(); });
    await normal.isolatedPage.waitForFunction(() => document.querySelector('#message')?.value === 'normal control draft normal control transcript', null, { timeout: 10000 });
    const normalInput = await normal.isolatedPage.locator('#message').inputValue();
    assert.equal(normalInput, 'normal control draft normal control transcript');
    await normal.isolatedContext.close();

    const switched = await openApp('user');
    await switched.isolatedPage.locator('#sidebar-new-chat-btn').click();
    await switched.isolatedPage.waitForFunction(() => !!window.sessionModule.getPendingDraftId());
    const switchedA = await switched.isolatedPage.evaluate(() => window.sessionModule.getPendingDraftId());
    await switched.isolatedPage.locator('.send-btn').click();
    await switched.isolatedPage.waitForFunction(() => window.__voiceFixture.requests.length === 1);
    await switched.isolatedPage.evaluate(() => window.__voiceFixture.grant(0));
    await switched.isolatedPage.waitForFunction(() => window.__voiceFixture.recorders[0]?.state === 'recording');
    await switched.isolatedPage.locator('.send-btn').click();
    await switched.isolatedPage.waitForFunction(() => window.__voiceFixture.recognitions[0]?.stopped === true);
    await switched.isolatedPage.locator('#message').fill('switch A draft');
    await switched.isolatedPage.locator('#sidebar-new-chat-btn').click();
    await switched.isolatedPage.waitForFunction(id => window.sessionModule.getPendingDraftId() !== id, switchedA);
    await switched.isolatedPage.waitForFunction(() => document.querySelector('#message')?.value === '');
    await switched.isolatedPage.locator('#message').fill('switch B draft');
    await switched.isolatedPage.evaluate(() => localStorage.setItem('odysseus-auth-user', 'different-fixture-user'));
    await switched.isolatedPage.evaluate(() => { window.__voiceFixture.recognitions[0].emit('private transcript'); window.__voiceFixture.recognitions[0].finish(); });
    await switched.isolatedPage.waitForFunction(() => document.querySelector('.toast-message')?.textContent.includes('account context changed'), null, { timeout: 10000 });
    assert.equal(await switched.isolatedPage.locator('#message').inputValue(), 'switch B draft');
    assert.deepEqual(await switched.isolatedPage.evaluate(() => window.__voiceFixture.clipboard), []);
    await switched.isolatedContext.close();

    const deleted = await openApp('user');
    await deleted.isolatedPage.locator('#sidebar-new-chat-btn').click();
    await deleted.isolatedPage.waitForFunction(() => !!window.sessionModule.getPendingDraftId());
    const deletedA = await deleted.isolatedPage.evaluate(() => window.sessionModule.getPendingDraftId());
    await deleted.isolatedPage.locator('.send-btn').click();
    await deleted.isolatedPage.waitForFunction(() => window.__voiceFixture.requests.length === 1);
    await deleted.isolatedPage.evaluate(() => window.__voiceFixture.grant(0));
    await deleted.isolatedPage.waitForFunction(() => window.__voiceFixture.recorders[0]?.state === 'recording');
    await deleted.isolatedPage.locator('.send-btn').click();
    await deleted.isolatedPage.waitForFunction(() => window.__voiceFixture.recognitions[0]?.stopped === true);
    await deleted.isolatedPage.locator('#message').fill('deleted A draft');
    await deleted.isolatedPage.locator('#sidebar-new-chat-btn').click();
    await deleted.isolatedPage.waitForFunction(id => window.sessionModule.getPendingDraftId() !== id, deletedA);
    await deleted.isolatedPage.waitForFunction(() => document.querySelector('#message')?.value === '');
    await deleted.isolatedPage.locator('#message').fill('deleted B draft');
    await deleted.isolatedPage.evaluate(id => window.sessionModule.deleteSessionById(id), deletedA);
    await deleted.isolatedPage.evaluate(() => { window.__voiceFixture.recognitions[0].emit('recoverable transcript'); window.__voiceFixture.recognitions[0].finish(); });
    await deleted.isolatedPage.waitForFunction(() => document.querySelector('#styled-confirm-overlay')?.classList.contains('hidden') === false, null, { timeout: 10000 });
    const copyPrompt = await deleted.isolatedPage.locator('#styled-confirm-msg').textContent();
    assert.match(copyPrompt, /original chat is unavailable/i);
    assert.equal(copyPrompt.includes('recoverable transcript'), false);
    await deleted.isolatedPage.locator('#styled-confirm-ok').click();
    await deleted.isolatedPage.waitForFunction(() => window.__voiceFixture.clipboard.includes('recoverable transcript'), null, { timeout: 10000 });
    assert.equal(await deleted.isolatedPage.locator('#message').inputValue(), 'deleted B draft');
    await deleted.isolatedContext.close();

    const fallback = await openApp('user');
    await fallback.isolatedPage.locator('#sidebar-new-chat-btn').click();
    await fallback.isolatedPage.waitForFunction(() => !!window.sessionModule.getPendingDraftId());
    const fallbackA = await fallback.isolatedPage.evaluate(() => window.sessionModule.getPendingDraftId());
    await fallback.isolatedPage.locator('.send-btn').click();
    await fallback.isolatedPage.waitForFunction(() => window.__voiceFixture.requests.length === 1);
    await fallback.isolatedPage.evaluate(() => window.__voiceFixture.grant(0));
    await fallback.isolatedPage.waitForFunction(() => window.__voiceFixture.recorders[0]?.state === 'recording');
    await fallback.isolatedPage.locator('.send-btn').click();
    await fallback.isolatedPage.waitForFunction(() => window.__voiceFixture.recognitions[0]?.stopped === true);
    await fallback.isolatedPage.locator('#message').fill('fallback A draft');
    await fallback.isolatedPage.locator('#sidebar-new-chat-btn').click();
    await fallback.isolatedPage.waitForFunction(id => window.sessionModule.getPendingDraftId() !== id, fallbackA);
    await fallback.isolatedPage.waitForFunction(() => document.querySelector('#message')?.value === '');
    await fallback.isolatedPage.locator('#message').fill('fallback B draft');
    await fallback.isolatedPage.evaluate(() => window.__voiceFixture.recognitions[0].finish());
    await fallback.isolatedPage.waitForFunction(() => document.querySelector('#styled-confirm-overlay')?.classList.contains('hidden') === false, null, { timeout: 10000 });
    assert.match(await fallback.isolatedPage.locator('#styled-confirm-msg').textContent(), /belongs to another chat/i);
    await fallback.isolatedPage.locator('#styled-confirm-ok').click();
    await fallback.isolatedPage.waitForFunction(() => window.__voiceFixture.downloads.length === 1, null, { timeout: 10000 });
    assert.match((await fallback.isolatedPage.evaluate(() => window.__voiceFixture.downloads[0])), /voice-message-.*\.webm/);
    assert.equal(await fallback.isolatedPage.locator('#message').inputValue(), 'fallback B draft');
    await fallback.isolatedContext.close();

    const nobody = await openApp('user');
    await nobody.isolatedPage.locator('#sidebar-new-chat-btn').click();
    await nobody.isolatedPage.waitForFunction(() => !!window.sessionModule.getPendingDraftId());
    const nobodyA = await nobody.isolatedPage.evaluate(() => window.sessionModule.getPendingDraftId());
    await nobody.isolatedPage.locator('.send-btn').click();
    await nobody.isolatedPage.waitForFunction(() => window.__voiceFixture.requests.length === 1);
    await nobody.isolatedPage.evaluate(() => window.__voiceFixture.grant(0));
    await nobody.isolatedPage.waitForFunction(() => window.__voiceFixture.recorders[0]?.state === 'recording');
    await nobody.isolatedPage.locator('.send-btn').click();
    await nobody.isolatedPage.waitForFunction(() => window.__voiceFixture.recognitions[0]?.stopped === true);
    await nobody.isolatedPage.locator('#message').fill('private A draft');
    const nobodyStorageKey = `ody-composer-drafts:${encodeURIComponent('fixture-user')}:${encodeURIComponent(nobodyA)}`;
    const persistedBeforeNobody = await nobody.isolatedPage.evaluate(key => localStorage.getItem(key), nobodyStorageKey);
    assert.ok(persistedBeforeNobody);
    await nobody.isolatedPage.locator('#incognito-btn').click();
    await nobody.isolatedPage.waitForFunction(() => document.querySelector('#incognito-toggle')?.checked === true);
    const nobodyOptions = await nobody.isolatedPage.evaluate(() => window.sessionModule.captureVoiceDestination(window.sessionModule.captureVoiceIdentity()).draftOptions);
    assert.equal(nobodyOptions.incognito, true);
    assert.equal(await nobody.isolatedPage.evaluate(key => localStorage.getItem(key), nobodyStorageKey), null);
    await nobody.isolatedPage.locator('#sidebar-new-chat-btn').click();
    await nobody.isolatedPage.waitForFunction(id => window.sessionModule.getPendingDraftId() !== id, nobodyA);
    const nobodyB = await nobody.isolatedPage.evaluate(() => window.sessionModule.getPendingDraftId());
    await nobody.isolatedPage.waitForFunction(() => document.querySelector('#message')?.value === '');
    await nobody.isolatedPage.evaluate(() => window.sessionModule.createDirectChat('http://fixture.invalid', 'fixture/model', ''));
    assert.equal(await nobody.isolatedPage.evaluate(() => window.sessionModule.materializePendingSession()), true);
    await nobody.isolatedPage.locator('#message').fill('private B draft');
    await nobody.isolatedPage.evaluate(() => { window.__voiceFixture.recognitions[0].emit('private late transcript'); window.__voiceFixture.recognitions[0].finish(); });
    await nobody.isolatedPage.waitForFunction(() => document.querySelector('.toast-message')?.textContent.includes('Voice transcript'), null, { timeout: 10000 });
    const nobodyStorageAfter = await nobody.isolatedPage.evaluate(key => localStorage.getItem(key), nobodyStorageKey);
    const nobodyPersistentTranscript = await nobody.isolatedPage.evaluate(text => Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)) || '').some(value => value.includes(text)), 'private late transcript');
    const nobodySavedDraft = await nobody.isolatedPage.evaluate(async ({ id, options }) => (await import('/static/js/composerDrafts.js')).getComposerDraft(id, options), { id: nobodyA, options: nobodyOptions });
    assert.equal(nobodyStorageAfter, null);
    assert.equal(nobodyPersistentTranscript, false);
    assert.equal(nobodySavedDraft, 'private A draft private late transcript');
    assert.equal(await nobody.isolatedPage.locator('#message').inputValue(), 'private B draft');
    await nobody.isolatedContext.close();

    provider = 'local';
    const unknownMaterialization = await openApp('unknown');
    await unknownMaterialization.isolatedPage.evaluate(() => window.sessionModule.createDirectChat('http://fixture.invalid', 'fixture/model', '', { fresh: true }));
    const unknownMaterializedDraft = await unknownMaterialization.isolatedPage.evaluate(() => window.sessionModule.getPendingDraftId());
    await unknownMaterialization.isolatedPage.locator('.send-btn').click();
    await unknownMaterialization.isolatedPage.waitForFunction(() => window.__voiceFixture.requests.length === 1);
    await unknownMaterialization.isolatedPage.evaluate(() => window.__voiceFixture.grant(0));
    await unknownMaterialization.isolatedPage.waitForFunction(() => window.__voiceFixture.recorders[0]?.state === 'recording');
    const unknownSttReady = sttRequestReady;
    await unknownMaterialization.isolatedPage.locator('.send-btn').click();
    await unknownSttReady;
    await unknownMaterialization.isolatedPage.locator('#message').fill('unknown A draft');
    authMode = 'user';
    const firstIdentity = await unknownMaterialization.isolatedPage.evaluate(async () => (await import('/static/js/authState.js')).getAuthState());
    assert.equal(firstIdentity.verified, true);
    assert.equal(firstIdentity.switched, false);
    const pageOwnedOptions = await unknownMaterialization.isolatedPage.evaluate(() => window.sessionModule.captureVoiceDestination(window.sessionModule.captureVoiceIdentity()).draftOptions);
    assert.equal(pageOwnedOptions.memoryOnly, true);
    const materializedUnknown = await unknownMaterialization.isolatedPage.evaluate(() => window.sessionModule.materializePendingSession());
    assert.equal(materializedUnknown, true);
    const unknownSessionId = await unknownMaterialization.isolatedPage.evaluate(() => window.sessionModule.getCurrentSessionId());
    const unknownSessionStorageKey = `ody-composer-drafts:${encodeURIComponent('fixture-user')}:${encodeURIComponent(unknownSessionId)}`;
    const unknownUserStorageBeforeLateResult = await unknownMaterialization.isolatedPage.evaluate(key => localStorage.getItem(key), unknownSessionStorageKey);
    const pageOwnedBeforeLateResult = await unknownMaterialization.isolatedPage.evaluate(async ({ id, options }) => (await import('/static/js/composerDrafts.js')).getComposerDraft(id, options), { id: unknownSessionId, options: pageOwnedOptions });
    assert.equal(pageOwnedBeforeLateResult, 'unknown A draft');
    await unknownMaterialization.isolatedPage.locator('#sidebar-new-chat-btn').click();
    await unknownMaterialization.isolatedPage.waitForFunction(() => !!window.sessionModule.getPendingDraftId());
    await unknownMaterialization.isolatedPage.waitForFunction(() => document.querySelector('#message')?.value === '');
    await unknownMaterialization.isolatedPage.evaluate(() => window.sessionModule.createDirectChat('http://fixture.invalid', 'fixture/model', ''));
    assert.equal(await unknownMaterialization.isolatedPage.evaluate(() => window.sessionModule.materializePendingSession()), true);
    await unknownMaterialization.isolatedPage.locator('#message').fill('unknown B draft');
    sttRelease?.();
    await unknownMaterialization.isolatedPage.waitForFunction(() => document.querySelector('.toast-message')?.textContent.includes('Voice transcript'), null, { timeout: 10000 });
    const pageOwnedAfterLateResult = await unknownMaterialization.isolatedPage.evaluate(async ({ id, options }) => (await import('/static/js/composerDrafts.js')).getComposerDraft(id, options), { id: unknownSessionId, options: pageOwnedOptions });
    assert.equal(pageOwnedAfterLateResult, 'unknown A draft late server transcript A');
    const unknownUserStorageAfterLateResult = await unknownMaterialization.isolatedPage.evaluate(key => localStorage.getItem(key), unknownSessionStorageKey);
    const unknownPersistentTranscript = await unknownMaterialization.isolatedPage.evaluate(text => Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)) || '').some(value => value.includes(text)), 'late server transcript A');
    assert.equal(await unknownMaterialization.isolatedPage.locator('#message').inputValue(), 'unknown B draft');
    await unknownMaterialization.isolatedPage.evaluate(id => window.sessionModule.selectSession(id, { showLoading: false }), unknownSessionId);
    await unknownMaterialization.isolatedPage.waitForFunction(id => window.sessionModule.getCurrentSessionId() === id, unknownSessionId);
    const unknownMaterializedReturned = await unknownMaterialization.isolatedPage.locator('#message').inputValue();
    const unknownUserStorageAfterReturn = await unknownMaterialization.isolatedPage.evaluate(key => localStorage.getItem(key), unknownSessionStorageKey);
    assert.equal(unknownUserStorageBeforeLateResult, null);
    assert.equal(unknownUserStorageAfterLateResult, null);
    assert.equal(unknownPersistentTranscript, false);
    assert.equal(unknownUserStorageAfterReturn, null);
    assert.equal(unknownMaterializedReturned, 'unknown A draft late server transcript A');
    await unknownMaterialization.isolatedContext.close();

    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);

    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex');
    console.log(JSON.stringify({
      pass: true,
      source: { gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), appJs: hash('static/app.js'), voiceRecorderJs: hash('static/js/voiceRecorder.js'), sessionsJs: hash('static/js/sessions.js') },
      result: { beforeRelease, afterLateResultAndEnd: afterA, afterBrowserBackToA: backA },
      ordering: ['actual New Chat A', 'synthetic getUserMedia grant and recording', 'actual Stop A calls SpeechRecognition.stop and waits for end', 'actual New Chat B', 'type B draft', 'deliver final A result then end', 'browser Back restores A'],
      apiRequestCount: apiRequests.length, apiPaths: [...new Set(apiRequests.map(r => r.path))].sort(),
      externalRequests, pageErrors,
      serverStt: { draftA: serverDraftA, draftB: serverDraftB, savedDraft: serverSavedDraft },
      materialization: { pendingDraftId: materializedDraft, sessionId: materializedSessionId, savedDraft: materializedSavedDraft, createdSessions },
      pagePrivate: 'Separate actual app context booted against the fixture verified-anonymous auth response.',
      unknownAuthAdoption: { draftId: unknownA, recovered: unknownRecovered, resolvedIdentity: resolvedAuth.identity },
      nobodyPrivacy: { draftId: nobodyA, nextDraftId: nobodyB, persistentDraft: nobodyStorageAfter, persistentTranscript: nobodyPersistentTranscript, memoryDraft: nobodySavedDraft },
      unknownMaterialization: { pendingDraftId: unknownMaterializedDraft, sessionId: unknownSessionId, pageOwnedOptions, pageOwnedBeforeLateResult, pageOwnedDraft: pageOwnedAfterLateResult, persistentBeforeLateResult: unknownUserStorageBeforeLateResult, persistentAfterLateResult: unknownUserStorageAfterLateResult, persistentAfterReturn: unknownUserStorageAfterReturn, persistentTranscript: unknownPersistentTranscript, returnedInput: unknownMaterializedReturned },
      normalCurrentDestination: normalInput,
      privacyCases: { accountSwitchKeptPrivate: true, deletedDestinationCopiedOnlyAfterConfirm: true, offscreenAudioDownloadedOnlyAfterConfirm: true },
      scope: 'Actual full app and voiceRecorder; fake media devices and SpeechRecognition; loopback-only API fixtures; clipboard/download sinks captured in-page; no physical microphone, external STT, upload, real accounts, or network.'
    }, null, 2));
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve)).catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
