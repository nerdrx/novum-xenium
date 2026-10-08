// Gallery fetches must not let an older filter response replace newer results.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
let plans = [{status:503, payload:{detail:"fixture outage"}}];
const html = `<!doctype html><meta charset="utf-8"><body><div id="toast"></div>
<script type="module">import * as gallery from '/static/js/gallery.js'; window.gallery = gallery; gallery.openGallery(); window.fixtureReady = true;</script></body>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.end(html);
  if (url.pathname === '/__plans' && req.method === 'POST') {
    let body=''; req.on('data', c=>body+=c); req.on('end',()=>{plans=JSON.parse(body);res.writeHead(204);res.end();});return;
  }
  if (url.pathname === '/api/gallery/albums') {
    const plan=plans.shift() || {payload:{albums:[]}};
    if(plan.delay) await new Promise(r=>setTimeout(r,plan.delay));
    res.writeHead(plan.status||200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify(plan.payload));
  }
  if (url.pathname === '/api/gallery/library') {
    res.setHeader('Content-Type','application/json');
    return res.end(JSON.stringify({items:[],total:0,tags:[],models:[]}));
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async () => {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-gpu']});
 try {
  const page=await browser.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>window.fixtureReady);
  await page.locator('.gallery-tab[data-tab="albums"]').click();
  await page.waitForSelector('#gallery-albums-load-error[role="alert"]');
  assert.doesNotMatch(await page.locator('#gallery-albums-grid-wrap').textContent(),/No albums yet/);
  const setPlans=p=>page.evaluate(plans=>fetch('/__plans',{method:'POST',body:JSON.stringify(plans)}),p);
  await setPlans([{payload:{albums:[{id:'keep',name:'Last good album',count:2}]}}]);
  await page.locator('#gallery-albums-load-error button').click();
  await page.waitForSelector('.gallery-album-card[data-album="keep"]');
  await setPlans([{status:503,payload:{detail:'refresh outage'}}]);
  await page.evaluate(()=>window.gallery.closeGallery());
  await page.waitForFunction(()=>!document.getElementById('gallery-modal'));
  await page.evaluate(()=>window.gallery.openGallery());
  await page.locator('.gallery-tab[data-tab="albums"]').click();
  await page.waitForSelector('#gallery-albums-load-error');
  assert.equal(await page.locator('.gallery-album-card[data-album="keep"]').count(),1,'failed refresh preserves cached album');
  await setPlans([{payload:{albums:[null]}}]);
  await page.locator('#gallery-albums-load-error button').click();
  await page.waitForFunction(()=>document.querySelector('#gallery-albums-load-error') && document.querySelector('#gallery-albums-container')?.getAttribute('aria-busy')!=='true');
  assert.equal(await page.locator('.gallery-album-card[data-album="keep"]').count(),1,'malformed success preserves cached album');
  await setPlans([{payload:{albums:[]}}]);
  await page.locator('#gallery-albums-load-error button').click();
  await page.waitForFunction(()=>!document.querySelector('#gallery-albums-load-error') && document.querySelector('.gallery-albums-empty')?.textContent.includes('No albums yet'));
  // A closed gallery's delayed failure cannot overwrite a newer session.
  await setPlans([{delay:700,status:503,payload:{detail:'old failure'}},{payload:{albums:[{id:'newest',name:'Newest album',count:0}]}}]);
  await page.evaluate(()=>window.gallery.closeGallery());await page.waitForFunction(()=>!document.getElementById('gallery-modal'));
  const old=page.waitForRequest(r=>r.url().endsWith('/api/gallery/albums'));
  await page.evaluate(()=>window.gallery.openGallery());await old;
  await page.evaluate(()=>window.gallery.closeGallery());await page.waitForFunction(()=>!document.getElementById('gallery-modal'));
  await page.evaluate(()=>window.gallery.openGallery());await page.locator('.gallery-tab[data-tab="albums"]').click();
  await page.waitForSelector('.gallery-album-card[data-album="newest"]');await page.waitForTimeout(800);
  assert.equal(await page.locator('#gallery-albums-load-error').count(),0,'obsolete failure stays silent');
  assert.equal(await page.locator('.gallery-album-card[data-album="newest"]').count(),1);
  assert.deepEqual(errors,[]);console.log('PASS: album load failures, retained rows, malformed payload, Retry, genuine empty and stale closed-session response');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
