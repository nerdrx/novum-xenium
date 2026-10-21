const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const originHost = 'http://127.0.0.1';
const htmlPath = path.join(repo, 'static/index.html');
const sourcePath = path.join(repo, 'static/js/voiceRecorder.js');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
const pageErrors = [], externalRequests = [], apiRequests = [];
const syntheticMedia = `(() => {
  const mode = new URL(location.href).searchParams.get('speechMode');
  const media = { requests: [], recorders: [], tracks: [], recognitions: [] };
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  class SyntheticMediaRecorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.ondataavailable = null; this.onstop = null; media.recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { if (this.state !== 'recording') return; this.state = 'inactive'; this.ondataavailable?.({data:new Blob(['synthetic audio'])}); queueMicrotask(() => this.onstop?.()); }
  }
  class SyntheticSpeechRecognition {
    constructor() { if (mode === 'recognition-constructor') throw new Error('synthetic recognition constructor failure'); media.recognitions.push(this); }
    start() { if (mode === 'recognition-start') throw new Error('synthetic recognition start failure'); this.started = true; }
    stop() { this.stopped = true; }
  }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia() {
    const d = deferred(); media.requests.push(d); return d.promise;
  }}});
  Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: SyntheticMediaRecorder });
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: SyntheticSpeechRecognition });
  window.__mediaFixture = { media, grant(i) { const tracks = Array.from({length:2}, () => ({stopped:false, stop(){this.stopped=true;}})); media.tracks.push(...tracks); media.requests[i].resolve({getTracks:()=>tracks}); } };
})();`;
const server = http.createServer((req,res) => {
  const url = new URL(req.url, originHost);
  if (url.pathname === '/') { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); return fs.createReadStream(htmlPath).pipe(res); }
  if (url.pathname.startsWith('/api/')) {
    apiRequests.push({method:req.method,path:url.pathname});
    const data = url.pathname === '/api/stt/stats' ? {provider:'browser'}
      : url.pathname === '/api/auth/status' ? {authenticated:true,configured:true,username:'fixture-user',is_admin:false,privileges:{}}
      : url.pathname === '/api/auth/features' ? {features:{}}
      : ['/api/sessions','/api/presets/templates','/api/tools'].includes(url.pathname) ? []
      : url.pathname === '/api/models' ? {items:[]}
      : url.pathname === '/api/stt/transcribe' ? {text:'unused fixture endpoint'} : {};
    res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify(data));
  }
  const filename = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!filename.startsWith(repo + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) { res.writeHead(404); return res.end(); }
  const ext=path.extname(filename); const type=ext==='.css'?'text/css':(ext==='.js'||ext==='.mjs')?'text/javascript':'application/octet-stream';
  res.writeHead(200, {'content-type':type}); return fs.createReadStream(filename).pipe(res);
});

