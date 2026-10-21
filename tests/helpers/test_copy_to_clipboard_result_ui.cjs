const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = process.cwd();
const sourcePath = process.env.CLIPBOARD_UI_OVERRIDE || path.join(repo, 'static/js/ui.js');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
const calls = [];
const html = `<!doctype html><div id="toast"></div><script type="module">
import * as ui from '/static/js/ui.js';
window.__ui = ui;
window.__clipboardCalls = [];
window.__execResult = new URL(location.href).searchParams.get('exec') === 'true';
Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text=>{
  window.__clipboardCalls.push(String(text));
  if (new URL(location.href).searchParams.get('clipboard') === 'reject') throw new Error('fixture clipboard rejection');
}}});
document.execCommand = command => {
  window.__execCalls = (window.__execCalls || 0) + 1;
  window.__execValue = document.querySelector('textarea')?.value || '';
  return window.__execResult;
};
window.__ready = true;
</script>`;
const server = http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  if(pathname==='/') {res.writeHead(200,{'content-type':'text/html'});return res.end(html);}
  if(pathname==='/api/tasks/notification-logs') {
    const chunks=[];req.on('data',x=>chunks.push(x));req.on('end',()=>{calls.push(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(200,{'content-type':'application/json'});res.end('{}');});return;
  }
  if(pathname==='/api/prefs/theme'||pathname==='/api/prefs/custom-themes') {res.writeHead(200,{'content-type':'application/json'});return res.end('{}');}
  if(pathname.startsWith('/api/')) {res.writeHead(200,{'content-type':'application/json'});return res.end('{}');}
  if (pathname === '/static/js/ui.js' && process.env.CLIPBOARD_UI_OVERRIDE) { res.writeHead(200, {'content-type':'text/javascript'}); return res.end(fs.readFileSync(sourcePath)); }
  const file=path.resolve(repo,'static',`.${pathname.slice('/static'.length)}`);
  if(!file.startsWith(path.resolve(repo,'static')+path.sep)){res.writeHead(400);return res.end();}
  const ext=path.extname(file);const type=ext==='.js'||ext==='.mjs'?'text/javascript':ext==='.css'?'text/css':'application/octet-stream';
  fs.readFile(file,(error,bytes)=>{if(error){res.writeHead(404);return res.end();}res.writeHead(200,{'content-type':type});res.end(bytes);});
});

