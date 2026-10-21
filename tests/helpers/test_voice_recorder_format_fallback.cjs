const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = process.cwd();
const sourcePath = path.join(repo, 'static/js/voiceRecorder.js');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
const uploadBodies = [];
const html = `<!doctype html><button id="start">Start</button><textarea id="message"></textarea><script>
window.__fixture = {mode: new URL(location.href).searchParams.get('mode'), tracks: [], files: [], errors: [], toasts: []};
const NativeRecorder = window.MediaRecorder;
window.MediaRecorder = new Proxy(NativeRecorder, {construct(target, args) {
  const fixture = window.__fixture;
  if (args[1]?.mimeType === 'audio/webm' && fixture.mode !== 'normal-webm') {
    throw new DOMException('fixture rejects explicit WebM', 'NotSupportedError');
  }
  if (!args[1] && fixture.mode === 'failed-retry') {
    throw new DOMException('fixture rejects the UA default', 'NotSupportedError');
  }
  // In the alternate-format case, emulate a UA whose no-options default is its
  // natively supported MP4 recorder; the constructed recorder remains native.
  if (!args[1] && fixture.mode === 'alternate-default') args[1] = {mimeType: 'audio/mp4'};
  const recorder=Reflect.construct(target, args);
  if (fixture.mode === 'alternate-default' && !args[1]?.__explicitWebM) {
    const chosenMime=recorder.mimeType; let started=false;
    Object.defineProperty(recorder,'mimeType',{configurable:true,get:()=>started?chosenMime:''});
    const nativeStart=recorder.start.bind(recorder);
    recorder.start=(...values)=>{const result=nativeStart(...values);started=true;return result;};
  }
  return recorder;
}});
Object.defineProperty(navigator, 'mediaDevices', {configurable:true, value:{getUserMedia:async()=>{
  const audio = new AudioContext(); window.__audio=audio; await audio.resume();
  const oscillator = audio.createOscillator();
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(destination); oscillator.start();
  const stream = destination.stream;
  const track = stream.getAudioTracks()[0];
  const nativeStop = track.stop.bind(track); track.stopCount = 0;
  track.stop = () => { track.stopCount++; nativeStop(); oscillator.stop(); audio.close(); };
  window.__fixture.tracks.push(track);
  return stream;
}}});
</script><script type="module">
import('/static/js/voiceRecorder.js').then(m=>{
 window.voice=m.default; window.voice._sttProvider=new URL(location.href).searchParams.get('provider')||'disabled';
 document.getElementById('start').onclick=()=>window.voice.startRecording(file=>window.__fixture.files.push(file), x=>window.__fixture.toasts.push(x), x=>window.__fixture.errors.push(x));
 window.__ready=true;
}).catch(e=>{window.__moduleError=e.stack||String(e);window.__ready=true});
</script>`;

const server = http.createServer((req, res) => {
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  if (req.url.startsWith('/')) {
    if (pathname === '/') { res.writeHead(200, {'content-type':'text/html'}); return res.end(html); }
    if (req.url === '/static/js/voiceRecorder.js') { res.writeHead(200, {'content-type':'text/javascript'}); return fs.createReadStream(sourcePath).pipe(res); }
    if (req.url === '/api/stt/transcribe') {
      const chunks=[]; req.on('data', chunk=>chunks.push(chunk)); req.on('end',()=>{
        const body=Buffer.concat(chunks); uploadBodies.push({contentType:req.headers['content-type'],body:body.toString('latin1')});
        res.writeHead(200, {'content-type':'application/json'}); res.end('{"text":"synthetic transcript"}');
      }); return;
    }
  }
  res.writeHead(404); res.end();
});

