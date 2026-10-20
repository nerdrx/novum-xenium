const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(process.env.NOVUM_REPO_ROOT || path.resolve(__dirname, '../..'));
const staticRoot = path.join(repo, 'static');
const html = `<!doctype html><meta charset="utf-8">
<div class="list-item active-session" data-session-id="chat-A"></div>
<textarea id="message"></textarea><div id="attach-strip"></div><input id="file-input" type="file" multiple>
<input id="incognito-toggle" type="checkbox"><input id="web-toggle" type="checkbox"><input id="research-toggle" type="checkbox"><input id="bash-toggle" type="checkbox"><button id="research-toggle-btn"></button>
<button id="workspace-indicator-btn"></button><span id="workspace-indicator-name"></span><button id="overflow-workspace-btn"></button>
<div id="chat-history"></div><button class="send-btn"></button><div id="toast"></div>
<script type="module">
  import chat from '/static/js/chat.js';
  import sessions from '/static/js/sessions.js';
  import * as workspace from '/static/js/workspace.js';
  import workspaceDefault from '/static/js/workspace.js';
  import Storage from '/static/js/storage.js';
  import ui from '/static/js/ui.js?v=20260916largetoolscroll1';
  window.modulesReady = Promise.all([chat, sessions]).then(() => {
    window.testModules = { chat, sessions, workspace, workspaceDefault, Storage, ui };
  }).catch(error => { window.moduleError = error.stack || String(error); throw error; });
</script>`;
let held = null;
const heldVets = new Map();
const vetRequests = [];
const requests = [];
let origin;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture') { res.writeHead(200, {'Content-Type':'text/html'}); return res.end(html); }
  if (url.pathname === '/api/auth/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({configured:false,authenticated:false,username:null}));
  }
  if (url.pathname === '/api/workspace/vet') {
    const vetPath = url.searchParams.get('path') || '';
    vetRequests.push(vetPath);
    heldVets.set(vetPath, res);
    return;
  }
  if (url.pathname === '/__release-vet') {
    const vetPath = url.searchParams.get('path') || '';
    const response = heldVets.get(vetPath);
    if (!response) { res.writeHead(404); return res.end(); }
    heldVets.delete(vetPath);
    const ok = url.searchParams.get('ok') === 'true';
    response.writeHead(ok ? 200 : 409, {'Content-Type':'application/json'});
    response.end(JSON.stringify(ok ? {ok:true,path:'/synthetic/canonical-B'} : {ok:false,path:null}));
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/chat_stream') {
    let raw=''; for await (const chunk of req) raw += chunk.toString('utf8');
    const value = name => raw.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`))?.[1] || '';
    const record = { session:value('session'), workspace:value('workspace'), response:res };
    requests.push(record);
    held = record;
    return;
  }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname.replace(/^\/static/, ''))}`);
  if (url.pathname.startsWith('/static/') && file.startsWith(`${staticRoot}${path.sep}`) && fs.existsSync(file)) {
    res.writeHead(200, {'Content-Type':(file.endsWith('.js') || file.endsWith('.mjs')) ? 'text/javascript' : 'application/octet-stream', 'Cache-Control':'no-store'});
    return fs.createReadStream(file).pipe(res);
  }
  if (url.pathname.startsWith('/api/')) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end('{}'); }
  res.writeHead(404); res.end('Not found');
});
function release(path='/synthetic/workspace-A') {
  assert.ok(held, 'expected a held actual chat SSE POST');
  const { response } = held; held = null;
  response.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-store'});
  response.end(`data: ${JSON.stringify({type:'workspace_rejected',data:{path}})}\n\ndata: [DONE]\n\n`);
}
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',args:['--no-sandbox','--disable-gpu']});
  try {
    const results=[];
    const scenarios = [
      {name:'settled-newer-B-preserved', current:'/synthetic/workspace-B', expected:'/synthetic/workspace-B'},
      {name:'current-rejected-A-cleared', current:'/synthetic/workspace-A', expected:''},
      {name:'pending-B-success-survives-rejection-A', current:'pending-vet-B', vetOk:true, expected:'/synthetic/canonical-B'},
      {name:'pending-B-failure-leaves-invalid-A-cleared', current:'pending-vet-B', vetOk:false, expected:''},
    ];
    for (const test of scenarios) {
      const currentPath=test.current;
      const page=await browser.newPage(); page.setDefaultTimeout(10000);
      const errors=[]; const diagnostics=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>diagnostics.push(`console:${m.type()}:${m.text()}`)); page.on('requestfailed',r=>diagnostics.push(`requestfailed:${r.url()}:${r.failure()?.errorText}`)); page.on('response',r=>{if(r.url().startsWith(origin) && (r.status()>=400 || r.request().resourceType()==='script')) diagnostics.push(`response:${r.status()}:${r.request().resourceType()}:${r.url()}:${r.headers()['content-type']}`)});
      page.on('request',request=>assert.ok(request.url().startsWith(origin),'fixture blocks external requests'));
      await page.goto(`${origin}/fixture`);
      await page.waitForFunction(()=>window.testModules,{timeout:7000}).catch(async error=>{ console.error('module diagnostic',await page.evaluate(()=>({ready:!!window.modulesReady,modules:!!window.testModules,moduleError:window.moduleError})),errors,diagnostics); throw error; });
      await page.evaluate(async () => {
        const {chat,sessions,workspace,Storage,ui}=window.testModules;
        sessions.setCurrentSessionId('chat-A');
        workspace.setWorkspace('/synthetic/workspace-A');
        Storage.saveToggleState({mode:'agent'});
        ui.showToast = message => { window.rejectionToast = message; };
        window.rejectionCleanupResults=[];
        const nativeClearRejected = window.testModules.workspaceDefault.clearRejectedWorkspace;
        window.testModules.workspaceDefault.clearRejectedWorkspace = path => {
          const cleared=nativeClearRejected(path);
          window.rejectionCleanupResults.push({path,cleared});
          return cleared;
        };
        document.getElementById('message').value='Synthetic workspace rejection proof';
        window.sendSettled=false;
        window.sendPromise=chat.handleChatSubmit({preventDefault(){}}).finally(()=>window.sendSettled=true);
      });
      const until=Date.now()+8000;
      while (!held && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,10));
      assert.ok(held,'chat request should reach the held synthetic SSE endpoint');
      const request=requests.at(-1);
      assert.equal(request.session,'chat-A');
      assert.equal(request.workspace,'/synthetic/workspace-A','POST carries the workspace originally rejected');
      await page.evaluate(path=>{
        window.testModules.sessions.setCurrentSessionId('chat-B');
        if (path === 'pending-vet-B') window.pendingVet = window.testModules.workspace.vetAndSetWorkspace('/synthetic/pending-workspace-B');
        else window.testModules.workspace.setWorkspace(path);
      },currentPath);
      if (currentPath === 'pending-vet-B') {
        const vetUntil=Date.now()+5000;
        while (!heldVets.has('/synthetic/pending-workspace-B') && Date.now()<vetUntil) await new Promise(resolve=>setTimeout(resolve,10));
        assert.ok(heldVets.has('/synthetic/pending-workspace-B'),'new workspace vet request should be held before rejection arrives');
      }
      release();
      await page.waitForFunction(()=>window.sendSettled,{timeout:7000});
      await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
      assert.ok(await page.evaluate(()=>!!window.rejectionToast),'rejection remains visible to the user');
      let observed=await page.evaluate(()=>({workspace:window.testModules.workspace.getWorkspace(),session:window.testModules.sessions.getCurrentSessionId(),toast:window.rejectionToast,sendSettled:window.sendSettled}));
      let vetResult=null;
      if (currentPath === 'pending-vet-B') {
        const response=await fetch(`${origin}/__release-vet?path=${encodeURIComponent('/synthetic/pending-workspace-B')}&ok=${test.vetOk}`);
        assert.equal(response.status,204,'held B vet response is released');
        vetResult=await page.evaluate(async()=>window.pendingVet);
        observed={...observed,workspace:await page.evaluate(()=>window.testModules.workspace.getWorkspace())};
      }
      assert.deepEqual(errors,[]);
      const cleanup=await page.evaluate(()=>window.rejectionCleanupResults);
      const scenario=test.name;
      const passed=observed.workspace===test.expected && !!observed.toast && observed.sendSettled && errors.length===0 && (test.vetOk===undefined ? true : test.vetOk ? vetResult?.ok===true : vetResult?.ok===false && !vetResult?.stale);
      results.push({scenario,postWorkspaceWasA:request.workspace==='/synthetic/workspace-A',expectedWorkspace:test.expected,observedWorkspace:observed.workspace,session:observed.session,toastShown:!!observed.toast,cleanup,pendingVetResult:vetResult,sendSettled:observed.sendSettled,pageErrors:errors.length,passed});
      await page.close();
    }
    const summary={pass:results.length===scenarios.length && results.every(x=>x.passed),loopbackOnly:true,actualChatModule:true,actualWorkspaceModule:true,syntheticOnly:true,results};
    console.log(JSON.stringify(summary));
    assert.equal(summary.results.length,scenarios.length,'all selected controls executed');
    assert.equal(summary.pass,true,'all selected workspace rejection ownership controls must pass');
  } finally {
    await browser.close(); server.closeAllConnections?.(); await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);server.closeAllConnections?.();server.close();process.exitCode=1;});
