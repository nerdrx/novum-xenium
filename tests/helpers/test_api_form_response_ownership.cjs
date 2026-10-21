'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const sourcePath = path.join(repo, 'static/js/settings.js');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
const originRef = { origin: '' };
const initialIntegration = { id: 'fixture-api', name: 'Synthetic API', base_url: 'https://fixture.invalid/api', auth_type: 'none', auth_header: '', enabled: true };
const accountB = { id: 'fixture-account-b', label: 'Account B', url: 'https://fixture.invalid/b', username: 'b-user' };
const state = { integration: { ...initialIntegration }, tests: [], saves: [], listReads: 0, pendingTest: null, pendingSave: null, nextTestHold: false, nextTestError: false, nextSaveHold: false, nextListNull: false, errorToasts: [] };
const html = `<!doctype html><meta charset="utf-8"><body><div id="settings-ancestor"><div id="unified-integrations-list"></div><div id="unified-intg-form" style="display:none"></div><div><button id="unified-intg-add-btn">Add</button></div><div id="toast"></div></div><script type="module">window.__integrationChanges=0;window.__notificationLogRequests=0;window.__fixtureJsonConsumed={test:0,save:0,list:0};window.addEventListener('odysseus-integrations-changed',()=>window.__integrationChanges++);const nativeFetch=window.fetch.bind(window);window.fetch=async(...args)=>{const url=new URL(args[0],location.href);if(url.pathname==='/api/tasks/notification-logs')window.__notificationLogRequests++;const response=await nativeFetch(...args);const method=(args[1]?.method||'GET').toUpperCase();const originalJson=response.json.bind(response);response.json=async(...jsonArgs)=>{try{return await originalJson(...jsonArgs)}finally{if(url.pathname==='/api/auth/integrations/fixture-api/test')window.__fixtureJsonConsumed.test++;if(url.pathname==='/api/auth/integrations/fixture-api'&&method==='PUT')window.__fixtureJsonConsumed.save++;if(url.pathname==='/api/auth/integrations'&&method==='GET')window.__fixtureJsonConsumed.list++;}};return response;};import settings from '/static/js/settings.js';await settings.initUnifiedIntegrations();window.fixtureReady=true;</script>`;
function json(res, value, status=200) { res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(value)); }
function readBody(req) { return new Promise((resolve,reject)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch(e){reject(e);}});req.on('error',reject);}); }
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1');
  if(u.pathname==='/') {res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(html);}
  if(u.pathname==='/__state') return json(res,{tests:state.tests,saves:state.saves,listReads:state.listReads,errorToasts:state.errorToasts,pendingTest:!!state.pendingTest,pendingSave:!!state.pendingSave,integration:{...state.integration}});
  if(u.pathname==='/__reset') {if(state.pendingTest||state.pendingSave)return json(res,{ok:false},409);state.integration={...initialIntegration};state.tests=[];state.saves=[];state.listReads=0;state.nextTestError=false;state.nextListNull=false;state.errorToasts=[];return json(res,{ok:true});}
  if(u.pathname==='/__hold-test') {state.nextTestHold=true;res.writeHead(204);return res.end();}
  if(u.pathname==='/__hold-save') {state.nextSaveHold=true;res.writeHead(204);return res.end();}
  if(u.pathname==='/__fail-next-test') {state.nextTestError=true;res.writeHead(204);return res.end();}
  if(u.pathname==='/__null-next-integration-list') {state.nextListNull=true;res.writeHead(204);return res.end();}
  if(u.pathname==='/__release-test') {if(!state.pendingTest)return json(res,{ok:false},409);const p=state.pendingTest;state.pendingTest=null;if(p.fail){p.res.writeHead(503,{'content-type':'application/json'});p.res.end('{');}else json(p.res,{ok:true,message:'Synthetic API test succeeded'});return json(res,{ok:true});}
  if(u.pathname==='/__release-save') {if(!state.pendingSave)return json(res,{ok:false},409);const p=state.pendingSave;state.pendingSave=null;state.integration={...state.integration,...p.body};json(p.res,{ok:true,integration:{id:state.integration.id,...state.integration}});return json(res,{ok:true});}
  if(u.pathname==='/api/auth/integrations/presets') return json(res,{presets:{}});
  if(u.pathname==='/api/tasks/notification-logs'&&req.method==='POST') {state.errorToasts.push(await readBody(req));return json(res,{ok:true});}
  if(u.pathname==='/api/auth/integrations' && req.method==='GET') {state.listReads++;if(state.nextListNull){state.nextListNull=false;return json(res,null);}return json(res,{integrations:[{...state.integration}]});}
  if(u.pathname==='/api/auth/integrations/fixture-api/test' && req.method==='POST') {const id=state.tests.length+1;state.tests.push({id});if(state.nextTestHold){state.nextTestHold=false;state.pendingTest={id,res,fail:state.nextTestError};state.nextTestError=false;return;}return json(res,{ok:true,message:'Synthetic API test succeeded'});}
  if(u.pathname==='/api/auth/integrations/fixture-api' && req.method==='PUT') {const body=await readBody(req);state.saves.push({method:'PUT',path:u.pathname,body});if(state.nextSaveHold){state.nextSaveHold=false;state.pendingSave={res,body};return;}state.integration={...state.integration,...body};return json(res,{ok:true,integration:{id:state.integration.id,...state.integration}});}
  if(u.pathname==='/api/calendar/config/accounts') return json(res,{accounts:[accountB]});
  if(u.pathname==='/api/calendar/calendars') return json(res,{calendars:[]});
  if(u.pathname==='/api/contacts/config') return json(res,{});
  if(u.pathname==='/api/contacts/list') return json(res,{contacts:[],count:0});
  if(u.pathname==='/api/email/accounts') return json(res,{accounts:[]});
  if(u.pathname==='/api/mcp/servers'||u.pathname==='/api/tokens') return json(res,[]);
  if(u.pathname==='/api/vault/config') return json(res,{});
  const file=path.resolve(repo,'.'+decodeURIComponent(u.pathname));
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end('not found');}
  res.writeHead(200,{'content-type':file.endsWith('.js')||file.endsWith('.mjs')?'text/javascript':'application/octet-stream'});fs.createReadStream(file).pipe(res);
});
async function newPage(browser, externalRequests, pageErrors) {
  const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(6000);
  await page.route('**/*',route=>{const u=new URL(route.request().url());if((u.protocol==='http:'||u.protocol==='https:')&&u.origin!==originRef.origin){externalRequests.push(u.href);return route.abort();}return route.continue();});
  page.on('pageerror',e=>pageErrors.push(e.stack||e.message));await page.goto(originRef.origin);await page.waitForFunction(()=>window.fixtureReady);await page.locator('.intg-card[data-intg-id="fixture-api"]').waitFor();return {context,page};
}
async function openApi(page){await page.locator('.intg-card[data-intg-id="fixture-api"]').click();await page.locator('#uf-api-test').waitFor();await page.waitForFunction(()=>document.querySelector('#uf-api-url')?.value==='https://fixture.invalid/api');}
async function openBDraft(page){await page.locator('.intg-card[data-intg-id="fixture-account-b"]').click();await page.waitForFunction(()=>document.querySelector('#uf-caldav-url')?.value==='https://fixture.invalid/b');await page.locator('#uf-caldav-label').fill('B draft remains');await page.locator('#uf-caldav-url').fill('https://fixture.invalid/b-draft');await page.locator('#uf-caldav-user').fill('b-draft-user');await page.locator('#uf-caldav-pass').fill('b-draft-password');}
async function consumed(page,key){return page.evaluate(key=>window.__fixtureJsonConsumed[key],key);}
async function waitForConsumed(page,key,count){await page.waitForFunction(([key,count])=>window.__fixtureJsonConsumed[key]===count+1,[key,count]);}
async function nextFrame(page){await page.evaluate(()=>new Promise(requestAnimationFrame));}
(async()=>{
 let browser;const result={source:{file:'static/js/settings.js',sha256:sourceHash},loopbackOnly:true,cases:{},externalRequests:[],pageErrors:[]};
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));originRef.origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-gpu']});
  // Current-selection positive control: both API responses update the open form normally.
  {
   const {context,page}=await newPage(browser,result.externalRequests,result.pageErrors);
   await openApi(page);await page.locator('#uf-api-test').click();await page.waitForFunction(()=>document.querySelector('#uf-api-msg')?.textContent==='Synthetic API test succeeded');
   const before=await page.evaluate(()=>window.__integrationChanges);await page.locator('#uf-api-save').click();await page.waitForFunction(n=>window.__integrationChanges===n+1,before);
   result.cases.normalApiTestAndSave={testMessage:await page.locator('#uf-api-msg').textContent(),saveRequest:(await page.request.get(`${originRef.origin}/__state`).then(r=>r.json())).saves[0],integrationChanges:await page.evaluate(()=>window.__integrationChanges),pageErrors:result.pageErrors.length};
   assert.equal(result.cases.normalApiTestAndSave.testMessage,'Saved');assert.equal(result.cases.normalApiTestAndSave.saveRequest.body.name,'Synthetic API');assert.equal(result.cases.normalApiTestAndSave.integrationChanges,before+1);await context.close();
  }
  await pageReset();
  // Late successful API Test after selecting CalDAV B.
  {
   const {context,page}=await newPage(browser,result.externalRequests,result.pageErrors);await openApi(page);await page.request.get(`${originRef.origin}/__hold-test`);const errorsBefore=result.pageErrors.length,testBefore=await consumed(page,'test');await page.locator('#uf-api-test').click();await page.waitForFunction(async()=> (await(await fetch('/__state')).json()).pendingTest);await openBDraft(page);await page.request.get(`${originRef.origin}/__release-test`);await waitForConsumed(page,'test',testBefore);await nextFrame(page);
   const s=await page.request.get(`${originRef.origin}/__state`).then(r=>r.json());const live=await page.evaluate(()=>({activeType:document.querySelector('.intg-card-active')?.dataset.intgType,activeId:document.querySelector('.intg-card-active')?.dataset.intgId,label:document.querySelector('#uf-caldav-label')?.value,url:document.querySelector('#uf-caldav-url')?.value,apiMessage:!!document.querySelector('#uf-api-msg'),changes:window.__integrationChanges}));
   result.cases.heldApiTestThenCalDavB={live,testRequests:s.tests.length,saves:s.saves.length,newPageErrors:result.pageErrors.length-errorsBefore};assert.equal(live.activeType,'caldav');assert.equal(live.activeId,'fixture-account-b');assert.equal(live.label,'B draft remains');assert.equal(live.url,'https://fixture.invalid/b-draft');assert.equal(live.apiMessage,false);assert.equal(s.saves.length,0);assert.equal(result.pageErrors.length,errorsBefore);await context.close();
  }
  await pageReset();
  // A successful late Test response after Cancel must leave the shared form hidden.
  {
   const {context,page}=await newPage(browser,result.externalRequests,result.pageErrors);await openApi(page);await page.request.get(`${originRef.origin}/__hold-test`);const testBefore=await consumed(page,'test');await page.locator('#uf-api-test').click();await page.waitForFunction(async()=> (await(await fetch('/__state')).json()).pendingTest);await page.locator('#uf-api-cancel').click();const errorsBefore=result.pageErrors.length;await page.request.get(`${originRef.origin}/__release-test`);await waitForConsumed(page,'test',testBefore);await nextFrame(page);
   const s=await page.request.get(`${originRef.origin}/__state`).then(r=>r.json());const live=await page.evaluate(()=>({visible:getComputedStyle(document.querySelector('#unified-intg-form')).display!=='none',message:document.querySelector('#uf-api-msg')?.textContent}));result.cases.cancelledApiTestResponse={live,testRequests:s.tests.length,newPageErrors:result.pageErrors.length-errorsBefore};assert.equal(live.visible,false);assert.equal(live.message,'');assert.equal(s.tests.length,1);assert.equal(result.pageErrors.length,errorsBefore);await context.close();
  }
  await pageReset();
  // Invalid Test JSON after the form changes follows the catch branch without touching CalDAV's UI.
  {
   const {context,page}=await newPage(browser,result.externalRequests,result.pageErrors);await openApi(page);await page.request.get(`${originRef.origin}/__hold-test`);await page.request.get(`${originRef.origin}/__fail-next-test`);const testBefore=await consumed(page,'test');await page.locator('#uf-api-test').click();await page.waitForFunction(async()=> (await(await fetch('/__state')).json()).pendingTest);await openBDraft(page);const errorsBefore=result.pageErrors.length;await page.request.get(`${originRef.origin}/__release-test`);await waitForConsumed(page,'test',testBefore);await nextFrame(page);
   const s=await page.request.get(`${originRef.origin}/__state`).then(r=>r.json());const live=await page.evaluate(()=>({activeType:document.querySelector('.intg-card-active')?.dataset.intgType,label:document.querySelector('#uf-caldav-label')?.value,url:document.querySelector('#uf-caldav-url')?.value,apiMessage:!!document.querySelector('#uf-api-msg')}));
   result.cases.heldMalformedApiTestThenCalDavB={live,testRequests:s.tests.length,newPageErrors:result.pageErrors.length-errorsBefore};assert.equal(live.activeType,'caldav');assert.equal(live.label,'B draft remains');assert.equal(live.url,'https://fixture.invalid/b-draft');assert.equal(live.apiMessage,false);assert.equal(result.pageErrors.length,errorsBefore);await context.close();
  }
  await pageReset();
  // Late successful API Save after selecting CalDAV B: the server accepts the write, while UI status stays owner-guarded.
  {
   const {context,page}=await newPage(browser,result.externalRequests,result.pageErrors);await openApi(page);await page.locator('#uf-api-name').fill('API save in flight');const before=await page.request.get(`${originRef.origin}/__state`).then(r=>r.json()),saveBefore=await consumed(page,'save'),listBefore=await consumed(page,'list');await page.request.get(`${originRef.origin}/__hold-save`);await page.locator('#uf-api-save').click();await page.waitForFunction(async()=> (await(await fetch('/__state')).json()).pendingSave);await openBDraft(page);const errorsBefore=result.pageErrors.length;await page.request.get(`${originRef.origin}/__release-save`);await waitForConsumed(page,'save',saveBefore);await waitForConsumed(page,'list',listBefore);await page.waitForFunction(()=>window.__integrationChanges===1);await page.waitForFunction(()=>[...document.querySelectorAll('.intg-card')].some(card=>card.textContent.includes('API save in flight')));await nextFrame(page);
   const s=await page.request.get(`${originRef.origin}/__state`).then(r=>r.json());const live=await page.evaluate(()=>({label:document.querySelector('#uf-caldav-label')?.value,url:document.querySelector('#uf-caldav-url')?.value,apiMessage:!!document.querySelector('#uf-api-msg'),apiForm:!!document.querySelector('#uf-api-name'),changes:window.__integrationChanges,listHasSavedName:[...document.querySelectorAll('.intg-card')].some(card=>card.textContent.includes('API save in flight'))}));
   result.cases.heldApiSaveThenCalDavB={live,saveRequests:s.saves.length,savedServerName:s.integration.name,savedPayload:s.saves[0]?.body,listReadsBefore:before.listReads,listReadsAfter:s.listReads,pageErrors:result.pageErrors.length,changes:live.changes};assert.equal(live.label,'B draft remains');assert.equal(live.url,'https://fixture.invalid/b-draft');assert.equal(live.apiMessage,false);assert.equal(live.apiForm,false);assert.equal(s.saves.length,1);assert.equal(s.integration.name,'API save in flight');assert.equal(live.changes,1);assert.ok(s.listReads>before.listReads);assert.equal(live.listHasSavedName,true);assert.equal(result.pageErrors.length,0);await context.close();
  }
  await pageReset();
  // Prove whether a committed Save is mislabeled if the subsequent list refresh is malformed.
  {
   const {context,page}=await newPage(browser,result.externalRequests,result.pageErrors);await openApi(page);await page.locator('#uf-api-name').fill('Accepted but list response null');const before=await page.request.get(`${originRef.origin}/__state`).then(r=>r.json()),saveBefore=await consumed(page,'save'),listBefore=await consumed(page,'list');await page.request.get(`${originRef.origin}/__null-next-integration-list`);await page.locator('#uf-api-save').click();await waitForConsumed(page,'save',saveBefore);await waitForConsumed(page,'list',listBefore);await page.waitForFunction(async([name])=>{const state=await(await fetch('/__state')).json(),message=document.querySelector('#uf-api-msg')?.textContent;return state.integration.name===name&&(message==='Failed'||window.__notificationLogRequests>0);},['Accepted but list response null']);await nextFrame(page);
   const after=await page.request.get(`${originRef.origin}/__state`).then(r=>r.json());const live=await page.evaluate(()=>({name:document.querySelector('#uf-api-name')?.value,message:document.querySelector('#uf-api-msg')?.textContent,changes:window.__integrationChanges,toast:document.querySelector('#toast')?.textContent}));result.cases.acceptedSaveThenNullListRefresh={live,saveRequests:after.saves.length,savedServerName:after.integration.name,listReadsBefore:before.listReads,listReadsAfter:after.listReads,errorToasts:after.errorToasts};assert.equal(after.saves.length,1);assert.equal(after.integration.name,'Accepted but list response null');assert.equal(live.message,'Saved');assert.equal(live.changes,1);assert.ok(after.listReads>before.listReads);assert.match(live.toast,/could not be refreshed/i);await context.close();
  }
 }catch(e){result.failure=e.stack||e;process.exitCode=1;}
 finally{result.pass=!result.failure&&result.externalRequests.length===0&&result.pageErrors.length===0;if(state.pendingTest){json(state.pendingTest.res,{ok:false,message:'fixture cleanup'});state.pendingTest=null;}if(state.pendingSave){json(state.pendingSave.res,{ok:false});state.pendingSave=null;}if(browser)await browser.close().catch(()=>{});if(server.closeAllConnections)server.closeAllConnections();await new Promise(resolve=>server.close(()=>resolve())).catch(()=>{});process.stdout.write(JSON.stringify(result,null,2)+'\n');}
 async function pageReset(){if(state.pendingTest||state.pendingSave)throw new Error('pending fixture response at reset');await new Promise((resolve,reject)=>{http.get(`${originRef.origin}/__reset`,r=>{r.resume();r.on('end',resolve);}).on('error',reject);});}
})();
