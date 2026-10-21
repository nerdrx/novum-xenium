'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = process.env.SOURCE_ROOT || path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
const sourcePath = path.join(staticRoot, 'js/presets.js');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
const emptyCustom = { name: 'Custom', character_name: '', enabled: false, temperature: 1, max_tokens: 0, system_prompt: '', reasoning_mode: 'auto', thinking_mode: '', persona_memory: '', persona_memory_schema: 'general' };
let server, browser, custom = { ...emptyCustom }, revision = 0, legacy = false, unguardedToken = false;
let getStatus = 200, failNextSave = false, badAckNext = false, missingGuardNext = false, holdNext = null, holdGetNext = null;
const requests = [], posts = [], held = new Map(), heldGets = new Map();

const html = `<!doctype html><meta charset="utf-8">
<div id="custom-preset-modal" class="modal hidden"><div class="modal-content">
<div class="preset-tab active" data-chartab="character"></div><div class="preset-chartab" data-chartab-panel="character"></div>
<div class="preset-tab" data-chartab="inject"></div><div class="preset-chartab" data-chartab-panel="inject"></div>
<div class="preset-tab" data-chartab="group"></div><div class="preset-chartab" data-chartab-panel="group"></div>
<select id="char-template-select"><option value="__default__">Default</option></select>
<button id="char-delete-template-btn"></button><button id="char-new-btn"></button><div id="char-name-row"></div>
<input id="custom-character-name"><textarea id="custom-system-prompt"></textarea>
<input id="custom-temperature" type="range" value="1"><span id="temp-value"></span>
<input id="custom-max-tokens" type="range" value="1000"><span id="tokens-value"></span>
<select id="custom-reasoning-mode"><option value="auto">auto</option></select>
<select id="custom-thinking-mode"><option value=""></option><option value="on">on</option><option value="off">off</option></select>
<input id="custom-show-persona-name" type="checkbox" checked><input id="inject-prefix"><input id="inject-suffix">
<button id="save-as-template-btn"></button><button id="reset-character-btn"></button><button id="char-expand-btn"></button>
<button id="overflow-preset-btn"></button><button id="character-indicator-btn"><span id="char-indicator-icon"></span><span id="character-indicator-name"></span></button>
<button id="close-custom-preset"></button><button id="cancel-custom-preset"></button>
</div></div>
<script type="module">
window.__timers = []; window.__clearedTimers = [];
const nativeSetTimeout = window.setTimeout.bind(window), nativeClearTimeout = window.clearTimeout.bind(window);
window.setTimeout = (callback, delay, ...args) => { const id = nativeSetTimeout(callback, delay, ...args); if (delay === 15000) window.__timers.push(id); return id; };
window.clearTimeout = id => { if (window.__timers.includes(id)) window.__clearedTimers.push(id); return nativeClearTimeout(id); };
import m from '/static/js/presets.js';
window.p = { m, errors: [], toasts: [], saves: [] };
window.uiModule = { showError: x => p.errors.push(x), showToast: x => p.toasts.push(x) };
window.styledConfirm = async () => true;
m.init(location.origin);
window.startSave = () => { p.saves.push(m.saveCustomPreset(uiModule.showToast, uiModule.showError)); return p.saves.length - 1; };
window.waitSave = index => p.saves[index];
if (!new URLSearchParams(location.search).has('skipStartup')) window.startup = m.loadPresets(uiModule.showError);
m.openCustomPresetModal();
window.ready = true;
</script>`;

