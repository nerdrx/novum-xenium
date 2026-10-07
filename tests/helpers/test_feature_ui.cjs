// Real DOM smoke tests for the shipped team and workspace controls.
// APIs/model replies are fixtures; run with an installed Playwright package.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"></head>
<body style="padding:24px;overflow:auto"><div id="toast"></div><button id="workspace-open">Workspace</button>
<div class="group-conversation-panel" style="position:relative;bottom:auto;right:auto;width:280px"><div id="team"></div></div>
<script type="module">
import {createGroupTeam} from '/static/js/groupTeam.js';
import workspace from '/static/js/workspace.js';
window.sessionModule={getCurrentSessionId:()=> 'fixture-chat'};
window.teamCalls=[];
const team=createGroupTeam({apiBase:'',getParentSessionId:()=> 'fixture-chat',
 getModels:()=>[{mid:'builder',display:'Builder'},{mid:'reviewer',display:'Reviewer'}],
 getParticipantSessions:()=>({builder:'builder-session',reviewer:'reviewer-session'}),
 getRequestContext:()=>({mode:'agent',workspace:'/workspace'})});
const nativeFetch=window.fetch.bind(window);
window.fetch=(url,options={})=>{
 if(url.includes('/team/run')&&options.method==='POST')window.teamCalls.push(JSON.parse(options.body));
 return nativeFetch(url,options);
};
await team.mount(document.getElementById('team'));team.setEnabled(true);
document.getElementById('workspace-open').onclick=()=>workspace.openWorkspaceBrowser();
window.fixtureReady=true;
</script></body></html>`;
let savedBoard = null;
let savedRun = null;
let isolatePosted = false;
let restored = false;
const snapshot = {id:'a'.repeat(32),created_at:new Date().toISOString(),label:'Before coding'};
const json = (res, data) => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
const server = http.createServer(async(req,res)=>{
  const url = new URL(req.url,'http://localhost');
  if(url.pathname==='/') return res.end(html);
  if(url.pathname.startsWith('/api/groups/')) {
    if(url.pathname.endsWith('/team/run')&&req.method==='POST') {
      let body='';for await(const part of req)body+=part;
      const payload=JSON.parse(body);savedBoard=payload.board;isolatePosted=payload.isolate_worktrees;
      savedBoard.tasks=savedBoard.tasks.map(task=>({...task,status:'awaiting_review',work_result:'Task worktree (detached at selected Git HEAD; uncommitted source changes were not copied):\n/tmp/worktree-a\n\nVerified fixture report',review_result:'Review complete'}));
      savedRun={job_id:'fixture-job',status:'completed',state:{message:'Pass complete'}};
      return json(res,{run:savedRun});
    }
    if(url.pathname.endsWith('/team/run')) return json(res,{run:savedRun});
    if(req.method==='PUT') {let body='';for await(const part of req)body+=part;savedBoard=JSON.parse(body).board;}
    return json(res,{board:savedBoard});
  }
  if(url.pathname==='/api/workspace/browse')return json(res,{path:'/workspace',parent:'/',dirs:[],selectable:true});
  if(url.pathname==='/api/workspace/snapshots')return json(res,{snapshots:[snapshot]});
  if(url.pathname.endsWith('/preview'))return json(res,{snapshot,revision:'fixture-revision',changes:[{path:'main.py',status:'modified',diff:'-before\n+after\n'}]});
  if(url.pathname.endsWith('/restore')){restored=true;return json(res,{rollback_snapshot_id:'b'.repeat(32)});}
  const file=path.resolve(repo,'.'+url.pathname);
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/plain');
  fs.createReadStream(file).pipe(res);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE});
  try {
    const page=await browser.newPage({viewport:{width:1000,height:800}});
    const errors=[];page.on('pageerror',error=>errors.push(error.stack));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>window.fixtureReady);
    await page.locator('[data-team-plan]').fill('Build and review a tiny app');
    await page.locator('[data-team-add]').click();
    await page.locator('[data-team-title]').fill('Implement the assigned app');
    await page.locator('[data-team-title]').blur();
    await page.locator('[data-team-isolate]').check();
    await page.locator('[data-team-run]').click();
    await page.locator('[data-team-done]').waitFor();
    assert.match(await page.locator('.group-team-worktree').textContent(),/\/tmp\/worktree-a/);
    const posted=await page.evaluate(()=>window.teamCalls[0]);
    assert.deepEqual(posted.participant_sessions,{builder:'builder-session',reviewer:'reviewer-session'});
    assert.equal(posted.isolate_worktrees,true);
    assert.equal(isolatePosted,true);
    assert.equal(posted.board.tasks[0].title,'Implement the assigned app');
    assert.match(await page.locator('.group-team-status').textContent(),/awaiting review/);
    if(process.env.UI_CAPTURE_DIR)await page.screenshot({animations:'disabled',path:path.join(process.env.UI_CAPTURE_DIR,'team.png')});
    await page.locator('[data-team-done]').click();
    assert.equal(await page.locator('.group-team-status').textContent(),'done');
    await page.locator('#workspace-open').click();
    await page.locator('#workspace-snapshot-select option[value="'+snapshot.id+'"]').waitFor({state:'attached'});
    await page.locator('#workspace-snapshot-select').selectOption(snapshot.id);
    await page.locator('#workspace-snapshot-review').click();
    await page.locator('#workspace-snapshot-preview details').waitFor();
    await page.locator('#workspace-snapshot-preview summary').click();
    assert.match(await page.locator('#workspace-snapshot-preview pre').textContent(),/-before/);
    if(process.env.UI_CAPTURE_DIR)await page.screenshot({animations:'disabled',path:path.join(process.env.UI_CAPTURE_DIR,'undo.png')});
    page.on('dialog',dialog=>dialog.accept());
    await page.locator('#workspace-snapshot-restore').click();
    await page.waitForFunction(()=>document.getElementById('workspace-snapshot-preview').textContent.startsWith('Restored.'));
    assert.equal(restored,true);
    assert.equal(await page.locator('#workspace-snapshot-restore').isDisabled(),true);
    assert.deepEqual(errors,[]);
    console.log('PASS: headless DOM server-owned team pass, human completion, snapshot preview/restore');
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
