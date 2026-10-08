// Controlled API fixtures; real frontend assets and browser sandbox enforcement.
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const fs=require('fs');
const assert=require('assert/strict');
const path=require('node:path');
const os=require('node:os');
const repo=path.resolve(__dirname,'../..');
const screenshots=process.env.NX_MODULES_SCREENSHOT_DIR || os.tmpdir();
fs.mkdirSync(screenshots,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE || undefined,headless:true});
 try {
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport});
  let item={id:'demo',name:'Demo <b>safe</b>',version:'1.0',description:'An isolated panel',enabled:false,panel_url:null,previous_version:null,mcp_servers:[{id:'unrelated',name:'Other tools',configured:true,enabled:true,status:'connected',manifest_match:false}],mcp:{name:'Demo tools',transport:'http',url:'https://tools.example.test/mcp'}};
  let isAdmin=true,fail=false,installs=0,toggles=0,connections=0,rollbacks=0;
  await page.route('http://modules.test/**',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<style>:root{--bg:#111;--panel:#191919;--fg:#eee;--border:#444;--red:#a400ff}.hidden{display:none!important}body{margin:16px}.modal{position:fixed;inset:8px;display:flex;justify-content:center;align-items:center}.modal-content{background:var(--bg);border:2px solid var(--border)}.modal-header{display:flex;justify-content:space-between;padding:12px}</style><link rel="stylesheet" href="/static/modules.css"><section id="modules-panel"></section><div id="module-window" class="modal hidden" role="dialog" aria-labelledby="module-window-title"><div class="modal-content"><header id="module-window-header" class="modal-header"><h2 id="module-window-title"></h2><button id="module-window-close">Close</button></header><div id="module-frame-host"></div></div></div><script type="module">import{initModules,refreshModules}from'/static/js/modules.js';initModules();window.refreshModules=refreshModules;refreshModules();</script>`});
   if(url.pathname.startsWith('/static/'))return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(repo+url.pathname)});
   if(url.pathname==='/api/modules'&&request.method()==='GET')return route.fulfill({status:fail?500:200,json:fail?{detail:'Fixture failure'}:{modules:[item],is_admin:isAdmin}});
   if(url.pathname==='/api/mcp/servers'){connections++;assert.ok(request.postData().includes('https://tools.example.test/mcp'));item.mcp_servers.push({id:'tools',name:'Demo tools',configured:true,enabled:true,status:'connected',manifest_match:true});return route.fulfill({json:{id:'tools',connected:true}});}
   if(url.pathname==='/api/modules/demo/rollback'){rollbacks++;item={...item,version:'1.0',previous_version:'2.0',enabled:false,panel_url:null};return route.fulfill({json:{module:item}});}
   if(url.pathname==='/api/modules/install'){installs++;item={...item,version:'2.0',previous_version:'1.0',enabled:false,panel_url:null};return route.fulfill({json:{module:item,updated:true}});}
   if(url.pathname==='/api/modules/demo/enabled'){toggles++;item={...item,enabled:request.postDataJSON().enabled};item.panel_url=item.enabled?'/api/modules/demo/panel':null;return route.fulfill({json:{module:item}});}
   if(url.pathname==='/api/modules/demo/assets/test.png')return route.fulfill({contentType:'image/png',body:fs.readFileSync(path.join(repo,'static/icons/novum-xenium.png'))});
   if(url.pathname==='/api/modules/demo/panel')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'none'; frame-ancestors 'self'"},body:`<body><p>Isolated demo</p><img src="assets/test.png" alt="Local module image"><script>window.probe={};try{parent.document.body;probe.parent=true}catch(e){probe.parent=false}try{localStorage.getItem('x');probe.storage=true}catch(e){probe.storage=false}fetch('/api/modules').then(()=>probe.network=true).catch(()=>probe.network=false);</script>`});
   return route.fulfill({status:404,body:'not found'});
  });
  await page.goto('http://modules.test');
  await page.getByRole('heading',{name:'Modules',exact:true}).waitFor();
  assert.equal(await page.locator('.modules-card b').count(),0);
  assert.equal(await page.getByRole('button',{name:'Open panel',exact:true}).count(),0);
  await page.getByRole('button',{name:'Enable Demo <b>safe</b>',exact:true}).click();
  assert.equal(connections,0);
  await page.getByRole('button',{name:'Connect MCP server',exact:true}).click();
  await page.getByText('Demo tools: connected',{exact:true}).waitFor();
  assert.equal(connections,1);
  assert.equal(await page.getByRole('button',{name:'Connect MCP server',exact:true}).count(),0);
  await page.getByRole('button',{name:'Open panel',exact:true}).click();
  await page.locator('#module-frame-host iframe').waitFor();
  assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
  const frame=page.frames().find(f=>f.url().endsWith('/panel'));
  await frame.waitForFunction(()=>window.probe&&typeof probe.network==='boolean');
  assert.deepEqual(await frame.evaluate(()=>window.probe),{parent:false,storage:false,network:false});
  await frame.waitForFunction(()=>document.querySelector('img').complete && document.querySelector('img').naturalWidth>0);
  assert.equal(await frame.locator('img').evaluate(image=>image.naturalWidth>0),true);
  await page.locator('#module-window-close').press('Escape');
  assert.equal(await page.locator('iframe').count(),0);
  assert.equal(await page.getByRole('button',{name:'Open panel',exact:true}).evaluate(e=>e===document.activeElement),true);
  await page.getByRole('button',{name:'Open panel',exact:true}).click();
  await page.locator('iframe').waitFor();
  await page.locator('#modules-file').setInputFiles({name:'demo.zip',mimeType:'application/zip',buffer:Buffer.from('test')});
  await page.getByRole('button',{name:'Install / update',exact:true}).evaluate(e=>e.click());
  await page.getByText('Version 2.0',{exact:true}).waitFor();
  assert.equal(installs,1);assert.equal(toggles,1);
  assert.equal(await page.locator('iframe').count(),0);
  assert.equal(await page.locator('#module-window').evaluate(e=>e.classList.contains('hidden')),true);
  assert.equal(await page.getByRole('button',{name:'Open panel',exact:true}).count(),0);
  assert.equal(await page.locator('.modules-card').evaluate(e=>e.getBoundingClientRect().right<=innerWidth),true);
  await page.getByRole('button',{name:'Restore 1.0',exact:true}).click();
  await page.getByText('Version 1.0',{exact:true}).waitFor();
  assert.equal(rollbacks,1);
  assert.equal(await page.getByRole('button',{name:'Open panel',exact:true}).count(),0);
  isAdmin=false;await page.evaluate(()=>refreshModules());
  assert.equal(await page.locator('#modules-file').count(),0);
  assert.equal(await page.getByRole('button',{name:/Enable Demo/}).count(),0);
  fail=true;await page.evaluate(()=>refreshModules());
  await page.getByRole('alert').filter({hasText:'Fixture failure'}).waitFor();
  fail=false;await page.getByRole('button',{name:'Try again',exact:true}).click();
  await page.getByRole('heading',{name:'Modules',exact:true}).waitFor();
  await page.screenshot({path:path.join(screenshots,`nx-modules-${viewport.width}.png`)});
  await page.close();
 }
 } finally { await browser.close(); }
 console.log('PASS: desktop/mobile modules install, toggle, upgrade disables, non-admin controls, retry, Escape/focus restore, upgrade closes frame, explicit MCP registration with unrelated refs, local module image, rollback, safe text, opaque iframe DOM/storage/network isolation');
})().catch(e=>{console.error(e);process.exit(1)});