function json(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function listen() {
  return new Promise(resolve => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html); }
      if (url.pathname.startsWith('/static/')) {
        const file = path.resolve(staticRoot, '.' + url.pathname.slice('/static'.length));
        if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(fs.readFileSync(file));
      }
      if (url.pathname === '/__state') return json(res, 200, { custom, revision, legacy, unguardedToken, requests, posts, held: [...held.keys()], heldGets: [...heldGets.keys()] });
      if (url.pathname === '/__reset') {
        custom = { ...emptyCustom }; revision = Number(url.searchParams.get('revision') || 0);
        legacy = url.searchParams.get('legacy') === '1'; unguardedToken = url.searchParams.get('unguardedToken') === '1';
        getStatus = 200; failNextSave = false; badAckNext = false; missingGuardNext = false; holdNext = null; holdGetNext = null;
        requests.length = 0; posts.length = 0; held.clear(); heldGets.clear();
        return res.writeHead(200).end();
      }
      if (url.pathname === '/__get-status') { getStatus = Number(url.searchParams.get('status') || 200); return res.writeHead(200).end(); }
      if (url.pathname === '/__hold-next') { holdNext = url.searchParams.get('phase') || 'before'; return res.writeHead(200).end(); }
      if (url.pathname === '/__hold-get') { holdGetNext = url.searchParams.get('phase') || 'body'; return res.writeHead(200).end(); }
      if (url.pathname === '/__release-get') {
        const name = url.searchParams.get('name') || '';
        const release = heldGets.get(name);
        if (!release) return res.writeHead(404).end();
        heldGets.delete(name); release(); return res.writeHead(200).end();
      }
      if (url.pathname === '/__fail-next') { failNextSave = true; return res.writeHead(200).end(); }
      if (url.pathname === '/__bad-ack-next') { badAckNext = true; return res.writeHead(200).end(); }
      if (url.pathname === '/__missing-guard-next') { missingGuardNext = true; return res.writeHead(200).end(); }
      if (url.pathname === '/__restore-revision') { revision = Number(url.searchParams.get('revision')); return json(res, 200, { revision }); }
      if (url.pathname === '/__external-change') {
        revision += 1; custom = { ...custom, name: 'External', character_name: 'External', enabled: true, system_prompt: 'external edit' };
        return json(res, 200, { revision, custom });
      }
      if (url.pathname === '/__release') {
        const name = url.searchParams.get('name');
        const release = held.get(name);
        if (!release) return res.writeHead(404).end();
        held.delete(name); release(); return res.writeHead(200).end();
      }
      if (url.pathname === '/api/presets' && req.method === 'GET') {
        requests.push({ method: 'GET', path: url.pathname });
        if (getStatus !== 200) return json(res, getStatus, { detail: 'synthetic unavailable' });
        const mode = holdGetNext; holdGetNext = null;
        const snapshot = { custom: { ...custom }, ...(legacy ? {} : { custom_revision: revision, ...(!unguardedToken ? { custom_save_revision_guard: true } : {}) }) };
        if (mode === 'body') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.write('{"custom":');
          await new Promise(resolveHeld => heldGets.set('preflight', resolveHeld));
          if (!res.destroyed) res.end(JSON.stringify(snapshot).slice('{"custom":'.length));
          return;
        }
        return json(res, 200, snapshot);
      }
      if (url.pathname === '/api/presets/templates' && req.method === 'GET') return json(res, 200, []);
      if (url.pathname === '/api/presets/templates' && req.method === 'POST') {
        for await (const _chunk of req) { /* consume synthetic template save */ }
        return json(res, 200, { success: true });
      }
      if (url.pathname === '/api/presets/custom' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        const rawExpected = url.searchParams.get('expected_custom_revision');
        const expected = rawExpected === null ? null : Number(rawExpected);
        const record = { name: body.name, prompt: body.system_prompt, expected, status: null };
        posts.push(record); requests.push({ method: 'POST', path: url.pathname, expected, name: body.name });
        const phase = holdNext; holdNext = null;
        if (phase === 'before') await new Promise(resolveHeld => held.set(body.name, () => { record.released = true; resolveHeld(); }));
        const guarded = !legacy && !unguardedToken;
        if (guarded && expected !== null && expected !== revision) {
          record.status = 409;
          return json(res, 409, { success: false, message: 'Persona settings changed; retry saving your preserved edits.', custom_revision: revision });
        }
        if (failNextSave) { failNextSave = false; record.status = 200; return json(res, 200, { success: false, message: 'Synthetic write rejected' }); }
        custom = { ...body, character_name: body.name }; revision += 1; record.status = 200;
        const malformedAck = badAckNext; badAckNext = false;
        const missingGuard = missingGuardNext; missingGuardNext = false;
        const result = { success: true, ...(!legacy ? { custom_revision: malformedAck ? expected : revision, ...(!unguardedToken && !missingGuard ? { custom_save_revision_guard: true } : {}) } : {}) };
        if (phase === 'body') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.write('{"success":true,');
          await new Promise(resolveHeld => held.set(body.name, () => { record.released = true; resolveHeld(); }));
          if (!res.destroyed) res.end(legacy ? '}' : `"custom_revision":${malformedAck ? expected : revision}${!unguardedToken && !missingGuard ? ',"custom_save_revision_guard":true' : ''}}`);
          return;
        }
        return json(res, 200, result);
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', resolve);
  });
}
async function state(page) { return page.request.get(`${origin}/__state`).then(r => r.json()); }
async function waitFor(page, predicate, label, timeout = 8000) {
  await page.waitForFunction(predicate, null, { timeout }).catch(error => { throw new Error(`Timed out waiting for ${label}: ${error.message}`); });
}
async function waitForState(page, expression, label, timeout = 8000) {
  await page.waitForFunction(async source => {
    const value = await fetch('/__state').then(response => response.json());
    return new Function('state', `return (${source})(state)`)(value);
  }, expression, { timeout }).catch(error => { throw new Error(`Timed out waiting for ${label}: ${error.message}`); });
}
async function newPage(context, skipStartup = false) {
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
  await page.goto(origin + (skipStartup ? '/?skipStartup=1' : '/'));
  await waitFor(page, () => window.ready === true, 'module ready');
  if (!skipStartup) await page.evaluate(() => window.startup);
  return page;
}
async function fill(page, name, prompt) {
  await page.locator('#custom-character-name').fill(name);
  await page.locator('#custom-system-prompt').fill(prompt);
}
async function begin(page) { return page.evaluate(() => window.startSave()); }
async function finish(page, index) { await page.evaluate(i => window.waitSave(i), index); }
async function reset(revisionValue = 0, legacyValue = false, unguardedTokenValue = false) {
  await fetch(`${origin}/__reset?revision=${revisionValue}&legacy=${legacyValue ? 1 : 0}&unguardedToken=${unguardedTokenValue ? 1 : 0}`);
}

