// Actual shipped controls in headless Chrome; HTTP replies are fixtures.
// PLAYWRIGHT_PACKAGE=/path/to/playwright BROWSER_EXECUTABLE=/path/to/chrome node tests/helpers/test_usability_ui.cjs
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const state = { approvalFail: true, saveFail: true, mode: 'auto', snapshotsFail: true,
  modelFail: true, models: [], saves: 0, restored: null, previewDelay: 100 };
const snapshots = ['a', 'b'].map(id => ({id, label: `Snapshot ${id}`, created_at: '2026-10-07T10:00:00Z'}));
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css">
<body style="padding:20px;overflow:auto"><div id="toast"></div>
<button id="workspace-open">Workspace</button><div id="group-participants"></div><button id="group-add-btn">Add participant</button>
<div class="chat-input-right" style="position:fixed;bottom:12px;right:12px"><div class="mode-toggle">Agent</div></div>
<script type="module">
import workspace from '/static/js/workspace.js';
import approval from '/static/js/approvalMode.js';
import group from '/static/js/group.js';
window.fixtureSid='fixture-chat';
window.sessionModule={getCurrentSessionId:()=>window.fixtureSid};
window.modelsModule={getCachedItems:()=>[]};
window.workspace=workspace;
document.getElementById('workspace-open').onclick=()=>workspace.openWorkspaceBrowser();
approval.init();group.init('');window.fixtureReady=true;
</script></body>`;
const reply = (res, status, data) => {res.writeHead(status, {'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/api/prefs/tool_approval_mode') {
    if (req.method === 'PUT') {
      let body='';for await (const part of req) body+=part;
      await pause(100);
      if(state.saveFail) return reply(res, 503, {});
      state.mode=JSON.parse(body).value;
    } else if(state.approvalFail) return reply(res, 503, {});
    return reply(res, 200, {value:state.mode});
  }
  if (url.pathname === '/api/models') return reply(res, state.modelFail ? 503 : 200, {items:state.models});
  if (url.pathname === '/api/presets/templates') return reply(res, 200, []);
  if (url.pathname === '/api/workspace/browse') {
    const folder=url.searchParams.get('path') || '/workspace';
    if(folder==='/missing') return reply(res, 403, {});
    if(folder==='/slow-old') await pause(350);
    return reply(res, 200, {path:folder,parent:folder==='/workspace'?'/':'/workspace',
      dirs:folder==='/workspace'?[{name:'sample-project',path:'/workspace/sample-project'}]:[],selectable:folder!=='/'});
  }
  if (url.pathname === '/api/workspace/snapshots') {
    if(req.method==='POST') {state.saves++;await pause(150);const created={id:'c',label:'Manual snapshot',created_at:'2026-10-07T11:00:00Z'};snapshots.push(created);return reply(res,200,created);}
    if(state.snapshotsFail) return reply(res,503,{});
    return reply(res,200,{snapshots});
  }
  if (url.pathname.endsWith('/preview')) {
    await pause(state.previewDelay);const id=url.pathname.split('/').at(-2);
    return reply(res,200,{snapshot:snapshots.find(s=>s.id===id),revision:'fixture-revision',changes:[{path:'main.py',status:'modified',diff:'-before\n+after'}]});
  }
  if (url.pathname.endsWith('/restore')) {state.restored=url.pathname.split('/').at(-2);await pause(100);return reply(res,200,{rollback_snapshot_id:'recovery'});}
  const file=path.resolve(repo,'.'+url.pathname);
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/plain');fs.createReadStream(file).pipe(res);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-gpu']});
  try {
    const page=await browser.newPage({viewport:{width:1100,height:850}});
    page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>window.fixtureReady);
    const retry=page.getByRole('button',{name:'Retry loading approval mode'});
    await retry.waitFor();
    assert.deepEqual(await page.getByRole('radio').evaluateAll(nodes=>nodes.map(n=>n.disabled)),[true,true,true]);
    state.approvalFail=false;await retry.click();
    await page.waitForFunction(()=>!document.querySelector('.approval-mode-trigger').disabled && document.querySelector('[data-approval-label]').textContent==='Approve for me');
    await page.getByRole('radio',{name:/Full access/}).click();
    await page.waitForFunction(()=>document.querySelector('.approval-mode-error').textContent.includes('Could not save'));
    assert.match(await page.evaluate(()=>document.activeElement.textContent),/Approve for me/);
    state.saveFail=false;await page.getByRole('radio',{name:/Full access/}).press('Enter');
    await page.waitForFunction(()=>document.querySelector('.approval-mode-panel').hidden);
    assert.match(await page.locator('.approval-mode-trigger').getAttribute('aria-label'),/Full access/);

    await page.locator('#group-add-btn').click();
    await page.getByText(/Could not load participant choices/).waitFor();
    assert.equal(await page.locator('#group-add-btn').isDisabled(),false);
    state.modelFail=false;await page.locator('#group-add-btn').click();
    await page.getByText(/No models are available/).waitFor();
    state.models=[{models:['fixture-model'],models_display:['Fixture model'],url:'http://fixture'}];
    await page.locator('#group-add-btn').click();
    await page.getByRole('combobox',{name:'Participant model'}).waitFor();
    assert.equal(await page.getByRole('combobox',{name:'Participant character'}).inputValue(),'');

    await page.locator('#workspace-open').click();
    await page.getByRole('button',{name:'Retry loading snapshots'}).waitFor();
    state.snapshotsFail=false;await page.getByRole('button',{name:'Retry loading snapshots'}).click();
    await page.locator('#workspace-snapshot-select option[value="a"]').waitFor({state:'attached'});
    await page.getByRole('button',{name:'sample-project',exact:true}).press('Enter');
    await page.waitForFunction(()=>document.getElementById('workspace-cur-path').value==='/workspace/sample-project');
    const input=page.getByRole('textbox',{name:'Workspace folder path'});
    await input.fill('/missing');await input.press('Enter');
    await page.getByRole('button',{name:'Retry opening folder'}).waitFor();
    assert.equal(await page.locator('#workspace-use').isDisabled(),true);
    await input.fill('/slow-old');await input.press('Enter');
    await input.fill('/fast-new');await input.press('Enter');
    await page.waitForFunction(()=>document.getElementById('workspace-cur-path').value==='/fast-new');
    await pause(400);assert.equal(await input.inputValue(),'/fast-new');

    await page.locator('#workspace-snapshot-select').selectOption('a');
    await page.locator('#workspace-snapshot-review').click();
    await page.waitForFunction(()=>!document.getElementById('workspace-snapshot-restore').disabled);
    await page.locator('#workspace-snapshot-select').selectOption('b');
    assert.equal(await page.locator('#workspace-snapshot-restore').isDisabled(),true);
    assert.equal(await page.locator('#workspace-snapshot-preview').textContent(),'');
    await page.locator('#workspace-snapshot-review').click();
    await page.waitForFunction(()=>!document.getElementById('workspace-snapshot-restore').disabled);
    page.on('dialog',dialog=>dialog.accept());
    await page.locator('#workspace-snapshot-restore').click();
    await page.waitForFunction(()=>document.getElementById('workspace-snapshot-preview').textContent.startsWith('Restored.'));
    assert.equal(state.restored,'b');
    await page.evaluate(()=>{const button=document.getElementById('workspace-snapshot-create');button.click();button.click();});
    await page.waitForFunction(()=>document.getElementById('workspace-snapshot-select').value==='c');
    assert.equal(state.saves,1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#workspace-modal').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'workspace-open');

    state.previewDelay=400;
    await page.locator('#workspace-open').click();
    await page.locator('#workspace-snapshot-select').selectOption('a');
    await page.locator('#workspace-snapshot-review').click();
    await page.keyboard.press('Escape');
    await page.locator('#workspace-open').click();
    await pause(450);
    assert.equal(await page.locator('#workspace-snapshot-restore').isDisabled(),true);
    assert.equal(await page.locator('#workspace-snapshot-preview').textContent(),'');
    await page.keyboard.press('Escape');

    for(const width of [1100,390]) {
      await page.setViewportSize({width,height:850});
      await page.locator('.approval-mode-trigger').click();
      const bounds=await page.locator('.approval-mode-panel').boundingBox();
      assert(bounds.x>=0 && bounds.x+bounds.width<=width+1);
      await page.keyboard.press('Escape');
      await page.locator('#workspace-open').click();
      await page.waitForFunction(()=>document.getElementById('workspace-body').getAttribute('aria-busy')==='false');
      const modal=await page.locator('#workspace-modal .modal-content').boundingBox();
      assert(modal.x>=0 && modal.x+modal.width<=width+1);
      if(process.env.UI_CAPTURE_DIR)await page.screenshot({animations:'disabled',path:path.join(process.env.UI_CAPTURE_DIR,`usability-${width}.png`)});
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: approval retry/focus, group failure/empty/retry, keyboard folders, failed/stale browse, snapshot selection/restore/single save, Escape focus and desktop/mobile bounds');
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
