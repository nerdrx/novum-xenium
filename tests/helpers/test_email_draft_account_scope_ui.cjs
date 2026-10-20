const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const state = { draft: [], send: [], external: 0 };
const html = `<!doctype html><meta charset="utf-8"><body><div id="toast"></div><div id="chat-container" style="height:100vh"></div><script type="module">import doc from '/static/js/document.js'; import sessions from '/static/js/sessions.js'; doc.init(location.origin); sessions.setCurrentSessionId('fixture-session'); window.fixture={doc}; window.fixtureReady=true;</script>`;
const json=(res, value, status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://fixture');
 if(u.pathname==='/'){res.setHeader('content-type','text/html');return res.end(html);}
 if(u.pathname==='/api/email/draft'&&req.method==='POST'){let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);const i=state.draft.push(body)-1;const account = body.resolve_for_send ? 'acct-IMAP' : (body.account_id || 'acct-DEFAULT');const sendAccount=body.resolve_for_send?(body.account_id||'acct-SMTP'):null;return json(res,{success:true,draft_uid:`fixture-uid-${i}`,draft_folder:'Drafts',account_id:account,draft_uidvalidity:`uidv-${i}`,mailbox_scope:`scope-${account}`,send_account_id:sendAccount});}
 if(u.pathname==='/api/email/accounts')return json(res,{accounts:['acct-A','acct-B'].map(id=>({id,smtp_host:'smtp.fixture.invalid',smtp_user:`${id}@fixture.invalid`,has_smtp_password:true}))});
 if(u.pathname==='/api/email/send'&&req.method==='POST'){let raw='';for await(const c of req)raw+=c;state.send.push(JSON.parse(raw));return json(res,{success:true,account_id:'acct-B',sent_folder:'Sent',sent_uid:'fixture-sent'});}
 if(u.pathname==='/api/document'&&req.method==='POST'){let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);return json(res,{id:`fixture-${b.title}`,title:b.title,language:b.language,content:b.content,current_content:b.content,session_id:b.session_id});}
 if(u.pathname.startsWith('/api/'))return json(res,{});
 const file=path.resolve(repo,`.${decodeURIComponent(u.pathname)}`);if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.setHeader('content-type',(file.endsWith('.js')||file.endsWith('.mjs'))?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');fs.createReadStream(file).pipe(res);
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || undefined,args:['--no-sandbox','--disable-gpu']});
 try{const page=await browser.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGEERROR',e.message)});page.on('requestfailed',r=>console.error('REQUESTFAIL',r.url(),r.failure()?.errorText));page.on('console',m=>{if(m.type()==='error')console.error('CONSOLE',m.text())});await page.route('**/*',route=>{let o='';try{o=new URL(route.request().url()).origin;}catch{}if(o!==origin){state.external++;return route.abort();}return route.continue();});await page.addInitScript(()=>{window.__appJsonCounts={};const originalFetch=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await originalFetch(...args);let pathname='';try{pathname=new URL(args[0] instanceof Request?args[0].url:args[0],location.href).pathname;}catch{}const originalJson=response.json.bind(response);response.json=async(...jsonArgs)=>{try{return await originalJson(...jsonArgs);}finally{window.__appJsonCounts[pathname]=(window.__appJsonCounts[pathname]||0)+1;}};return response;};});await page.goto(origin);await page.waitForFunction(()=>window.fixtureReady,null,{timeout:5000}).catch(async e=>{console.error('FIXTURE',await page.evaluate(()=>({ready:window.fixtureReady,href:location.href})).catch(()=>null),errors);throw e;});
 async function open(title){await page.evaluate(async t=>window.fixture.doc.openEmailDraft({to:'to@example.invalid',subject:t,body:`Synthetic ${t}`,uid:`opened-${t}`,folder:'Drafts',account_id:'acct-A',uidvalidity:'uidv-A',mailbox_scope:'scope-acct-A'}),title);await page.waitForFunction(t=>window.fixture.doc.getCurrentDocId()===`fixture-${t}`,title);}
 async function setAcct(id){await page.evaluate(id=>{window.__odysseusActiveEmailAccount=id;},id);}
 // Observe requests and wait for each request/response via response event + server-side fixture ledger.
 async function saveAndRead(){const before=await page.evaluate(()=>window.__appJsonCounts['/api/email/draft']||0);const p=page.waitForResponse(r=>r.url().endsWith('/api/email/draft')&&r.request().method()==='POST');await page.locator('#doc-email-more-menu').evaluate(e=>e.style.display='block');await page.locator('#doc-email-draft-btn').click();await p;await page.waitForFunction(n=>(window.__appJsonCounts['/api/email/draft']||0)>n,before,{timeout:5000});return state.draft.at(-1);}
 await open('SwitchSave');await setAcct('acct-A');const first=await saveAndRead();await page.waitForTimeout(0);await setAcct('acct-B');const switchedSave=await saveAndRead();
 await open('SwitchSend');await setAcct('acct-A');const beforeSend=await saveAndRead();await setAcct('acct-B');
 await page.locator('#doc-email-to').fill('receiver@example.invalid');
 const body=page.locator('#doc-editor-textarea');if(await body.count())await body.evaluate(el=>{el.value='Synthetic send body';});
 const rich=page.locator('#doc-email-richbody');if(await rich.count())await rich.evaluate(el=>{el.innerText='Synthetic send body';el.innerHTML='<p>Synthetic send body</p>';});
 const sendBefore=await page.evaluate(()=>window.__appJsonCounts['/api/email/send']||0);const sendResponse=page.waitForResponse(r=>r.url().endsWith('/api/email/send')&&r.request().method()==='POST',{timeout:5000});await page.locator('#doc-email-send-btn').click();await sendResponse;await page.waitForFunction(n=>(window.__appJsonCounts['/api/email/send']||0)>n,sendBefore,{timeout:5000});
 const rec=state.draft.at(-1), sent=state.send.at(-1);
 assert.equal(first.account_id,'acct-A');assert.equal(first.draft_uid,'opened-SwitchSave');assert.equal(first.draft_account_id,'acct-A');assert.equal(first.draft_uidvalidity,'uidv-A');assert.equal(first.draft_mailbox_scope,'scope-acct-A');
 assert.equal(switchedSave.account_id,'acct-B');assert.equal(switchedSave.draft_uid,'fixture-uid-0');assert.equal(switchedSave.draft_folder,'Drafts');assert.equal(switchedSave.draft_account_id,'acct-A');assert.equal(switchedSave.draft_uidvalidity,'uidv-0');assert.equal(switchedSave.draft_mailbox_scope,'scope-acct-A');
 assert.equal(beforeSend.account_id,'acct-A');assert.equal(beforeSend.draft_uid,'opened-SwitchSend');assert.equal(rec.account_id,'acct-B');assert.equal(rec.draft_uid,'fixture-uid-2');assert.equal(rec.draft_folder,'Drafts');assert.equal(rec.draft_account_id,'acct-A');assert.equal(rec.draft_uidvalidity,'uidv-2');assert.equal(rec.draft_mailbox_scope,'scope-acct-A');assert.equal(rec.resolve_for_send,true);
 assert.equal(sent.account_id,'acct-B');assert.equal(sent.draft_uid,'fixture-uid-3');assert.equal(sent.draft_folder,'Drafts');assert.equal(sent.draft_account_id,'acct-IMAP');assert.equal(sent.draft_uidvalidity,'uidv-3');assert.equal(sent.draft_mailbox_scope,'scope-acct-IMAP');assert.equal(state.external,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({pass:true,externalRequests:state.external,pageErrors:errors,manualSave:{accountA:first,afterSwitchToB:switchedSave},sendPreflight:{accountAInitial:beforeSend,accountBRecoveryDraft:rec,accountBSend:sent},fixtureOnly:true}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
