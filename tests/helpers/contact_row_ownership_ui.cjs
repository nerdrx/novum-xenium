'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(process.env.CONTACTS_REPO || path.resolve(__dirname, '../..'));
const settingsPath = path.join(repo, 'static/js/settings.js');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(settingsPath)).digest('hex');
const sourceCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const initialContacts = () => [
  { uid: 'fixture-a', name: 'Fixture A', emails: ['a@example.invalid'], phones: [], address: '' },
  { uid: 'fixture-b', name: 'Fixture B', emails: ['b@example.invalid'], phones: [], address: '' },
];
let holdSave = false;
let releaseSave;
let holdDelete = false;
let releaseDelete;
let holdAdd = false;
let releaseAdd;
let holdImport = false;
let releaseImport;
let holdRefresh = false;
let releaseRefresh;
let saveFailure = false;
let deleteFailure = false;
const state = { contacts: initialContacts(), writes: [], deletes: [], adds: [], imports: [], listReads: 0, heldSave: 0, heldDelete: 0, heldAdd: 0, heldImport: 0, heldRefresh: 0 };
const pageHtml = `<!doctype html><meta charset="utf-8"><body>
<div id="unified-integrations-list"></div><div id="unified-intg-form" style="display:none"></div>
<div><button id="unified-intg-add-btn" type="button">Add</button></div>
<div id="toast" role="status" aria-live="polite"></div>
<script type="module">import settings from '/static/js/settings.js'; await settings.initUnifiedIntegrations(); window.fixtureReady=true;</script>
</body>`;
const json = (res, value, status=200) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageHtml);
    }
    if (u.pathname === '/__state') return json(res, {
      contacts: state.contacts.map(c => ({ ...c })), writes: state.writes, deletes: state.deletes, adds: state.adds, imports: state.imports,
      listReads: state.listReads, heldSave: state.heldSave, heldDelete: state.heldDelete, heldAdd: state.heldAdd, heldImport: state.heldImport, heldRefresh: state.heldRefresh,
    });
    if (u.pathname === '/__release-save') { releaseSave?.(); releaseSave = null; return json(res, { ok: true }); }
    if (u.pathname === '/__release-delete') { releaseDelete?.(); releaseDelete = null; return json(res, { ok: true }); }
    if (u.pathname === '/__release-add') { releaseAdd?.(); releaseAdd = null; return json(res, { ok: true }); }
    if (u.pathname === '/__release-import') { releaseImport?.(); releaseImport = null; return json(res, { ok: true }); }
    if (u.pathname === '/__release-refresh') { releaseRefresh?.(); releaseRefresh = null; return json(res, { ok: true }); }
    if (u.pathname === '/api/tasks/notification-logs' && req.method === 'POST') { req.resume(); return json(res, { ok: true }); }
    if (u.pathname === '/api/auth/integrations') return json(res, { integrations: [] });
    if (u.pathname === '/api/calendar/config/accounts') return json(res, { accounts: [] });
    if (u.pathname === '/api/calendar/calendars') return json(res, { calendars: [] });
    if (u.pathname === '/api/contacts/config') return json(res, {});
    if (u.pathname === '/api/email/accounts') return json(res, { accounts: [] });
    if (u.pathname === '/api/mcp/servers' || u.pathname === '/api/tokens') return json(res, []);
    if (u.pathname === '/api/vault/config') return json(res, {});
    if (u.pathname === '/api/contacts/list' && req.method === 'GET') {
      state.listReads++;
      if (holdRefresh) {
        holdRefresh = false;
        state.heldRefresh = state.listReads;
        await new Promise(resolve => { releaseRefresh = resolve; });
      }
      return json(res, { contacts: state.contacts.map(c => ({ ...c })), count: state.contacts.length });
    }
    if (u.pathname === '/api/contacts/add' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      state.adds.push(body);
      state.contacts.push({ uid: `fixture-added-${state.adds.length}`, name: body.name, emails: body.email ? [body.email] : [], phones: body.phone ? [body.phone] : [], address: body.address || '' });
      if (holdAdd) { holdAdd = false; state.heldAdd = state.adds.length; await new Promise(resolve => { releaseAdd = resolve; }); }
      return json(res, { success: true });
    }
    if (u.pathname === '/api/contacts/import' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      state.imports.push(body);
      state.contacts.push({ uid: `fixture-imported-${state.imports.length}`, name: 'Fixture Imported', emails: ['imported@example.invalid'], phones: [], address: '' });
      if (holdImport) { holdImport = false; state.heldImport = state.imports.length; await new Promise(resolve => { releaseImport = resolve; }); }
      return json(res, { success: true, imported: 1, total: 1, failed: 0 });
    }
    const match = u.pathname.match(/^\/api\/contacts\/([^/]+)$/);
    if (match && req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const contact = state.contacts.find(c => c.uid === decodeURIComponent(match[1]));
      if (!contact) return json(res, { success: false }, 404);
      const status = saveFailure ? 503 : 200;
      state.writes.push({ uid: contact.uid, body, status });
      if (status === 200) Object.assign(contact, body);
      if (holdSave) {
        holdSave = false;
        state.heldSave = state.writes.length;
        await new Promise(resolve => { releaseSave = resolve; });
      }
      return json(res, status === 200 ? { success: true } : { detail: 'synthetic save failure' }, status);
    }
    if (match && req.method === 'DELETE') {
      const contact = state.contacts.find(c => c.uid === decodeURIComponent(match[1]));
      const status = deleteFailure ? 503 : 200;
      state.deletes.push({ uid: decodeURIComponent(match[1]), status });
      if (status === 200) state.contacts = state.contacts.filter(c => c.uid !== decodeURIComponent(match[1]));
      if (holdDelete) {
        holdDelete = false;
        state.heldDelete = state.deletes.length;
        await new Promise(resolve => { releaseDelete = resolve; });
      }
      return json(res, status === 200 ? { success: true } : { detail: contact ? 'synthetic delete failure' : 'missing contact' }, status);
    }
    const file = path.resolve(repo, `.${decodeURIComponent(u.pathname)}`);
    if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  } catch (_) {
    if (!res.headersSent) res.writeHead(500);
    res.end('fixture error');
  }
});

