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
const initialCustom = { name: 'Custom', enabled: false, temperature: 1, max_tokens: 0, system_prompt: '', reasoning_mode: 'auto', thinking_mode: '', persona_memory: '', persona_memory_schema: 'general' };
let server, browser, revision = 0, guardCapability = true, bundleCapability = true;
let custom = { ...initialCustom }, templates = [], holdNextCustom = false, heldCustom = null;
let holdNextTemplateGet = false, heldTemplateGet = null, holdNextAck = false, heldAck = null, failBundleNext = false, omitBundleAckNext = false;
const posts = [], templatePosts = [], requests = [];

const html = `<!doctype html><meta charset="utf-8">
<div id="custom-preset-modal" class="modal"><div class="modal-content">
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
import m from '/static/js/presets.js';
window.p = { m, errors: [], toasts: [], saves: [] };
window.uiModule = { showError: x => p.errors.push(x), showToast: x => p.toasts.push(x) };
window.styledConfirm = async () => true;
m.init(location.origin);
window.startup = m.loadPresets(uiModule.showError);
await window.startup;
window.reloadPresets = () => m.loadPresets(uiModule.showError);
window.startSave = () => { p.saves.push(m.saveCustomPreset(uiModule.showToast, uiModule.showError)); return p.saves.length - 1; };
window.waitSave = index => p.saves[index];
window.setTab = name => document.querySelectorAll('.preset-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.chartab === name));
window.ready = true;
</script>`;

function json(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function upsertTemplate(template) {
  const index = templates.findIndex(item => item.id === template.id || item.name === template.name);
  if (index < 0) templates.push(template);
  else templates[index] = template;
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
      if (url.pathname === '/__state') return json(res, 200, { revision, custom, templates, posts, templatePosts, requests, templateGetHeld: !!heldTemplateGet, ackHeld: !!heldAck });
      if (url.pathname === '/__hold-custom') { holdNextCustom = true; return res.writeHead(200).end(); }
      if (url.pathname === '/__release-custom') {
        if (!heldCustom) return res.writeHead(404).end();
        heldCustom(); heldCustom = null; return res.writeHead(200).end();
      }
      if (url.pathname === '/__hold-template-get') { holdNextTemplateGet = true; return res.writeHead(200).end(); }
      if (url.pathname === '/__release-template-get') {
        if (!heldTemplateGet) return res.writeHead(404).end();
        heldTemplateGet(); heldTemplateGet = null; return res.writeHead(200).end();
      }
      if (url.pathname === '/__hold-ack') { holdNextAck = true; return res.writeHead(200).end(); }
      if (url.pathname === '/__release-ack') {
        if (!heldAck) return res.writeHead(404).end();
        heldAck(); heldAck = null; return res.writeHead(200).end();
      }
      if (url.pathname === '/__bundle-false') { failBundleNext = true; return res.writeHead(200).end(); }
      if (url.pathname === '/__bundle-omit') { omitBundleAckNext = true; return res.writeHead(200).end(); }
      if (url.pathname === '/__capabilities') {
        guardCapability = url.searchParams.get('guard') !== '0';
        bundleCapability = url.searchParams.get('bundle') !== '0';
        return res.writeHead(200).end();
      }
      if (url.pathname === '/api/presets' && req.method === 'GET') {
        requests.push({ method: 'GET', path: 'presets' });
        return json(res, 200, { custom: { ...custom }, custom_revision: revision, ...(guardCapability ? { custom_save_revision_guard: true } : {}), ...(bundleCapability ? { custom_template_autosave: true } : {}) });
      }
      if (url.pathname === '/api/presets/templates' && req.method === 'GET') {
        requests.push({ method: 'GET', path: 'templates' });
        const snapshot = templates.map(item => ({ ...item }));
        if (holdNextTemplateGet) {
          holdNextTemplateGet = false;
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.write('[');
          await new Promise(release => { heldTemplateGet = release; });
          if (!res.destroyed) res.end(JSON.stringify(snapshot).slice(1));
          return;
        }
        return json(res, 200, snapshot);
      }
      if (url.pathname === '/api/presets/custom' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        const expected = url.searchParams.has('expected_custom_revision') ? Number(url.searchParams.get('expected_custom_revision')) : null;
        const candidate = body.template_autosave || null;
        posts.push({ name: body.name, expected, template: candidate ? { ...candidate } : null });
        requests.push({ method: 'POST', path: 'custom', name: body.name, expected });
        if (guardCapability && expected !== revision) return json(res, 409, { success: false, message: 'revision conflict', custom_revision: revision });
        if (holdNextCustom) {
          holdNextCustom = false;
          await new Promise(release => { heldCustom = release; });
        }
        const { template_autosave: _ignored, ...customBody } = body;
        custom = { ...customBody, character_name: body.name };
        revision += 1;
        let templateSave;
        if (candidate) {
          if (failBundleNext) {
            failBundleNext = false;
            templateSave = { success: false, message: 'synthetic bundle rejected' };
          } else {
            upsertTemplate(candidate);
            if (!omitBundleAckNext) templateSave = { success: true, template: { ...candidate } };
            else omitBundleAckNext = false;
          }
        }
        const result = { success: true, custom_revision: revision, ...(guardCapability ? { custom_save_revision_guard: true } : {}), ...(bundleCapability ? { custom_template_autosave: true } : {}), ...(templateSave ? { template_save: templateSave } : {}) };
        if (holdNextAck) {
          holdNextAck = false;
          await new Promise(release => { heldAck = release; });
        }
        if (res.destroyed) return;
        return json(res, 200, result);
      }
      if (url.pathname === '/api/presets/templates' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const template = JSON.parse(raw); templatePosts.push(template); requests.push({ method: 'POST', path: 'templates', name: template.name });
        upsertTemplate(template);
        return json(res, 200, { success: true });
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', resolve);
  });
}
async function waitFor(page, fn, label, timeout = 8000) {
  await page.waitForFunction(fn, null, { timeout }).catch(error => { throw new Error(`Timed out waiting for ${label}: ${error.message}`); });
}
async function state(page) { return page.request.get(`${origin}/__state`).then(response => response.json()); }
async function fill(page, name, prompt) {
  await page.locator('#custom-character-name').fill(name);
  await page.locator('#custom-system-prompt').fill(prompt);
}
async function begin(page) { return page.evaluate(() => window.startSave()); }
async function finish(page, index) { await page.evaluate(i => window.waitSave(i), index); }

