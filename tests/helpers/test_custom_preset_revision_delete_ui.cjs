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

const initialCustom = { character_name: '', enabled: false, temperature: 1, max_tokens: 0, system_prompt: '', reasoning_mode: 'auto', thinking_mode: '' };
const templates = [];
let server, browser, heldResolve = null, holdNextCustom = false, heldCustomCount = 0;
let heldDeleteResolve = null, holdNextDelete = false, heldDeleteCount = 0;
let storedCustom = null, customRevision = 0, legacyApi = false;
let customBodies = [], templateBodies = [], deleteRequests = [], deleteResults = [], requests = [], externalRequests = [];
const failedCustomNames = new Set();
const html = `<!doctype html><meta charset="utf-8">
<div id="custom-preset-modal" class="hidden"></div>
<div class="preset-tab active" data-chartab="character"></div><div class="preset-chartab" data-chartab-panel="character"></div>
<select id="char-template-select"><option value="__default__">Default</option></select>
<button id="char-delete-template-btn"></button><button id="char-new-btn"></button><div id="char-name-row"></div>
<input id="custom-character-name"><textarea id="custom-system-prompt"></textarea>
<input id="custom-temperature" value="1"><span id="temp-value"></span>
<input id="custom-max-tokens" value="8448"><span id="tokens-value"></span>
<select id="custom-reasoning-mode"><option value="auto">auto</option><option value="on">on</option><option value="off">off</option></select>
<select id="custom-thinking-mode"><option value=""></option><option value="on">on</option><option value="off">off</option></select>
<input id="custom-show-persona-name" type="checkbox" checked><input id="inject-prefix"><input id="inject-suffix">
<button id="save-as-template-btn"></button><button id="reset-character-btn"></button><button id="overflow-preset-btn"></button>
<button id="character-indicator-btn"><span id="char-indicator-icon"></span><span id="character-indicator-name"></span></button>
<button id="save-custom-preset">Save &amp; Start Persona</button><button id="close-custom-preset"></button><button id="cancel-custom-preset"></button>
<script type="module">
import m, { PROMPT_TEMPLATES } from '/static/js/presets.js';
PROMPT_TEMPLATES.push({name:'Synthetic Builtin B', isCharacter:true, isPreset:true, prompt:'Builtin B prompt', temperature:1});
window.p = { m, errors:[], toasts:[] };
window.savePromises = [];
document.querySelector('#close-custom-preset').addEventListener('click', () => document.querySelector('#custom-preset-modal').classList.add('hidden'));
window.styledConfirm = async () => true;
window.uiModule = { showError: x => p.errors.push(x), showToast: x => p.toasts.push(x) };
m.init(location.origin);
await m.loadPresets();
window.document.querySelector('#save-custom-preset').addEventListener('click', async () => {
  const activeTab = document.querySelector('.preset-tab.active');
  if (activeTab && activeTab.dataset.chartab === 'group') return;
  const savePromise = m.saveCustomPreset(uiModule.showToast, uiModule.showError);
  window.savePromises.push(savePromise);
  await savePromise;
});
m.openCustomPresetModal();
window.ready = true;
</script>`;

