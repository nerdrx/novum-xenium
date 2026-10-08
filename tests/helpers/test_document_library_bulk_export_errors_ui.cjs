const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
let exportCalls = 0;
let mode = 'partial';
const html = `<!doctype html><body><div id="toast"></div><script type="module">
import * as lib from '/static/js/documentLibrary.js'; import ui from '/static/js/ui.js';
window.toasts=[]; ui.showToast=m=>window.toasts.push(m); ui.showError=m=>window.toasts.push('ERROR:'+m);
lib.initLibrary({apiBase:'',esc:s=>String(s||''),getDocs:()=>new Map(),isOpen:()=>false,createDocument:async()=>{},newDocument:async()=>{},loadDocument:async()=>{},switchToDoc:()=>{},openPanel:()=>{},addDocToTabs:()=>{},syncDocIndicator:()=>{}});
lib.openLibrary(); window.ready=true;
</script></body>`;
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname==='/') return res.end(html);
 if(u.pathname==='/api/documents/library') {res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({documents:[{id:'a',title:'A',language:'markdown',preview:'a'},{id:'b',title:'B',language:'markdown',preview:'b'}],total:2,languages:{markdown:2},session_count:0}));}
 if(u.pathname==='/api/document/a') {exportCalls++;res.setHeader('Content-Type','application/json');if(mode==='malformed')return res.end(JSON.stringify({title:'A',language:'markdown'}));res.writeHead(503);return res.end('down');}
 if(u.pathname==='/api/document/b') {exportCalls++;if(mode==='malformed'){res.writeHead(503);return res.end('down');}res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({title:'B',language:'markdown',current_content:'ok'}));}
 if(u.pathname==='/__mode') {mode=u.searchParams.get('value');res.writeHead(204);return res.end();}
 const fp=path.resolve(repo,'.'+u.pathname); if(!fp.startsWith(repo+'/')||!fs.existsSync(fp)){res.writeHead(404);return res.end();}
 res.setHeader('Content-Type',fp.endsWith('.js')?'text/javascript':'text/plain');
 if(fp===repo+'/static/js/documentLibrary.js') {let s=fs.readFileSync(fp,'utf8');s=s.replace('async function libraryBulkExport() {','window.__runBulkExport=libraryBulkExport; window.__selectedIds=_librarySelectedIds; async function libraryBulkExport() {'); return res.end(s);}
 fs.createReadStream(fp).pipe(res);
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r)); const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium',args:['--no-sandbox','--disable-gpu']});try{const p=await browser.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto(`http://127.0.0.1:${server.address().port}`);await p.waitForFunction(()=>window.ready&&window.__runBulkExport);await p.waitForTimeout(100);await p.evaluate(()=>{window.__selectedIds.add('a');window.__selectedIds.add('b')});await p.evaluate(()=>window.__runBulkExport());assert.deepEqual(await p.evaluate(()=>window.toasts),['ERROR:1 of 2 documents exported; 1 failed']);assert.equal(await p.evaluate(()=>window.__selectedIds.size),2,'failed items stay selected for retry');
await p.evaluate(()=>fetch('/__mode?value=malformed'));await p.evaluate(()=>window.__runBulkExport());assert.deepEqual(await p.evaluate(()=>window.toasts),['ERROR:1 of 2 documents exported; 1 failed','ERROR:0 of 2 documents exported; 2 failed'],'all-failed/malformed replies never claim success');assert.equal(exportCalls,4);assert.deepEqual(errors,[]);console.log('PASS: Library bulk export reports actual successful and failed counts; malformed/failed docs stay retryable');}finally{await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
