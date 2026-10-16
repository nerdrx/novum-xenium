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
  res.setHeader('Content-Type',(file.endsWith('.js') || file.endsWith('.mjs'))?'text/javascript':'text/css');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'/opt/google/chrome/chrome',args:['--no-sandbox']});
 try {
  const page=await browser.newPage({viewport:{width:1280,height:800}});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/static/js/workspace.js', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function openWorkspaceBrowser() { window.projectToolsOpened = true; }' }));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.dock);
  const mediaFixture = await page.evaluate(async()=>{
    if(!MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) throw new Error('WebM fixture encoding unavailable');
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const ctx=canvas.getContext('2d');
    const stream=canvas.captureStream(8);const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});const chunks=[];
    recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)};const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();
    for(let i=0;i<8;i++){ctx.fillStyle=i%2?'#2468aa':'#c76a45';ctx.fillRect(0,0,160,90);await new Promise(resolve=>setTimeout(resolve,90))}
    recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());return btoa(String.fromCharCode(...new Uint8Array(await new Blob(chunks).arrayBuffer())));
  });
  const mediaBuffer=Buffer.from(mediaFixture,'base64');
  await page.evaluate(()=>{
   dock.updateWorkspaceDock({type:'tool_output',tool:'native_preview',screenshot:'data:image/svg+xml;base64,PHN2Zz4=',exit_code:0},'alpha');
   dock.updateWorkspaceDock({type:'tool_output',browser_preview:{screenshot:'javascript:alert(1)',url:'javascript:alert(1)',title:'<img onerror=alert(1)>',state:'unavailable'},diff:{path:'main.py',text:'+ hello'},subagent:{session_id:'child-1',title:'Worker'}},'alpha');
   dock.updateWorkspaceDock({inline_media:[{kind:'image',url:'https://media.example.test/pic.png',label:'Safe image'},{kind:'video',url:'https://media.example.test/clip.webm',label:'Safe clip'},{kind:'image',url:'/api/images/generated/owned.png',label:'Local generated image'},{kind:'video',url:'javascript:alert(1)'},{kind:'image',url:'http://outside.example.test/unsafe.png'}]},'alpha');
   dock.updateWorkspaceDock({type:'diff',text:'beta secret'},'beta');
  });
  await page.locator('.workspace-dock-toggle').click();
  assert.equal(await page.locator('.workspace-dock img').count(),0);
  assert.equal(await page.locator('#chat-container').evaluate(el=>getComputedStyle(el).marginRight),'420px');
  const separator = page.locator('.workspace-dock-resize');
  assert.equal(await separator.getAttribute('role'),'separator');
  assert.equal(await separator.getAttribute('aria-valuemin'),'280');
  const handle = await separator.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, 300);
  await page.mouse.down(); await page.mouse.move(780, 300); await page.mouse.up();
  assert.equal(await page.locator('.workspace-dock').evaluate(el=>Math.round(el.getBoundingClientRect().width)),500);
  assert.equal(await page.evaluate(()=>localStorage.getItem('odysseus.workspaceDock.width')),'500');
  await page.reload(); await page.waitForFunction(()=>window.dock);
  await page.locator('.workspace-dock-toggle').click();
  assert.equal(await page.locator('.workspace-dock').evaluate(el=>Math.round(el.getBoundingClientRect().width)),500,'saved width restores after reload');
  await page.locator('.workspace-dock-resize').focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('.workspace-dock-resize').getAttribute('aria-valuenow'),'516','keyboard grows the panel and updates its accessible value');
  await page.keyboard.press('End');
  assert.equal(await page.locator('.workspace-dock-resize').getAttribute('aria-valuenow'),'720','keyboard resize clamps to the available width');
  assert.ok(await page.locator('#chat-container').evaluate(el=>el.clientWidth>=420),'chat keeps its minimum readable width');
  await page.locator('#workspace-tab-Preview').focus();
  await page.evaluate(()=>{
   dock.updateWorkspaceDock({type:'tool_output',tool:'native_preview',screenshot:'data:image/svg+xml;base64,PHN2Zz4=',exit_code:0},'alpha');
   dock.updateWorkspaceDock({type:'tool_output',browser_preview:{screenshot:'javascript:alert(1)',url:'javascript:alert(1)',title:'<img onerror=alert(1)>',state:'unavailable'},diff:{path:'main.py',text:'+ hello'},subagent:{session_id:'child-1',title:'Worker'}},'alpha');
   dock.updateWorkspaceDock({inline_media:[{kind:'image',url:'https://media.example.test/pic.png',label:'Safe image'},{kind:'video',url:'https://media.example.test/clip.webm',label:'Safe clip'},{kind:'image',url:'/api/images/generated/owned.png',label:'Local generated image'},{kind:'video',url:'javascript:alert(1)'},{kind:'image',url:'http://outside.example.test/unsafe.png'}]},'alpha');
   dock.updateWorkspaceDock({type:'diff',text:'beta secret'},'beta');
  });
  assert.equal(await page.locator('#chat-container').evaluate(el=>getComputedStyle(el).marginRight),'720px');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[role=tab][aria-selected=true]').textContent(),'Media');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[role=tab][aria-selected=true]').textContent(),'Files');
  assert.match(await page.locator('[role=tabpanel]').textContent(),/Observed edits this visit/);
  assert.doesNotMatch(await page.locator('[role=tabpanel]').textContent(),/beta secret/);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.workspace-dock img,.workspace-dock iframe,.workspace-dock a').count(),0);
  assert.match(await page.locator('[role=tabpanel]').textContent(),/<img onerror/);
  await page.keyboard.press('ArrowRight');
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
  await page.route('https://media.example.test/**', route => route.request().url()==='https://media.example.test/clip.webm'
    ? route.fulfill({status:200,contentType:'video/webm',body:mediaBuffer}) : route.abort());
  await page.locator('#workspace-tab-Media').click();
  assert.equal(await page.evaluate(async () => (await import('/static/js/chatMedia.js')).safePublicMediaUrl('  ')), '', 'blank references are not treated as the app origin');
  assert.equal(await page.locator('.workspace-media-item').count(),3,`Workspace lists HTTPS and same-origin media only for the selected chat: ${await page.locator('[role=tabpanel]').textContent()} errors=${errors.join('|')}`);
  await page.waitForFunction(()=>document.querySelector('.workspace-media-item video')?.preload==='metadata',null,{timeout:5000});
  assert.equal(await page.locator('.workspace-media-item video').getAttribute('preload'),'metadata');
  assert.equal(await page.locator('.workspace-media-item a').first().getAttribute('href'),'https://media.example.test/pic.png');
  assert.equal(await page.locator('.workspace-media-item button.chat-media-fullscreen').count(),3);
  assert.equal(await page.locator('.workspace-media-item').nth(2).locator('img').getAttribute('src'),`http://127.0.0.1:${server.address().port}/api/images/generated/owned.png`,'same-origin generated images remain available');
  const workspaceVideo=page.locator('.workspace-media-item video');
  await workspaceVideo.evaluate(video=>video.load());
  await page.waitForFunction(()=>document.querySelector('.workspace-media-item video')?.readyState>=2,null,{timeout:10000});
  const workspaceVideoNode=await workspaceVideo.elementHandle();
  await workspaceVideo.evaluate(async video=>{video.muted=true;await video.play()});
  await page.waitForFunction(()=>document.querySelector('.workspace-media-item video')?.paused===false);
  await page.evaluate(()=>dock.updateWorkspaceDock({inline_media:[{kind:'image',url:'https://media.example.test/new.png'}]},'alpha'));
  assert.equal(await workspaceVideo.evaluate((node,old)=>node===old,workspaceVideoNode),true,'Workspace updates reuse its active media node');
  assert.equal(await workspaceVideo.evaluate(video=>video.paused),false,'Workspace updates do not interrupt playback');
  await page.evaluate(()=>dock.updateWorkspaceDock({inline_media:Array.from({length:61},(_,index)=>({kind:'image',url:`https://media.example.test/item-${index}.png`}))},'alpha'));
  assert.equal(await page.locator('.workspace-media-item').count(),60,'Workspace bounds the media gallery at sixty entries');
  assert.match(await page.locator('[role=tabpanel]').textContent(),/Showing the first 60 media items/,'Workspace discloses when the gallery reached its limit');
  await page.setViewportSize({width:390,height:700});
  assert.equal(await page.locator('#chat-container').evaluate(el=>getComputedStyle(el).marginRight),'0px');
  assert.ok((await page.locator('.workspace-dock').boundingBox()).width<=390);
  assert.equal(await page.locator('.workspace-dock-resize').evaluate(el=>getComputedStyle(el).display),'none','mobile dock remains full width with no resize handle');
  assert.equal(await page.locator('.workspace-dock-tabs').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  await page.setViewportSize({width:320,height:700});
  assert.equal(await page.locator('.workspace-dock-tabs').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  for (const tab of await page.locator('.workspace-dock-tabs button').all()) {
    const box=await tab.boundingBox(); assert.ok(box.x>=0 && box.x+box.width<=320);
  }
  await page.route('**/api/chat/evidence/alpha', route => route.fulfill({json:{runs:[{status:'error',model:'test-model',duration_seconds:2,events:[{tool:'test_tool',exit_code:1}]}]}}));
  await page.locator('#workspace-tab-Runs').click();
  await page.getByRole('button', {name:'Refresh runs'}).waitFor();
  assert.match(await page.locator('[role=tabpanel]').textContent(), /Failed · 2s/);
  assert.match(await page.locator('[role=tabpanel]').textContent(), /test_tool · exit 1/);
  await page.route('**/api/chat/evidence/beta', route => route.fulfill({status:503,body:'unavailable'}));
  await page.evaluate(()=>dock.resetWorkspaceDock('beta'));
  await page.getByRole('button', {name:'Refresh runs'}).waitFor();
  assert.match(await page.locator('[role=tabpanel]').textContent(), /Could not load runs/);
  assert.doesNotMatch(await page.locator('[role=tabpanel]').textContent(), /test_tool/);
  const previewPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=';
  let previewHistoryRequests = 0;
  await page.route('**/api/chat/previews/browser-only*', route => {
    previewHistoryRequests++;
    const offset = new URL(route.request().url()).searchParams.get('offset');
    return route.fulfill({json: offset === '1'
      ? {retention_days:7,previews:[{id:'preview-old',kind:'desktop',title:'Older page',created_at:1791000000,expires_at:1791604800}],has_more:false,next_offset:2}
      : {retention_days:7,previews:[{id:'preview-1',kind:'browser',title:'Saved page',created_at:1792000000,expires_at:1792604800}],has_more:true,next_offset:1}});
  });
  await page.route('**/api/chat/previews/browser-only/preview-1**', route => route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=','base64')}));
  await page.route('**/api/chat/previews/browser-only/preview-old**', route => route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=','base64')}));
  await page.evaluate(pixel => {
    dock.resetWorkspaceDock('browser-only');
    dock.updateWorkspaceDock({type:'tool_output',browser_preview:{screenshot:pixel,url:'https://example.com/',title:'Example browser page',state:'updated'}},'browser-only');
  }, previewPixel);
  await page.locator('#workspace-tab-Preview').click();
  assert.equal(await page.locator('.workspace-dock-content > img').getAttribute('src'), previewPixel, 'Default Preview should show browser activity when no desktop preview exists');
  await page.locator('.workspace-preview-history-item').waitFor();
  assert.equal(previewHistoryRequests,1,'preview history loads on explicit preview-tab open');
  assert.match(await page.locator('.workspace-preview-history-item').first().innerText(),/Saved page/);
  assert.match(await page.locator('.workspace-dock-content').innerText(),/storage limits may remove older previews/);
  await page.getByRole('button',{name:'Load older previews'}).click();
  await page.getByText(/Older page/).waitFor();
  assert.equal(previewHistoryRequests,2,'older previews load from the next bounded page');
  await page.waitForFunction(() => document.querySelector('.workspace-dock img')?.naturalWidth > 0);
  await page.locator('#workspace-tab-Browser').click();
  await page.evaluate(() => dock.updateWorkspaceDock({type:'tool_output',browser_preview:{state:'unavailable'}},'browser-only'));
  assert.equal(await page.locator('.workspace-dock-content > img').getAttribute('src'), previewPixel, 'An unavailable browser update must preserve the last screenshot');
  assert.match(await page.locator('[role=tabpanel]').textContent(), /Last available screenshot/);
  assert.match(await page.locator('.workspace-dock-content > img').getAttribute('alt'), /Previous browser screenshot/);
  assert.equal(await page.locator('.workspace-dock a').getAttribute('href'), 'https://example.com/');
  assert.ok(await page.locator('.workspace-dock-content > img').evaluate(img => img.getBoundingClientRect().right <= innerWidth));
  await page.evaluate(() => dock.resetWorkspaceDock('empty-chat'));
  assert.equal(await page.locator('.workspace-dock img').count(), 0, 'Browser screenshot must not leak into another chat');
  assert.doesNotMatch(await page.locator('.workspace-dock-content').innerText(),/Saved page/,'preview history is isolated by session');
  await page.evaluate(() => dock.resetWorkspaceDock('browser-only'));
  assert.equal(await page.locator('.workspace-dock-content > img').count(), 1);
  let staleRequestAborted = false;
  page.on('requestfailed', request => {
    if (request.url().includes('/api/chat/previews/slow-chat')) staleRequestAborted = true;
  });
  await page.route('**/api/chat/previews/slow-chat', async route => {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { await route.fulfill({json:{previews:[{id:'stale',kind:'browser',title:'Stale preview',created_at:1}]}}); } catch {}
  });
  await page.evaluate(() => dock.resetWorkspaceDock('slow-chat'));
  await page.waitForTimeout(10);
  await page.evaluate(() => dock.resetWorkspaceDock('browser-only'));
  await page.waitForTimeout(120);
  assert.equal(staleRequestAborted, true, 'switching chats aborts the old history request');
  assert.doesNotMatch(await page.locator('.workspace-dock-content').innerText(),/Stale preview/);
  await page.getByRole('button', {name:'Files & project tools'}).click();
  await page.waitForFunction(() => window.projectToolsOpened === true);
  assert.equal(await page.locator('.workspace-dock').count(), 0);
  assert.deepEqual(errors,[]);
  console.log('PASS: dock safe content, session isolation, keyboard tabs/Escape focus, desktop/mobile layout');
 } finally {await browser.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);server.closeAllConnections?.();server.close();process.exitCode=1;});
