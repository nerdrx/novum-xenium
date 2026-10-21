const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const staticRoot = path.join(repo, 'static');
const groupPath = path.join(staticRoot, 'js/group.js');
const presetsPath = path.join(staticRoot, 'js/presets.js');
const groupSource = fs.readFileSync(groupPath, 'utf8');
const presetsSource = fs.readFileSync(presetsPath, 'utf8');
const groupSeam = 'async function _getCharacterList()';
assert.equal(groupSource.split(groupSeam).length - 1, 1, 'test seam remains unique');
const servedGroup = groupSource.replace(groupSeam, 'export async function _getCharacterList()');
const presetsLoadSeam = 'userTemplates = templates;';
assert.equal(presetsSource.split(presetsLoadSeam).length - 1, 1, 'template cache update seam remains unique');
const servedPresets = presetsSource.replace(presetsLoadSeam,
  `${presetsLoadSeam} window.__templateLoadsApplied = (window.__templateLoadsApplied || 0) + 1;`);
const sourceHash = crypto.createHash('sha256').update(groupSource).digest('hex');
let server, browser, origin, templates = [], postCount = 0, getCount = 0;
let postWaiters = new Map(), holdNextGet = false, nextGetStatus = 200, releaseGet = null, heldGetCount = 0;
let externalRequests = [], pageErrors = [], diagnostics = [];

const html = `<!doctype html><meta charset="utf-8">
<div class="preset-tab active" data-chartab="character"></div>
<div class="preset-chartab" data-chartab-panel="character"></div>
<select id="char-template-select"><option value="__default__">Default</option></select>
<input id="custom-character-name" value="New In Flight">
<input id="custom-temperature" value="1">
<input id="custom-max-tokens" value="0">
<textarea id="custom-system-prompt">Synthetic prompt A</textarea>
<select id="custom-reasoning-mode"><option value="auto" selected>auto</option></select>
<select id="custom-thinking-mode"><option value=""></option><option>on</option></select>
<input id="custom-show-persona-name" type="checkbox" checked>
<input id="inject-prefix"><input id="inject-suffix">
<script type="module">
import { saveCustomPreset, getUserTemplates, init } from '/static/js/presets.js?v=20260908personaname1';
import group, { _getCharacterList } from '/static/js/group.js?v=20261007usability1';
window.__templateLoadsApplied = 0;
window.proof = { saveCustomPreset, getUserTemplates, init, group, getCharacterList: _getCharacterList };
window.errors = [];
window.uiModule = { showError: message => window.errors.push(message) };
window.proof.init(location.origin);
window.ready = true;
</script>`;

