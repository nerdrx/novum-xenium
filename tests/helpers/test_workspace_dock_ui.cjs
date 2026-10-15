const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const html = `<!doctype html><link rel="stylesheet" href="/static/workspace-dock.css"><main id="chat-container"><div class="chat-top-bar"></div><p>Chat stays here</p></main><script type="module">import * as dock from '/static/js/workspaceDock.js'; window.dock=dock; dock.resetWorkspaceDock('alpha');</script>`;
const server = http.createServer((req,res) => {
  if(req.url === '/') {res.setHeader('Content-Type','text/html');return res.end(html);}
  const file=path.resolve(repo,'.'+req.url);
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'/opt/google/chrome/chrome',args:['--no-sandbox']});
 try {
  const page=await browser.newPage({viewport:{width:1280,height:800}});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/static/js/workspace.js', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function openWorkspaceBrowser() { window.projectToolsOpened = true; }' }));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.dock);
  await page.evaluate(()=>{
   dock.updateWorkspaceDock({type:'tool_output',tool:'native_preview',screenshot:'data:image/svg+xml;base64,PHN2Zz4=',exit_code:0},'alpha');
   dock.updateWorkspaceDock({type:'tool_output',browser_preview:{screenshot:'javascript:alert(1)',url:'javascript:alert(1)',title:'<img onerror=alert(1)>',state:'unavailable'},diff:{path:'main.py',text:'+ hello'},subagent:{session_id:'child-1',title:'Worker'}},'alpha');
   dock.updateWorkspaceDock({type:'diff',text:'beta secret'},'beta');
  });
  await page.locator('.workspace-dock-toggle').click();
  assert.equal(await page.locator('.workspace-dock img').count(),0);
  assert.equal(await page.locator('#chat-container').evaluate(el=>getComputedStyle(el).marginRight),'420px');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[role=tab][aria-selected=true]').textContent(),'Files');
  assert.match(await page.locator('[role=tabpanel]').textContent(),/Observed edits this visit/);
  assert.doesNotMatch(await page.locator('[role=tabpanel]').textContent(),/beta secret/);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.workspace-dock img,.workspace-dock iframe,.workspace-dock a').count(),0);
  assert.match(await page.locator('[role=tabpanel]').textContent(),/<img onerror/);
  await page.keyboard.press('End');
  assert.equal(await page.locator('.workspace-dock a').getAttribute('href'),'#child-1');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.workspace-dock').count(),0);
  assert.equal(await page.evaluate(()=>document.activeElement.className),'workspace-dock-toggle');
  await page.evaluate(()=>dock.resetWorkspaceDock('beta'));
  await page.locator('.workspace-dock-toggle').click();
  await page.locator('#workspace-tab-Files').click();
  assert.match(await page.locator('[role=tabpanel]').textContent(),/beta secret/);
  assert.doesNotMatch(await page.locator('[role=tabpanel]').textContent(),/main.py/);
  await page.evaluate(()=>dock.resetWorkspaceDock('alpha'));
  assert.equal(await page.locator('.workspace-dock').count(), 1, 'Switching chats keeps workspace open');
  assert.match(await page.locator('[role=tabpanel]').textContent(), /main.py/);
  assert.doesNotMatch(await page.locator('[role=tabpanel]').textContent(), /beta secret/);
  await page.setViewportSize({width:390,height:700});
  assert.equal(await page.locator('#chat-container').evaluate(el=>getComputedStyle(el).marginRight),'0px');
  assert.ok((await page.locator('.workspace-dock').boundingBox()).width<=390);
  await page.getByRole('button', {name:'Files & project tools'}).click();
  await page.waitForFunction(() => window.projectToolsOpened === true);
  assert.equal(await page.locator('.workspace-dock').count(), 0);
  assert.deepEqual(errors,[]);
  console.log('PASS: dock safe content, session isolation, keyboard tabs/Escape focus, desktop/mobile layout');
 } finally {await browser.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);server.closeAllConnections?.();server.close();process.exitCode=1;});
