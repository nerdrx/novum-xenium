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
const contact = {uid:'fixture-contact',name:'Mira Fixture',emails:['mira@example.invalid'],phones:[],address:''};
const state = {scenario:'',listReads:0,pending:[],currentContact:{...contact},abortedResponses:0};
let pendingStartedResolve=null;
let pendingStartedPromise=null;
let pendingClosedResolve=null;
let pendingClosedPromise=null;
const pageHtml = `<!doctype html><meta charset="utf-8"><body>
<div id="unified-integrations-list"></div><div id="unified-intg-form" style="display:none"></div>
<div><button id="unified-intg-add-btn" type="button">Add</button></div>
<script type="module">import settings from '/static/js/settings.js'; await settings.initUnifiedIntegrations(); window.fixtureReady=true;</script></body>`;
const json = (res, body, status=200) => { res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req,res) => {
  const u = new URL(req.url,'http://127.0.0.1');
  if (u.pathname === '/') { res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return res.end(pageHtml); }
  if (u.pathname === '/__state') return json(res,{scenario:state.scenario,listReads:state.listReads,pending:state.pending.filter(item=>!item.closed&&!item.res.destroyed).length,abortedResponses:state.abortedResponses,pendingNames:state.pending.filter(item=>!item.closed&&!item.res.destroyed).map(item=>item.body.contacts[0].name),currentContact:{...state.currentContact}});
  if (u.pathname === '/__release') {
    const held=state.pending.splice(0).filter(item=>!item.closed&&!item.res.destroyed);
    if (!held.length) return json(res,{ok:false},409);
    for (const item of held) item.headersSent ? item.res.end(JSON.stringify(item.body)) : json(item.res,item.body);
    return json(res,{ok:true,released:held.length,releasedNames:held.map(item=>item.body.contacts[0].name)});
  }
  if (u.pathname === '/__scenario') { state.scenario=u.searchParams.get('value')||'normal'; return json(res,{ok:true}); }
  if (u.pathname === '/api/auth/integrations') return json(res,{integrations:[]});
  if (u.pathname === '/api/calendar/config/accounts') return json(res,{accounts:[]});
  if (u.pathname === '/api/contacts/config') return json(res,{});
  if (u.pathname === '/api/contacts/list' && req.method === 'GET') {
    const n=++state.listReads;
    if (n===1) return json(res,{contacts:[],count:0}); // unified integration summary read
    if (['stalledFetch','stalledJson'].includes(state.scenario) && n===2) {
      const item={res,body:{contacts:[{...state.currentContact,name:'Mira After Hold'}],count:1},headersSent:state.scenario==='stalledJson',closed:false};
      if(item.headersSent){res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();}
      res.on('close',()=>{if(!res.writableEnded){item.closed=true;state.abortedResponses++;pendingClosedResolve?.();}});
      state.pending.push(item); pendingStartedResolve?.(); return;
    }
    if (['olderRefreshSave','reopenManager'].includes(state.scenario) && n===3) { state.pending.push({res,body:{contacts:[{...state.currentContact}],count:1}}); pendingStartedResolve?.(); return; }
    if (state.scenario==='priorRows503' && n===4) {
      const item={res,body:{contacts:[{...state.currentContact}],count:1},headersSent:true,closed:false};
      res.writeHead(200,{'content-type':'application/json'}); res.flushHeaders();
      res.on('close',()=>{if(!res.writableEnded)item.closed=true;});
      state.pending.push(item); pendingStartedResolve?.(); return;
    }
    if (state.scenario==='reopenManager' && n>=4) return json(res,{contacts:[{uid:'manager-b-only',name:'Manager B Match',emails:['b@example.invalid'],phones:[],address:''},{uid:'manager-b-second',name:'Manager B Second',emails:['second-b@example.invalid'],phones:[],address:''}],count:2});
    if (state.scenario==='http503' && n===2) return json(res,{detail:'Synthetic listing failure'},503);
    if (state.scenario==='network' && n>=2) return req.socket.destroy();
    if (state.scenario==='null' && n===2) return json(res,null);
    if (state.scenario==='priorRows503' && n===3) return json(res,{detail:'Synthetic refresh failure'},503);
    if (state.scenario==='malformed' && n===2) return json(res,{contacts:[null],count:1});
    if (state.scenario==='empty' && n>=2) return json(res,{contacts:[],count:0});
    if (n===2 || (state.scenario==='priorRows503' && n===2)) return json(res,{contacts:[{...state.currentContact}],count:1});
    return json(res,{contacts:[{...state.currentContact}],count:1});
  }
  if (u.pathname === '/api/contacts/fixture-contact' && req.method === 'PUT') {
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    state.currentContact={...state.currentContact,...JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')};
    return json(res,{success:true});
  }
  if (u.pathname === '/api/email/accounts') return json(res,{accounts:[]});
  if (u.pathname === '/api/mcp/servers' || u.pathname === '/api/tokens') return json(res,[]);
  const file=path.resolve(repo,`.${decodeURIComponent(u.pathname)}`);
  if (!file.startsWith(repo+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200,{'content-type':file.endsWith('.js')||file.endsWith('.mjs')?'text/javascript':'application/octet-stream'});
  return fs.createReadStream(file).pipe(res);
});
(async()=>{
  let browser; const pages=[];
  const proof={source:{file:'static/js/settings.js',sha256:sourceHash},cases:{},pageErrors:[],externalRequests:[]};
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-gpu']});
    const openManager=async(scenario,clock=false)=>{
      state.scenario=scenario; state.listReads=0; state.pending=[]; state.currentContact={...contact}; state.abortedResponses=0;
      pendingStartedPromise=new Promise(resolve=>{pendingStartedResolve=resolve;});
      pendingClosedPromise=new Promise(resolve=>{pendingClosedResolve=resolve;});
      const page=await browser.newPage(); pages.push(page); page.setDefaultTimeout(7000);
      if(clock) await page.clock.install({time:new Date('2027-01-15T12:00:00Z')});
      await page.addInitScript(()=>{const original=window.fetch.bind(window);window.fetch=async function(...args){const observeBody=String(args[0]).includes('/api/contacts/list')&&window.__observeNextContactListBody;if(observeBody)window.__observeNextContactListBody=false;const response=await original(...args);if(String(args[0]).includes('/api/contacts/list')){window.__contactListFetchResolved=(window.__contactListFetchResolved||0)+1;if(observeBody)response.clone().json().then(()=>{window.__contactListBodyConsumed=(window.__contactListBodyConsumed||0)+1;});}return response;};});
      const listRequests=[];
      page.on('request',request=>{if(new URL(request.url()).pathname==='/api/contacts/list')listRequests.push(request);});
      page.__contactListRequests=listRequests;
      await page.route('**/*',route=>{const u=new URL(route.request().url()); if(['http:','https:'].includes(u.protocol)&&u.origin!==origin){proof.externalRequests.push(u.href);return route.abort();} return route.continue();});
      page.on('pageerror',e=>proof.pageErrors.push(e.stack||e.message));
      await page.goto(origin); await page.waitForFunction(()=>window.fixtureReady);
      await page.locator('#unified-intg-add-btn').click();
      await page.locator('.uf-type-option[data-value="carddav"]').click();
      await page.locator('#cm-list').waitFor();
      return page;
    };
    const stateOn=page=>page.evaluate(async()=>await(await fetch('/__state')).json());
    const uiOn=page=>page.evaluate(()=>{const retry=document.querySelector('#cm-list .cm-load-retry');const bounds=retry?.getBoundingClientRect();return {text:document.querySelector('#cm-list')?.innerText||'',rows:[...document.querySelectorAll('#cm-list .contact-row')].map(r=>r.innerText),retry:!!retry,retryBounds:bounds?{width:bounds.width,height:bounds.height}:null,warning:!!document.querySelector('#cm-list .cm-load-warning'),count:document.querySelector('#cm-count')?.textContent||''};});
    const finish=async(page)=>{const s=await stateOn(page); await page.close(); return s;};

    // Exercise list-local request ownership before the slower clock/deadline cases.
    {
      const page=await openManager('olderRefreshSave');
      await page.locator('.contact-row[data-uid="fixture-contact"] .contact-name').waitFor();
      await page.locator('#cm-search').fill('Mira');
      await pendingStartedPromise;
      const pendingBeforeSave=await stateOn(page);
      await page.locator('.contact-row[data-uid="fixture-contact"] .contact-edit').click();
      await page.locator('.contact-edit-name').fill('Mira Saved While Refresh Held');
      await page.locator('.contact-save').click();
      await page.waitForFunction(()=>document.querySelector('.contact-name')?.textContent==='Mira Saved While Refresh Held');
      const saved=await stateOn(page);
      const readsBeforeRelease=await page.evaluate(()=>window.__contactListFetchResolved||0);
      const release=await fetch(`${origin}/__release`); assert.equal(release.status,200);
      const released=await release.json(); assert.equal(released.released,1);
      await page.waitForFunction(expected=>(window.__contactListFetchResolved||0)>=expected+1,readsBeforeRelease);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const displayed=await page.locator('.contact-name').innerText();
      assert.equal(saved.currentContact.name,'Mira Saved While Refresh Held');
      assert.equal(displayed,'Mira Saved While Refresh Held');
      proof.cases.olderRefreshAfterSave={pendingBeforeSave,savedContact:saved.currentContact.name,releasedNames:released.releasedNames,displayAfterHeldOldResponse:displayed,staleOverwrite:false};
      await finish(page);
    }
    {
      const page=await openManager('reopenManager');
      await page.locator('.contact-row[data-uid="fixture-contact"] .contact-name').waitFor();
      await page.evaluate(()=>{window.__observeNextContactListBody=true;});
      await page.locator('#cm-search').fill('Mira');
      await pendingStartedPromise;
      const heldRequestA=page.__contactListRequests.at(-1);
      assert.ok(heldRequestA);
      await page.locator('#uf-carddav-cancel').click();
      await page.locator('#unified-intg-add-btn').click();
      await page.locator('.uf-type-option[data-value="carddav"]').click();
      await page.waitForFunction(()=>document.querySelectorAll('#cm-list .contact-row').length===2);
      await page.locator('#cm-list .contact-name').filter({hasText:'Manager B Match'}).waitFor();
      const readsBeforeSearch=(await stateOn(page)).listReads;
      const fetchesBeforeSearch=await page.evaluate(()=>window.__contactListFetchResolved||0);
      await page.locator('#cm-search').fill('Manager B');
      await page.waitForFunction(async n=>(await(await fetch('/__state')).json()).listReads>n,readsBeforeSearch);
      await page.waitForFunction(n=>(window.__contactListFetchResolved||0)>n,fetchesBeforeSearch);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const before=await uiOn(page);
      const bodyBefore=await page.evaluate(()=>window.__contactListBodyConsumed||0);
      const release=await fetch(`${origin}/__release`); assert.equal(release.status,200);
      const released=await release.json(); assert.equal(released.released,1);
      await page.waitForFunction(n=>(window.__contactListBodyConsumed||0)>n,bodyBefore);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const after=await uiOn(page);
      const query=await page.locator('#cm-search').inputValue();
      const visibleRows=await page.locator('#cm-list .contact-row').allTextContents();
      assert.equal(query,'Manager B');
      assert.equal(visibleRows.length,2);
      assert.match(visibleRows.join(' '),/Manager B Match/);
      assert.equal(after.count,before.count);
      proof.cases.heldOldListAfterReopen={before,after,query,visibleRows,managerBCountPreserved:after.count===before.count};
      await finish(page);
    }

    for (const scenario of ['http503','network','null','malformed','empty']) {
      const page=await openManager(scenario);
      await page.waitForFunction(async()=>((await(await fetch('/__state')).json()).listReads)>=2);
      await page.waitForFunction(()=>document.querySelector('#cm-list .cm-load-warning')||/No contacts yet/.test(document.querySelector('#cm-list')?.textContent||''));
      const ui=await uiOn(page); const stateNow=await stateOn(page);
      if(scenario==='empty') { assert.match(ui.text,/No contacts yet/); assert.equal(ui.retry,false); assert.equal(ui.warning,false); }
      else { assert.match(ui.text,/Could not load contacts/); assert.equal(ui.retry,true); assert.equal(ui.warning,true); assert.ok(ui.retryBounds.width>=44&&ui.retryBounds.height>=44); }
      proof.cases[scenario]={ui,listReads:stateNow.listReads};
      if(scenario!=='empty') {
        if(scenario==='network') { const switched=await fetch(`${origin}/__scenario?value=normal`); assert.equal(switched.status,200); }
        await page.locator('.cm-load-retry').click();
        await page.waitForFunction(()=>document.querySelector('#cm-list .contact-name')?.textContent==='Mira Fixture'&&!document.querySelector('#cm-list .cm-load-warning'));
        proof.cases[scenario].retryRecovered=true;
      }
      await page.close();
    }

    // Search input is the existing UI refresh path; prove a 503 falsely replaces a previously rendered row with empty state.
    {
      const page=await openManager('priorRows503');
      await page.locator('.contact-row[data-uid="fixture-contact"]').waitFor();
      const oldRow=await page.locator('.contact-row[data-uid="fixture-contact"]').evaluateHandle(el=>el);
      await page.locator('.contact-row[data-uid="fixture-contact"] .contact-edit').click();
      await page.locator('.contact-edit-name').fill('Mira Unsaved Editor Draft');
      const before=await stateOn(page);
      await page.locator('#cm-search').fill('Mira');
      await page.waitForFunction(async()=>((await(await fetch('/__state')).json()).listReads)>=3);
      await page.waitForFunction(()=>document.querySelector('#cm-list .cm-load-warning'));
      assert.equal(await page.evaluate(row=>row.isConnected,oldRow),true);
      const failureUi=await uiOn(page);
      assert.equal(failureUi.rows.length,1); assert.equal(failureUi.retry,true); assert.equal(failureUi.warning,true);
      assert.match(failureUi.text,/Showing previous results/);
      assert.equal(await page.evaluate(row=>row.isConnected,oldRow),true);
      assert.equal(await page.locator('.contact-row-edit').isVisible(),true);
      assert.equal(await page.locator('.contact-edit-name').inputValue(),'Mira Unsaved Editor Draft');
      const retryButton=page.locator('.cm-load-retry');
      assert.ok((await retryButton.boundingBox()).width>=44); assert.ok((await retryButton.boundingBox()).height>=44);
      await page.evaluate(()=>{window.__observeNextContactListBody=true;});
      await retryButton.click();
      await pendingStartedPromise;
      const whileRetryHeld=await page.evaluate(()=>({
        oldRowConnected:document.querySelector('.contact-row[data-uid="fixture-contact"]')?.isConnected===true,
        editorVisible:document.querySelector('.contact-row-edit')?.checkVisibility()===true,
        draft:document.querySelector('.contact-edit-name')?.value??null,
      }));
      assert.equal(whileRetryHeld.editorVisible,true);
      await page.locator('.contact-edit-name').fill('Mira Edited During Retry');
      const readsBeforeBody=await page.evaluate(()=>window.__contactListBodyConsumed||0);
      const release=await fetch(`${origin}/__release`); assert.equal(release.status,200);
      const released=await release.json(); assert.equal(released.released,1);
      await page.waitForFunction(n=>(window.__contactListBodyConsumed||0)>n,readsBeforeBody);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.waitForFunction(()=>!document.querySelector('#cm-list .cm-load-warning')&&document.querySelector('#cm-list .contact-name')?.textContent==='Mira Fixture');
      const ui=await uiOn(page); const stateNow=await stateOn(page);
      const oldRowDisconnected=!(await page.evaluate(row=>row.isConnected,oldRow));
      const afterRetryDom=await page.evaluate(()=>{
        const row=document.querySelector('#cm-list .contact-row');
        const editor=row?.querySelector('.contact-row-edit');
        const input=row?.querySelector('.contact-edit-name');
        return {uid:row?.dataset.uid??null,editorVisible:!!editor&&editor.checkVisibility(),draft:input?.value??null,renderedName:row?.querySelector('.contact-name')?.textContent??null};
      });
      const retryState={
        warning:ui.warning,
        rowCount:ui.rows.length,
        uid:afterRetryDom.uid,
        oldRowDisconnected,
        editorVisible:afterRetryDom.editorVisible,
        draft:afterRetryDom.draft,
        renderedName:afterRetryDom.renderedName,
      };
      assert.equal(ui.rows.length,1); assert.equal(ui.retry,false);
      assert.equal(retryState.uid,'fixture-contact'); assert.equal(retryState.oldRowDisconnected,true);
      assert.equal(retryState.editorVisible,true); assert.equal(retryState.draft,'Mira Edited During Retry');
      assert.equal(retryState.renderedName,'Mira Fixture');
      proof.cases.priorRows503={beforeRows:1,afterFailure:failureUi,editorPreserved:true,draft:'Mira Unsaved Editor Draft',whileRetryHeld,latestDraft:'Mira Edited During Retry',afterRetry:ui,retryState,bodyCompletionObserved:true,twoAnimationFramesObserved:true,listReads:stateNow.listReads-before.listReads};
      await page.close();
    }

    // Both response-header and response-body stalls hit the 15-second deadline and recover on manual retry.
    {
      for(const scenario of ['stalledFetch','stalledJson']) {
        const page=await openManager(scenario,true);
        await pendingStartedPromise;
        await page.clock.runFor(16000);
        await page.locator('#cm-list .cm-load-warning').waitFor();
        await pendingClosedPromise;
        const afterClock=await uiOn(page), afterState=await stateOn(page);
        assert.equal(afterState.abortedResponses,1); assert.equal(afterState.pending,0);
        assert.equal(afterClock.retry,true); assert.ok(afterClock.retryBounds.width>=44&&afterClock.retryBounds.height>=44);
        proof.cases[scenario]={simulatedMilliseconds:16000,whileHeld:afterClock,readsWhileHeld:afterState.listReads,pendingResponses:afterState.pending,requestAborted:afterState.abortedResponses===1};
        await page.locator('.cm-load-retry').click();
        await page.waitForFunction(()=>document.querySelector('#cm-list .contact-name')?.textContent==='Mira Fixture'&&!document.querySelector('#cm-list .cm-load-warning'));
        proof.cases[scenario].retryRecovered=true;
        await finish(page);
      }
    }

    assert.deepEqual(proof.pageErrors,[]); assert.deepEqual(proof.externalRequests,[]);
    proof.pass=true; process.stdout.write(JSON.stringify(proof,null,2)+'\n');
  } catch(error) { process.stderr.write(`${error.stack||error}\n`); process.exitCode=1; }
  finally { if(browser) await browser.close().catch(()=>{}); if(server.closeAllConnections) server.closeAllConnections(); await new Promise(resolve=>server.close(()=>resolve())).catch(()=>{}); }
})();