(async () => {
  let browser;
  const result = {pass:false, source:{file:'static/js/voiceRecorder.js',sha256:sourceHash}, cases:{}, apiRequestCount:0, externalRequests, pageErrors, scope:'actual app.js click handler and voiceRecorder module; synthetic MediaStream/MediaRecorder/SpeechRecognition, fixture API loopback only'};
  const contexts=[];
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const port=server.address().port; const origin=`${originHost}:${port}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'/opt/google/chrome/chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
    async function open(mode) {
      const context=await browser.newContext(); contexts.push(context); await context.addInitScript(syntheticMedia);
      const page=await context.newPage(); page.on('pageerror',e=>pageErrors.push(e.stack||e.message));
      await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin){externalRequests.push(u.href);return route.abort();}return route.continue();});
      await page.goto(`${origin}/?speechMode=${mode}`,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>window.__odysseusAppStarted===true&&document.querySelector('.send-btn')?.dataset.mode==='mic',{},{timeout:15000});
      return page;
    }
    async function failCase(mode) {
      const page=await open(mode); await page.locator('.send-btn').click();
      await page.waitForFunction(()=>window.__mediaFixture.media.requests.length===1);
      await page.evaluate(()=>window.__mediaFixture.grant(0));
      await page.waitForFunction(()=>window.__mediaFixture.media.recorders[0]?.state==='recording');
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const during=await page.evaluate(()=>({recorder:window.__mediaFixture.media.recorders[0].state,tracks:window.__mediaFixture.media.tracks.map(t=>t.stopped),button:document.querySelector('.send-btn').dataset.mode,toast:document.getElementById('toast').textContent.trim(),recognitionStopped:window.__mediaFixture.media.recognitions[0]?.stopped===true}));
      assert.equal(during.recorder,'recording'); assert.deepEqual(during.tracks,[false,false]); assert.equal(during.button,'recording','SpeechRecognition failure must preserve actual Stop control'); assert.match(during.toast,/Browser transcription unavailable; recording continues/); if(mode==='recognition-start') assert.equal(during.recognitionStopped,true,'partial recognition cleaned up');
      await page.locator('.send-btn').click();
      await page.waitForFunction(()=>window.__mediaFixture.media.recorders[0]?.state==='inactive'&&window.__mediaFixture.media.tracks.every(t=>t.stopped)&&document.querySelectorAll('#attach-strip .thumb').length===1);
      const stopped=await page.evaluate(()=>({recorder:window.__mediaFixture.media.recorders[0].state,tracks:window.__mediaFixture.media.tracks.map(t=>t.stopped),button:document.querySelector('.send-btn').dataset.mode,attachmentCount:document.querySelectorAll('#attach-strip .thumb').length,attachmentLabel:document.querySelector('#attach-strip .thumb')?.textContent.trim()}));
      assert.equal(stopped.recorder,'inactive'); assert.deepEqual(stopped.tracks,[true,true]); assert.equal(stopped.attachmentCount,1);
      return {during,stopped};
    }
    result.cases.recognitionConstructorThrows=await failCase('recognition-constructor');
    result.cases.recognitionStartThrows=await failCase('recognition-start');
    const page=await open('normal'); await page.locator('.send-btn').click();
    await page.waitForFunction(()=>window.__mediaFixture.media.requests.length===1); await page.evaluate(()=>window.__mediaFixture.grant(0));
    await page.waitForFunction(()=>window.__mediaFixture.media.recorders[0]?.state==='recording'&&window.__mediaFixture.media.recognitions[0]?.started);
    await page.evaluate(()=>{const r=window.__mediaFixture.media.recognitions[0];const result={isFinal:true,0:{transcript:'synthetic browser transcript'}};r.onresult({resultIndex:0,results:[result]});});
    await page.locator('.send-btn').click();
    await page.waitForFunction(()=>window.__mediaFixture.media.recorders[0]?.state==='inactive'&&window.__mediaFixture.media.tracks.every(t=>t.stopped)&&document.getElementById('message')?.value==='synthetic browser transcript');
    result.cases.normalBrowserTranscription=await page.evaluate(()=>({recorder:window.__mediaFixture.media.recorders[0].state,tracks:window.__mediaFixture.media.tracks.map(t=>t.stopped),input:document.getElementById('message').value,attachmentCount:document.querySelectorAll('#attach-strip .thumb').length,button:document.querySelector('.send-btn').dataset.mode}));
    assert.deepEqual(result.cases.normalBrowserTranscription.tracks,[true,true]); assert.equal(result.cases.normalBrowserTranscription.attachmentCount,0);
    result.apiRequestCount=apiRequests.length; assert.deepEqual(pageErrors,[]); assert.deepEqual(externalRequests,[]); result.pass=true;
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } catch(e) { process.stderr.write((e.stack||String(e))+'\n'); process.exitCode=1; }
  finally { await Promise.all(contexts.map(c=>c.close().catch(()=>{}))); if(browser) await browser.close().catch(()=>{}); if(server.closeAllConnections) server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)).catch(()=>{}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
