'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const repo = path.resolve(__dirname, '../..');
const paths = ['/api/auth/integrations','/api/calendar/config/accounts','/api/contacts/config','/api/contacts/list','/api/email/accounts','/api/mcp/servers','/api/vault/config','/api/tokens','/api/calendar/calendars'];
const pageHtml = `<!doctype html><meta charset="utf-8"><div id="unified-integrations-list"></div><div id="unified-intg-form" style="display:none"></div><div><button id="unified-intg-add-btn">Add</button></div><script type="module">import settings from '/static/js/settings.js';window.retryInit=()=>settings.initUnifiedIntegrations();window.fixtureReady=true;settings.initUnifiedIntegrations().then(()=>window.initDone=true,e=>{window.initError=String(e);window.initDone=true;setTimeout(()=>{throw e},0)});</script>`;
let scenario = '';
const reads = Object.create(null);
let heldStarted;
let heldStartedPromise;
let heldRelease;
let heldClosed;
let heldClosedPromise;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, {'content-type':'text/html'}); return res.end(pageHtml); }
  if (paths.includes(url.pathname)) {
    reads[scenario] ||= {};
    reads[scenario][url.pathname] = (reads[scenario][url.pathname] || 0) + 1;
    const n = reads[scenario][url.pathname];
    let status = 200;
    let body = url.pathname === '/api/auth/integrations' ? (['heldFetch','heldJson'].includes(scenario) ? {integrations:[{id:'fixture-api',name:'Recovered API',base_url:'https://fixture.invalid',enabled:true}]} : {integrations:[]})
      : url.pathname === '/api/calendar/config/accounts' ? (scenario === 'user403' ? {accounts:[{id:'fixture-calendar',label:'Fixture Calendar',url:'https://fixture.invalid/caldav'}]} : {accounts:[]})
      : url.pathname === '/api/contacts/list' ? {contacts:[],count:0}
      : url.pathname === '/api/calendar/calendars' ? {calendars:[]}
      : url.pathname === '/api/email/accounts' ? (['all503','partial503','nullretry','admin403'].includes(scenario) ? {accounts:[{id:'fixture-email',name:'Fixture Mail',enabled:true}]} : {accounts:[]})
      : url.pathname === '/api/mcp/servers' || url.pathname === '/api/tokens' ? [] : {};
    if (scenario === 'all503' && n === 1) status = 503;
    if (scenario === 'partial503' && url.pathname === '/api/auth/integrations') status = 503;
    if (scenario === 'nullretry' && url.pathname === '/api/auth/integrations' && n === 1) body = null;
    if (scenario === 'admin403' && ['/api/auth/integrations','/api/contacts/config','/api/contacts/list','/api/mcp/servers','/api/vault/config','/api/tokens'].includes(url.pathname)) status = 403;
    if (scenario === 'user403' && url.pathname === '/api/email/accounts') status = 403;
    if ((scenario === 'heldFetch' || scenario === 'heldJson') && url.pathname === '/api/auth/integrations' && n === 1) {
      res.on('close', () => { heldClosed?.(); });
      heldStarted?.();
      if (scenario === 'heldJson') { res.writeHead(200, {'content-type':'application/json'}); res.flushHeaders(); }
      heldRelease = () => { if (!res.destroyed) { if (scenario === 'heldFetch') res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(body)); } };
      return;
    }
    res.writeHead(status, {'content-type':'application/json'});
    return res.end(JSON.stringify(status === 503 ? {detail:'synthetic'} : body));
  }
  const file = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, {'content-type':file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream'});
  fs.createReadStream(file).pipe(res);
});
function resetHold() {
  heldStartedPromise = new Promise(resolve => { heldStarted = resolve; });
  heldClosedPromise = new Promise(resolve => { heldClosed = resolve; });
  heldRelease = undefined;
}
async function newPage(browser, origin, pageErrors, externalRequests, clock = false) {
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  if (clock) await page.clock.install({time:new Date('2027-01-15T12:00:00Z')});
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (['http:','https:'].includes(u.protocol) && u.origin !== origin) { externalRequests.push(u.href); return route.abort(); }
    return route.continue();
  });
  page.on('pageerror', e => pageErrors.push({scenario,error:e.stack || e.message}));
  await page.goto(origin);
  await page.waitForFunction(() => window.fixtureReady);
  return page;
}
async function snapshot(page) {
  return page.evaluate(() => ({text:document.querySelector('#unified-integrations-list')?.innerText||'',cards:[...document.querySelectorAll('.intg-card')].map(c=>({id:c.dataset.intgId,type:c.dataset.intgType,text:c.innerText})),warning:!!document.querySelector('.intg-load-warning'),retry:!!document.querySelector('.intg-retry-load'),error:window.initError||null}));
}
(async () => {
  let browser;
  const pageErrors = [], externalRequests = [], result = {};
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-gpu']});
    async function run(name, check) {
      scenario = name;
      const page = await newPage(browser, origin, pageErrors, externalRequests);
      await page.waitForFunction(() => !!document.querySelector('.intg-load-warning') || document.querySelector('.intg-card') || /No integrations configured/.test(document.body.innerText) || window.initError);
      await check(page);
      result[name] = {reads:{...reads[name]},ui:await snapshot(page)};
      await page.close();
    }
    await run('normalEmpty', async page => {
      await page.waitForFunction(() => /No integrations configured/.test(document.querySelector('#unified-integrations-list')?.textContent||''));
      assert.equal(await page.locator('.intg-load-warning').count(), 0);
    });
    await run('all503', async page => {
      await page.locator('.intg-load-warning').waitFor();
      assert.match(await page.locator('.intg-load-warning').innerText(), /could not be loaded/);
      assert.equal(await page.locator('.intg-retry-load').evaluate(b => b.getBoundingClientRect().height >= 44 && b.getBoundingClientRect().width >= 44), true);
      await page.locator('.intg-retry-load').click();
      await page.waitForFunction(() => document.querySelector('.intg-card')?.dataset.intgId === 'fixture-email' && !document.querySelector('.intg-load-warning'));
    });
    await run('partial503', async page => {
      await page.locator('.intg-card').waitFor();
      assert.equal(await page.locator('.intg-card').count(), 1);
      await page.locator('.intg-load-warning').waitFor();
      assert.match(await page.locator('.intg-load-warning').innerText(), /Some integrations could not be loaded/);
    });
    await run('nullretry', async page => {
      await page.locator('.intg-load-warning').waitFor();
      assert.equal(await page.locator('.intg-card').count(), 1);
      await page.locator('.intg-retry-load').click();
      await page.waitForFunction(() => !document.querySelector('.intg-load-warning'));
    });
    await run('admin403', async page => {
      await page.locator('.intg-card').waitFor();
      assert.equal(await page.locator('.intg-load-warning').count(), 0);
      assert.equal(await page.locator('.intg-card').count(), 1);
    });
    await run('user403', async page => {
      await page.locator('.intg-load-warning').waitFor();
      assert.match(await page.locator('.intg-load-warning').innerText(), /could not be loaded/);
      assert.equal(await page.locator('.intg-card').count(), 1);
      assert.equal(await page.locator('.intg-card').getAttribute('data-intg-type'), 'caldav');
    });
    for (const kind of ['heldFetch','heldJson']) {
      scenario = kind; resetHold();
      const page = await newPage(browser, origin, pageErrors, externalRequests, true);
      await heldStartedPromise;
      await page.clock.runFor(16000);
      await page.locator('.intg-load-warning').waitFor();
      const beforeRetry = await snapshot(page);
      const aborted = await Promise.race([heldClosedPromise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1000))]);
      result[kind] = {afterDeadline:beforeRetry,requestAborted:aborted};
      assert.equal(beforeRetry.warning, true, `${kind}: timed-out initial load should show warning`);
      assert.equal(beforeRetry.retry, true, `${kind}: timed-out initial load should offer Retry`);
      assert.equal(aborted, true, `${kind}: deadline should abort fetch or JSON-body read`);
      await page.locator('.intg-retry-load').click();
      await page.waitForFunction(() => document.querySelector('.intg-card')?.dataset.intgId === 'fixture-api');
      await page.locator('.intg-load-warning').waitFor({state:'detached'});
      result[kind].retryReads = {...reads[kind]};
      await page.close();
    }
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
    process.stdout.write(JSON.stringify({source:{file:'static/js/settings.js',sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'static/js/settings.js'))).digest('hex')},result,pageErrors,externalRequests,pass:true},null,2)+'\n');
  } catch (error) { process.stderr.write(`${error.stack||error}\n`); process.exitCode=1; }
  finally { if (browser) await browser.close().catch(()=>{}); if (server.closeAllConnections) server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())).catch(()=>{}); }
})();
