const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const host = 'http://127.0.0.1';
const htmlPath = path.join(repo, 'static/index.html');
const requests = [], authResponses = [], externalRequests = [], pageErrors = [];
let authMode = 'anonymous';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, host);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(htmlPath).pipe(res);
  }
  if (url.pathname.startsWith('/api/')) {
    req.resume();
    req.on('end', () => {
      requests.push(url.pathname);
      let status = 200, data = {};
      if (url.pathname === '/api/auth/status') {
        if (authMode === 'unavailable') status = 503;
        else if (authMode === 'user') data = { configured: true, authenticated: true, username: 'fixture-user', is_admin: false, privileges: {} };
        else data = { configured: false, authenticated: false, username: null };
        authResponses.push({ mode: authMode, status });
      } else if (url.pathname === '/api/stt/stats') data = { provider: 'local' };
      else if (url.pathname === '/api/auth/features') data = { features: {} };
      else if (url.pathname === '/api/sessions' || url.pathname === '/api/presets/templates') data = [];
      else if (url.pathname === '/api/models') data = { items: [] };
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    });
    return;
  }
  const file = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end();
  }
  const ext = path.extname(file);
  const type = ext === '.css' ? 'text/css' : (ext === '.js' || ext === '.mjs') ? 'text/javascript' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  let browser;
  const contexts = [];
  const result = { pass: false, cases: {}, authResponses, externalRequests, pageErrors,
    source: { head: 'fb70158b6645d2b14035d738d3b5d3938eb410a3' },
    scope: 'Actual full app and production sessions/composerDrafts modules; loopback synthetic APIs only; no audio, microphone, STT, accounts, or user content.' };
  const appFile = name => path.join(repo, 'static/js', name);
  for (const [name, key] of [['sessions.js','sessionsJs'],['composerDrafts.js','composerDraftsJs']]) {
    result.source[key] = crypto.createHash('sha256').update(fs.readFileSync(appFile(name))).digest('hex');
  }

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `${host}:${server.address().port}`;
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });

    async function open(mode) {
      authMode = mode;
      const context = await browser.newContext(); contexts.push(context);
      await context.addInitScript(() => {
        window.__historyEvents = [];
        for (const name of ['popstate', 'hashchange']) window.addEventListener(name,
          () => window.__historyEvents.push({ name, hash: location.hash }), true);
      });
      const page = await context.newPage();
      page.on('pageerror', error => pageErrors.push(error.stack || error.message));
      await page.route('**/*', route => {
        const target = new URL(route.request().url());
        if (target.origin !== origin) { externalRequests.push(target.href); return route.abort(); }
        return route.continue();
      });
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__odysseusAppStarted === true &&
        document.querySelector('.send-btn')?.dataset.mode === 'mic', null, { timeout: 20000 });
      await page.waitForFunction(() => !document.getElementById('app-loader'), null, { timeout: 10000 });
      const mic = await page.locator('.send-btn').evaluate(btn => ({ mode: btn.dataset.mode, disabled: btn.disabled, hidden: btn.hidden }));
      assert.deepEqual(mic, { mode: 'mic', disabled: false, hidden: false });
      return page;
    }

    async function newChat(page, fromId) {
      await page.locator('#sidebar-new-chat-btn').click();
      await page.waitForFunction(oldId => window.sessionModule.getPendingDraftId() &&
        window.sessionModule.getPendingDraftId() !== oldId, fromId, { timeout: 10000 });
      return page.evaluate(() => window.sessionModule.getPendingDraftId());
    }

    async function createABAndRestore(mode, shouldMigrate, incognito = false) {
      const page = await open(mode);
      const start = await page.evaluate(() => window.sessionModule.getPendingDraftId());
      const idA = await newChat(page, start);
      if (incognito) await page.evaluate(() => window.sessionModule.setPendingDraftIncognito(true));
      await page.evaluate(() => window.sessionModule.createDirectChat(
        'https://fixture.invalid/model', 'fixture/model', 'fixture-endpoint'));
      await page.locator('#message').fill(`draft A ${mode}`);
      const draftKeysBefore = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ody-composer-drafts:')));
      const idB = await newChat(page, idA);
      await page.locator('#message').fill(`draft B ${mode}`);
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
      await page.waitForFunction(id => window.__historyEvents.some(event =>
        event.name === 'popstate' && event.hash === `#newchat-${id}`), idA);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const restored = await page.evaluate(() => ({
        pendingDraftId: window.sessionModule.getPendingDraftId(),
        text: document.getElementById('message').value,
        metadata: window.sessionModule.getPendingChat(),
        localKeys: Object.keys(localStorage).filter(k => k.startsWith('ody-composer-drafts:')),
        events: window.__historyEvents.slice(),
      }));
      assert.equal(restored.pendingDraftId, idA);
      assert.equal(restored.text, `draft A ${mode}`);
      assert.equal(restored.metadata?.url, 'https://fixture.invalid/model');
      assert.equal(restored.metadata?.modelId, 'fixture/model');
      assert.ok(restored.events.some(event => event.name === 'popstate' && event.hash === `#newchat-${idA}`));

      let adopted = null;
      if (shouldMigrate) {
        authMode = 'user';
        const verified = await page.evaluate(async () => {
          const auth = await import('/static/js/authState.js');
          return await auth.getAuthState();
        });
        assert.equal(verified.verified, true);
        assert.equal(verified.switched, false);
        assert.equal(verified.identity, 'fixture-user');
        const restore = await page.evaluate(id => window.sessionModule.restorePendingChatDraft(id), idA);
        assert.equal(restore, true);
        adopted = await page.evaluate(id => ({
          text: document.getElementById('message').value,
          metadata: window.sessionModule.getPendingChat(),
          stored: localStorage.getItem(`ody-composer-drafts:fixture-user:${encodeURIComponent(id)}`),
          pageScopeKeys: Object.keys(localStorage).filter(k => k.startsWith('ody-composer-drafts:page-')),
        }), idA);
        assert.equal(adopted.text, `draft A ${mode}`);
        assert.equal(JSON.parse(adopted.stored).text, `draft A ${mode}`);
        assert.equal(JSON.parse(adopted.stored).pending.modelId, 'fixture/model');
        assert.deepEqual(adopted.pageScopeKeys, []);
      }
      assert.equal(pageErrors.length, 0);
      assert.deepEqual(externalRequests, []);
      await page.close();
      return { idA, idB, draftKeysBefore, restored, adopted, mic: { mode: 'mic', disabled: false, hidden: false } };
    }

    async function checkIncognitoCollisionAndSwitchGuard() {
      const page = await open('unavailable');
      const start = await page.evaluate(() => window.sessionModule.getPendingDraftId());
      const idA = await newChat(page, start);
      const accountKey = `ody-composer-drafts:fixture-user:${encodeURIComponent(idA)}`;
      const existingRecord = JSON.stringify({ text: 'pre-existing account draft' });
      await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: accountKey, value: existingRecord });
      await page.evaluate(() => window.sessionModule.setPendingDraftIncognito(true));
      await page.evaluate(() => window.sessionModule.createDirectChat(
        'https://fixture.invalid/model', 'fixture/model', 'fixture-endpoint'));
      await page.locator('#message').fill('draft A incognito unavailable');
      const idB = await newChat(page, idA);
      await page.locator('#message').fill('draft B incognito unavailable');
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
      await page.waitForFunction(({ id }) => window.sessionModule.getPendingDraftId() === id &&
        document.getElementById('message')?.value === 'draft A incognito unavailable', { id: idA }, { timeout: 10000 });
      authMode = 'user';
      const auth = await page.evaluate(async () => import('/static/js/authState.js').then(module => module.getAuthState()));
      assert.equal(auth.verified, true);
      assert.equal(auth.switched, false);
      const restoredAfterVerify = await page.evaluate(id => ({
        restored: window.sessionModule.restorePendingChatDraft(id),
        text: document.getElementById('message').value,
        stored: localStorage.getItem(`ody-composer-drafts:fixture-user:${encodeURIComponent(id)}`),
      }), idA);
      assert.equal(restoredAfterVerify.restored, true);
      assert.equal(restoredAfterVerify.text, 'draft A incognito unavailable');
      assert.equal(restoredAfterVerify.stored, existingRecord, 'incognito restore must preserve a same-key account draft');
      await page.evaluate(() => localStorage.setItem('odysseus-auth-user', 'different-fixture-user'));
      const switchedRestore = await page.evaluate(id => ({
        restored: window.sessionModule.restorePendingChatDraft(id),
        stored: localStorage.getItem(`ody-composer-drafts:fixture-user:${encodeURIComponent(id)}`),
      }), idA);
      assert.equal(switchedRestore.restored, false);
      assert.equal(switchedRestore.stored, existingRecord, 'switched identity must not alter another identity\'s account draft');
      assert.equal(pageErrors.length, 0);
      assert.deepEqual(externalRequests, []);
      await page.close();
      return { idA, idB, restoredAfterVerify, switchedRestore };
    }

    result.cases.verifiedAnonymous = await createABAndRestore('anonymous', false);
    assert.deepEqual(result.cases.verifiedAnonymous.draftKeysBefore, []);
    assert.deepEqual(result.cases.verifiedAnonymous.restored.localKeys, []);
    result.cases.verifiedAnonymousIncognito = await createABAndRestore('anonymous-incognito', false, true);
    assert.deepEqual(result.cases.verifiedAnonymousIncognito.draftKeysBefore, []);
    assert.deepEqual(result.cases.verifiedAnonymousIncognito.restored.localKeys, []);
    result.cases.authUnavailableThenVerified = await createABAndRestore('unavailable', true);
    assert.deepEqual(result.cases.authUnavailableThenVerified.draftKeysBefore, []);
    assert.ok(authResponses.some(item => item.mode === 'unavailable' && item.status === 503));
    assert.ok(authResponses.some(item => item.mode === 'user' && item.status === 200));
    result.cases.verifiedAccountControl = await createABAndRestore('user', false);
    assert.ok(result.cases.verifiedAccountControl.draftKeysBefore.some(key => key.startsWith('ody-composer-drafts:fixture-user:')));
    result.cases.incognitoCollisionAndSwitchGuard = await checkIncognitoCollisionAndSwitchGuard();
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
    result.requestPaths = [...new Set(requests)].sort();
    result.pass = true;
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write((error.stack || String(error)) + '\n');
    process.exitCode = 1;
  } finally {
    await Promise.all(contexts.map(context => context.close().catch(() => {})));
    if (browser) await browser.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve)).catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
