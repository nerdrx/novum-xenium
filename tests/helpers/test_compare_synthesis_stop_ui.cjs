const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(process.env.NOVUM_REPO_ROOT || path.resolve(__dirname, '../..'));
const staticRoot = path.join(repo, 'static');
const html = `<!doctype html><meta charset="utf-8"><body>
<textarea id="message"></textarea><input id="incognito-toggle" type="checkbox"><input id="web-toggle" type="checkbox"><button class="send-btn"></button>
<button id="compare-shuffle-btn"></button><button id="compare-check-btn"></button><button id="compare-add-btn"></button><div id="compare-vote-bar"></div><div id="cmp-badge-0"></div><div id="cmp-title-0"></div>
<div class="compare-pane" data-pane="0"><button class="pane-stop-btn"></button><div id="cmp-summary-0"></div><div id="cmp-history-0"></div></div><div id="toast"></div>
<script type="module">
 import compare, {handleCompareSubmit} from '/static/js/compare/index.js';
 import state from '/static/js/compare/state.js';
 import spinner from '/static/js/spinner.js';
 import {getKnownAuthState, authStatePromise} from '/static/js/authState.js';
 window.ready=Promise.resolve(authStatePromise).then(()=>{window.fixture={compare,handleCompareSubmit,state,getKnownAuthState,spinner};});
</script></body>`;
let currentCase = '';
let createHold = 'none';
let heldCreates = [];
let heldJson = null;
let heldChat = null;
const events = [];
const chatBodies = [];
const deletes = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') { res.writeHead(200, {'Content-Type':'text/html'}); return res.end(html); }
  if (url.pathname === '/api/auth/status') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({configured:true,authenticated:true,username:'SyntheticAlice'})); }
  if (url.pathname === '/api/search/query') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({results:[{title:'Synthetic result',snippet:'Synthetic snippet',url:'https://example.invalid/'}],time:0.01})); }
  if (url.pathname === '/api/session' && req.method === 'POST') {
    events.push({case:currentCase,method:'POST',path:'/api/session'});
    const id = `synthetic-${currentCase}-${heldCreates.length + 1}`;
    if (createHold === 'headers') { heldCreates.push({res,id}); return; }
    if (createHold === 'json') { res.writeHead(200, {'Content-Type':'application/json'}); heldJson={res,id}; return; }
    res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({id}));
  }
  if (url.pathname === '/api/chat_stream' && req.method === 'POST') {
    let body=''; for await (const chunk of req) body += chunk.toString('utf8');
    events.push({case:currentCase,method:'POST',path:'/api/chat_stream'});
    chatBodies.push({case:currentCase,body});
    if (['spinner-stop','image-spinner-stop','tool-wave-stop'].includes(currentCase)) {
      heldChat=res;
      if (currentCase !== 'spinner-stop') {
        const tool = currentCase === 'image-spinner-stop' ? 'generate_image' : 'bash';
        res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-store'});
        res.write(`data: ${JSON.stringify({type:'tool_start',tool,command:'synthetic only'})}\n\n`);
      }
      return;
    }
    res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-store'}); return res.end('data: [DONE]\n\n');
  }
  if (url.pathname.startsWith('/api/session/') && req.method === 'DELETE') { deletes.push(currentCase); res.writeHead(204); return res.end(); }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname.replace(/^\/static/, ''))}`);
  if (url.pathname.startsWith('/static/') && file.startsWith(`${staticRoot}${path.sep}`) && fs.existsSync(file)) {
    res.writeHead(200, {'Content-Type':(file.endsWith('.js')||file.endsWith('.mjs'))?'text/javascript':'application/octet-stream','Cache-Control':'no-store'});
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404); res.end();
});
async function openCase(browser, name, mode='search') {
  currentCase=name; const context=await browser.newContext(); const page=await context.newPage(); page.setDefaultTimeout(10000);
  const origin=`http://127.0.0.1:${server.address().port}`; const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>assert.ok(r.url().startsWith(origin),'external request blocked by fixture'));
  await page.addInitScript(()=>localStorage.setItem('odysseus-auth-user','SyntheticAlice'));
  await page.goto(origin); await page.waitForFunction(()=>window.fixture,{timeout:10000});
  await page.evaluate(mode=>{
    const {state,spinner}=window.fixture;
    const create=spinner.create.bind(spinner);
    spinner.create=(...args)=>{const item=create(...args);window.spinners=(window.spinners||[]);window.spinners.push(item);const destroy=item.destroy.bind(item);item.destroy=(...xs)=>{window.destroyed=(window.destroyed||0)+1;return destroy(...xs);};return item;};
    state.API_BASE='';state.isActive=true;state._streaming=false;state._abortControllers=[];
    state._selectedModels=[{model:'synthetic-model',name:'Synthetic'}];state._paneSessionIds=['synthetic-pane-session'];
    state._compareMode=mode;state._searchSynthModels=mode==='search'?[{endpoint:'',model:'synthetic-synth-model'}]:null;
    state._parallel=true;state._blindMode=true;state._timeout=30;
    const native=window.fetch.bind(window);
    window.fetch=(url,opts={})=>{if(String(url).includes('/api/session')&&opts.method==='POST')window.createSignal=opts.signal;return native(url,opts);};
  },mode);
  return {page,context,errors};
}
async function startSearch(page, text) { await page.evaluate(text=>{document.getElementById('message').value=text;window.fixture.handleCompareSubmit({preventDefault(){}});},text); }
async function stop(page) { await page.evaluate(()=>window.fixture.handleCompareSubmit({preventDefault(){}})); }
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-gpu']});
  const result={pass:false,cases:{},externalRequests:0};
  try {
    // Stop aborts synthesis before response headers arrive and doesn't post to chat.
    {
      currentCase='stop-headers';createHold='headers';heldCreates=[];
      const {page,context,errors}=await openCase(browser,currentCase);
      await startSearch(page,'headers-held'); const until=Date.now()+5000;while(!heldCreates.length&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
      assert.equal(heldCreates.length,1);await stop(page);
      const aborted=await page.evaluate(()=>window.createSignal.aborted);
      await page.waitForFunction(()=>document.querySelector('#cmp-history-0').innerText.includes('Synthesis was stopped.'),{timeout:5000});
      if(!heldCreates[0].res.destroyed){heldCreates[0].res.writeHead(200,{'Content-Type':'application/json'});heldCreates[0].res.end(JSON.stringify({id:heldCreates[0].id}));}
      await new Promise(r=>setTimeout(r,50));
      const noChat=!chatBodies.some(x=>x.case==='stop-headers');
      result.cases.heldHeaders={signalAborted:aborted,noChatPost:noChat,cancelFeedback:true};
      assert.equal(aborted,true);assert.equal(noChat,true);assert.deepEqual(errors,[]);await context.close();
    }
    // Stop aborts body parsing even after session response headers were received.
    {
      currentCase='stop-json';createHold='json';heldJson=null;
      const {page,context,errors}=await openCase(browser,currentCase);
      await startSearch(page,'json-held');const until=Date.now()+5000;while(!heldJson&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
      assert.ok(heldJson);await stop(page);const aborted=await page.evaluate(()=>window.createSignal.aborted);
      await page.waitForFunction(()=>document.querySelector('#cmp-history-0').innerText.includes('Synthesis was stopped.'),{timeout:5000});
      if(!heldJson.res.destroyed)heldJson.res.end(JSON.stringify({id:heldJson.id}));heldJson=null;
      await new Promise(r=>setTimeout(r,50));const noChat=!chatBodies.some(x=>x.case==='stop-json');
      result.cases.heldJson={headersReceived:true,signalAborted:aborted,noChatPost:noChat};
      assert.equal(aborted,true);assert.equal(noChat,true);assert.deepEqual(errors,[]);await context.close();
    }
    // A's abort/finally cannot clear the active Stop state for B; B then completes normally.
    {
      currentCase='round-A-B';createHold='headers';heldCreates=[];
      const {page,context,errors}=await openCase(browser,currentCase);
      await startSearch(page,'round A');const untilA=Date.now()+5000;while(heldCreates.length<1&&Date.now()<untilA)await new Promise(r=>setTimeout(r,10));
      await page.evaluate(()=>{window.fixture.handleCompareSubmit({preventDefault(){}});document.getElementById('message').value='round B';window.fixture.handleCompareSubmit({preventDefault(){}});window.bStartedBusy=window.fixture.state._streaming;});
      const untilB=Date.now()+5000;while(heldCreates.length<2&&Date.now()<untilB)await new Promise(r=>setTimeout(r,10));assert.equal(heldCreates.length,2);
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('#cmp-history-0 .body')).some(x=>x.innerText.includes('Synthesis was stopped.')),{timeout:5000});
      const during=await page.evaluate(()=>({startedBusy:window.bStartedBusy,busy:window.fixture.state._streaming,active:window.fixture.state._abortControllers.some(Boolean),sendMode:document.querySelector('.send-btn').dataset.mode}));
      assert.deepEqual(during,{startedBusy:true,busy:true,active:true,sendMode:'streaming'});
      result.cases.newRoundOwnership={...during};
      const bResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat_stream',{timeout:5000});
      for(const held of heldCreates)if(!held.res.destroyed){held.res.writeHead(200,{'Content-Type':'application/json'});held.res.end(JSON.stringify({id:held.id}));}
      await bResponse;await page.waitForFunction(()=>!window.fixture.state._streaming,{timeout:5000});
      result.cases.newRoundOwnership.normalCompletionClearsBusy=!(await page.evaluate(()=>window.fixture.state._streaming));
      assert.equal(result.cases.newRoundOwnership.normalCompletionClearsBusy,true);assert.deepEqual(errors,[]);await context.close();
    }
    // Existing verified search synthesis still posts and deletes its own temp session.
    {
      currentCase='normal';createHold='none';
      const {page,context,errors}=await openCase(browser,currentCase);
      await startSearch(page,'normal synth');await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat_stream',{timeout:5000});
      await page.waitForFunction(()=>!window.fixture.state._streaming,{timeout:5000});await new Promise(r=>setTimeout(r,50));
      result.cases.normal={chatPosted:chatBodies.some(x=>x.case==='normal'),cleanup:deletes.includes('normal')};
      assert.equal(result.cases.normal.chatPosted,true);assert.equal(result.cases.normal.cleanup,true);assert.deepEqual(errors,[]);await context.close();
    }
    // A real Compare chat Stop tears down the spinner on the AbortError path.
    {
      currentCase='spinner-stop';createHold='none';heldChat=null;
      const {page,context,errors}=await openCase(browser,currentCase,'chat');
      await startSearch(page,'spinner stop');const until=Date.now()+5000;while(!heldChat&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.ok(heldChat);
      await stop(page);await page.waitForFunction(()=>document.querySelector('#cmp-history-0 .msg-ai .body')?.innerText.includes('Cancelled.'));
      const spinner=await page.evaluate(()=>({destroyed:window.destroyed||0,running:window.spinners?.[0]?.isRunning,interval:window.spinners?.[0]?.intervalId!==null,connected:!!window.spinners?.[0]?.element?.isConnected}));
      result.cases.spinnerStop=spinner;assert.ok(spinner.destroyed>0);assert.equal(spinner.running,false);assert.equal(spinner.interval,false);assert.equal(spinner.connected,false);
      heldChat.destroy();heldChat=null;assert.deepEqual(errors,[]);await context.close();
    }
    for (const [caseName, selector] of [['image-spinner-stop','#cmp-history-0 .msg-ai'],['tool-wave-stop','.agent-thread-node']]) {
      currentCase=caseName;createHold='none';heldChat=null;
      const {page,context,errors}=await openCase(browser,currentCase,'chat');
      await startSearch(page,caseName);
      const until=Date.now()+5000;
      while(!heldChat&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
      assert.ok(heldChat,`${caseName} stream is held after synthetic tool_start`);
      await page.waitForFunction(selector=>document.querySelector(selector),selector,{timeout:5000});
      await page.evaluate(()=>{
        const ai=document.querySelector('#cmp-history-0 .msg-ai');
        window.proofImageSpinner=ai?._imgSpinner||null;
        window.proofToolNode=document.querySelector('.agent-thread-node');
        window.fixture.handleCompareSubmit({preventDefault(){}});
      });
      await page.waitForFunction(()=>document.querySelector('#cmp-history-0 .msg-ai .body')?.innerText.includes('Cancelled.'));
      const cleanup=await page.evaluate(()=>({
        image:window.proofImageSpinner?{running:window.proofImageSpinner.isRunning,interval:window.proofImageSpinner.intervalId!==null,connected:!!window.proofImageSpinner.element?.isConnected}:null,
        wave:window.proofToolNode?{interval:window.proofToolNode._waveInterval,connected:window.proofToolNode.isConnected}:null,
      }));
      result.cases[caseName]={cancelled:true,...cleanup};
      if(caseName==='image-spinner-stop') assert.deepEqual(cleanup.image,{running:false,interval:false,connected:false});
      else assert.deepEqual(cleanup.wave,{interval:null,connected:false});
      assert.deepEqual(errors,[]);heldChat.destroy();heldChat=null;await context.close();
    }
    result.pass=true;result.externalRequests=0;result.sourceCommit='744a4bf434db8c42bc46ff72df2f6d272e65cf7f';
    console.log(JSON.stringify(result));
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