function listen() {
  return new Promise(resolve => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') { res.writeHead(200, {'content-type':'text/html'}); return res.end(html); }
      if (url.pathname.startsWith('/static/')) {
        const filename = path.resolve(staticRoot, '.' + url.pathname.slice('/static'.length));
        if (!filename.startsWith(staticRoot + path.sep) || !fs.existsSync(filename)) { res.writeHead(404).end(); return; }
        res.writeHead(200, {'content-type':'text/javascript; charset=utf-8'});
        return res.end(filename === groupPath ? servedGroup : filename === presetsPath ? servedPresets : fs.readFileSync(filename));
      }
      if (url.pathname === '/__state') {
        res.writeHead(200, {'content-type':'application/json'});
        return res.end(JSON.stringify({postCount, getCount, heldGetCount, templates}));
      }
      if (url.pathname === '/__hold-next-get') { holdNextGet = true; nextGetStatus = Number(url.searchParams.get('status') || 200); res.writeHead(200).end(); return; }
      if (url.pathname === '/__release-get') { releaseGet?.(); releaseGet = null; res.writeHead(200).end(); return; }
      if (url.pathname === '/__release-post') {
        const id = Number(url.searchParams.get('id'));
        const outcome = url.searchParams.get('outcome');
        const release = postWaiters.get(id);
        if (!release) { res.writeHead(404).end(); return; }
        release(outcome); postWaiters.delete(id); res.writeHead(200).end(); return;
      }
      if (url.pathname === '/api/presets/templates' && req.method === 'GET') {
        getCount++;
        const snapshot = templates.map(entry => ({...entry}));
        const responseStatus = nextGetStatus; nextGetStatus = 200;
        if (holdNextGet) { holdNextGet = false; heldGetCount++; await new Promise(r => { releaseGet = r; }); }
        if (responseStatus !== 200) { res.writeHead(responseStatus).end('fixture failure'); return; }
        res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify(snapshot));
      }
      if (url.pathname === '/api/presets/templates' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const entry = JSON.parse(body), id = ++postCount;
        const outcome = await new Promise(resolvePost => { postWaiters.set(id, resolvePost); });
        if (outcome === 'success') templates = [...templates.filter(t => t.name !== entry.name), {...entry, id: 'server-' + id}];
        res.writeHead(200, {'content-type':'application/json'});
        return res.end(JSON.stringify({success: outcome === 'success'}));
      }
      if (url.pathname === '/api/presets/custom' && req.method === 'POST') {
        for await (const _chunk of req) {}
        res.writeHead(200, {'content-type':'application/json'}); return res.end('{"success":true}');
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
}

async function openPage() {
  const context = await browser.newContext(), page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => diagnostics.push('console: '+m.type()+': '+m.text()));
  page.on('requestfailed', r => diagnostics.push('requestfailed: '+r.url()+' '+r.failure()?.errorText));
  page.on('request', r => { if (new URL(r.url()).origin !== origin) externalRequests.push(r.url()); });
  await page.goto(origin); await page.waitForFunction(() => window.ready);
  await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).getCount >= 1);
  return {context, page};
}
async function save(page, prompt) {
  await page.locator('#custom-system-prompt').fill(prompt);
  await page.evaluate(() => window.proof.saveCustomPreset(() => {}, e => window.errors.push(e)));
  await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).postCount >= Number(window.expectedPosts));
}
async function state(page) { return page.evaluate(() => window.proof.getUserTemplates().map(t => ({id:t.id,name:t.name,system_prompt:t.system_prompt}))); }
async function releasePost(page, id, outcome) { await page.request.get(`${origin}/__release-post?id=${id}&outcome=${outcome}`); }

