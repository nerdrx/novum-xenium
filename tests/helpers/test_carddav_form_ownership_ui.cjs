'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(process.env.REPO_PATH || path.join(__dirname, '../..'));
const sourcePath = path.join(repo, 'static/js/settings.js');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
const state = {
  config: { url: 'https://carddav.fixture.invalid/addressbook/', username: 'fixture-user', password: '***' },
  showFixtureContacts:false, configGets: 0, saves: [], saveStatus: 200, saveResponseKind:'success', configGetStatus:200, configShape:'valid', pendingConfig: null, pendingConfigBody:null, holdNextConfig: false, holdNextConfigBody:false, holdNextSave: false, pendingSave: null, notifications: 0, integrationGets:0,
};
const json = (res, value, status=200) => { res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(value)); };
const pageHtml = `<!doctype html><meta charset="utf-8"><body>
<div id="unified-integrations-list"></div><div id="unified-intg-form" style="display:none"></div>
<div><button id="unified-intg-add-btn" type="button">Add Integration</button></div>
<div id="toast" role="status" aria-live="polite"></div>
<script>window.addEventListener('odysseus-integrations-changed',()=>window.fixtureNotifications++);window.fixtureNotifications=0;</script>
<script type="module">import settings from '/static/js/settings.js'; await settings.initUnifiedIntegrations(); window.fixtureReady=true;</script>
</body>`;
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); return res.end(pageHtml); }
    if (u.pathname === '/__fixture-contacts') {state.showFixtureContacts=u.searchParams.get('enabled')==='true';return json(res,{ok:true});}
    if (u.pathname === '/__state') return json(res, {
      configGets: state.configGets, saves: state.saves, saveStatus: state.saveStatus, saveResponseKind:state.saveResponseKind, configGetStatus:state.configGetStatus, configShape:state.configShape,
      pendingConfig: !!state.pendingConfig, pendingConfigBody:!!state.pendingConfigBody, holdNextConfig: state.holdNextConfig, holdNextConfigBody:state.holdNextConfigBody, pendingSave:!!state.pendingSave, notifications:state.notifications, integrationGets:state.integrationGets, passwordPresent:state.config.password==='***',
    });
    if (u.pathname === '/__mode') { state.saveStatus = Number(u.searchParams.get('status') || 200); state.saveResponseKind=u.searchParams.get('kind')||'success'; return json(res, {ok:true}); }
    if (u.pathname === '/__config-mode') { state.configGetStatus = Number(u.searchParams.get('status') || 200); state.configShape=u.searchParams.get('shape')||'valid'; return json(res, {ok:true}); }
    if (u.pathname === '/__hold-config') { state.holdNextConfig = true; return json(res, {ok:true}); }
    if (u.pathname === '/__hold-config-body') { state.holdNextConfigBody = true; return json(res, {ok:true}); }
    if (u.pathname === '/__hold-save') { state.holdNextSave = true; return json(res, {ok:true}); }
    if (u.pathname === '/__release-config') {
      if (state.pendingConfigBody) {
        const pending=state.pendingConfigBody; state.pendingConfigBody=null;
        if (!pending.res.destroyed) pending.res.end(JSON.stringify(state.config));
        pending.resolve(); return json(res,{ok:true});
      }
      const pending = state.pendingConfig;
      if (!pending) return json(res, {ok:false}, 409);
      state.pendingConfig = null;
      if (!pending.res.destroyed) json(pending.res, state.config);
      pending.resolve();
      return json(res, {ok:true});
    }
    if (u.pathname === '/__release-save') {
      const pending = state.pendingSave;
      if (!pending) return json(res, {ok:false}, 409);
      state.pendingSave = null;
      if ('carddav_url' in pending.body) state.config.url=pending.body.carddav_url;
      if ('carddav_username' in pending.body) state.config.username=pending.body.carddav_username;
      if ('carddav_password' in pending.body) state.config.password='***';
      json(pending.res, {success:true}); pending.resolve(); return json(res, {ok:true});
    }
    if (u.pathname === '/api/contacts/config' && req.method === 'GET') {
      state.configGets++;
      if (state.holdNextConfigBody) {
        state.holdNextConfigBody=false;
        res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'}); res.flushHeaders();
        await new Promise(resolve=>{state.pendingConfigBody={res,resolve};});
        if (!res.destroyed) res.end(JSON.stringify(state.config));
        return;
      }
      if (state.holdNextConfig) {
        state.holdNextConfig = false;
        await new Promise(resolve => { state.pendingConfig = {res, resolve}; });
        return;
      }
      if (state.configShape==='missing') return json(res, {url:state.config.url, password:state.config.password}, state.configGetStatus);
      if (state.configShape==='null') return json(res, null, state.configGetStatus);
      if (state.configShape==='array') return json(res, [], state.configGetStatus);
      if (state.configShape==='wrongtype') return json(res, {url:state.config.url, username:null, password:state.config.password}, state.configGetStatus);
      return json(res, state.config, state.configGetStatus);
    }
    if (u.pathname === '/api/contacts/config' && req.method === 'PUT') {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      state.saves.push(body);
      if (state.holdNextSave) { state.holdNextSave=false; await new Promise(resolve=>{state.pendingSave={res,resolve,body};}); return; }
      if (state.saveStatus !== 200) return json(res, {detail:'synthetic fixture failure'}, state.saveStatus);
      if (state.saveResponseKind==='false') return json(res, {success:false});
      if (state.saveResponseKind==='null') return json(res, null);
      if (state.saveResponseKind==='missing') {res.writeHead(200,{'cache-control':'no-store'});return res.end();}
      if ('carddav_url' in body) state.config.url=body.carddav_url;
      if ('carddav_username' in body) state.config.username=body.carddav_username;
      if ('carddav_password' in body) state.config.password='***';
      return json(res, {success:true});
    }
    if (u.pathname === '/api/auth/integrations') {state.integrationGets++;return json(res, {integrations:[]});}
    if (u.pathname === '/api/auth/integrations/presets') return json(res, {presets:{}});
    if (u.pathname === '/api/calendar/config/accounts') return json(res, {accounts:[]});
    if (u.pathname === '/api/contacts/list') return json(res, state.showFixtureContacts?{contacts:[{uid:'fixture-b',name:'Fixture B',emails:[],phones:[],address:''}],count:1}:{contacts:[],count:0});
    if (u.pathname === '/api/email/accounts') return json(res, {accounts:[]});
    if (u.pathname === '/api/mcp/servers') return json(res, {servers:[]});
    if (u.pathname === '/api/vault/config') return json(res, {});
    if (u.pathname === '/api/tokens') return json(res, []);
    if (u.pathname === '/api/calendar/calendars') return json(res, {calendars:[]});
    const file = path.resolve(repo, `.${decodeURIComponent(u.pathname)}`);
    if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {'content-type':file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream'});
    return fs.createReadStream(file).pipe(res);
  } catch (err) { if (!res.headersSent) res.writeHead(500); res.end('fixture error'); }
});
(async () => {
  let browser;
  const proof={source:{file:'static/js/settings.js',sha256:sourceHash},cases:{},pageErrors:[],externalRequests:[]};
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-gpu']});
    const page=await browser.newPage(); page.setDefaultTimeout(7000);
    await page.route('**/*',route=>{const u=new URL(route.request().url()); if(['http:','https:'].includes(u.protocol)&&u.origin!==origin){proof.externalRequests.push(u.href);return route.abort();} return route.continue();});
    page.on('pageerror',err=>proof.pageErrors.push(err.stack||err.message));
    await page.goto(origin); await page.waitForFunction(()=>window.fixtureReady);
    const openType=async type=>{await page.locator('#unified-intg-add-btn').click(); await page.locator(`.uf-type-option[data-value="${type}"]`).click();};
    const stateOn=async()=>page.evaluate(async()=>await(await fetch('/__state')).json());
    const setStatus=async (status,kind='success')=>{const r=await page.request.get(`${origin}/__mode?status=${status}&kind=${kind}`); assert.equal(r.status(),200);};
    await openType('carddav');
    await page.locator('#uf-carddav-save').waitFor();
    await page.waitForFunction(()=>document.querySelector('#uf-carddav-save')?.disabled===false);
    await page.waitForFunction(()=>document.querySelector('#uf-carddav-url')?.value==='https://carddav.fixture.invalid/addressbook/');
    const prefill={url:await page.locator('#uf-carddav-url').inputValue(),username:await page.locator('#uf-carddav-user').inputValue(),passwordValue:await page.locator('#uf-carddav-pass').inputValue(),passwordPlaceholder:await page.locator('#uf-carddav-pass').getAttribute('placeholder')};
    assert.equal(prefill.url,'https://carddav.fixture.invalid/addressbook/');
    assert.equal(prefill.username,'fixture-user');
    assert.equal(prefill.passwordValue,'');
    assert.equal(prefill.passwordPlaceholder,'(unchanged)');
    await page.locator('#uf-carddav-url').fill('https://new.fixture.invalid/book/');
    await page.locator('#uf-carddav-user').fill('new-fixture-user');
    await setStatus(503);
    await page.locator('#uf-carddav-save').click();
    await page.waitForFunction(()=>['Saved','Save failed'].includes(document.querySelector('#uf-carddav-msg')?.textContent));
    assert.equal(await page.locator('#uf-carddav-msg').innerText(),'Save failed');
    let after=await stateOn();
    assert.equal(after.saves.length,1);
    assert.equal(after.saves[0].carddav_url,'https://new.fixture.invalid/book/');
    assert.equal(after.saves[0].carddav_username,'new-fixture-user');
    assert.equal('carddav_password' in after.saves[0],false);
    proof.cases.saveHttp503={attemptBody:after.saves[0],visibleMessage:await page.locator('#uf-carddav-msg').innerText(),httpStatus:503};

    // Malformed successful responses must not be treated as saved.
    for (const kind of ['false','null','missing']) {
      await setStatus(200,kind);
      await page.locator('#uf-carddav-msg').evaluate(el=>el.textContent='');
      await page.locator('#uf-carddav-save').click();
      await page.waitForFunction(()=>document.querySelector('#uf-carddav-msg')?.textContent==='Save failed');
      proof.cases[`save200${kind}`]={message:await page.locator('#uf-carddav-msg').innerText(),httpStatus:200};
    }

    // Normal successful save verifies body shape and the existing blank-password omission.
    await setStatus(200);
    await page.locator('#uf-carddav-save').click();
    await page.waitForFunction(()=>document.querySelector('#uf-carddav-msg')?.textContent==='Saved');
    after=await stateOn();
    assert.equal(after.saves.length,5);
    assert.equal('carddav_password' in after.saves.at(-1),false);
    proof.cases.normalSave={httpStatus:200,attemptBody:after.saves.at(-1),maskedSavedPasswordStillPresent:after.passwordPresent};
    assert.equal(after.passwordPresent,true);

    // An empty URL intentionally disables CardDAV; the separate username remains editable and is preserved.
    await page.locator('#uf-carddav-url').fill('');
    await page.locator('#uf-carddav-msg').evaluate(el=>el.textContent='');
    await page.locator('#uf-carddav-save').click();
    await page.waitForFunction(()=>document.querySelector('#uf-carddav-msg')?.textContent==='Saved');
    after=await stateOn();
    const disableBody=after.saves.at(-1);
    assert.equal(disableBody.carddav_url,'');
    assert.equal(disableBody.carddav_username,'new-fixture-user');
    proof.cases.emptyUrlDisable={body:disableBody};

    // A save response arrives after the user has changed fields in the same form.
    await page.request.get(`${origin}/__hold-save`);
    await page.locator('#uf-carddav-url').fill('https://submitted.fixture.invalid/book/');
    await page.locator('#uf-carddav-msg').evaluate(el=>el.textContent='');
    await page.locator('#uf-carddav-save').click();
    await page.waitForFunction(async()=> (await(await fetch('/__state')).json()).pendingSave);
    await page.locator('#uf-carddav-url').fill('https://newer-draft.fixture.invalid/book/');
    const savedRel=await page.request.get(`${origin}/__release-save`); assert.equal(savedRel.status(),200);
    await page.waitForFunction(()=>document.querySelector('#uf-carddav-msg')?.textContent==='Saved; newer edits remain unsaved.');
    proof.cases.heldSaveSameFormEdit={submittedUrl:'https://submitted.fixture.invalid/book/',visibleUrl:await page.locator('#uf-carddav-url').inputValue(),message:await page.locator('#uf-carddav-msg').innerText()};

    // A committed save response arrives after the user leaves the form.
    await page.locator('#uf-carddav-cancel').click();
    await openType('carddav'); await page.locator('#uf-carddav-url').waitFor();
    await page.waitForFunction(()=>document.querySelector('#uf-carddav-url')?.value==='https://submitted.fixture.invalid/book/');
    await page.request.get(`${origin}/__hold-save`);
    await page.locator('#uf-carddav-url').fill('https://leave-form.fixture.invalid/book/');
    await page.locator('#uf-carddav-save').click();
    await page.waitForFunction(async()=> (await(await fetch('/__state')).json()).pendingSave);
    await page.locator('#uf-carddav-cancel').click(); await openType('api'); await page.locator('#uf-api-name').fill('Other form draft');
    const notifyBefore=await page.evaluate(()=>window.fixtureNotifications);
    const integrationGetsBefore=(await stateOn()).integrationGets;
    const relSave=await page.request.get(`${origin}/__release-save`); assert.equal(relSave.status(),200);
    await page.waitForFunction(async n=> (await(await fetch('/__state')).json()).integrationGets>n,integrationGetsBefore);
    const notifyAfter=await page.evaluate(()=>window.fixtureNotifications);
    proof.cases.heldSaveAfterSwitch={activeForm:'API',draft:await page.locator('#uf-api-name').inputValue(),notificationsBefore:notifyBefore,notificationsAfter:notifyAfter,pageErrors:proof.pageErrors.slice()};

    assert.equal(proof.cases.heldSaveSameFormEdit.visibleUrl,'https://newer-draft.fixture.invalid/book/');
    assert.equal(proof.cases.heldSaveSameFormEdit.message,'Saved; newer edits remain unsaved.');
    assert.equal(proof.cases.heldSaveAfterSwitch.draft,'Other form draft');
    assert.equal(notifyAfter,notifyBefore+1);
    assert.equal(proof.pageErrors.length,0);

    // An accepted setup save must not refresh a newly opened manager over its row draft.
    await page.locator('#uf-api-cancel').click();
    await page.request.get(`${origin}/__fixture-contacts?enabled=true`);
    await openType('carddav');
    await page.waitForFunction(()=>document.querySelector('#uf-carddav-save')?.disabled===false);
    await page.request.get(`${origin}/__hold-save`);
    await page.locator('#uf-carddav-url').fill('https://accepted-config.fixture.invalid/book/');
    await page.locator('#uf-carddav-save').click();
    await page.waitForFunction(async()=> (await(await fetch('/__state')).json()).pendingSave);
    await page.locator('#uf-carddav-cancel').click();
    await openType('carddav');
    await page.locator('.contact-row[data-uid="fixture-b"] .contact-edit').click();
    await page.locator('.contact-edit-name').fill('B unsaved after setup save');
    const configDraft=await page.locator('.contact-edit-name').evaluateHandle(n=>n);
    const configNotifyBefore=await page.evaluate(()=>window.fixtureNotifications);
    const configGetsBefore=(await stateOn()).integrationGets;
    const configFinished=page.waitForEvent('requestfinished',req=>new URL(req.url()).pathname==='/api/contacts/config'&&req.method()==='PUT');
    const configReleased=await page.request.get(`${origin}/__release-save`);assert.equal(configReleased.status(),200);
    await configFinished;
    await page.waitForFunction(async n=>(await(await fetch('/__state')).json()).integrationGets>n,configGetsBefore);
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    proof.cases.configSaveAfterReopen={draft:await page.locator('.contact-edit-name').inputValue(),originalEditorConnected:await page.evaluate(n=>n.isConnected,configDraft),editorVisible:await page.locator('.contact-edit-name').isVisible(),notificationsBefore:configNotifyBefore,notificationsAfter:await page.evaluate(()=>window.fixtureNotifications)};
    assert.equal(proof.cases.configSaveAfterReopen.draft,'B unsaved after setup save');
    assert.equal(proof.cases.configSaveAfterReopen.originalEditorConnected,true);
    assert.equal(proof.cases.configSaveAfterReopen.editorVisible,true);
    assert.equal(proof.cases.configSaveAfterReopen.notificationsAfter,configNotifyBefore+1);
    await page.locator('#uf-carddav-cancel').click();
    await page.request.get(`${origin}/__fixture-contacts?enabled=false`);
    await openType('api');

    // Save stays disabled during prefill, and late config preserves typed fields.
    await page.locator('#uf-api-cancel').click();
    await page.request.get(`${origin}/__hold-config`);
    await openType('carddav');
    await page.waitForFunction(async()=> (await(await fetch('/__state')).json()).pendingConfig);
    assert.equal(await page.locator('#uf-carddav-save').isDisabled(),true);
    await page.locator('#uf-carddav-url').fill('https://typed.fixture.invalid/book/');
    await page.locator('#uf-carddav-user').fill('typed-user');
    const prefillFinished=page.waitForEvent('requestfinished',req=>new URL(req.url()).pathname==='/api/contacts/config'&&req.method()==='GET');
    const releasedPrefill=await page.request.get(`${origin}/__release-config`); assert.equal(releasedPrefill.status(),200); await prefillFinished;
    await page.waitForFunction(()=>document.querySelector('#uf-carddav-save')?.disabled===false);
    assert.equal(await page.locator('#uf-carddav-url').inputValue(),'https://typed.fixture.invalid/book/');
    assert.equal(await page.locator('#uf-carddav-user').inputValue(),'typed-user');
    proof.cases.heldPrefillPreservesEdits={saveDisabledUntilComplete:true,url:await page.locator('#uf-carddav-url').inputValue(),username:await page.locator('#uf-carddav-user').inputValue()};

    // Early Cancel aborts a second held prefill and the next form remains owned.
    await page.locator('#uf-carddav-cancel').click();
    assert.equal(await page.locator('#unified-intg-form').evaluate(el=>el.style.display),'none');
    await page.request.get(`${origin}/__hold-config`);
    await openType('carddav');
    await page.waitForFunction(async()=> (await(await fetch('/__state')).json()).pendingConfig);
    const cancelledPrefill = page.waitForEvent('requestfailed',req=>new URL(req.url()).pathname==='/api/contacts/config'&&req.method()==='GET');
    await page.locator('#uf-carddav-cancel').click();
    assert.equal(await page.locator('#unified-intg-form').evaluate(el=>el.style.display),'none');
    await cancelledPrefill;
    await openType('api'); await page.locator('#uf-api-name').fill('After cancelled prefill');
    const releaseCancelled=await page.request.get(`${origin}/__release-config`); assert.equal(releaseCancelled.status(),200);
    assert.equal(await page.locator('#uf-api-name').inputValue(),'After cancelled prefill');
    proof.cases.cancelDuringPrefill={formHidden:true,nextFormDraft:await page.locator('#uf-api-name').inputValue()};

    // HTTP failure yields an honest prefill error and re-enables bound controls.
    await page.locator('#uf-api-cancel').click();
    await page.request.get(`${origin}/__config-mode?status=503`);
    await openType('carddav');
    await page.waitForFunction(()=>document.querySelector('#uf-carddav-save')?.disabled===false);
    assert.equal(await page.locator('#uf-carddav-msg').innerText(),'Could not load saved CardDAV settings.');
    proof.cases.prefillHttp503={saveEnabledAfterSettledFailure:await page.locator('#uf-carddav-save').isEnabled(),message:await page.locator('#uf-carddav-msg').innerText()};
    await page.request.get(`${origin}/__config-mode?status=200`);

    // The backend config contract includes url, username, and password strings.
    for (const shape of ['missing','null','array','wrongtype']) {
      await page.request.get(`${origin}/__config-mode?status=200&shape=${shape}`);
      await page.locator('#uf-carddav-cancel').click(); await openType('carddav');
      await page.waitForFunction(()=>document.querySelector('#uf-carddav-save')?.disabled===false);
      assert.equal(await page.locator('#uf-carddav-msg').innerText(),'Could not load saved CardDAV settings.');
      assert.equal(await page.locator('#uf-carddav-url').inputValue(),'');
      assert.equal(await page.locator('#uf-carddav-user').inputValue(),'');
      proof.cases[`invalidPrefill${shape}`]={message:await page.locator('#uf-carddav-msg').innerText(),url:await page.locator('#uf-carddav-url').inputValue(),username:await page.locator('#uf-carddav-user').inputValue()};
    }
    await page.request.get(`${origin}/__config-mode?status=200&shape=valid`);

    // Actual 15s native deadline spans the held GET and releases the form.
    await page.locator('#uf-carddav-cancel').click();
    await page.clock.install({time:new Date('2026-10-21T12:00:00Z')});
    await page.request.get(`${origin}/__hold-config`);
    await openType('carddav');
    await page.waitForFunction(async()=> (await(await fetch('/__state')).json()).pendingConfig);
    await page.clock.fastForward(15000);
    await page.waitForFunction(()=>document.querySelector('#uf-carddav-save')?.disabled===false);
    assert.equal(await page.locator('#uf-carddav-msg').innerText(),'Could not load saved CardDAV settings.');
    const abortedPending=await stateOn();
    const releaseTimedOut=await page.request.get(`${origin}/__release-config`); assert.equal(releaseTimedOut.status(),200);
    proof.cases.prefillDeadline={waitedMs:15000,saveEnabledAfterAbort:await page.locator('#uf-carddav-save').isEnabled(),serverRequestWasPendingBeforeAbort:abortedPending.pendingConfig};

    // Headers may arrive while JSON body stays open; the same deadline covers body parsing.
    await page.locator('#uf-carddav-cancel').click();
    await page.request.get(`${origin}/__hold-config-body`);
    const configResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/contacts/config'&&response.request().method()==='GET');
    await openType('carddav'); await configResponse;
    await page.waitForFunction(async()=> (await(await fetch('/__state')).json()).pendingConfigBody);
    assert.equal(await page.locator('#uf-carddav-save').isDisabled(),true);
    await page.clock.fastForward(5000);
    assert.equal(await page.locator('#uf-carddav-save').isDisabled(),true);
    await page.clock.fastForward(10000);
    await page.waitForFunction(()=>document.querySelector('#uf-carddav-save')?.disabled===false);
    assert.equal(await page.locator('#uf-carddav-msg').innerText(),'Could not load saved CardDAV settings.');
    const bodyPending=await stateOn();
    assert.equal(bodyPending.pendingConfigBody,true);
    const releasedJsonBody=await page.request.get(`${origin}/__release-config`); assert.equal(releasedJsonBody.status(),200);
    proof.cases.prefillJsonDeadline={waitedMs:15000,headersReceived:true,bodyPendingBeforeAbort:bodyPending.pendingConfigBody,saveEnabledAfterAbort:await page.locator('#uf-carddav-save').isEnabled()};
    assert.equal(proof.pageErrors.length,0);
    assert.deepEqual(proof.externalRequests,[]);
    proof.pass=proof.externalRequests.length===0;
    console.log(JSON.stringify(proof,null,2));
    if (!proof.pass) process.exitCode=1;
  } catch (err) { console.error(err.stack||err); process.exitCode=1; }
  finally { if (browser) await browser.close(); server.close(); }
})();
