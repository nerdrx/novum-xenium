const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const imports = new Map([
  ["import Storage from './storage.js';", "import Storage from '/stubs/storage.js';"],
  ["import uiModule, { autoResize, styledPrompt } from './ui.js?v=20260916largetoolscroll1';", "import uiModule, { autoResize, styledPrompt } from '/stubs/ui.js';"],
  ["import chatRenderer from './chatRenderer.js?v=20261007toolstatus1';", "import chatRenderer from '/stubs/chatRenderer.js';"],
  ["import { providerLogo } from './providers.js';", "import { providerLogo } from '/stubs/providers.js';"],
  ["import { initModelPicker, updateModelPicker } from './modelPicker.js?v=20260909routeidentity1';", "import { initModelPicker, updateModelPicker } from '/stubs/modelPicker.js';"],
  ["import themeModule from './theme.js?v=20260911organsrain1';", "import themeModule from '/stubs/theme.js';"],
  ["import spinnerModule from './spinner.js';", "import spinnerModule from '/stubs/spinner.js';"],
  ["import { installSessionHistory, pendingChatRouteId, setPendingChatHistory, setSessionHistory } from './sessionHistory.js';", "import { installSessionHistory, pendingChatRouteId, setPendingChatHistory, setSessionHistory } from '/stubs/sessionHistory.js';"],
  ["import { applySubagentInspector, clearSubagentInspector } from './subagentInspector.js';", "import { applySubagentInspector, clearSubagentInspector } from '/stubs/subagentInspector.js';"],
  ["import { resetBrowserPreview } from './browserPreview.js';", "import { resetBrowserPreview } from '/stubs/browserPreview.js';"],
  ["import { deleteComposerDraft, getComposerDraft, getPendingChatMetadata, saveComposerDraft, transferComposerDraft } from './composerDrafts.js';", "import { deleteComposerDraft, getComposerDraft, getPendingChatMetadata, saveComposerDraft, transferComposerDraft } from '/stubs/composerDrafts.js';"],
]);
const stubs = {
  'storage.js': `const Storage={get:()=>null,getJSON:(_key,fallback=null)=>fallback,setJSON:()=>{}};export default Storage;`,
  'ui.js': `export const autoResize=()=>{};export const styledPrompt=async()=>null;const ui={el:id=>document.getElementById(id),showToast:()=>{},showError:()=>{},scrollHistoryInstant:()=>{},isTouchInsideModal:()=>false};export default ui;`,
  'chatRenderer.js': `export default {hideWelcomeScreen(){},addMessage(){},updateSessionCostUI(){}};`,
  'providers.js': `export const providerLogo=()=>'';`,
  'modelPicker.js': `export const initModelPicker=()=>{};export const updateModelPicker=()=>{};`,
  'theme.js': `export default {};`, 'spinner.js': `export default {};`,
  'sessionHistory.js': `export const installSessionHistory=()=>{};export const pendingChatRouteId=()=>'';export const setPendingChatHistory=()=>{};export const setSessionHistory=()=>{};`,
  'subagentInspector.js': `export const applySubagentInspector=()=>{};export const clearSubagentInspector=()=>{};`,
  'browserPreview.js': `export const resetBrowserPreview=()=>{};`,
  'composerDrafts.js': `export const deleteComposerDraft=()=>{};export const getComposerDraft=()=>null;export const getPendingChatMetadata=()=>null;export const saveComposerDraft=()=>{};export const transferComposerDraft=()=>{};`,
};
const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0} .sidebar-inner{height:600px;overflow:auto} #session-list{display:block}
  .list-item{min-height:36px}
  </style><div class="sidebar"><div class="sidebar-inner"><section class="section" id="sessions-section"><div class="section-header-flex"><span id="chats-section-title">Chats</span></div></section></div></div>
  <div id="chat-history"></div><div id="current-meta"></div>
  <script type="module">
    const RealDate = Date;
    window.__fakeNow = RealDate.parse('2026-10-18T12:00:00+02:00');
    class ClockDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [window.__fakeNow])); }
      static now() { return window.__fakeNow; }
    }
    window.Date = ClockDate;
    window.__midnightTimers = [];
    const realSetTimeout = window.setTimeout.bind(window);
    const realClearTimeout = window.clearTimeout.bind(window);
    let nextTimerId = 100000;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay >= 10000000) {
        const timer = { id: ++nextTimerId, callback: () => callback(...args), delay, canceled: false };
        window.__midnightTimers.push(timer);
        return timer.id;
      }
      return realSetTimeout(callback, delay, ...args);
    };
    window.clearTimeout = id => {
      const timer = window.__midnightTimers.find(item => item.id === id);
      if (timer) timer.canceled = true;
      else realClearTimeout(id);
    };
    import * as sessions from '/test/sessions.js';
    import { applyInitialSectionCollapse } from '/static/js/section-management.js';
    window.sessions=sessions; window.applyInitialSectionCollapse=applyInitialSectionCollapse;
    window.setFixtures=(items)=>{window.__fixtureItems=items;window.__setFixtures(items);};
    window.ready=true;
  </script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type','text/html'); return res.end(html); }
  if (url.pathname === '/test/sessions.js') {
    let source = fs.readFileSync(path.join(repo, 'static/js/sessions.js'), 'utf8');
    source = source.replace("from './actionMenuOrder.js'", "from '/static/js/actionMenuOrder.js'")
      .replace("from './escMenuStack.js'", "from '/static/js/escMenuStack.js'");
    for (const [from, to] of imports) {
      assert.ok(source.includes(from), `missing sessions import: ${from}`);
      source = source.replace(from, to);
    }
    source = source.replace('let _sortMode = Storage.get(\'odysseus-session-sort\') || \'active\';',
      "let _sortMode = Storage.get('odysseus-session-sort') || 'active'; window.__setSortMode=(mode)=>{_sortMode=mode;}; window.__setFixtures=(items)=>{sessions=items;renderSessionList();};");
    res.setHeader('Content-Type','text/javascript'); return res.end(source);
  }
  if (url.pathname.startsWith('/stubs/')) {
    const body = stubs[path.basename(url.pathname)];
    if (!body) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type','text/javascript'); return res.end(body);
  }
  const file = path.resolve(repo, `.${url.pathname}`);
  if (!file.startsWith(repo + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', (file.endsWith('.js') || file.endsWith('.mjs')) ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox']});
  try {
    const errors=[];
    const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Europe/Berlin'});
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>window.ready);
    assert.equal(await page.evaluate(()=>window.__midnightTimers.filter(timer=>!timer.canceled).length),0,'no midnight timer exists before a sidebar list is rendered');
    await page.evaluate(()=>{
      const list=document.createElement('div'); list.id='session-list';
      document.getElementById('sessions-section').appendChild(list);
    });
    const fixture=[{id:'chat-target',name:'Synthetic target',last_message_at:'2026-10-18T07:45:29.188076Z',updated_at:'2026-10-19T11:17:00+02:00'}];
    await page.evaluate(items=>window.setFixtures(items),fixture);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const initialHeader=await page.locator('#session-list .session-date-section-header').first().textContent();
    assert.equal(initialHeader,'Today','18 Oct session on 18 Oct appears in Today');
    await page.evaluate(()=>{ window.__sameDayRow=document.querySelector('#session-list .list-item[data-session-id="chat-target"]'); });
    await page.evaluate(()=>{ document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(40);
    assert.equal(await page.locator('#session-list .list-item[data-session-id="chat-target"]').evaluate(el=>el===window.__sameDayRow), true,
      'same-day focus/visibility keeps row identity and avoids a redundant rerender');
    await page.evaluate(()=>{window.__fakeNow=Date.parse('2026-10-19T12:00:00+02:00');window.sessions.renderSessionList();});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const freshNextDayHeader=await page.locator('#session-list .session-date-section-header').first().textContent();
    assert.equal(freshNextDayHeader,'Yesterday','a fresh render buckets the 18 Oct session as Yesterday on 19 Oct');
    await page.evaluate(()=>{
      window.__fakeNow=Date.parse('2026-10-18T12:00:00+02:00');
      window.sessions.renderSessionList();
    });
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.evaluate(()=>{
      window.__fakeNow=Date.parse('2026-10-19T12:00:00+02:00');
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForTimeout(80);
    const afterIdleHeader=await page.locator('#session-list .session-date-section-header').first().textContent();
    assert.equal(afterIdleHeader,'Yesterday','visibility/focus after a local-day change refreshes the bucket label');
    const afterVisibilityHeader=afterIdleHeader;
    await page.evaluate(()=>{
      window.__fakeNow=Date.parse('2026-10-18T12:00:00+02:00');
      window.sessions.renderSessionList();
    });
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#session-list .session-date-section-header').first().textContent(),'Today');
    const midnightDelay=await page.evaluate(()=>{
      const timer=window.__midnightTimers.filter(item=>!item.canceled).at(-1);
      window.__fakeNow=Date.parse('2026-10-19T00:01:00+02:00');
      timer.callback();
      return timer.delay;
    });
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const afterMidnightTimer=await page.locator('#session-list .session-date-section-header').first().textContent();
    assert.equal(afterMidnightTimer,'Yesterday','the local-midnight callback rerenders the unchanged 18 Oct message');
    await page.evaluate(()=>{
      window.__fakeNow=Date.parse('2026-10-18T12:00:00+02:00');
      window.sessions.renderSessionList();
    });
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.evaluate(()=>{ window.__fakeNow=Date.parse('2026-10-19T12:00:00+02:00'); document.dispatchEvent(new Event('visibilitychange')); });
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const afterVisibleDayChange=await page.locator('#session-list .session-date-section-header').first().textContent();
    assert.equal(afterVisibleDayChange,'Yesterday','returning visible after a missed midnight rerenders date buckets');
    await page.evaluate(()=>{
      window.__fakeNow=Date.parse('2026-03-29T00:00:00+01:00');
      window.sessions.renderSessionList();
    });
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const springDstDelay=await page.evaluate(()=>window.__midnightTimers.filter(item=>!item.canceled).at(-1).delay);
    await page.evaluate(()=>{
      window.__fakeNow=Date.parse('2026-10-25T00:00:00+02:00');
      window.sessions.renderSessionList();
    });
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const autumnDstDelay=await page.evaluate(()=>window.__midnightTimers.filter(item=>!item.canceled).at(-1).delay);
    assert.equal(springDstDelay,23*60*60*1000,'spring-forward local day schedules the next local midnight after 23 elapsed hours');
    assert.equal(autumnDstDelay,25*60*60*1000,'fall-back local day schedules the next local midnight after 25 elapsed hours');
    assert.deepEqual(errors,[]);
    const evidence={result:'PASS',session:{id:'chat-target',last_message_at:'2026-10-18T07:45:29.188076Z',updated_at:'2026-10-19T11:17:00+02:00'},clock:{initial:'2026-10-18T12:00:00+02:00',advanced:'2026-10-19T12:00:00+02:00'},initialHeader,afterSameDayFocus:initialHeader,freshNextDayHeader,afterVisibilityDayChange:afterIdleHeader,afterMidnightTimer,afterVisibleDayChange,springDstDelay,autumnDstDelay,midnightDelay,pageErrors:errors,scope:'synthetic session metadata; no live API or chat content'};
    if (process.env.EVIDENCE_DIR) {
      fs.mkdirSync(process.env.EVIDENCE_DIR,{recursive:true});
      fs.writeFileSync(path.join(process.env.EVIDENCE_DIR,'sidebar-date-rollover-results.json'),JSON.stringify(evidence,null,2));
    }
    console.log(JSON.stringify(evidence));
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
