const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = process.env.SOURCE_ROOT || path.resolve(__dirname, '../..');
const groupsInitial = [
  { id: 'fixture-a', name: 'Synthetic A', mode: 'parallel', participants: [] },
  { id: 'fixture-b', name: 'Synthetic B', mode: 'parallel', participants: [] },
];
let scenario = '';
let groups = [];
let requests = [];
let getCount = 0;
let postCount = 0;
let pageErrors = [];
let allPageErrors = [];
let externalRequests = [];
let externalRequestCount = 0;
let blockedPosts = [];
let holdNextPost = false;
let heldPostResolve = null;
let heldPostCount = 0;
let holdNextGet = false;
let heldGetResolve = null;
let heldGetCount = 0;
function waitNode(test, label) { return new Promise((resolve,reject)=>{ const start=Date.now(); const poll=()=>{ if(test()) return resolve(); if(Date.now()-start>8000) return reject(new Error('timeout waiting for '+label)); setTimeout(poll,5); }; poll(); }); }
const html = `<!doctype html><meta charset="utf-8"><body>
<div id="custom-preset-modal">
  <div class="preset-tab active" data-chartab="group">Group</div>
  <div class="preset-chartab" data-chartab-panel="group">
    <div id="group-holder"><div id="group-participants"><span>Ready</span></div></div>
    <button id="group-add-btn" type="button">Add participant</button>
  </div>
</div>
<button id="group-mode-btn" type="button">Mode</button><button id="save-custom-preset" type="button">Start</button>
<div id="toast"></div>
<script>window.__confirmCalls=0;window.__confirmGate=null;window.styledConfirm=async()=>{window.__confirmCalls++;if(window.__confirmGate)await window.__confirmGate;return true};</script>
<script type="module">
 import group from '/static/js/group.js';
 group.init('');
 window.styledConfirm=async()=>{window.__confirmCalls++;if(window.__confirmGate)await window.__confirmGate;return true};
 document.querySelector('.preset-tab[data-chartab="group"]').click();
 window.groupReady=true;
</script></body>`;
const json = (res, value, status=200) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, {'Content-Type':'text/html'}); return res.end(html); }
  if (url.pathname === '/__hold-post') { holdNextPost=true; req.resume(); return json(res,{ok:true}); }
  if (url.pathname === '/__release-post') { heldPostResolve?.(); heldPostResolve=null; req.resume(); return json(res,{ok:true}); }
  if (url.pathname === '/__hold-get') { holdNextGet=true; req.resume(); return json(res,{ok:true}); }
  if (url.pathname === '/__release-get') { heldGetResolve?.(); heldGetResolve=null; req.resume(); return json(res,{ok:true}); }
  if (url.pathname === '/api/presets/groups') {
    if (req.method === 'GET') { getCount++; req.resume(); const snapshot=structuredClone(groups); if (scenario==='refresh-500' && getCount===2) return json(res,{detail:'synthetic unavailable'},500); if (holdNextGet) { holdNextGet=false; heldGetCount++; await new Promise(resolve=>{heldGetResolve=resolve;}); } return json(res,{groups:snapshot}); }
    if (req.method === 'POST') {
      let body=''; for await (const chunk of req) body += chunk;
      const parsed=JSON.parse(body); postCount++;
      requests.push({scenario, body:parsed});
      if (holdNextPost) { holdNextPost=false; heldPostCount++; await new Promise(resolve=>{heldPostResolve=resolve;}); }
      if (scenario==='http-500' && postCount===1) return json(res,{detail:'synthetic unavailable'},500);
      groups=parsed.groups;
      return json(res,{ok:true});
    }
  }
  if (url.pathname.startsWith('/api/')) { req.resume(); return json(res,{}); }
  const file=path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {'Content-Type':(/\.(?:js|mjs)$/.test(file)?'text/javascript':'application/octet-stream')});
  fs.createReadStream(file).pipe(res);
});
(async()=>{
 let browser;
 const cases={};
 try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'/opt/google/chrome/chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
  async function open(which) {
   scenario=which; groups=structuredClone(groupsInitial); requests=[]; getCount=0; postCount=0; pageErrors=[]; externalRequests=[]; blockedPosts=[]; holdNextPost=false; heldPostResolve=null; heldPostCount=0; holdNextGet=false; heldGetResolve=null; heldGetCount=0;
   const context=await browser.newContext(); const page=await context.newPage();
   page.on('pageerror',e=>{pageErrors.push(e.message);allPageErrors.push({scenario,message:e.message});});
   await page.addInitScript(() => { window.__groupGetCompleted=0; window.__groupPostRejected=0; window.addEventListener('unhandledrejection', () => { window.__groupPostRejected++; }); const originalFetch=window.fetch.bind(window); window.fetch=async (...args)=>{ const response=await originalFetch(...args); if(String(args[0]).includes('/api/presets/groups') && (!args[1]?.method || args[1].method==='GET')) window.__groupGetCompleted++; return response; }; });
   await page.route('**/*',async route=>{const u=new URL(route.request().url()); if(u.origin!==`http://127.0.0.1:${server.address().port}`){externalRequests.push(u.href);externalRequestCount++;return route.abort();} if(u.pathname==='/api/presets/groups' && route.request().method()==='POST' && blockedPosts.length===0){if(scenario==='network-failure'){blockedPosts.push(JSON.parse(route.request().postData()));return route.abort('failed');}if(scenario==='accepted-response-lost'){blockedPosts.push(JSON.parse(route.request().postData()));const response=await route.fetch();await response.dispose();return route.abort('failed');}} return route.continue();});
   await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.groupReady===true);
   await page.waitForFunction(()=>window.__groupGetCompleted===1 && document.querySelectorAll('#group-presets-list button').length===2);
   return {context,page};
  }
  {
   const {context,page}=await open('network-failure');
   await page.locator('#group-presets-list button').nth(0).locator('span').nth(1).dispatchEvent('click');
   await waitNode(()=>blockedPosts.length===1,'first delete request blocked');
   await page.waitForFunction(()=>window.__groupGetCompleted===2 && document.querySelectorAll('#group-presets-list button').length===2);
   assert.equal(await page.evaluate(()=>window.__groupGetCompleted),2,'network rejection refreshes the current list before retry');
   const afterFailure={groups:groups.map(g=>g.name), chips:await page.locator('#group-presets-list button span:first-child').allTextContents(), blockedPosts:blockedPosts.map(p=>p.groups.map(g=>g.name)), acceptedPosts:requests.map(r=>r.body.groups.map(g=>g.name)), postCount};
   assert.deepEqual(afterFailure.groups,['Synthetic A','Synthetic B']);
   assert.deepEqual(afterFailure.chips,['Synthetic A','Synthetic B']);
   assert.match(await page.locator('#toast').textContent(),/Could not confirm the delete\. The list was refreshed/);
   assert.deepEqual(afterFailure.blockedPosts,[['Synthetic B']]);
   assert.deepEqual(afterFailure.acceptedPosts,[]);
   assert.equal(afterFailure.postCount,0);
   await page.locator('#group-presets-list button').nth(0).locator('span').nth(1).dispatchEvent('click');
   await waitNode(()=>postCount===1 && groups.length===1,'retry POST accepted');
   await page.waitForFunction(()=>window.__groupGetCompleted===3 && document.querySelectorAll('#group-presets-list button').length===1);
   const afterRetry={groups:groups.map(g=>g.name), posts:requests.map(r=>r.body.groups.map(g=>g.name)), chips:await page.locator('#group-presets-list button span:first-child').allTextContents(), errors:pageErrors.slice()};
   assert.deepEqual(afterRetry.posts,[['Synthetic B']]);
   assert.deepEqual(afterRetry.groups,['Synthetic B']);
   assert.deepEqual(afterRetry.chips,['Synthetic B']);
   cases.networkRejectionRetryDeletesOnlyA= {afterFailure,afterRetry};
   await context.close();
  }
  {
   const {context,page}=await open('accepted-response-lost');
   await page.locator('#group-presets-list button').nth(0).locator('span').nth(1).dispatchEvent('click');
   await page.waitForFunction(()=>window.__groupGetCompleted===2 && document.querySelectorAll('#group-presets-list button').length===1);
   const afterLostReply={groups:groups.map(g=>g.name),chips:await page.locator('#group-presets-list button span:first-child').allTextContents(),submitted:requests.map(r=>r.body.groups.map(g=>g.name)),blocked:blockedPosts.map(p=>p.groups.map(g=>g.name)),toast:await page.locator('#toast').textContent()};
   assert.deepEqual(afterLostReply.groups,['Synthetic B']);
   assert.deepEqual(afterLostReply.chips,['Synthetic B']);
   assert.deepEqual(afterLostReply.submitted,[['Synthetic B']]);
   assert.deepEqual(afterLostReply.blocked,[['Synthetic B']]);
   assert.match(afterLostReply.toast,/Could not confirm the delete\. The list was refreshed/);
   await page.locator('#group-presets-list button').nth(0).locator('span').nth(1).dispatchEvent('click');
   await waitNode(()=>postCount===2 && groups.length===0,'delete of remaining B follows reconciled list');
   await page.waitForFunction(()=>window.__groupGetCompleted===3 && document.querySelectorAll('#group-presets-list button').length===0);
   cases.acceptedWriteLostReplyRefreshesBeforeRetry={afterLostReply,posts:requests.map(r=>r.body.groups.map(g=>g.name)),groups:groups.map(g=>g.name)};
   assert.deepEqual(cases.acceptedWriteLostReplyRefreshesBeforeRetry.posts,[['Synthetic B'],[]]);
   assert.deepEqual(cases.acceptedWriteLostReplyRefreshesBeforeRetry.groups,[]);
   await context.close();
  }
  {
   const {context,page}=await open('refresh-500');
   await page.locator('#group-presets-list button').nth(0).locator('span').nth(1).dispatchEvent('click');
   await waitNode(()=>postCount===1 && groups.length===1,'delete accepted before refresh failure');
   await waitNode(()=>getCount===2,'failed refresh response received');
   assert.deepEqual(await page.locator('#group-presets-list button span:first-child').allTextContents(),['Synthetic A','Synthetic B'],'failed refresh preserves rendered list');
   assert.match(await page.locator('#toast').textContent(),/Preset deleted, but the list could not refresh/);
   await page.locator('#group-presets-list button').nth(1).locator('span').nth(1).dispatchEvent('click');
   assert.equal(postCount,1,'stale chip cannot submit a delete that would restore A');
   assert.match(await page.locator('#toast').textContent(),/Group preset list needs to reload/);
   await page.locator('.preset-tab[data-chartab="group"]').dispatchEvent('click');
   await page.waitForFunction(()=>window.__groupGetCompleted===3 && document.querySelectorAll('#group-presets-list button').length===1);
   cases.acceptedDeleteRefreshFailure={groups:groups.map(g=>g.name),posts:requests.map(r=>r.body.groups.map(g=>g.name)),chips:await page.locator('#group-presets-list button span:first-child').allTextContents()};
   assert.deepEqual(cases.acceptedDeleteRefreshFailure.posts,[['Synthetic B']]);
   assert.deepEqual(cases.acceptedDeleteRefreshFailure.groups,['Synthetic B']);
   assert.deepEqual(cases.acceptedDeleteRefreshFailure.chips,['Synthetic B']);
   await context.close();
  }
  {
   const {context,page}=await open('http-500');
   await page.locator('#group-presets-list button').nth(0).dispatchEvent('contextmenu');
   await waitNode(()=>postCount===1,'HTTP500 first delete request');
   await page.waitForFunction(()=>window.__groupGetCompleted===2 && document.querySelectorAll('#group-presets-list button').length===2);
   assert.match(await page.locator('#toast').textContent(),/Could not confirm the delete\. The list was refreshed/);
   await page.locator('#group-presets-list button').nth(0).locator('span').nth(1).dispatchEvent('click');
   await waitNode(()=>postCount===2 && groups.length===1,'HTTP500 retry accepted');
   await page.waitForFunction(()=>window.__groupGetCompleted===3 && document.querySelectorAll('#group-presets-list button').length===1);
   cases.http500RerendersBeforeSecondClick={groups:groups.map(g=>g.name), posts:requests.map(r=>r.body.groups.map(g=>g.name)), chips:await page.locator('#group-presets-list button span:first-child').allTextContents(), errors:pageErrors.slice()};
   assert.deepEqual(cases.http500RerendersBeforeSecondClick.posts,[['Synthetic B'],['Synthetic B']]);
   assert.deepEqual(cases.http500RerendersBeforeSecondClick.groups,['Synthetic B']);
   assert.deepEqual(cases.http500RerendersBeforeSecondClick.chips,['Synthetic B']);
   await context.close();
  }
  {
   const {context,page}=await open('stale-get');
   await page.request.get(`http://127.0.0.1:${server.address().port}/__hold-get`);
   await page.locator('.preset-tab[data-chartab="group"]').dispatchEvent('click');
   await waitNode(()=>heldGetCount===1,'older list GET held');
   await page.locator('#group-presets-list button').nth(0).locator('span').nth(1).dispatchEvent('click');
   await page.waitForFunction(()=>window.__groupGetCompleted===2 && document.querySelectorAll('#group-presets-list button').length===1);
   await page.request.get(`http://127.0.0.1:${server.address().port}/__release-get`);
   await page.waitForFunction(()=>window.__groupGetCompleted===3);
   const afterOldResponse={groups:groups.map(g=>g.name),chips:await page.locator('#group-presets-list button span:first-child').allTextContents(),posts:requests.map(r=>r.body.groups.map(g=>g.name))};
   assert.deepEqual(afterOldResponse.groups,['Synthetic B']);
   assert.deepEqual(afterOldResponse.chips,['Synthetic B'],'older GET cannot repaint deleted A');
   await page.locator('#group-presets-list button').nth(0).locator('span').nth(1).dispatchEvent('click');
   await waitNode(()=>postCount===2 && groups.length===0,'delete current B after old GET is ignored');
   await page.waitForFunction(()=>window.__groupGetCompleted===4 && document.querySelectorAll('#group-presets-list button').length===0);
   cases.olderListResponseCannotRestoreDeletedPreset={afterOldResponse,posts:requests.map(r=>r.body.groups.map(g=>g.name)),groups:groups.map(g=>g.name)};
   assert.deepEqual(cases.olderListResponseCannotRestoreDeletedPreset.posts,[['Synthetic B'],[]]);
   assert.deepEqual(cases.olderListResponseCannotRestoreDeletedPreset.groups,[]);
   await context.close();
  }
  {
   const {context,page}=await open('held-post-overlap');
   await page.request.get(`http://127.0.0.1:${server.address().port}/__hold-post`);
   await page.locator('#group-presets-list button').nth(0).locator('span').nth(1).dispatchEvent('click');
   await waitNode(()=>heldPostCount===1,'first delete held at server');
   await page.locator('#group-presets-list button').nth(0).locator('span').nth(1).dispatchEvent('click');
   await page.locator('#group-presets-list button').nth(1).locator('span').nth(1).dispatchEvent('click');
   assert.equal(requests.length,1,'duplicate and different-chip deletes are ignored while first POST is held');
   await page.request.get(`http://127.0.0.1:${server.address().port}/__release-post`);
   await waitNode(()=>postCount===1 && groups.length===1,'held first delete accepted');
   await page.waitForFunction(()=>window.__groupGetCompleted===2 && document.querySelectorAll('#group-presets-list button').length===1);
   cases.heldDifferentChipClick={groups:groups.map(g=>g.name),posts:requests.map(r=>r.body.groups.map(g=>g.name)),chips:await page.locator('#group-presets-list button span:first-child').allTextContents()};
   assert.deepEqual(cases.heldDifferentChipClick.posts,[['Synthetic B']]);
   assert.deepEqual(cases.heldDifferentChipClick.groups,['Synthetic B']);
   await context.close();
  }
  {
   const {context,page}=await open('held-confirm-overlap');
   await page.evaluate(()=>{window.__confirmGate=new Promise(resolve=>{window.__releaseConfirm=resolve});});
   await page.locator('#group-presets-list button').nth(0).dispatchEvent('contextmenu');
   await page.waitForFunction(()=>window.__confirmCalls===1);
   await page.locator('#group-presets-list button').nth(1).locator('span').nth(1).dispatchEvent('click');
   assert.equal(requests.length,0,'X click is ignored while context-menu confirmation is pending');
   await page.evaluate(()=>window.__releaseConfirm());
   await waitNode(()=>postCount===1 && groups.length===1,'confirmed delete accepted');
   await page.waitForFunction(()=>window.__groupGetCompleted===2 && document.querySelectorAll('#group-presets-list button').length===1);
   cases.heldConfirmationDifferentChipClick={groups:groups.map(g=>g.name),posts:requests.map(r=>r.body.groups.map(g=>g.name)),chips:await page.locator('#group-presets-list button span:first-child').allTextContents()};
   assert.deepEqual(cases.heldConfirmationDifferentChipClick.posts,[['Synthetic B']]);
   assert.deepEqual(cases.heldConfirmationDifferentChipClick.groups,['Synthetic B']);
   await context.close();
  }
  {
   const {context,page}=await open('success-control');
   await page.locator('#group-presets-list button').nth(0).dispatchEvent('contextmenu');
   await waitNode(()=>postCount===1 && groups.length===1,'successful delete accepted');
   await page.waitForFunction(()=>window.__groupGetCompleted===2 && document.querySelectorAll('#group-presets-list button').length===1);
   cases.successControl={groups:groups.map(g=>g.name), posts:requests.map(r=>r.body.groups.map(g=>g.name)), chips:await page.locator('#group-presets-list button span:first-child').allTextContents(), errors:pageErrors.slice()};
   assert.deepEqual(cases.successControl.posts,[['Synthetic B']]);
   assert.deepEqual(cases.successControl.groups,['Synthetic B']);
   await context.close();
  }
  assert.equal(externalRequestCount,0,'all browser requests stay on the local fixture origin');
  assert.deepEqual(allPageErrors,[],'no unhandled browser page errors');
  console.log(JSON.stringify({pass:true, cases, externalRequestCount, pageErrors:allPageErrors, scope:'Actual static/js/group.js module and rendered chip UI in a minimal synthetic DOM; loopback-only presets endpoint; no models, tools, chats, or real preset data.'},null,2));
 } finally {
  if(browser) await browser.close();
  server.closeAllConnections?.();
  await new Promise(resolve=>server.close(()=>resolve()));
 }
})().catch(e=>{console.error(e, {scenario, getCount, postCount, requests, pageErrors});process.exitCode=1;});