function listen() {
  return new Promise(resolve => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); return res.end(html); }
      if (url.pathname.startsWith('/static/')) {
        const file = path.resolve(staticRoot, '.' + url.pathname.slice('/static'.length));
        if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
        res.writeHead(200, {'content-type':'text/javascript; charset=utf-8'}); return res.end(fs.readFileSync(file));
      }
      if (url.pathname === '/__hold-custom') { holdNextCustom = true; res.writeHead(200).end(); return; }
      if (url.pathname === '/__fail-custom') { failedCustomNames.add(url.searchParams.get('name') || ''); res.writeHead(200).end(); return; }
      if (url.pathname === '/__hold-delete') { holdNextDelete = true; res.writeHead(200).end(); return; }
      if (url.pathname === '/__release-delete') {
        if (!heldDeleteResolve) { res.writeHead(409).end('no held delete'); return; }
        heldDeleteResolve(); heldDeleteResolve = null; res.writeHead(200).end(); return;
      }
      if (url.pathname === '/__legacy') { legacyApi = url.searchParams.get('enabled') === '1'; res.writeHead(200).end(); return; }
      if (url.pathname === '/__reset') {
        storedCustom = null; customRevision = 0; legacyApi = false; templates.splice(0, templates.length);
        res.writeHead(200).end(); return;
      }
      if (url.pathname === '/__seed') {
        const name = url.searchParams.get('name') || '';
        const prompt = url.searchParams.get('prompt') || `${name} prompt`;
        storedCustom = { ...initialCustom, name, character_name: name, system_prompt: prompt, enabled: !!name };
        customRevision = Number(url.searchParams.get('revision') || 0);
        templates.splice(0, templates.length, { id: `template-${name}`, name, system_prompt: prompt, temperature: 1, max_tokens: 0, reasoning_mode: 'auto', thinking_mode: '', persona_memory: '', persona_memory_schema: 'general' });
        const otherName = url.searchParams.get('other') || '';
        if (otherName) templates.push({ id: `template-${otherName}`, name: otherName, system_prompt: `${otherName} prompt`, temperature: 1, max_tokens: 0, reasoning_mode: 'auto', thinking_mode: '', persona_memory: '', persona_memory_schema: 'general' });
        res.writeHead(200).end(); return;
      }
      if (url.pathname === '/__state') {
        res.writeHead(200, {'content-type':'application/json', 'cache-control':'no-store'});
        return res.end(JSON.stringify({heldCustomCount, heldDeleteCount, storedCustom, customRevision, customBodies, templateBodies, deleteRequests, deleteResults, templates, requests}));
      }
      if (url.pathname === '/__release-custom') {
        if (!heldResolve) { res.writeHead(409).end('no held custom request'); return; }
        heldResolve(); heldResolve = null; res.writeHead(200).end(); return;
      }
      if (url.pathname === '/api/presets') {
        requests.push('GET /api/presets'); res.writeHead(200, {'content-type':'application/json'});
        return res.end(JSON.stringify({custom: {...(storedCustom || initialCustom)}, ...(legacyApi ? {} : {custom_revision: customRevision})}));
      }
      if (url.pathname === '/api/presets/templates' && req.method === 'GET') {
        requests.push('GET /api/presets/templates'); res.writeHead(200, {'content-type':'application/json'});
        return res.end(JSON.stringify(templates));
      }
      if (url.pathname === '/api/presets/custom' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const config = JSON.parse(body); customBodies.push(config);
        requests.push('POST /api/presets/custom');
        const failed = failedCustomNames.delete(config.name);
        if (!failed) { storedCustom = {...config, character_name:config.name}; customRevision++; }
        const responseRevision = customRevision;
        if (holdNextCustom) { holdNextCustom = false; heldCustomCount++; await new Promise(resolveHeld => { heldResolve = resolveHeld; }); }
        if (failed) {
          res.writeHead(200, {'content-type':'application/json'}); return res.end('{"success":false}');
        }
        res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({success:true, custom_revision:responseRevision}));
      }
      if (url.pathname.startsWith('/api/presets/templates/') && req.method === 'DELETE') {
        const id = decodeURIComponent(url.pathname.slice('/api/presets/templates/'.length));
        const rawExpected = url.searchParams.get('expected_custom_revision');
        const expected = rawExpected === null ? null : Number(rawExpected);
        deleteRequests.push({id, expectedRevision:expected});
        if (holdNextDelete) { holdNextDelete = false; heldDeleteCount++; await new Promise(resolveHeld => { heldDeleteResolve = resolveHeld; }); }
        const matching = templates.filter(t => t.id === id);
        const activeName = storedCustom?.enabled ? (storedCustom.character_name || '') : '';
        if (expected !== null && matching.some(t => t.name === activeName) && expected !== customRevision) {
          deleteResults.push({id, status:409, expectedRevision:expected, currentRevision:customRevision, activeName});
          res.writeHead(409, {'content-type':'application/json'}); return res.end('{"detail":"Active custom preset changed"}');
        }
        for (let i = templates.length - 1; i >= 0; i--) if (templates[i].id === id) templates.splice(i, 1);
        if (!legacyApi && expected !== null && matching.some(t => t.name === activeName)) {
          storedCustom = { ...storedCustom, character_name:'', system_prompt:'', enabled:false, persona_memory:'', persona_memory_schema:'general' };
          customRevision++;
        }
        deleteResults.push({id, status:200, expectedRevision:expected, currentRevision:customRevision, activeName});
        res.writeHead(200, {'content-type':'application/json'});
        return res.end(JSON.stringify(legacyApi ? {success:true} : {success:true, custom_revision:customRevision}));
      }
      if (url.pathname === '/api/presets/templates' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const item = JSON.parse(body); templateBodies.push(item); requests.push('POST /api/presets/templates');
        const index = templates.findIndex(t => t.name === item.name);
        if (index < 0) templates.push({...item, id:'fixture-template-' + templates.length});
        else templates[index] = {...templates[index], ...item};
        res.writeHead(200, {'content-type':'application/json'}); return res.end('{"success":true}');
      }
      if (url.pathname.startsWith('/api/')) requests.push('UNEXPECTED ' + req.method + ' ' + url.pathname);
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', resolve);
  });
}