const errors = [];
let origin;
(async () => {
  const contexts = [];
  try {
    await listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
    origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext(); contexts.push(context);
    const page = await context.newPage(); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(String(error)));
    await page.goto(origin); await waitFor(page, () => window.ready === true, 'module ready');

    // Pending character is available to Group while its saved-template dropdown remains confirmed-only.
    await fill(page, 'Shared Persona', 'captured A');
    await page.request.get(`${origin}/__hold-custom`);
    const saveA = await begin(page);
    await waitFor(page, async () => (await fetch('/__state').then(response => response.json())).posts.length === 1, 'A custom POST');
    let current = await state(page);
    const idA = current.posts[0].template.id;
    assert(idA && current.posts[0].template.system_prompt === 'captured A');
    assert.equal(await page.evaluate(() => p.m.getUserTemplates().find(item => item.name === 'Shared Persona')?.system_prompt), 'captured A');
    assert.equal(await page.locator('#char-template-select option[value="Shared Persona"]').count(), 0, 'pending template does not enter the confirmed saved-template dropdown');
    await fill(page, 'Shared Persona', 'captured B');
    const saveB = await begin(page);
    await page.request.get(`${origin}/__release-custom`);
    await finish(page, saveA);
    await waitFor(page, async () => (await fetch('/__state').then(response => response.json())).posts.length === 2, 'B queued custom POST');
    current = await state(page);
    assert.equal(current.posts[1].template.id, idA, 'queued same-name save reuses the confirmed ID');
    assert.equal(current.posts[1].template.system_prompt, 'captured B');
    await finish(page, saveB);
    current = await state(page);
    assert.equal(current.templates.length, 1);
    assert.equal(current.templates[0].system_prompt, 'captured B');
    assert.equal(await page.evaluate(() => p.m.getUserTemplates().find(item => item.name === 'Shared Persona')?.system_prompt), 'captured B');

    // Different names retain both bundled entries.
    await fill(page, 'Separate A', 'A template');
    const separateA = await begin(page); await finish(page, separateA);
    await fill(page, 'Separate B', 'B template');
    const separateB = await begin(page); await finish(page, separateB);
    current = await state(page);
    assert.deepEqual(current.templates.filter(item => item.name.startsWith('Separate')).map(item => item.name), ['Separate A', 'Separate B']);

    // A stale template GET cannot overwrite a bundled confirmation.
    await page.request.get(`${origin}/__hold-template-get`);
    const staleLoad = page.evaluate(() => window.reloadPresets());
    await waitFor(page, async () => (await fetch('/__state').then(response => response.json())).templateGetHeld, 'held template GET');
    await fill(page, 'Refresh Race', 'bundled refresh race');
    const refreshSave = await begin(page); await finish(page, refreshSave);
    await page.request.get(`${origin}/__release-template-get`);
    await staleLoad;
    await page.waitForTimeout(50);
    current = await state(page);
    assert(current.templates.some(item => item.name === 'Refresh Race'));
    assert.equal(await page.evaluate(() => p.m.getUserTemplates().find(item => item.name === 'Refresh Race')?.system_prompt), 'bundled refresh race');

    // Explicit template rejection is reported separately from accepted custom settings.
    await page.request.get(`${origin}/__bundle-false`);
    await fill(page, 'Template Rejected', 'custom still saves');
    const rejected = await begin(page); await finish(page, rejected);
    current = await state(page);
    assert.equal(current.custom.character_name, 'Template Rejected');
    assert(!current.templates.some(item => item.name === 'Template Rejected'));
    assert((await page.evaluate(() => p.errors)).some(message => message.includes('Persona saved') && message.includes('reusable template')));
    assert.equal(await page.evaluate(() => p.m.getUserTemplates().find(item => item.name === 'Template Rejected')), undefined, 'confirmed bundle failure removes the optimistic template choice');

    await page.request.get(`${origin}/__bundle-omit`);
    await fill(page, 'Bundle ACK Missing', 'server wrote but omitted result');
    const missingAck = await begin(page); await finish(page, missingAck);
    current = await state(page);
    const missingAckId = current.templates.find(item => item.name === 'Bundle ACK Missing').id;
    assert.equal(current.custom.character_name, 'Bundle ACK Missing', 'missing template result does not undo accepted custom save');
    assert.equal(await page.evaluate(() => p.m.getUserTemplates().find(item => item.name === 'Bundle ACK Missing')?.id), missingAckId, 'missing bundle result retains its stable pending ID');
    assert((await page.evaluate(() => p.errors)).some(message => message.includes('Persona saved') && message.includes('reusable template')));
    await fill(page, 'Bundle ACK Missing', 'user-directed confirmation retry');
    const missingAckRetry = await begin(page); await finish(page, missingAckRetry);
    current = await state(page);
    assert.equal(current.posts.at(-1).template.id, missingAckId);
    assert.equal(current.templates.filter(item => item.name === 'Bundle ACK Missing').length, 1);

    // A committed template with a missing ACK keeps its ID through 409 and explicit retry.
    await page.request.get(`${origin}/__hold-ack`);
    await fill(page, 'Uncertain Same Name', 'committed before dropped ACK');
    const uncertainA = await begin(page);
    await page.waitForFunction(async () => {
      const value = await fetch('/__state').then(response => response.json());
      return value.ackHeld && value.templates.some(item => item.name === 'Uncertain Same Name');
    });
    await finish(page, uncertainA);
    current = await state(page);
    const uncertainId = current.templates.find(item => item.name === 'Uncertain Same Name').id;
    const afterAmbiguous = await page.evaluate(() => ({ templates: p.m.getUserTemplates(), errors: p.errors }));
    assert.equal(afterAmbiguous.templates.find(item => item.name === 'Uncertain Same Name')?.id, uncertainId, `ambiguous template ACK retains its pending ID: ${JSON.stringify({ afterAmbiguous, posts: current.posts, revision: current.revision })}`);
    await page.request.get(`${origin}/__release-ack`);
    await fill(page, 'Uncertain Same Name', 'queued B after ambiguity');
    const uncertainB = await begin(page); await finish(page, uncertainB);
    current = await state(page);
    assert.equal(current.posts.at(-1).template.id, uncertainId, 'same-name B preserves the ambiguous A ID');
    assert.equal(current.templates.find(item => item.name === 'Uncertain Same Name').system_prompt, 'committed before dropped ACK', '409 does not rewrite the prior committed template');
    assert.equal(await page.evaluate(() => p.m.getUserTemplates().find(item => item.name === 'Uncertain Same Name')?.id), uncertainId, '409 retains the uncertain entry for user-directed retry');
    assert.equal(await page.evaluate(() => p.m.getUserTemplates().find(item => item.name === 'Uncertain Same Name')?.system_prompt), 'committed before dropped ACK', '409 restores the earlier uncertain entry instead of showing rejected B');
    await page.request.get(`${origin}/__bundle-false`);
    await fill(page, 'Uncertain Same Name', 'explicit retry');
    const retry = await begin(page); await finish(page, retry);
    current = await state(page);
    assert.equal(current.posts.at(-1).template.id, uncertainId);
    assert.equal(current.templates.filter(item => item.name === 'Uncertain Same Name').length, 1);
    assert.equal(current.templates.find(item => item.name === 'Uncertain Same Name').system_prompt, 'committed before dropped ACK', 'explicit template failure restores the earlier uncertain template');
    assert.equal(await page.evaluate(() => p.m.getUserTemplates().find(item => item.name === 'Uncertain Same Name')?.system_prompt), 'committed before dropped ACK');
    await fill(page, 'Uncertain Same Name', 'final explicit retry');
    const finalRetry = await begin(page); await finish(page, finalRetry);
    current = await state(page);
    assert.equal(current.posts.at(-1).template.id, uncertainId);
    assert.equal(current.templates.filter(item => item.name === 'Uncertain Same Name').length, 1);
    assert.equal(current.templates.find(item => item.name === 'Uncertain Same Name').system_prompt, 'final explicit retry');

    // Built-in and Inject saves never send bundled template payloads.
    await page.locator('#char-template-select').selectOption('Socrates');
    await fill(page, 'Socrates', 'builtin prompt');
    const builtin = await begin(page); await finish(page, builtin);
    assert.equal((await state(page)).posts.at(-1).template, null);
    await page.evaluate(() => window.setTab('inject'));
    await fill(page, 'Stale character name', 'stale prompt ignored for Inject');
    const inject = await begin(page); await finish(page, inject);
    assert.equal((await state(page)).posts.at(-1).template, null);

    // Modern custom CAS without the bundle capability retains the separate endpoint fallback.
    await page.request.get(`${origin}/__capabilities?bundle=0&guard=1`);
    await page.evaluate(() => p.m.loadPresets(uiModule.showError));
    await page.evaluate(() => window.setTab('character'));
    await page.locator('#char-template-select').selectOption('__default__');
    await fill(page, 'Legacy Template Fallback', 'fallback prompt');
    const fallback = await begin(page); await finish(page, fallback);
    await waitFor(page, async () => (await fetch('/__state').then(response => response.json())).templatePosts.some(item => item.name === 'Legacy Template Fallback'), 'legacy endpoint fallback');
    current = await state(page);
    assert.equal(current.posts.at(-1).template, null, 'old server receives unchanged custom POST body');
    assert(current.templates.some(item => item.name === 'Legacy Template Fallback'), JSON.stringify({ current, fallbackPosts: current.templatePosts }));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ pass: true, sourceHash, cases: ['same-name queued ID reuse', 'different-name persistence', 'stale GET protection', 'separate template rejection', 'ambiguous ACK then 409 plus bundle-false restore, then explicit retry same ID', 'built-in and Inject skip', 'legacy separate endpoint fallback'], templates: current.templates.length, posts: current.posts.length }));
  } finally {
    if (heldCustom) { heldCustom(); heldCustom = null; }
    if (heldTemplateGet) { heldTemplateGet(); heldTemplateGet = null; }
    if (heldAck) { heldAck(); heldAck = null; }
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
