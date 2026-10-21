const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const origin = 'http://127.0.0.1';
const apiRequests = [], externalRequests = [], pageErrors = [], heldStt = [], heldWaiters = [];
const mediaScript = `(() => {
 const media={requests:[],recorders:[],tracks:[],stops:[],holdStop:false};
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia(){let resolve;const promise=new Promise(r=>resolve=r);media.requests.push({resolve});return promise;}}});
 class Recorder{constructor(stream){this.stream=stream;this.state='inactive';media.recorders.push(this);}start(){this.state='recording';}stop(){if(this.state!=='recording')return;this.state='inactive';const deliver=()=>{this.ondataavailable?.({data:new Blob(['synthetic audio'])});this.onstop?.();};media.stops.push(deliver);if(!media.holdStop)setTimeout(deliver,0);}naturalStop(){if(this.state!=='recording')return;this.state='inactive';setTimeout(()=>{this.ondataavailable?.({data:new Blob(['synthetic audio'])});this.onstop?.();},0);}}
 Object.defineProperty(window,'MediaRecorder',{configurable:true,value:Recorder});
 window.__mediaFixture={media,grant(i){const track={stopped:false,stop(){this.stopped=true;}};const stream={getTracks:()=>[track]};media.tracks.push(track);media.requests[i].resolve(stream);},holdStops(value){media.holdStop=!!value;},deliverStop(i){media.stops[i]?.();},naturalStop(i){media.recorders[i]?.naturalStop();}};
})();`;
const htmlPath=path.join(repo,'static/index.html');
assert.ok(fs.existsSync(htmlPath),'canonical app entry must exist');
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,origin);
 if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return fs.createReadStream(htmlPath).pipe(res);}
 if(url.pathname.startsWith('/api/')){
  let size=0;req.on('data',chunk=>size+=chunk.length);req.on('end',()=>{
   apiRequests.push({method:req.method,path:url.pathname,bodyBytes:size});
   if(url.pathname==='/api/stt/transcribe'){
    heldStt.push({res,bodyBytes:size});
    for(let i=heldWaiters.length-1;i>=0;i--)if(heldStt.length>heldWaiters[i].index){heldWaiters.splice(i,1)[0].resolve(heldStt[heldStt.length-1]);}
    return;
   }
   const data=url.pathname==='/api/stt/stats'?{provider:'local'}:
    url.pathname==='/api/auth/status'?{authenticated:true,configured:true,username:'fixture-user',is_admin:false,privileges:{}}:
    url.pathname==='/api/auth/features'?{features:{}}:
    ['/api/sessions','/api/presets/templates'].includes(url.pathname)?[]:
    url.pathname==='/api/models'?{items:[]}:{ };
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));
  });return;
 }
 const filename=path.resolve(repo,`.${decodeURIComponent(url.pathname)}`);
 if(!filename.startsWith(repo+path.sep)||!fs.existsSync(filename)||!fs.statSync(filename).isFile()){res.writeHead(404);return res.end();}
 const ext=path.extname(filename),type=ext==='.html'?'text/html':ext==='.css'?'text/css':(ext==='.js'||ext==='.mjs')?'text/javascript':'application/octet-stream';
 res.writeHead(200,{'content-type':type});fs.createReadStream(filename).pipe(res);
});
function waitForHeld(index){if(heldStt.length>index)return Promise.resolve(heldStt[index]);return new Promise(resolve=>heldWaiters.push({index,resolve}));}
function release(item,text){if(item&&!item.res.writableEnded){item.res.writeHead(200,{'content-type':'application/json'});item.res.end(JSON.stringify({text}));}}
(async()=>{
 let browser;const contexts=[];
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const allowed=`${origin}:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'/opt/google/chrome/chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
  async function openPage(){
   const context=await browser.newContext();contexts.push(context);await context.addInitScript(mediaScript);
   const page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));
   await page.route('**/*',route=>{const target=new URL(route.request().url());if(target.origin!==allowed){externalRequests.push(target.href);return route.abort();}return route.continue();});
   await page.goto(`${allowed}/`,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.__odysseusAppStarted===true&&document.querySelector('.send-btn')?.dataset.mode==='mic',null,{timeout:15000});
   return {context,page};
  }
  async function state(page){return page.evaluate(async()=>{const voice=await import('/static/js/voiceRecorder.js');return{button:document.querySelector('.send-btn')?.dataset.mode,isRecording:voice.getIsRecording(),recorderStates:window.__mediaFixture.media.recorders.map(r=>r.state),trackStopped:window.__mediaFixture.media.tracks.map(t=>t.stopped),requestCount:window.__mediaFixture.media.requests.length,input:document.getElementById('message')?.value};});}
  async function start(page,index){
   await page.locator('.send-btn').click();await page.waitForFunction(i=>window.__mediaFixture.media.requests.length===i+1,index);
   await page.evaluate(i=>window.__mediaFixture.grant(i),index);
   await page.waitForFunction(i=>window.__mediaFixture.media.recorders[i]?.state==='recording',index);
  }
  async function stopAndHold(page,recorderIndex,heldIndex){
   await page.locator('.send-btn').click();const response=await waitForHeld(heldIndex);
   await page.waitForFunction(i=>window.__mediaFixture.media.recorders[i]?.state==='inactive',recorderIndex);
   assert.ok(response.bodyBytes>0);return response;
  }
  async function settle(page,text){
   await page.waitForFunction(value=>document.getElementById('message')?.value===value,text,{timeout:10000});
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  }

  const active=await openPage();
  await start(active.page,0);const heldA=await stopAndHold(active.page,0,0);
  const activeAfterSecondStop=await state(active.page);
  await active.page.locator('.send-btn').click();
  await active.page.waitForFunction(()=>document.querySelector('.send-btn')?.dataset.mode==='mic');
  await start(active.page,1);
  const activeBeforeRelease=await state(active.page);
  assert.equal(activeBeforeRelease.button,'recording');assert.equal(activeBeforeRelease.isRecording,true);
  release(heldA,'transcript A active control');
  await settle(active.page,'transcript A active control');
  const activeAfterRelease=await state(active.page);
  assert.equal(activeAfterRelease.recorderStates[1],'recording');assert.equal(activeAfterRelease.trackStopped[1],false);
  assert.equal(activeAfterRelease.isRecording,true);assert.equal(activeAfterRelease.button,'recording');
  assert.equal(activeAfterRelease.input,'transcript A active control','A output is preserved through newer B recording');
  await active.context.close();

  const pending=await openPage();
  await start(pending.page,0);const heldPendingA=await stopAndHold(pending.page,0,1);
  await pending.page.locator('.send-btn').click();
  await pending.page.waitForFunction(()=>document.querySelector('.send-btn')?.dataset.mode==='mic');
  await pending.page.locator('.send-btn').click();
  await pending.page.waitForFunction(()=>window.__mediaFixture.media.requests.length===2);
  const pendingBeforeRelease=await state(pending.page);
  assert.equal(pendingBeforeRelease.button,'recording');assert.equal(pendingBeforeRelease.requestCount,2);
  release(heldPendingA,'transcript A pending control');
  await settle(pending.page,'transcript A pending control');
  const pendingAfterRelease=await state(pending.page);
  assert.equal(pendingAfterRelease.button,'recording','A cleanup must not clear the pending B Stop control');
  assert.equal(pendingAfterRelease.requestCount,2);
  assert.equal(pendingAfterRelease.input,'transcript A pending control','A output is preserved while B permission is pending');
  await pending.page.evaluate(()=>window.__mediaFixture.grant(1));
  await pending.page.waitForFunction(()=>window.__mediaFixture.media.recorders[1]?.state==='recording');
  const pendingAfterGrant=await state(pending.page);
  assert.equal(pendingAfterGrant.button,'recording');assert.equal(pendingAfterGrant.isRecording,true);
  await pending.context.close();

  const delayed=await openPage();
  await delayed.page.evaluate(()=>window.__mediaFixture.holdStops(true));
  await start(delayed.page,0);
  await delayed.page.locator('.send-btn').click();
  await delayed.page.waitForFunction(()=>window.__mediaFixture.media.recorders[0]?.state==='inactive'&&window.__mediaFixture.media.stops.length===1);
  const delayedAfterStop=await state(delayed.page);
  await delayed.page.locator('.send-btn').click();
  await delayed.page.waitForFunction(()=>document.querySelector('.send-btn')?.dataset.mode==='mic');
  await delayed.page.locator('.send-btn').click();
  await delayed.page.waitForFunction(()=>window.__mediaFixture.media.requests.length===2&&document.querySelector('.send-btn')?.dataset.mode==='recording');
  const delayedPendingB=await state(delayed.page);
  await delayed.page.evaluate(()=>window.__mediaFixture.deliverStop(0));
  const heldDelayedA=await waitForHeld(2);
  assert.ok(heldDelayedA.bodyBytes>0);
  await delayed.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const delayedOnstopBeforeBody=await state(delayed.page);
  release(heldDelayedA,'transcript A delayed onstop');
  await settle(delayed.page,'transcript A delayed onstop');
  const delayedAfterA=await state(delayed.page);
  assert.equal(delayedAfterA.button,'recording','stop-time intent must preserve B pending Stop UI even when native onstop is delivered late');
  assert.equal(delayedAfterA.requestCount,2);
  await delayed.page.evaluate(()=>window.__mediaFixture.grant(1));
  await delayed.page.waitForFunction(()=>window.__mediaFixture.media.recorders[1]?.state==='recording');
  const delayedAfterBGrant=await state(delayed.page);
  assert.equal(delayedAfterBGrant.button,'recording');
  assert.equal(delayedAfterBGrant.isRecording,true);
  await delayed.context.close();

  const normal=await openPage();
  await start(normal.page,0);const heldNormal=await stopAndHold(normal.page,0,3);
  release(heldNormal,'normal completion');await settle(normal.page,'normal completion');
  await normal.page.waitForFunction(()=>document.querySelector('.send-btn')?.dataset.mode!=='recording');
  const normalAfter=await state(normal.page);
  assert.equal(normalAfter.isRecording,false);assert.equal(normalAfter.recorderStates[0],'inactive');assert.equal(normalAfter.trackStopped[0],true);
  const natural=await openPage();
  await start(natural.page,0);
  await natural.page.evaluate(()=>window.__mediaFixture.naturalStop(0));
  const heldNatural=await waitForHeld(4);assert.ok(heldNatural.bodyBytes>0);
  release(heldNatural,'natural stop transcript');await settle(natural.page,'natural stop transcript');
  await natural.page.waitForFunction(()=>document.querySelector('.send-btn')?.dataset.mode!=='recording');
  const naturalAfter=await state(natural.page);
  assert.equal(naturalAfter.isRecording,false);assert.equal(naturalAfter.recorderStates[0],'inactive');assert.equal(naturalAfter.trackStopped[0],true);
  assert.deepEqual(externalRequests,[]);assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({pass:true,source:{head:'fb70158b6645d2b14035d738d3b5d3938eb410a3',voiceRecorderJs:crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'static/js/voiceRecorder.js'))).digest('hex')},cases:{activeNewRecorder:{afterSecondStop:activeAfterSecondStop,beforeRelease:activeBeforeRelease,afterRelease:activeAfterRelease},pendingNewPermission:{beforeRelease:pendingBeforeRelease,afterRelease:pendingAfterRelease,afterGrant:pendingAfterGrant},delayedOnstopNewPermission:{afterStop:delayedAfterStop,pendingB:delayedPendingB,onstopDeliveredBeforeBody:delayedOnstopBeforeBody,afterACompletion:delayedAfterA,afterBGrant:delayedAfterBGrant},normalCompletion:normalAfter,naturalStop:naturalAfter},apiRequests:apiRequests.length,apiPaths:[...new Set(apiRequests.map(r=>r.path))].sort(),heldStt:heldStt.map(x=>({bodyBytes:x.bodyBytes,released:x.res.writableEnded})),externalRequests,pageErrors,scope:'Actual full app/session/voiceRecorder; synthetic MediaStream/MediaRecorder and loopback-only API; no physical microphone, external STT, or upload'},null,2)+'\n');
 }finally{
  for(const item of heldStt)release(item,'cleanup');
  await Promise.all(contexts.map(c=>c.close().catch(()=>{})));if(browser)await browser.close().catch(()=>{});server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