const errors = [], externalRequests = [];
let origin;
(async () => {
  let contexts = [];
  try {
    await listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
    origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext(); contexts.push(context);

    // Captured payloads execute in invocation order; each POST uses prior ACK revision.
    await reset(0);
    let page = await newPage(context);
    await fill(page, 'Queue A', 'captured A');
    await page.request.get(`${origin}/__hold-next?phase=before`);
    const saveA = await begin(page);
    await waitForState(page, "state => state.held.includes('Queue A')", 'held first custom save');
    await fill(page, 'Queue B', 'captured B');
    const saveB = await begin(page);
    await page.waitForTimeout(100);
    let current = await state(page);
    let ui;
    assert.equal(current.posts.length, 1, 'second save waits behind first write');
    assert.equal(current.posts[0].expected, 0);
    await page.request.get(`${origin}/__release?name=Queue%20A`);
    await finish(page, saveA);
    await waitForState(page, 'state => state.posts.length === 2', 'queued second save');
    await finish(page, saveB);
    current = await state(page);
    assert.deepEqual(current.posts.map(item => [item.name, item.expected]), [['Queue A', 0], ['Queue B', 1]]);
    assert.equal(current.custom.character_name, 'Queue B');
    assert.equal(current.custom.system_prompt, 'captured B');
    assert.equal((await page.evaluate(() => p.m.getAllPresets().custom.character_name)), 'Queue B');

    // Unknown revision preflight is token-only; failed preflight never POSTs.
    await reset(7);
    page = await newPage(context, true);
    await fill(page, 'Preflight draft', 'keep this draft');
    const beforeCache = await page.evaluate(() => JSON.stringify(window.p.m.getAllPresets()));
    await page.request.get(`${origin}/__get-status?status=503`);
    const preflightFail = await begin(page); await finish(page, preflightFail);
    current = await state(page);
    assert.equal(current.posts.length, 0, 'failed preflight does not send write');
    assert.equal(await page.evaluate(() => JSON.stringify(window.p.m.getAllPresets())), beforeCache, 'preflight does not replace module cache');
    assert.equal(await page.locator('#custom-system-prompt').inputValue(), 'keep this draft');
    await page.request.get(`${origin}/__get-status?status=200`);
    await page.request.get(`${origin}/__hold-next?phase=before`);
    const preflightSave = await begin(page);
    await waitForState(page, "state => state.held.includes('Preflight draft')", 'preflighted save held');
    current = await state(page);
    assert.equal(current.requests.filter(item => item.method === 'GET').length, 2, 'failed and successful token preflight both run');
    assert.equal(await page.evaluate(() => JSON.stringify(window.p.m.getAllPresets())), beforeCache, 'successful token-only preflight does not overwrite module cache');
    assert.equal(current.posts[0].expected, 7);
    await page.request.get(`${origin}/__release?name=Preflight%20draft`);
    await finish(page, preflightSave);

    // A held preflight body times out without mutation; an explicit retry can succeed.
    await reset(7);
    page = await newPage(context, true);
    await fill(page, 'Preflight timeout', 'preserve across timeout');
    const timeoutCache = await page.evaluate(() => JSON.stringify(p.m.getAllPresets()));
    await page.request.get(`${origin}/__hold-get?phase=body`);
    const preflightTimeout = await begin(page);
    await waitForState(page, "state => state.heldGets.includes('preflight')", 'preflight JSON held');
    await finish(page, preflightTimeout);
    current = await state(page);
    assert.equal(current.posts.length, 0, 'preflight timeout never sends POST');
    assert.equal(await page.evaluate(() => JSON.stringify(p.m.getAllPresets())), timeoutCache, 'preflight timeout leaves cache untouched');
    assert.equal(await page.locator('#custom-system-prompt').inputValue(), 'preserve across timeout');
    ui = await page.evaluate(() => ({ errors: p.errors.slice(), toasts: p.toasts.slice(), timers: window.__timers.length, cleared: window.__clearedTimers.length }));
    assert(ui.errors.length > 0);
    assert.equal(ui.toasts.length, 0);
    assert.equal(ui.timers, ui.cleared, 'preflight timeout clears its timer');
    await page.request.get(`${origin}/__release-get?name=preflight`);
    const preflightRetry = await begin(page); await finish(page, preflightRetry);
    current = await state(page);
    assert.equal(current.posts.length, 1);
    assert.equal(current.posts[0].expected, 7, 'retry rechecks the revision before writing');

    // Conflict is explicit, preserves the draft, and does not auto-retry.
    await reset(3);
    page = await newPage(context);
    await fill(page, 'Conflict draft', 'preserve on conflict');
    await page.request.get(`${origin}/__external-change`);
    const conflictSave = await begin(page); await finish(page, conflictSave);
    current = await state(page);
    assert.equal(current.posts.length, 1);
    assert.equal(current.posts[0].expected, 3);
    assert.equal(current.posts[0].status, 409);
    assert.equal(current.custom.character_name, 'External');
    assert.equal(await page.locator('#custom-system-prompt').inputValue(), 'preserve on conflict');
    ui = await page.evaluate(() => ({ errors: p.errors.slice(), toasts: p.toasts.slice(), hidden: document.querySelector('#custom-preset-modal').classList.contains('hidden') }));
    assert.equal(ui.toasts.length, 0, 'conflict never says Persona saved');
    assert.match(ui.errors.at(-1), /changed/);
    assert.equal(ui.hidden, false);
    const explicitRetry = await begin(page); await finish(page, explicitRetry);
    current = await state(page);
    assert.equal(current.posts.length, 2, 'retry only follows explicit second save');
    assert.equal(current.posts[1].expected, 4, 'conflict token is used only by later user action');
    assert.equal(current.custom.character_name, 'Conflict draft');

    // A valid conflict token can move backwards after restore; explicit retry uses it.
    await reset(9);
    page = await newPage(context);
    await fill(page, 'Restored draft', 'retry after restore conflict');
    await page.request.get(`${origin}/__restore-revision?revision=2`);
    const restoredConflict = await begin(page); await finish(page, restoredConflict);
    current = await state(page);
    assert.equal(current.posts[0].expected, 9);
    assert.equal(current.posts[0].status, 409);
    const restoredRetry = await begin(page); await finish(page, restoredRetry);
    current = await state(page);
    assert.deepEqual(current.posts.map(item => [item.expected, item.status]), [[9, 409], [2, 200]]);
    assert.equal(current.custom.character_name, 'Restored draft');

    // A malformed modern ACK is uncertain: no false toast, and next write uses last ACK.
    await reset(4);
    page = await newPage(context);
    await fill(page, 'Malformed ACK A', 'server may have committed');
    await page.request.get(`${origin}/__bad-ack-next`);
    const badAck = await begin(page); await finish(page, badAck);
    current = await state(page);
    ui = await page.evaluate(() => ({ errors: p.errors.slice(), toasts: p.toasts.slice() }));
    assert.equal(current.posts[0].expected, 4);
    assert.equal(current.custom.character_name, 'Malformed ACK A');
    assert(ui.errors.some(message => message.includes('outcome could not be confirmed')));
    assert.equal(ui.toasts.length, 0);
    const afterBadAck = await begin(page); await finish(page, afterBadAck);
    current = await state(page);
    assert.equal(current.posts[1].expected, 4, 'next write uses only the last acknowledged revision');
    assert.equal(current.posts[1].status, 409);
    const afterBadAckRetry = await begin(page); await finish(page, afterBadAckRetry);
    current = await state(page);
    assert.deepEqual(current.posts.slice(1).map(item => [item.expected, item.status]), [[4, 409], [5, 200]]);

    // A modern ACK needs its explicit capability marker as well as a revision.
    await reset(6);
    page = await newPage(context);
    await fill(page, 'Missing guard ACK', 'do not claim unguarded success');
    await page.request.get(`${origin}/__missing-guard-next`);
    const missingGuardAck = await begin(page); await finish(page, missingGuardAck);
    current = await state(page);
    ui = await page.evaluate(() => ({ errors: p.errors.slice(), toasts: p.toasts.slice(), active: p.m.getAllPresets().custom.character_name }));
    assert.equal(current.posts[0].expected, 6);
    assert.equal(current.custom.character_name, 'Missing guard ACK', 'the synthetic server committed before its malformed ACK');
    assert.equal(ui.active, '', 'client does not apply a success ACK without the marker');
    assert(ui.errors.some(message => message.includes('outcome could not be confirmed')));
    assert.equal(ui.toasts.length, 0, 'missing marker never says Persona saved');
    const markerRetry = await begin(page); await finish(page, markerRetry);
    current = await state(page);
    assert.deepEqual(current.posts.map(item => [item.expected, item.status]), [[6, 200], [6, 409]]);
    const explicitMarkerRetry = await begin(page); await finish(page, explicitMarkerRetry);
    current = await state(page);
    assert.deepEqual(current.posts.slice(1).map(item => [item.expected, item.status]), [[6, 409], [7, 200]]);

    // Latest queued save failing leaves its own form open and emits no success toast.
    await reset(0);
    page = await newPage(context);
    await fill(page, 'First accepted', 'accepted text');
    const first = await begin(page); await finish(page, first);
    await page.evaluate(() => { p.toasts.length = 0; p.errors.length = 0; });
    await page.evaluate(() => p.m.openCustomPresetModal());
    await fill(page, 'Latest failed', 'latest draft remains');
    await page.request.get(`${origin}/__fail-next`);
    const latestFail = await begin(page); await finish(page, latestFail);
    current = await state(page);
    ui = await page.evaluate(() => ({ errors: p.errors.slice(), toasts: p.toasts.slice(), hidden: document.querySelector('#custom-preset-modal').classList.contains('hidden') }));
    assert.equal(current.custom.character_name, 'First accepted');
    assert.equal(await page.locator('#custom-system-prompt').inputValue(), 'latest draft remains');
    assert.equal(ui.toasts.length, 0);
    assert(ui.errors.length > 0);
    assert.equal(ui.hidden, false);

    // Body timeout occurs after server commit; following modern write gets CAS conflict.
    await reset(0);
    page = await newPage(context);
    await fill(page, 'Body timeout A', 'committed before held JSON');
    await page.request.get(`${origin}/__hold-next?phase=body`);
    const bodyTimeoutA = await begin(page);
    await waitForState(page, "state => state.held.includes('Body timeout A')", 'body response held');
    await finish(page, bodyTimeoutA);
    await fill(page, 'Body timeout B', 'newer draft after timeout');
    const bodyTimeoutB = await begin(page); await finish(page, bodyTimeoutB);
    current = await state(page);
    assert.deepEqual(current.posts.map(item => item.status), [200, 409]);
    assert.equal(current.posts[1].expected, 0, 'next save uses last acknowledged revision after ambiguous timeout');
    assert.equal(current.custom.character_name, 'Body timeout A', 'CAS prevents stale or unconfirmed overwrite');
    assert.equal(await page.locator('#custom-system-prompt').inputValue(), 'newer draft after timeout');
    ui = await page.evaluate(() => ({ errors: p.errors.slice(), toasts: p.toasts.slice(), timers: window.__timers, cleared: window.__clearedTimers }));
    assert(ui.errors.some(message => message.includes('outcome could not be confirmed')));
    assert.equal(ui.toasts.length, 0, 'timed-out write never says Persona saved');
    assert.equal(ui.timers.length, ui.cleared.length, 'body timeout clears owned timer');
    await page.request.get(`${origin}/__release?name=Body%20timeout%20A`);
    await waitForState(page, "state => state.posts.find(item => item.name === 'Body timeout A')?.released === true", 'body request released');

    // Header timeout leaves A before the server CAS; B may win, and late A must conflict.
    await reset(0);
    page = await newPage(context);
    await fill(page, 'Header timeout A', 'held before route');
    await page.request.get(`${origin}/__hold-next?phase=before`);
    const headerTimeoutA = await begin(page);
    await waitForState(page, "state => state.held.includes('Header timeout A')", 'header request held');
    await finish(page, headerTimeoutA);
    await fill(page, 'Header timeout B', 'newer write wins');
    const headerTimeoutB = await begin(page); await finish(page, headerTimeoutB);
    await page.request.get(`${origin}/__release?name=Header%20timeout%20A`);
    await waitForState(page, 'state => state.posts[0]?.status === 409', 'late old request conflicts');
    current = await state(page);
    assert.deepEqual(current.posts.map(item => [item.name, item.expected, item.status]), [['Header timeout A', 0, 409], ['Header timeout B', 0, 200]]);
    assert.equal(current.custom.character_name, 'Header timeout B');
    assert.equal(await page.evaluate(() => p.m.getAllPresets().custom.character_name), 'Header timeout B');

    // Legacy backend normal writes stay compatible; ambiguous legacy timeout blocks queue.
    await reset(0, true);
    page = await newPage(context);
    await fill(page, 'Legacy A', 'legacy A');
    const legacyA = await begin(page); await finish(page, legacyA);
    await page.evaluate(() => p.m.openCustomPresetModal());
    await fill(page, 'Legacy B', 'legacy B');
    const legacyB = await begin(page); await finish(page, legacyB);
    current = await state(page);
    assert.deepEqual(current.posts.map(item => [item.name, item.expected]), [['Legacy A', null], ['Legacy B', null]]);
    assert.equal(current.custom.character_name, 'Legacy B');

    // A pre-277 server may expose a token without enforcing conditional writes.
    await reset(0, false, true);
    page = await newPage(context);
    await fill(page, 'Legacy uncertain A', 'ambiguous legacy write');
    await page.request.get(`${origin}/__hold-next?phase=before`);
    const legacyTimeoutA = await begin(page);
    await waitForState(page, "state => state.held.includes('Legacy uncertain A')", 'legacy write held');
    await finish(page, legacyTimeoutA);
    await fill(page, 'Legacy blocked B', 'must remain unsent');
    const legacyBlockedB = await begin(page); await finish(page, legacyBlockedB);
    current = await state(page);
    assert.equal(current.posts.length, 1, 'ambiguous legacy write blocks later write');
    assert.equal(current.posts[0].expected, null, 'token without the capability flag is treated as legacy');
    assert.equal(await page.locator('#custom-system-prompt').inputValue(), 'must remain unsent');
    ui = await page.evaluate(() => ({ errors: p.errors.slice(), toasts: p.toasts.slice() }));
    assert(ui.errors.some(message => message.includes('unknown outcome')));
    assert.equal(ui.toasts.length, 0);
    await page.request.get(`${origin}/__release?name=Legacy%20uncertain%20A`);
    await waitForState(page, "state => state.posts.find(item => item.name === 'Legacy uncertain A')?.status === 200", 'legacy late write settled');

    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
    assert.deepEqual(externalRequests, []);
    console.log(JSON.stringify({ pass: true, sourceHash, requests: (await state(page)).requests.length, modernTimeouts: 2, legacyQueueBlocked: true }));
  } catch (error) {
    console.error(error.stack || String(error)); process.exitCode = 1;
  } finally {
    for (const name of [...held.keys()]) {
      try { await fetch(`${origin}/__release?name=${encodeURIComponent(name)}`); } catch (_) {}
    }
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})();
