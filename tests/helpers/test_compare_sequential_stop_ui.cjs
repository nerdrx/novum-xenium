const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(process.env.NOVUM_REPO_ROOT || path.resolve(__dirname, '../..'));
const staticRoot = path.join(root, 'static');
const html = `<!doctype html><textarea id="message"></textarea>
<input id="incognito-toggle" type="checkbox"><input id="web-toggle" type="checkbox">
<button class="send-btn"></button><button id="compare-shuffle-btn"></button>
<button id="compare-check-btn"></button><button id="compare-add-btn"></button>
<div id="compare-vote-bar"></div><div id="toast"></div>
${[0, 1].map(i => `<div id="cmp-badge-${i}"></div><div id="cmp-title-${i}"></div>
<div class="compare-pane" data-pane="${i}"><button class="pane-stop-btn"></button>
<div id="cmp-summary-${i}"></div><div id="cmp-history-${i}"></div></div>`).join('')}
<script type="module">
import compare, {handleCompareSubmit} from '/static/js/compare/index.js';
import state from '/static/js/compare/state.js';
import {authStatePromise} from '/static/js/authState.js';
window.ready=Promise.resolve(authStatePromise).then(()=>window.fixture={compare,handleCompareSubmit,state});
</script>`;
let scenario = '', heldA1 = null;
const calls = [];
function field(body, name) {
  return body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]+)`))?.[1] || '';
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') { res.writeHead(200, {'Content-Type':'text/html'}); return res.end(html); }
  if (url.pathname === '/api/auth/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({configured:true,authenticated:true,username:'SyntheticAlice'}));
  }
  if (url.pathname === '/api/search/query') {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const query = field(body, 'query'), provider = field(body, 'provider');
    calls.push({scenario, query, provider});
    if (scenario === 'stop-race' && query === 'round A' && provider === 'provider-1') { heldA1 = res; return; }
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({results:[{title:`${query} / ${provider}`,snippet:'synthetic',url:'https://example.invalid'}],time:0.01}));
  }
  const file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname.replace(/^\/static/, ''))}`);
  if (url.pathname.startsWith('/static/') && file.startsWith(`${staticRoot}${path.sep}`) && fs.existsSync(file)) {
    res.writeHead(200, {'Content-Type':(file.endsWith('.js') || file.endsWith('.mjs'))?'text/javascript':'application/octet-stream','Cache-Control':'no-store'});
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404); res.end();
});
async function open(browser, name, parallel) {
  scenario = name;
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  page.on('request', req => assert.ok(req.url().startsWith(origin), 'fixture forbids external requests'));
  await page.addInitScript(() => localStorage.setItem('odysseus-auth-user', 'SyntheticAlice'));
  await page.goto(origin);
  try { await page.waitForFunction(() => window.fixture, {timeout:5000}); }
  catch (error) {
    const state = await page.evaluate(() => ({fixture:!!window.fixture, ready:!!window.ready, body:document.body.innerText}));
    throw new Error(`fixture not ready: ${error.message}; pageErrors=${errors.join('|')}; state=${JSON.stringify(state)}`);
  }
  await page.evaluate(parallel => {
    const s = window.fixture.state;
    Object.assign(s, {API_BASE:'', isActive:true, _streaming:false, _abortControllers:[],
      _selectedModels:[{model:'provider-1',name:'One'},{model:'provider-2',name:'Two'}],
      _paneSessionIds:['synthetic-1','synthetic-2'], _compareMode:'search',
      _searchSynthModels:null, _parallel:parallel, _blindMode:true});
  }, parallel);
  return {context,page,errors};
}
async function send(page, text) {
  await page.evaluate(text => { document.getElementById('message').value=text; window.fixture.handleCompareSubmit({preventDefault(){}}); }, text);
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE, args:['--no-sandbox','--disable-gpu']});
  const result = {pass:false, externalRequests:0, cases:{}};
  try {
    let run = await open(browser, 'sequential-positive', false);
    await send(run.page, 'sequence'); await run.page.waitForFunction(() => !window.fixture.state._streaming);
    let observed = calls.filter(x => x.scenario === 'sequential-positive');
    assert.deepEqual(observed.map(x => x.provider), ['provider-1','provider-2']);
    result.cases.sequentialPositive = {bothProviders: observed.length === 2};
    assert.deepEqual(run.errors, []); await run.context.close();

    run = await open(browser, 'parallel-positive', true);
    await send(run.page, 'parallel'); await run.page.waitForFunction(() => !window.fixture.state._streaming);
    observed = calls.filter(x => x.scenario === 'parallel-positive');
    assert.deepEqual(observed.map(x => x.provider).sort(), ['provider-1','provider-2']);
    result.cases.parallelPositive = {bothProviders: observed.length === 2};
    assert.deepEqual(run.errors, []); await run.context.close();

    scenario = 'stop-race'; heldA1 = null;
    run = await open(browser, scenario, false);
    await send(run.page, 'round A');
    await run.page.waitForFunction(() => window.fixture.state._abortControllers.length === 2 && window.fixture.state._streaming);
    const until = Date.now() + 5000;
    while (!heldA1 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(heldA1, 'A provider-1 request reached the hold point');
    await run.page.evaluate(() => {
      window.fixture.handleCompareSubmit({preventDefault(){}});
      document.getElementById('message').value = 'round B';
      window.fixture.handleCompareSubmit({preventDefault(){}});
    });
    await run.page.waitForFunction(() => !window.fixture.state._streaming, {timeout:5000});
    const bCalls = calls.filter(x => x.scenario === scenario && x.query === 'round B');
    const aSecond = calls.filter(x => x.scenario === scenario && x.query === 'round A' && x.provider === 'provider-2');
    const paneB = await run.page.locator('#cmp-history-1').innerText();
    assert.deepEqual(bCalls.map(x => x.provider), ['provider-1','provider-2']);
    assert.deepEqual(aSecond, [], 'stopped A must not advance to provider 2');
    assert.match(paneB, /round B \/ provider-2/);
    result.cases.sequentialStop = {aFirstHeld:true, oldASecondQueryAbsent:aSecond.length===0,
      bCompletedBothProviders:bCalls.length===2, paneKeepsB:paneB.includes('round B / provider-2')};
    if (heldA1 && !heldA1.destroyed) heldA1.destroy(); heldA1 = null;
    assert.deepEqual(run.errors, []); await run.context.close();
    result.pass = true; result.sourceBase = '744a4bf434db8c42bc46ff72df2f6d272e65cf7f';
    console.log(JSON.stringify(result));
  } finally {
    if (heldA1 && !heldA1.destroyed) heldA1.destroy();
    await browser.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode=1; });
