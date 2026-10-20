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
 import { _runSynthForPane } from '/static/js/compare/stream.js';
 import state from '/static/js/compare/state.js';
 import spinner from '/static/js/spinner.js';
 import {getKnownAuthState, authStatePromise} from '/static/js/authState.js';
 window.ready=Promise.resolve(authStatePromise).then(()=>{window.fixture={compare,handleCompareSubmit,state,getKnownAuthState,runSynth:_runSynthForPane,spinner};});
</script></body>`;
const counts = new Map();
const posts = [];
const sessionCreates = [];
const synthPosts = [];
const sessionDeletes = [];
const httpEvents = [];
let activeCase = '';
let heldSearch = null;
let heldSession = null;
const server = http.createServer(async (req,res)=>{
 const url = new URL(req.url, 'http://fixture');
 if (url.pathname.startsWith('/api/auth/status') || ['/api/session','/api/chat_stream','/api/search'].includes(url.pathname)) httpEvents.push({case:activeCase,method:req.method,path:url.pathname});
 if (url.pathname === '/') { res.writeHead(200, {'Content-Type':'text/html'}); return res.end(html); }
 if (url.pathname === '/api/auth/status') {
   const count = (counts.get(activeCase) || 0) + 1; counts.set(activeCase, count);
   if (['unknown-retry','empty'].includes(activeCase) && count === 1) { res.writeHead(503); return res.end('{}'); }
   res.writeHead(200, {'Content-Type':'application/json'});
   return res.end(JSON.stringify({configured:true,authenticated:true,username:'SyntheticAlice'}));
 }
 if (url.pathname === '/api/chat_stream') {
   if (activeCase.includes('synth')) {
     let raw='';for await (const chunk of req)raw+=chunk.toString('utf8');
     synthPosts.push({case:activeCase,body:raw});
     res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-store'});
     return res.end('data: [DONE]\n\n');
   }
   posts.push(activeCase);
   res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-store'});
   return res.end('data: [DONE]\n\n');
 }
 if (url.pathname === '/api/session' && req.method === 'POST') {
   sessionCreates.push(activeCase);
   if (activeCase === 'late-switch-synth') { heldSession=res; return; }
   res.writeHead(200, {'Content-Type':'application/json'});return res.end(JSON.stringify({id:'synthetic-synth-session'}));
 }
 if (url.pathname === '/api/session/synthetic-synth-session' && req.method === 'DELETE') {
   sessionDeletes.push(activeCase);res.writeHead(204);return res.end();
 }
 if (url.pathname === '/api/search') {
   if (activeCase === 'late-switch') { heldSearch=res; return; }
   res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({context:'synthetic search context'}));
 }
 const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname.replace(/^\/static/, ''))}`);
 if (url.pathname.startsWith('/static/') && file.startsWith(`${staticRoot}${path.sep}`) && fs.existsSync(file)) {
   res.writeHead(200, {'Content-Type':(file.endsWith('.js')||file.endsWith('.mjs'))?'text/javascript':'application/octet-stream','Cache-Control':'no-store'});
   return fs.createReadStream(file).pipe(res);
 }
 res.writeHead(404); res.end();
});
async function openCase(browser, name) {
 activeCase = name;
 const context = await browser.newContext();
 const page = await context.newPage(); page.setDefaultTimeout(10000);
 const origin = `http://127.0.0.1:${server.address().port}`;
 const errors = [];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',request=>assert.ok(request.url().startsWith(origin), 'fixture blocks external requests'));
 await page.addInitScript(()=>localStorage.setItem('odysseus-auth-user','SyntheticAlice'));
 await page.goto(origin);
 await page.waitForFunction(()=>window.fixture,{timeout:10000});
 await page.evaluate(()=>{
   const spinner=window.fixture.spinner;
   const create=spinner.create.bind(spinner);
   spinner.create=(...args)=>{const instance=create(...args);const destroy=instance.destroy?.bind(instance);if(destroy)instance.destroy=(...destroyArgs)=>{window.spinnerDestroyCount=(window.spinnerDestroyCount||0)+1;return destroy(...destroyArgs);};return instance;};
   const {state}=window.fixture;
   state.API_BASE=''; state.isActive=true; state._streaming=false;
   state._selectedModels=[{model:'synthetic-model',name:'Synthetic'}];
   state._paneSessionIds=['synthetic-session']; state._compareMode='agent'; state._parallel=true; state._blindMode=true; state._timeout=1;
   window.fetchFields=[];
   const nativeFetch=window.fetch.bind(window);
   window.fetch=(url,opts={})=>{
     if (String(url).includes('/api/chat_stream') && typeof opts.body?.entries==='function') window.fetchFields=Array.from(opts.body.entries());
     return nativeFetch(url,opts);
   };
 });
 return {page,context,errors};
}
async function submit(page, text='synthetic draft') {
 await page.evaluate(text=>{const input=document.getElementById('message');input.value=text;input.focus();window.fixture.handleCompareSubmit({preventDefault(){}});},text);
}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-gpu']});
 const result={pass:false,cases:{},externalCalls:0};
 try {
  // A real auth-module response initially fails. The preflight must preserve the draft;
  // its background retry may verify later, but only a second explicit submit may send.
  {
   const {page,context,errors}=await openCase(browser,'unknown-retry');
   await submit(page,'unknown draft');
   const first=await page.evaluate(()=>({draft:document.getElementById('message').value,known:window.fixture.getKnownAuthState()}));
   assert.equal(first.draft,'unknown draft');
   assert.equal(posts.includes('unknown-retry'),false);
   await page.waitForFunction(()=>window.fixture.getKnownAuthState()?.verified===true,{timeout:5000});
   await submit(page,'unknown draft');
   await page.waitForFunction(()=>window.fetchFields.length>0,{timeout:5000});
   await page.waitForFunction(()=>!window.fixture.state._streaming,{timeout:5000});
   assert.equal(posts.filter(x=>x==='unknown-retry').length,1);
   assert.equal((await page.locator('#message').inputValue()),'');
   assert.deepEqual(errors,[]);
   result.cases.unknown={firstSubmitPreservedDraft:true,noAutomaticPost:true,explicitRetrySentOnce:true};
   await context.close();
  }
  // An empty submit remains a no-op and does not trigger auth retry work.
  {
   const {page,context,errors}=await openCase(browser,'empty');
   await page.evaluate(()=>window.fixture.handleCompareSubmit({preventDefault(){}}));
   await new Promise(resolve=>setTimeout(resolve,80));
   assert.equal(counts.get('empty'),1,'empty submit must not retry auth');
   assert.equal(posts.includes('empty'),false);assert.deepEqual(errors,[]);
   result.cases.empty={noAuthRetry:true,noPost:true};
   await context.close();
  }
  // Actual canonical auth state detects another identity; Compare must not consume or dispatch.
  {
   const {page,context,errors}=await openCase(browser,'switched');
   const before=await page.evaluate(()=>({verified:window.fixture.getKnownAuthState()?.verified,active:document.activeElement?.id}));
   assert.equal(before.verified,true);
   await page.evaluate(()=>localStorage.setItem('odysseus-auth-user','SyntheticBob'));
   await page.evaluate(()=>window.fixture.getKnownAuthState());
   await submit(page,'switched draft');
   const after=await page.evaluate(()=>({draft:document.getElementById('message').value,active:document.activeElement?.id,switched:window.fixture.getKnownAuthState()?.switched}));
   assert.equal(after.switched,true);assert.equal(after.draft,'switched draft');assert.equal(after.active,'message');
   assert.equal(posts.includes('switched'),false);assert.deepEqual(errors,[]);
   result.cases.switched={draftPreserved:true,focusPreserved:true,noPost:true};
   await context.close();
  }
  // Verified identity retains existing send behavior and mode/tool payload.
  // Hold the real Compare pre-search await to verify a subsequent identity switch
  // is checked again before the actual chat_stream request.
  {
   const {page,context,errors}=await openCase(browser,'late-switch');
   await page.evaluate(()=>{window.fixture.state._compareMode='chat';document.getElementById('web-toggle').checked=true;});
   await submit(page,'late-switch draft');
   const until=Date.now()+5000;
   while (!heldSearch && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,10));
   assert.ok(heldSearch,'Compare pre-search should be held at the synthetic loopback request');
   await page.evaluate(()=>{localStorage.setItem('odysseus-auth-user','SyntheticBob');window.fixture.getKnownAuthState();document.getElementById('message').value='newer draft typed while search waits';});
   heldSearch.writeHead(200, {'Content-Type':'application/json'});heldSearch.end(JSON.stringify({context:'synthetic held context'}));heldSearch=null;
   await page.waitForFunction(()=>!window.fixture.state._streaming,{timeout:5000});
   assert.equal(posts.includes('late-switch'),false,'late identity change must be rechecked before chat_stream POST');
   assert.equal(await page.locator('#message').inputValue(),'newer draft typed while search waits','blocked old request must not overwrite newer composer text');
   assert.match(await page.locator('#cmp-history-0 .msg-ai .body').innerText(),/account changed.*reload/i,'pane displays why the stream was blocked');
   const spinnerDestroyed=await page.evaluate(()=>window.spinnerDestroyCount>0);
   assert.deepEqual(errors,[]);
   result.cases.lateSwitch={noPostAfterIdentityChange:true,newerDraftPreserved:true,blockedFeedbackShown:true,spinnerDestroyedOnError:spinnerDestroyed};
   await context.close();
  }
  // Verified identity retains existing send behavior and mode/tool payload.
  {
   const {page,context,errors}=await openCase(browser,'verified');
   await submit(page,'verified draft');
   await page.waitForFunction(()=>window.fetchFields.length>0,{timeout:5000});
   await page.waitForFunction(()=>!window.fixture.state._streaming,{timeout:5000});
   const fields=await page.evaluate(()=>Object.fromEntries(window.fetchFields));
   assert.equal(fields.message,'verified draft');assert.equal(fields.mode,'agent');assert.equal(fields.allow_bash,'true');
   assert.equal(await page.locator('#message').inputValue(),'');assert.deepEqual(errors,[]);
   result.cases.verified={onePost:true,draftCleared:true,allowBashPreserved:true};
   await context.close();
  }
  // Stop remains available during a stream even after auth state changes.
  {
   const {page,context,errors}=await openCase(browser,'stop');
   await page.evaluate(()=>{window.fixture.state._streaming=true;window.fixture.state._abortControllers=[];localStorage.setItem('odysseus-auth-user','SyntheticBob');window.fixture.getKnownAuthState();document.getElementById('message').value='stop draft';window.fixture.handleCompareSubmit({preventDefault(){}});});
   const stop=await page.evaluate(()=>({streaming:window.fixture.state._streaming,draft:document.getElementById('message').value}));
   assert.equal(stop.streaming,false);assert.equal(stop.draft,'stop draft');assert.equal(posts.includes('stop'),false);assert.deepEqual(errors,[]);
   result.cases.stop={stopStillWorks:true,draftUntouched:true,noPost:true};
   await context.close();
  }
  // Direct actual synthesis entry: an already-switched identity must not create
  // a temporary session or send the synthesis prompt.
  {
   const {page,context,errors}=await openCase(browser,'switched-synth');
   await page.evaluate(()=>{localStorage.setItem('odysseus-auth-user','SyntheticBob');window.fixture.getKnownAuthState();window.synthBody=document.createElement('div');window.synthPromise=window.fixture.runSynth({endpoint:'',model:'synthetic-model'},'synthetic synth prompt',window.synthBody,null,document.getElementById('cmp-history-0'));});
   await page.evaluate(()=>window.synthPromise);
   const feedback=await page.evaluate(()=>window.synthBody.innerText);
   result.cases.switchedSynthesis={noSessionCreate:!sessionCreates.includes('switched-synth'),noChatPost:!synthPosts.some(x=>x.case==='switched-synth'),blockedFeedbackShown:/account changed/i.test(feedback)};
   assert.deepEqual(errors,[]);
   await context.close();
  }
  // The canonical auth state changes while actual session creation is held.
  // Releasing that fake response must not allow the synthesis chat POST.
  {
   const {page,context,errors}=await openCase(browser,'late-switch-synth');
   await page.evaluate(()=>{window.synthBody=document.createElement('div');window.synthPromise=window.fixture.runSynth({endpoint:'',model:'synthetic-model'},'synthetic late synth prompt',window.synthBody,null,document.getElementById('cmp-history-0'));});
   const until=Date.now()+5000;while(!heldSession&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
   assert.ok(heldSession,'synthesis session create must be held by fake loopback');
   await page.evaluate(()=>{localStorage.setItem('odysseus-auth-user','SyntheticBob');window.fixture.getKnownAuthState();});
   heldSession.writeHead(200,{'Content-Type':'application/json'});heldSession.end(JSON.stringify({id:'synthetic-synth-session'}));heldSession=null;
   await page.evaluate(()=>window.synthPromise);
   const feedback=await page.evaluate(()=>window.synthBody.innerText);
   result.cases.lateSwitchSynthesis={sessionCreatedBeforeSwitch:true,noChatPostAfterSwitch:!synthPosts.some(x=>x.case==='late-switch-synth'),blockedFeedbackShown:/account changed/i.test(feedback),noCrossAccountCleanup:!sessionDeletes.includes('late-switch-synth')};
   assert.deepEqual(errors,[]);
   await context.close();
  }
  // Verified synthesis still creates, posts, and performs existing cleanup.
  {
   const {page,context,errors}=await openCase(browser,'verified-synth');
   await page.evaluate(()=>{window.synthBody=document.createElement('div');window.synthPromise=window.fixture.runSynth({endpoint:'',model:'synthetic-model'},'synthetic verified synth prompt',window.synthBody,null,document.getElementById('cmp-history-0'));});
   await page.evaluate(()=>window.synthPromise);
   const posted=synthPosts.find(x=>x.case==='verified-synth');
   result.cases.verifiedSynthesis={sessionCreated:sessionCreates.includes('verified-synth'),chatPosted:!!posted,postedPrompt:posted?JSON.parse(posted.body).message:null,existingCleanup:sessionDeletes.includes('verified-synth'),bodyHtml:await page.evaluate(()=>window.synthBody.innerHTML),events:httpEvents.filter(x=>x.case==='verified-synth')};
   assert.deepEqual(errors,[]);
   await context.close();
  }
  const badSynthCases=[];
  if (!result.cases.switchedSynthesis?.noSessionCreate || !result.cases.switchedSynthesis?.noChatPost || !result.cases.switchedSynthesis?.blockedFeedbackShown) badSynthCases.push('switchedSynthesis');
  if (!result.cases.lateSwitchSynthesis?.sessionCreatedBeforeSwitch || !result.cases.lateSwitchSynthesis?.noChatPostAfterSwitch || !result.cases.lateSwitchSynthesis?.blockedFeedbackShown || !result.cases.lateSwitchSynthesis?.noCrossAccountCleanup) badSynthCases.push('lateSwitchSynthesis');
  if (!result.cases.verifiedSynthesis?.sessionCreated || !result.cases.verifiedSynthesis?.chatPosted || !result.cases.verifiedSynthesis?.existingCleanup || result.cases.verifiedSynthesis?.postedPrompt !== 'synthetic verified synth prompt') badSynthCases.push('verifiedSynthesis');
  if (result.cases.lateSwitch?.spinnerDestroyedOnError !== true) badSynthCases.push('lateSwitch-spinner-cleanup');
  result.pass=badSynthCases.length===0; result.syntheticPosts=posts.length; result.statusRequests=Object.fromEntries(counts);
  console.log(JSON.stringify(result));
  assert.deepEqual(badSynthCases,[],`synthesis auth cases failed: ${badSynthCases.join(', ')}`);
 } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
