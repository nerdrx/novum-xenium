const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(process.env.SOURCE_ROOT || path.resolve(__dirname, '../..'));
const gitHead=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const files = ['static/index.html','static/app.js','static/js/voiceRecorder.js','static/js/compare/index.js','static/js/compare/selector.js','static/js/chat.js'];
const hashes = Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex')]));
const externalRequests = [], pageErrors = [], apiRequests = [];
const mediaInit = `(() => {
  const media = {requests:[], recorders:[], tracks:[], recognitions:[]};
  let grant;
  Object.defineProperty(navigator, 'mediaDevices', {configurable:true,value:{getUserMedia(){media.requests.push({});return new Promise(resolve=>{grant=()=>{const tracks=[{stopped:false,stop(){this.stopped=true;}},{stopped:false,stop(){this.stopped=true;}}];media.tracks.push(...tracks);resolve({getTracks:()=>tracks});};});}}});
  class FakeRecorder { constructor(stream){this.stream=stream;this.state='inactive';media.recorders.push(this);} start(){this.state='recording';} stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['fixture audio'])});queueMicrotask(()=>this.onstop?.());} }
  class FakeRecognition {
    constructor(){this.stopped=false;this.aborted=false;media.recognitions.push(this);}
    start(){this.started=true;}
    stop(){this.stopped=true;queueMicrotask(()=>{this.ended=true;this.onend?.();});}
    abort(){this.aborted=true;this.ended=true;this.onend?.();}
    emit(text){const item={isFinal:true,0:{transcript:text}};this.onresult?.({resultIndex:0,results:[item]});}
  }
  Object.defineProperty(window,'MediaRecorder',{configurable:true,value:FakeRecorder});
  Object.defineProperty(window,'SpeechRecognition',{configurable:true,value:FakeRecognition});
  Object.defineProperty(window,'webkitSpeechRecognition',{configurable:true,value:FakeRecognition});
  window.__compareMicFixture={media,grant(){if(!grant)throw Error('getUserMedia grant was not pending');grant();}};
})();`;
const server = http.createServer((req,res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return fs.createReadStream(path.join(repo,'static/index.html')).pipe(res);}
  if (url.pathname.startsWith('/api/')) {
    apiRequests.push({method:req.method,path:url.pathname});
    let data = {};
    if (url.pathname === '/api/auth/status') data = {authenticated:true,configured:true,username:'fixture-user',is_admin:true,privileges:{}};
    else if (url.pathname === '/api/auth/settings') data = {stt_enabled:true,stt_provider:'browser',stt_model:'base',stt_language:''};
    else if (url.pathname === '/api/stt/stats') data = {provider:'browser',available:true};
    else if (['/api/sessions','/api/presets/templates','/api/tools','/api/model-endpoints'].includes(url.pathname)) data = [];
    else if (url.pathname === '/api/models') data = {items:[{url:'fixture://no-provider-call',models:['fixture-chat'],models_display:['Fixture Chat'],endpoint_id:'fixture-endpoint',endpoint_name:'Synthetic fixture'}]};
    else if (url.pathname === '/api/probe-selected') data = {results:[{status:'ok',model:'fixture-chat',latency_ms:1}]};
    res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(data));
  }
  const filename=path.resolve(repo,`.${decodeURIComponent(url.pathname)}`);
  if(!filename.startsWith(repo+path.sep)||!fs.existsSync(filename)||!fs.statSync(filename).isFile()){res.writeHead(404);return res.end();}
  const ext=path.extname(filename), type=ext==='.html'?'text/html':ext==='.css'?'text/css':(ext==='.js'||ext==='.mjs')?'text/javascript':'application/octet-stream';
  res.writeHead(200,{'content-type':type});return fs.createReadStream(filename).pipe(res);
});

