const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const held = new Map();
const requests = [];
let defaultCount = 0;
let browser;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><button id="workspace-indicator-btn"><span id="workspace-indicator-name"></span></button><div id="overflow-workspace-btn"></div><div id="toast"></div><script type="module">import workspace from "/static/js/workspace.js";window.workspace=workspace;window.ready=true;</script>');
  }
  if (url.pathname === '/__state') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ requests, defaultCount }));
  }
  if (url.pathname === '/__release') {
    const key = url.searchParams.get('key');
    const response = held.get(key);
    if (!response) return res.writeHead(404).end();
    held.delete(key);
    const ok = url.searchParams.get('ok') === 'true';
    response.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(ok ? { ok: true, path: `/canonical/${key}` } : { ok: false, path: null }));
    return res.writeHead(204).end();
  }
  if (url.pathname === '/api/tasks/notification-logs') return res.writeHead(204).end();
  if (url.pathname === '/api/workspace/vet') {
    const key = url.searchParams.get('path');
    requests.push(key);
    held.set(key, res);
    return;
  }
  if (url.pathname === '/api/workspace/default') {
    const key = `default-${++defaultCount}`;
    held.set(key, res);
    return;
  }
  if (url.pathname.startsWith('/static/')) {
    const file = path.resolve(repo, `.${url.pathname}`);
    if (!file.startsWith(path.join(repo, 'static') + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
    return res.end(fs.readFileSync(file));
  }
  res.writeHead(404).end();
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function state() { return (await (await fetch(`${origin}/__state`)).json()); }
let origin;
async function waitUntil(predicate) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    const value = await state();
    if (predicate(value)) return value;
    await delay(10);
  }
  throw new Error('timed out waiting for synthetic request');
}
async function release(key, ok) {
  const response = await fetch(`${origin}/__release?key=${encodeURIComponent(key)}&ok=${ok}`);
  assert.equal(response.status, 204, `held response missing: ${key}`);
}
function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}
(async () => {
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  const nonLoopback = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin)) nonLoopback.push(request.url()); });
  await page.goto(origin);
  await page.waitForFunction(() => window.ready && !!window.workspace);

  await page.evaluate(() => window.workspace.setWorkspace('/synthetic/seed-clear'));
  await page.evaluate(() => { window.__clearVet = window.workspace.vetAndSetWorkspace('/synthetic/A-clear'); });
  await waitUntil(s => s.requests.includes('/synthetic/A-clear'));
  await page.evaluate(() => window.workspace.clearWorkspace());
  assert.equal(await page.evaluate(() => localStorage.getItem('odysseus-workspace')), '');
  await release('/synthetic/A-clear', true);
  const clearResult = await page.evaluate(async () => ({ result: await window.__clearVet, stored: localStorage.getItem('odysseus-workspace') }));
  assert.equal(clearResult.stored, '', 'late vet must not undo explicit clear');
  assert.equal(clearResult.result.stale, true);

  await page.evaluate(() => window.workspace.setWorkspace('/synthetic/seed-overlap'));
  await page.evaluate(() => {
    window.__oldVet = window.workspace.vetAndSetWorkspace('/synthetic/old-A');
    window.__newVet = window.workspace.vetAndSetWorkspace('/synthetic/new-B');
  });
  await waitUntil(s => s.requests.includes('/synthetic/old-A') && s.requests.includes('/synthetic/new-B'));
  await release('/synthetic/new-B', true);
  const newVet = await page.evaluate(async () => ({ result: await window.__newVet, stored: localStorage.getItem('odysseus-workspace') }));
  await release('/synthetic/old-A', true);
  const oldVet = await page.evaluate(async () => ({ result: await window.__oldVet, stored: localStorage.getItem('odysseus-workspace') }));
  assert.equal(newVet.stored, '/canonical//synthetic/new-B');
  assert.equal(oldVet.stored, newVet.stored, 'older vet cannot overwrite latest request intent');
  assert.equal(oldVet.result.stale, true);

  await page.evaluate(() => window.workspace.setWorkspace('/synthetic/seed-direct'));
  await page.evaluate(() => { window.__directVet = window.workspace.vetAndSetWorkspace('/synthetic/direct-old'); });
  await waitUntil(s => s.requests.includes('/synthetic/direct-old'));
  await page.evaluate(() => window.workspace.setWorkspace('/synthetic/new-direct-choice'));
  await release('/synthetic/direct-old', true);
  const direct = await page.evaluate(async () => ({ result: await window.__directVet, stored: localStorage.getItem('odysseus-workspace') }));
  assert.equal(direct.stored, '/synthetic/new-direct-choice');
  assert.equal(direct.result.stale, true);

  // A default request made stale by a newer vet must not be cached as loaded.
  await page.evaluate(() => {
    localStorage.removeItem('odysseus-workspace');
    window.__defaultDuringVet = window.workspace.loadDefaultWorkspace();
    window.__vetDuringDefault = window.workspace.vetAndSetWorkspace('/synthetic/pending-explicit');
  });
  await waitUntil(s => s.defaultCount === 1 && s.requests.includes('/synthetic/pending-explicit'));
  await release('default-1', true);
  const defaultHeld = await page.evaluate(async () => ({ result: await window.__defaultDuringVet, stored: localStorage.getItem('odysseus-workspace') }));
  assert.equal(defaultHeld.stored, null, 'default must wait behind pending explicit vet intent');
  assert.equal(defaultHeld.result.ok, false);
  await release('/synthetic/pending-explicit', false);
  const failedVet = await page.evaluate(async () => window.__vetDuringDefault);
  assert.equal(failedVet.ok, false);
  await page.evaluate(() => { window.__defaultRetry = window.workspace.loadDefaultWorkspace(); });
  await waitUntil(s => s.defaultCount === 2);
  await release('default-2', true);
  const retriedDefault = await page.evaluate(async () => ({ result: await window.__defaultRetry, stored: localStorage.getItem('odysseus-workspace') }));
  assert.equal(retriedDefault.result.ok, true, 'stale default response must not cache the load as complete');
  assert.equal(retriedDefault.stored, '/canonical/default-2');

  // Also cover a default request started after a vet, when its revision is
  // current but the explicit choice is still pending.
  await page.reload();
  await page.waitForFunction(() => window.ready && !!window.workspace);
  await page.evaluate(() => {
    localStorage.removeItem('odysseus-workspace');
    window.__vetBeforeDefault = window.workspace.vetAndSetWorkspace('/synthetic/vet-before-default');
  });
  await waitUntil(s => s.requests.includes('/synthetic/vet-before-default'));
  await page.evaluate(() => { window.__defaultAfterVetStart = window.workspace.loadDefaultWorkspace(); });
  await waitUntil(s => s.defaultCount === 3);
  await release('default-3', true);
  const pendingVetDefault = await page.evaluate(async () => ({ result: await window.__defaultAfterVetStart, stored: localStorage.getItem('odysseus-workspace') }));
  assert.equal(pendingVetDefault.stored, null, 'default must not outrun an already pending vet');
  await release('/synthetic/vet-before-default', false);
  await page.evaluate(async () => { window.__vetBeforeDefaultResult = await window.__vetBeforeDefault; });
  await page.evaluate(() => { window.__defaultAfterVetRetry = window.workspace.loadDefaultWorkspace(); });
  await waitUntil(s => s.defaultCount === 4);
  await release('default-4', true);
  const retriedPendingDefault = await page.evaluate(async () => ({ result: await window.__defaultAfterVetRetry, stored: localStorage.getItem('odysseus-workspace') }));
  assert.equal(retriedPendingDefault.result.ok, true);
  assert.equal(retriedPendingDefault.stored, '/canonical/default-4');

  await page.reload();
  await page.waitForFunction(() => window.ready && !!window.workspace);
  await page.evaluate(() => {
    window.workspace.setWorkspace('/synthetic/storage-A');
    window.__nativeSetItem = Storage.prototype.setItem;
    window.__failWorkspaceWrites = true;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'odysseus-workspace' && window.__failWorkspaceWrites) throw new DOMException('synthetic quota failure', 'QuotaExceededError');
      return window.__nativeSetItem.call(this, key, value);
    };
  });
  const rejectedDirectWrite = await page.evaluate(() => {
    const ok = window.workspace.setWorkspace('/synthetic/storage-B');
    return { ok, stored: localStorage.getItem('odysseus-workspace'), getter: window.workspace.getWorkspace(), pill: document.getElementById('workspace-indicator-name').textContent };
  });
  assert.equal(rejectedDirectWrite.ok, false);
  assert.equal(rejectedDirectWrite.stored, '/synthetic/storage-A');
  assert.equal(rejectedDirectWrite.getter, '/synthetic/storage-A');
  assert.equal(rejectedDirectWrite.pill, 'storage-A');
  await page.evaluate(() => { window.__rejectedVet = window.workspace.vetAndSetWorkspace('/synthetic/storage-B'); });
  await waitUntil(s => s.requests.includes('/synthetic/storage-B'));
  await release('/synthetic/storage-B', true);
  const rejectedVet = await page.evaluate(async () => {
    const result = await window.__rejectedVet;
    return { ok: result.ok, storageError: result.storage_error, stored: localStorage.getItem('odysseus-workspace'), pill: document.getElementById('workspace-indicator-name').textContent };
  });
  assert.equal(rejectedVet.ok, false);
  assert.equal(rejectedVet.storageError, true);
  assert.equal(rejectedVet.stored, '/synthetic/storage-A');
  assert.equal(rejectedVet.pill, 'storage-A');
  const rejectedClear = await page.evaluate(() => ({ ok: window.workspace.clearWorkspace(), stored: localStorage.getItem('odysseus-workspace'), pill: document.getElementById('workspace-indicator-name').textContent, toast: document.getElementById('toast').textContent }));
  assert.equal(rejectedClear.ok, false);
  assert.equal(rejectedClear.stored, '/synthetic/storage-A');
  assert.equal(rejectedClear.pill, 'storage-A');
  assert.match(rejectedClear.toast, /Could not save workspace in browser storage/);
  await page.evaluate(() => { window.__ownedStorageVet = window.workspace.vetAndSetWorkspace('/synthetic/storage-owned-B'); });
  await waitUntil(s => s.requests.includes('/synthetic/storage-owned-B'));
  const rejectedAutomaticClear = await page.evaluate(() => ({ ok: window.workspace.clearRejectedWorkspace('/synthetic/storage-A'), stored: localStorage.getItem('odysseus-workspace'), getter: window.workspace.getWorkspace() }));
  assert.equal(rejectedAutomaticClear.ok, false);
  assert.equal(rejectedAutomaticClear.stored, '/synthetic/storage-A');
  assert.equal(rejectedAutomaticClear.getter, '/synthetic/storage-A');
  await page.evaluate(() => { window.__failWorkspaceWrites = false; });
  await release('/synthetic/storage-owned-B', true);
  const restoredVet = await page.evaluate(async () => {
    const result = await window.__ownedStorageVet;
    return { ok: result.ok, stored: localStorage.getItem('odysseus-workspace'), pill: document.getElementById('workspace-indicator-name').textContent };
  });
  assert.equal(restoredVet.ok, true);
  assert.equal(restoredVet.stored, '/canonical//synthetic/storage-owned-B');
  assert.equal(restoredVet.pill, 'storage-owned-B');

  // Completing a superseded vet must not clear the newer vet's default-load
  // barrier; after the newer vet fails, that barrier must release.
  await page.reload();
  await page.waitForFunction(() => window.ready && !!window.workspace);
  await page.evaluate(() => {
    localStorage.removeItem('odysseus-workspace');
    window.__oldBeforeNewFail = window.workspace.vetAndSetWorkspace('/synthetic/old-before-new-fail');
  });
  await waitUntil(s => s.requests.includes('/synthetic/old-before-new-fail'));
  await page.evaluate(() => { window.__newFailAfterOld = window.workspace.vetAndSetWorkspace('/synthetic/new-fail-after-old'); });
  await waitUntil(s => s.requests.includes('/synthetic/new-fail-after-old'));
  await release('/synthetic/old-before-new-fail', true);
  const oldBeforeNew = await page.evaluate(async () => window.__oldBeforeNewFail);
  assert.equal(oldBeforeNew.stale, true);
  await page.evaluate(() => { window.__defaultWhileNewPending = window.workspace.loadDefaultWorkspace(); });
  await waitUntil(s => s.defaultCount === 5);
  await release('default-5', true);
  const blockedByNew = await page.evaluate(async () => ({ result: await window.__defaultWhileNewPending, stored: localStorage.getItem('odysseus-workspace') }));
  assert.equal(blockedByNew.result.ok, false);
  assert.equal(blockedByNew.stored, null);
  await release('/synthetic/new-fail-after-old', false);
  await page.evaluate(async () => { window.__newFailResult = await window.__newFailAfterOld; });
  await page.evaluate(() => { window.__defaultAfterNewFail = window.workspace.loadDefaultWorkspace(); });
  await waitUntil(s => s.defaultCount === 6);
  await release('default-6', true);
  const afterNewFailure = await page.evaluate(async () => ({ result: await window.__defaultAfterNewFail, stored: localStorage.getItem('odysseus-workspace') }));
  assert.equal(afterNewFailure.result.ok, true);
  assert.equal(afterNewFailure.stored, '/canonical/default-6');

  // An older held vet cannot block default loading after the newer vet has
  // failed, and its late success cannot overwrite that default.
  await page.reload();
  await page.waitForFunction(() => window.ready && !!window.workspace);
  await page.evaluate(() => {
    localStorage.removeItem('odysseus-workspace');
    window.__oldLate = window.workspace.vetAndSetWorkspace('/synthetic/old-late-after-new-fail');
  });
  await waitUntil(s => s.requests.includes('/synthetic/old-late-after-new-fail'));
  await page.evaluate(() => { window.__newFailsFirst = window.workspace.vetAndSetWorkspace('/synthetic/new-fails-first'); });
  await waitUntil(s => s.requests.includes('/synthetic/new-fails-first'));
  await release('/synthetic/new-fails-first', false);
  const newestFailure = await page.evaluate(async () => window.__newFailsFirst);
  assert.equal(newestFailure.ok, false);
  await page.evaluate(() => { window.__defaultAfterNewFailed = window.workspace.loadDefaultWorkspace(); });
  await waitUntil(s => s.defaultCount === 7);
  await release('default-7', true);
  const defaultWithOldHeld = await page.evaluate(async () => ({ result: await window.__defaultAfterNewFailed, stored: localStorage.getItem('odysseus-workspace') }));
  assert.equal(defaultWithOldHeld.result.ok, true);
  assert.equal(defaultWithOldHeld.stored, '/canonical/default-7');
  await release('/synthetic/old-late-after-new-fail', true);
  const lateOld = await page.evaluate(async () => ({ result: await window.__oldLate, stored: localStorage.getItem('odysseus-workspace') }));
  assert.equal(lateOld.result.stale, true);
  assert.equal(lateOld.stored, '/canonical/default-7');

  // Exercise the actual slash-command handler body: stale completion is silent.
  const slashSource = fs.readFileSync(path.join(repo, 'static/js/slashCommands.js'), 'utf8');
  const replies = [];
  const commandWorkspace = { getWorkspace: () => '', vetAndSetWorkspace: async () => ({ ok: false, path: null, stale: true }) };
  const command = new Function('workspaceModule', 'uiModule', 'slashReply', `return (${extractFunction(slashSource, '_cmdWorkspace')});`)(
    commandWorkspace, { esc: value => value }, reply => replies.push(reply),
  );
  await command(['set', '/synthetic/stale-command'], {});
  await delay(0);
  assert.deepEqual(replies, [], 'stale vet outcome must not emit obsolete slash reply');
  const storageReplies = [];
  const failedStorageWorkspace = { getWorkspace: () => '/synthetic/storage-A', vetAndSetWorkspace: async () => ({ ok: false, path: null, storage_error: true }), clearWorkspace: () => false };
  const failedStorageCommand = new Function('workspaceModule', 'uiModule', 'slashReply', `return (${extractFunction(slashSource, '_cmdWorkspace')});`)(
    failedStorageWorkspace, { esc: value => value }, reply => storageReplies.push(reply),
  );
  await failedStorageCommand(['set', '/synthetic/storage-B'], {});
  await failedStorageCommand(['clear'], {});
  await delay(0);
  assert.equal(storageReplies.length, 2);
  assert.ok(storageReplies.every(reply => reply.includes('Could not save workspace in browser storage')));
  const legacyClearReplies = [];
  const legacyClearCommand = new Function('workspaceModule', 'uiModule', 'slashReply', `return (${extractFunction(slashSource, '_cmdWorkspace')});`)(
    { getWorkspace: () => '/synthetic/legacy', clearWorkspace: () => undefined },
    { esc: value => value }, reply => legacyClearReplies.push(reply),
  );
  await legacyClearCommand(['clear'], {});
  assert.deepEqual(legacyClearReplies, ['Workspace cleared.'], 'legacy clearWorkspace success returned undefined');
  const requestFailureReplies = [];
  const requestFailureCommand = new Function('workspaceModule', 'uiModule', 'slashReply', `return (${extractFunction(slashSource, '_cmdWorkspace')});`)(
    { getWorkspace: () => '', vetAndSetWorkspace: async () => ({ ok: false, path: null, request_error: true }) },
    { esc: value => value }, reply => requestFailureReplies.push(reply),
  );
  await requestFailureCommand(['set', '/synthetic/unavailable'], {});
  await delay(0);
  assert.equal(requestFailureReplies.length, 1);
  assert.match(requestFailureReplies[0], /Could not check this workspace with the Novum Xenium backend/);
  const invalidPathReplies = [];
  const invalidPathCommand = new Function('workspaceModule', 'uiModule', 'slashReply', `return (${extractFunction(slashSource, '_cmdWorkspace')});`)(
    { getWorkspace: () => '', vetAndSetWorkspace: async () => ({ ok: false, path: null }) },
    { esc: value => value }, reply => invalidPathReplies.push(reply),
  );
  await invalidPathCommand(['set', '/synthetic/not-a-folder'], {});
  await delay(0);
  assert.equal(invalidPathReplies.length, 1);
  assert.match(invalidPathReplies[0], /Not a usable workspace folder/);
  // Confirm the real caller checks stale before emitting either reply.
  const caller = slashSource.slice(slashSource.indexOf('workspaceModule.vetAndSetWorkspace(path).then'), slashSource.indexOf('});', slashSource.indexOf('workspaceModule.vetAndSetWorkspace(path).then')) + 3);
  assert.match(caller, /if \(stale\) return;/);
  assert.ok(command);

  const summary = { loopbackOnly: nonLoopback.length === 0, pageErrors: errors, requests, cases: {
    lateVetAfterClear: clearResult.result.stale && clearResult.stored === '',
    latestOverlappingVetWins: oldVet.result.stale && oldVet.stored === newVet.stored,
    directChoiceInvalidatesVet: direct.result.stale && direct.stored === '/synthetic/new-direct-choice',
    defaultBlockedAndRetryable: defaultHeld.result.ok === false && defaultHeld.stored === null && retriedDefault.result.ok && retriedDefault.stored === '/canonical/default-2' && pendingVetDefault.stored === null && retriedPendingDefault.result.ok && retriedPendingDefault.stored === '/canonical/default-4',
    storageWriteFailureDoesNotClaimSelection: !rejectedDirectWrite.ok && !rejectedVet.ok && rejectedVet.storageError && !rejectedClear.ok && /Could not save workspace in browser storage/.test(rejectedClear.toast) && !rejectedAutomaticClear.ok && restoredVet.ok && restoredVet.stored === '/canonical//synthetic/storage-owned-B',
    staleVetDoesNotClearNewerPendingOwnership: blockedByNew.result.ok === false && afterNewFailure.result.ok && afterNewFailure.stored === '/canonical/default-6',
    staleVetDoesNotBlockOrOverwriteAfterNewerFailure: defaultWithOldHeld.result.ok && lateOld.result.stale && lateOld.stored === '/canonical/default-7',
    slashCallerSuppressesStaleReply: /if \(stale\) return;/.test(caller) && replies.length === 0,
    slashCallerReportsStorageFailure: storageReplies.length === 2 && storageReplies.every(reply => reply.includes('Could not save workspace in browser storage')),
    slashCallerAcceptsLegacyClearSuccess: legacyClearReplies.length === 1 && legacyClearReplies[0] === 'Workspace cleared.',
    slashCallerSeparatesRequestFailure: requestFailureReplies.length === 1 && /Could not check this workspace/.test(requestFailureReplies[0]),
    slashCallerPreservesInvalidPathMessage: invalidPathReplies.length === 1 && /Not a usable workspace folder/.test(invalidPathReplies[0]),
  } };
  assert.equal(summary.loopbackOnly, true);
  assert.deepEqual(errors, []);
  for (const [name, passed] of Object.entries(summary.cases)) assert.equal(passed, true, name);
  console.log(JSON.stringify(summary));
} finally {
  for (const response of held.values()) { try { response.destroy(); } catch {} }
  held.clear();
  await browser?.close().catch(() => {});
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
})().catch(error => { console.error(error); server.closeAllConnections?.(); server.close(); process.exitCode = 1; });