async function makePage(origin, errs) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => errs.push(String(e)));
  page.on('request', r => { if (new URL(r.url()).origin !== origin) externalRequests.push(r.url()); });
  await page.goto(origin);
  await page.waitForFunction(() => window.ready === true);
  await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).requests.includes('GET /api/presets/templates'));
  return {context, page};
}

(async () => {
  let contexts = [], errs = [], result;
  try {
    await listen();
    browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE || undefined, args:['--no-sandbox']});
    const origin = `http://127.0.0.1:${server.address().port}`;

    const race = await makePage(origin, errs); contexts.push(race.context);
    const {page} = race;
    await page.locator('#custom-character-name').fill('Synthetic Persona A');
    await page.locator('#custom-system-prompt').fill('Persona A prompt');
    await page.request.get(origin + '/__hold-custom');
    await page.locator('#save-custom-preset').click();
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).heldCustomCount === 1);
    const heldState = await (await page.request.get(origin + '/__state')).json();
    assert.equal(heldState.customBodies[0].name, 'Synthetic Persona A');
    assert.equal(heldState.customBodies[0].system_prompt, 'Persona A prompt');

    await page.locator('#char-template-select').selectOption('Synthetic Builtin B');
    await page.locator('#custom-system-prompt').fill('Unsaved edited B draft');
    const beforeRelease = await page.evaluate(() => ({
      selected: document.querySelector('#char-template-select').value,
      prompt: document.querySelector('#custom-system-prompt').value,
      modalHidden: document.querySelector('#custom-preset-modal').classList.contains('hidden')
    }));
    assert.equal(beforeRelease.selected, 'Synthetic Builtin B');
    assert.equal(beforeRelease.prompt, 'Unsaved edited B draft');
    await page.request.get(origin + '/__release-custom');
    await page.evaluate(() => window.savePromises[0]);
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).templateBodies.some(t => t.name === 'Synthetic Persona A'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const afterRelease = await page.evaluate(() => ({
      selected: document.querySelector('#char-template-select').value,
      name: document.querySelector('#custom-character-name').value,
      prompt: document.querySelector('#custom-system-prompt').value,
      modalHidden: document.querySelector('#custom-preset-modal').classList.contains('hidden'),
      active: p.m.getSelectedPreset(),
      customName: p.m.getAllPresets().custom.character_name,
      customPrompt: p.m.getAllPresets().custom.system_prompt
    }));
    assert.equal(afterRelease.selected, 'Synthetic Builtin B');
    assert.equal(afterRelease.prompt, 'Unsaved edited B draft', 'newer unsaved B draft remains visible after A resolves');
    assert.equal(afterRelease.modalHidden, false, 'A completion leaves the newer B form open');
    assert.equal(afterRelease.active, 'custom', 'the successful A config remains the persisted active custom config');
    assert.equal(afterRelease.customName, 'Synthetic Persona A');
    assert.equal(afterRelease.customPrompt, 'Persona A prompt');
    const persistedA = await (await page.request.get(origin + '/__state')).json();
    assert.equal(persistedA.storedCustom.name, 'Synthetic Persona A', 'fixture accepted A independently of the newer unsaved B form');
    assert(persistedA.templateBodies.some(t => t.name === 'Synthetic Persona A'), 'A autosave classification uses its captured Default selection');

    await page.locator('#close-custom-preset').click();
    await page.evaluate(() => p.m.openCustomPresetModal());
    const reopened = await page.evaluate(() => ({
      selected: document.querySelector('#char-template-select').value,
      name: document.querySelector('#custom-character-name').value,
      prompt: document.querySelector('#custom-system-prompt').value,
      modalHidden: document.querySelector('#custom-preset-modal').classList.contains('hidden')
    }));
    assert.equal(reopened.modalHidden, false);
    assert.equal(reopened.selected, 'Synthetic Persona A');
    assert.equal(reopened.prompt, 'Persona A prompt', 'explicit close/reopen loads the successfully saved A config; B was an unsaved draft');

    const sameForm = await makePage(origin, errs); contexts.push(sameForm.context);
    const samePage = sameForm.page;
    await samePage.locator('#custom-character-name').fill('Same Form A');
    await samePage.locator('#custom-system-prompt').fill('Saved A text');
    await samePage.request.get(origin + '/__hold-custom');
    await samePage.locator('#save-custom-preset').click();
    await samePage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).heldCustomCount === 2);
    await samePage.locator('#custom-system-prompt').fill('Newer same-form draft');
    await samePage.request.get(origin + '/__release-custom');
    await samePage.evaluate(() => window.savePromises[0]);
    await samePage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).templateBodies.some(t => t.name === 'Same Form A'));
    const sameFormState = await samePage.evaluate(() => ({
      prompt: document.querySelector('#custom-system-prompt').value,
      hidden: document.querySelector('#custom-preset-modal').classList.contains('hidden'),
      savedPrompt: p.m.getAllPresets().custom.system_prompt
    }));
    assert.equal(sameFormState.prompt, 'Newer same-form draft');
    assert.equal(sameFormState.hidden, false);
    assert.equal(sameFormState.savedPrompt, 'Saved A text');

    const normal = await makePage(origin, errs); contexts.push(normal.context);
    const normalPage = normal.page;
    await normalPage.locator('#custom-character-name').fill('Normal Persona C');
    await normalPage.locator('#custom-system-prompt').fill('Normal Persona C prompt');
    await normalPage.locator('#save-custom-preset').click();
    await normalPage.evaluate(() => window.savePromises[0]);
    await normalPage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).templateBodies.some(t => t.name === 'Normal Persona C'));
    const normalState = await normalPage.evaluate(() => ({
      hidden: document.querySelector('#custom-preset-modal').classList.contains('hidden'),
      active: p.m.getSelectedPreset(),
      customName: p.m.getAllPresets().custom.character_name,
      customPrompt: p.m.getAllPresets().custom.system_prompt
    }));
    assert.equal(normalState.hidden, true);
    assert.equal(normalState.active, 'custom');
    assert.equal(normalState.customName, 'Normal Persona C');
    assert.equal(normalState.customPrompt, 'Normal Persona C prompt');

    const newerSave = await makePage(origin, errs); contexts.push(newerSave.context);
    const newerPage = newerSave.page;
    await newerPage.locator('#custom-character-name').fill('Older Persona A');
    await newerPage.locator('#custom-system-prompt').fill('Older A prompt');
    await newerPage.request.get(origin + '/__hold-custom');
    await newerPage.locator('#save-custom-preset').click();
    await newerPage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).heldCustomCount === 3);
    await newerPage.locator('#char-template-select').selectOption('Synthetic Builtin B');
    await newerPage.locator('#custom-system-prompt').fill('Newer B prompt');
    await newerPage.locator('#save-custom-preset').click();
    await newerPage.evaluate(() => window.savePromises[1]);
    const afterB = await newerPage.evaluate(() => ({
      hidden: document.querySelector('#custom-preset-modal').classList.contains('hidden'),
      customName: p.m.getAllPresets().custom.character_name,
      customPrompt: p.m.getAllPresets().custom.system_prompt
    }));
    assert.equal(afterB.customName, 'Synthetic Builtin B');
    assert.equal(afterB.customPrompt, 'Newer B prompt');
    assert.equal(afterB.hidden, true);
    const backendAfterB = await (await newerPage.request.get(origin + '/__state')).json();
    assert.equal(backendAfterB.storedCustom.name, 'Synthetic Builtin B');
    await newerPage.request.get(origin + '/__release-custom');
    await newerPage.evaluate(() => window.savePromises[0]);
    await newerPage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).templateBodies.some(t => t.name === 'Older Persona A'));
    const lateAState = await newerPage.evaluate(() => ({
      hidden: document.querySelector('#custom-preset-modal').classList.contains('hidden'),
      customName: p.m.getAllPresets().custom.character_name,
      customPrompt: p.m.getAllPresets().custom.system_prompt,
      toasts: [...p.toasts]
    }));
    const lateABackend = await (await newerPage.request.get(origin + '/__state')).json();
    assert.equal(lateABackend.storedCustom.name, 'Synthetic Builtin B', 'fixture processes B after A; backend therefore retains B');
    assert.equal(lateAState.customName, 'Synthetic Builtin B', 'late A cannot replace the newer accepted B active state');
    assert.equal(lateAState.customPrompt, 'Newer B prompt');
    assert(lateABackend.templateBodies.some(t => t.name === 'Older Persona A'), 'different-name older A template remains an independent save');
    // This is fixture ordering only; the frontend ownership guard makes no server-order guarantee.
    const newerSaveObservation = { afterB, afterLateA: lateAState, backendAfterLateA: lateABackend.storedCustom };

    await page.request.get(origin + '/__reset');
    const sameNameRace = await makePage(origin, errs); contexts.push(sameNameRace.context);
    const sameNamePage = sameNameRace.page;
    await sameNamePage.locator('#custom-character-name').fill('Shared Persona');
    await sameNamePage.locator('#custom-system-prompt').fill('Older A template text');
    await sameNamePage.request.get(origin + '/__hold-custom');
    await sameNamePage.locator('#save-custom-preset').click();
    await sameNamePage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).heldCustomCount === 4);
    await sameNamePage.locator('#custom-system-prompt').fill('Newer B template text');
    const sameNameTemplatePosts = [];
    sameNamePage.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/presets/templates') sameNameTemplatePosts.push(request);
    });
    const newerTemplateResponse = sameNamePage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/presets/templates');
    await sameNamePage.locator('#save-custom-preset').click();
    await sameNamePage.evaluate(() => window.savePromises[1]);
    assert.equal((await newerTemplateResponse).status(), 200);
    await sameNamePage.request.get(origin + '/__release-custom');
    await sameNamePage.evaluate(() => window.savePromises[0]);
    await sameNamePage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const sameNameBackend = await (await sameNamePage.request.get(origin + '/__state')).json();
    const sameNameObservation = await sameNamePage.evaluate(() => ({
      activeName: p.m.getAllPresets().custom.character_name,
      activePrompt: p.m.getAllPresets().custom.system_prompt,
    }));
    sameNameObservation.templatePrompts = sameNameBackend.templateBodies.filter(t => t.name === 'Shared Persona').map(t => t.system_prompt);
    sameNameObservation.storedTemplatePrompt = sameNameBackend.templates.find(t => t.name === 'Shared Persona')?.system_prompt;
    sameNameObservation.storedCustomName = sameNameBackend.storedCustom?.name;
    sameNameObservation.storedCustomPrompt = sameNameBackend.storedCustom?.system_prompt;
    sameNameObservation.templatePostCount = sameNameTemplatePosts.length;
    assert.equal(sameNameObservation.activePrompt, 'Newer B template text');
    assert.deepEqual(sameNameObservation.templatePrompts, ['Newer B template text']);
    assert.equal(sameNameObservation.templatePostCount, 1, 'late older A does not dispatch a same-name template overwrite');
    assert.equal(sameNameObservation.storedTemplatePrompt, 'Newer B template text');
    assert.equal(sameNameObservation.storedCustomPrompt, 'Newer B template text');

    const failedB = await makePage(origin, errs); contexts.push(failedB.context);
    const failedPage = failedB.page;
    const activeBeforeFailedSaves = await failedPage.evaluate(() => p.m.getAllPresets().custom.character_name);
    await failedPage.locator('#custom-character-name').fill('Older Persona Before Failure');
    await failedPage.locator('#custom-system-prompt').fill('Successful A prompt');
    await failedPage.request.get(origin + '/__hold-custom');
    await failedPage.locator('#save-custom-preset').click();
    await failedPage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).heldCustomCount === 5);
    await failedPage.locator('#custom-character-name').fill('Failed Persona B');
    await failedPage.locator('#custom-system-prompt').fill('Rejected B prompt');
    await failedPage.request.get(origin + '/__fail-custom?name=Failed%20Persona%20B');
    await failedPage.locator('#save-custom-preset').click();
    await failedPage.evaluate(() => window.savePromises[1]);
    const afterFailedB = await failedPage.evaluate(() => ({
      activeName: p.m.getAllPresets().custom.character_name,
      errors: [...p.errors],
      toasts: [...p.toasts]
    }));
    assert(afterFailedB.errors.some(x => x === 'Failed to save custom preset'));
    assert.notEqual(afterFailedB.activeName, 'Failed Persona B', 'failed B did not become active');
    assert.equal(afterFailedB.activeName, activeBeforeFailedSaves, 'failed B preserves the previously loaded active state');
    await failedPage.request.get(origin + '/__release-custom');
    await failedPage.evaluate(() => window.savePromises[0]);
    await failedPage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).templateBodies.some(t => t.name === 'Older Persona Before Failure'));
    const afterFailedBLateA = await failedPage.evaluate(() => ({
      activeName: p.m.getAllPresets().custom.character_name,
      activePrompt: p.m.getAllPresets().custom.system_prompt,
      errors: [...p.errors],
      toasts: [...p.toasts]
    }));
    assert.equal(afterFailedBLateA.activeName, 'Older Persona Before Failure', 'failed B does not cancel later successful A');
    assert.equal(afterFailedBLateA.activePrompt, 'Successful A prompt');
    assert.deepEqual(afterFailedBLateA.errors, ['Failed to save custom preset']);
    assert.deepEqual(afterFailedBLateA.toasts, ['Persona saved']);

    const acceptedAThenFailedB = await makePage(origin, errs); contexts.push(acceptedAThenFailedB.context);
    const acceptedPage = acceptedAThenFailedB.page;
    await acceptedPage.locator('#custom-character-name').fill('Accepted Persona A');
    await acceptedPage.locator('#custom-system-prompt').fill('Accepted A prompt');
    await acceptedPage.locator('#save-custom-preset').click();
    await acceptedPage.evaluate(() => window.savePromises[0]);
    await acceptedPage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).templateBodies.some(t => t.name === 'Accepted Persona A'));
    await acceptedPage.locator('#custom-character-name').fill('Failed Persona After A');
    await acceptedPage.locator('#custom-system-prompt').fill('Rejected later B prompt');
    await acceptedPage.request.get(origin + '/__fail-custom?name=Failed%20Persona%20After%20A');
    await acceptedPage.locator('#save-custom-preset').click();
    await acceptedPage.evaluate(() => window.savePromises[1]);
    const acceptedAState = await acceptedPage.evaluate(() => ({
      activeName: p.m.getAllPresets().custom.character_name,
      activePrompt: p.m.getAllPresets().custom.system_prompt,
      errors: [...p.errors],
      toasts: [...p.toasts]
    }));
    assert.equal(acceptedAState.activeName, 'Accepted Persona A', 'failed later B preserves already-accepted A');
    assert.equal(acceptedAState.activePrompt, 'Accepted A prompt');
    assert.deepEqual(acceptedAState.errors, ['Failed to save custom preset']);
    assert.deepEqual(acceptedAState.toasts, ['Persona saved']);

    const deleteSeedUrl = new URL('/__seed', origin);
    deleteSeedUrl.searchParams.set('name', 'Delete Persona A');
    deleteSeedUrl.searchParams.set('prompt', 'Delete A prompt');
    deleteSeedUrl.searchParams.set('revision', '80');
    await normalPage.request.get(deleteSeedUrl.toString());
    const deletePageResult = await makePage(origin, errs); contexts.push(deletePageResult.context);
    const deletePage = deletePageResult.page;
    await deletePage.locator('#char-template-select').selectOption('Delete Persona A');
    await deletePage.locator('#char-delete-template-btn').click();
    await deletePage.waitForFunction(async () => {
      const state = await fetch('/__state').then(r => r.json());
      return state.deleteRequests.some(item => item.id === 'template-Delete Persona A')
        && !state.templates.some(item => item.name === 'Delete Persona A');
    });
    await deletePage.waitForFunction(() => document.querySelector('#char-template-select').value === '__default__');
    const deletedAState = await deletePage.evaluate(() => ({
      selected: p.m.getSelectedPreset(),
      active: p.m.getAllPresets().custom,
      errors: [...p.errors]
    }));
    const deletedABackend = await (await deletePage.request.get(origin + '/__state')).json();
    assert.equal(deletedABackend.deleteRequests.at(-1).expectedRevision, 80);
    assert.equal(deletedABackend.customRevision, 81);
    assert.equal(deletedABackend.storedCustom.enabled, false);
    assert.equal(deletedAState.selected, null);
    assert.equal(deletedAState.active.character_name, '');
    assert.deepEqual(deletedAState.errors, []);
    const afterReload = await makePage(origin, errs); contexts.push(afterReload.context);
    const reloadState = await afterReload.page.evaluate(() => ({
      selected: p.m.getSelectedPreset(),
      custom: p.m.getAllPresets().custom
    }));
    assert.equal(reloadState.selected, null);
    assert.equal(reloadState.custom.enabled, false, 'server revision contract keeps the deleted active persona inactive after reload');
    assert.equal(reloadState.custom.character_name, '');

    const conflictSeed = new URL('/__seed', origin);
    conflictSeed.searchParams.set('name', 'Conflict Persona A');
    conflictSeed.searchParams.set('prompt', 'Original A prompt');
    conflictSeed.searchParams.set('revision', '100');
    await normalPage.request.get(conflictSeed.toString());
    await normalPage.request.get(origin + '/__hold-delete');
    const conflictPageResult = await makePage(origin, errs); contexts.push(conflictPageResult.context);
    const conflictPage = conflictPageResult.page;
    await conflictPage.locator('#char-template-select').selectOption('Conflict Persona A');
    await conflictPage.locator('#char-delete-template-btn').click();
    await conflictPage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).heldDeleteCount === 1);
    await conflictPage.locator('#custom-system-prompt').fill('New accepted A prompt');
    await conflictPage.locator('#save-custom-preset').click();
    await conflictPage.evaluate(() => window.savePromises[0]);
    await conflictPage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).templates.some(item => item.name === 'Conflict Persona A' && item.system_prompt === 'New accepted A prompt'));
    await conflictPage.request.get(origin + '/__release-delete');
    await conflictPage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).deleteResults.length === 2);
    await conflictPage.waitForFunction(() => p.errors.length === 1);
    const conflictState = await conflictPage.evaluate(async () => {
      const state = await fetch('/__state').then(r => r.json());
      return {
        custom: p.m.getAllPresets().custom,
        fieldPrompt: document.querySelector('#custom-system-prompt').value,
        selected: document.querySelector('#char-template-select').value,
        errors: [...p.errors],
        templates: state.templates,
        deleteRequest: state.deleteRequests.at(-1),
        deleteResult: state.deleteResults.at(-1),
        serverRevision: state.customRevision
      };
    });
    assert.equal(conflictState.deleteRequest.expectedRevision, 100);
    assert.equal(conflictState.serverRevision, 101);
    assert.equal(conflictState.custom.character_name, 'Conflict Persona A');
    assert.equal(conflictState.custom.system_prompt, 'New accepted A prompt');
    assert.equal(conflictState.fieldPrompt, 'New accepted A prompt');
    assert.equal(conflictState.selected, 'Conflict Persona A');
    assert(conflictState.templates.some(item => item.name === 'Conflict Persona A'));
    assert.deepEqual(conflictState.errors, ['Persona settings changed while deletion was pending. Copy unsaved edits, then reload the page before retrying if deletion is still intended.']);

    const newerBSeed = new URL('/__seed', origin);
    newerBSeed.searchParams.set('name', 'Delete A Keep B');
    newerBSeed.searchParams.set('prompt', 'A prompt before B');
    newerBSeed.searchParams.set('other', 'Active B');
    newerBSeed.searchParams.set('revision', '200');
    await normalPage.request.get(newerBSeed.toString());
    await normalPage.request.get(origin + '/__hold-delete');
    const newerBPageResult = await makePage(origin, errs); contexts.push(newerBPageResult.context);
    const newerBPage = newerBPageResult.page;
    await newerBPage.locator('#char-template-select').selectOption('Delete A Keep B');
    await newerBPage.locator('#char-delete-template-btn').click();
    await newerBPage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).heldDeleteCount === 2);
    await newerBPage.locator('#char-template-select').selectOption('Active B');
    await newerBPage.locator('#custom-system-prompt').fill('New active B prompt');
    await newerBPage.locator('#save-custom-preset').click();
    await newerBPage.evaluate(() => window.savePromises[0]);
    await newerBPage.request.get(origin + '/__release-delete');
    await newerBPage.waitForFunction(async () => {
      const state = await fetch('/__state').then(r => r.json());
      return !state.templates.some(item => item.name === 'Delete A Keep B') && p.errors.length === 0;
    });
    const newerBDeleteState = await newerBPage.evaluate(async () => {
      const state = await fetch('/__state').then(r => r.json());
      return {
        active: p.m.getAllPresets().custom,
        selected: p.m.getSelectedPreset(),
        fieldPrompt: document.querySelector('#custom-system-prompt').value,
        templates: state.templates,
        request: state.deleteRequests.at(-1),
        revision: state.customRevision
      };
    });
    assert.equal(newerBDeleteState.request.expectedRevision, 200);
    assert.equal(newerBDeleteState.revision, 201);
    assert.equal(newerBDeleteState.active.character_name, 'Active B');
    assert.equal(newerBDeleteState.active.system_prompt, 'New active B prompt');
    assert.equal(newerBDeleteState.fieldPrompt, 'New active B prompt');
    assert.equal(newerBDeleteState.selected, 'custom');
    assert(newerBDeleteState.templates.some(item => item.name === 'Active B'));
    assert(!newerBDeleteState.templates.some(item => item.name === 'Delete A Keep B'));

    const legacySeed = new URL('/__seed', origin);
    legacySeed.searchParams.set('name', 'Legacy API Persona');
    legacySeed.searchParams.set('prompt', 'Legacy prompt');
    legacySeed.searchParams.set('revision', '300');
    await normalPage.request.get(legacySeed.toString());
    await normalPage.request.get(origin + '/__legacy?enabled=1');
    const legacyPageResult = await makePage(origin, errs); contexts.push(legacyPageResult.context);
    const legacyPage = legacyPageResult.page;
    await legacyPage.locator('#char-template-select').selectOption('Legacy API Persona');
    await legacyPage.locator('#char-delete-template-btn').click();
    await legacyPage.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).deleteRequests.some(item => item.id === 'template-Legacy API Persona'));
    const legacyState = await (await legacyPage.request.get(origin + '/__state')).json();
    const legacyErrors = await legacyPage.evaluate(() => p.errors);
    assert.equal(legacyState.deleteRequests.at(-1).expectedRevision, null, 'older API without a revision receives legacy DELETE without query');
    assert.deepEqual(legacyErrors, []);
    await legacyPage.request.get(origin + '/__legacy?enabled=0');

    const finalState = await (await normalPage.request.get(origin + '/__state')).json();
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(errs, []);
    assert(!finalState.requests.some(x => typeof x === 'string' && x.startsWith('UNEXPECTED')));
    result = {
      pass: true,
      sourceRoot: repo,
      sourceHash,
      heldA: { request: heldState.customBodies[0], beforeRelease, afterRelease, reopened },
      sameFormEdit: sameFormState,
      normalSave: normalState,
      newerSaveObservation,
      sameNameTemplateObservation: sameNameObservation,
      newerFailureThenOlderSuccess: { afterFailedB, afterFailedBLateA },
      acceptedAThenFailedB: acceptedAState,
      customRevisionDelete: { deletedAState, deletedABackend, reloadState, conflictState, newerBDeleteState, legacyDelete: { expectedRevision: legacyState.deleteRequests.at(-1).expectedRevision, errors: legacyErrors } },
      finalRequestSummary: { customNames: finalState.customBodies.map(x => x.name), templateNames: finalState.templateBodies.map(x => x.name) },
      externalRequests,
      pageErrors: errs,
      scope: 'Actual frozen static/js/presets.js and its real modal/template event handlers; exact app.js caller behavior represented by its sole save-button callback; synthetic loopback only.'
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    if (heldResolve) { heldResolve(); heldResolve = null; }
    if (heldDeleteResolve) { heldDeleteResolve(); heldDeleteResolve = null; }
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