(async()=>{
  let browser;
    const result={pass:false,source:{file:'static/js/ui.js',sha256:sourceHash},cases:{},externalRequests:[],pageErrors:[],notifications:calls,scope:'actual ui.js and chatRenderer.js modules in headless Chrome; synthetic clipboard APIs and execCommand stub; only synthetic text; notification log fixture loopback; no OS clipboard or external network'};
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'/opt/google/chrome/chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
    async function run(clipboard,exec){
      const page=await browser.newPage();
      page.on('pageerror',e=>result.pageErrors.push(e.stack||e.message));
      page.on('console',m=>{if(m.type()==='error')result.pageErrors.push(`console: ${m.text()}`);});
      page.on('requestfailed',r=>result.pageErrors.push(`request failed: ${r.url()} ${r.failure()?.errorText||''}`));
      page.on('request',r=>{if(new URL(r.url()).origin!==origin)result.externalRequests.push(r.url());});
      await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
      await page.goto(`${origin}/?clipboard=${clipboard}&exec=${exec}`);
      await page.waitForFunction(()=>window.__ready===true&&window.__ui?.copyToClipboard);
      const before=calls.length;
      const observation=await page.evaluate(async()=>{
        const copied = await window.__ui.copyToClipboard('synthetic clipboard probe');
        return {copied,toast:document.querySelector('#toast .toast-message')?.textContent||'',execCalls:window.__execCalls||0,execValue:window.__execValue||'',textareaCount:document.querySelectorAll('textarea').length,clipboardCalls:window.__clipboardCalls.length};
      });
      for(let i=0;i<30&&calls.length===before;i++) await new Promise(resolve=>setTimeout(resolve,10));
      await page.close();
      return {...observation,notificationLogged:calls.length===before+1,notificationStatus:calls.at(-1)?.status||''};
    }
    result.cases.bothClipboardPathsFail=await run('reject','false');
    assert.equal(result.cases.bothClipboardPathsFail.copied,false);assert.equal(result.cases.bothClipboardPathsFail.toast,'Could not copy');assert.equal(result.cases.bothClipboardPathsFail.execCalls,1);assert.equal(result.cases.bothClipboardPathsFail.execValue,'synthetic clipboard probe');assert.equal(result.cases.bothClipboardPathsFail.textareaCount,0);assert.equal(result.cases.bothClipboardPathsFail.notificationLogged,true);assert.equal(calls.at(-1)?.status,'error');
    result.cases.clipboardApiSuccess=await run('resolve','false');
    assert.equal(result.cases.clipboardApiSuccess.copied,true);assert.equal(result.cases.clipboardApiSuccess.toast,'Copied');assert.equal(result.cases.clipboardApiSuccess.execCalls,0);assert.equal(result.cases.clipboardApiSuccess.textareaCount,0);assert.equal(result.cases.clipboardApiSuccess.notificationLogged,true);assert.equal(result.cases.clipboardApiSuccess.notificationStatus,'success');
    result.cases.execCommandFallbackSuccess=await run('reject','true');
    assert.equal(result.cases.execCommandFallbackSuccess.copied,true);assert.equal(result.cases.execCommandFallbackSuccess.toast,'Copied');assert.equal(result.cases.execCommandFallbackSuccess.execCalls,1);assert.equal(result.cases.execCommandFallbackSuccess.execValue,'synthetic clipboard probe');assert.equal(result.cases.execCommandFallbackSuccess.textareaCount,0);assert.equal(result.cases.execCommandFallbackSuccess.notificationLogged,true);assert.equal(result.cases.execCommandFallbackSuccess.notificationStatus,'success');
    result.cases.rendererOwnedSuccessOnFailure=await (async()=>{
      const page=await browser.newPage();
      page.on('pageerror',e=>result.pageErrors.push(e.stack||e.message));
      page.on('request',r=>{if(new URL(r.url()).origin!==origin)result.externalRequests.push(r.url());});
      await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
      await page.goto(`${origin}/?clipboard=reject&exec=false`);
      await page.waitForFunction(()=>window.__ready===true&&window.__ui?.copyToClipboard);
      const before=calls.length;
      const observation=await page.evaluate(async()=>{
        localStorage.setItem('odysseus-user-actions-recent',JSON.stringify(['copy','edit','delete']));
        const renderer=await import('/static/js/chatRenderer.js');
        const message=document.createElement('div');
        message.innerHTML='<div class="body">synthetic renderer copy text</div>';
        const footer=renderer.createUserMsgFooter(message);
        document.body.appendChild(message);document.body.appendChild(footer);
        const button=footer.querySelector('.footer-copy-btn');
        const before=button.innerHTML;
        button.click();
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        await new Promise(resolve=>{
          if(document.querySelector('#toast .toast-message')?.textContent==='Could not copy') return resolve();
          const observer=new MutationObserver(()=>{if(document.querySelector('#toast .toast-message')?.textContent==='Could not copy'){observer.disconnect();resolve();}});
          observer.observe(document.body,{subtree:true,childList:true,characterData:true});
        });
        return {buttonUnchanged:button.innerHTML===before,toast:document.querySelector('#toast .toast-message')?.textContent||'',textareaCount:document.querySelectorAll('textarea').length};
      });
      for(let i=0;i<30&&calls.length===before;i++) await new Promise(resolve=>setTimeout(resolve,10));
      await page.close();
      return {...observation,notificationLogged:calls.length===before+1,notificationStatus:calls.at(-1)?.status||''};
    })();
    assert.equal(result.cases.rendererOwnedSuccessOnFailure.buttonUnchanged,true);assert.equal(result.cases.rendererOwnedSuccessOnFailure.toast,'Could not copy');assert.equal(result.cases.rendererOwnedSuccessOnFailure.textareaCount,0);assert.equal(result.cases.rendererOwnedSuccessOnFailure.notificationLogged,true);
    assert.equal(result.cases.rendererOwnedSuccessOnFailure.notificationStatus,'error');
    result.cases.rendererOwnSuccessOnSuccess=await (async()=>{
      const page=await browser.newPage();
      page.on('pageerror',e=>result.pageErrors.push(e.stack||e.message));
      page.on('console',m=>{if(m.type()==='error')result.pageErrors.push(`console: ${m.text()}`);});
      page.on('requestfailed',r=>result.pageErrors.push(`request failed: ${r.url()} ${r.failure()?.errorText||''}`));
      page.on('request',r=>{if(new URL(r.url()).origin!==origin)result.externalRequests.push(r.url());});
      await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
      await page.goto(`${origin}/?clipboard=reject&exec=true`);
      await page.waitForFunction(()=>window.__ready===true&&window.__ui?.copyToClipboard);
      const before=calls.length;
      const observation=await page.evaluate(async()=>{
        localStorage.setItem('odysseus-user-actions-recent',JSON.stringify(['copy','edit','delete']));
        const renderer=await import('/static/js/chatRenderer.js');
        const message=document.createElement('div');
        message.innerHTML='<div class="body">synthetic renderer copy text</div>';
        const footer=renderer.createUserMsgFooter(message);
        document.body.appendChild(message);document.body.appendChild(footer);
        const button=footer.querySelector('.footer-copy-btn');
        const before=button.innerHTML;
        button.click();
        await new Promise(resolve=>{
          if(document.querySelector('#toast .toast-message')?.textContent==='Copied') return resolve();
          const observer=new MutationObserver(()=>{if(document.querySelector('#toast .toast-message')?.textContent==='Copied'){observer.disconnect();resolve();}});
          observer.observe(document.body,{subtree:true,childList:true,characterData:true});
        });
        return {buttonChanged:button.innerHTML!==before,toast:document.querySelector('#toast .toast-message')?.textContent||'',textareaCount:document.querySelectorAll('textarea').length};
      });
      for(let i=0;i<30&&calls.length===before;i++) await new Promise(resolve=>setTimeout(resolve,10));
      await page.close();
      return {...observation,notificationLogged:calls.length===before+1,notificationStatus:calls.at(-1)?.status||''};
    })();
    assert.equal(result.cases.rendererOwnSuccessOnSuccess.buttonChanged,true);assert.equal(result.cases.rendererOwnSuccessOnSuccess.toast,'Copied');assert.equal(result.cases.rendererOwnSuccessOnSuccess.textareaCount,0);assert.equal(result.cases.rendererOwnSuccessOnSuccess.notificationLogged,true);assert.equal(result.cases.rendererOwnSuccessOnSuccess.notificationStatus,'success');
    assert.deepEqual(result.externalRequests,[]);assert.deepEqual(result.pageErrors,[]);result.pass=true;
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } catch(error){process.stdout.write(JSON.stringify(result,null,2)+'\n');process.stderr.write((error.stack||String(error))+'\n');process.exitCode=1;}
  finally{if(browser)await browser.close().catch(()=>{});if(server.closeAllConnections)server.closeAllConnections();await new Promise(resolve=>server.close(resolve)).catch(()=>{});}
})();