(async()=>{
  let browser;
  const contexts=[];
  const proof={pass:false,source:{head:gitHead,sha256:hashes},cases:[],apiRequests,externalRequests,pageErrors,scope:'Actual app Compare transition and send-button/voiceRecorder; fake getUserMedia, MediaRecorder and both speech-recognition constructors; loopback fixture APIs only; no physical mic or compare prompt submission.'};
  const launchPage=async(origin)=>{
    const context=await browser.newContext({serviceWorkers:'block'});contexts.push(context);await context.addInitScript(mediaInit);
    const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.stack||error.message));
    await page.route('**/*',route=>{const target=new URL(route.request().url());if(target.origin!==origin){externalRequests.push(target.href);return route.abort();}return route.continue();});
    await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:15000});
    await page.waitForFunction(()=>window.__odysseusAppStarted===true&&document.querySelector('.send-btn')?.dataset.mode==='mic',null,{timeout:20000});
    return page;
  };
  const enterCompare=async page=>{
    await page.locator('#tool-compare-btn').click({timeout:10000});
    await page.locator('#compare-model-overlay').waitFor({state:'visible',timeout:10000});
    await page.waitForFunction(()=>{const button=document.querySelector('#compare-model-overlay .research-start-btn');return button&&button.disabled===false;},null,{timeout:10000});
    await page.locator('#compare-model-overlay .research-start-btn').click();
    await page.waitForFunction(()=>!document.querySelector('#compare-model-overlay')&&document.querySelector('#chat-container')?.classList.contains('compare-active'),null,{timeout:20000});
  };
  const snapshot=page=>page.evaluate(()=>({compareActive:document.querySelector('#chat-container')?.classList.contains('compare-active'),buttonMode:document.querySelector('.send-btn')?.dataset.mode,buttonTitle:document.querySelector('.send-btn')?.title,buttonAriaLabel:document.querySelector('.send-btn')?.getAttribute('aria-label'),recorderState:window.__compareMicFixture.media.recorders.at(-1)?.state??null,recognitions:window.__compareMicFixture.media.recognitions.map(item=>({started:!!item.started,stopped:!!item.stopped,ended:!!item.ended})),permissionRequests:window.__compareMicFixture.media.requests.length,tracks:window.__compareMicFixture.media.tracks.map(track=>({stopped:track.stopped}))}));
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'/opt/google/chrome/chrome',args:['--no-sandbox','--disable-dev-shm-usage']});

    // Ordinary Compare entry must stay idle.
    const idlePage=await launchPage(origin);
    const idleBeforeCompare=await snapshot(idlePage);
    await enterCompare(idlePage);
    const idleAfterCompare=await snapshot(idlePage);
    proof.cases.push({name:'idle-compare-entry',beforeCompare:idleBeforeCompare,afterCompare:idleAfterCompare});
    assert.equal(idleAfterCompare.compareActive,true);
    assert.equal(idleAfterCompare.permissionRequests,0);
    assert.equal(idleAfterCompare.recorderState,null);
    await idlePage.close();

    // Permission request starts in chat; Compare is entered before permission is granted.
    const pendingPage=await launchPage(origin);
    await pendingPage.locator('.send-btn').click();
    await pendingPage.waitForFunction(()=>window.__compareMicFixture.media.requests.length===1,null,{timeout:10000});
    const pendingBeforeCompare=await snapshot(pendingPage);
    await enterCompare(pendingPage);
    const pendingAfterCompare=await snapshot(pendingPage);
    await pendingPage.evaluate(()=>window.__compareMicFixture.grant());
    await pendingPage.waitForFunction(()=>window.__compareMicFixture.media.tracks.length===2,null,{timeout:10000});
    const pendingAfterGrant=await snapshot(pendingPage);
    proof.cases.push({name:'permission-pending-then-compare',beforeCompare:pendingBeforeCompare,afterCompareBeforeGrant:pendingAfterCompare,afterGrant:pendingAfterGrant});
    assert.equal(pendingAfterGrant.recorderState,null,'a permission grant invalidated by Compare must not create a recorder');
    assert.deepEqual(pendingAfterGrant.tracks,[{stopped:true},{stopped:true}]);
    assert.deepEqual(pendingAfterGrant.recognitions,[],'stale permission grant must not start browser recognition');
    await pendingPage.close();

    // Recording already active; entering Compare must not hide an active recorder under Send.
    const activePage=await launchPage(origin);
    await activePage.locator('#sidebar-new-chat-btn').click();
    await activePage.waitForFunction(()=>!!window.sessionModule.getPendingDraftId(),null,{timeout:10000});
    await activePage.locator('.send-btn').click();
    await activePage.waitForFunction(()=>window.__compareMicFixture.media.requests.length===1,null,{timeout:10000});
    await activePage.evaluate(()=>window.__compareMicFixture.grant());
    await activePage.waitForFunction(()=>window.__compareMicFixture.media.recorders[0]?.state==='recording',null,{timeout:10000});
    await activePage.waitForFunction(()=>window.__compareMicFixture.media.recognitions[0]?.started===true,null,{timeout:10000});
    const chatOrigin=await activePage.evaluate(()=>{
      const session=window.sessionModule;
      const destination=session.captureVoiceDestination(session.captureVoiceIdentity());
      window.__compareMicFixture.media.recognitions[0].emit('kept in original chat');
      return {id:destination.pendingDraftId,options:destination.draftOptions};
    });
    const activeBeforeCompare=await snapshot(activePage);
    await enterCompare(activePage);
    await activePage.waitForFunction(async ({id,options})=>{
      const drafts=await import('/static/js/composerDrafts.js');
      return drafts.getComposerDraft(id,options).includes('kept in original chat');
    },chatOrigin,{timeout:15000});
    const activeAfterCompare=await snapshot(activePage);
    const draftDestination=await activePage.evaluate(async ({id,options})=>{
      const drafts=await import('/static/js/composerDrafts.js');
      return {id,text:drafts.getComposerDraft(id,options),currentId:window.sessionModule.getPendingDraftId(),input:document.querySelector('#message')?.value};
    },chatOrigin);
    proof.cases.push({name:'recording-active-then-compare',beforeCompare:activeBeforeCompare,afterCompare:activeAfterCompare,destination:draftDestination});
    await activePage.close();

    const unexpectedPageErrors=pageErrors.filter(error=>!error.includes("SecurityError: Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed"));
    proof.unexpectedPageErrors=unexpectedPageErrors;
    proof.knownHarnessPageErrors=pageErrors.length-unexpectedPageErrors.length;
    assert.deepEqual(externalRequests,[]);
    assert.deepEqual(unexpectedPageErrors,[]);
    assert.equal(proof.cases[1].afterGrant.recorderState,null);
    assert.deepEqual(proof.cases[1].afterGrant.tracks,[{stopped:true},{stopped:true}]);
    assert.equal(proof.cases[1].afterGrant.compareActive,true);
    assert.equal(proof.cases[2].afterCompare.recorderState,'inactive');
    assert.equal(proof.cases[2].afterCompare.compareActive,true);
    assert.deepEqual(proof.cases[2].afterCompare.tracks,[{stopped:true},{stopped:true}]);
    assert.equal(proof.cases[2].afterCompare.recognitions[0].stopped,true);
    assert.equal(proof.cases[2].afterCompare.recognitions[0].ended,true);
    assert.equal(draftDestination.id,chatOrigin.id);
    assert.notEqual(draftDestination.currentId,chatOrigin.id);
    assert.equal(draftDestination.input,'');
    proof.pass=true;
    process.stdout.write(JSON.stringify(proof,null,2)+'\n');
  } catch(error) {
    process.stderr.write(JSON.stringify({pass:false,proof,error:error.stack||String(error)},null,2)+'\n');process.exitCode=1;
  } finally {
    await Promise.all(contexts.map(context=>context.close().catch(()=>{})));
    if(browser)await browser.close().catch(()=>{});
    if(server.closeAllConnections)server.closeAllConnections();
    if(server.listening)await new Promise(resolve=>server.close(resolve)).catch(()=>{});
  }
})().catch(error=>{process.stderr.write((error.stack||String(error))+'\n');process.exitCode=1;});
