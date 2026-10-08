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
  let item={id:'demo',name:'Demo <b>safe</b>',version:'1.0',description:'An isolated panel',enabled:false,panel_url:null,previous_version:null,permissions:['git'],mcp_servers:[{id:'unrelated',name:'Other tools',configured:true,enabled:true,status:'connected',manifest_match:false}],mcp:{name:'Demo tools',transport:'http',url:'https://tools.example.test/mcp'}};
  let isAdmin=true,fail=false,installs=0,toggles=0,connections=0,rollbacks=0,sourceInstalls=0,source=null,sourceVersion='2.0',sourceEnabled=false,dataReads=0,sourceEvents=[];
  await page.route('http://modules.test/**',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<style>:root{--bg:#111;--panel:#191919;--fg:#eee;--border:#444;--red:#a400ff}.hidden{display:none!important}body{margin:16px}.modal{position:fixed;inset:8px;display:flex;justify-content:center;align-items:center}.modal-content{background:var(--bg);border:2px solid var(--border)}.modal-header{display:flex;justify-content:space-between;padding:12px}</style><link rel="stylesheet" href="/static/modules.css"><section id="modules-panel"></section><div id="module-window" class="modal hidden" role="dialog" aria-labelledby="module-window-title"><div class="modal-content"><header id="module-window-header" class="modal-header"><h2 id="module-window-title"></h2><button id="module-window-close">Close</button></header><div id="module-frame-host"></div></div></div><div id="settings-modal" class="hidden">Integrations</div><script type="module">import{initModules,refreshModules}from'/static/js/modules.js';initModules({openIntegrations:()=>{window.openIntegrationCalls=(window.openIntegrationCalls||0)+1;document.getElementById('settings-modal').classList.remove('hidden')}});window.refreshModules=refreshModules;refreshModules();</script>`});
   if(url.pathname.startsWith('/static/'))return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(repo+url.pathname)});
   if(url.pathname==='/api/modules'&&request.method()==='GET')return route.fulfill({status:fail?500:200,json:fail?{detail:'Fixture failure'}:{modules:[item,...(source?.modules.filter(m=>m.installed_version&&m.id!=='conflict-demo').map(m=>({id:m.id,name:m.name,version:m.installed_version,enabled:m.enabled,panel_url:null,permissions:['git']}))||[])],is_admin:isAdmin}});
   if(url.pathname==='/api/modules/sources'&&request.method()==='GET')return route.fulfill({json:{sources:source?[source]:[]}});
   if(url.pathname==='/api/modules/sources'&&request.method()==='POST'){
    const urlValue=request.postDataJSON().url;assert.equal(urlValue,'https://github.com/example/source');
    const previous=source?.modules||[];
    source={id:'demo-source',url:urlValue,commit:'abcdef0123456789',modules:[
     {id:'source-demo',name:'Source Demo',version:sourceVersion,description:'From a pinned GitHub source',installed_version:previous.find(m=>m.id==='source-demo')?.installed_version||null,enabled:sourceEnabled},
     {id:'fail-demo',name:'Failure Demo',version:sourceVersion,description:'Activation failure fixture',installed_version:previous.find(m=>m.id==='fail-demo')?.installed_version||null,enabled:false},
     {id:'conflict-demo',name:'Conflict Demo',version:sourceVersion,description:'Installed elsewhere',installed_version:'9.0',enabled:false,conflict:true},
    ]};
    return route.fulfill({json:{source}});
   }
   if(url.pathname==='/api/modules/sources/demo-source/install'&&request.method()==='POST'){
    const id=request.postDataJSON().module_id,mod=source.modules.find(m=>m.id===id);assert.ok(mod);sourceInstalls++;sourceEvents.push(`install:${id}`);
    if(id==='fail-demo')await new Promise(resolve=>setTimeout(resolve,150));
    mod.installed_version=mod.version;mod.enabled=false;if(id==='source-demo')sourceEnabled=false;
    return route.fulfill({json:{module:{id,name:mod.name,version:mod.version,enabled:false}}});
   }
   if(url.pathname==='/api/modules/sources/demo-source'&&request.method()==='DELETE'){source=null;return route.fulfill({json:{ok:true}});}
   if(url.pathname==='/api/modules/source-demo/enabled'||url.pathname==='/api/modules/fail-demo/enabled'){
    const id=url.pathname.includes('source-demo')?'source-demo':'fail-demo',enabled=request.postDataJSON().enabled,mod=source.modules.find(m=>m.id===id);
    sourceEvents.push(`enable:${id}:${enabled}`);
    if(id==='fail-demo'&&enabled)return route.fulfill({status:500,json:{detail:'Fixture activation failure'}});
    mod.enabled=enabled;if(id==='source-demo')sourceEnabled=enabled;
    return route.fulfill({json:{module:{id,name:mod.name,version:mod.installed_version,enabled}}});
   }
   if(url.pathname==='/api/modules/demo/data/git'){dataReads++;assert.equal(url.searchParams.get('workspace'),'/workspace');return route.fulfill({json:{repositories:['ok']}});}
   if(url.pathname==='/api/mcp/servers'){connections++;assert.ok(request.postData().includes('https://tools.example.test/mcp'));item.mcp_servers.push({id:'tools',name:'Demo tools',configured:true,enabled:true,status:'connected',manifest_match:true});return route.fulfill({json:{id:'tools',connected:true}});}
   if(url.pathname==='/api/modules/demo/rollback'){rollbacks++;item={...item,version:'1.0',previous_version:'2.0',enabled:false,panel_url:null};return route.fulfill({json:{module:item}});}
   if(url.pathname==='/api/modules/install'){installs++;item={...item,version:'2.0',previous_version:'1.0',enabled:false,panel_url:null};return route.fulfill({json:{module:item,updated:true}});}
   if(url.pathname==='/api/modules/demo/enabled'){toggles++;item={...item,enabled:request.postDataJSON().enabled};item.panel_url=item.enabled?'/api/modules/demo/panel':null;return route.fulfill({json:{module:item}});}
   if(url.pathname==='/api/modules/demo/assets/test.png')return route.fulfill({contentType:'image/png',body:fs.readFileSync(path.join(repo,'static/icons/novum-xenium.png'))});
   if(url.pathname==='/api/modules/demo/panel')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'none'; frame-ancestors 'self'"},body:`<body><p>Isolated demo</p><img src="assets/test.png" alt="Local module image"><script>window.probe={responses:[]};try{parent.document.body;probe.parent=true}catch(e){probe.parent=false}try{localStorage.getItem('x');probe.storage=true}catch(e){probe.storage=false}fetch('/api/modules').then(()=>probe.network=true).catch(()=>probe.network=false);addEventListener('message',e=>{if(e.data?.type==='novum:response')probe.responses.push(e.data)});parent.postMessage({type:'novum:request',id:'req-1',capability:'git',workspace:'/workspace'},'*');parent.postMessage({type:'novum:request',id:'req-2',capability:'research'},'*');</script>`});
   return route.fulfill({status:404,body:'not found'});
  });
  await page.goto('http://modules.test');
  await page.getByRole('heading',{name:'Modules',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Installed (1)',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.getByLabel('Repository URL').count(),0);
  await page.getByLabel('Find installed modules').fill('missing');
  await page.getByText('No matching modules. Try another name or status.').waitFor();
  assert.equal(await page.locator('[data-module-id="demo"]').isVisible(),false);
  await page.getByLabel('Find installed modules').fill('demo');
  assert.equal(await page.locator('[data-module-id="demo"]').isVisible(),true);
  await page.getByLabel('Module status').selectOption('enabled');
  assert.equal(await page.locator('[data-module-id="demo"]').isVisible(),false);
  await page.getByLabel('Module status').selectOption('all');
  await page.getByRole('button',{name:'Repositories',exact:true}).click();
  await page.getByLabel('Repository URL').fill('https://github.com/example/source');
  await page.getByRole('button',{name:'Add repo'}).click();
  await page.getByText('Pinned abcdef012345',{exact:true}).waitFor();
  await page.getByRole('checkbox',{name:'Enable Source Demo'}).check();
  await page.getByText('Source Demo enabled.',{exact:true}).waitFor();
  assert.equal(sourceInstalls,1);assert.equal(sourceEnabled,true);
  assert.deepEqual(sourceEvents.slice(0,2),['install:source-demo','enable:source-demo:true']);
  const failedToggle=page.getByRole('checkbox',{name:'Enable Failure Demo'});
  await page.getByRole('button',{name:'Install disabled'}).click();
  assert.equal(await failedToggle.isDisabled(),true);
  await page.getByText('Failure Demo installed disabled. Review and enable it when ready.').waitFor();
  await failedToggle.check();
  await page.getByRole('alert').filter({hasText:'Fixture activation failure'}).waitFor();
  assert.equal(await page.getByRole('checkbox',{name:'Enable Failure Demo'}).isChecked(),false);
  assert.equal(source.modules.find(m=>m.id==='fail-demo').installed_version,'2.0');
  const conflictToggle=page.getByRole('checkbox',{name:'Enable Conflict Demo'});
  assert.equal(await conflictToggle.isDisabled(),true);
  await page.getByText(/already installed from another source or ZIP/).waitFor();
  sourceVersion='3.0';
  await page.getByRole('button',{name:/Refresh/}).first().click();
  await page.getByRole('button',{name:'Update to 3.0'}).first().waitFor();
  await page.getByRole('button',{name:'Update to 3.0'}).first().click();
  await page.getByText('Source Demo updated disabled. Review and enable it when ready.').waitFor();
  assert.equal(sourceInstalls,3);assert.equal(sourceEnabled,false);
  await page.getByRole('button',{name:/Forget source/}).click();
  await page.getByRole('button',{name:/^Installed \(/}).click();
  await page.getByText('Install from ZIP',{exact:true}).click();
  await page.getByRole('button',{name:'Install / update',exact:true}).waitFor();
  assert.equal(source,null);
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
  assert.deepEqual(await frame.evaluate(()=>({parent:probe.parent,storage:probe.storage,network:probe.network})),{parent:false,storage:false,network:false});
  await frame.waitForFunction(()=>window.probe?.responses?.some(r=>r.id==='req-1'&&r.data?.repositories?.[0]==='ok')&&window.probe?.responses?.some(r=>r.id==='req-2'&&r.error==='Permission denied.'));
  assert.equal(dataReads,1);
  await frame.evaluate(()=>parent.postMessage({type:'novum:open',action:'integrations'},'*'));
  await page.locator('#settings-modal:not(.hidden)').waitFor();
  assert.equal(await page.evaluate(()=>window.openIntegrationCalls),1);
  await page.evaluate(()=>window.postMessage({type:'novum:request',id:'fake',capability:'git'},'*'));
  await page.waitForTimeout(50);assert.equal(dataReads,1);
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
 console.log('PASS: desktop/mobile module ZIP and GitHub source flows, first-check install/enable, activation failure reconciliation, source collisions, disabled updates, forget semantics, bridge permissions and integrations action, non-admin controls, retries, focus restore, MCP registration and rollback');
})().catch(e=>{console.error(e);process.exit(1)});
