'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const settingsPath = path.join(repo, 'static/js/settings.js');
const settingsHash = crypto.createHash('sha256').update(fs.readFileSync(settingsPath)).digest('hex');
const state = { tests: [], saves: [], pending: [], nextTestHold: false, nextTestReply: null, pendingAccounts: [], nextAccountHold: false, failNextAccount: false, accountStatuses: [], pendingSaves: [], nextSaveHold: false, pendingPresets: [], nextPresetsHold: false, accountReads: 0 };
const accounts = [
  { id: 'fixture-account-a', label: 'Account A', url: 'https://fixture.invalid/a', username: 'a-user' },
  { id: 'fixture-account-b', label: 'Account B', url: 'https://fixture.invalid/b', username: 'b-user' },
];
const pageHtml = `<!doctype html><meta charset="utf-8"><body><div id="settings-ancestor">
<div id="unified-integrations-list"></div>
<div id="unified-intg-form" style="display:none"></div>
<div><button id="unified-intg-add-btn" type="button">Add</button></div></div>
<script type="module">
  window.__integrationChanges = 0;
  window.addEventListener('odysseus-integrations-changed', () => window.__integrationChanges++);
  import settings from '/static/js/settings.js';
  await settings.initUnifiedIntegrations();
  window.fixtureReady = true;
</script></body>`;

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}
function reset() {
  if (state.pending.length || state.pendingAccounts.length || state.pendingSaves.length || state.pendingPresets.length) throw new Error('cannot reset while requests are held');
  state.tests.length = 0;
  state.saves.length = 0;
  state.nextTestHold = false;
  state.nextTestReply = null;
  state.failNextAccount = false;
  state.accountStatuses.length = 0;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') return res.end(pageHtml);
  if (url.pathname === '/__state') return json(res, {
    tests: state.tests,
    saves: state.saves,
    pending: state.pending.map(item => item.id),
    pendingAccounts: state.pendingAccounts.map(item => item.id),
    pendingSaves: state.pendingSaves.map(item => item.id),
    pendingPresets: state.pendingPresets.map(item => item.id),
    accountReads: state.accountReads,
    accountStatuses: state.accountStatuses,
  });
  if (url.pathname === '/__reset') {
    try { reset(); return json(res, { ok: true }); }
    catch (error) { return json(res, { ok: false, error: error.message }, 409); }
  }
  if (url.pathname === '/__hold-next-test') {
    state.nextTestHold = true;
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__hold-next-account') {
    state.nextAccountHold = true;
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__fail-next-account-prefill') {
    state.failNextAccount = true;
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__hold-next-save') {
    state.nextSaveHold = true;
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__hold-next-presets') {
    state.nextPresetsHold = true;
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__next-test-null') {
    state.nextTestReply = { payload: null };
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__release-save') {
    const item = state.pendingSaves.shift();
    if (!item) return json(res, { ok: false, error: 'no held save' }, 409);
    const id = item.path.split('/').pop();
    const account = accounts.find(row => row.id === id);
    if (account) Object.assign(account, item.body);
    json(item.res, { ok: true });
    return json(res, { ok: true, released: item.id });
  }
  if (url.pathname === '/__release-account') {
    const item = state.pendingAccounts.shift();
    if (!item) return json(res, { ok: false, error: 'no held account lookup' }, 409);
    json(item.res, { accounts });
    return json(res, { ok: true, released: item.id });
  }
  if (url.pathname === '/__release-test') {
    const item = state.pending.shift();
    if (!item) return json(res, { ok: false, error: 'no held Test' }, 409);
    json(item.res, { ok: true, message: 'Synthetic CalDAV connection succeeded' });
    return json(res, { ok: true, released: item.id });
  }
  if (url.pathname === '/__release-presets') {
    const item = state.pendingPresets.shift();
    if (!item) return json(res, { ok: false, error: 'no held presets' }, 409);
    json(item.res, { presets: {} });
    return json(res, { ok: true, released: item.id });
  }
  if (url.pathname === '/api/auth/integrations/presets') {
    const id = state.pendingPresets.length + 1;
    if (state.nextPresetsHold) {
      state.nextPresetsHold = false;
      state.pendingPresets.push({ id, res });
      return;
    }
    return json(res, { presets: {} });
  }
  if (url.pathname === '/api/calendar/config/accounts' && req.method === 'GET') {
    state.accountReads++;
    if (state.failNextAccount) {
      state.failNextAccount = false;
      state.accountStatuses.push(503);
      return json(res, { detail: 'Synthetic prefill failure' }, 503);
    }
    state.accountStatuses.push(200);
    const id = state.pendingAccounts.length + 1;
    if (state.nextAccountHold) {
      state.nextAccountHold = false;
      state.pendingAccounts.push({ id, res });
      return;
    }
    return json(res, { accounts });
  }
  if (url.pathname === '/api/calendar/config/accounts' && req.method === 'POST') {
    const body = await readBody(req);
    state.saves.push({ method: 'POST', path: url.pathname, body });
    return json(res, { ok: true, account: { id: 'fixture-created', ...body } });
  }
  if (url.pathname.startsWith('/api/calendar/config/accounts/') && req.method === 'PUT') {
    const body = await readBody(req);
    const save = { method: 'PUT', path: url.pathname, body };
    state.saves.push(save);
    if (state.nextSaveHold) {
      state.nextSaveHold = false;
      state.pendingSaves.push({ id: state.saves.length, ...save, res });
      return;
    }
    const account = accounts.find(row => row.id === url.pathname.split('/').pop());
    if (account) Object.assign(account, body);
    return json(res, { ok: true });
  }
  if (url.pathname === '/api/calendar/test' && req.method === 'POST') {
    const body = await readBody(req);
    const id = state.tests.length + 1;
    state.tests.push({ id, body });
    if (state.nextTestHold) {
      state.nextTestHold = false;
      state.pending.push({ id, res });
      return;
    }
    if (state.nextTestReply) {
      const reply = state.nextTestReply;
      state.nextTestReply = null;
      return json(res, reply.payload);
    }
    return json(res, { ok: true, message: 'Synthetic CalDAV connection succeeded' });
  }
  if (url.pathname === '/api/auth/integrations') return json(res, { integrations: [{ id: 'fixture-api', name: 'Fixture API', base_url: 'https://fixture.invalid/api', enabled: true }] });
  if (url.pathname === '/api/contacts/config') return json(res, {});
  if (url.pathname === '/api/contacts/list') return json(res, { contacts: [], count: 0 });
  if (url.pathname === '/api/email/accounts') return json(res, { accounts: [] });
  if (url.pathname === '/api/mcp/servers') return json(res, []);
  if (url.pathname === '/api/vault/config') return json(res, {});
  if (url.pathname === '/api/tokens') return json(res, []);
  if (url.pathname === '/api/calendar/calendars') return json(res, { calendars: [] });
  const file = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('not found');
  }
  const type = file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript'
    : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  let browser;
  const result = {
    mode: 'caldav-test-form-ownership',
    source: { file: 'static/js/settings.js', sha256: settingsHash },
    loopbackOnly: true,
    externalRequests: [],
    pageErrors: [],
    cases: {},
  };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.BROWSER_EXECUTABLE,
      args: ['--no-sandbox', '--disable-gpu'],
    });
    const newPage = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      await page.addInitScript(() => {
        window.__caldavTestJsonConsumed = 0;
        window.__caldavTestFetchResolved = 0;
        window.__caldavSaveFetchResolved = 0;
        window.__caldavAccountJsonConsumed = 0;
        window.__caldavAccountFetchResolved = 0;
        window.__apiPresetsFetchResolved = 0;
        window.__apiPresetsJsonConsumed = 0;
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await nativeFetch(...args);
          const request = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
          const method = (args[1]?.method || (typeof args[0] === 'object' && args[0].method) || 'GET').toUpperCase();
          if (request.pathname === '/api/calendar/test') window.__caldavTestFetchResolved++;
          if (request.pathname.startsWith('/api/calendar/config/accounts/') && method === 'PUT') window.__caldavSaveFetchResolved++;
          if (request.pathname === '/api/calendar/config/accounts' && method === 'GET') window.__caldavAccountFetchResolved++;
          if (request.pathname === '/api/auth/integrations/presets') window.__apiPresetsFetchResolved++;
          const originalJson = response.json.bind(response);
          response.json = async (...jsonArgs) => {
            const data = await originalJson(...jsonArgs);
            if (request.pathname === '/api/calendar/test') window.__caldavTestJsonConsumed++;
            if (request.pathname === '/api/calendar/config/accounts' && method === 'GET') window.__caldavAccountJsonConsumed++;
            if (request.pathname === '/api/auth/integrations/presets') window.__apiPresetsJsonConsumed++;
            return data;
          };
          return response;
        };
      });
      await page.route('**/*', route => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:') {
          if (requestUrl.origin !== origin) {
            result.loopbackOnly = false;
            result.externalRequests.push(requestUrl.href);
            return route.abort();
          }
        }
        return route.continue();
      });
      page.on('pageerror', error => result.pageErrors.push(error.stack || error.message));
      await page.goto(origin);
      await page.waitForFunction(() => window.fixtureReady);
      await page.locator('.intg-card[data-intg-type="caldav"]').first().waitFor();
      return { page, context };
    };
    const resetState = async page => {
      const response = await page.request.get(`${origin}/__reset`);
      assert.equal(response.status(), 200, 'test state resets only after prior requests finish');
    };
    const stateOn = async page => page.evaluate(async () => await (await fetch('/__state')).json());
    const openAccount = async (page, id) => {
      const beforeReads = await page.evaluate(() => window.__caldavAccountJsonConsumed);
      await page.locator(`.intg-card[data-intg-id="${id}"]`).click();
      await page.waitForFunction(count => {
        const title = document.querySelector('#unified-intg-form h2')?.textContent || '';
        return window.__caldavAccountJsonConsumed === count + 1 && title.includes('Edit CalDAV Calendar');
      }, beforeReads);
    };
    const openNewCalDav = async page => {
      await page.locator('#unified-intg-add-btn').click();
      await page.locator('.uf-type-option[data-value="caldav"]').click();
      await page.locator('#uf-caldav-save').waitFor();
      assert.match(await page.locator('#unified-intg-form h2').textContent(), /Add CalDAV Calendar/);
    };
    const fillAccount = async (page, label, url, username, password) => {
      await page.locator('#uf-caldav-label').fill(label);
      await page.locator('#uf-caldav-url').fill(url);
      await page.locator('#uf-caldav-user').fill(username);
      await page.locator('#uf-caldav-pass').fill(password);
    };
    const closeContext = async context => { await context.close().catch(() => {}); };

    // Save tests input snapshot A, but the existing handler reads mutable fields again after await.
    {
      const { page, context } = await newPage();
      try {
        await openAccount(page, 'fixture-account-a');
        await fillAccount(page, 'A tested label', 'https://fixture.invalid/tested-a', 'tested-user-a', '');
        await page.request.get(`${origin}/__hold-next-test`);
        await page.locator('#uf-caldav-save').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending.length === 1);
        await fillAccount(page, 'B changed label', 'https://fixture.invalid/changed-b', 'changed-user-b', 'changed-password-b');
        const pendingState = await stateOn(page);
        assert.deepEqual(pendingState.tests[0].body, {
          url: 'https://fixture.invalid/tested-a', username: 'tested-user-a', password: '', account_id: 'fixture-account-a',
        }, 'the test endpoint received the original A snapshot');
        await page.request.get(`${origin}/__release-test`);
        await page.waitForFunction(() => window.__caldavTestJsonConsumed === 1);
        const finalState = await stateOn(page);
        assert.equal(finalState.saves.length, 0, 'changed fields must block persistence after testing the old snapshot');
        assert.equal(await page.locator('#uf-caldav-label').inputValue(), 'B changed label');
        assert.equal(await page.locator('#uf-caldav-url').inputValue(), 'https://fixture.invalid/changed-b');
        assert.equal(await page.locator('#uf-caldav-user').inputValue(), 'changed-user-b');
        assert.equal(await page.locator('#uf-caldav-pass').inputValue(), 'changed-password-b');
        assert.match(await page.locator('#uf-caldav-msg').textContent(), /Fields changed/);
        result.cases.changedFieldsPreserved = {
          observed: 'no save; edited values preserved; retest requested',
          tested: pendingState.tests[0].body,
          message: await page.locator('#uf-caldav-msg').textContent(),
          fields: { label: await page.locator('#uf-caldav-label').inputValue(), url: await page.locator('#uf-caldav-url').inputValue(), username: await page.locator('#uf-caldav-user').inputValue(), password: await page.locator('#uf-caldav-pass').inputValue() },
        };
      } finally { await closeContext(context); }
    }

    // A delayed Test A completion writes into the globally looked-up message node in reopened form B.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openAccount(page, 'fixture-account-a');
        await page.request.get(`${origin}/__hold-next-test`);
        await page.locator('#uf-caldav-test').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending.length === 1);
        await page.locator('#uf-caldav-cancel').click();
        await openAccount(page, 'fixture-account-b');
        assert.equal(await page.locator('#uf-caldav-msg').textContent(), '', 'reopened B starts without a message');
        const testFetches = await page.evaluate(() => window.__caldavTestFetchResolved);
        await page.request.get(`${origin}/__release-test`);
        await page.waitForFunction(count => window.__caldavTestFetchResolved === count + 1, testFetches);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        assert.equal(await page.locator('#uf-caldav-url').inputValue(), 'https://fixture.invalid/b');
        assert.equal(await page.locator('#uf-caldav-msg').textContent(), '', 'stale A result must not paint reopened B form');
        result.cases.heldTestAReopenB = {
          observed: 'stale A result ignored by reopened B form',
          currentFormUrl: await page.locator('#uf-caldav-url').inputValue(),
          currentMessage: await page.locator('#uf-caldav-msg').textContent(),
        };
      } finally { await closeContext(context); }
    }

    // Record Save A canceled/reopened as B while its connection Test is held.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openAccount(page, 'fixture-account-a');
        await fillAccount(page, 'A saved draft', 'https://fixture.invalid/save-a', 'save-user-a', '');
        const testFetches = await page.evaluate(() => window.__caldavTestFetchResolved);
        await page.request.get(`${origin}/__hold-next-test`);
        await page.locator('#uf-caldav-save').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending.length === 1);
        await page.locator('#uf-caldav-cancel').click();
        await openAccount(page, 'fixture-account-b');
        await page.locator('#uf-caldav-label').fill('B draft stays');
        const beforeRelease = await stateOn(page);
        await page.request.get(`${origin}/__release-test`);
        await page.waitForFunction(count => window.__caldavTestFetchResolved === count + 1, testFetches);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const afterRelease = await stateOn(page);
        assert.equal(afterRelease.saves.length, 0, 'Save A must not persist after its form was canceled');
        assert.equal(await page.locator('#uf-caldav-url').inputValue(), 'https://fixture.invalid/b');
        assert.equal(await page.locator('#uf-caldav-label').inputValue(), 'B draft stays');
        assert.equal(await page.locator('#uf-caldav-msg').textContent(), '', 'Save A must not paint B');
        result.cases.heldSaveAReopenB = {
          saveRequests: afterRelease.saves.length,
          currentUrl: await page.locator('#uf-caldav-url').inputValue(),
          currentLabel: await page.locator('#uf-caldav-label').inputValue(),
          currentMessage: await page.locator('#uf-caldav-msg').textContent(),
          initialSaveRequests: beforeRelease.saves.length,
        };
      } finally { await closeContext(context); }
    }

    // Record standalone Test result ownership when fields change in the same visible form.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openAccount(page, 'fixture-account-a');
        await fillAccount(page, 'Tested A', 'https://fixture.invalid/test-a', 'test-user-a', 'test-password-a');
        const testReads = await page.evaluate(() => window.__caldavTestJsonConsumed);
        await page.request.get(`${origin}/__hold-next-test`);
        await page.locator('#uf-caldav-test').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending.length === 1);
        await fillAccount(page, 'Edited B', 'https://fixture.invalid/test-b', 'test-user-b', 'test-password-b');
        await page.request.get(`${origin}/__release-test`);
        await page.waitForFunction(count => window.__caldavTestJsonConsumed === count + 1, testReads);
        const currentFields = { label: await page.locator('#uf-caldav-label').inputValue(), url: await page.locator('#uf-caldav-url').inputValue(), username: await page.locator('#uf-caldav-user').inputValue(), password: await page.locator('#uf-caldav-pass').inputValue() };
        const message = await page.locator('#uf-caldav-msg').textContent();
        assert.deepEqual(currentFields, { label: 'Edited B', url: 'https://fixture.invalid/test-b', username: 'test-user-b', password: 'test-password-b' });
        assert.equal(message, 'Fields changed — test again', 'Test must not report success for a changed field snapshot');
        result.cases.standaloneTestAfterEdit = { observed: 'changed fields preserved; stale success suppressed', tested: (await stateOn(page)).tests[0].body, currentFields, message };
      } finally { await closeContext(context); }
    }

    // A stale account lookup must neither fill B fields nor bind A handlers to B controls.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        const initialReads = await page.evaluate(() => window.__caldavAccountFetchResolved);
        await page.request.get(`${origin}/__hold-next-account`);
        await page.locator('.intg-card[data-intg-id="fixture-account-a"]').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pendingAccounts.length === 1);
        await page.locator('.intg-card[data-intg-id="fixture-account-b"]').click();
        await page.waitForFunction(() => document.querySelector('#uf-caldav-url')?.value === 'https://fixture.invalid/b');
        await page.waitForFunction(count => window.__caldavAccountJsonConsumed === count + 1, initialReads);
        await page.request.get(`${origin}/__release-account`);
        await page.waitForFunction(count => window.__caldavAccountFetchResolved === count + 2, initialReads);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        assert.equal(await page.locator('#uf-caldav-url').inputValue(), 'https://fixture.invalid/b', 'stale A lookup must not overwrite B fields');
        await page.locator('#uf-caldav-test').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).tests.length === 1);
        const finalState = await stateOn(page);
        assert.equal(finalState.tests.length, 1, 'stale A lookup must not bind a second Test handler to B');
        assert.deepEqual(finalState.tests[0].body, { url: 'https://fixture.invalid/b', username: 'b-user', password: '', account_id: 'fixture-account-b' });
        result.cases.heldEditLookupAThenB = { observed: 'stale A lookup ignored; B fields and one B Test handler retained', test: finalState.tests[0].body };
      } finally { await closeContext(context); }
    }

    // Record whether a delayed same-form account prefill overwrites typing before applying a guard.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        const beforeReads = await page.evaluate(() => window.__caldavAccountFetchResolved);
        await page.request.get(`${origin}/__hold-next-account`);
        await page.locator('.intg-card[data-intg-id="fixture-account-a"]').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pendingAccounts.length === 1);
        await fillAccount(page, 'Typed draft', 'https://fixture.invalid/typed', 'typed-user', 'typed-password');
        await page.request.get(`${origin}/__release-account`);
        await page.waitForFunction(count => window.__caldavAccountFetchResolved === count + 1, beforeReads);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const afterLookup = { label: await page.locator('#uf-caldav-label').inputValue(), url: await page.locator('#uf-caldav-url').inputValue(), username: await page.locator('#uf-caldav-user').inputValue(), password: await page.locator('#uf-caldav-pass').inputValue() };
        assert.deepEqual(afterLookup, { label: 'Typed draft', url: 'https://fixture.invalid/typed', username: 'typed-user', password: 'typed-password' }, 'delayed account prefill must preserve fields edited while loading');
        result.cases.sameFormTypingDuringEditLookup = { observed: 'typed fields preserved', afterLookup };
      } finally { await closeContext(context); }
    }

    // Record pending Save behavior when Settings ancestor becomes hidden.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openAccount(page, 'fixture-account-a');
        await fillAccount(page, 'Hidden save', 'https://fixture.invalid/hidden', 'hidden-user', 'hidden-password');
        const testFetches = await page.evaluate(() => window.__caldavTestFetchResolved);
        await page.request.get(`${origin}/__hold-next-test`);
        await page.locator('#uf-caldav-save').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending.length === 1);
        await page.locator('#settings-ancestor').evaluate(el => { el.style.display = 'none'; });
        await page.request.get(`${origin}/__release-test`);
        await page.waitForFunction(count => window.__caldavTestFetchResolved === count + 1, testFetches);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const whileHidden = await stateOn(page);
        await page.locator('#settings-ancestor').evaluate(el => { el.style.display = ''; });
        assert.equal(whileHidden.saves.length, 0, 'hidden Settings form must not continue into persistence');
        assert.equal(await page.locator('#uf-caldav-msg').textContent(), '', 'abandoned Test status is cleared when Settings returns');
        result.cases.heldSaveSettingsHidden = {
          savesWhileHidden: whileHidden.saves.length,
          messageAfterReturn: await page.locator('#uf-caldav-msg').textContent(),
          fields: { label: await page.locator('#uf-caldav-label').inputValue(), url: await page.locator('#uf-caldav-url').inputValue() },
        };
      } finally { await closeContext(context); }
    }

    // A Save A result must not persist or hide the shared form after another type is selected.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openAccount(page, 'fixture-account-a');
        await fillAccount(page, 'A draft', 'https://fixture.invalid/type-race-a', 'race-user-a', 'race-password-a');
        const testReads = await page.evaluate(() => window.__caldavTestFetchResolved);
        await page.request.get(`${origin}/__hold-next-test`);
        await page.locator('#uf-caldav-save').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending.length === 1);
        await page.request.get(`${origin}/__hold-next-presets`);
        await page.locator('.intg-card[data-intg-id="fixture-api"]').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pendingPresets.length === 1);
        await page.request.get(`${origin}/__release-test`);
        await page.waitForFunction(count => window.__caldavTestFetchResolved === count + 1, testReads);
        await page.waitForFunction(async () => {
          const state = await (await fetch('/__state')).json();
          const message = document.querySelector('#uf-caldav-msg')?.textContent;
          return state.saves.length > 0 || message === '';
        });
        const beforePresets = await stateOn(page);
        assert.equal(beforePresets.saves.length, 0, 'changing integration type invalidates pending CalDAV Save');
        assert.equal(await page.locator('#unified-intg-form').isVisible(), true, 'pending API presets leave shared form visible');
        assert.equal(await page.locator('#uf-caldav-msg').textContent(), '', 'abandoned Test status is cleared while presets load');
        await page.request.get(`${origin}/__release-presets`);
        await page.locator('#unified-intg-form h2').filter({ hasText: 'API Integration' }).waitFor();
        assert.equal(await page.locator('#unified-intg-form').isVisible(), true, 'API form remains visible after stale CalDAV result');
        result.cases.caldavSaveThenApiSelection = { savesAfterTest: beforePresets.saves.length, formTitle: await page.locator('#unified-intg-form h2').textContent(), visible: await page.locator('#unified-intg-form').isVisible(), messageAfterAbandon: '' };
      } finally { await closeContext(context); }
    }

    // Successful persistence after hiding Settings clears only its own transient message.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openAccount(page, 'fixture-account-a');
        await fillAccount(page, 'Hidden PUT', 'https://fixture.invalid/hidden-put', 'hidden-put-user', 'hidden-put-password');
        await page.request.get(`${origin}/__hold-next-save`);
        const accountReads = (await stateOn(page)).accountReads;
        await page.locator('#uf-caldav-save').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pendingSaves.length === 1);
        await page.locator('#settings-ancestor').evaluate(el => { el.style.display = 'none'; });
        await page.request.get(`${origin}/__release-save`);
        await page.waitForFunction(() => window.__caldavSaveFetchResolved === 1);
        await page.waitForFunction(() => document.querySelector('.intg-card[data-intg-id="fixture-account-a"]')?.textContent.includes('Hidden PUT'));
        await page.locator('#settings-ancestor').evaluate(el => { el.style.display = ''; });
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const messageAfterReturn = await page.locator('#uf-caldav-msg').textContent();
        assert.equal(messageAfterReturn, '', 'abandoned Saving status is cleared after persisted state refreshes');
        assert.ok((await stateOn(page)).accountReads > accountReads);
        result.cases.heldSaveSettingsHiddenDuringPut = { observed: 'saved state refreshed; stale Saving status cleared', messageAfterReturn };
      } finally { await closeContext(context); }
    }

    // A literal null from the Test endpoint is a controlled failure, not an unhandled UI error.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openAccount(page, 'fixture-account-a');
        const testReads = await page.evaluate(() => window.__caldavTestJsonConsumed);
        await page.request.get(`${origin}/__next-test-null`);
        await page.locator('#uf-caldav-test').click();
        await page.waitForFunction(count => window.__caldavTestJsonConsumed === count + 1, testReads);
        await page.waitForFunction(() => document.querySelector('#uf-caldav-msg')?.textContent === 'Invalid response from server');
        assert.equal(await page.locator('#uf-caldav-msg').textContent(), 'Invalid response from server');
        result.cases.nullTestResponse = { observed: 'malformed null response shown as controlled failure', message: await page.locator('#uf-caldav-msg').textContent() };
      } finally { await closeContext(context); }
    }

    // Record current Cancel behavior while edit-account prefill is still waiting.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        const accountFetches = await page.evaluate(() => window.__caldavAccountFetchResolved);
        await page.request.get(`${origin}/__hold-next-account`);
        await page.locator('.intg-card[data-intg-id="fixture-account-a"]').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pendingAccounts.length === 1);
        await page.locator('#uf-caldav-cancel').click();
        const visibleAfterCancel = await page.locator('#unified-intg-form').isVisible();
        await page.request.get(`${origin}/__release-account`);
        await page.waitForFunction(count => window.__caldavAccountFetchResolved === count + 1, accountFetches);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const formUrlAfterLookup = await page.locator('#uf-caldav-url').inputValue();
        assert.equal(visibleAfterCancel, false, 'Cancel must be wired before the initial edit lookup completes');
        assert.equal(formUrlAfterLookup, '', 'a canceled form must not receive the delayed prefill');
        result.cases.cancelWhilePrefillHeld = { observed: 'cancel hid the form; late prefill ignored', visibleAfterCancel, formUrlAfterLookup };
      } finally { await closeContext(context); }
    }

    // Record changing fields while actual account PUT waits for server response.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openAccount(page, 'fixture-account-a');
        await fillAccount(page, 'Saving A', 'https://fixture.invalid/put-a', 'put-user-a', 'put-password-a');
        await page.request.get(`${origin}/__hold-next-save`);
        await page.locator('#uf-caldav-save').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pendingSaves.length === 1);
        const input = page.locator('#uf-caldav-url');
        const disabledWhileSaving = await input.isDisabled();
        assert.equal(disabledWhileSaving, true, 'captured form inputs stay disabled during actual persistence');
        assert.equal(await page.locator('#uf-caldav-msg').textContent(), 'Saving…');
        const duringSave = await stateOn(page);
        const accountReads = duringSave.accountReads;
        await page.request.get(`${origin}/__release-save`);
        await page.waitForFunction(() => window.__caldavSaveFetchResolved === 1);
        await page.waitForFunction(async count => (await (await fetch('/__state')).json()).accountReads > count, accountReads);
        await page.waitForFunction(() => document.querySelector('#unified-intg-form').style.display === 'none');
        await openAccount(page, 'fixture-account-a');
        result.cases.editDuringActualSave = {
          disabledWhileSaving,
          pendingPayload: duringSave.saves[0].body,
          afterReopen: { label: await page.locator('#uf-caldav-label').inputValue(), url: await page.locator('#uf-caldav-url').inputValue(), username: await page.locator('#uf-caldav-user').inputValue(), password: await page.locator('#uf-caldav-pass').inputValue() },
        };
      } finally { await closeContext(context); }
    }

    // Record successful PUT A after form changes to B while response is held.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openAccount(page, 'fixture-account-a');
        await fillAccount(page, 'Saved A', 'https://fixture.invalid/persist-a', 'persist-user-a', 'persist-password-a');
        await page.request.get(`${origin}/__hold-next-save`);
        await page.locator('#uf-caldav-save').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pendingSaves.length === 1);
        await page.locator('#uf-caldav-cancel').click();
        await openAccount(page, 'fixture-account-b');
        await page.locator('#uf-caldav-label').fill('B remains open');
        const baselineReads = (await stateOn(page)).accountReads;
        const eventsBefore = await page.evaluate(() => window.__integrationChanges);
        const saveFetches = await page.evaluate(() => window.__caldavSaveFetchResolved);
        await page.request.get(`${origin}/__release-save`);
        await page.waitForFunction(count => window.__caldavSaveFetchResolved === count + 1, saveFetches);
        await page.waitForFunction(count => window.__integrationChanges === count + 1, eventsBefore);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        await page.waitForFunction(async count => (await (await fetch('/__state')).json()).accountReads > count, baselineReads);
        const afterSave = await stateOn(page);
        const refreshedCard = await page.locator('.intg-card[data-intg-id="fixture-account-a"]').textContent();
        assert.ok(refreshedCard.includes('Saved A'), 'successful background Save must refresh the integrations list');
        assert.equal(afterSave.saves.length, 1);
        assert.equal(afterSave.accountReads > baselineReads, true, 'successful Save refreshes saved integration state');
        assert.equal(await page.locator('#uf-caldav-url').inputValue(), 'https://fixture.invalid/b', 'refresh must not replace the reopened B form');
        assert.equal(await page.locator('#uf-caldav-label').inputValue(), 'B remains open');
        assert.equal(await page.locator('#uf-caldav-msg').textContent(), '', 'background Save must not paint B status');
        result.cases.saveACompletesAfterReopenB = {
          accountReadsBefore: baselineReads,
          accountReadsAfter: afterSave.accountReads,
          integrationEventsBefore: eventsBefore,
          integrationEventsAfter: await page.evaluate(() => window.__integrationChanges),
          currentUrl: await page.locator('#uf-caldav-url').inputValue(),
          currentLabel: await page.locator('#uf-caldav-label').inputValue(),
          currentMessage: await page.locator('#uf-caldav-msg').textContent(),
        };
      } finally { await closeContext(context); }
    }

    // Failed edit prefill leaves blank fields; Save must stop before Test or persistence.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await page.request.get(`${origin}/__fail-next-account-prefill`);
        await openAccount(page, 'fixture-account-a');
        const before = await stateOn(page);
        assert.equal(before.accountStatuses.at(-1), 503);
        assert.equal(await page.locator('#uf-caldav-url').inputValue(), '');
        assert.equal(await page.locator('#uf-caldav-user').inputValue(), '');
        await page.locator('#uf-caldav-save').click();
        await page.waitForFunction(async () => {
          const state = await (await fetch('/__state')).json();
          return state.tests.length > 0 || document.querySelector('#uf-caldav-msg')?.textContent.includes('URL and username');
        });
        const after = await stateOn(page);
        assert.equal(after.tests.length, 0);
        assert.equal(after.saves.length, 0);
        assert.equal(await page.evaluate(() => window.__caldavTestFetchResolved), 0);
        assert.equal(await page.evaluate(() => window.__caldavSaveFetchResolved), 0);
        result.cases.failedPrefillEmptyUsernameBlocked = {
          observed: 'visible field error; no Test request or save',
          prefillStatus: before.accountStatuses.at(-1),
          testRequests: after.tests.length,
          saves: after.saves.length,
          message: await page.locator('#uf-caldav-msg').textContent(),
        };
      } finally { await closeContext(context); }
    }

    // Manually clearing URL and username on an edit cannot borrow saved values.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openAccount(page, 'fixture-account-a');
        await page.locator('#uf-caldav-url').fill('');
        await page.locator('#uf-caldav-user').fill('');
        await page.locator('#uf-caldav-save').click();
        await page.waitForFunction(() => document.querySelector('#uf-caldav-msg')?.textContent.includes('URL and username'));
        const after = await stateOn(page);
        assert.equal(after.tests.length, 0);
        assert.equal(after.saves.length, 0);
        assert.equal(await page.evaluate(() => window.__caldavTestFetchResolved), 0);
        assert.equal(await page.evaluate(() => window.__caldavSaveFetchResolved), 0);
        assert.equal(await page.locator('#uf-caldav-url').inputValue(), '');
        assert.equal(await page.locator('#uf-caldav-user').inputValue(), '');
        result.cases.manuallyClearedUrlAndUsernameBlocked = {
          observed: 'visible field error; no Test request or save',
          testRequests: after.tests.length,
          saves: after.saves.length,
          message: await page.locator('#uf-caldav-msg').textContent(),
        };
      } finally { await closeContext(context); }
    }

    // New accounts require a password before Save can send a Test request.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openNewCalDav(page);
        await fillAccount(page, 'New fixture', 'https://fixture.invalid/new', 'new-user', '');
        await page.locator('#uf-caldav-save').click();
        await page.waitForFunction(() => document.querySelector('#uf-caldav-msg')?.textContent.includes('new accounts also need a password'));
        const after = await stateOn(page);
        assert.equal(after.tests.length, 0);
        assert.equal(after.saves.length, 0);
        assert.equal(await page.evaluate(() => window.__caldavTestFetchResolved), 0);
        assert.equal(await page.evaluate(() => window.__caldavSaveFetchResolved), 0);
        assert.equal(await page.locator('#uf-caldav-url').inputValue(), 'https://fixture.invalid/new');
        assert.equal(await page.locator('#uf-caldav-user').inputValue(), 'new-user');
        result.cases.newAccountBlankPasswordBlocked = {
          observed: 'visible password requirement; no Test request or save',
          testRequests: after.tests.length,
          saves: after.saves.length,
          message: await page.locator('#uf-caldav-msg').textContent(),
        };
      } finally { await closeContext(context); }
    }

    // Saved edits may still test with a blank password when their explicit account id is present.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openAccount(page, 'fixture-account-a');
        await fillAccount(page, 'Saved edit blank password', 'https://fixture.invalid/edit', 'edit-user', '');
        await page.locator('#uf-caldav-save').click();
        await page.waitForFunction(async () => {
          const state = await (await fetch('/__state')).json();
          return state.tests.length === 1 && state.saves.length === 1;
        });
        const after = await stateOn(page);
        assert.deepEqual(after.tests[0].body, {
          url: 'https://fixture.invalid/edit', username: 'edit-user', password: '', account_id: 'fixture-account-a',
        });
        assert.equal(after.saves[0].path, '/api/calendar/config/accounts/fixture-account-a');
        result.cases.explicitSavedEditBlankPassword = {
          observed: 'explicit account id preserved saved-edit fallback',
          test: after.tests[0].body,
          savePath: after.saves[0].path,
        };
      } finally { await closeContext(context); }
    }

    // Ordinary Test+Save path remains a positive control with identical tested/saved values.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        await openAccount(page, 'fixture-account-a');
        await fillAccount(page, 'Normal control', 'https://fixture.invalid/normal', 'normal-user', 'normal-password');
        await page.locator('#uf-caldav-save').click();
        await page.waitForFunction(async () => {
          const state = await (await fetch('/__state')).json();
          return state.tests.length === 1 && state.saves.length === 1;
        });
        const finalState = await stateOn(page);
        assert.deepEqual(finalState.tests[0].body, {
          url: 'https://fixture.invalid/normal', username: 'normal-user', password: 'normal-password',
        });
        assert.deepEqual(finalState.saves[0].body, {
          label: 'Normal control', url: 'https://fixture.invalid/normal', username: 'normal-user', password: 'normal-password',
        });
        assert.equal(finalState.saves[0].path, '/api/calendar/config/accounts/fixture-account-a');
        result.cases.normalTestSave = { observed: 'tested and saved same values', test: finalState.tests[0].body, save: finalState.saves[0] };
      } finally { await closeContext(context); }
    }
    // A delayed API preset response must not replace a newer CalDAV form.
    {
      const { page, context } = await newPage();
      try {
        await resetState(page);
        const presetReads = await page.evaluate(() => window.__apiPresetsFetchResolved);
        const presetJson = await page.evaluate(() => window.__apiPresetsJsonConsumed);
        await page.request.get(`${origin}/__hold-next-presets`);
        await page.locator('.intg-card[data-intg-id="fixture-api"]').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pendingPresets.length === 1);
        await openAccount(page, 'fixture-account-b');
        await fillAccount(page, 'B draft survives', 'https://fixture.invalid/b-draft', 'b-draft-user', 'b-draft-password');
        await page.evaluate(() => { window.__expectedCalDavRoot = document.querySelector('#uf-caldav-url').closest('.admin-card'); });
        const beforeRelease = await page.evaluate(() => ({
          activeType: document.querySelector('.intg-card-active')?.dataset.intgType,
          activeId: document.querySelector('.intg-card-active')?.dataset.intgId,
          visible: getComputedStyle(document.querySelector('#unified-intg-form')).display !== 'none',
          apiFormPainted: !!document.querySelector('#uf-api-name'),
          url: document.querySelector('#uf-caldav-url')?.value,
          label: document.querySelector('#uf-caldav-label')?.value,
          rootConnected: window.__expectedCalDavRoot?.isConnected,
        }));
        assert.deepEqual(beforeRelease, {
          activeType: 'caldav', activeId: 'fixture-account-b', visible: true,
          apiFormPainted: false, url: 'https://fixture.invalid/b-draft',
          label: 'B draft survives', rootConnected: true,
        });
        await page.request.get(`${origin}/__release-presets`);
        await page.waitForFunction(count => window.__apiPresetsFetchResolved === count + 1, presetReads);
        await page.waitForFunction(count => window.__apiPresetsJsonConsumed === count + 1, presetJson);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const afterRelease = await page.evaluate(() => ({
          activeType: document.querySelector('.intg-card-active')?.dataset.intgType,
          activeId: document.querySelector('.intg-card-active')?.dataset.intgId,
          visible: getComputedStyle(document.querySelector('#unified-intg-form')).display !== 'none',
          apiFormPainted: !!document.querySelector('#uf-api-name'),
          url: document.querySelector('#uf-caldav-url')?.value,
          label: document.querySelector('#uf-caldav-label')?.value,
          rootSameAndConnected: window.__expectedCalDavRoot === document.querySelector('#uf-caldav-url')?.closest('.admin-card') && window.__expectedCalDavRoot.isConnected,
        }));
        assert.deepEqual(afterRelease, {
          activeType: 'caldav', activeId: 'fixture-account-b', visible: true,
          apiFormPainted: false, url: 'https://fixture.invalid/b-draft',
          label: 'B draft survives', rootSameAndConnected: true,
        }, 'stale API presets must not replace the newer CalDAV draft');
        result.cases.heldApiPresetsThenCalDavBDraft = { beforeRelease, afterRelease, stalePresetResponseConsumed: true };
      } finally { await closeContext(context); }
    }

    // A still-current API intent must not paint after Cancel hides the shared form.
    {
      const { page, context } = await newPage();
      try {
        await openAccount(page, 'fixture-account-b');
        const presetReads = await page.evaluate(() => window.__apiPresetsFetchResolved);
        const presetJson = await page.evaluate(() => window.__apiPresetsJsonConsumed);
        await page.request.get(`${origin}/__hold-next-presets`);
        await page.locator('.intg-card[data-intg-id="fixture-api"]').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pendingPresets.length === 1);
        await page.locator('#uf-caldav-cancel').click();
        assert.equal(await page.locator('#unified-intg-form').isVisible(), false);
        await page.request.get(`${origin}/__release-presets`);
        await page.waitForFunction(count => window.__apiPresetsFetchResolved === count + 1, presetReads);
        await page.waitForFunction(count => window.__apiPresetsJsonConsumed === count + 1, presetJson);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const afterCancel = await page.evaluate(() => ({
          visible: getComputedStyle(document.querySelector('#unified-intg-form')).display !== 'none',
          apiFormPainted: !!document.querySelector('#uf-api-name'),
          caldavRootConnected: !!document.querySelector('#uf-caldav-url')?.isConnected,
        }));
        assert.deepEqual(afterCancel, { visible: false, apiFormPainted: false, caldavRootConnected: true });
        result.cases.cancelledPriorFormThenApiPresets = { afterCancel, stalePresetResponseConsumed: true };
      } finally { await closeContext(context); }
    }

    // The same API preset flow still opens normally when its selection remains current.
    {
      const { page, context } = await newPage();
      try {
        await page.locator('.intg-card[data-intg-id="fixture-api"]').click();
        await page.locator('#uf-api-name').waitFor();
        result.cases.normalApiPresetLoad = {
          apiFormPainted: true,
          visible: await page.locator('#unified-intg-form').isVisible(),
          presetCount: await page.locator('#uf-api-preset option').count(),
        };
        assert.equal(result.cases.normalApiPresetLoad.visible, true);
      } finally { await closeContext(context); }
    }

    assert.deepEqual(result.externalRequests, [], 'no non-fixture request was allowed');
    assert.deepEqual(result.pageErrors, [], 'actual settings module raised no browser errors');
    result.pass = true;
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    for (const item of state.pending.splice(0)) json(item.res, { ok: false, error: 'fixture cleanup' });
    for (const item of state.pendingAccounts.splice(0)) json(item.res, { accounts });
    for (const item of state.pendingSaves.splice(0)) json(item.res, { ok: false, error: 'fixture cleanup' }, 503);
    if (server.closeAllConnections) server.closeAllConnections();
    if (browser) await browser.close().catch(() => {});
    await new Promise(resolve => server.close(() => resolve())).catch(() => {});
  }
})();