(async () => {
  try {
    await listen();
    browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE || undefined, args:['--no-sandbox']});

    // New personas must appear in Group while the async template POST is pending.
    templates=[]; postCount=0; getCount=0; heldGetCount=0; postWaiters=new Map(); holdNextGet=false;
    let {context,page}=await openPage();
    await page.evaluate(() => { window.expectedPosts = 1; });
    const firstPost = page.waitForRequest(r => r.url().endsWith('/api/presets/templates') && r.method()==='POST');
    await save(page, 'Synthetic prompt A'); await firstPost;
    const initialPending = await state(page);
    assert.equal(initialPending.length, 1); assert(initialPending[0].id); const stableId=initialPending[0].id;
    const dropdownWhileHeld = await page.locator('#char-template-select option').allTextContents();
    assert(!dropdownWhileHeld.includes('New In Flight'), 'pending entry must not appear in the confirmed saved-template dropdown');
    const visibleWhileHeld = await page.evaluate(async () => (await window.proof.getCharacterList()).map(c => ({id:c.id,name:c.name,prompt:c.prompt})));
    assert(visibleWhileHeld.some(c => c.name==='New In Flight' && c.id===stableId && c.prompt==='Synthetic prompt A'));
    assert.deepEqual(templates, [], 'Group GET returned old server list while template POST remained held');
    await page.request.get(origin+'/__hold-next-get'); await releasePost(page,1,'false');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).heldGetCount === 1);
    assert((await page.evaluate(() => window.errors)).some(e => /Persona saved, but reusable template save could not be confirmed/.test(e)), 'save failure is reported before refresh completes');
    assert.deepEqual(await state(page), [], 'failed pending entry disappears before held reconciliation GET is released');
    await page.request.get(origin+'/__release-get');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).getCount >= 3);
    assert.deepEqual(await state(page), []);
    await context.close();

    // A later same-name save must own the shared pending slot when an older failure settles.
    templates=[]; postCount=0; getCount=0; heldGetCount=0; postWaiters=new Map(); holdNextGet=false;
    ({context,page}=await openPage());
    await page.evaluate(() => { window.expectedPosts = 1; });
    const oldPost=page.waitForRequest(r => r.url().endsWith('/api/presets/templates') && r.method()==='POST');
    await save(page,'Older prompt'); await oldPost;
    const oldEntry=(await state(page))[0];
    await page.evaluate(() => { window.expectedPosts = 2; });
    const newPost=page.waitForRequest(r => r.url().endsWith('/api/presets/templates') && r.method()==='POST');
    await save(page,'Newer prompt'); await newPost;
    const newestWhileBothHeld=(await state(page))[0];
    assert.equal(newestWhileBothHeld.id,oldEntry.id,'same-name overlap reuses the nonempty pending ID');
    assert.equal(newestWhileBothHeld.system_prompt,'Newer prompt');
    await page.request.get(origin+'/__hold-next-get'); await releasePost(page,1,'false');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).heldGetCount === 1);
    assert((await page.evaluate(() => window.errors)).some(e => /Persona saved, but reusable template save could not be confirmed/.test(e)), 'older save failure is reported immediately');
    const afterOldFailure=(await state(page))[0];
    assert.equal(afterOldFailure.id,oldEntry.id); assert.equal(afterOldFailure.system_prompt,'Newer prompt');
    const newerStillGroupVisible=await page.evaluate(async () => (await window.proof.getCharacterList()).map(c => ({id:c.id,name:c.name,prompt:c.prompt})));
    assert(newerStillGroupVisible.some(c => c.id===oldEntry.id && c.name==='New In Flight' && c.prompt==='Newer prompt'));
    await page.request.get(origin+'/__release-get');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).getCount >= 4);
    assert.equal((await state(page))[0].system_prompt,'Newer prompt');
    await releasePost(page,2,'success');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).getCount >= 5);
    const confirmed=await state(page);
    assert.equal(confirmed.length,1); assert.equal(confirmed[0].name,'New In Flight'); assert.equal(confirmed[0].system_prompt,'Newer prompt');
    assert.deepEqual(templates.map(t=>t.name),['New In Flight']);
    await context.close();

    // An older successful-save refresh must not overwrite a newer same-name save.
    templates=[]; postCount=0; getCount=0; heldGetCount=0; postWaiters=new Map(); holdNextGet=false;
    ({context,page}=await openPage());
    await page.evaluate(() => { window.expectedPosts = 1; });
    await page.request.get(origin+'/__hold-next-get');
    const oldSnapshotPost=page.waitForRequest(r => r.url().endsWith('/api/presets/templates') && r.method()==='POST');
    await save(page,'Older snapshot prompt'); await oldSnapshotPost;
    await releasePost(page,1,'success');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).heldGetCount === 1);
    const heldOldSnapshot=templates.map(entry=>({...entry}));
    assert.equal(heldOldSnapshot[0].system_prompt,'Older snapshot prompt');
    await page.evaluate(() => { window.expectedPosts = 2; });
    const newerSnapshotPost=page.waitForRequest(r => r.url().endsWith('/api/presets/templates') && r.method()==='POST');
    await save(page,'Newer snapshot prompt'); await newerSnapshotPost;
    await releasePost(page,2,'success');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).getCount >= 3);
    const newerSnapshotApplied=await state(page);
    assert.equal(newerSnapshotApplied[0].system_prompt,'Newer snapshot prompt');
    const dropdownAfterNewerSnapshot=await page.locator('#char-template-select').evaluate(el=>el.innerHTML);
    const appliedBeforeOldResponse=await page.evaluate(()=>window.__templateLoadsApplied);
    const oldResponse=page.waitForResponse(r=>r.url().endsWith('/api/presets/templates') && r.request().method()==='GET');
    await page.request.get(origin+'/__release-get');
    await oldResponse;
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
    const afterStaleSnapshot=await state(page);
    assert.equal(afterStaleSnapshot[0].system_prompt,'Newer snapshot prompt', 'older GET snapshot must not overwrite newer confirmed save');
    assert.equal(await page.locator('#char-template-select').evaluate(el=>el.innerHTML),dropdownAfterNewerSnapshot,
      'stale GET must not repopulate or mutate the saved-template selector');
    assert.equal(await page.evaluate(()=>window.__templateLoadsApplied),appliedBeforeOldResponse,
      'stale GET snapshot must not be applied');
    assert.deepEqual(await page.evaluate(()=>window.errors),[], 'stale successful response must not report an error');
    await context.close();

    // A stale failed refresh must not warn after a newer refresh succeeded.
    templates=[]; postCount=0; getCount=0; heldGetCount=0; postWaiters=new Map(); holdNextGet=false;
    ({context,page}=await openPage());
    await page.evaluate(() => { window.expectedPosts = 1; });
    await page.request.get(origin+'/__hold-next-get?status=503');
    const failedRefreshPost=page.waitForRequest(r => r.url().endsWith('/api/presets/templates') && r.method()==='POST');
    await save(page,'Older failing refresh'); await failedRefreshPost;
    await releasePost(page,1,'success');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).heldGetCount === 1);
    await page.evaluate(() => { window.expectedPosts = 2; });
    const successRefreshPost=page.waitForRequest(r => r.url().endsWith('/api/presets/templates') && r.method()==='POST');
    await save(page,'Newer successful refresh'); await successRefreshPost;
    await releasePost(page,2,'success');
    await page.waitForFunction(async () => (await fetch('/__state').then(r => r.json())).getCount >= 3);
    const stateBeforeStaleFailure=await state(page);
    const selectorBeforeStaleFailure=await page.locator('#char-template-select').evaluate(el=>el.innerHTML);
    const staleFailureResponse=page.waitForResponse(r=>r.url().endsWith('/api/presets/templates') && r.request().method()==='GET');
    await page.request.get(origin+'/__release-get');
    await staleFailureResponse;
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
    assert.equal((await state(page))[0].system_prompt,stateBeforeStaleFailure[0].system_prompt);
    assert.equal(await page.locator('#char-template-select').evaluate(el=>el.innerHTML),selectorBeforeStaleFailure);
    assert.deepEqual(await page.evaluate(()=>window.errors),[], 'stale failed refresh must not warn after newer success');
    await context.close();

    assert.deepEqual(externalRequests,[]); assert.deepEqual(pageErrors,[]);
    console.log(JSON.stringify({pass:true,groupSourceHash:sourceHash,heldPostAvailability:visibleWhileHeld,dropdownWhileHeld,
      failedPendingRemovedBeforeHeldRefresh:true,olderFailurePreservedNewerPending:{oldEntry,newestWhileBothHeld,afterOldFailure},
      confirmedSuccess:confirmed,staleSuccessfulSnapshot:{heldOldSnapshot,newerSnapshotApplied,afterStaleSnapshot,
        selectorUnchanged:true,appliedRevisionUnchanged:true,staleResponseWarning:false},
      staleFailedRefresh:{statePreserved:true,selectorPreserved:true,staleResponseWarning:false},externalRequests,pageErrors,
      scope:'Actual presets/group ES modules and synthetic loopback only; group private character-list function exposed in served test copy.'},null,2));
  } finally {
    if(browser) await browser.close();
    if(server){server.closeAllConnections?.();await new Promise(r=>server.close(r));}
  }
})().catch(e=>{console.error(e);console.error(JSON.stringify({pageErrors,diagnostics},null,2));process.exitCode=1;});
