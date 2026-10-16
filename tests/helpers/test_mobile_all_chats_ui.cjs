const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const repo = path.resolve(__dirname, '../..');
const imports = new Map([
  ["import Storage from './storage.js';", "import Storage from '/stubs/storage.js';"],
  ["import uiModule, { autoResize, styledPrompt } from './ui.js';", "import uiModule, { autoResize, styledPrompt } from '/stubs/ui.js';"],
  ["import chatRenderer from './chatRenderer.js?v=20261007toolstatus1';", "import chatRenderer from '/stubs/chatRenderer.js';"],
  ["import { providerLogo } from './providers.js';", "import { providerLogo } from '/stubs/providers.js';"],
  ["import { initModelPicker, updateModelPicker } from './modelPicker.js?v=20260722ctxheader1';", "import { initModelPicker, updateModelPicker } from '/stubs/modelPicker.js';"],
  ["import themeModule from './theme.js';", "import themeModule from '/stubs/theme.js';"],
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
  </style><div class="sidebar"><div class="sidebar-inner"><section class="section" id="sessions-section"><div class="section-header-flex"><span id="chats-section-title">Chats</span></div><div id="session-list"></div></section></div></div>
  <div id="chat-history"></div><div id="current-meta"></div>
  <script type="module">
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
    for (const [from, to] of imports) {
      assert.ok(source.includes(from), `missing sessions import: ${from}`);
      source = source.replace(from, to);
    }
    source = source.replace('let sessions = [];', 'let sessions = []; window.__unused=0;');
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
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain');
  fs.createReadStream(file).pipe(res);
});

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox']});
  try {
    const errors=[];
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>window.ready);
    const fixture=Array.from({length:104},(_,i)=>({id:`chat-${i}`,name:`Chat ${i}`,created_at:new Date(Date.UTC(2026,0,1,0,i)).toISOString(),folder:i<52?'Work':null}));
    await page.evaluate(items=>window.setFixtures(items),fixture);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#session-list .list-item[data-session-id]').count(),104,'mobile flat list shows every chat by default');
    assert.ok(await page.locator('.sidebar-inner').evaluate(el=>el.scrollHeight>el.clientHeight),'full mobile list remains scrollable');
    assert.equal(await page.locator('.session-show-more-btn').first().textContent(),'Show less');
    await page.locator('.session-show-more-btn').first().click();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#session-list .list-item[data-session-id]').count(),10,'mobile Show less remains available');
    await page.locator('.session-show-more-btn').first().click();
    await page.evaluate(()=>window.__setSortMode('group'));
    await page.evaluate(items=>window.setFixtures(items),fixture);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#session-list .list-item[data-session-id]').count(),104,'mobile grouped/foldered list bypasses folder and unfiled caps by default');
    await page.locator('#sessions-section').evaluate(section=>window.applyInitialSectionCollapse(section,{},{}));
    assert.equal(await page.locator('#sessions-section').getAttribute('class'),'section','Chats expanded by default');
    await page.locator('#sessions-section').evaluate(section=>window.applyInitialSectionCollapse(section,{'sessions-section':false},{'sessions-section':true}));
    assert.equal(await page.locator('#sessions-section').getAttribute('class'),'section','new explicit expanded choice wins over legacy collapse');
    await page.locator('#sessions-section').evaluate(section=>window.applyInitialSectionCollapse(section,{'sessions-section':true},{}));
    assert.match(await page.locator('#sessions-section').getAttribute('class'),/collapsed/,'explicit saved collapse is honored');
    await page.locator('#sessions-section').evaluate(section=>window.applyInitialSectionCollapse(section,{}, {'sessions-section':true}));
    assert.match(await page.locator('#sessions-section').getAttribute('class'),/collapsed/,'legacy collapse remains a fallback');
    const desktop=await browser.newPage({viewport:{width:1280,height:800}});
    desktop.on('pageerror',error=>errors.push(error.message));
    await desktop.goto(`http://127.0.0.1:${server.address().port}/`);
    await desktop.waitForFunction(()=>window.ready);
    await desktop.evaluate(items=>window.setFixtures(items),fixture);
    await desktop.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await desktop.locator('#session-list .list-item[data-session-id]').count(),10,'desktop default cap stays at ten');
    assert.equal(await desktop.locator('.session-show-more-btn').first().textContent(),'Show 94 more');
    assert.equal(await desktop.evaluate(()=>window.__fixtureItems.length),104,'rendering does not mutate session data');
    assert.deepEqual(errors,[]);
    console.log('PASS: mobile all-chat visibility and section preferences');
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
