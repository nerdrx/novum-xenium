const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><meta charset="utf-8"><body>
<select id="adm-epProvider"><option value="">Generic URL</option><option value="http://127.0.0.1:9123/v1">Synthetic loopback choice</option></select>
<input id="adm-epUrl"><select id="adm-epKind"><option value="api">API</option><option value="proxy">Proxy</option></select>
<input id="adm-epApiKey"><select id="adm-epType"><option value="llm">LLM</option><option value="image">Image</option></select>
<button id="adm-epApiTestBtn">Test</button><button id="adm-epApiCancelTestBtn">Cancel</button>
<button id="adm-epAddBtn">Add</button><div id="adm-epApiMsg"></div>
<input id="adm-epLocalUrl"><input id="adm-epLocalApiKey">
<select id="adm-epLocalType"><option value="llm">LLM</option><option value="embedding">Embedding</option></select>
<button id="adm-epLocalTestBtn">Test</button><button id="adm-epLocalAddBtn">&gt;Add</button>
<div id="adm-epLocalMsg"></div>
<div id="adm-epList-local"></div><div id="adm-epList-api"></div>
<script type="module">import '/static/js/admin.js'; window.fixtureReady = true;</script></body>`;
let postCount = 0, nextHold = false, testCount = 0, nextTestHold = false, nextTestFailure = false, nextTestInvalidJson = false;
const bodies = [], testBodies = [], pending = new Map(), pendingTests = new Map();
function formValue(body, name) {
  const match = body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`));
  return match ? match[1] : null;
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/') return res.end(html);
  if (u.pathname === '/__state') { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({postCount,testCount,pending:[...pending.keys()],pendingTests:[...pendingTests.keys()]})); }
  if (u.pathname === '/__hold-next') { nextHold = true; res.writeHead(204); return res.end(); }
  if (u.pathname === '/__hold-test') { nextTestHold = true; res.writeHead(204); return res.end(); }
  if (u.pathname === '/__fail-test') { nextTestFailure = true; res.writeHead(204); return res.end(); }
  if (u.pathname === '/__invalid-json-test') { nextTestInvalidJson = true; res.writeHead(204); return res.end(); }
  if (u.pathname === '/__release') { const id=Number(u.searchParams.get('id')); pending.get(id)?.(); pending.delete(id); res.writeHead(204); return res.end(); }
  if (u.pathname === '/__release-test') { const id=Number(u.searchParams.get('id')); pendingTests.get(id)?.(); pendingTests.delete(id); res.writeHead(204); return res.end(); }
  if (u.pathname === '/api/model-endpoints/test' && req.method === 'POST') {
    const id=++testCount; let body=''; req.on('data', c => body += c); req.on('end', () => {
      testBodies[id]=body;
      const failed=nextTestFailure; nextTestFailure=false;
      const invalidJson=nextTestInvalidJson; nextTestInvalidJson=false;
      const send=()=>{res.writeHead(failed?500:200,{'Content-Type':'application/json'});res.end(invalidJson?'synthetic invalid json':JSON.stringify(failed?{detail:'synthetic-old-error'}:{online:true,status:'ok',models:['synthetic-current-model']}));};
      if (nextTestHold) { nextTestHold=false; pendingTests.set(id,send); } else send();
    }); return;
  }
  if (u.pathname === '/api/model-endpoints' && req.method === 'GET') { res.setHeader('Content-Type','application/json'); return res.end('[]'); }
  if (u.pathname === '/api/model-endpoints' && req.method === 'POST') {
    const id=++postCount; let body=''; req.on('data', c => body += c); req.on('end', () => {
      bodies[id]=body;
      const send=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:`synthetic-${id}`,models:[],online:false}));};
      if (nextHold) { nextHold=false; pending.set(id,send); } else send();
    }); return;
  }
  const file = path.resolve(repo, `.${u.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'text/plain');
  if (u.pathname === '/static/js/admin.js') return res.end(fs.readFileSync(file,'utf8').replace(
    '/* ═══════════════════════════════════════════\n   PUBLIC API',
    'window.__testInitEndpointForm = initEndpointForm;\n/* ═══════════════════════════════════════════\n   PUBLIC API'));
  if (u.pathname === '/static/js/settings.js') return res.end(
    'export default { refreshAiModelEndpoints() {}, initIntegrations() {}, open() {}, close() {} };');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || '/opt/google/chrome/chrome',args:['--no-sandbox','--disable-gpu']});
    const page=await browser.newPage(); page.setDefaultTimeout(5000);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const errors=[]; let loopbackOnly=true;
    await page.route('**/*', route => {
      const requestUrl = new URL(route.request().url());
      if ((requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:') && requestUrl.origin !== origin) {
        loopbackOnly = false;
        return route.abort();
      }
      return route.continue();
    });
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{const u=new URL(r.url());if((u.protocol==='http:'||u.protocol==='https:')&&u.hostname!=='127.0.0.1')loopbackOnly=false;});
    await page.goto(origin);
    await page.waitForFunction(()=>window.fixtureReady&&window.__testInitEndpointForm);
    await page.evaluate(()=>window.__testInitEndpointForm());
    const $=id=>page.locator(`#${id}`);
    const fillOld=async(n,url,key,kind,type)=>{
      await $('adm-epProvider').selectOption(''); await $('adm-epUrl').fill(url); await $('adm-epApiKey').fill(key);
      await $('adm-epKind').selectOption(kind); await $('adm-epType').selectOption(type);
    };
    const state=async()=>page.evaluate(()=>({url:document.querySelector('#adm-epUrl').value,key:document.querySelector('#adm-epApiKey').value,provider:document.querySelector('#adm-epProvider').value,kind:document.querySelector('#adm-epKind').value,type:document.querySelector('#adm-epType').value}));
    const localState=async()=>page.evaluate(()=>({url:document.querySelector('#adm-epLocalUrl').value,key:document.querySelector('#adm-epLocalApiKey').value,type:document.querySelector('#adm-epLocalType').value}));
    const waitHeldTest=async id=>page.waitForFunction(async id=>(await(await fetch('/__state')).json()).pendingTests.includes(id),id);
    const holdAndClick=async n=>{await page.evaluate(()=>fetch('/__hold-next'));await $('adm-epAddBtn').click();await page.waitForFunction(async n=>(await(await fetch('/__state')).json()).postCount===n,n);};
    const release=async n=>{await page.evaluate(n=>fetch(`/__release?id=${n}`),n);await page.waitForFunction(()=>!document.querySelector('#adm-epAddBtn').disabled);};
    const fillLocal=async(url,key,type)=>{await $('adm-epLocalUrl').fill(url);await $('adm-epLocalApiKey').fill(key);await $('adm-epLocalType').selectOption(type);};
    const holdAndClickLocal=async n=>{await page.evaluate(()=>fetch('/__hold-next'));await $('adm-epLocalAddBtn').click();await page.waitForFunction(async n=>(await(await fetch('/__state')).json()).postCount===n,n);};
    const releaseLocal=async n=>{await page.evaluate(n=>fetch(`/__release?id=${n}`),n);await page.waitForFunction(()=>!document.querySelector('#adm-epLocalAddBtn').disabled);};

    // Test results belong to the form snapshot that submitted them.
    await $('adm-epUrl').fill('http://127.0.0.1:9091/v1');
    await page.evaluate(()=>fetch('/__hold-test'));
    await $('adm-epApiTestBtn').click();
    await waitHeldTest(1);
    await $('adm-epUrl').fill('http://127.0.0.1:9092/v1');
    await page.evaluate(()=>fetch('/__release-test?id=1'));
    await page.waitForFunction(()=>!document.querySelector('#adm-epApiTestBtn').disabled);
    const apiEditedResult=await page.locator('#adm-epApiMsg').textContent();
    assert.equal(apiEditedResult.includes('synthetic-current-model'),false,'stale API Test response discarded');
    assert.equal(await $('adm-epApiTestBtn').isDisabled(),false,'API Test button restored after stale result');

    await $('adm-epApiTestBtn').click();
    await page.waitForFunction(()=>document.querySelector('#adm-epApiMsg').textContent.includes('synthetic-current-model'));
    const apiCurrentResult=await page.locator('#adm-epApiMsg').textContent();
    assert.equal(apiCurrentResult.includes('synthetic-current-model'),true,'unchanged API Test result rendered');

    await $('adm-epUrl').fill('http://127.0.0.1:9093/v1');
    await page.evaluate(()=>fetch('/__hold-test'));
    await $('adm-epApiTestBtn').click();
    await waitHeldTest(3);
    await $('adm-epApiCancelTestBtn').click();
    await page.waitForFunction(()=>document.querySelector('#adm-epApiMsg').textContent.includes('Test canceled'));
    assert.equal(await $('adm-epApiTestBtn').isDisabled(),false,'API Test button restored after explicit cancel');

    await $('adm-epUrl').fill('http://127.0.0.1:9096/v1');
    await page.evaluate(async()=>{await fetch('/__hold-test');await fetch('/__fail-test');});
    await $('adm-epApiTestBtn').click();
    await waitHeldTest(4);
    await $('adm-epUrl').fill('http://127.0.0.1:9097/v1');
    await page.evaluate(()=>fetch('/__release-test?id=4'));
    await page.waitForFunction(()=>!document.querySelector('#adm-epApiTestBtn').disabled);
    const apiEditedError=await page.locator('#adm-epApiMsg').textContent();
    assert.equal(apiEditedError.includes('synthetic-old-error'),false,'stale API Test error discarded');

    await $('adm-epUrl').fill('http://127.0.0.1:9096/v1');
    await page.evaluate(async()=>{await fetch('/__hold-test');await fetch('/__invalid-json-test');});
    await $('adm-epApiTestBtn').click();
    await waitHeldTest(5);
    await $('adm-epUrl').fill('http://127.0.0.1:9097/v1');
    await page.evaluate(()=>fetch('/__release-test?id=5'));
    await page.waitForFunction(()=>!document.querySelector('#adm-epApiTestBtn').disabled);
    const apiInvalidJson=await page.locator('#adm-epApiMsg').textContent();
    assert.equal(apiInvalidJson.includes('Test failed'),false,'stale API invalid-JSON error discarded');

    // Provider changes re-enable Test while A1 is pending. Reproduce A2 with
    // the exact same values so only request identity distinguishes ownership.
    await $('adm-epProvider').selectOption('http://127.0.0.1:9123/v1');
    await $('adm-epApiKey').fill('synthetic-overlap-key');
    await $('adm-epType').selectOption('image');
    await page.evaluate(()=>fetch('/__hold-test'));
    await $('adm-epApiTestBtn').click();
    await waitHeldTest(6);
    await $('adm-epProvider').selectOption('');
    await $('adm-epProvider').selectOption('http://127.0.0.1:9123/v1');
    await $('adm-epApiKey').fill('synthetic-overlap-key');
    await $('adm-epType').selectOption('image');
    await page.evaluate(()=>fetch('/__hold-test'));
    await $('adm-epApiTestBtn').click();
    await waitHeldTest(7);
    assert.equal(formValue(testBodies[6], 'base_url'),formValue(testBodies[7], 'base_url'),'overlap uses same URL');
    assert.equal(formValue(testBodies[6], 'api_key'),formValue(testBodies[7], 'api_key'),'overlap uses same synthetic key');
    assert.equal(formValue(testBodies[6], 'model_type'),formValue(testBodies[7], 'model_type'),'overlap uses same model type');
    const oldOverlapResponse=page.waitForResponse(r=>r.url().endsWith('/api/model-endpoints/test'));
    await page.evaluate(()=>fetch('/__release-test?id=6'));
    await oldOverlapResponse;
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
    assert.equal((await page.locator('#adm-epApiMsg').textContent()).includes('synthetic-current-model'),false,'older overlap response discarded');
    assert.equal(await $('adm-epApiTestBtn').isDisabled(),true,'older completion keeps newer Test disabled');
    await page.evaluate(()=>fetch('/__release-test?id=7'));
    await page.waitForFunction(()=>document.querySelector('#adm-epApiMsg').textContent.includes('synthetic-current-model'));
    assert.equal(await $('adm-epApiTestBtn').isDisabled(),false,'newest overlap completion restores Test');
    assert.equal(await $('adm-epApiTestBtn').textContent(),'Test','newest overlap completion restores Test label');

    await $('adm-epLocalUrl').fill('http://127.0.0.1:9094/v1');
    await page.evaluate(()=>fetch('/__hold-test'));
    await $('adm-epLocalTestBtn').click();
    await waitHeldTest(8);
    await $('adm-epLocalUrl').fill('http://127.0.0.1:9095/v1');
    await page.evaluate(()=>fetch('/__release-test?id=8'));
    await page.waitForFunction(()=>!document.querySelector('#adm-epLocalTestBtn').disabled);
    const localEditedResult=await page.locator('#adm-epLocalMsg').textContent();
    assert.equal(localEditedResult.includes('synthetic-current-model'),false,'stale local Test response discarded');
    assert.equal(await $('adm-epLocalTestBtn').isDisabled(),false,'local Test button restored after stale result');

    await $('adm-epLocalUrl').fill('http://127.0.0.1:9098/v1');
    await page.evaluate(()=>fetch('/__hold-test'));
    await $('adm-epLocalTestBtn').click();
    await waitHeldTest(9);
    await page.evaluate(()=>{const old=document.querySelector('#adm-epLocalUrl');const fresh=old.cloneNode(false);fresh.value='http://127.0.0.1:9099/v1';old.replaceWith(fresh);});
    await page.evaluate(()=>fetch('/__release-test?id=9'));
    await page.waitForFunction(()=>!document.querySelector('#adm-epLocalTestBtn').disabled);
    const localReplacement=await page.evaluate(()=>({url:document.querySelector('#adm-epLocalUrl').value,msg:document.querySelector('#adm-epLocalMsg').textContent}));
    assert.equal(localReplacement.url,'http://127.0.0.1:9099/v1','replacement local URL retained');
    assert.equal(localReplacement.msg.includes('synthetic-current-model'),false,'replacement local field suppresses old result');

    await $('adm-epLocalTestBtn').click();
    await page.waitForFunction(()=>document.querySelector('#adm-epLocalMsg').textContent.includes('synthetic-current-model'));
    const localCurrentResult=await page.locator('#adm-epLocalMsg').textContent();
    assert.equal(localCurrentResult.includes('synthetic-current-model'),true,'unchanged local Test result rendered');

    // All fields change while the original API request is pending.
    await fillOld(1,'http://127.0.0.1:9011/v1','synthetic-old-all','proxy','llm');
    await holdAndClick(1);
    assert.equal(formValue(bodies[1], 'base_url') === 'http://127.0.0.1:9011/v1', true, 'API POST keeps submitted URL');
    assert.equal(formValue(bodies[1], 'api_key') === 'synthetic-old-all', true, 'API POST keeps submitted key');
    assert.equal(formValue(bodies[1], 'endpoint_kind') === 'proxy', true, 'API POST keeps submitted kind');
    assert.equal(formValue(bodies[1], 'model_type') === 'llm', true, 'API POST keeps submitted type');
    await $('adm-epProvider').selectOption('http://127.0.0.1:9123/v1');
    await $('adm-epApiKey').fill('synthetic-new-all'); await $('adm-epType').selectOption('image');
    await release(1);
    const allChanged=await state();

    // A URL-only edit must preserve the entire coherent form, including reused credentials.
    await fillOld(2,'http://127.0.0.1:9021/v1','synthetic-reused-key','api','image');
    await holdAndClick(2); await $('adm-epUrl').fill('http://127.0.0.1:9022/v1'); await release(2);
    const urlOnly=await state();
    assert.equal(formValue(bodies[2], 'base_url') === 'http://127.0.0.1:9021/v1', true, 'API second POST keeps submitted URL');
    assert.equal(formValue(bodies[2], 'api_key') === 'synthetic-reused-key', true, 'API second POST keeps submitted key');
    assert.equal(formValue(bodies[2], 'endpoint_kind') === 'api', true, 'API second POST keeps submitted kind');
    assert.equal(formValue(bodies[2], 'model_type') === 'image', true, 'API second POST keeps submitted type');

    // Unchanged form with whitespace is submitted trimmed and still clears normally.
    await fillOld(3,'  http://127.0.0.1:9031/v1  ',' synthetic-whitespace-key ','api','image');
    await $('adm-epAddBtn').click();
    await page.waitForFunction(async()=>(await(await fetch('/__state')).json()).postCount===3);
    await page.waitForFunction(()=>!document.querySelector('#adm-epAddBtn').disabled);
    assert.equal(formValue(bodies[3], 'base_url') === 'http://127.0.0.1:9031/v1', true, 'API POST trims URL');
    assert.equal(formValue(bodies[3], 'api_key') === 'synthetic-whitespace-key', true, 'API POST trims key');
    assert.equal(formValue(bodies[3], 'endpoint_kind') === 'api', true, 'API whitespace POST keeps submitted kind');
    assert.equal(formValue(bodies[3], 'model_type') === 'image', true, 'API whitespace POST keeps submitted type');
    const unchangedWhitespace=await state();

    // Replacing a control node during the request preserves the whole current form.
    await fillOld(4,'http://127.0.0.1:9041/v1','synthetic-replacement-key','api','image');
    await holdAndClick(4);
    assert.equal(formValue(bodies[4], 'base_url') === 'http://127.0.0.1:9041/v1', true, 'API replacement POST keeps submitted URL');
    assert.equal(formValue(bodies[4], 'api_key') === 'synthetic-replacement-key', true, 'API replacement POST keeps submitted key');
    assert.equal(formValue(bodies[4], 'endpoint_kind') === 'api', true, 'API replacement POST keeps submitted kind');
    assert.equal(formValue(bodies[4], 'model_type') === 'image', true, 'API replacement POST keeps submitted type');
    await page.evaluate(()=>{const old=document.querySelector('#adm-epUrl');const fresh=old.cloneNode(false);fresh.value='http://127.0.0.1:9042/v1';old.replaceWith(fresh);});
    await release(4);
    const replacedControl=await state();

    // Local endpoint form: all edits during an older POST belong to a new draft.
    await fillLocal('http://127.0.0.1:9051/v1','synthetic-local-old-all','llm');
    await holdAndClickLocal(5);
    assert.equal(formValue(bodies[5], 'base_url') === 'http://127.0.0.1:9051/v1', true, 'local POST keeps submitted URL');
    assert.equal(formValue(bodies[5], 'api_key') === 'synthetic-local-old-all', true, 'local POST keeps submitted key');
    assert.equal(formValue(bodies[5], 'model_type') === 'llm', true, 'local POST keeps submitted type');
    await fillLocal('http://127.0.0.1:9052/v1','synthetic-local-new-all','embedding');
    await releaseLocal(5);
    const localAllChanged=await localState();

    // URL-only change preserves reused credentials and non-default type.
    await fillLocal('http://127.0.0.1:9061/v1','synthetic-local-reused','embedding');
    await holdAndClickLocal(6);
    assert.equal(formValue(bodies[6], 'base_url') === 'http://127.0.0.1:9061/v1', true, 'local second POST keeps submitted URL');
    assert.equal(formValue(bodies[6], 'api_key') === 'synthetic-local-reused', true, 'local second POST keeps submitted key');
    assert.equal(formValue(bodies[6], 'model_type') === 'embedding', true, 'local second POST keeps submitted type');
    await $('adm-epLocalUrl').fill('http://127.0.0.1:9062/v1');
    await releaseLocal(6);
    const localUrlOnly=await localState();

    // Unchanged whitespace-padded local fields still submit trimmed and clear.
    await fillLocal('  http://127.0.0.1:9071/v1  ',' synthetic-local-whitespace ','embedding');
    await $('adm-epLocalAddBtn').click();
    await page.waitForFunction(async()=>(await(await fetch('/__state')).json()).postCount===7);
    await page.waitForFunction(()=>!document.querySelector('#adm-epLocalAddBtn').disabled);
    assert.equal(formValue(bodies[7], 'base_url') === 'http://127.0.0.1:9071/v1', true, 'local POST trims URL');
    assert.equal(formValue(bodies[7], 'api_key') === 'synthetic-local-whitespace', true, 'local POST trims key');
    assert.equal(formValue(bodies[7], 'model_type') === 'embedding', true, 'local POST keeps type');
    const localWhitespace=await localState();

    // Replacing local URL node during request preserves replacement controls.
    await fillLocal('http://127.0.0.1:9081/v1','synthetic-local-replacement','llm');
    await holdAndClickLocal(8);
    await page.evaluate(()=>{const old=document.querySelector('#adm-epLocalUrl');const fresh=old.cloneNode(false);fresh.value='http://127.0.0.1:9082/v1';old.replaceWith(fresh);});
    await releaseLocal(8);
    const localReplaced=await localState();

    assert.equal(allChanged.url === 'http://127.0.0.1:9123/v1' && allChanged.key === 'synthetic-new-all' && allChanged.provider === 'http://127.0.0.1:9123/v1' && allChanged.kind === 'api' && allChanged.type === 'image', true, 'API all-field draft preserved');
    assert.equal(urlOnly.url === 'http://127.0.0.1:9022/v1' && urlOnly.key === 'synthetic-reused-key' && urlOnly.provider === '' && urlOnly.kind === 'api' && urlOnly.type === 'image', true, 'API URL-only draft preserved');
    assert.equal(unchangedWhitespace.url === '' && unchangedWhitespace.key === '' && unchangedWhitespace.provider === '' && unchangedWhitespace.kind === 'proxy' && unchangedWhitespace.type === 'llm', true, 'API unchanged form cleared');
    assert.equal(replacedControl.url === 'http://127.0.0.1:9042/v1' && replacedControl.key === 'synthetic-replacement-key' && replacedControl.provider === '' && replacedControl.kind === 'api' && replacedControl.type === 'image', true, 'API replacement controls preserved');
    assert.equal(localAllChanged.url === 'http://127.0.0.1:9052/v1' && localAllChanged.key === 'synthetic-local-new-all' && localAllChanged.type === 'embedding', true, 'local all-field draft preserved');
    assert.equal(localUrlOnly.url === 'http://127.0.0.1:9062/v1' && localUrlOnly.key === 'synthetic-local-reused' && localUrlOnly.type === 'embedding', true, 'local URL-only draft preserved');
    assert.equal(localWhitespace.url === '' && localWhitespace.key === '' && localWhitespace.type === 'llm', true, 'local unchanged form cleared');
    assert.equal(localReplaced.url === 'http://127.0.0.1:9082/v1' && localReplaced.key === 'synthetic-local-replacement' && localReplaced.type === 'llm', true, 'local replacement controls preserved');
    assert.deepEqual(errors,[]);assert.equal(loopbackOnly,true);assert.equal(postCount,8);assert.equal(testCount,10);
    console.log(JSON.stringify({apiTestStaleResultDiscarded:true,apiTestStaleErrorDiscarded:true,apiTestInvalidJsonCatchDiscarded:true,apiTestCurrentResultRendered:true,apiTestCancelPreserved:true,apiOverlappingSameSnapshotOlderResponseDiscarded:true,apiOverlappingNewerResponseRendered:true,localTestStaleResultDiscarded:true,localTestReplacementNodeDiscarded:true,localTestCurrentResultRendered:true,apiAllFieldsChangedPreserved:true,apiUrlOnlyPreservedCoherentForm:true,apiUnchangedWhitespaceCleared:true,apiReplacementNodePreserved:true,localAllFieldsChangedPreserved:true,localUrlOnlyPreservedCoherentForm:true,localUnchangedWhitespaceCleared:true,localReplacementNodePreserved:true,submittedPayloadsStayedOld:true,pageErrors:errors.length,loopbackOnly,syntheticPosts:postCount,testRequests:testCount}));
  } finally {
    try {
      for (const [id, send] of pending) {
        try { send(); } catch (_) {}
        pending.delete(id);
      }
      for (const [id, send] of pendingTests) {
        try { send(); } catch (_) {}
        pendingTests.delete(id);
      }
      if (browser) await browser.close();
    } finally {
      if (server.listening) await new Promise(resolve=>server.close(resolve));
    }
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
