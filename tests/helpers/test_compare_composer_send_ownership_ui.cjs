const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(process.env.SOURCE_ROOT || path.join(__dirname, '../..'));
const sourceHead = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const sourceFiles = ['static/index.html','static/app.js','static/js/voiceRecorder.js','static/js/compare/index.js','static/js/compare/selector.js','static/js/chat.js'];
const hashes = Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex')]));
const externalRequests = [], pageErrors = [], apiRequests = [];
const mediaInit = `(() => {
  const media = {requests:[], recorders:[], tracks:[], speech:{instances:0,starts:0,stops:0,aborts:0,active:false}};
  let grant;
  Object.defineProperty(navigator, 'mediaDevices', {configurable:true,value:{getUserMedia(){media.requests.push({});return new Promise(resolve=>{grant=()=>{const tracks=[{stopped:false,stop(){this.stopped=true;}},{stopped:false,stop(){this.stopped=true;}}];media.tracks.push(...tracks);resolve({getTracks:()=>tracks});};});}}});
  class FakeRecorder { constructor(stream){this.stream=stream;this.state='inactive';media.recorders.push(this);} start(){this.state='recording';} stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['fixture audio'])});queueMicrotask(()=>this.onstop?.());} }
  Object.defineProperty(window,'MediaRecorder',{configurable:true,value:FakeRecorder});
  class FakeSpeechRecognition { constructor(){media.speech.instances++;this.onend=null;} start(){media.speech.starts++;media.speech.active=true;} stop(){media.speech.stops++;media.speech.active=false;this.onend?.();} abort(){media.speech.aborts++;media.speech.active=false;this.onend?.();} }
  Object.defineProperty(window,'SpeechRecognition',{configurable:true,value:FakeSpeechRecognition});
  Object.defineProperty(window,'webkitSpeechRecognition',{configurable:true,value:FakeSpeechRecognition});
  window.__compareMicFixture={media,grant(){if(!grant)throw Error('getUserMedia grant was not pending');grant();}};
})();`;
let server;
server = http.createServer((req,res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return fs.createReadStream(path.join(repo,'static/index.html')).pipe(res);}
  if (url.pathname.startsWith('/api/')) {
    apiRequests.push({method:req.method,path:url.pathname});
    if (url.pathname === '/api/chat_stream') { req.resume(); res.writeHead(503,{'content-type':'application/json'}); return res.end(JSON.stringify({detail:'synthetic no-model fixture'})); }
    let data = {};
    if (url.pathname === '/api/auth/status') data = {authenticated:true,configured:true,username:'fixture-user',is_admin:true,privileges:{}};
    else if (url.pathname === '/api/auth/settings') data = {stt_enabled:true,stt_provider:'browser',stt_model:'base',stt_language:''};
    else if (url.pathname === '/api/stt/stats') data = {provider:'browser',available:true};
    else if (['/api/sessions','/api/presets/templates','/api/tools','/api/model-endpoints'].includes(url.pathname)) data = [];
    else if (url.pathname === '/api/models') data = {items:[{url:'fixture://no-provider-call',models:['fixture-chat'],models_display:['Fixture Chat'],endpoint_id:'fixture-endpoint',endpoint_name:'Synthetic fixture'}]};
    else if (url.pathname === '/api/probe-selected') data = {results:[{status:'ok',model:'fixture-chat',latency_ms:1}]};
    res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(data));
  }
  const filename = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!filename.startsWith(repo + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {res.writeHead(404);return res.end();}
  const ext=path.extname(filename);const type=ext==='.html'?'text/html':ext==='.css'?'text/css':(ext==='.js'||ext==='.mjs')?'text/javascript':'application/octet-stream';
  res.writeHead(200,{'content-type':type});return fs.createReadStream(filename).pipe(res);
});