(async()=>{
  let browser;
  const result={pass:false,source:{file:'static/js/voiceRecorder.js',sha256:sourceHash},cases:{},uploads:[],externalRequests:[],pageErrors:[],scope:'actual voiceRecorder module in headless Chrome; synthetic oscillator capture; loopback-only STT fixture; no physical microphone, external network, or inference. Proxy forces explicit WebM rejection and maps the no-options retry to native MP4 for deterministic alternate-format coverage; this does not claim Chrome normally rejects WebM or defaults to MP4.'};
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
    async function run(mode, provider='disabled') {
      const context=await browser.newContext(); const page=await context.newPage();
      page.on('pageerror',e=>result.pageErrors.push(e.stack||e.message));
      page.on('request',r=>{if(new URL(r.url()).origin!==origin)result.externalRequests.push(r.url())});
      await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
      await page.goto(`${origin}/?mode=${mode}&provider=${provider}`); await page.waitForFunction(()=>window.__ready===true);
      assert.equal(await page.evaluate(()=>window.__moduleError||null),null);
      await page.locator('#start').click();
      const recording=await page.waitForFunction(()=>window.voice?.getIsRecording()||window.__fixture.errors.length>0);
      const failed=await page.evaluate(()=>!window.voice.getIsRecording());
      if(failed){const state=await page.evaluate(()=>({stopped:window.__fixture.tracks.map(t=>t.stopCount),errors:[...window.__fixture.errors]})); await context.close(); return {page:null,...state};}
      await page.waitForTimeout(500);
      await page.evaluate(()=>window.voice.stopRecording());
      await page.waitForFunction(()=>!window.voice.getIsRecording() && (window.__fixture.files.length>0 || window.__fixture.toasts.includes('Transcribed') || window.__fixture.errors.length>0));
      const state=await page.evaluate(async()=>({
        tracks:window.__fixture.tracks.map(t=>({stopCount:t.stopCount,readyState:t.readyState})),
        errors:[...window.__fixture.errors],toasts:[...window.__fixture.toasts],
        files:await Promise.all(window.__fixture.files.map(async f=>({name:f.name,type:f.type,size:f.size,bytes:Array.from(new Uint8Array(await f.arrayBuffer()))}))),
        isRecording:window.voice.getIsRecording()
      }));
      await context.close(); return {page,state};
    }

    let c=await run('alternate-default');
    assert.ok(c.state, 'WebM rejection must retry the supported native recorder');
    assert.equal(c.state.errors.length,0); assert.equal(c.state.files.length,1);
    const alt=c.state.files[0]; assert.equal(alt.name.split('.').at(-1),'m4a'); assert.equal(alt.type,'audio/mp4'); assert.ok(alt.size>0,JSON.stringify(c.state)); assert.equal(c.state.tracks[0].stopCount,1);
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),'novum-pass169-'));
    try {
      const media=path.join(temp,'voice.m4a'); fs.writeFileSync(media,Buffer.from(alt.bytes));
      const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=format_name','-of','default=noprint_wrappers=1:nokey=1',media],{encoding:'utf8'});
      assert.equal(probe.status,0,probe.stderr); assert.match(probe.stdout,/mov,mp4|mp4/);
      result.cases.webmNotSupportedUsesNativeAlternate={mimeType:alt.type,filename:alt.name,bytes:alt.size,container:probe.stdout.trim(),trackStopCount:c.state.tracks[0].stopCount,nativeMp4DefaultShim:true};
    } finally { fs.rmSync(temp,{recursive:true,force:true}); }

    c=await run('normal-webm','local');
    assert.equal(c.state.errors.length,0); assert.equal(c.state.tracks[0].stopCount,1);
    assert.equal(uploadBodies.length,1); assert.match(uploadBodies[0].body,/filename="audio\.webm"/); assert.match(uploadBodies[0].body,/Content-Type: audio\/webm/i);
    result.uploads.push({filename:'audio.webm',mimeType:'audio/webm'});
    result.cases.normalWebmSttUpload={filename:'audio.webm',mimeType:'audio/webm',trackStopCount:c.state.tracks[0].stopCount};

    c=await run('alternate-default','local');
    assert.equal(c.state.errors.length,0); assert.equal(c.state.tracks[0].stopCount,1);
    assert.equal(uploadBodies.length,2); assert.match(uploadBodies[1].body,/filename="audio\.m4a"/); assert.match(uploadBodies[1].body,/Content-Type: audio\/mp4/i);
    result.uploads.push({filename:'audio.m4a',mimeType:'audio/mp4'});
    result.cases.nativeAlternateSttUpload={filename:'audio.m4a',mimeType:'audio/mp4',trackStopCount:c.state.tracks[0].stopCount};

    c=await run('failed-retry');
    assert.ok(c.errors.some(e=>e.includes('fixture rejects the UA default'))); assert.deepEqual(c.stopped,[1]);
    result.cases.failedRetryCleansStream={trackStopCount:c.stopped[0],errors:c.errors};
    assert.deepEqual(result.externalRequests,[]); assert.deepEqual(result.pageErrors,[]);
    result.pass=true; process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } catch(e){process.stderr.write((e.stack||String(e))+'\n');process.exitCode=1;}
  finally {if(browser)await browser.close().catch(()=>{});if(server.closeAllConnections)server.closeAllConnections();await new Promise(resolve=>server.close(resolve)).catch(()=>{});}
})();
