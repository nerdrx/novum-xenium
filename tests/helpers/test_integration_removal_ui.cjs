'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const settingsPath = path.join(repo, 'static/js/settings.js');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(settingsPath)).digest('hex');
const accounts = [
  { id: 'fixture-account-a', label: 'Calendar A', url: 'https://fixture.invalid/a', username: 'user-a' },
  { id: 'fixture-account-b', label: 'Calendar B', url: 'https://fixture.invalid/b', username: 'user-b' },
];
const initialAccounts = accounts.map(row => ({ ...row }));
const state = { deletes: [], reads: 0, changes: 0, mode: 'success', pending: null };
const bodyData = {
  '/api/auth/integrations': { integrations: [] },
  '/api/contacts/config': {},
  '/api/contacts/list': { contacts: [], count: 0 },
  '/api/email/accounts': { accounts: [] },
  '/api/mcp/servers': [],
  '/api/vault/config': {},
  '/api/tokens': [],
  '/api/calendar/calendars': { calendars: [] },
};
let networkFailDelete = false;
let networkFailureAttempts = 0;
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const pageHtml = `<!doctype html><meta charset="utf-8"><body>
<div id="unified-integrations-list"></div><div id="unified-intg-form" style="display:none"></div>
<div><button id="unified-intg-add-btn" type="button">Add</button></div>
<div id="toast" role="status" aria-live="polite"></div>
<script>window.confirmResult=true;window.confirmCalls=0;window.changes=0;
window.addEventListener('odysseus-integrations-changed',()=>window.changes++);</script>
<script type="module">import settings from '/static/js/settings.js';
window.styledConfirm=async()=>{window.confirmCalls++;return window.confirmResult};
await settings.initUnifiedIntegrations();window.ready=true;</script>
</body>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') return res.end(pageHtml);
  if (url.pathname === '/__state') return json(res, {
    deletes: state.deletes,
    reads: state.reads,
    changes: state.changes,
    pending: !!state.pending,
    accountIds: accounts.map(row => row.id),
  });
  if (url.pathname === '/__reset') {
    if (state.pending) return json(res, { ok: false }, 409);
    accounts.splice(0, accounts.length, ...initialAccounts.map(row => ({ ...row })));
    state.deletes.length = 0;
    state.reads = 0;
    state.changes = 0;
    state.mode = 'success';
    return json(res, { ok: true });
  }
  if (url.pathname === '/__mode') {
    state.mode = url.searchParams.get('value') || 'success';
    return json(res, { ok: true });
  }
  if (url.pathname === '/__release-delete') {
    if (!state.pending) return json(res, { ok: false }, 409);
    const { res: held } = state.pending;
    state.pending = null;
    accounts.splice(accounts.findIndex(row => row.id === 'fixture-account-a'), 1);
    json(held, { ok: true });
    return json(res, { ok: true });
  }
  if (url.pathname === '/api/calendar/config/accounts' && req.method === 'GET') {
    state.reads++;
    return json(res, { accounts });
  }
  if (url.pathname.startsWith('/api/calendar/config/accounts/') && req.method === 'DELETE') {
    state.deletes.push(url.pathname);
    if (state.mode === 'network') return req.socket.destroy();
    if (state.mode === 'hold') { state.pending = { res }; return; }
    if (state.mode === '503') return json(res, { detail: 'Synthetic removal refused' }, 503);
    accounts.splice(accounts.findIndex(row => row.id === url.pathname.split('/').pop()), 1);
    return json(res, { ok: true });
  }
  if (url.pathname === '/api/tasks/notification-logs' && req.method === 'POST') return json(res, { ok: true });
  if (url.pathname in bodyData) return json(res, bodyData[url.pathname]);
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
  const proof = { source: { file: 'static/js/settings.js', sha256: sourceHash }, externalRequests: [], pageErrors: [], cases: {} };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
    const newPage = async () => {
      const resetResponse = await fetch(`${origin}/__reset`);
      assert.equal(resetResponse.status, 200);
      const page = await browser.newPage();
      page.setDefaultTimeout(7000);
      await page.route('**/*', route => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:') {
          if (requestUrl.origin !== origin) { proof.externalRequests.push(requestUrl.href); return route.abort(); }
        }
        if (networkFailDelete && route.request().method() === 'DELETE'
          && requestUrl.pathname === '/api/calendar/config/accounts/fixture-account-a') {
          networkFailureAttempts++;
          return route.abort('failed');
        }
        return route.continue();
      });
      page.on('pageerror', error => proof.pageErrors.push(error.stack || error.message));
      await page.goto(origin);
      await page.waitForFunction(() => window.ready);
      await page.locator('.intg-card[data-intg-type="caldav"]').first().waitFor();
      return page;
    };
    const reset = async page => {
      const res = await page.request.get(`${origin}/__reset`);
      assert.equal(res.status(), 200);
    };
    const stateOn = page => page.evaluate(async () => ({ ...(await (await fetch('/__state')).json()), changes: window.changes }));
    const openA = async page => {
      await page.locator('.intg-card[data-intg-id="fixture-account-a"]').click();
      await page.waitForFunction(() => document.querySelector('#uf-caldav-url')?.value === 'https://fixture.invalid/a');
    };
    const closePage = page => page.close().catch(() => {});

    // A non-2xx removal must preserve the open form and draft, without refreshing or emitting success.
    {
      const page = await newPage();
      try {
        await reset(page); await openA(page);
        await page.locator('#uf-caldav-label').fill('Unsaved draft');
        const baseline = await stateOn(page);
        await page.request.get(`${origin}/__mode?value=503`);
        await page.locator('.intg-del-btn[data-intg-id="fixture-account-a"]').click();
        await page.waitForFunction(() => window.changes > 0 || document.querySelector('#toast')?.classList.contains('show'));
        const after = await stateOn(page);
        const message = await page.evaluate(() => document.querySelector('#toast .toast-message')?.textContent ?? null);
        assert.equal(after.deletes.length, 1, JSON.stringify(after));
        assert.equal(after.changes, 0, 'failed DELETE must not emit the integrations-changed event');
        assert.equal(after.reads, baseline.reads, 'failed DELETE must not refresh the list');
        assert.equal(await page.locator('#unified-intg-form').isVisible(), true);
        assert.equal(await page.locator('#uf-caldav-label').inputValue(), 'Unsaved draft');
        assert.equal(message, 'Could not remove integration. Try again.');
        assert.equal(await page.locator('#toast').getAttribute('aria-live'), 'polite');
        proof.cases.http503 = { status: 503, deletions: after.deletes.length, refreshed: after.reads > baseline.reads, changes: after.changes, formVisible: true, draft: 'Unsaved draft', toast: message };
      } finally { await closePage(page); }
    }

    // Network rejection follows the same failure path and keeps the draft intact.
    {
      const page = await newPage();
      try {
        await reset(page); await openA(page);
        await page.locator('#uf-caldav-label').fill('Network draft');
        networkFailureAttempts = 0;
        networkFailDelete = true;
        await page.locator('.intg-del-btn[data-intg-id="fixture-account-a"]').click();
        await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('show'));
        networkFailDelete = false;
        const after = await stateOn(page);
        assert.equal(networkFailureAttempts, 1);
        assert.equal(after.deletes.length, 0, 'aborted network request never reached the fake server');
        assert.equal(after.changes, 0);
        assert.equal(await page.locator('#unified-intg-form').isVisible(), true);
        assert.equal(await page.locator('#uf-caldav-label').inputValue(), 'Network draft');
        proof.cases.networkFailure = { attempts: networkFailureAttempts, serverDeletes: after.deletes.length, changes: after.changes, formVisible: true, draft: 'Network draft', toast: await page.locator('#toast .toast-message').textContent() };
      } finally { await closePage(page); }
    }

    // Confirm cancellation never calls the endpoint or refreshes/notifies.
    {
      const page = await newPage();
      try {
        await reset(page); await openA(page);
        await page.locator('#uf-caldav-label').fill('Canceled draft');
        await page.evaluate(() => { window.confirmResult = false; });
        const before = await stateOn(page);
        await page.locator('.intg-del-btn[data-intg-id="fixture-account-a"]').click();
        await page.waitForFunction(() => window.confirmCalls === 1);
        const after = await stateOn(page);
        assert.equal(after.deletes.length, 0);
        assert.equal(after.reads, before.reads);
        assert.equal(after.changes, 0);
        assert.equal(await page.locator('#unified-intg-form').isVisible(), true);
        assert.equal(await page.locator('#uf-caldav-label').inputValue(), 'Canceled draft');
        proof.cases.confirmCanceled = { confirmCalls: 1, deletions: after.deletes.length, changes: after.changes, formVisible: true, draft: 'Canceled draft' };
      } finally { await closePage(page); }
    }

    // Successful DELETE refreshes and notifies, but does not close a form selected while it waited.
    {
      const page = await newPage();
      try {
        await reset(page); await openA(page);
        const before = await stateOn(page);
        await page.request.get(`${origin}/__mode?value=hold`);
        await page.locator('.intg-del-btn[data-intg-id="fixture-account-a"]').click();
        await page.waitForFunction(async () => (await (await fetch('/__state')).json()).pending);
        await page.locator('.intg-card[data-intg-id="fixture-account-b"]').click();
        await page.waitForFunction(() => document.querySelector('#uf-caldav-url')?.value === 'https://fixture.invalid/b');
        await page.locator('#uf-caldav-label').fill('B remains open');
        await page.request.get(`${origin}/__release-delete`);
        await page.waitForFunction(() => window.changes === 1);
        await page.waitForFunction(async count => (await (await fetch('/__state')).json()).reads > count, before.reads);
        assert.equal(await page.locator('#unified-intg-form').isVisible(), true, 'late removal must keep the newer form visible');
        assert.equal(await page.locator('#uf-caldav-url').inputValue(), 'https://fixture.invalid/b');
        assert.equal(await page.locator('#uf-caldav-label').inputValue(), 'B remains open');
        assert.equal((await stateOn(page)).accountIds.includes('fixture-account-a'), false);
        proof.cases.successAndNewerForm = { deletions: 1, changes: await page.evaluate(() => window.changes), formVisible: true, selectedUrl: 'https://fixture.invalid/b', refreshed: true };
      } finally { await closePage(page); }
    }

    // Ordinary success closes the same form after refreshing/removal.
    {
      const page = await newPage();
      try {
        await reset(page); await openA(page);
        const before = await stateOn(page);
        await page.locator('.intg-del-btn[data-intg-id="fixture-account-a"]').click();
        await page.waitForFunction(() => window.changes === 1);
        await page.waitForFunction(async count => (await (await fetch('/__state')).json()).reads > count, before.reads);
        const after = await stateOn(page);
        assert.equal(after.deletes.length, 1);
        assert.equal(after.changes, 1);
        assert.equal(await page.locator('#unified-intg-form').isVisible(), false);
        assert.equal(await page.locator('.intg-card[data-intg-id="fixture-account-a"]').count(), 0);
        proof.cases.success = { deletions: after.deletes.length, changes: after.changes, refreshed: true, formVisible: false, removedCardCount: 0 };
      } finally { await closePage(page); }
    }

    assert.deepEqual(proof.externalRequests, []);
    assert.deepEqual(proof.pageErrors, []);
    proof.pass = true;
    process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    if (state.pending) { json(state.pending.res, { ok: true }); state.pending = null; }
    if (server.closeAllConnections) server.closeAllConnections();
    if (browser) await browser.close().catch(() => {});
    await new Promise(resolve => server.close(() => resolve())).catch(() => {});
  }
})();