(async()=>{
  let browser;
  const contexts=[];
  const proof={pass:false,source:{head:sourceHead,sha256:hashes},steps:[],apiRequests,externalRequests,pageErrors,scope:'Actual application Compare entry, composer send-button listener, and voiceRecorder; synthetic browser media; loopback fixture APIs only; no prompt/model comparison or physical microphone.'};
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'/opt/google/chrome/chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.newContext({serviceWorkers:'block'});contexts.push(context);await context.addInitScript(mediaInit);
    const page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.stack||e.message));
    await page.route('**/*',route=>{const target=new URL(route.request().url());if(target.origin!==origin){externalRequests.push(target.href);return route.abort();}return route.continue();});
    await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:15000});
    await page.waitForFunction(()=>window.__odysseusAppStarted===true&&document.querySelector('.send-btn')?.dataset.mode==='mic',{},{timeout:20000});
    proof.steps.push({step:'app-ready',sttProvider:'browser',composerMode:await page.locator('.send-btn').getAttribute('data-mode')});
    await page.locator('#tool-compare-btn').click({timeout:10000});
    await page.locator('#compare-model-overlay').waitFor({state:'visible',timeout:10000});
    await page.locator('#compare-model-overlay .research-start-btn').waitFor({state:'visible',timeout:10000});
    await page.waitForFunction(()=>document.querySelector('#compare-model-overlay .research-start-btn')?.disabled===false,null,{timeout:10000});
    await page.locator('#compare-model-overlay .research-start-btn').click();
    await page.waitForFunction(()=>!document.querySelector('#compare-model-overlay')&&document.querySelector('#chat-container')?.classList.contains('compare-active'),null,{timeout:20000});
    const compareState=await page.evaluate(()=>({active:document.querySelector('#chat-container')?.classList.contains('compare-active'),buttonMode:document.querySelector('.send-btn')?.dataset.mode,buttonTitle:document.querySelector('.send-btn')?.title,composer:document.querySelector('#message')?.value}));
    assert.equal(compareState.active,true);
    assert.equal(compareState.composer,'');
    assert.equal(compareState.buttonMode,'');
    assert.equal(compareState.buttonTitle,'Send to all models');
    proof.steps.push({step:'compare-active-before-click',...compareState});
    await page.evaluate(()=>window._updateSendBtnIcon());
    const refreshed=await page.evaluate(()=>({buttonMode:document.querySelector('.send-btn')?.dataset.mode,buttonTitle:document.querySelector('.send-btn')?.title}));
    assert.equal(refreshed.buttonTitle,'Send to all models','ordinary icon refresh must preserve Compare action');
    assert.equal(refreshed.buttonMode,'');
    await page.locator('.send-btn').click();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const emptyClick=await page.evaluate(()=>({mediaRequests:window.__compareMicFixture.media.requests.length,buttonMode:document.querySelector('.send-btn')?.dataset.mode,buttonTitle:document.querySelector('.send-btn')?.title,compareActive:document.querySelector('#chat-container')?.classList.contains('compare-active')}));
    assert.equal(emptyClick.mediaRequests,0,'empty Compare send must not request microphone');
    assert.equal(await page.evaluate(()=>window.__compareMicFixture.media.speech.instances),0,'empty Compare send must not construct Browser SpeechRecognition');
    assert.equal(emptyClick.buttonTitle,'Send to all models');
    assert.equal(emptyClick.compareActive,true);
    await page.waitForFunction(start=>Date.now()-start>=350,Date.now(),{timeout:1000});
    await page.locator('#message').press('Enter');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>window.__compareMicFixture.media.requests.length),0,'empty Compare Enter must not request microphone');
    assert.equal(await page.evaluate(()=>document.querySelector('#chat-container')?.classList.contains('compare-active')),true);
    await page.waitForFunction(start=>Date.now()-start>=350,Date.now(),{timeout:1000});
    await page.locator('#message').fill('synthetic compare prompt');
    await page.locator('#message').press('Enter');
    await page.locator('.compare-pane .msg-user .body').filter({hasText:'synthetic compare prompt'}).first().waitFor({state:'attached',timeout:10000});
    const typedCompare=await page.evaluate(()=>({panePrompt:document.querySelector('.compare-pane .msg-user .body')?.textContent,mediaRequests:window.__compareMicFixture.media.requests.length,active:document.querySelector('#chat-container')?.classList.contains('compare-active')}));
    assert.equal(typedCompare.panePrompt,'synthetic compare prompt','typed Enter must route through Compare submit');
    assert.equal(typedCompare.mediaRequests,0);
    assert.equal(await page.evaluate(()=>window.__compareMicFixture.media.speech.instances),0,'typed Compare submit must not construct Browser SpeechRecognition');
    assert.ok(apiRequests.some(r=>r.path==='/api/chat_stream'),'Compare submit reaches only synthetic no-model loopback stream endpoint');
    const compareStreamRequests=apiRequests.filter(r=>r.path==='/api/chat_stream').length;
    proof.result={compareState,refreshed,emptyClick,typedCompare,probeRequests:apiRequests.filter(r=>r.path==='/api/probe-selected').length,chatStreamFixtureRequests:compareStreamRequests,transcribeRequests:apiRequests.filter(r=>r.path==='/api/stt/transcribe').length};
    assert.equal(proof.result.transcribeRequests,0);
    assert.equal(proof.result.chatStreamFixtureRequests>0,true);

    // Normal-chat control: mic remains available and Stop remains functional outside Compare.
    const normalContext=await browser.newContext({serviceWorkers:'block'});contexts.push(normalContext);await normalContext.addInitScript(mediaInit);
    const normal=await normalContext.newPage();normal.on('pageerror',e=>pageErrors.push(e.stack||e.message));
    await normal.route('**/*',route=>{const target=new URL(route.request().url());if(target.origin!==origin){externalRequests.push(target.href);return route.abort();}return route.continue();});
    await normal.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:15000});
    await normal.waitForFunction(()=>window.__odysseusAppStarted===true&&document.querySelector('.send-btn')?.dataset.mode==='mic',null,{timeout:20000});
    await normal.locator('.send-btn').click();await normal.waitForFunction(()=>window.__compareMicFixture.media.requests.length===1,null,{timeout:10000});await normal.evaluate(()=>window.__compareMicFixture.grant());await normal.waitForFunction(()=>window.__compareMicFixture.media.recorders[0]?.state==='recording',null,{timeout:10000});
    await normal.locator('.send-btn').click();await normal.waitForFunction(()=>window.__compareMicFixture.media.recorders[0]?.state==='inactive'&&window.__compareMicFixture.media.tracks.length===2&&window.__compareMicFixture.media.tracks.every(t=>t.stopped)&&window.__compareMicFixture.media.speech.stops===1&&!window.__compareMicFixture.media.speech.active&&document.querySelector('.send-btn')?.dataset.mode!=='recording',null,{timeout:10000});
    proof.normalChatControl=await normal.evaluate(()=>({mediaRequests:window.__compareMicFixture.media.requests.length,recorderState:window.__compareMicFixture.media.recorders[0]?.state,tracksStopped:window.__compareMicFixture.media.tracks.every(t=>t.stopped),speech:window.__compareMicFixture.media.speech,buttonMode:document.querySelector('.send-btn')?.dataset.mode,buttonTitle:document.querySelector('.send-btn')?.title}));
    assert.equal(proof.normalChatControl.mediaRequests,1);assert.equal(proof.normalChatControl.recorderState,'inactive');assert.equal(proof.normalChatControl.tracksStopped,true);assert.equal(proof.normalChatControl.speech.starts,1);assert.equal(proof.normalChatControl.speech.stops,1);assert.equal(proof.normalChatControl.speech.active,false);
    assert.deepEqual(externalRequests,[]);
    const unexpectedPageErrors=pageErrors.filter(error=>!error.includes("SecurityError: Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed"));
    proof.knownHarnessPageErrors=pageErrors.length-unexpectedPageErrors.length;
    proof.unexpectedPageErrors=unexpectedPageErrors;
    assert.deepEqual(unexpectedPageErrors,[]);
    proof.pass=true;
    process.stdout.write(JSON.stringify(proof,null,2)+'\n');
  } catch(error) {
    process.stderr.write(JSON.stringify({pass:false,proof,error:error.stack||String(error)},null,2)+'\n');
    process.exitCode=1;
  } finally {
    await Promise.all(contexts.map(c=>c.close().catch(()=>{})));
    if(browser)await browser.close().catch(()=>{});
    if(server?.closeAllConnections)server.closeAllConnections();
    if(server?.listening)await new Promise(resolve=>server.close(resolve)).catch(()=>{});
  }
})().catch(error=>{process.stderr.write((error.stack||String(error))+'\n');process.exitCode=1;});