(async () => {
  let browser;
  const pageErrors = [], externalRequests = [];
  const proof = { scope: 'actual Settings module public Contacts Manager UI; synthetic loopback only', source: { repo, commit: sourceCommit, file: 'static/js/settings.js', sha256: sourceHash }, cases: {}, pageErrors, externalRequests };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu'] });
    const newPage = async () => {
      const page = await browser.newPage();
      page.setDefaultTimeout(7000);
      await page.addInitScript(() => {
        const watched = new Set();
        window.__proofResponses = [];
        window.__watchProofResponse = (method, pathname) => watched.add(`${method.toUpperCase()} ${pathname}`);
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const requestUrl = new URL(typeof input === 'string' ? input : input.url, location.href);
          const method = String(init?.method || input?.method || 'GET').toUpperCase();
          const key = `${method} ${requestUrl.pathname}`;
          const observe = watched.delete(key);
          const pending = nativeFetch(input, init);
          if (observe) pending.then(response => response.clone().json().then(
            body => window.__proofResponses.push({ key, status: response.status, body }),
            error => window.__proofResponses.push({ key, status: response.status, error: String(error) }),
          ));
          return pending;
        };
      });
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (['http:', 'https:'].includes(u.protocol) && u.origin !== origin) {
          externalRequests.push(u.href);
          return route.abort();
        }
        return route.continue();
      });
      page.on('pageerror', error => pageErrors.push(error.stack || error.message));
      await page.goto(origin);
      await page.waitForFunction(() => window.fixtureReady);
      return page;
    };
    const stateOn = page => page.evaluate(async () => await (await fetch('/__state')).json());
    const release = async (page, route) => {
      const response = await page.request.get(`${origin}${route}`);
      assert.equal(response.status(), 200);
    };
    const openManager = async (page, requireA = true) => {
      await page.locator('#unified-intg-add-btn').click();
      await page.locator('.uf-type-option[data-value="carddav"]').click();
      if (requireA) await page.locator('.contact-row[data-uid="fixture-a"] .contact-edit').waitFor();
      await page.locator('.contact-row[data-uid="fixture-b"] .contact-edit').waitFor();
    };
    const reopenManager = async (page, requireA = true) => {
      await page.locator('#uf-carddav-cancel').click();
      await page.waitForFunction(() => document.querySelector('#unified-intg-form')?.style.display === 'none');
      await openManager(page, requireA);
    };
    const twoFrames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const observeResponse = async (page, method, pathname) => {
      const key = `${method.toUpperCase()} ${pathname}`;
      await page.evaluate(([m, p]) => window.__watchProofResponse(m, p), [method, pathname]);
      await page.waitForFunction(k => window.__proofResponses.some(item => item.key === k), key);
      return page.evaluate(k => window.__proofResponses.find(item => item.key === k), key);
    };
    const fresh = () => {
      state.contacts = initialContacts(); state.writes = []; state.deletes = []; state.listReads = 0;
      state.adds = []; state.imports = []; state.heldAdd = 0; state.heldImport = 0;
      state.heldSave = 0; state.heldDelete = 0; state.heldRefresh = 0;
      holdSave = false; holdDelete = false; holdAdd = false; holdImport = false; holdRefresh = false;
      saveFailure = false; deleteFailure = false;
      releaseSave = null; releaseDelete = null; releaseAdd = null; releaseImport = null; releaseRefresh = null;
    };

    // Normal success and failure controls: saves stay in the active editor on
    // failure and an owned retry saves and refreshes the row.
    fresh();
    {
      const page = await newPage(); await openManager(page);
      const readsBeforeFailure = (await stateOn(page)).listReads;
      await page.locator('.contact-row[data-uid="fixture-a"] .contact-edit').click();
      await page.locator('.contact-row[data-uid="fixture-a"] .contact-edit-name').fill('A draft retained');
      saveFailure = true;
      await page.locator('.contact-row[data-uid="fixture-a"] .contact-save').click();
      await page.locator('#toast .toast-message').filter({ hasText: 'Could not save contact. Try again.' }).waitFor({ state: 'visible' });
      await twoFrames(page);
      assert.equal(await page.locator('.contact-row[data-uid="fixture-a"] .contact-edit-name').inputValue(), 'A draft retained');
      assert.equal((await stateOn(page)).listReads, readsBeforeFailure, 'failed save must not refresh the row list');
      saveFailure = false;
      const oldRow = await page.locator('.contact-row[data-uid="fixture-a"]').evaluateHandle(node => node);
      await page.evaluate(() => window.__watchProofResponse('PUT', '/api/contacts/fixture-a'));
      await page.locator('.contact-row[data-uid="fixture-a"] .contact-save').click();
      const goodResponse = await observeResponse(page, 'PUT', '/api/contacts/fixture-a');
      await page.waitForFunction(node => !node.isConnected, oldRow);
      assert.equal(await page.locator('.contact-name').first().textContent(), 'A draft retained');
      const snapshot = await stateOn(page);
      proof.cases.ownedSaveControls = { failedStatus: 503, failedDraftRetained: true, successfulStatus: goodResponse.status, savedName: snapshot.contacts[0].name, listReads: snapshot.listReads };
      await page.close();
    }

    // A newer draft in the same Add form remains intact when its accepted
    // earlier snapshot completes; this preserves the existing Add semantics.
    fresh();
    {
      const page = await newPage(); await openManager(page);
      await page.locator('#cm-add-toggle').click();
      await page.locator('#cm-add-name').fill('First accepted Add');
      await page.locator('#cm-add-email').fill('first@example.invalid');
      holdAdd = true;
      await page.evaluate(() => window.__watchProofResponse('POST', '/api/contacts/add'));
      await page.locator('#cm-add-save').click();
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).heldAdd === 1);
      await page.locator('#cm-add-name').fill('Newer Add draft');
      await page.locator('#cm-add-email').fill('newer@example.invalid');
      await release(page, '/__release-add');
      const response = await observeResponse(page, 'POST', '/api/contacts/add');
      await twoFrames(page);
      const snapshot = await stateOn(page);
      const draft = await page.evaluate(() => ({
        name: document.querySelector('#cm-add-name')?.value,
        email: document.querySelector('#cm-add-email')?.value,
        visible: document.querySelector('#cm-add-row')?.style.display === 'flex',
      }));
      proof.cases.addSameFormNewDraft = { status: response.status, acceptedName: snapshot.adds[0]?.name, newerDraftRetained: draft.name === 'Newer Add draft' && draft.email === 'newer@example.invalid' && draft.visible, draft };
      await page.close();
    }

    // Add accepted in manager A must not refresh over an unsaved edit in a
    // reopened manager B.
    fresh();
    {
      const page = await newPage(); await openManager(page);
      await page.locator('#cm-add-toggle').click();
      await page.locator('#cm-add-name').fill('Fixture added');
      await page.locator('#cm-add-email').fill('added@example.invalid');
      holdAdd = true;
      await page.evaluate(() => window.__watchProofResponse('POST', '/api/contacts/add'));
      await page.locator('#cm-add-save').click();
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).heldAdd === 1);
      await reopenManager(page);
      await page.locator('.contact-row[data-uid="fixture-b"] .contact-edit').click();
      await page.locator('.contact-row[data-uid="fixture-b"] .contact-edit-name').fill('Fixture B unsaved draft');
      holdRefresh = true;
      await page.evaluate(() => window.__watchProofResponse('GET', '/api/contacts/list'));
      await release(page, '/__release-add');
      const response = await observeResponse(page, 'POST', '/api/contacts/add'); await twoFrames(page);
      let snapshot = await stateOn(page);
      const refreshIssued = snapshot.heldRefresh > 0;
      let refreshBodyCompleted = false;
      if (refreshIssued) {
        await release(page, '/__release-refresh');
        const listResponse = await observeResponse(page, 'GET', '/api/contacts/list');
        assert.equal(listResponse.status, 200); await twoFrames(page); refreshBodyCompleted = true;
      }
      const after = await page.evaluate(() => {
        const input = document.querySelector('.contact-row[data-uid="fixture-b"] .contact-edit-name');
        return { editorPresent: !!input, editorVisible: !!input && input.checkVisibility(), value: input?.value ?? null };
      });
      snapshot = await stateOn(page);
      proof.cases.staleAddAfterReopen = { status: response.status, acceptedName: snapshot.adds[0]?.name, addedContactPresent: snapshot.contacts.some(c => c.uid === 'fixture-added-1'), refreshIssued, refreshBodyCompleted, draftPreserved: after.editorVisible && after.value === 'Fixture B unsaved draft', after };
      await page.close();
    }

    // Import uses the real file-input entrypoint; its completion must not
    // refresh a manager that has replaced the one that started the import.
    fresh();
    {
      const page = await newPage(); await openManager(page); holdImport = true;
      await page.evaluate(() => window.__watchProofResponse('POST', '/api/contacts/import'));
      await page.locator('#cm-import-file').setInputFiles({ name: 'fixture.vcf', mimeType: 'text/vcard', buffer: Buffer.from('BEGIN:VCARD\nVERSION:3.0\nFN:Fixture Imported\nEMAIL:imported@example.invalid\nEND:VCARD\n') });
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).heldImport === 1);
      await reopenManager(page);
      await page.locator('.contact-row[data-uid="fixture-b"] .contact-edit').click();
      await page.locator('.contact-row[data-uid="fixture-b"] .contact-edit-name').fill('Fixture B unsaved draft');
      holdRefresh = true;
      await page.evaluate(() => window.__watchProofResponse('GET', '/api/contacts/list'));
      await release(page, '/__release-import');
      const response = await observeResponse(page, 'POST', '/api/contacts/import'); await twoFrames(page);
      let snapshot = await stateOn(page);
      const refreshIssued = snapshot.heldRefresh > 0;
      let refreshBodyCompleted = false;
      if (refreshIssued) {
        await release(page, '/__release-refresh');
        const listResponse = await observeResponse(page, 'GET', '/api/contacts/list');
        assert.equal(listResponse.status, 200); await twoFrames(page); refreshBodyCompleted = true;
      }
      const after = await page.evaluate(() => {
        const input = document.querySelector('.contact-row[data-uid="fixture-b"] .contact-edit-name');
        return { editorPresent: !!input, editorVisible: !!input && input.checkVisibility(), value: input?.value ?? null };
      });
      snapshot = await stateOn(page);
      proof.cases.staleImportAfterReopen = { status: response.status, acceptedVcf: snapshot.imports[0]?.vcf, importedContactPresent: snapshot.contacts.some(c => c.uid === 'fixture-imported-1'), refreshIssued, refreshBodyCompleted, draftPreserved: after.editorVisible && after.value === 'Fixture B unsaved draft', after };
      await page.close();
    }

    // Save A response held while the same UI is replaced and B has a draft.
    fresh();
    {
      const page = await newPage(); await openManager(page);
      await page.locator('.contact-row[data-uid="fixture-a"] .contact-edit').click();
      await page.locator('.contact-row[data-uid="fixture-a"] .contact-edit-name').fill('Fixture A saved');
      holdSave = true;
      await page.evaluate(() => window.__watchProofResponse('PUT', '/api/contacts/fixture-a'));
      await page.locator('.contact-row[data-uid="fixture-a"] .contact-save').click();
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).heldSave === 1);
      await reopenManager(page);
      await page.locator('.contact-row[data-uid="fixture-b"] .contact-edit').click();
      await page.locator('.contact-row[data-uid="fixture-b"] .contact-edit-name').fill('Fixture B unsaved draft');
      holdRefresh = true;
      await page.evaluate(() => window.__watchProofResponse('GET', '/api/contacts/list'));
      await release(page, '/__release-save');
      const put = await observeResponse(page, 'PUT', '/api/contacts/fixture-a'); assert.equal(put.status, 200); await twoFrames(page);
      let snapshot = await stateOn(page);
      const sawRefresh = snapshot.heldRefresh > 0;
      let refreshCompleted = false;
      if (sawRefresh) {
        await release(page, '/__release-refresh');
        const response = await observeResponse(page, 'GET', '/api/contacts/list'); assert.equal(response.status, 200); await twoFrames(page);
        refreshCompleted = true;
      }
      const after = await page.evaluate(() => {
        const input = document.querySelector('.contact-row[data-uid="fixture-b"] .contact-edit-name');
        return { editorPresent: !!input, editorVisible: !!input && input.checkVisibility(), value: input?.value ?? null };
      });
      snapshot = await stateOn(page);
      proof.cases.staleSaveAfterReopen = {
        acceptedSaveStatus: put.status, savedA: snapshot.contacts.find(c => c.uid === 'fixture-a')?.name,
        staleRefreshIssued: sawRefresh, refreshBodyCompleted: refreshCompleted,
        draftPreserved: after.editorVisible && after.value === 'Fixture B unsaved draft', after,
      };
      await page.close();
    }

    // Accepted Delete confirmation must not dispatch after its original row
    // and list have been replaced by a different manager session.
    fresh();
    {
      const page = await newPage(); await openManager(page);
      const deleteRequests = [];
      page.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/contacts/fixture-a') deleteRequests.push(request.url()); });
      await page.locator('.contact-row[data-uid="fixture-a"] .contact-del').click();
      await page.locator('#styled-confirm-ok').waitFor({ state: 'visible' });
      // Use the actual form cancel listener while the confirmation is pending
      // to model the owning UI changing before the async confirm resolves.
      await page.locator('#uf-carddav-cancel').evaluate(button => button.click());
      await page.waitForFunction(() => document.querySelector('#unified-intg-form')?.style.display === 'none');
      await page.locator('#unified-intg-add-btn').evaluate(button => button.click());
      await page.locator('.uf-type-option[data-value="carddav"]').waitFor({ state: 'visible' });
      await page.locator('.uf-type-option[data-value="carddav"]').evaluate(button => button.click());
      await page.locator('.contact-row[data-uid="fixture-b"] .contact-edit').waitFor();
      await page.locator('#styled-confirm-ok').click();
      await twoFrames(page);
      const snapshot = await stateOn(page);
      proof.cases.confirmAcceptedAfterOwnerLost = { deleteRequests: deleteRequests.length, serverDeleteCount: snapshot.deletes.length, bRowStillPresent: await page.locator('.contact-row[data-uid="fixture-b"]').count() === 1 };
      await page.close();
    }

    // A successful Delete already sent from A may complete after B is opened;
    // its stale completion must not refresh away B's unsaved editor.
    fresh();
    {
      const page = await newPage(); await openManager(page);
      await page.locator('.contact-row[data-uid="fixture-a"] .contact-del').click();
      await page.locator('#styled-confirm-ok').waitFor({ state: 'visible' });
      holdDelete = true;
      await page.evaluate(() => window.__watchProofResponse('DELETE', '/api/contacts/fixture-a'));
      await page.locator('#styled-confirm-ok').click();
      await page.waitForFunction(async () => (await (await fetch('/__state')).json()).heldDelete === 1);
      await reopenManager(page, false);
      await page.locator('.contact-row[data-uid="fixture-b"] .contact-edit').click();
      await page.locator('.contact-row[data-uid="fixture-b"] .contact-edit-name').fill('Fixture B delete-race draft');
      holdRefresh = true;
      await page.evaluate(() => window.__watchProofResponse('GET', '/api/contacts/list'));
      await release(page, '/__release-delete');
      const response = await observeResponse(page, 'DELETE', '/api/contacts/fixture-a'); assert.equal(response.status, 200); await twoFrames(page);
      let snapshot = await stateOn(page);
      const sawRefresh = snapshot.heldRefresh > 0;
      let refreshCompleted = false;
      if (sawRefresh) {
        await release(page, '/__release-refresh');
        const refresh = await observeResponse(page, 'GET', '/api/contacts/list'); assert.equal(refresh.status, 200); await twoFrames(page);
        refreshCompleted = true;
      }
      const after = await page.evaluate(() => {
        const input = document.querySelector('.contact-row[data-uid="fixture-b"] .contact-edit-name');
        return { editorPresent: !!input, editorVisible: !!input && input.checkVisibility(), value: input?.value ?? null };
      });
      snapshot = await stateOn(page);
      proof.cases.staleDeleteAfterReopen = {
        acceptedDeleteStatus: response.status, deletedA: !snapshot.contacts.some(c => c.uid === 'fixture-a'),
        staleRefreshIssued: sawRefresh, refreshBodyCompleted: refreshCompleted,
        draftPreserved: after.editorVisible && after.value === 'Fixture B delete-race draft', after,
      };
      await page.close();
    }

    // Normal owned Delete remains functional and refreshes the current list.
    fresh();
    {
      const page = await newPage(); await openManager(page);
      await page.locator('.contact-row[data-uid="fixture-a"] .contact-del').click();
      await page.locator('#styled-confirm-ok').waitFor({ state: 'visible' });
      await page.evaluate(() => window.__watchProofResponse('DELETE', '/api/contacts/fixture-a'));
      await page.locator('#styled-confirm-ok').click();
      const response = await observeResponse(page, 'DELETE', '/api/contacts/fixture-a'); assert.equal(response.status, 200);
      await page.waitForFunction(() => !document.querySelector('.contact-row[data-uid="fixture-a"]'));
      const snapshot = await stateOn(page);
      proof.cases.ownedDeleteControl = { status: response.status, deletedA: !snapshot.contacts.some(c => c.uid === 'fixture-a'), bRowPresent: await page.locator('.contact-row[data-uid="fixture-b"]').count() === 1, listReads: snapshot.listReads };
      await page.close();
    }

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
    proof.pass = true;
    process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    releaseSave?.(); releaseDelete?.(); releaseAdd?.(); releaseImport?.(); releaseRefresh?.();
    if (browser) await browser.close().catch(() => {});
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve())).catch(() => {});
  }
})();
