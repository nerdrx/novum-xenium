const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = process.env.TEST_REPO || path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(repo, 'static/js/admin.js'), 'utf8');
const marker = '/* ═══════════════════════════════════════════\n   PUBLIC API';
assert(source.includes(marker));
const html = `<!doctype html><meta charset="utf-8"><body>
<button id="adm-exportDataBtn">Export</button><button id="adm-importDataBtn">Import</button><input type="file" id="adm-importFile">
<button id="adm-fullBackupBtn">Backup</button><button id="adm-fullRestoreChoose">Preview Full Restore</button>
<input type="file" id="adm-fullRestoreFile"><button id="adm-fullRestoreApply" style="display:none">Stage Restore and Require Restart</button>
<div id="adm-backupMsg"></div><div id="adm-fullRestorePreview"></div>
<script type="module">import '/static/js/admin.js';window.ready=true;</script>`;
let heldStage, stageStarted = 0, nextStageStatus = 200, restorePending = false;
const requests = [];
const send = (res, body) => {res.writeHead(200, {'Content-Type':'application/json'});res.end(JSON.stringify(body));};
const server = http.createServer((req,res) => {
  const url = new URL(req.url,'http://127.0.0.1');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/__reset-synthetic-backend') {restorePending=false;res.writeHead(204);return res.end();}
  if (url.pathname === '/api/backup/preview' || url.pathname === '/api/backup/restore') {
    let body = '';req.on('data', c => body += c);req.on('end', () => {
      requests.push({path:url.pathname,body});
      if (url.pathname.endsWith('/preview')) return send(res,{created_at:body,files:1,unpacked_bytes:12,includes_database:true,includes_encryption_key:true});
      stageStarted++;let status=nextStageStatus;nextStageStatus=200;if(status===200&&restorePending)status=400;heldStage = () => {if(status===200)restorePending=true;res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(status===200?{ok:true,message:'Synthetic restore staged'}:{detail:status===400?'A restore is already pending; restart the application first':'Synthetic staging failure'}));};
    });return;
  }
  if (url.pathname === '/static/js/admin.js') {res.setHeader('Content-Type','text/javascript');return res.end(source.replace(marker,'window.__initBackup = initBackup;\n'+marker));}
  if (url.pathname === '/static/js/settings.js') {res.setHeader('Content-Type','text/javascript');return res.end('export default {};');}
  const file = path.resolve(repo,'.'+url.pathname);
  if (!file.startsWith(repo+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',/\.(?:js|mjs)$/.test(file)?'text/javascript':'text/plain');fs.createReadStream(file).pipe(res);
});
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    browser = await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',args:['--no-sandbox','--disable-gpu']});
    const page = await browser.newPage();page.setDefaultTimeout(5000);
    await page.addInitScript(() => {window.confirm=()=>true;const deny=async()=>{throw Error('Hardware disabled in QA');};Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:deny,getDisplayMedia:deny,enumerateDevices:async()=>[]}});window.SpeechRecognition=window.webkitSpeechRecognition=class{start(){throw Error('Disabled');}};window.MediaRecorder=class{constructor(){throw Error('Disabled');}};});
    const origin = `http://127.0.0.1:${server.address().port}`;const errors=[];let externalRequests=0;
    await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin){externalRequests++;return route.abort();}return route.continue();});
    page.on('pageerror', e=>errors.push(e.message));
    await page.goto(origin);await page.waitForFunction(()=>window.ready&&window.__initBackup);await page.evaluate(()=>window.__initBackup());
    const input=page.locator('#adm-fullRestoreFile'), apply=page.locator('#adm-fullRestoreApply');
    const choose = async name => {
      await input.setInputFiles({name:name+'.zip',mimeType:'application/zip',buffer:Buffer.from('synthetic-'+name)});
      await page.waitForFunction(name=>document.querySelector('#adm-fullRestorePreview').textContent.includes('synthetic-'+name),name);
    };
    const stage = async (number,status=200) => {
      nextStageStatus=status;await apply.click();
      await new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const tick=()=>stageStarted===number?resolve():Date.now()>deadline?reject(Error('stage not started')):setTimeout(tick,10);tick();});
    };
    const release = async () => {heldStage();heldStage=null;await page.waitForFunction(()=>!document.querySelector('#adm-fullRestoreApply').disabled);};
    await choose('A');await stage(1);
    assert.equal(await page.locator('#adm-fullRestoreChoose').isEnabled(),true);
    await choose('B');await release();
    assert((await page.locator('#adm-fullRestorePreview').textContent()).includes('synthetic-B'),'late A must preserve newer preview B');
    assert.equal(await apply.isVisible(),true);
    assert.equal(await page.locator('#adm-backupMsg').textContent(),'Synthetic restore staged','accepted A still reports success');
    await stage(2);await release();
    assert((await page.locator('#adm-backupMsg').textContent()).includes('A restore is already pending'));
    assert((await page.locator('#adm-fullRestorePreview').textContent()).includes('synthetic-B'));
    assert.equal(await apply.isVisible(),true,'backend pending rejection preserves newer choice');
    // Independent no-pending-backup control; this fake reset is not an app restart.
    await page.evaluate(()=>fetch('/__reset-synthetic-backend'));
    await stage(3);await release();
    assert((await page.locator('#adm-fullRestorePreview').textContent()).includes('Restore staged.'),'current B clears its own preview');
    assert.equal(await apply.isVisible(),false);
    assert.equal(await apply.textContent(),'Stage Restore and Require Restart');
    await page.evaluate(()=>fetch('/__reset-synthetic-backend'));
    await choose('C');await stage(4,503);await release();
    assert((await page.locator('#adm-fullRestorePreview').textContent()).includes('synthetic-C'),'failure preserves current choice');
    assert.equal(await apply.isVisible(),true);
    assert((await page.locator('#adm-backupMsg').textContent()).includes('Synthetic staging failure'));
    await stage(5);await release();
    assert.equal(await apply.isVisible(),false);
    const stages=requests.filter(r=>r.path.endsWith('/restore')).map(r=>r.body);
    assert.deepEqual(stages,['synthetic-A','synthetic-B','synthetic-B','synthetic-C','synthetic-C']);
    assert.deepEqual(errors,[]);assert.equal(externalRequests,0);
    console.log(JSON.stringify({source_sha256:crypto.createHash('sha256').update(source).digest('hex'),pass:true,newerPreviewPreserved:true,acceptedOlderStageReported:true,pendingRestoreRejectedB:true,currentStageCleanup:true,failedStageRetryPreserved:true,stages,errors,externalRequests,limits:'Actual admin module with private initializer exposure; synthetic loopback files/responses only. No real backup or restore.'}));
  } finally {heldStage?.();await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
