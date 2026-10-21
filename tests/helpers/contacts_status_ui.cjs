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
const uid = 'fixture-contact-1';
const state = { contacts: [{ uid, name: 'Mira Before', emails: ['mira@example.invalid'], phones: ['+1000'], address: 'Loopback' }], listReads: 0, writes: [], deletes: [], mode: 'ok' };
let networkFailMethod = null;
const networkFailureAttempts = { PUT: 0, DELETE: 0 };
const pageHtml = `<!doctype html><meta charset="utf-8"><body>
<div id="unified-integrations-list"></div><div id="unified-intg-form" style="display:none"></div>
<div><button id="unified-intg-add-btn" type="button">Add</button></div>
<div id="toast" role="status" aria-live="polite"></div>
<script type="module">import settings from '/static/js/settings.js'; await settings.initUnifiedIntegrations(); window.fixtureReady=true;</script>
</body>`;
const json = (res, value, status=200) => { res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); return res.end(pageHtml); }
    if (u.pathname === '/__state') return json(res, { ...state, contacts: state.contacts.map(c=>({...c})) });
    if (u.pathname === '/__mode') { state.mode = u.searchParams.get('value') || 'ok'; return json(res, {ok:true}); }
    if (u.pathname === '/api/tasks/notification-logs' && req.method === 'POST') { req.resume(); return json(res, {ok:true}); }
    if (u.pathname === '/api/auth/integrations') return json(res, {integrations:[]});
    if (u.pathname === '/api/calendar/config/accounts') return json(res, {accounts:[]});
    if (u.pathname === '/api/contacts/config') return json(res, {});
    if (u.pathname === '/api/contacts/list' && req.method === 'GET') { state.listReads++; return json(res, {contacts:state.contacts.map(c=>({...c})),count:state.contacts.length}); }
    if (u.pathname === '/api/email/accounts') return json(res, {accounts:[]});
    if (u.pathname === '/api/mcp/servers' || u.pathname === '/api/tokens') return json(res, []);
    if (u.pathname === '/api/contacts/fixture-contact-1' && req.method === 'PUT') {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const status=state.mode === 'save503' ? 503 : 200;
      state.writes.push({body,status});
      const responseBody = status === 503 ? {detail:'synthetic save failure'}
        : state.mode === 'saveFalse' ? {success:false}
        : state.mode === 'saveNull' ? null
        : {success:true};
      if (status === 200 && responseBody?.success === true) Object.assign(state.contacts[0], body);
      return json(res, responseBody, status);
    }
    if (u.pathname === '/api/contacts/fixture-contact-1' && req.method === 'DELETE') {
      const status=state.mode === 'delete403' ? 403 : 200;
      state.deletes.push({status});
      const responseBody = status === 403 ? {detail:'synthetic delete forbidden'}
        : state.mode === 'deleteFalse' ? {success:false}
        : state.mode === 'deleteMissing' ? {}
        : {success:true};
      if (status === 200 && responseBody?.success === true) state.contacts = [];
      return json(res, responseBody, status);
    }
    const file = path.resolve(repo, `.${decodeURIComponent(u.pathname)}`);
    if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {'content-type':file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream'});
    return fs.createReadStream(file).pipe(res);
  } catch (err) { if (!res.headersSent) res.writeHead(500); res.end('fixture error'); }
});
(async () => {
  let browser;
  const pageErrors=[], externalRequests=[], proof={source:{file:'static/js/settings.js',sha256:sourceHash},cases:{},pageErrors,externalRequests};
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-gpu']});
    const page=await browser.newPage(); page.setDefaultTimeout(7000);
    await page.route('**/*',route=>{const u=new URL(route.request().url()); if(['http:','https:'].includes(u.protocol)&&u.origin!==origin){externalRequests.push(u.href);return route.abort();} if(networkFailMethod===route.request().method()&&u.pathname==='/api/contacts/fixture-contact-1'){networkFailureAttempts[networkFailMethod]++;networkFailMethod=null;return route.abort('failed');} return route.continue();});
    page.on('pageerror',err=>pageErrors.push(err.stack||err.message));
    await page.goto(origin); await page.waitForFunction(()=>window.fixtureReady);
    await page.locator('#unified-intg-add-btn').click();
    await page.locator('.uf-type-option[data-value="carddav"]').click();
    await page.locator('.contact-row[data-uid="fixture-contact-1"] .contact-edit').waitFor();
    const stateOn=()=>page.evaluate(async()=>await(await fetch('/__state')).json());
    const setMode=async mode=>{const r=await page.request.get(`${origin}/__mode?value=${mode}`);assert.equal(r.status(),200);};
    const edit=async()=>page.locator('.contact-row[data-uid="fixture-contact-1"] .contact-edit').click();
    const oldRow=async()=>page.locator('.contact-row[data-uid="fixture-contact-1"]').evaluateHandle(el=>el);
    const awaitRerender=async old=>page.waitForFunction(node=>!node.isConnected,old);
    const clearToast=async()=>page.locator('#toast').evaluate(el=>{el.textContent='';el.classList.remove('show');});
    const failedOrRerendered=async(row,text)=>page.waitForFunction(([node,expected])=>document.querySelector('#toast .toast-message')?.textContent===expected||!node.isConnected,[row,text]);
    const assertSaveFailure=async(mode,draft)=>{
      await edit(); await page.locator('.contact-edit-name').fill(draft);
      const row=await oldRow(), before=await stateOn(), reads=before.listReads;
      await clearToast(); await setMode(mode); await page.locator('.contact-save').click();
      await failedOrRerendered(row,'Could not save contact. Try again.');
      const current=await stateOn();
      assert.equal(await page.evaluate(node=>node.isConnected,row),true);
      assert.equal(await page.locator('.contact-edit-name').inputValue(),draft);
      assert.equal(await page.locator('#toast .toast-message').innerText(),'Could not save contact. Try again.');
      assert.equal(current.listReads,reads); assert.equal(current.contacts[0].name,before.contacts[0].name);
      return {row,reads,current};
    };
    const assertDeleteFailure=async(mode)=>{
      const row=await oldRow(), reads=(await stateOn()).listReads;
      await clearToast(); await setMode(mode); await page.locator('.contact-del').click();
      await page.locator('#styled-confirm-ok').waitFor({state:'visible'}); await page.locator('#styled-confirm-ok').click();
      await failedOrRerendered(row,'Could not delete contact. Try again.');
      const current=await stateOn();
      assert.equal(await page.evaluate(node=>node.isConnected,row),true);
      assert.equal(await page.locator('#toast .toast-message').innerText(),'Could not delete contact. Try again.');
      assert.equal(current.listReads,reads); assert.equal(current.contacts.length,1);
      return {row,reads,current};
    };

    // Positive control: successful PUT updates data, then refreshes the actual row.
    await edit(); await page.locator('.contact-edit-name').fill('Mira Saved');
    let prior=await oldRow(); const beforeSuccessReads=(await stateOn()).listReads;
    await setMode('ok'); await page.locator('.contact-save').click(); await awaitRerender(prior);
    await page.waitForFunction(()=>document.querySelector('.contact-name')?.textContent==='Mira Saved');
    let after=await stateOn();
    assert.equal(after.writes.at(-1).status,200); assert.equal(after.writes.at(-1).body.name,'Mira Saved');
    assert.ok(after.listReads>beforeSuccessReads);
    proof.cases.saveSuccess={status:200,savedName:after.contacts[0].name,listRefreshes:after.listReads-beforeSuccessReads};

    // HTTP 503 must keep the edit open, then a retry with the same values succeeds.
    await edit(); await page.locator('.contact-edit-name').fill('Mira Unsaved Draft');
    prior=await oldRow(); const beforeFailureReads=(await stateOn()).listReads;
    await setMode('save503'); await page.locator('.contact-save').click();
    await failedOrRerendered(prior,'Could not save contact. Try again.');
    after=await stateOn();
    assert.equal(await page.locator('#toast .toast-message').count(),1,'failed save should show an error'); assert.equal(await page.locator('#toast .toast-message').textContent(),'Could not save contact. Try again.'); assert.equal(after.writes.at(-1).status,503); assert.equal(after.writes.at(-1).body.name,'Mira Unsaved Draft');
    assert.equal(after.listReads,beforeFailureReads,'failed save does not refetch'); assert.equal(after.contacts[0].name,'Mira Saved');
    assert.equal(await page.evaluate(row=>row.isConnected,prior),true); assert.equal(await page.locator('.contact-row-edit').isVisible(),true);
    assert.equal(await page.locator('.contact-edit-name').inputValue(),'Mira Unsaved Draft');
    proof.cases.save503={status:503,attemptedName:after.writes.at(-1).body.name,draftRetained:true,visibleError:await page.locator('#toast .toast-message').innerText(),listRefreshes:after.listReads-beforeFailureReads};
    prior=await oldRow(); await setMode('ok'); await page.locator('.contact-save').click(); await awaitRerender(prior);
    await page.waitForFunction(()=>document.querySelector('.contact-name')?.textContent==='Mira Unsaved Draft');
    after=await stateOn(); assert.equal(after.writes.at(-1).status,200); assert.equal(after.contacts[0].name,'Mira Unsaved Draft');
    proof.cases.saveRetry={status:200,savedName:after.contacts[0].name};

    // HTTP 200 is not success unless the endpoint confirms it in the body.
    let bodyFailure=await assertSaveFailure('saveFalse','Mira False-Body Draft');
    assert.equal(bodyFailure.current.writes.at(-1).status,200);
    proof.cases.saveFalseBody={status:200,draftRetained:true,noRefresh:bodyFailure.current.listReads===bodyFailure.reads};
    prior=bodyFailure.row; await setMode('ok'); await page.locator('.contact-save').click(); await awaitRerender(prior);
    await page.waitForFunction(()=>document.querySelector('.contact-name')?.textContent==='Mira False-Body Draft');
    after=await stateOn(); assert.equal(after.contacts[0].name,'Mira False-Body Draft');
    proof.cases.saveFalseBodyRetry={savedName:after.contacts[0].name};

    bodyFailure=await assertSaveFailure('saveNull','Mira Null-Body Draft');
    assert.equal(bodyFailure.current.writes.at(-1).status,200);
    proof.cases.saveNullBody={status:200,draftRetained:true,noRefresh:bodyFailure.current.listReads===bodyFailure.reads};
    prior=bodyFailure.row; await setMode('ok'); await page.locator('.contact-save').click(); await awaitRerender(prior);
    await page.waitForFunction(()=>document.querySelector('.contact-name')?.textContent==='Mira Null-Body Draft');
    after=await stateOn(); assert.equal(after.contacts[0].name,'Mira Null-Body Draft');

    // A rejected fetch follows the same no-refresh, draft-preserving path.
    await edit(); await page.locator('.contact-edit-name').fill('Mira Network Draft');
    prior=await oldRow(); const beforeNetworkSaveReads=(await stateOn()).listReads; const writesBeforeNetwork=(await stateOn()).writes.length;
    await clearToast(); networkFailMethod='PUT'; await page.locator('.contact-save').click();
    await failedOrRerendered(prior,'Could not save contact. Try again.');
    after=await stateOn(); assert.equal(networkFailureAttempts.PUT,1); assert.equal(after.writes.length,writesBeforeNetwork);
    assert.equal(after.listReads,beforeNetworkSaveReads); assert.equal(await page.evaluate(row=>row.isConnected,prior),true);
    assert.equal(await page.locator('.contact-edit-name').inputValue(),'Mira Network Draft');
    proof.cases.saveNetworkFailure={attempts:networkFailureAttempts.PUT,draftRetained:true,listRefreshes:after.listReads-beforeNetworkSaveReads};
    prior=await oldRow(); await page.locator('.contact-save').click(); await awaitRerender(prior);
    await page.waitForFunction(()=>document.querySelector('.contact-name')?.textContent==='Mira Network Draft');
    after=await stateOn(); assert.equal(after.writes.at(-1).status,200); assert.equal(after.contacts[0].name,'Mira Network Draft');

    // HTTP 403 keeps the contact row and does not issue a follow-up list read.
    const rowBeforeDelete=await oldRow(); const beforeDeleteReads=after.listReads;
    await setMode('delete403'); await page.locator('.contact-del').click();
    await page.locator('#styled-confirm-ok').waitFor({state:'visible'}); await page.locator('#styled-confirm-ok').click();
    await failedOrRerendered(rowBeforeDelete,'Could not delete contact. Try again.');
    after=await stateOn();
    assert.equal(after.deletes.at(-1).status,403); assert.equal(after.contacts.length,1);
    assert.equal(after.listReads,beforeDeleteReads); assert.equal(await page.evaluate(row=>row.isConnected,rowBeforeDelete),true);
    proof.cases.delete403={status:403,contactStillPresent:true,visibleError:await page.locator('#toast .toast-message').innerText(),listRefreshes:after.listReads-beforeDeleteReads};

    let deleteFailure=await assertDeleteFailure('deleteFalse');
    assert.equal(deleteFailure.current.deletes.at(-1).status,200);
    proof.cases.deleteFalseBody={status:200,contactRetained:true,noRefresh:deleteFailure.current.listReads===deleteFailure.reads};
    deleteFailure=await assertDeleteFailure('deleteMissing');
    assert.equal(deleteFailure.current.deletes.at(-1).status,200);
    proof.cases.deleteMissingBody={status:200,contactRetained:true,noRefresh:deleteFailure.current.listReads===deleteFailure.reads};

    // Network rejection must also keep the row and avoid refreshing.
    const rowBeforeNetworkDelete=await oldRow(); const beforeNetworkDeleteReads=after.listReads; const serverDeletesBefore=(await stateOn()).deletes.length;
    await clearToast(); networkFailMethod='DELETE'; await page.locator('.contact-del').click();
    await page.locator('#styled-confirm-ok').waitFor({state:'visible'}); await page.locator('#styled-confirm-ok').click();
    await failedOrRerendered(rowBeforeNetworkDelete,'Could not delete contact. Try again.');
    after=await stateOn(); assert.equal(networkFailureAttempts.DELETE,1); assert.equal(after.deletes.length,serverDeletesBefore);
    assert.equal(after.listReads,beforeNetworkDeleteReads); assert.equal(after.contacts.length,1);
    assert.equal(await page.evaluate(row=>row.isConnected,rowBeforeNetworkDelete),true);
    proof.cases.deleteNetworkFailure={attempts:networkFailureAttempts.DELETE,contactStillPresent:true,listRefreshes:after.listReads-beforeNetworkDeleteReads};

    // Retrying Delete normally removes the contact and refreshes.
    const rowBeforeDeleteSuccess=await oldRow(); const beforeDeleteSuccessReads=after.listReads;
    await setMode('ok'); await page.locator('.contact-del').click();
    await page.locator('#styled-confirm-ok').waitFor({state:'visible'}); await page.locator('#styled-confirm-ok').click();
    await awaitRerender(rowBeforeDeleteSuccess); await page.waitForFunction(()=>/No contacts yet/.test(document.querySelector('#cm-list')?.textContent||''));
    after=await stateOn();
    assert.equal(after.deletes.at(-1).status,200); assert.equal(after.contacts.length,0); assert.ok(after.listReads>beforeDeleteSuccessReads);
    proof.cases.deleteSuccess={status:200,contactRemoved:true,listRefreshes:after.listReads-beforeDeleteSuccessReads};
    assert.deepEqual(pageErrors,[]); assert.deepEqual(externalRequests,[]);
    proof.pass=true; process.stdout.write(JSON.stringify(proof,null,2)+'\n');
    await page.close();
  } catch(err) { process.stderr.write(`${err.stack||err}\n`); process.exitCode=1; }
  finally { if(browser) await browser.close().catch(()=>{}); if(server.closeAllConnections) server.closeAllConnections(); await new Promise(resolve=>server.close(()=>resolve())).catch(()=>{}); }
})();
