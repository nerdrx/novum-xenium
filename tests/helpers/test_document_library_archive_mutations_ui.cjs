const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const docs = [
  { id: 'fixture-doc-1', title: 'Synthetic archived document one', language: 'text', updated_at: '2026-10-20T00:00:00Z' },
  { id: 'fixture-doc-2', title: 'Synthetic archived document two', language: 'text', updated_at: '2026-10-20T00:00:00Z' },
  { id: 'fixture-doc-3', title: 'Synthetic bulk restore failure', language: 'text', updated_at: '2026-10-20T00:00:00Z' },
  { id: 'fixture-doc-4', title: 'Synthetic bulk delete control', language: 'text', updated_at: '2026-10-20T00:00:00Z' },
  { id: 'fixture-doc-5', title: 'Synthetic selected before confirmation', language: 'text', updated_at: '2026-10-20T00:00:00Z' },
  { id: 'fixture-doc-6', title: 'Synthetic selected during confirmation', language: 'text', updated_at: '2026-10-20T00:00:00Z' },
  { id: 'fixture-doc-7', title: 'Synthetic bulk restore success', language: 'text', updated_at: '2026-10-20T00:00:00Z' },
  { id: 'fixture-doc-8', title: 'Synthetic bulk delete success', language: 'text', updated_at: '2026-10-20T00:00:00Z' },
  { id: 'fixture-doc-9', title: 'Synthetic context-menu restore', language: 'text', updated_at: '2026-10-20T00:00:00Z' },
  { id: 'fixture-doc-10', title: 'Synthetic held response A', language: 'text', updated_at: '2026-10-20T00:00:00Z' },
  { id: 'fixture-doc-11', title: 'Synthetic held response B', language: 'text', updated_at: '2026-10-20T00:00:00Z' },
];
const research = [
  { id:'fixture-research-1', query:'Synthetic mixed restore failure', source_count:1, completed_at:1792454400 },
  { id:'fixture-research-2', query:'Synthetic mixed delete failure', source_count:1, completed_at:1792454400 },
  { id:'fixture-research-3', query:'Synthetic context delete', source_count:1, completed_at:1792454400 },
  { id:'fixture-research-4', query:'Synthetic preview restore', source_count:1, completed_at:1792454400 },
  { id:'fixture-research-5', query:'Synthetic preview delete', source_count:1, completed_at:1792454400 },
];
const sessions = [
  { id:'fixture-chat-1', name:'Synthetic mixed restore chat', model:'fixture/model', updated_at:'2026-10-20T00:00:00Z' },
  { id:'fixture-chat-2', name:'Synthetic mixed delete chat', model:'fixture/model', updated_at:'2026-10-20T00:00:00Z' },
  { id:'fixture-chat-3', name:'Synthetic preview restore chat', model:'fixture/model', updated_at:'2026-10-20T00:00:00Z' },
];
const archived = new Set(docs.map(d => d.id));
const deleted = new Set();
const archivedResearch = new Set(research.map(r => r.id));
const deletedResearch = new Set();
const archivedSessions = new Set(sessions.map(s => s.id));
const deletedSessions = new Set();
let failRestore = true;
let failDelete = true;
let failBulkRestore = true;
let failBulkDelete = true;
const failures = new Map();
let holdPath = '';
let releaseHeld = null;
const calls = [];
const assets = [];
const unmatched = [];
const librarySource = fs.readFileSync(path.join(repo, 'static/js/documentLibrary.js'), 'utf8');
const sessionsSource = fs.readFileSync(path.join(repo, 'static/js/sessions.js'), 'utf8');
assert.match(librarySource, /return sessionModule\.deleteSessionById\(id, \{ credentials: 'same-origin' \}\);/, 'archive chat deletion keeps the session helper');
assert.match(sessionsSource, /export async function deleteSessionById\(sessionId, options = \{\}\) \{[\s\S]*?if \(response\.ok\) \{[\s\S]*?_clearComposerDraft\(sessionId\);[\s\S]*?return response;/, 'session helper retains response and successful-delete draft cleanup');
const html = `<!doctype html><meta charset="utf-8"><body><button id="tool-doclib-btn"></button><script type="module">
  import { initLibrary, openLibrary } from '/static/js/documentLibrary.js';
  import ui from '/static/js/ui.js?v=20260916largetoolscroll1';
  window.feedback = [];
  ui.showError = message => window.feedback.push({kind:'error', message:String(message)});
  ui.showToast = message => window.feedback.push({kind:'toast', message:String(message)});
  ui.styledConfirm = async () => true;
  initLibrary({apiBase:'', esc:s=>String(s??''), getDocs:()=>new Map(), isOpen:()=>false,
    createDocument:()=>{}, newDocument:()=>{}, loadDocument:()=>{}, prepareDocumentOpen:()=>{},
    switchToDoc:()=>{}, openPanel:()=>{}, addDocToTabs:()=>{}, syncDocIndicator:()=>{}});
  openLibrary({tab:'archive'});
  window.styledConfirm = async () => true;
  window.fixtureReady = true;
</script></body>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) calls.push({method:req.method, path:url.pathname, search:url.search});
  const json = (status, body) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)); };
  if (url.pathname === '/') { res.setHeader('Content-Type','text/html'); return res.end(html); }
  if (url.pathname === '/__hold') { holdPath = url.searchParams.get('path') || ''; res.writeHead(204); return res.end(); }
  if (url.pathname === '/__release') { const release = releaseHeld; releaseHeld = null; release?.(); res.writeHead(204); return res.end(); }
  if (url.pathname === '/__state') return json(200, {calls});
  if (url.pathname === '/api/sessions/archived') return json(200, {sessions:sessions.filter(s => archivedSessions.has(s.id) && !deletedSessions.has(s.id))});
  if (url.pathname === '/api/documents/library') { const rows = docs.filter(d => archived.has(d.id) && !deleted.has(d.id)); return json(200, {documents:rows, total:rows.length, languages:rows.length?{text:rows.length}:{}, session_count:0}); }
  if (url.pathname === '/api/research/library') return json(200, {research:research.filter(r => archivedResearch.has(r.id) && !deletedResearch.has(r.id))});
  const researchDetailMatch = url.pathname.match(/^\/api\/research\/detail\/(fixture-research-\d+)$/);
  if (researchDetailMatch && req.method === 'GET') {
    const row = research.find(r => r.id === researchDetailMatch[1]);
    return json(row ? 200 : 404, row ? {...row, sources:[], result:'Synthetic archived report preview.'} : {detail:'not found'});
  }
  const docMatch = url.pathname.match(/^\/api\/document\/(fixture-doc-\d+)(?:\/archive)?$/);
  const researchMatch = url.pathname.match(/^\/api\/research\/(fixture-research-\d+)(?:\/archive)?$/);
  const sessionMatch = url.pathname.match(/^\/api\/session\/(fixture-chat-\d+)(?:\/unarchive)?$/);
  const routeKey = `${req.method} ${url.pathname}`;
  const plannedStatus = failures.get(routeKey);
  const respond = (status, body, done) => {
    const finish = () => { if (status >= 200 && status < 300) done?.(); json(status, body); };
    if (holdPath === url.pathname) { holdPath = ''; releaseHeld = finish; }
    else finish();
  };
  if (plannedStatus === 'network') { req.socket.destroy(); return; }
  if (Number.isInteger(plannedStatus)) return json(plannedStatus, {detail:'synthetic fixture response'});
  if (docMatch && req.method === 'GET') { const row=docs.find(d=>d.id===docMatch[1]); return json(row ? 200 : 404, row ? {...row,current_content:'synthetic only'} : {detail:'not found'}); }
  if (docMatch && url.pathname.endsWith('/archive') && req.method === 'POST') {
    if (docMatch[1] === 'fixture-doc-3' && failBulkRestore) return json(503, {detail:'synthetic bulk archive outage'});
    if (docMatch[1] === 'fixture-doc-1' && failRestore) return json(503, {detail:'synthetic archive outage'});
    return respond(200, {ok:true, id:docMatch[1], archived:false}, () => archived.delete(docMatch[1]));
  }
  if (docMatch && req.method === 'DELETE') {
    if (docMatch[1] === 'fixture-doc-4' && failBulkDelete) return json(503, {detail:'synthetic bulk delete outage'});
    if (docMatch[1] === 'fixture-doc-2' && failDelete) return json(403, {detail:'synthetic delete forbidden'});
    return respond(200, {status:'deleted', id:docMatch[1]}, () => deleted.add(docMatch[1]));
  }
  if (researchMatch && url.pathname.endsWith('/archive') && req.method === 'POST') return respond(200, {ok:true}, () => archivedResearch.delete(researchMatch[1]));
  if (researchMatch && req.method === 'DELETE') return respond(200, {ok:true}, () => deletedResearch.add(researchMatch[1]));
  if (sessionMatch && url.pathname.endsWith('/unarchive') && req.method === 'POST') return respond(200, {ok:true}, () => archivedSessions.delete(sessionMatch[1]));
  if (sessionMatch && req.method === 'DELETE') return respond(200, {ok:true}, () => deletedSessions.add(sessionMatch[1]));
  if (req.method === 'GET' && url.pathname === '/api/history/fixture-chat-3') return json(200, {history:[{role:'user',content:'synthetic chat history only'}]});
  if (url.pathname === '/api/prefs/theme') return json(200, {});
  if (url.pathname === '/api/auth/settings') return json(200, {});
  if (url.pathname === '/api/tools') return json(200, []);
  if (url.pathname === '/api/auth/status') return json(200, {authenticated:false});
  if (url.pathname === '/api/prefs/custom-themes') return json(200, {});
  if (url.pathname === '/api/tts/stats') return json(200, {});
  if (url.pathname.startsWith('/api/')) unmatched.push({method:req.method,path:url.pathname,search:url.search});
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const disk = path.resolve(repo, '.' + decodeURIComponent(url.pathname));
  if (!disk.startsWith(repo + path.sep) || !fs.existsSync(disk) || !fs.statSync(disk).isFile()) { res.writeHead(404); return res.end(); }
  const mime = (disk.endsWith('.js') || disk.endsWith('.mjs')) ? 'text/javascript' : disk.endsWith('.css') ? 'text/css' : 'text/plain';
  assets.push({path:url.pathname, mime});
  res.setHeader('Content-Type', mime);
  fs.createReadStream(disk).pipe(res);
});
function boundedCloseServer() {
  return new Promise(resolve => {
    server.close(resolve);
    const timer = setTimeout(() => { server.closeAllConnections?.(); resolve(); }, 1000);
    timer.unref?.();
  });
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (!process.env.BROWSER_EXECUTABLE) throw new Error('BROWSER_EXECUTABLE is required for this opt-in browser proof');
  const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE, args:['--no-sandbox','--disable-gpu']});
  try {
    const page = await browser.newPage();
    const errors = [];
    const expectedHttpErrors = [];
    page.on('pageerror', e => errors.push(e.stack || e.message));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const message = m.text();
      if (message.includes('Failed to load resource: the server responded with a status of 403') || message.includes('Failed to load resource: the server responded with a status of 503')) expectedHttpErrors.push(message);
      else errors.push('console: ' + message);
    });
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== origin) return route.abort();
      return route.continue();
    });
    await page.goto(origin, {waitUntil:'load', timeout:10000});
    await page.waitForFunction(() => window.fixtureReady && document.querySelector('#doclib-arc-grid .memory-item'), { timeout: 8000 }).catch(async error => { throw new Error(error.message + '\nstate=' + JSON.stringify(await page.evaluate(() => ({ready:window.fixtureReady, modal:!!document.querySelector('#doclib-modal'), grid:!!document.querySelector('#doclib-arc-grid'), body:document.body.innerText.slice(0,500)}))) + '\nerrors=' + errors.join('\n') + '\nassets=' + JSON.stringify(assets)); });
    const card = page.locator('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-1"]');
    await card.click();
    const restore = card.locator('.doclib-chat-restore-btn');
    await restore.waitFor({timeout:5000});
    await restore.click();
    await page.waitForFunction(() => window.feedback.some(item => item.kind === 'error' && item.message.includes('HTTP 503')));
    const afterFailure = await page.evaluate(() => ({
      rowCount: document.querySelectorAll('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-1"]').length,
      visibleMessages: [...document.querySelectorAll('[role="alert"], .toast, .toast-message, .notification')].map(e=>e.textContent.trim()).filter(Boolean),
      feedback: window.feedback
    }));
    assert.equal(afterFailure.rowCount, 1, 'failed 503 leaves archived document listed after refresh');
    assert.ok(afterFailure.feedback.some(item => item.kind === 'error' && item.message.includes('HTTP 503')), 'preview restore reports the safe HTTP status');
    assert.equal(calls.filter(c=>c.method==='POST' && c.path.endsWith('/archive')).length, 1);

    failRestore = false;
    await card.click();
    await card.locator('.doclib-chat-restore-btn').waitFor({timeout:5000});
    await card.locator('.doclib-chat-restore-btn').click();
    await page.waitForFunction(() => !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-1"]'));
    assert.equal(archived.has('fixture-doc-1'), false, 'successful restore removes document from archived view');

    const deleteCard = page.locator('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-2"]');
    await deleteCard.click();
    await deleteCard.locator('.doclib-chat-delete-btn').waitFor({timeout:5000});
    await deleteCard.locator('.doclib-chat-delete-btn').click();
    await page.waitForFunction(() => window.feedback.some(item => item.kind === 'error' && item.message.includes('HTTP 403')));
    assert.equal(deleted.has('fixture-doc-2'), false, 'failed 503 leaves document undeleted');
    assert.ok((await page.evaluate(() => window.feedback)).some(item => item.kind === 'error' && item.message.includes('HTTP 403')), 'preview delete reports the safe HTTP status');
    await page.evaluate(() => { window.feedback = []; });
    failDelete = false;
    const retryDelete = page.locator('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-2"]');
    await retryDelete.click();
    await retryDelete.locator('.doclib-chat-delete-btn').waitFor({timeout:5000});
    await retryDelete.locator('.doclib-chat-delete-btn').click();
    await page.waitForFunction(() => !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-2"]'));
    assert.equal(deleted.has('fixture-doc-2'), true, 'successful delete removes document from archived view');

    const clearFeedback = () => page.evaluate(() => { window.feedback = []; });
    const selectKeys = async keys => {
      await page.locator('#doclib-arc-select-btn').click();
      for (const key of keys) await page.locator(`#doclib-arc-grid .memory-item[data-arckey="${key}"] .memory-select-cb`).check();
    };
    const errorMessages = async () => page.evaluate(() => window.feedback.filter(item => item.kind === 'error').map(item => item.message));
    const menuAction = async (key, label) => {
      await page.locator(`#doclib-arc-grid .memory-item[data-arckey="${key}"] button[class*="_arc-"]`).click();
      await page.locator('._lib-dd .dropdown-item-compact').filter({hasText:label}).click();
    };

    failures.set('POST /api/document/fixture-doc-9/archive', 403);
    await menuAction('documents:fixture-doc-9', 'Restore');
    await page.waitForFunction(() => window.feedback.some(item => item.kind === 'error' && item.message.includes('HTTP 403')));
    assert.ok((await errorMessages()).some(message => message.includes('HTTP 403')), 'document context-menu restore reports status');
    assert.equal(archived.has('fixture-doc-9'), true);
    await clearFeedback();
    failures.delete('POST /api/document/fixture-doc-9/archive');
    await menuAction('documents:fixture-doc-9', 'Restore');
    await page.waitForFunction(() => !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-9"]'));
    assert.equal(archived.has('fixture-doc-9'), false);

    // Research context menu failure and success exercise the same shared mutation path.
    failures.set('DELETE /api/research/fixture-research-3', 403);
    await menuAction('research:fixture-research-3', 'Delete');
    await page.waitForFunction(() => window.feedback.some(item => item.kind === 'error' && item.message.includes('HTTP 403')));
    assert.ok((await errorMessages()).some(message => message.includes('HTTP 403')));
    assert.equal(deletedResearch.has('fixture-research-3'), false);
    await clearFeedback();
    failures.delete('DELETE /api/research/fixture-research-3');
    await menuAction('research:fixture-research-3', 'Delete');
    await page.waitForFunction(() => !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="research:fixture-research-3"]'));
    assert.equal(deletedResearch.has('fixture-research-3'), true);

    // Archived research preview restore/delete use the same status-aware path.
    failures.set('POST /api/research/fixture-research-4/archive', 403);
    const researchRestoreRow = page.locator('#doclib-arc-grid .memory-item[data-arckey="research:fixture-research-4"]');
    await researchRestoreRow.click();
    await researchRestoreRow.locator('.doclib-chat-archive-btn').waitFor({timeout:5000});
    await researchRestoreRow.locator('.doclib-chat-archive-btn').click();
    await page.waitForFunction(() => window.feedback.some(item => item.kind === 'error' && item.message.includes('HTTP 403')));
    assert.equal(archivedResearch.has('fixture-research-4'), true, 'failed research preview restore remains archived');
    await clearFeedback();
    failures.delete('POST /api/research/fixture-research-4/archive');
    const researchRestoreRetry = page.locator('#doclib-arc-grid .memory-item[data-arckey="research:fixture-research-4"]');
    await researchRestoreRetry.click();
    await researchRestoreRetry.locator('.doclib-chat-archive-btn').waitFor({timeout:5000});
    await researchRestoreRetry.locator('.doclib-chat-archive-btn').click();
    await page.waitForFunction(() => !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="research:fixture-research-4"]'));
    assert.equal(archivedResearch.has('fixture-research-4'), false, 'research preview restore success removes archived row');

    failures.set('DELETE /api/research/fixture-research-5', 503);
    const researchDeleteRow = page.locator('#doclib-arc-grid .memory-item[data-arckey="research:fixture-research-5"]');
    await researchDeleteRow.click();
    await researchDeleteRow.locator('.doclib-chat-delete-btn').waitFor({timeout:5000});
    await researchDeleteRow.locator('.doclib-chat-delete-btn').click();
    await page.waitForFunction(() => window.feedback.some(item => item.kind === 'error' && item.message.includes('HTTP 503')));
    assert.equal(deletedResearch.has('fixture-research-5'), false, 'failed research preview delete preserves archived row');
    await clearFeedback();
    failures.delete('DELETE /api/research/fixture-research-5');
    const researchDeleteRetry = page.locator('#doclib-arc-grid .memory-item[data-arckey="research:fixture-research-5"]');
    await researchDeleteRetry.click();
    await researchDeleteRetry.locator('.doclib-chat-delete-btn').waitFor({timeout:5000});
    await researchDeleteRetry.locator('.doclib-chat-delete-btn').click();
    await page.waitForFunction(() => !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="research:fixture-research-5"]'));
    assert.equal(deletedResearch.has('fixture-research-5'), true, 'research preview delete success removes archived row');

    // Archived chat preview reports a 503 and leaves the row; retry success restores it.
    failures.set('POST /api/session/fixture-chat-3/unarchive', 503);
    const chatRow = page.locator('#doclib-arc-grid .memory-item[data-arckey="chats:fixture-chat-3"]');
    await chatRow.click();
    await chatRow.locator('.doclib-chat-restore-btn').waitFor({timeout:5000});
    await chatRow.locator('.doclib-chat-restore-btn').click();
    await page.waitForFunction(() => window.feedback.some(item => item.kind === 'error' && item.message.includes('HTTP 503')));
    assert.ok((await errorMessages()).some(message => message.includes('HTTP 503')));
    assert.equal(archivedSessions.has('fixture-chat-3'), true);
    await clearFeedback();
    failures.delete('POST /api/session/fixture-chat-3/unarchive');
    const retryChat = page.locator('#doclib-arc-grid .memory-item[data-arckey="chats:fixture-chat-3"]');
    await retryChat.click();
    await retryChat.locator('.doclib-chat-restore-btn').waitFor({timeout:5000});
    await retryChat.locator('.doclib-chat-restore-btn').click();
    await page.waitForFunction(() => !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="chats:fixture-chat-3"]'));
    assert.equal(archivedSessions.has('fixture-chat-3'), false);

    // Bulk restore mixes success with 403/503 failures; only failures remain selected.
    failures.set('POST /api/research/fixture-research-1/archive', 403);
    await selectKeys(['documents:fixture-doc-3', 'documents:fixture-doc-7', 'research:fixture-research-1', 'chats:fixture-chat-1']);
    await page.locator('#doclib-arc-bulk-restore').click();
    await page.waitForFunction(() => window.feedback.some(item => item.kind === 'error' && item.message.includes('2 of 4 archived items')));
    await page.waitForFunction(() => document.querySelector('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-3"] .memory-select-cb')?.checked && document.querySelector('#doclib-arc-grid .memory-item[data-arckey="research:fixture-research-1"] .memory-select-cb')?.checked);
    const restoreErrors = (await errorMessages()).join(' ');
    assert.match(restoreErrors, /2 of 4 archived items/);
    assert.match(restoreErrors, /2 succeeded/);
    assert.match(restoreErrors, /HTTP 403/);
    assert.match(restoreErrors, /HTTP 503/);
    assert.equal(archived.has('fixture-doc-7'), false);
    assert.equal(archivedSessions.has('fixture-chat-1'), false);
    assert.equal(archived.has('fixture-doc-3'), true);
    assert.equal(archivedResearch.has('fixture-research-1'), true);
    await clearFeedback();
    failBulkRestore = false;
    failures.delete('POST /api/research/fixture-research-1/archive');
    await page.locator('#doclib-arc-bulk-restore').click();
    await page.waitForFunction(() => !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-3"]') && !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="research:fixture-research-1"]'));
    assert.equal(await page.locator('#doclib-arc-bulk').evaluate(el => el.classList.contains('hidden')), true, 'all-success retry exits selection mode');

    // Bulk delete also aggregates mixed outcomes and preserves session helper behavior.
    failures.set('DELETE /api/research/fixture-research-2', 403);
    await selectKeys(['documents:fixture-doc-4', 'documents:fixture-doc-8', 'research:fixture-research-2', 'chats:fixture-chat-2']);
    await page.locator('#doclib-arc-bulk-delete').click();
    await page.waitForFunction(() => window.feedback.some(item => item.kind === 'error' && item.message.includes('2 of 4 archived items')));
    await page.waitForFunction(() => document.querySelector('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-4"] .memory-select-cb')?.checked && document.querySelector('#doclib-arc-grid .memory-item[data-arckey="research:fixture-research-2"] .memory-select-cb')?.checked);
    const deleteErrors = (await errorMessages()).join(' ');
    assert.match(deleteErrors, /2 of 4 archived items/);
    assert.match(deleteErrors, /2 succeeded/);
    assert.match(deleteErrors, /HTTP 403/);
    assert.match(deleteErrors, /HTTP 503/);
    assert.equal(deleted.has('fixture-doc-8'), true);
    assert.equal(deletedSessions.has('fixture-chat-2'), true);
    assert.equal(deleted.has('fixture-doc-4'), false);
    assert.equal(deletedResearch.has('fixture-research-2'), false);
    assert.ok(calls.some(call => call.method === 'DELETE' && call.path === '/api/session/fixture-chat-2'), 'chat delete went through the session helper endpoint');
    await clearFeedback();
    failBulkDelete = false;
    failures.delete('DELETE /api/research/fixture-research-2');
    await page.locator('#doclib-arc-bulk-delete').click();
    await page.waitForFunction(() => !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-4"]') && !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="research:fixture-research-2"]'));
    assert.equal(await page.locator('#doclib-arc-bulk').evaluate(el => el.classList.contains('hidden')), true);

    // Confirmation snapshots A; changing selection to B must never redirect A's action.
    await selectKeys(['documents:fixture-doc-5']);
    await page.evaluate(() => { window.confirmCalls = 0; window.styledConfirm = message => { window.confirmCalls++; window.lastConfirmMessage = message; return new Promise(resolve => { window.confirmResolve = resolve; }); }; });
    const deleteClick = page.locator('#doclib-arc-bulk-delete').click();
    await page.waitForFunction(() => window.confirmCalls === 1, { timeout:3000 });
    await page.locator('#doclib-arc-bulk-cancel').click();
    await selectKeys(['documents:fixture-doc-6']);
    const requestForA = page.waitForRequest(request => request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/document/fixture-doc-5', {timeout:5000});
    await page.evaluate(() => window.confirmResolve(true));
    await deleteClick;
    const observedA = await requestForA;
    await observedA.response();
    await page.waitForFunction(() => !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-5"]'));
    assert.equal(deleted.has('fixture-doc-5'), true);
    assert.equal(deleted.has('fixture-doc-6'), false);
    assert.equal(await page.locator('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-6"] .memory-select-cb').isChecked(), true, 'newer selection B survives A completion');

    // A response already in flight likewise cannot clear a newer selection or cancel intent.
    await page.locator('#doclib-arc-bulk-cancel').click();
    await selectKeys(['documents:fixture-doc-10']);
    holdPath = '/api/document/fixture-doc-10/archive';
    const restore10 = page.locator('#doclib-arc-bulk-restore').click();
    await page.waitForFunction(async () => (await (await fetch('/__state')).json()).calls.some(call => call.method === 'POST' && call.path === '/api/document/fixture-doc-10/archive'), {timeout:5000});
    await page.locator('#doclib-arc-bulk-cancel').click();
    await selectKeys(['documents:fixture-doc-11']);
    await page.evaluate(() => fetch('/__release'));
    await restore10;
    await page.waitForFunction(() => !document.querySelector('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-10"]'));
    assert.equal(await page.locator('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-11"] .memory-select-cb').isChecked(), true, 'newer response-time selection survives A completion');

    // Canceling the destructive confirmation dispatches no mutation.
    await page.locator('#doclib-arc-bulk-cancel').click();
    await selectKeys(['documents:fixture-doc-11']);
    await page.evaluate(() => { window.confirmCalls = 0; window.styledConfirm = message => { window.confirmCalls++; return Promise.resolve(false); }; });
    const deletesBeforeCancel = calls.filter(call => call.method === 'DELETE').length;
    await page.locator('#doclib-arc-bulk-delete').click();
    await page.waitForFunction(() => window.confirmCalls === 1);
    await page.evaluate(() => Promise.resolve());
    assert.equal(calls.filter(call => call.method === 'DELETE').length, deletesBeforeCancel, 'confirmation cancel sends no delete requests');
    assert.equal(await page.locator('#doclib-arc-grid .memory-item[data-arckey="documents:fixture-doc-11"] .memory-select-cb').isChecked(), true, 'cancel preserves current selection');

    assert.deepEqual(unmatched, [], `unexpected fixture API paths: ${JSON.stringify(unmatched)}`);
    assert.deepEqual(errors, [], `browser errors: ${errors.join('\\n')}`);
    assert.equal(expectedHttpErrors.length, 11, 'only the fixture planned HTTP 403/503 responses should log resource errors');
    console.log(JSON.stringify({result:'confirmed', archiveMutationFailuresVisible:true, researchPreviewFailuresAndRetries:true, partialBulkResultsPreserveFailedSelection:true, successfulRetryRemovesRows:true, chatDeleteKeepsSessionHelper:true, heldConfirmTargetsSnapshotA:true, newerSelectionSurvivesCompletion:true, cancelDispatchesNoMutation:true, requestCount:calls.length, expectedHttpFailureConsoleEntries:expectedHttpErrors.length, unmatched, pageErrors:errors}));
  } finally {
    await browser.close();
    await boundedCloseServer();
  }
})().catch(async error => { console.error(error.stack || error); server.closeAllConnections?.(); await boundedCloseServer(); process.exitCode=1; });
